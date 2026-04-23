import { AvailabilitySession } from '../models/index.js';
import { createAndSendNotification } from '../modules/notifications/socket.service.js';
import { NotificationCategory, StaffAvailabilityStatus } from '../utils/constants.js';
import { logger } from '../utils/logger.js';

export async function processAvailabilityShiftReminders(now = new Date()): Promise<void> {
  const expiredSessions = await AvailabilitySession.find({
    closedAt: { $exists: false },
    availabilityStatus: StaffAvailabilityStatus.AVAILABLE,
    shiftEndAt: { $lte: now },
    reminderSentAt: { $exists: false },
  }).select('userId shiftEndAt');

  for (const session of expiredSessions) {
    try {
      const endedAt = session.shiftEndAt
        ? session.shiftEndAt.toLocaleString('en-PH', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })
        : 'the scheduled end of your shift';

      await createAndSendNotification(
        session.userId,
        NotificationCategory.SYSTEM,
        'Shift Ended',
        `Your availability shift ended at ${endedAt}. Please close your availability when you are done.`,
        '/account/profile',
      );

      session.reminderSentAt = now;
      await session.save();
    } catch (error) {
      logger.error(`Failed to send availability reminder for session ${session._id.toString()}:`, error);
    }
  }
}
