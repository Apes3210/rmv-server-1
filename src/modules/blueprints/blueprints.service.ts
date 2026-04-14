import {
  Blueprint, BlueprintDraft, Project, User, AuditLog, PaymentPlan,
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
import { deleteFile } from '../uploads/upload.service.js';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';
import type {
  UploadBlueprintInput,
  RevisionUploadInput,
  ApproveBlueprintInput,
  RequestRevisionInput,
  AcceptBlueprintInput,
  UpsertBlueprintDraftInput,
} from './blueprints.validation.js';
import type { Types } from 'mongoose';

const MAX_REVISIONS = 3;

interface BlueprintDraftFileInput {
  key: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: Date;
}

interface BlueprintDraftQuotationInput {
  lineItems?: Array<{
    label: string;
    quantity: number;
    materials: string;
    labor: string;
  }>;
  fees?: string;
  validityDays?: string;
  breakdown?: string;
  estimatedDuration?: string;
  engineerNotes?: string;
  paymentMilestones?: Array<{ label: string; description: string }>;
}

function normalizeDraftFile(
  file?: BlueprintDraftFileInput | null,
): BlueprintDraftFileInput | null | undefined {
  if (file === undefined) return undefined;
  if (file === null) return null;

  return {
    key: file.key,
    name: file.name,
    type: file.type,
    size: file.size,
    uploadedAt: new Date(file.uploadedAt),
  };
}

function normalizeDraftQuotation(
  quotation?: BlueprintDraftQuotationInput,
): BlueprintDraftQuotationInput | undefined {
  if (!quotation) return undefined;

  return {
    lineItems: quotation.lineItems?.map((lineItem) => ({
      label: lineItem.label,
      quantity: lineItem.quantity,
      materials: lineItem.materials,
      labor: lineItem.labor,
    })),
    fees: quotation.fees ?? '',
    validityDays: quotation.validityDays ?? '30',
    breakdown: quotation.breakdown ?? '',
    estimatedDuration: quotation.estimatedDuration ?? '',
    engineerNotes: quotation.engineerNotes ?? '',
    paymentMilestones: quotation.paymentMilestones?.map((milestone) => ({
      label: milestone.label,
      description: milestone.description,
    })),
  };
}

function getDraftFileKeys(files?: {
  blueprint?: { key: string } | null;
  design?: { key: string } | null;
  costing?: { key: string } | null;
}) {
  return [files?.blueprint?.key, files?.design?.key, files?.costing?.key]
    .filter((value): value is string => Boolean(value));
}

function buildQuotationFromDraft(quotation?: BlueprintDraftQuotationInput) {
  const lineItems = (quotation?.lineItems || [])
    .filter((lineItem) => lineItem.label.trim())
    .map((lineItem) => {
      const materials = Number(lineItem.materials) || 0;
      const labor = Number(lineItem.labor) || 0;
      return {
        label: lineItem.label,
        quantity: lineItem.quantity,
        materials,
        labor,
        amount: (materials + labor) * lineItem.quantity,
      };
    });

  const totalMaterials = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.materials * lineItem.quantity,
    0,
  );
  const totalLabor = lineItems.reduce(
    (sum, lineItem) => sum + lineItem.labor * lineItem.quantity,
    0,
  );
  const fees = Number(quotation?.fees) || 0;
  const total = totalMaterials + totalLabor + fees;
  const validMilestones = (quotation?.paymentMilestones || [])
    .filter((milestone) => milestone.label.trim() && milestone.description.trim());

  if (total <= 0) {
    return undefined;
  }

  return {
    materials: totalMaterials,
    labor: totalLabor,
    fees,
    total,
    lineItems: lineItems.length > 0 ? lineItems : undefined,
    validityDays: Number(quotation?.validityDays) || 30,
    breakdown: quotation?.breakdown?.trim() || undefined,
    estimatedDuration: quotation?.estimatedDuration?.trim() || undefined,
    engineerNotes: quotation?.engineerNotes?.trim() || undefined,
    paymentMilestones: validMilestones.length > 0 ? validMilestones : undefined,
  };
}

async function assertAssignedEngineerForProject(projectId: string, actorId: string) {
  const project = await Project.findById(projectId).select('engineerIds status');
  if (!project) throw AppError.notFound('Project not found');

  const isAssignedEngineer = project.engineerIds.some((id) => id.toString() === actorId);
  if (!isAssignedEngineer) {
    throw AppError.forbidden('Only engineers assigned to this project can manage blueprint drafts');
  }

  return project;
}

async function deleteDraftFiles(keys: string[]) {
  await Promise.allSettled(keys.map((key) => deleteFile(key)));
}

function assertEngineerContractSigned(project: { engineerContractSignedAt?: Date | null }) {
  if (!project.engineerContractSignedAt) {
    throw AppError.badRequest('Engineer must sign the contract before sending design and costing to the customer');
  }
}

// ── Engineer: Upload Initial Blueprint ──

export async function uploadBlueprint(
  input: UploadBlueprintInput,
  uploadedBy: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');



  if ((project.initialDesignKeys?.length || project.initialDesignNotes?.trim()) && !['approved', 'not_required'].includes(project.designReviewStatus || 'not_required')) {
    throw AppError.badRequest('The sales initial design must be approved by engineering before the first blueprint upload');
  }

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
    designKey: input.designKey,
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
      projectId: project._id.toString(),
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

  // Create new version (carry over quotation if provided, otherwise keep previous)
  const blueprint = await Blueprint.create({
    projectId: currentBlueprint.projectId,
    version: newVersion,
    status: BlueprintStatus.UPLOADED,
    blueprintKey: input.blueprintKey,
    designKey: input.designKey,
    costingKey: input.costingKey,
    uploadedBy,
    quotation: input.quotation ?? currentBlueprint.quotation,
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
      projectId: project._id.toString(),
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

  // If the blueprint was already fully approved, revert the project back to BLUEPRINT stage
  if (blueprint.status === BlueprintStatus.APPROVED && project.status === ProjectStatus.APPROVED) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
    await project.save();
  }

  blueprint.status = BlueprintStatus.REVISION_REQUESTED;
  blueprint.blueprintApproved = false;
  blueprint.costingApproved = false;
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

// ── Engineer: Draft Autosave ──

export async function getBlueprintDraft(projectId: string, actorId: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  return BlueprintDraft.findOne({ projectId })
    .populate('createdBy', 'firstName lastName phone')
    .populate('lastEditedBy', 'firstName lastName phone');
}

export async function upsertBlueprintDraft(
  projectId: string,
  input: UpsertBlueprintDraftInput,
  actorId: string,
) {
  const project = await assertAssignedEngineerForProject(projectId, actorId);
  const latestBlueprint = await Blueprint.findOne({ projectId })
    .sort({ version: -1 })
    .select('_id status');

  if (input.mode === 'initial') {
    if (latestBlueprint) {
      throw AppError.badRequest('Initial blueprint draft is not available after a blueprint has been uploaded');
    }

    if (![ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(project.status)) {
      throw AppError.badRequest('Blueprint drafts are not available for this project right now');
    }
  }

  if (input.mode === 'revision') {
    if (!latestBlueprint || latestBlueprint.status !== BlueprintStatus.REVISION_REQUESTED) {
      throw AppError.badRequest('Revision draft is only available when a customer has requested a revision');
    }

    if (input.sourceBlueprintId && input.sourceBlueprintId !== latestBlueprint._id.toString()) {
      throw AppError.badRequest('Revision draft must target the latest revision-requested blueprint');
    }
  }

  let draft = await BlueprintDraft.findOne({ projectId });
  const previousFiles = {
    blueprint: draft?.files?.blueprint ?? null,
    design: draft?.files?.design ?? null,
    costing: draft?.files?.costing ?? null,
  };

  if (!draft) {
    draft = new BlueprintDraft({
      projectId,
      createdBy: actorId,
    });
  }

  const nextFiles = {
    blueprint:
      input.files && 'blueprint' in input.files
        ? normalizeDraftFile(input.files.blueprint ?? null) ?? null
        : draft.files?.blueprint ?? null,
    design:
      input.files && 'design' in input.files
        ? normalizeDraftFile(input.files.design ?? null) ?? null
        : draft.files?.design ?? null,
    costing:
      input.files && 'costing' in input.files
        ? normalizeDraftFile(input.files.costing ?? null) ?? null
        : draft.files?.costing ?? null,
  };

  draft.mode = input.mode;
  draft.sourceBlueprintId =
    input.mode === 'revision' && latestBlueprint ? latestBlueprint._id : undefined;
  draft.files = nextFiles;
  draft.quotation = input.quotation !== undefined
    ? normalizeDraftQuotation(input.quotation)
    : draft.quotation;
  draft.lastEditedBy = actorId as unknown as Types.ObjectId;

  await draft.save();

  const replacedKeys = [
    previousFiles.blueprint?.key && previousFiles.blueprint.key !== nextFiles.blueprint?.key
      ? previousFiles.blueprint.key
      : null,
    previousFiles.design?.key && previousFiles.design.key !== nextFiles.design?.key
      ? previousFiles.design.key
      : null,
    previousFiles.costing?.key && previousFiles.costing.key !== nextFiles.costing?.key
      ? previousFiles.costing.key
      : null,
  ].filter((value): value is string => Boolean(value));

  if (replacedKeys.length > 0) {
    await deleteDraftFiles(replacedKeys);
  }

  return BlueprintDraft.findById(draft._id)
    .populate('createdBy', 'firstName lastName phone')
    .populate('lastEditedBy', 'firstName lastName phone');
}

export async function finalizeBlueprintDraft(
  projectId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne({ projectId });
  if (!draft) throw AppError.notFound('Blueprint draft not found');

  const blueprintKey = draft.files?.blueprint?.key;
  const designKey = draft.files?.design?.key;
  const costingKey = draft.files?.costing?.key;

  if (!blueprintKey || !designKey || !costingKey) {
    throw AppError.badRequest('Blueprint, design, and costing files are required before finalizing the draft');
  }

  const quotation = buildQuotationFromDraft(draft.quotation);

  if (draft.mode === 'revision' && !draft.sourceBlueprintId) {
    throw AppError.badRequest('Revision draft is missing its source blueprint reference');
  }

  const finalizedBlueprint = draft.mode === 'revision'
    ? await uploadRevision(
        draft.sourceBlueprintId!.toString(),
        {
          blueprintKey,
          designKey,
          costingKey,
          quotation,
        },
        actorId,
        ip,
        ua,
      )
    : await uploadBlueprint(
        {
          projectId,
          blueprintKey,
          designKey,
          costingKey,
          quotation,
        },
        actorId,
        ip,
        ua,
      );

  await draft.deleteOne();
  return finalizedBlueprint;
}

export async function deleteBlueprintDraft(projectId: string, actorId: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne({ projectId });
  if (!draft) return;

  const keys = getDraftFileKeys(draft.files);
  await draft.deleteOne();

  if (keys.length > 0) {
    await deleteDraftFiles(keys);
  }
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

// ── Customer: Accept Blueprint (approve both components only) ──

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

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_APPROVED,
    actorId: customerId,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: {
      fullyApproved: true,
      paymentTypeSelectionPending: true,
      totalAmount: blueprint.quotation.total,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify engineer
  await createAndSendNotification(
    blueprint.uploadedBy,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `Customer accepted the blueprint for "${project.title}". Payment-plan selection is next.`,
    `/projects/${project._id}/blueprint`,
  );

  // Notify customer
  await createAndSendNotification(
    customerId,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `You approved the blueprint for "${project.title}". Select your payment plan to generate the contract.`,
    `/projects/${project._id}`,
  );

  return { blueprint };
}
