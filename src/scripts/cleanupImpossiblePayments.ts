import 'dotenv/config';
import mongoose from 'mongoose';
import { Payment, PaymentPlan } from '../models/Payment.js';
import { PaymentStageStatus } from '../utils/constants.js';

const MAX_PAYMENT_AMOUNT = 999_999_999;

function pickMongoUri() {
  return process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/rmv_system';
}

function hasFlag(flag: string) {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  const apply = hasFlag('--apply');
  const mongoUri = pickMongoUri();

  await mongoose.connect(mongoUri);

  const badPayments = await Payment.find({ amountPaid: { $gt: MAX_PAYMENT_AMOUNT } })
    .select({ _id: 1, projectId: 1, projectItemId: 1, stageId: 1, amountPaid: 1, status: 1, method: 1, createdAt: 1 })
    .lean();

  if (badPayments.length === 0) {
    console.log('No impossible payments found.');
    await mongoose.connection.close();
    return;
  }

  console.log(`Found ${badPayments.length} impossible payment(s) > ${MAX_PAYMENT_AMOUNT}.`);
  for (const p of badPayments.slice(0, 25)) {
    console.log(
      `- payment=${p._id} project=${p.projectId} item=${p.projectItemId ?? 'legacy'} stage=${p.stageId} amountPaid=${p.amountPaid} status=${p.status} method=${p.method}`,
    );
  }
  if (badPayments.length > 25) console.log(`...and ${badPayments.length - 25} more.`);

  const affected = new Map<string, { projectId: string; projectItemId?: string | null; stageId: string }>();
  for (const p of badPayments) {
    const key = `${String(p.projectId)}|${p.projectItemId ? String(p.projectItemId) : 'legacy'}|${p.stageId}`;
    affected.set(key, {
      projectId: String(p.projectId),
      projectItemId: p.projectItemId ? String(p.projectItemId) : null,
      stageId: p.stageId,
    });
  }

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to delete them and recompute stage totals.');
    await mongoose.connection.close();
    return;
  }

  const badIds = badPayments.map((p) => p._id);
  const delRes = await Payment.deleteMany({ _id: { $in: badIds } });
  console.log(`Deleted ${delRes.deletedCount ?? 0} payment(s).`);

  // Recompute affected stages in their payment plans.
  let updatedStages = 0;
  let unlockedPlans = 0;

  for (const entry of affected.values()) {
    const plan = await PaymentPlan.findOne({
      projectId: entry.projectId,
      ...(entry.projectItemId ? { projectItemId: entry.projectItemId } : { projectItemId: { $exists: false } }),
    });
    if (!plan) continue;

    const stage = plan.stages.find((s) => s.stageId === entry.stageId);
    if (!stage) continue;

    const payments = await Payment.find({
      projectId: entry.projectId,
      stageId: entry.stageId,
      ...(entry.projectItemId ? { projectItemId: entry.projectItemId } : { projectItemId: { $exists: false } }),
    })
      .select({ amountPaid: 1, status: 1 })
      .lean();

    const verifiedSum = payments
      .filter((p) => p.status === PaymentStageStatus.VERIFIED)
      .reduce((sum, p) => sum + Number(p.amountPaid || 0), 0);

    stage.amountPaid = verifiedSum;
    stage.remainingBalance = Math.max(0, stage.amount - stage.amountPaid - (stage.creditApplied || 0));

    // Repair status when it can no longer be true.
    if (stage.status === PaymentStageStatus.VERIFIED && stage.remainingBalance > 0) {
      const hasSubmitted = payments.some((p) => p.status === PaymentStageStatus.PROOF_SUBMITTED);
      const hasDeclined = payments.some((p) => p.status === PaymentStageStatus.DECLINED);
      stage.status = hasSubmitted ? PaymentStageStatus.PROOF_SUBMITTED : hasDeclined ? PaymentStageStatus.DECLINED : PaymentStageStatus.PENDING;
    }
    if (stage.status === PaymentStageStatus.PENDING && payments.some((p) => p.status === PaymentStageStatus.PROOF_SUBMITTED)) {
      stage.status = PaymentStageStatus.PROOF_SUBMITTED;
    }

    // If the plan was only immutable due to now-deleted verified payments, unlock it.
    const remainingVerified = await Payment.countDocuments({
      projectId: entry.projectId,
      ...(entry.projectItemId ? { projectItemId: entry.projectItemId } : { projectItemId: { $exists: false } }),
      status: PaymentStageStatus.VERIFIED,
    });
    if (remainingVerified === 0 && plan.isImmutable) {
      plan.isImmutable = false;
      unlockedPlans += 1;
    }

    await plan.save();
    updatedStages += 1;
  }

  console.log(`Recomputed ${updatedStages} stage(s). Unlocked ${unlockedPlans} plan(s).`);

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.connection.close();
  } catch {}
  process.exitCode = 1;
});

