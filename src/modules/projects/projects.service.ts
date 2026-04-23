import {
  Project, Appointment, User, AuditLog, VisitReport,
} from '../../models/index.js';
import { PaymentPlan } from '../../models/Payment.js';
import { Blueprint } from '../../models/Blueprint.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  ProjectStatus, AppointmentStatus, Role, AuditAction, NotificationCategory, StaffAvailabilityStatus,
} from '../../utils/constants.js';
import { VisitReportStatus } from '../../models/VisitReport.js';
import { projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { generateAndUploadContract, type ContractData } from '../../services/contract.service.js';
import { generateDownloadUrl } from '../uploads/upload.service.js';
import { logger } from '../../utils/logger.js';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  AssignEngineersInput,
  ReassignProjectSalesInput,
  AssignFabricationInput,
  TransitionProjectInput,
  SignContractInput,
  SignEngineerContractInput,
  ReviewInitialDesignInput,
  ResubmitInitialDesignInput,
  BackfillInitialDesignInput,
  SelectPaymentPlanInput,
  SubmitProjectReviewInput,
  SkipProjectReviewInput,
} from './projects.validation.js';
import type { Types } from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import { PaymentStageStatus } from '../../utils/constants.js';
import { getInstallmentConfig } from '../config/config.service.js';
import { generateProjectNumber } from '../../utils/projectNumber.js';

// ── Create Project (from completed appointment) ──

export async function createProject(
  input: CreateProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  if (appointment.status !== AppointmentStatus.COMPLETED) {
    throw AppError.badRequest('Project can only be created from a completed appointment');
  }

  // Check 1:1 relationship
  const existing = await Project.findOne({ appointmentId: input.appointmentId });
  if (existing) throw AppError.conflict('A project already exists for this appointment', ErrorCode.DUPLICATE_ENTRY);

  // Link the latest submitted visit report from this appointment
  const latestReport = await VisitReport.findOne({
    appointmentId: input.appointmentId,
    status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
  }).sort({ createdAt: -1 }).select('_id');

  const projectNumber = await generateProjectNumber();

  const project = await Project.create({
    appointmentId: input.appointmentId,
    projectNumber,
    customerId: appointment.customerId,
    salesStaffId: appointment.salesStaffId || actorId,
    title: input.title,
    serviceType: input.serviceType,
    description: input.description,
    siteAddress: input.siteAddress,
    measurements: input.measurements,
    materialType: input.materialType,
    finishColor: input.finishColor,
    quantity: input.quantity,
    notes: input.notes,
    designReviewStatus: 'not_required',
    status: ProjectStatus.DRAFT,
    ...(latestReport && { visitReportId: latestReport._id }),
  });

  await AuditLog.create({
    action: AuditAction.PROJECT_CREATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { appointmentId: input.appointmentId, title: input.title },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    appointment.customerId,
    NotificationCategory.SYSTEM,
    'Project Created',
    `Your project "${input.title}" has been created.`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Update Project Details ──

export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Only editable in draft/submitted status
  if (![ProjectStatus.DRAFT, ProjectStatus.SUBMITTED].includes(project.status)) {
    throw AppError.badRequest('Project can only be edited in draft or submitted status');
  }

  const changes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      (project as any)[key] = value;
      changes[key] = value;
    }
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: changes,
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

// ── Assign Engineers ──

export async function assignEngineers(
  projectId: string,
  input: AssignEngineersInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Verify all are engineers
  const engineers = await User.find({
    _id: { $in: input.engineerIds },
    roles: Role.ENGINEER,
    isActive: true,
  });
  if (engineers.length !== input.engineerIds.length) {
    throw AppError.badRequest('One or more engineer IDs are invalid');
  }

  project.engineerIds = input.engineerIds as unknown as Types.ObjectId[];

  // Auto-transition to BLUEPRINT if project is in SUBMITTED status
  if (project.status === ProjectStatus.SUBMITTED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_REASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { engineerIds: input.engineerIds },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineers
  for (const eng of engineers) {
    await createAndSendNotification(
      eng._id,
      NotificationCategory.SYSTEM,
      'Project Assigned',
      `You have been assigned to project "${project.title}".`,
      `/projects/${project._id}`,
    );
  }

  return project;
}

export async function reassignProjectSalesStaff(
  projectId: string,
  input: ReassignProjectSalesInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  if ([ProjectStatus.CANCELLED, ProjectStatus.COMPLETED].includes(project.status)) {
    throw AppError.badRequest('Sales reassignment is not allowed for completed or cancelled projects');
  }

  const previousSalesStaffId = project.salesStaffId.toString();
  if (previousSalesStaffId === input.salesStaffId) {
    return project;
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedSales = actorRoles.includes(Role.SALES_STAFF) && previousSalesStaffId === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only admins or the assigned sales staff can reassign this project');
  }

  const nextSalesStaff = await User.findOne({
    _id: input.salesStaffId,
    roles: Role.SALES_STAFF,
    isActive: true,
  }).select('availabilityStatus');
  if (!nextSalesStaff) throw AppError.badRequest('Invalid sales staff ID');

  if (
    nextSalesStaff.availabilityStatus === StaffAvailabilityStatus.UNAVAILABLE
    || nextSalesStaff.availabilityStatus === StaffAvailabilityStatus.ON_LEAVE
  ) {
    throw AppError.badRequest('Selected sales staff is currently unavailable');
  }

  project.salesStaffId = input.salesStaffId as unknown as Types.ObjectId;
  await project.save();

  const [appointmentUpdate, visitReportUpdate] = await Promise.all([
    Appointment.updateOne(
      { _id: project.appointmentId, status: { $nin: [AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW] } },
      { $set: { salesStaffId: nextSalesStaff._id } },
    ),
    VisitReport.updateMany(
      { appointmentId: project.appointmentId, status: VisitReportStatus.DRAFT },
      { $set: { salesStaffId: nextSalesStaff._id } },
    ),
  ]);

  await AuditLog.create({
    action: AuditAction.PROJECT_REASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      reassigned: true,
      scope: 'sales_staff',
      previousSalesStaffId,
      salesStaffId: input.salesStaffId,
      reason: input.reason || null,
      appointmentUpdated: appointmentUpdate.modifiedCount,
      draftVisitReportsUpdated: visitReportUpdate.modifiedCount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    input.salesStaffId,
    NotificationCategory.PROJECT,
    'Project Reassigned',
    `You were assigned to project "${project.title}".`,
    `/projects/${project._id}`,
  );

  await createAndSendNotification(
    previousSalesStaffId,
    NotificationCategory.PROJECT,
    'Project Reassignment',
    `Project "${project.title}" was reassigned to another sales staff member.`,
    `/projects/${project._id}`,
  );

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PROJECT,
    'Project Team Update',
    `Your project "${project.title}" now has an updated assigned sales staff.`,
    `/projects/${project._id}`,
  );

  return project;
}

function hasInitialDesignSubmission(project: {
  initialDesignKeys?: string[];
  initialDesignNotes?: string;
}) {
  return Boolean(project.initialDesignKeys?.length || project.initialDesignNotes?.trim());
}

function isHistoricalInitialDesignBackfillEligible(projectStatus: ProjectStatus, hasBlueprint: boolean) {
  return hasBlueprint || [
    ProjectStatus.APPROVED,
    ProjectStatus.PAYMENT_PENDING,
    ProjectStatus.FABRICATION,
    ProjectStatus.COMPLETED,
  ].includes(projectStatus);
}

function buildContractData(
  project: any,
  blueprint: any,
  paymentPlan: {
    totalAmount: number;
    isPayInFull: boolean;
    stages: Array<{ label: string; percentage: number; amount: number; description?: string }>;
  },
) {
  const customer = project.customerId as any;
  const engineers = project.engineerIds as any[];

  return {
    projectTitle: project.title,
    projectDescription: project.description,
    siteAddress: project.siteAddress,
    serviceType: project.serviceType,
    customerName: `${customer.firstName} ${customer.lastName}`,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    customerAddress: customer.address,
    engineerNames: engineers.map((e: any) => `${e.firstName} ${e.lastName}`),
    totalAmount: paymentPlan.totalAmount,
    paymentType: paymentPlan.isPayInFull ? 'full' : 'installment',
    stages: paymentPlan.stages.map((stage) => ({
      label: stage.label,
      percentage: stage.percentage,
      amount: stage.amount,
      description: stage.description,
    })),
    estimatedDuration: blueprint.quotation?.estimatedDuration,
    materialType: project.materialType,
    finishColor: project.finishColor,
    quantity: project.quantity,
    customerSignatureKey: customer.signatureKey || null,
    engineerSignatureKey: engineers[0]?.signatureKey || null,
    contractSignedAt: project.contractSignedAt || null,
    quotationLineItems: blueprint.quotation?.lineItems?.map((lineItem: any) => ({
      label: lineItem.label,
      quantity: lineItem.quantity,
      materials: lineItem.materials,
      labor: lineItem.labor,
      amount: lineItem.amount,
    })),
    quotationFees: blueprint.quotation?.fees,
    quotationValidityDays: blueprint.quotation?.validityDays,
    scopeOfWork: blueprint.quotation?.breakdown,
  } satisfies ContractData;
}

export async function reviewInitialDesign(
  projectId: string,
  input: ReviewInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const canReview = project.engineerIds.some((id) => id.toString() === actorId);
  const actor = await User.findById(actorId).select('roles firstName lastName');
  const isAdmin = actor?.roles?.includes(Role.ADMIN);

  if (!canReview && !isAdmin) {
    throw AppError.forbidden('Only an assigned engineer or admin can review the initial design');
  }

  if (!hasInitialDesignSubmission(project)) {
    throw AppError.badRequest('No initial design has been submitted for this project');
  }

  if (project.designReviewStatus === 'approved' && input.decision === 'approved') {
    return project;
  }

  project.designReviewStatus = input.decision;
  project.designReviewNotes = input.notes;
  project.designReviewedBy = actorId as unknown as Types.ObjectId;
  project.designReviewedAt = new Date();
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'initial_design_reviewed', decision: input.decision, notes: input.notes || null },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.salesStaffId,
    NotificationCategory.PROJECT,
    input.decision === 'approved' ? 'Initial Design Approved' : 'Initial Design Needs Changes',
    input.decision === 'approved'
      ? `The initial design for project "${project.title}" has been approved by engineering.`
      : `Engineering declined the initial design for project "${project.title}".${input.notes ? ` Notes: ${input.notes}` : ''}`,
    `/projects/${project._id}`,
  );

  return project;
}

export async function resubmitInitialDesign(
  projectId: string,
  input: ResubmitInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const actor = await User.findById(actorId).select('roles');
  const isAdmin = actor?.roles?.includes(Role.ADMIN);
  const isAssignedSales = String(project.salesStaffId) === actorId;
  if (!isAdmin && !isAssignedSales) {
    throw AppError.forbidden('Only the assigned sales staff or an admin can update the initial design');
  }

  if (![ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(project.status)) {
    throw AppError.badRequest('Initial design can only be updated before blueprint review begins');
  }

  const existingBlueprint = await Blueprint.findOne({ projectId }).select('_id');
  if (existingBlueprint) {
    throw AppError.badRequest('Initial design can no longer be updated after the blueprint has been uploaded');
  }

  project.initialDesignKeys = input.initialDesignKeys || [];
  project.initialDesignNotes = input.initialDesignNotes || undefined;
  project.designReviewStatus = 'pending';
  project.designReviewedBy = undefined;
  project.designReviewedAt = undefined;
  project.designReviewNotes = undefined;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'initial_design_resubmitted',
      initialDesignKeyCount: project.initialDesignKeys.length,
      hasNotes: !!project.initialDesignNotes,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  for (const engineerId of project.engineerIds) {
    await createAndSendNotification(
      engineerId,
      NotificationCategory.PROJECT,
      'Initial Design Resubmitted',
      `Sales staff updated the initial design for project "${project.title}". Please review it again.`,
      `/projects/${project._id}`,
    );
  }

  return project;
}

export async function backfillInitialDesign(
  projectId: string,
  input: BackfillInitialDesignInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const existingBlueprint = await Blueprint.findOne({ projectId }).select('_id');
  if (!isHistoricalInitialDesignBackfillEligible(project.status, Boolean(existingBlueprint))) {
    throw AppError.badRequest('Use the standard initial design workflow before blueprint review begins');
  }

  project.initialDesignKeys = input.initialDesignKeys || [];
  project.initialDesignNotes = input.initialDesignNotes || undefined;
  project.initialDesignBackfill = {
    isSyntheticDemo: true,
    reason: input.backfillReason,
    backfilledAt: new Date(),
    backfilledBy: actorId as unknown as Types.ObjectId,
  };

  if (!hasInitialDesignSubmission(project)) {
    throw AppError.badRequest('Provide at least one design file or a note');
  }

  if (project.designReviewStatus === 'pending' || project.designReviewStatus === 'declined') {
    project.designReviewStatus = 'not_required';
    project.designReviewedBy = undefined;
    project.designReviewedAt = undefined;
    project.designReviewNotes = undefined;
  }

  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'initial_design_backfilled',
      syntheticDemo: true,
      reason: input.backfillReason,
      initialDesignKeyCount: project.initialDesignKeys.length,
      hasNotes: !!project.initialDesignNotes,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

async function buildPaymentStages(projectId: string, paymentType: 'full' | 'installment') {
  const blueprint = await Blueprint.findOne({ projectId }).sort({ version: -1 });
  if (!blueprint?.quotation || blueprint.status !== 'approved') {
    throw AppError.badRequest('Customer payment selection is only available after the approved quotation is ready');
  }

  const baseTotal = blueprint.quotation.total;
  const installmentConfig = await getInstallmentConfig();
  const isPayInFull = paymentType === 'full';
  const totalAmount = isPayInFull
    ? baseTotal
    : Math.round(baseTotal * (1 + installmentConfig.surchargePercent / 100) * 100) / 100;

  const stages = isPayInFull
    ? [{
      stageId: uuidv4(),
      label: 'Full Payment',
      description: 'Due upon contract signing',
      percentage: 100,
      amount: totalAmount,
      status: PaymentStageStatus.PENDING,
      amountPaid: 0,
      creditApplied: 0,
      remainingBalance: totalAmount,
      activatedAt: new Date(),
    }]
    : installmentConfig.split.map((pct, idx) => {
      const amount = Math.round((totalAmount * pct / 100) * 100) / 100;
      const milestone = blueprint.quotation?.paymentMilestones?.[idx];
      return {
        stageId: uuidv4(),
        label: milestone?.label || installmentConfig.stageLabels[idx] || `Stage ${idx + 1}`,
        description: milestone?.description || installmentConfig.stageDescriptions[idx] || '',
        percentage: pct,
        amount,
        status: PaymentStageStatus.PENDING,
        amountPaid: 0,
        creditApplied: 0,
        remainingBalance: amount,
        activatedAt: idx === 0 ? new Date() : null,
      };
    });

  return {
    blueprint,
    totalAmount,
    isPayInFull,
    surchargePercent: isPayInFull ? 0 : installmentConfig.surchargePercent,
    stages,
  };
}

export async function selectPaymentPlan(
  projectId: string,
  input: SelectPaymentPlanInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');
  if (String((project.customerId as any)._id ?? project.customerId) !== actorId) {
    throw AppError.forbidden('Only the project customer can select a payment plan');
  }

  const approvedBlueprint = await Blueprint.findOne({ projectId }).sort({ version: -1 });
  if (!approvedBlueprint?.quotation || approvedBlueprint.status !== 'approved') {
    throw AppError.badRequest('Customer payment selection is only available after the approved quotation is ready');
  }

  const existingPlan = await PaymentPlan.findOne({ projectId: project._id });

  if (existingPlan) {
    if (![ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING].includes(project.status)) {
      throw AppError.conflict('A payment plan already exists for this project', ErrorCode.DUPLICATE_ENTRY);
    }

    if (!project.contractKey) {
      const recoveryContractData = buildContractData(project, approvedBlueprint, existingPlan);
      const { originalKey } = await generateAndUploadContract(recoveryContractData);
      project.contractKey = originalKey;
      project.contractGeneratedAt = new Date();
      project.originalContractDownloadedAt = undefined as any;
    }

    if (project.status === ProjectStatus.APPROVED) {
      projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
      project.status = ProjectStatus.PAYMENT_PENDING;
    }

    await project.save();
    return { paymentPlan: existingPlan, contractKey: project.contractKey, project };
  }

  if (project.status !== ProjectStatus.APPROVED) {
    throw AppError.badRequest('Payment plan selection is only available after blueprint approval');
  }

  const { blueprint, totalAmount, isPayInFull, surchargePercent, stages } = await buildPaymentStages(projectId, input.paymentType);

  const contractData = buildContractData(project, blueprint, {
    totalAmount,
    isPayInFull,
    stages,
  });
  const { originalKey } = await generateAndUploadContract(contractData);

  const plan = await PaymentPlan.create({
    projectId: project._id,
    totalAmount,
    isPayInFull,
    stages,
    createdBy: actorId,
  });

  projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
  project.status = ProjectStatus.PAYMENT_PENDING;
  project.contractKey = originalKey;
  project.contractGeneratedAt = new Date();
  project.originalContractDownloadedAt = undefined as any;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_CREATED,
    actorId,
    targetType: 'payment_plan',
    targetId: plan._id,
    details: { projectId, paymentType: input.paymentType, totalAmount, surchargePercent, stageCount: stages.length },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    actorId,
    NotificationCategory.PAYMENT,
    'Payment Plan Created',
    `Your ${isPayInFull ? 'full payment' : 'installment'} plan for "${project.title}" is ready. Please review and sign the contract next.`,
    `/projects/${project._id}`,
  );

  return { paymentPlan: plan, contractKey: originalKey, project };
}

// ── Assign Fabrication Staff ──

export async function assignFabricationStaff(
  projectId: string,
  input: AssignFabricationInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  if (![ProjectStatus.APPROVED, ProjectStatus.PAYMENT_PENDING, ProjectStatus.FABRICATION, ProjectStatus.COMPLETED].includes(project.status)) {
    throw AppError.badRequest('Fabrication team can only be assigned after the blueprint has been approved');
  }

  const latestBlueprint = await Blueprint.findOne({ projectId }).sort({ version: -1 }).select('status');
  if (!latestBlueprint) {
    throw AppError.badRequest('Fabrication team cannot be assigned until a blueprint exists');
  }

  if (latestBlueprint.status !== 'approved') {
    throw AppError.badRequest('Fabrication team can only be assigned after the customer approves the blueprint and costing');
  }

  // Verify lead is fabrication staff
  const lead = await User.findOne({
    _id: input.fabricationLeadId,
    roles: Role.FABRICATION_STAFF,
    isActive: true,
  });
  if (!lead) throw AppError.badRequest('Invalid fabrication lead');

  // Verify assistants
  if (input.fabricationAssistantIds.length > 0) {
    const assistants = await User.find({
      _id: { $in: input.fabricationAssistantIds },
      roles: Role.FABRICATION_STAFF,
      isActive: true,
    });
    if (assistants.length !== input.fabricationAssistantIds.length) {
      throw AppError.badRequest('One or more assistant IDs are invalid');
    }
  }

  project.fabricationLeadId = input.fabricationLeadId as unknown as Types.ObjectId;
  project.fabricationAssistantIds = input.fabricationAssistantIds as unknown as Types.ObjectId[];
  await project.save();

  await AuditLog.create({
    action: AuditAction.FABRICATION_ASSIGNED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { fabricationLeadId: input.fabricationLeadId, assistantIds: input.fabricationAssistantIds },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify fabrication staff
  await createAndSendNotification(
    input.fabricationLeadId,
    NotificationCategory.FABRICATION,
    'Fabrication Assignment',
    `You have been assigned as lead for project "${project.title}".`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Transition Project Status ──

export async function transitionProject(
  projectId: string,
  input: TransitionProjectInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  projectStateMachine.assertTransition(project.status, input.status);

  const oldStatus = project.status;
  project.status = input.status;

  if (input.status === ProjectStatus.CANCELLED && input.cancelReason) {
    project.cancelReason = input.cancelReason;
  }

  await project.save();

  const actionMap: Partial<Record<ProjectStatus, AuditAction>> = {
    [ProjectStatus.CANCELLED]: AuditAction.PROJECT_CANCELLED,
    [ProjectStatus.COMPLETED]: AuditAction.PROJECT_COMPLETED,
  };
  const action = actionMap[input.status] || AuditAction.PROJECT_UPDATED;

  await AuditLog.create({
    action,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { from: oldStatus, to: input.status, cancelReason: input.cancelReason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer on key transitions
  const notifyStatuses = [ProjectStatus.BLUEPRINT, ProjectStatus.APPROVED, ProjectStatus.FABRICATION, ProjectStatus.COMPLETED, ProjectStatus.CANCELLED];
  if (notifyStatuses.includes(input.status)) {
    const statusMessages: Record<string, string> = {
      [ProjectStatus.BLUEPRINT]: 'is now in the blueprint phase.',
      [ProjectStatus.APPROVED]: 'blueprint has been approved and is ready for payment.',
      [ProjectStatus.FABRICATION]: 'is now in fabrication.',
      [ProjectStatus.COMPLETED]: 'has been completed!',
      [ProjectStatus.CANCELLED]: `has been cancelled.${input.cancelReason ? ` Reason: ${input.cancelReason}` : ''}`,
    };

    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      'Project Update',
      `Your project "${project.title}" ${statusMessages[input.status]}`,
      `/projects/${project._id}`,
    );
  }

  return project;
}

// ── Get Project by ID ──

export async function getProjectById(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone')
    .populate('salesStaffId', 'firstName lastName')
    .populate('engineerIds', 'firstName lastName phone')
    .populate('designReviewedBy', 'firstName lastName')
    .populate('customerReview.submittedBy', 'firstName lastName')
    .populate('initialDesignBackfill.backfilledBy', 'firstName lastName')
    .populate('fabricationLeadId', 'firstName lastName')
    .populate('fabricationAssistantIds', 'firstName lastName')
    .populate('visitReportId');

  if (!project) throw AppError.notFound('Project not found');

  // Fallback: if visitReportId was never linked, find the latest submitted report for the appointment
  if (!project.visitReportId && project.appointmentId) {
    const fallbackReport = await VisitReport.findOne({
      appointmentId: project.appointmentId,
      status: { $in: [VisitReportStatus.SUBMITTED, VisitReportStatus.COMPLETED] },
    }).sort({ createdAt: -1 });

    if (fallbackReport) {
      // Persist the link so future queries don't need the fallback
      project.visitReportId = fallbackReport._id;
      await project.save();
      // Re-populate since we just set it as an ObjectId
      await project.populate('visitReportId');
    }
  }

  // Customers can only see their own
  if (
    actorRoles.includes(Role.CUSTOMER) &&
    !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r))
  ) {
    if (project.customerId._id?.toString() !== actorId) {
      throw AppError.forbidden('Access denied');
    }
  }

  // Epic 9: Engineer/Fabrication staff masking (AND Admin as requested)
  const isPrivileged = actorRoles.some((r) =>
    [Role.SALES_STAFF, Role.CASHIER].includes(r as Role)
  );

  if (!isPrivileged) {
    // Mask financial data for engineers/fabricators
    const maskedProject = project.toObject();
    maskedProject.totalCost = undefined;
    return maskedProject;
  }

  return project;
}

// ── List Projects ──

export async function getProjectByVisitReportId(visitReportId: string) {
  // Direct match: project was created from this visit report
  const project = await Project.findOne({ visitReportId }).select('_id title serviceType status').lean();
  if (project) return project;

  // Indirect match: ocular visit report linked to the consultation's project
  const report = await VisitReport.findById(visitReportId).select('linkedProjectId').lean();
  if (report?.linkedProjectId) {
    return Project.findById(report.linkedProjectId).select('_id title serviceType status').lean();
  }

  return null;
}

export async function listProjects(
  query: {
    status?: string;
    customerId?: string;
    salesStaffId?: string;
    engineerId?: string;
    search?: string;
    page?: string;
    limit?: string;
    sortBy?: string;
    sortOrder?: string;
  },
  actorId: string,
  actorRoles: Role[],
) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);
  const filter: Record<string, unknown> = {};

  // Role-based filtering
  if (actorRoles.includes(Role.CUSTOMER) && !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF, Role.ENGINEER].includes(r))) {
    filter.customerId = actorId;
  } else if (actorRoles.includes(Role.SALES_STAFF) && !actorRoles.some(r => [Role.ADMIN].includes(r))) {
    filter.salesStaffId = actorId;
  } else if (actorRoles.includes(Role.ENGINEER) && !actorRoles.some(r => [Role.ADMIN, Role.SALES_STAFF].includes(r))) {
    filter.$or = [
      { engineerIds: actorId },
      { status: ProjectStatus.SUBMITTED, engineerIds: { $size: 0 } },
    ];
  } else if (actorRoles.includes(Role.FABRICATION_STAFF) && !actorRoles.some(r => [Role.ADMIN, Role.ENGINEER].includes(r))) {
    // Fabrication staff see all projects currently in the fabrication stage
    filter.status = ProjectStatus.FABRICATION;
  }

  if (query.status === 'active') {
    // 'active' = all non-terminal statuses
    filter.status = { $nin: [ProjectStatus.COMPLETED, ProjectStatus.CANCELLED] };
  } else if (query.status) {
    filter.status = query.status;
  }
  if (query.customerId && !filter.customerId) filter.customerId = query.customerId;
  if (query.salesStaffId && !filter.salesStaffId) filter.salesStaffId = query.salesStaffId;
  if (query.engineerId && !filter.engineerIds) filter.engineerIds = query.engineerId;
  if (query.search) {
    const searchOr = [
      { title: { $regex: query.search, $options: 'i' } },
      { serviceType: { $regex: query.search, $options: 'i' } },
      { description: { $regex: query.search, $options: 'i' } },
    ];
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, { $or: searchOr }];
      delete filter.$or;
    } else {
      filter.$or = searchOr;
    }
  }

  const sortField = query.sortBy || 'createdAt';
  const sortOrder = query.sortOrder === 'asc' ? 1 : -1;

  const [projects, total] = await Promise.all([
    Project.find(filter)
      .populate('customerId', 'firstName lastName email')
      .populate('salesStaffId', 'firstName lastName')
      .populate('engineerIds', 'firstName lastName phone')
      .sort({ [sortField]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit),
    Project.countDocuments(filter),
  ]);

  return {
    items: await enrichWithBlueprintStatus(projects),
    total,
    hasMore: page * limit < total,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
}

/** Attach `latestBlueprintStatus` to each project for the list view */
async function enrichWithBlueprintStatus(projects: any[]) {
  if (!projects.length) return projects;
  const projectIds = projects.map((p) => p._id);
  // One aggregate: get the latest blueprint per project
  const latestBlueprints = await Blueprint.aggregate([
    { $match: { projectId: { $in: projectIds } } },
    { $sort: { version: -1 } },
    { $group: { _id: '$projectId', status: { $first: '$status' } } },
  ]);
  const bpMap = new Map(latestBlueprints.map((b) => [String(b._id), b.status]));
  return projects.map((p) => {
    const obj = p.toObject ? p.toObject() : { ...p };
    obj.latestBlueprintStatus = bpMap.get(String(obj._id)) || null;
    return obj;
  });
}

// ── Add media keys (reference photos) ──

export async function addMediaKeys(
  projectId: string,
  keys: string[],
  actorId: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  project.mediaKeys.push(...keys);
  await project.save();

  return project;
}

// ── Remove media key ──

export async function removeMediaKey(
  projectId: string,
  key: string,
  actorId: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  project.mediaKeys = project.mediaKeys.filter(k => k !== key);
  await project.save();

  return project;
}

// ── Generate Contract PDF ──

export async function generateContract(
  projectId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');

  // Must be in APPROVED or later
  const allowedStatuses = [
    ProjectStatus.APPROVED,
    ProjectStatus.PAYMENT_PENDING,
    ProjectStatus.FABRICATION,
    ProjectStatus.COMPLETED,
  ];
  if (!allowedStatuses.includes(project.status)) {
    throw AppError.badRequest('Contract can only be generated after blueprint acceptance');
  }

  // Get the latest blueprint for quotation
  const blueprint = await Blueprint.findOne({ projectId })
    .sort({ version: -1 });

  if (!blueprint?.quotation) {
    throw AppError.badRequest('No quotation found for this project');
  }

  // Get payment plan
  const paymentPlan = await PaymentPlan.findOne({ projectId });
  if (!paymentPlan) {
    throw AppError.badRequest('No payment plan found for this project');
  }

  const customer = project.customerId as any;
  const contractData = buildContractData(project, blueprint, paymentPlan);

  const { originalKey, copyKey } = await generateAndUploadContract(contractData);

  // Store the original key on the project
  project.contractKey = originalKey;
  project.contractGeneratedAt = new Date();
  project.originalContractDownloadedAt = undefined as any; // reset one-time download on regeneration
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'contract_generated', originalKey, copyKey },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    customer._id,
    NotificationCategory.SYSTEM,
    'Contract Ready',
    `The contract for your project "${project.title}" has been generated and is ready for download.`,
    `/projects/${project._id}`,
  );

  logger.info(`Contract generated for project ${projectId}: ${originalKey}`);

  return { originalKey, copyKey, project };
}

// ── Sign Contract (Customer) ──

export async function signContract(
  projectId: string,
  input: SignContractInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email phone address signatureKey')
    .populate('engineerIds', 'firstName lastName phone signatureKey');

  if (!project) throw AppError.notFound('Project not found');

  // Only the customer can sign
  if (String(project.customerId._id ?? project.customerId) !== actorId) {
    throw AppError.forbidden('Only the project customer can sign the contract');
  }

  // Must have a contract generated already
  if (!project.contractKey) {
    throw AppError.badRequest('No contract has been generated for this project yet');
  }

  // Must not already be signed
  if (project.contractSignedAt) {
    throw AppError.badRequest('Contract has already been signed');
  }

  // Save signature key on the user record
  await User.findByIdAndUpdate(actorId, { signatureKey: input.signatureKey });

  // Save signature key + signed timestamp on the project
  project.contractSignatureKey = input.signatureKey;
  project.contractSignedAt = new Date();
  await project.save();

  // Re-generate contract PDF with the signature embedded
  try {
    const blueprint = await Blueprint.findOne({ projectId }).sort({ version: -1 });
    const paymentPlan = await PaymentPlan.findOne({ projectId });

    if (blueprint?.quotation && paymentPlan) {
      const contractData: ContractData = {
        ...buildContractData(project, blueprint, paymentPlan),
        customerSignatureKey: input.signatureKey,
        contractSignedAt: project.contractSignedAt,
      };

      const { originalKey } = await generateAndUploadContract(contractData);
      project.contractKey = originalKey;
      project.contractGeneratedAt = new Date();
      project.originalContractDownloadedAt = undefined as any; // reset one-time download
      await project.save();

      logger.info(`Contract re-generated with signature for project ${projectId}: ${originalKey}`);
    }
  } catch (err) {
    logger.error('Failed to re-generate contract with signature', err);
  }

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'contract_signed', signatureKey: input.signatureKey },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer(s) and admin
  const engineerIds = (project.engineerIds as any[]).map((e: any) => e._id ?? e);
  for (const engId of engineerIds) {
    await createAndSendNotification(
      engId,
      NotificationCategory.SYSTEM,
      'Contract Signed',
      `Customer signed the contract for project "${project.title}". Payments can now proceed.`,
      `/projects/${project._id}`,
    );
  }

  await notifyRole(
    Role.ADMIN,
    NotificationCategory.SYSTEM,
    'Contract Signed',
    `Contract for project "${project.title}" has been signed by the customer.`,
    `/projects/${project._id}`,
  );

  return project;
}

export async function signEngineerContract(
  projectId: string,
  input: SignEngineerContractInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId).populate('engineerIds', 'firstName lastName email signatureKey');
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isAssignedEngineer = project.engineerIds.some((eng) => String((eng as any)._id ?? eng) === actorId);

  if (!isAdmin && !isAssignedEngineer) {
    throw AppError.forbidden('Only assigned engineers or admins can sign this contract');
  }

  await User.findByIdAndUpdate(actorId, { signatureKey: input.signatureKey });

  project.engineerContractSignatureKey = input.signatureKey;
  project.engineerContractSignedAt = new Date();
  project.engineerContractSignedBy = actorId as unknown as Types.ObjectId;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { action: 'engineer_contract_signed', signatureKey: input.signatureKey },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.customerId,
    NotificationCategory.SYSTEM,
    'Engineer Contract Signed',
    `Engineering has signed the contract for project "${project.title}". Design and costing can now be sent for your review.`,
    `/projects/${project._id}`,
  );

  return project;
}

// ── Get Contract Download URL ──

export async function getContractDownloadUrl(
  projectId: string,
  copy: 'original' | 'copy',
  actorId: string,
  actorRoles: Role[],
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  if (!project.contractKey) {
    throw AppError.badRequest('No contract has been generated for this project');
  }

  // One-time original download enforcement
  if (copy === 'original' && project.originalContractDownloadedAt) {
    throw AppError.badRequest(
      'The original contract has already been downloaded. Please use the copy version.',
    );
  }

  // Derive copy key from original key
  const key = copy === 'original'
    ? project.contractKey
    : project.contractKey.replace('-original.pdf', '-copy.pdf');

  const url = await generateDownloadUrl(key);

  // Mark original as downloaded
  if (copy === 'original') {
    project.originalContractDownloadedAt = new Date();
    await project.save();
  }

  return { url, key, originalDownloaded: !!project.originalContractDownloadedAt };
}

// ── Customer: Submit/Skip Internal Project Review ──

export async function submitProjectReview(
  projectId: string,
  input: SubmitProjectReviewInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomerOwner = project.customerId.toString() === actorId;
  if (!isAdmin && !isCustomerOwner) {
    throw AppError.forbidden('Only the project customer can submit a review');
  }

  if (project.status !== ProjectStatus.COMPLETED) {
    throw AppError.badRequest('Reviews are only available after project completion');
  }

  if (project.customerReview?.submittedAt) {
    throw AppError.conflict('A review has already been submitted for this project');
  }

  project.customerReview = {
    rating: input.rating,
    comment: input.comment,
    submittedAt: new Date(),
    submittedBy: actorId as unknown as Types.ObjectId,
    skippedAt: undefined,
    skippedReason: undefined,
  };
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'customer_review_submitted',
      rating: input.rating,
      hasComment: !!input.comment,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await createAndSendNotification(
    project.salesStaffId,
    NotificationCategory.PROJECT,
    'Customer Review Submitted',
    `A ${input.rating}-star review was submitted for project "${project.title}".`,
    `/projects/${project._id}`,
  );

  return project;
}

export async function skipProjectReview(
  projectId: string,
  input: SkipProjectReviewInput,
  actorId: string,
  actorRoles: Role[],
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(projectId);
  if (!project) throw AppError.notFound('Project not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomerOwner = project.customerId.toString() === actorId;
  if (!isAdmin && !isCustomerOwner) {
    throw AppError.forbidden('Only the project customer can skip review');
  }

  if (project.status !== ProjectStatus.COMPLETED) {
    throw AppError.badRequest('Review options are only available after project completion');
  }

  if (project.customerReview?.submittedAt) {
    throw AppError.conflict('A review has already been submitted for this project');
  }

  if (project.customerReview?.skippedAt) {
    return project;
  }

  project.customerReview = {
    ...project.customerReview,
    skippedAt: new Date(),
    skippedReason: input.reason,
  };
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: {
      action: 'customer_review_skipped',
      reason: input.reason || null,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  return project;
}

// ── Customer: Confirm Installation Schedule ──

export async function confirmInstallation(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const project = await Project.findById(projectId)
    .populate('customerId', 'firstName lastName email')
    .populate('fabricationLeadId', '_id firstName lastName');
  if (!project) throw AppError.notFound('Project not found');

  if (project.status !== ProjectStatus.FABRICATION) {
    throw AppError.badRequest('Project is not currently in the fabrication phase');
  }

  const isAdmin = actorRoles.includes(Role.ADMIN);
  const isCustomer = actorRoles.includes(Role.CUSTOMER) && project.customerId._id?.toString() === actorId;

  if (!isAdmin && !isCustomer) {
    throw AppError.forbidden('Only the project customer or an admin can confirm installation');
  }

  if ((project as any).installationConfirmedAt) {
    throw AppError.badRequest('Installation has already been confirmed for this project');
  }

  (project as any).installationConfirmedAt = new Date();
  await project.save();

  await AuditLog.create({
    action: AuditAction.PROJECT_UPDATED,
    actorId,
    targetType: 'project',
    targetId: project._id,
    details: { installationConfirmed: true },
  });

  // Notify fabrication lead and all admin
  const customerRef = project.customerId as any;
  const customerName = `${customerRef.firstName} ${customerRef.lastName}`;

  if (project.fabricationLeadId) {
    const leadId = (project.fabricationLeadId as any)._id ?? project.fabricationLeadId;
    await createAndSendNotification(
      leadId,
      NotificationCategory.PROJECT,
      'Installation Confirmed',
      `Customer ${customerName} has confirmed the installation schedule for project "${project.title}". You may now proceed to mark it as Done.`,
      `/projects/${project._id}/fabrication`,
    );
  }

  await notifyRole(
    Role.ADMIN,
    NotificationCategory.PROJECT,
    'Installation Confirmed',
    `Customer ${customerName} confirmed installation for project "${project.title}".`,
    `/projects/${project._id}/fabrication`,
  );

  return project;
}
