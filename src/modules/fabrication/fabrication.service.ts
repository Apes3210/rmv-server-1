import {
  FabricationUpdate, Project, User, AuditLog,
} from '../../models/index.js';
import { PaymentPlan } from '../../models/Payment.js';
import { AppError } from '../../utils/appError.js';
import {
  FabricationStatus, PaymentStageStatus, ProjectStatus, AuditAction, NotificationCategory, Role,
} from '../../utils/constants.js';
import { fabricationStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification, getIO } from '../notifications/socket.service.js';
import { sendFabricationUpdateEmail, sendPaymentHeadsUpEmail, sendPaymentDueEmail, sendReadyForDeliveryEmail, sendProjectCompletedEmail } from '../notifications/email.service.js';
import { getPaymentActivationConfig } from '../config/config.service.js';
import { formatCurrency } from '../../utils/helpers.js';
import { logger } from '../../utils/logger.js';
import type { CreateFabricationUpdateInput, UpdateFabricationUpdateInput } from './fabrication.validation.js';

// ── Per-stage payment gating helpers ──

const FABRICATION_STAGE_ORDER = [
  FabricationStatus.MATERIAL_PREP,
  FabricationStatus.CUTTING,
  FabricationStatus.WELDING,
  FabricationStatus.ASSEMBLY,
  FabricationStatus.FINISHING,
  FabricationStatus.QUALITY_CHECK,
  FabricationStatus.READY_FOR_DELIVERY,
  FabricationStatus.DONE,
];

/**
 * For a given target fabrication status and total number of payment stages,
 * return the minimum number of payment stages that must be verified.
 * Uses proportional distribution across the fabrication pipeline.
 */
function getRequiredPaidStages(targetStatus: FabricationStatus, totalPaymentStages: number): number {
  if (totalPaymentStages <= 0) return 0;

  const targetIdx = FABRICATION_STAGE_ORDER.indexOf(targetStatus);
  if (targetIdx === -1) return 0;

  const totalFabStages = FABRICATION_STAGE_ORDER.length; // 8
  return Math.min(
    totalPaymentStages,
    Math.ceil(((targetIdx + 1) / totalFabStages) * totalPaymentStages),
  );
}

// ── Fabrication Staff: Create Update ──

export async function createFabricationUpdate(
  input: CreateFabricationUpdateInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  if (project.status !== ProjectStatus.FABRICATION) {
    throw AppError.badRequest('Project is not in fabrication phase');
  }

  // Only fabrication staff or engineers assigned to this project can update
  const isLead = project.fabricationLeadId?.toString() === actorId;
  const isAssistant = project.fabricationAssistantIds.some(id => id.toString() === actorId);
  const isEngineer = project.engineerIds?.some((id: { toString: () => string }) => id.toString() === actorId);
  if (!isLead && !isAssistant && !isEngineer) {
    throw AppError.forbidden('You are not assigned to this project');
  }

  // Get current fabrication status (from latest update or queued)
  const latestUpdate = await FabricationUpdate.findOne({ projectId: input.projectId })
    .sort({ createdAt: -1 });

  const currentStatus = latestUpdate
    ? latestUpdate.status
    : FabricationStatus.QUEUED;

  // Validate status transition (forward-only)
  fabricationStateMachine.assertTransition(currentStatus, input.status);

  // Per-stage payment gate: require proportional payment stages to be verified
  const plan = await PaymentPlan.findOne({ projectId: input.projectId });
  if (plan && plan.stages.length > 0) {
    const requiredPaid = getRequiredPaidStages(input.status, plan.stages.length);
    const actualPaid = plan.stages.filter(s => s.status === PaymentStageStatus.VERIFIED).length;
    if (actualPaid < requiredPaid) {
      const nextUnpaid = plan.stages.find(s => s.status !== PaymentStageStatus.VERIFIED);
      throw AppError.badRequest(
        `Cannot advance to ${input.status.replace(/_/g, ' ')} — payment stage "${nextUnpaid?.label || `Stage ${actualPaid + 1}`}" must be verified first (${actualPaid}/${requiredPaid} required stages paid)`,
      );
    }
  }

  const update = await FabricationUpdate.create({
    projectId: input.projectId,
    status: input.status,
    notes: input.notes,
    photoKeys: input.photoKeys,
    updatedBy: actorId,
  });

  await AuditLog.create({
    action: AuditAction.FABRICATION_UPDATED,
    actorId,
    targetType: 'fabrication_update',
    targetId: update._id,
    details: { projectId: input.projectId, from: currentStatus, to: input.status },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    const statusLabels: Record<string, string> = {
      [FabricationStatus.MATERIAL_PREP]: 'Material Preparation',
      [FabricationStatus.CUTTING]: 'Cutting',
      [FabricationStatus.WELDING]: 'Welding',
      [FabricationStatus.FINISHING]: 'Finishing',
      [FabricationStatus.QUALITY_CHECK]: 'Quality Check',
      [FabricationStatus.READY_FOR_DELIVERY]: 'Ready for Delivery',
      [FabricationStatus.DONE]: 'Done',
    };

    if (input.status === FabricationStatus.READY_FOR_DELIVERY) {
      // Dedicated high-priority notification + email with CTA
      await createAndSendNotification(
        project.customerId,
        NotificationCategory.PROJECT,
        'Your Project is Ready for Delivery!',
        `"${project.title}" has completed fabrication. Please confirm your installation schedule to proceed.`,
        `/projects/${project._id}/fabrication`,
      );
      await sendReadyForDeliveryEmail(customer.email, { projectTitle: project.title });
    } else if (input.status === FabricationStatus.DONE) {
      // Completion notification + email
      await createAndSendNotification(
        project.customerId,
        NotificationCategory.PROJECT,
        'Project Complete!',
        `Your project "${project.title}" has been successfully installed and is now complete.`,
        `/projects/${project._id}`,
      );
      await sendProjectCompletedEmail(customer.email, { projectTitle: project.title });
    } else {
      // Generic fabrication progress update
      await createAndSendNotification(
        project.customerId,
        NotificationCategory.FABRICATION,
        'Fabrication Update',
        `Your project "${project.title}" is now in: ${statusLabels[input.status] || input.status}`,
        `/projects/${project._id}/fabrication`,
      );
      await sendFabricationUpdateEmail(customer.email, {
        projectTitle: project.title,
        status: statusLabels[input.status] || input.status,
        notes: input.notes,
      });
    }
  }

  // ── Emit real-time event to all project stakeholders ──
  try {
    const io = getIO();
    const projectIdStr = String(project._id);
    const rooms = new Set<string>();
    rooms.add(`user:${project.customerId}`);
    if (project.fabricationLeadId && project.fabricationLeadId.toString() !== actorId) {
      rooms.add(`user:${project.fabricationLeadId}`);
    }
    for (const id of (project.fabricationAssistantIds || [])) {
      if (id.toString() !== actorId) rooms.add(`user:${id}`);
    }
    for (const id of ((project as any).engineerIds || [])) {
      if (id.toString() !== actorId) rooms.add(`user:${id}`);
    }
    for (const room of rooms) {
      io.to(room).emit('fabrication:update', { projectId: projectIdStr });
    }
  } catch (err) {
    logger.warn('Failed to emit fabrication:update socket event', err);
  }

  // ── Payment Activation: check if this fabrication status triggers payment stages ──
  if (plan && plan.stages.length > 1) {
    try {
      const activationCfg = await getPaymentActivationConfig();
      const { activationMap, headsUpMap } = activationCfg;
      let planDirty = false;

      for (let i = 0; i < plan.stages.length; i++) {
        const stage = plan.stages[i];

        // Skip already activated, verified, or proof-submitted stages
        if (stage.activatedAt || stage.status === PaymentStageStatus.VERIFIED || stage.status === PaymentStageStatus.PROOF_SUBMITTED) {
          continue;
        }

        // ── Activation trigger: stage becomes due ──
        const activationTrigger = activationMap[i] ?? null;
        if (activationTrigger && activationTrigger === input.status) {
          stage.activatedAt = new Date();
          planDirty = true;

          // Notify customer: payment is now due
          if (customer) {
            await createAndSendNotification(
              project.customerId,
              NotificationCategory.PAYMENT,
              'Payment Now Due',
              `Payment for "${stage.label}" (${formatCurrency(stage.amount)}) is now due for project "${project.title}".`,
              `/projects/${project._id}/payments`,
            );
            await sendPaymentDueEmail(customer.email, {
              projectTitle: project.title,
              stageLabel: stage.label,
              amount: formatCurrency(stage.amount),
            });
          }

          logger.info(`Payment stage ${i} (${stage.label}) activated for project ${project._id} at fabrication status ${input.status}`);
        }

        // ── Heads-up trigger: advance notice (stage stays locked) ──
        const headsUpTrigger = headsUpMap[i] ?? null;
        if (headsUpTrigger && headsUpTrigger === input.status && !stage.headsUpSentAt) {
          stage.headsUpSentAt = new Date();
          planDirty = true;

          if (customer) {
            const statusLabel = input.status.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            await createAndSendNotification(
              project.customerId,
              NotificationCategory.PAYMENT,
              'Upcoming Payment Notice',
              `Heads up! Payment for "${stage.label}" (${formatCurrency(stage.amount)}) will be due soon for project "${project.title}".`,
              `/projects/${project._id}/payments`,
            );
            await sendPaymentHeadsUpEmail(customer.email, {
              projectTitle: project.title,
              stageLabel: stage.label,
              amount: formatCurrency(stage.amount),
              fabricationStatus: statusLabel,
            });
          }

          logger.info(`Heads-up sent for payment stage ${i} (${stage.label}) of project ${project._id} at fabrication status ${input.status}`);
        }
      }

      if (planDirty) {
        await plan.save();
      }
    } catch (err) {
      // Payment activation errors should NOT block fabrication updates
      logger.error('Payment activation check failed', err);
    }
  }

  // If fabrication is done, transition project to completed
  if (input.status === FabricationStatus.DONE) {
    // ── Installation confirmation gate ──
    if (!(project as any).installationConfirmedAt) {
      throw AppError.badRequest(
        'Customer must confirm the installation schedule before marking the project as Done',
      );
    }

    projectStateMachine.assertTransition(project.status, ProjectStatus.COMPLETED);
    project.status = ProjectStatus.COMPLETED;
    await project.save();

    await AuditLog.create({
      action: AuditAction.PROJECT_COMPLETED,
      actorId,
      targetType: 'project',
      targetId: project._id,
      ipAddress: ip,
      userAgent: ua,
    });
  }

  return update;
}

// ── Edit a Fabrication Update (notes + photos only, author or admin) ──

export async function updateFabricationUpdate(
  id: string,
  input: UpdateFabricationUpdateInput,
  actorId: string,
  actorRoles: Role[],
) {
  const update = await FabricationUpdate.findById(id);
  if (!update) throw AppError.notFound('Fabrication update not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  if (!isAdmin && update.updatedBy.toString() !== actorId) {
    throw AppError.forbidden('You can only edit your own updates');
  }

  if (input.notes !== undefined) update.notes = input.notes;
  if (input.photoKeys !== undefined) update.photoKeys = input.photoKeys;
  await update.save();

  await AuditLog.create({
    action: AuditAction.FABRICATION_UPDATED,
    actorId,
    targetType: 'fabrication_update',
    targetId: update._id,
    details: { edited: true, changes: input },
  });

  // Notify stakeholders in real-time
  try {
    const io = getIO();
    const project = await Project.findById(update.projectId)
      .select('customerId fabricationLeadId fabricationAssistantIds engineerIds');
    if (project) {
      const rooms = new Set<string>();
      rooms.add(`user:${project.customerId}`);
      if (project.fabricationLeadId) rooms.add(`user:${project.fabricationLeadId}`);
      for (const sid of (project.fabricationAssistantIds || [])) rooms.add(`user:${sid}`);
      for (const sid of ((project as any).engineerIds || [])) rooms.add(`user:${sid}`);
      rooms.delete(`user:${actorId}`);
      for (const room of rooms) io.to(room).emit('fabrication:update', { projectId: String(update.projectId) });
    }
  } catch (err) {
    logger.warn('Failed to emit fabrication:update on edit', err);
  }

  return update;
}

// ── Delete a Fabrication Update (author or admin only) ──

export async function deleteFabricationUpdate(
  id: string,
  actorId: string,
  actorRoles: Role[],
) {
  const update = await FabricationUpdate.findById(id);
  if (!update) throw AppError.notFound('Fabrication update not found');

  const isAdmin = actorRoles.includes(Role.ADMIN);
  if (!isAdmin && update.updatedBy.toString() !== actorId) {
    throw AppError.forbidden('You can only delete your own updates');
  }

  const projectId = String(update.projectId);
  await FabricationUpdate.findByIdAndDelete(id);

  await AuditLog.create({
    action: AuditAction.FABRICATION_UPDATED,
    actorId,
    targetType: 'fabrication_update',
    targetId: update._id,
    details: { deleted: true },
  });

  // Notify stakeholders in real-time
  try {
    const io = getIO();
    const project = await Project.findById(projectId)
      .select('customerId fabricationLeadId fabricationAssistantIds engineerIds');
    if (project) {
      const rooms = new Set<string>();
      rooms.add(`user:${project.customerId}`);
      if (project.fabricationLeadId) rooms.add(`user:${project.fabricationLeadId}`);
      for (const sid of (project.fabricationAssistantIds || [])) rooms.add(`user:${sid}`);
      for (const sid of ((project as any).engineerIds || [])) rooms.add(`user:${sid}`);
      rooms.delete(`user:${actorId}`);
      for (const room of rooms) io.to(room).emit('fabrication:update', { projectId });
    }
  } catch (err) {
    logger.warn('Failed to emit fabrication:update on delete', err);
  }

  return { id };
}

// ── List Fabrication Updates for a Project ──

async function assertFabricationProjectAccess(
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
    if (project.engineerIds.some((id) => id.toString() === actorId)) return;
    if (project.status === ProjectStatus.SUBMITTED && project.engineerIds.length === 0) return;
  }

  if (
    actorRoles.includes(Role.FABRICATION_STAFF) &&
    (project.fabricationLeadId?.toString() === actorId ||
      project.fabricationAssistantIds.some((id) => id.toString() === actorId))
  ) return;

  throw AppError.forbidden('Access denied');
}

export async function listFabricationUpdates(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertFabricationProjectAccess(projectId, actorId, actorRoles);
  const updates = await FabricationUpdate.find({ projectId })
    .populate('updatedBy', 'firstName lastName')
    .sort({ createdAt: 1 });
  return updates;
}

// ── Get Latest Fabrication Status ──

export async function getLatestFabricationStatus(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertFabricationProjectAccess(projectId, actorId, actorRoles);
  const latest = await FabricationUpdate.findOne({ projectId })
    .sort({ createdAt: -1 })
    .populate('updatedBy', 'firstName lastName');

  // Check payment gate — per-stage info
  const plan = await PaymentPlan.findOne({ projectId });
  const totalStages = plan ? plan.stages.length : 0;
  const paidCount = plan ? plan.stages.filter(s => s.status === PaymentStageStatus.VERIFIED).length : 0;
  const allPaid = totalStages > 0 && paidCount === totalStages;
  const unpaidCount = totalStages - paidCount;

  // Build per-transition gate requirements
  const allowedTransitions = fabricationStateMachine.getAllowed(
    latest?.status || FabricationStatus.QUEUED,
  );

  const stageGates: Record<string, { requiredPaid: number; currentPaid: number; blocked: boolean; nextUnpaidLabel?: string }> = {};
  if (totalStages > 0) {
    for (const transition of allowedTransitions) {
      const requiredPaid = getRequiredPaidStages(transition as FabricationStatus, totalStages);
      const blocked = paidCount < requiredPaid;
      const nextUnpaid = blocked ? plan!.stages.find(s => s.status !== PaymentStageStatus.VERIFIED) : undefined;
      stageGates[transition] = {
        requiredPaid,
        currentPaid: paidCount,
        blocked,
        nextUnpaidLabel: nextUnpaid?.label,
      };
    }
  }

  return {
    currentStatus: latest?.status || FabricationStatus.QUEUED,
    latestUpdate: latest,
    allowedTransitions,
    paymentGate: {
      allPaid,
      unpaidCount,
      paidCount,
      totalStages,
      stageGates,
    },
  };
}

// ── Get Fabrication Update by ID ──

export async function getFabricationUpdateById(
  updateId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const update = await FabricationUpdate.findById(updateId)
    .populate('updatedBy', 'firstName lastName');
  if (!update) throw AppError.notFound('Fabrication update not found');
  await assertFabricationProjectAccess(update.projectId.toString(), actorId, actorRoles);
  return update;
}
