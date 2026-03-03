import { PaymentPlan } from '../models/Payment.js';
import { Project, User } from '../models/index.js';
import { PaymentStageStatus, NotificationCategory, Role } from '../utils/constants.js';
import { getPaymentActivationConfig } from '../modules/config/config.service.js';
import { createAndSendNotification, notifyRole } from '../modules/notifications/socket.service.js';
import { sendPaymentOverdueEmail } from '../modules/notifications/email.service.js';
import { formatCurrency } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

/**
 * Payment Reminder Job
 *
 * Runs periodically (every hour) to:
 * 1. Find activated-but-unpaid payment stages past the grace period
 * 2. Send escalating overdue reminders to the customer
 * 3. After N reminders, escalate to the cashier role
 *
 * Config keys (from config collection):
 *   payment_reminder_grace_days     — days after activatedAt before first reminder (default: 3)
 *   payment_reminder_interval_days  — days between subsequent reminders (default: 2)
 *   payment_escalation_after_reminders — escalate to cashier after this many reminders (default: 3)
 */
export async function processPaymentReminders(): Promise<void> {
  try {
    const config = await getPaymentActivationConfig();
    const { reminderGraceDays, reminderIntervalDays, escalationAfterReminders } = config;

    // Find all plans with activated but unpaid stages
    const plans = await PaymentPlan.find({
      'stages': {
        $elemMatch: {
          activatedAt: { $ne: null },
          status: { $in: [PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED] },
          escalatedToCashier: { $ne: true },
        },
      },
    });

    const now = new Date();
    let remindersProcessed = 0;
    let escalationsProcessed = 0;

    for (const plan of plans) {
      const project = await Project.findById(plan.projectId).select('title customerId');
      if (!project) continue;

      const customer = await User.findById(project.customerId).select('email firstName');
      if (!customer) continue;

      for (const stage of plan.stages) {
        // Only process activated, unpaid, non-escalated stages
        if (
          !stage.activatedAt ||
          stage.status === PaymentStageStatus.VERIFIED ||
          stage.status === PaymentStageStatus.PROOF_SUBMITTED ||
          stage.escalatedToCashier
        ) {
          continue;
        }

        const activatedAt = new Date(stage.activatedAt);
        const msSinceActivation = now.getTime() - activatedAt.getTime();
        const daysSinceActivation = msSinceActivation / (1000 * 60 * 60 * 24);

        // Not yet past grace period
        if (daysSinceActivation < reminderGraceDays) continue;

        // Determine if it's time for the next reminder
        const daysSinceGrace = daysSinceActivation - reminderGraceDays;
        const expectedReminders = Math.floor(daysSinceGrace / reminderIntervalDays) + 1;

        if (stage.remindersSent >= expectedReminders) continue; // Already sent for this interval

        // Avoid sending duplicate in same run (check lastReminderAt)
        if (stage.lastReminderAt) {
          const hoursSinceLastReminder = (now.getTime() - new Date(stage.lastReminderAt).getTime()) / (1000 * 60 * 60);
          if (hoursSinceLastReminder < 12) continue; // Min 12h between reminders as safety
        }

        const reminderNumber = stage.remindersSent + 1;

        // ── Check if we should escalate to cashier instead ──
        if (reminderNumber > escalationAfterReminders) {
          stage.escalatedToCashier = true;
          stage.lastReminderAt = now;

          await notifyRole(
            Role.CASHIER,
            NotificationCategory.PAYMENT,
            'Overdue Payment Escalation',
            `Customer "${customer.firstName}" has not paid "${stage.label}" (${formatCurrency(stage.amount)}) for project "${project.title}" after ${stage.remindersSent} reminders. Please follow up.`,
            `/projects/${project._id}/payments`,
          );

          escalationsProcessed++;
          logger.info(`Payment stage "${stage.label}" escalated to cashier for project ${project._id}`);
          continue;
        }

        // ── Send overdue reminder to customer ──
        stage.remindersSent = reminderNumber;
        stage.lastReminderAt = now;

        const dueDate = activatedAt.toLocaleDateString('en-PH', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });

        await createAndSendNotification(
          project.customerId,
          NotificationCategory.PAYMENT,
          'Payment Overdue',
          `Reminder #${reminderNumber}: Payment for "${stage.label}" (${formatCurrency(stage.amount)}) is overdue for project "${project.title}". Please pay as soon as possible.`,
          `/projects/${project._id}/payments`,
        );

        await sendPaymentOverdueEmail(customer.email, {
          projectTitle: project.title,
          stageLabel: stage.label,
          amount: formatCurrency(stage.amount),
          dueDate,
          reminderNumber,
        });

        remindersProcessed++;
      }

      // Save any changes to this plan's stages
      await plan.save();
    }

    if (remindersProcessed > 0 || escalationsProcessed > 0) {
      logger.info(`Payment reminders processed: ${remindersProcessed} reminders, ${escalationsProcessed} escalations`);
    }
  } catch (error) {
    logger.error('Payment reminder job failed:', error);
  }
}
