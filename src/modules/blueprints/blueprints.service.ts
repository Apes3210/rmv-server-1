import {
  Blueprint, BlueprintDraft, Project, ProjectItem, User, AuditLog, PaymentPlan,
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
  const computedTotal = totalMaterials + totalLabor + fees;
  const total = computedTotal > 0 ? computedTotal : 1;
  const validMilestones = (quotation?.paymentMilestones || [])
    .filter((milestone) => milestone.label.trim() && milestone.description.trim());

  if (lineItems.length === 0) {
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

function itemScopedQuery(projectId: string, projectItemId?: string) {
  return projectItemId
    ? { projectId, projectItemId }
    : { projectId, projectItemId: { $exists: false } };
}

function buildProjectBlueprintLink(projectId: string, projectItemId?: string | null) {
  if (!projectItemId) return `/projects/${projectId}/blueprint`;

  return `/projects/${projectId}/blueprint?projectItemId=${projectItemId}`;
}

function isDuplicateKeyError(error: unknown) {
  const err = error as { name?: string; code?: number };
  return err.name === 'MongoServerError' && err.code === 11000;
}

function isInitialBlueprintUploadAvailable(projectStatus: ProjectStatus, projectItem?: { status?: ProjectStatus } | null) {
  if ([ProjectStatus.SUBMITTED, ProjectStatus.BLUEPRINT].includes(projectStatus)) return true;

  return projectStatus === ProjectStatus.APPROVED
    && Boolean(projectItem)
    && projectItem?.status !== ProjectStatus.APPROVED;
}

function hasPayableQuotation(blueprint: { quotation?: { total?: number } | null }) {
  return Boolean(blueprint.quotation);
}

async function markProjectItemApprovedAndSaveProject(
  project: any,
  projectItemId?: Types.ObjectId | string | null,
) {
  if (projectItemId) {
    await ProjectItem.findByIdAndUpdate(projectItemId, { $set: { status: ProjectStatus.APPROVED } });

    const hasPendingItems = await ProjectItem.exists({
      projectId: project._id,
      _id: { $ne: projectItemId },
      status: { $ne: ProjectStatus.APPROVED },
      deletedAt: null,
    });

    if (hasPendingItems) {
      await project.save();
      return;
    }
  }

  if (project.status === ProjectStatus.BLUEPRINT) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.APPROVED);
    project.status = ProjectStatus.APPROVED;
  }
  await project.save();
}

async function syncProjectTotalCostFromApprovedBlueprints(project: any, fallbackBlueprint?: any) {
  const itemCount = await ProjectItem.countDocuments({ projectId: project._id });
  const fallbackTotal = fallbackBlueprint?.quotation?.total;

  if (itemCount <= 1) {
    if (typeof fallbackTotal === 'number') project.totalCost = fallbackTotal;
    return;
  }

  const [aggregateTotal] = await Blueprint.aggregate([
    {
      $match: {
        projectId: project._id,
        projectItemId: { $exists: true },
        status: BlueprintStatus.APPROVED,
        'quotation.total': { $type: 'number' },
      },
    },
    { $sort: { projectItemId: 1, version: -1 } },
    { $group: { _id: '$projectItemId', total: { $first: '$quotation.total' } } },
    { $group: { _id: null, total: { $sum: '$total' } } },
  ]);

  project.totalCost = aggregateTotal?.total ?? (typeof fallbackTotal === 'number' ? fallbackTotal : 0);
}

async function resolveProjectItemForBlueprint(project: any, projectItemId?: string) {
  const itemCount = await ProjectItem.countDocuments({ projectId: project._id });

  if (itemCount > 1 && !projectItemId) {
    throw AppError.badRequest('Select a project item before managing its blueprint');
  }

  if (!projectItemId) return null;

  const projectItem = await ProjectItem.findOne({ _id: projectItemId, projectId: project._id });
  if (!projectItem) throw AppError.notFound('Project item not found');

  return projectItem;
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

  const projectItem = await resolveProjectItemForBlueprint(project, input.projectItemId);
  const designReviewStatus = projectItem?.designReviewStatus || project.designReviewStatus || 'not_required';
  const hasInitialDesign = Boolean(
    projectItem
      ? projectItem.initialDesignKeys?.length || projectItem.initialDesignNotes?.trim()
      : project.initialDesignKeys?.length || project.initialDesignNotes?.trim(),
  );

  if (hasInitialDesign && !['approved', 'not_required'].includes(designReviewStatus)) {
    throw AppError.badRequest('The sales initial design must be approved by engineering before the first blueprint upload');
  }

  if (!isInitialBlueprintUploadAvailable(project.status, projectItem)) {
    throw AppError.badRequest('Project is not in a valid state for blueprint upload');
  }

  // Check if initial version already exists
  const existing = await Blueprint.findOne({ ...itemScopedQuery(input.projectId, input.projectItemId), version: 1 });
  if (existing) {
    throw AppError.conflict('Initial blueprint already uploaded. Use revision upload.', ErrorCode.DUPLICATE_ENTRY);
  }

  const blueprint = await Blueprint.create({
    projectId: input.projectId,
    projectItemId: input.projectItemId,
    version: 1,
    status: BlueprintStatus.UPLOADED,
    blueprintKey: input.blueprintKey,
    designKey: input.designKey,
    costingKey: input.costingKey,
    uploadedBy,
    quotation: input.quotation,
  });

  if ([ProjectStatus.SUBMITTED, ProjectStatus.APPROVED].includes(project.status)) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.BLUEPRINT);
    project.status = ProjectStatus.BLUEPRINT;
    await project.save();
  }
  if (input.projectItemId) {
    await ProjectItem.findByIdAndUpdate(input.projectItemId, { $set: { status: ProjectStatus.BLUEPRINT } });
  }

  await AuditLog.create({
    action: AuditAction.BLUEPRINT_UPLOADED,
    actorId: uploadedBy,
    targetType: 'blueprint',
    targetId: blueprint._id,
    details: { projectId: input.projectId, projectItemId: input.projectItemId || null, version: 1 },
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
      buildProjectBlueprintLink(project._id.toString(), input.projectItemId),
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
    projectItemId: currentBlueprint.projectItemId,
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
      buildProjectBlueprintLink(project._id.toString(), currentBlueprint.projectItemId?.toString()),
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

  if (input.component === BlueprintComponent.COSTING && !hasPayableQuotation(blueprint)) {
    throw AppError.badRequest('Cannot approve billing without a valid quotation total. Please ask engineering to upload costing with pricing.');
  }

  if (input.component === BlueprintComponent.BLUEPRINT) {
    blueprint.blueprintApproved = true;
  } else {
    blueprint.costingApproved = true;
  }

  if (blueprint.quotation && Number(blueprint.quotation.total || 0) <= 0) {
    blueprint.quotation.total = 1;
  }

  const fullyApproved = blueprint.blueprintApproved && blueprint.costingApproved;

  // If both approved, mark blueprint as approved
  if (fullyApproved) {
    blueprint.status = BlueprintStatus.APPROVED;
    await blueprint.save();

    await syncProjectTotalCostFromApprovedBlueprints(project, blueprint);
    await markProjectItemApprovedAndSaveProject(project, blueprint.projectItemId);
  } else {
    await blueprint.save();
  }

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
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
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
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
  );

  return blueprint;
}

// ── Engineer: Draft Autosave ──

export async function getBlueprintDraft(projectId: string, actorId: string, projectItemId?: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  return BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId))
    .populate('createdBy', 'firstName lastName phone')
    .populate('lastEditedBy', 'firstName lastName phone');
}

export async function upsertBlueprintDraft(
  projectId: string,
  input: UpsertBlueprintDraftInput,
  actorId: string,
) {
  const project = await assertAssignedEngineerForProject(projectId, actorId);
  const projectItemId = input.projectItemId;
  const projectItem = await resolveProjectItemForBlueprint(project, projectItemId);
  const latestBlueprint = await Blueprint.findOne(itemScopedQuery(projectId, projectItemId))
    .sort({ version: -1 })
    .select('_id status');

  if (input.mode === 'initial') {
    if (latestBlueprint) {
      throw AppError.badRequest('Initial blueprint draft is not available after a blueprint has been uploaded');
    }

    if (!isInitialBlueprintUploadAvailable(project.status, projectItem)) {
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

  const draftQuery = itemScopedQuery(projectId, projectItemId);
  const existingDraft = await BlueprintDraft.findOne(draftQuery);
  const previousFiles = {
    blueprint: existingDraft?.files?.blueprint ?? null,
    design: existingDraft?.files?.design ?? null,
    costing: existingDraft?.files?.costing ?? null,
  };

  const set: Record<string, unknown> = {
    mode: input.mode,
    lastEditedBy: actorId,
  };
  const unset: Record<string, ''> = {};

  if (input.mode === 'revision' && latestBlueprint) {
    set.sourceBlueprintId = latestBlueprint._id;
  } else {
    unset.sourceBlueprintId = '';
  }

  if (input.files && 'blueprint' in input.files) {
    set['files.blueprint'] = normalizeDraftFile(input.files.blueprint ?? null) ?? null;
  }
  if (input.files && 'design' in input.files) {
    set['files.design'] = normalizeDraftFile(input.files.design ?? null) ?? null;
  }
  if (input.files && 'costing' in input.files) {
    set['files.costing'] = normalizeDraftFile(input.files.costing ?? null) ?? null;
  }
  if (input.quotation !== undefined) {
    set.quotation = normalizeDraftQuotation(input.quotation);
  }

  const setOnInsert: Record<string, unknown> = {
    projectId,
    createdBy: actorId,
  };
  if (projectItemId) {
    setOnInsert.projectItemId = projectItemId;
  }

  const update: Record<string, unknown> = {
    $set: set,
    $setOnInsert: setOnInsert,
  };
  if (Object.keys(unset).length > 0) {
    update.$unset = unset;
  }

  let draft;
  try {
    draft = await BlueprintDraft.findOneAndUpdate(
      draftQuery,
      update,
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;

    draft = await BlueprintDraft.findOneAndUpdate(
      draftQuery,
      update,
      {
        new: true,
        runValidators: true,
      },
    );
  }

  if (!draft) throw AppError.internal('Failed to save blueprint draft');

  const nextFiles = {
    blueprint: draft.files?.blueprint ?? null,
    design: draft.files?.design ?? null,
    costing: draft.files?.costing ?? null,
  };

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
  projectItemId?: string,
) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId));
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
          projectItemId: draft.projectItemId?.toString() || projectItemId,
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

export async function deleteBlueprintDraft(projectId: string, actorId: string, projectItemId?: string) {
  await assertAssignedEngineerForProject(projectId, actorId);

  const draft = await BlueprintDraft.findOne(itemScopedQuery(projectId, projectItemId));
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
  projectItemId?: string,
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprints = await Blueprint.find(itemScopedQuery(projectId, projectItemId))
    .populate('uploadedBy', 'firstName lastName phone')
    .sort({ version: -1 });
  return blueprints;
}

// ── Get Latest Blueprint for a Project ──

export async function getLatestBlueprint(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
  projectItemId?: string,
) {
  await assertBlueprintProjectAccess(projectId, actorId, actorRoles);
  const blueprint = await Blueprint.findOne(itemScopedQuery(projectId, projectItemId))
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

  if (!blueprint.quotation) {
    throw AppError.badRequest('Cannot accept a blueprint without a valid quotation. Please ask the engineer to provide pricing.');
  }

  // Mark both components as approved
  blueprint.blueprintApproved = true;
  blueprint.costingApproved = true;
  blueprint.status = BlueprintStatus.APPROVED;
  if (Number(blueprint.quotation.total || 0) <= 0) {
    blueprint.quotation.total = 1;
  }
  await blueprint.save();

  await syncProjectTotalCostFromApprovedBlueprints(project, blueprint);
  await markProjectItemApprovedAndSaveProject(project, blueprint.projectItemId);

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
    buildProjectBlueprintLink(project._id.toString(), blueprint.projectItemId?.toString()),
  );

  // Notify customer
  await createAndSendNotification(
    customerId,
    NotificationCategory.BLUEPRINT,
    'Blueprint Accepted',
    `You approved the blueprint for "${project.title}". Select your payment plan to continue to payments.`,
    `/projects/${project._id}`,
  );

  return { blueprint };
}
