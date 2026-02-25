import {
  Blueprint, Project, User, AuditLog, PaymentPlan,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  BlueprintStatus, BlueprintComponent, ProjectStatus,
  AuditAction, NotificationCategory, Role, PaymentStageStatus,
} from '../../utils/constants.js';
import { blueprintStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { sendBlueprintUploadedEmail } from '../notifications/email.service.js';
import { getInstallmentConfig } from '../config/config.service.js';
import { generateAndUploadContract } from '../../services/contract.service.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import type {
  UploadBlueprintInput,
  RevisionUploadInput,
  ApproveBlueprintInput,
  RequestRevisionInput,
  AcceptBlueprintInput,
} from './blueprints.validation.js';
import type { Types } from 'mongoose';

const MAX_REVISIONS = 3;

// ── Engineer: Upload Initial Blueprint ──

export async function uploadBlueprint(
  input: UploadBlueprintInput,
  uploadedBy: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Project must be in blueprint phase or submitted
  if (![ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(project.status)) {
    throw AppError.badRequest('Project is not in a valid state for blueprint upload');
  }

  // Check if initial version already exists
  const existing = await Blueprint.findOne({ projectId: input.projectId, version: 1 });
  if (existing) {
    throw AppError.conflict('Initial blueprint already uploaded. Use revision upload.', ErrorCode.DUPLICATE_ENTRY);
  }

  const blueprint = await Blueprint.create({
    projectId: input.projectId,
    version: 1,
    status: BlueprintStatus.UPLOADED,
    blueprintKey: input.blueprintKey,
    costingKey: input.costingKey,
    uploadedBy,
    quotation: input.quotation,
  });

  // Transition project to blueprint phase if submitted
  if (project.status === ProjectStatus.SUBMITTED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
    await project.save();
  }

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_UPLOADED,
    actorId: uploadedBy,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { projectId: input.projectId, version: 1 },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.BLUEPRINT,
      'Blueprint Uploaded',
      `A blueprint (Version 1) has been uploaded for your project "${project.title}". Please review and approve.`,
      `/projects/${project._id}/blueprint`,
    );

    await sendBlueprintUploadedEmail(customer.email, {
      version: 1,
      projectTitle: project.title,
    });
  }

  return blueprint;
}

// ── Engineer: Upload Revision ──

export async function uploadRevision(
  blueprintId: string,
  input: RevisionUploadInput,
  uploadedBy: string,
  ip?: string,
  ua?: string,
) {
  const currentBlueprint = await Blueprint.findById(blueprintId);
  if (!currentBlueprint) throw AppError.notFound('Blueprint not found');

  if (currentBlueprint.status !== BlueprintStatus.REVISION_REQUESTED) {
    throw AppError.badRequest('A revision can only be uploaded when revision is requested');
  }

  const newVersion = currentBlueprint.version + 1;

  // Max 3 revisions check (initial + 3 revisions = version 4 max)
  if (newVersion > MAX_REVISIONS + 1) {
    throw AppError.badRequest(`Maximum of ${MAX_REVISIONS} revisions allowed`);
  }

  const project = await Project.findById(currentBlueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Mark current as superseded by updating status
  currentBlueprint.status = BlueprintStatus.REVISION_UPLOADED;
  await currentBlueprint.save();

  // Create new version
  const blueprint = await Blueprint.create({
    projectId: currentBlueprint.projectId,
    version: newVersion,
    status: BlueprintStatus.UPLOADED,
    blueprintKey: input.blueprintKey,
    costingKey: input.costingKey,
    uploadedBy,
  });

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_REVISION_UPLOADED,
    actorId: uploadedBy,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { projectId: currentBlueprint.projectId.toString(), version: newVersion, previousId: blueprintId },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.BLUEPRINT,
      'Blueprint Revision Uploaded',
      `A revised blueprint (Version ${newVersion}) has been uploaded for "${project.title}". Please review.`,
      `/projects/${project._id}/blueprint`,
    );

    await sendBlueprintUploadedEmail(customer.email, {
      version: newVersion,
      projectTitle: project.title,
    });
  }

  return blueprint;
}

// ── Customer: Approve Component ──

export async function approveComponent(
  blueprintId: string,
  input: ApproveBlueprintInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  // Verify ownership
  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can approve blueprints');
  }

  if (blueprint.status !== BlueprintStatus.UPLOADED && blueprint.status !== BlueprintStatus.REVISION_UPLOADED) {
    throw AppError.badRequest('Blueprint is not in a reviewable state');
  }

  if (input.component === BlueprintComponent.BLUEPRINT) {
    blueprint.blueprintApproved = true;
  } else {
    blueprint.costingApproved = true;
  }

  // If both approved, mark blueprint as approved
  if (blueprint.blueprintApproved && blueprint.costingApproved) {
    blueprint.status = BlueprintStatus.APPROVED;

    // Transition project to approved
    if (project.status === ProjectStatus.BLUEPRINT) {
      projectStateMachine.assertTransition(project.status, ProjectStatus.APPROVED);
      project.status = ProjectStatus.APPROVED;
      await project.save();
    }
  }

  await blueprint.save();

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_APPROVED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: {
      component: input.component,
      blueprintApproved: blueprint.blueprintApproved,
      costingApproved: blueprint.costingApproved,
      fullyApproved: blueprint.status === BlueprintStatus.APPROVED,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  const notifyMessage = blueprint.status === BlueprintStatus.APPROVED
    ? `Blueprint and costing for "${project.title}" have been fully approved.`
    : `Customer approved the ${input.component} for "${project.title}".`;

  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    blueprint.status === BlueprintStatus.APPROVED ? 'Blueprint Fully Approved' : 'Component Approved',
    notifyMessage,
    `/projects/${project._id}/blueprint`,
  );

  return blueprint;
}

// ── Customer: Request Revision ──

export async function requestRevision(
  blueprintId: string,
  input: RequestRevisionInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can request revisions');
  }

  // Check max revisions
  if (blueprint.version >= MAX_REVISIONS + 1) {
    throw AppError.badRequest(`Maximum of ${MAX_REVISIONS} revisions reached`);
  }

  blueprintStateMachine.assertTransition(blueprint.status, BlueprintStatus.REVISION_REQUESTED);

  blueprint.status = BlueprintStatus.REVISION_REQUESTED;
  blueprint.revisionNotes = input.notes;
  blueprint.revisionRefKeys = input.refKeys;
  await blueprint.save();

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_REVISION_REQUESTED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { notes: input.notes, version: blueprint.version },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    'Revision Requested',
    `Customer requested a revision for blueprint V${blueprint.version} of "${project.title}". Notes: ${input.notes}`,
    `/projects/${project._id}/blueprint`,
  );

  return blueprint;
}

// ── Get Blueprint by ID ──

async function assertBlueprintProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds fabricationLeadId fabricationAssistantIds status');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.includes(Role.ADMIN)) return;

  if (actorRoles.includes(Role.CUSTOMER) && project.customerId.toString() === actorId) return;
  if (actorRoles.includes(Role.SALES_STAFF) && project.salesStaffId?.toString() === actorId) return;

  if (actorRoles.includes(Role.ENGINEER)) {
    // Assigned engineer
    if (project.engineerIds.some((id) => id.toString() === actorId)) return;
    // Unassigned submitted projects (engineers can browse these)
    if (project.status === ProjectStatus.SUBMITTED && project.engineerIds.length === 0) return;
  }

  if (
    actorRoles.includes(Role.FABRICATION_STAFF) &&
    (project.fabricationLeadId?.toString() === actorId ||
      project.fabricationAssistantIds.some((id) => id.toString() === actorId))
  ) return;

  throw AppError.forbidden('Access denied');
}

export async function getBlueprintById(
  blueprintId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const blueprint = await Blueprint.findById(blueprintId)
    .populate('uploadedBy', 'firstName lastName phone');
  if (!blueprint) throw AppError.notFound('Blueprint not found');
  await assertBlueprintProjectAccess(blueprint.projectId.toString(), actorId, actorRoles);
  return blueprint;
}

// ── List Blueprints for a Project ──

export async function listBlueprintsByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprints = await Blueprint.find({ projectId })
    .populate('uploadedBy', 'firstName lastName phone')
    .sort({ version: -1 });
  return blueprints;
}

// ── Get Latest Blueprint for a Project ──

export async function getLatestBlueprint(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprint = await Blueprint.findOne({ projectId })
    .sort({ version: -1 })
    .populate('uploadedBy', 'firstName lastName phone');
  return blueprint;
}

// ── Customer: Accept Blueprint (approve both + choose payment type + auto-create plan) ──

export async function acceptBlueprint(
  blueprintId: string,
  input: AcceptBlueprintInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const blueprint = await Blueprint.findById(blueprintId);
  if (!blueprint) throw AppError.notFound('Blueprint not found');

  const project = await Project.findById(blueprint.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('Only the project customer can accept blueprints');
  }

  if (![BlueprintStatus.UPLOADED, BlueprintStatus.REVISION_UPLOADED, BlueprintStatus.APPROVED].includes(blueprint.status)) {
    throw AppError.badRequest('Blueprint is not in a reviewable state');
  }

  if (!blueprint.quotation || blueprint.quotation.total <= 0) {
    throw AppError.badRequest('Cannot accept a blueprint without a valid quotation. Please ask the engineer to provide pricing.');
  }

  // Mark both components as approved
  blueprint.blueprintApproved = true;
  blueprint.costingApproved = true;
  blueprint.status = BlueprintStatus.APPROVED;
  await blueprint.save();

  // Transition project: BLUEPRINT → APPROVED → PAYMENT_PENDING
  if (project.status === ProjectStatus.BLUEPRINT) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.APPROVED);
    project.status = ProjectStatus.APPROVED;
    await project.save();
  }

  // Auto-generate payment plan
  const baseTotal = blueprint.quotation.total;
  let finalTotal = baseTotal;
  let isPayInFull = true;

  const installmentConfig = await getInstallmentConfig();

  if (input.paymentType === 'installment') {
    isPayInFull = false;
    const surcharge = installmentConfig.surchargePercent;
    finalTotal = Math.round(baseTotal * (1 + surcharge / 100) * 100) / 100;
  }

  let stages;
  if (isPayInFull) {
    stages = [{
      stageId: uuidv4(),
      label: 'Full Payment',
      percentage: 100,
      amount: finalTotal,
      status: PaymentStageStatus.PENDING,
      amountPaid: 0,
      creditApplied: 0,
      remainingBalance: finalTotal,
    }];
  } else {
    stages = installmentConfig.split.map((pct, idx) => {
      const amount = Math.round((finalTotal * pct / 100) * 100) / 100;
      return {
        stageId: uuidv4(),
        label: installmentConfig.stageLabels[idx] || `Stage ${idx + 1}`,
        percentage: pct,
        amount,
        status: PaymentStageStatus.PENDING,
        amountPaid: 0,
        creditApplied: 0,
        remainingBalance: amount,
      };
    });
  }

  // Check no existing plan
  const existingPlan = await PaymentPlan.findOne({ projectId: project._id });
  if (existingPlan) {
    throw AppError.conflict('A payment plan already exists for this project', ErrorCode.DUPLICATE_ENTRY);
  }

  const plan = await PaymentPlan.create({
    projectId: project._id,
    totalAmount: finalTotal,
    isPayInFull,
    stages,
    createdBy: customerId,
  });

  // Transition project to PAYMENT_PENDING
  if (project.status === ProjectStatus.APPROVED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
    project.status = ProjectStatus.PAYMENT_PENDING;
    await project.save();
  }

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_APPROVED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: {
      fullyApproved: true,
      paymentType: input.paymentType,
      totalAmount: finalTotal,
      surchargePercent: isPayInFull ? 0 : installmentConfig.surchargePercent,
      stages: stages.length,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `Customer accepted the blueprint for "${project.title}" and chose ${isPayInFull ? 'full payment' : 'installment payment'}.`,
    `/projects/${project._id}/blueprint`,
  );

  // Notify customer
  await createAndSendNotification(
    customerId,
    NotificationCategory.PAYMENT,
    'Payment Plan Created',
    `Your payment plan for "${project.title}" is ready. Total: ₱${finalTotal.toLocaleString('en-PH', { minimumFractionDigits: 2 })}.`,
    `/projects/${project._id}`,
  );

  // ── Auto-generate contract PDF (without customer signature — they sign later) ──
  try {
    const customer = await User.findById(customerId).select('firstName lastName email phone address');
    const engineers = await User.find({ _id: { $in: project.engineerIds } }).select('firstName lastName');

    const contractData = {
      projectTitle: project.title,
      projectDescription: project.description,
      siteAddress: project.siteAddress,
      serviceType: project.serviceType,
      customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
      customerEmail: customer?.email || '',
      customerPhone: customer?.phone,
      customerAddress: customer?.address,
      engineerNames: engineers.map((e: any) => `${e.firstName} ${e.lastName}`),
      totalAmount: finalTotal,
      paymentType: input.paymentType as 'full' | 'installment',
      stages: stages.map(s => ({ label: s.label, percentage: s.percentage, amount: s.amount })),
      estimatedDuration: blueprint.quotation.estimatedDuration,
      materialType: project.materialType,
      finishColor: project.finishColor,
      quantity: project.quantity,
      customerSignatureKey: null, // Signature will be added when customer signs the contract
    };

    const { originalKey } = await generateAndUploadContract(contractData);

    project.contractKey = originalKey;
    project.contractGeneratedAt = new Date();
    await project.save();

    // Notify customer about contract — tell them to review and sign
    await createAndSendNotification(
      customerId,
      NotificationCategory.SYSTEM,
      'Contract Ready for Signing',
      `The contract for your project "${project.title}" has been generated. Please review and e-sign it before making any payments.`,
      `/projects/${project._id}`,
    );

    logger.info(`Auto-generated contract on blueprint accept for project ${project._id}: ${originalKey}`);
  } catch (err) {
    // Contract generation failure should NOT block the accept flow
    logger.error('Failed to auto-generate contract on blueprint accept', err);
  }

  return { blueprint, paymentPlan: plan };
}
