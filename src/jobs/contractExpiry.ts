import { User } from '../models/index.js';
import { sendContractExpiringEmail } from '../modules/notifications/email.service.js';
import { logger } from '../utils/logger.js';

/**
 * Contract Expiry Processor
 *
 * Checks for users with expiresAt within 7 or 1 day(s) and sends
 * a warning email. Only fires once per threshold by checking
 * `contractWarnings` on the user document.
 *
 * Also auto-disables users whose contract has already expired.
 */
export async function processContractExpiries(): Promise<void> {
  const now = new Date();
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const in1Day = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000);

  // ── 1. Warn users expiring within 7 days (but more than 1 day) ──
  const expiringIn7 = await User.find({
    expiresAt: { $lte: in7Days, $gt: in1Day },
    isActive: true,
    'contractWarnings.7d': { $ne: true },
  });

  for (const user of expiringIn7) {
    try {
      const daysRemaining = Math.ceil(
        ((user.expiresAt as Date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      );

      await sendContractExpiringEmail(user.email, {
        userName: `${user.firstName} ${user.lastName}`,
        expiresAt: (user.expiresAt as Date).toLocaleDateString(),
        daysRemaining,
      });

      await User.updateOne(
        { _id: user._id },
        { $set: { 'contractWarnings.7d': true } },
      );

      logger.info(`📧 Contract 7-day warning sent to ${user.email}`);
    } catch (err) {
      logger.error(`Contract warning email failed for ${user.email}:`, err);
    }
  }

  // ── 2. Warn users expiring within 1 day ──
  const expiringIn1 = await User.find({
    expiresAt: { $lte: in1Day, $gt: now },
    isActive: true,
    'contractWarnings.1d': { $ne: true },
  });

  for (const user of expiringIn1) {
    try {
      const daysRemaining = Math.max(1, Math.ceil(
        ((user.expiresAt as Date).getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
      ));

      await sendContractExpiringEmail(user.email, {
        userName: `${user.firstName} ${user.lastName}`,
        expiresAt: (user.expiresAt as Date).toLocaleDateString(),
        daysRemaining,
      });

      await User.updateOne(
        { _id: user._id },
        { $set: { 'contractWarnings.1d': true } },
      );

      logger.info(`📧 Contract 1-day warning sent to ${user.email}`);
    } catch (err) {
      logger.error(`Contract warning email failed for ${user.email}:`, err);
    }
  }

  // ── 3. Auto-disable expired contracts ──
  const result = await User.updateMany(
    {
      expiresAt: { $lte: now },
      isActive: true,
    },
    { $set: { isActive: false } },
  );

  if (result.modifiedCount > 0) {
    logger.info(`🔒 Auto-disabled ${result.modifiedCount} expired contract user(s)`);
  }
}
