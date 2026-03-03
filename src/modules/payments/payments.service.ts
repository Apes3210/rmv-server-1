import { v4 as uuidv4 } from 'uuid';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import {
  PaymentPlan, Payment, Project, User, AuditLog, ReceiptCounter, Appointment,
} from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  PaymentStageStatus, PaymentMethod, ProjectStatus, AuditAction, NotificationCategory, Role,
} from '../../utils/constants.js';
import { paymentStateMachine, projectStateMachine } from '../../utils/stateMachine.js';
import { createAndSendNotification } from '../notifications/socket.service.js';
import { sendPaymentVerifiedEmail, sendPaymentDeclinedEmail } from '../notifications/email.service.js';
import { formatCurrency, generateReceiptNumber } from '../../utils/helpers.js';
import { createStageCheckoutSession } from '../../services/paymongo.service.js';
import { generateReceiptPdf, type ReceiptData } from '../../services/receipt.service.js';
import { r2Client } from '../../config/r2.js';
import { generateDownloadUrl } from '../uploads/upload.service.js';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type {
  CreatePaymentPlanInput,
  UpdatePaymentPlanInput,
  SubmitPaymentProofInput,
  DeclinePaymentInput,
} from './payments.validation.js';
import type { Types } from 'mongoose';

// ── Receipt PDF helper — generate, upload to R2, return key ──

async function generateAndUploadReceipt(data: ReceiptData): Promise<string> {
  try {
    const buf = await generateReceiptPdf(data);
    const key = `receipts/${uuidv4()}-${data.receiptNumber}.pdf`;
    await r2Client.send(
      new PutObjectCommand({
        Bucket: env.R2_BUCKET_NAME,
        Key: key,
        Body: buf,
        ContentType: 'application/pdf',
      }),
    );
    logger.info(`Receipt PDF uploaded: ${key}`);
    return key;
  } catch (err) {
    logger.error('Receipt PDF generation/upload failed', err);
    return ''; // non-fatal — payment still succeeds
  }
}

// ── Cashier: Create Payment Plan ──

export async function createPaymentPlan(
  input: CreatePaymentPlanInput,
  createdBy: string,
  ip?: string,
  ua?: string,
) {
  const project = await Project.findById(input.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Project must be approved
  if (project.status !== ProjectStatus.APPROVED) {
    throw AppError.badRequest('Payment plan can only be created for approved projects');
  }

  // Check no existing plan
  const existing = await PaymentPlan.findOne({ projectId: input.projectId });
  if (existing) throw AppError.conflict('Payment plan already exists for this project', ErrorCode.DUPLICATE_ENTRY);

  const isPayInFull = input.stages.length === 1;
  const stages = input.stages.map((s, idx) => {
    const amount = Math.round((input.totalAmount * s.percentage / 100) * 100) / 100;
    // Auto-verify ₱0 stages so customers don't need to checkout for nothing
    const isZero = amount <= 0;
    return {
      stageId: uuidv4(),
      label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
      percentage: s.percentage,
      amount,
      status: isZero ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING,
      qrCodeKey: s.qrCodeKey,
      amountPaid: isZero ? amount : 0,
      creditApplied: 0,
      remainingBalance: isZero ? 0 : amount,
      activatedAt: (idx === 0 || isZero) ? new Date() : null, // Stage 1 immediately due; others wait for fabrication
    };
  });

  const plan = await PaymentPlan.create({
    projectId: input.projectId,
    totalAmount: input.totalAmount,
    isPayInFull,
    stages,
    createdBy,
  });

  // Transition project to payment_pending
  projectStateMachine.assertTransition(project.status, ProjectStatus.PAYMENT_PENDING);
  project.status = ProjectStatus.PAYMENT_PENDING;
  await project.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_CREATED,
    actorId: createdBy,
    targetType: 'payment_plan',
    targetId: plan._id,
    details: { projectId: input.projectId, totalAmount: input.totalAmount, stageCount: stages.length },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Payment Plan Created',
    `A payment plan of ${formatCurrency(input.totalAmount)} has been set up for "${project.title}".`,
    `/projects/${project._id}/payments`,
  );

  return plan;
}

// ── Cashier: Update Payment Plan (before any verified payment) ──

export async function updatePaymentPlan(
  planId: string,
  input: UpdatePaymentPlanInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findById(planId);
  if (!plan) throw AppError.notFound('Payment plan not found');

  if (plan.isImmutable) {
    throw AppError.badRequest('Payment plan cannot be modified after a payment has been verified');
  }

  if (input.totalAmount !== undefined) {
    plan.totalAmount = input.totalAmount;
  }

  if (input.stages) {
    const isPayInFull = input.stages.length === 1;
    plan.isPayInFull = isPayInFull;
    plan.stages = input.stages.map((s, idx) => {
      const amount = Math.round((plan.totalAmount * s.percentage / 100) * 100) / 100;
      const isZero = amount <= 0;
      return {
        stageId: uuidv4(),
        label: isPayInFull ? 'Full Payment' : `Stage ${idx + 1}`,
        percentage: s.percentage,
        amount,
        status: isZero ? PaymentStageStatus.VERIFIED : PaymentStageStatus.PENDING,
        qrCodeKey: s.qrCodeKey,
        amountPaid: isZero ? amount : 0,
        creditApplied: 0,
        remainingBalance: isZero ? 0 : amount,
        activatedAt: idx === 0 ? new Date() : null,
        headsUpSentAt: null,
        remindersSent: 0,
        lastReminderAt: null,
        escalatedToCashier: false,
      };
    });
  }

  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PLAN_UPDATED,
    actorId,
    targetType: 'payment_plan',
    targetId: plan._id,
    details: { totalAmount: plan.totalAmount, stageCount: plan.stages.length },
    ipAddress: ip,
    userAgent: ua,
  });

  return plan;
}

// ── Customer: Submit Payment Proof ──

export async function submitPaymentProof(
  input: SubmitPaymentProofInput,
  customerId: string,
  idempotencyKey?: string,
  ip?: string,
  ua?: string,
) {
  // Find the plan containing this stage
  const plan = await PaymentPlan.findOne({ 'stages.stageId': input.stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only submit payments for your own projects');
  }

  // Contract must be signed before payment
  if (!project.contractSignedAt) {
    throw AppError.badRequest('You must sign the project contract before making any payments');
  }

  const stage = plan.stages.find(s => s.stageId === input.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  // Stage must be pending or declined (re-submit allowed)
  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest('This stage is not accepting payments');
  }

  // If stage isn't activated yet, allow payment but log it as advance
  // (badges stay informational; customer can pay early)

  const payment = await Payment.create({
    projectId: plan.projectId,
    stageId: input.stageId,
    method: input.method,
    amountPaid: input.amountPaid,
    referenceNumber: input.referenceNumber,
    proofKey: input.proofKey,
    status: PaymentStageStatus.PROOF_SUBMITTED,
    idempotencyKey,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Update stage status
  stage.status = PaymentStageStatus.PROOF_SUBMITTED;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_PROOF_SUBMITTED,
    actorId: customerId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: input.stageId, method: input.method, amountPaid: input.amountPaid },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashier
  await createAndSendNotification(
    plan.createdBy,
    NotificationCategory.PAYMENT,
    'Payment Proof Submitted',
    `New payment proof submitted for "${project.title}" - ${stage.label} (${formatCurrency(input.amountPaid)})`,
    `/projects/${project._id}/payments`,
  );

  return payment;
}

// ── Cashier: Verify Payment ──

export async function verifyPayment(
  paymentId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');

  paymentStateMachine.assertTransition(payment.status, PaymentStageStatus.VERIFIED);

  const plan = await PaymentPlan.findOne({ projectId: payment.projectId });
  if (!plan) throw AppError.notFound('Payment plan not found');

  const stage = plan.stages.find(s => s.stageId === payment.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  const project = await Project.findById(payment.projectId);
  if (!project) throw AppError.notFound('Project not found');

  // Credit system: calculate overpay/underpay
  const totalPaidForStage = stage.amountPaid + payment.amountPaid;
  const remaining = stage.amount - totalPaidForStage;

  if (remaining <= 0) {
    // Fully paid or overpaid
    stage.status = PaymentStageStatus.VERIFIED;
    stage.amountPaid = totalPaidForStage;
    stage.remainingBalance = 0;

    const excess = Math.abs(remaining);
    if (excess > 0) {
      payment.excessCredit = excess;
      // Apply excess credit to next pending stage
      await applyExcessCredit(plan, excess);
    }
  } else {
    // Partial payment — stage remains proof_submitted but records the partial
    stage.amountPaid = totalPaidForStage;
    stage.remainingBalance = remaining;
    // Mark as pending to allow more proofs
    stage.status = PaymentStageStatus.PENDING;
  }

  // Lock the plan after first verified payment
  if (!plan.isImmutable) {
    plan.isImmutable = true;
  }

  await plan.save();

  // Generate receipt
  const receiptNumber = await generateNextReceiptNumber();
  payment.status = PaymentStageStatus.VERIFIED;
  payment.verifiedBy = actorId as unknown as Types.ObjectId;
  payment.verifiedAt = new Date();
  payment.receiptNumber = receiptNumber;

  // Generate receipt PDF
  const customer = await User.findById(project.customerId);
  const verifier = await User.findById(actorId);
  const totalPaid = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0);
  const customerAddr = customer?.addressData
    ? [customer.addressData.street, customer.addressData.barangay, customer.addressData.city, customer.addressData.province, customer.addressData.zip].filter(Boolean).join(', ')
    : (customer as any)?.address || '';
  const receiptKey = await generateAndUploadReceipt({
    receiptNumber,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
    customerEmail: customer?.email || '',
    customerAddress: customerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid: payment.amountPaid,
    paymentMethod: payment.method,
    referenceNumber: payment.referenceNumber,
    creditApplied: payment.creditFromPrevious,
    excessCredit: payment.excessCredit,
    verifiedByName: verifier ? `${verifier.firstName} ${verifier.lastName}` : 'System',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid,
    totalOutstanding: Math.max(0, plan.totalAmount - totalPaid),
  });
  if (receiptKey) payment.receiptKey = receiptKey;

  await payment.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: {
      stageId: payment.stageId,
      amountPaid: payment.amountPaid,
      receiptNumber,
      receiptKey,
      excessCredit: payment.excessCredit,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PAYMENT,
      'Payment Verified',
      `Your payment of ${formatCurrency(payment.amountPaid)} for "${project.title}" - ${stage.label} has been verified. Receipt: ${receiptNumber}`,
      `/projects/${project._id}/payments`,
    );

    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(payment.amountPaid),
      stageLabel: stage.label,
      receiptNumber,
    });
  }

  // Check if first stage (down payment / full payment) is verified — transition project to fabrication
  const firstStageVerified = plan.stages[0]?.status === PaymentStageStatus.VERIFIED;
  if (firstStageVerified && project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
    await project.save();

    const allVerified = plan.stages.every(s => s.status === PaymentStageStatus.VERIFIED);
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      allVerified ? 'All Payments Verified' : 'Down Payment Verified',
      allVerified
        ? `All payments for "${project.title}" are verified! Your project is now moving to fabrication.`
        : `Your down payment for "${project.title}" has been verified! Your project is now moving to fabrication. Remaining payments can be made during the fabrication phase.`,
      `/projects/${project._id}`,
    );
  }

  return { payment, receiptNumber };
}

// ── Cashier: Decline Payment ──

export async function declinePayment(
  paymentId: string,
  input: DeclinePaymentInput,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');

  paymentStateMachine.assertTransition(payment.status, PaymentStageStatus.DECLINED);

  const plan = await PaymentPlan.findOne({ projectId: payment.projectId });
  if (!plan) throw AppError.notFound('Payment plan not found');

  const stage = plan.stages.find(s => s.stageId === payment.stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  const project = await Project.findById(payment.projectId);
  if (!project) throw AppError.notFound('Project not found');

  payment.status = PaymentStageStatus.DECLINED;
  payment.declineReason = input.reason;
  await payment.save();

  // Revert stage status to declined
  stage.status = PaymentStageStatus.DECLINED;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_DECLINED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: payment.stageId, reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  const customer = await User.findById(project.customerId);
  if (customer) {
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.PAYMENT,
      'Payment Declined',
      `Your payment for "${project.title}" - ${stage.label} has been declined. Reason: ${input.reason}`,
      `/projects/${project._id}/payments`,
    );

    await sendPaymentDeclinedEmail(customer.email, {
      stageLabel: stage.label,
      reason: input.reason,
    });
  }

  return payment;
}

// ── Get Payment Plan by Project ──

async function assertPaymentProjectAccess(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
): Promise<void> {
  const project = await Project.findById(projectId)
    .select('customerId salesStaffId engineerIds fabricationLeadId fabricationAssistantIds status');
  if (!project) throw AppError.notFound('Project not found');

  if (actorRoles.some((role) => [Role.ADMIN, Role.CASHIER].includes(role))) return;

  if (actorRoles.includes(Role.CUSTOMER) && project.customerId.toString() === actorId) return;
  if (actorRoles.includes(Role.SALES_STAFF) && project.salesStaffId?.toString() === actorId) return;

  if (actorRoles.includes(Role.ENGINEER)) {
    if (project.engineerIds.some((id) => id.toString() === actorId)) return;
    if (project.status === ProjectStatus.SUBMITTED && project.engineerIds.length === 0) return;
  }


  if (actorRoles.includes(Role.FABRICATION_STAFF)) {
    if (project.fabricationLeadId?.toString() === actorId) return;
    if (project.fabricationAssistantIds?.some((id) => id.toString() === actorId)) return;
  }
  throw AppError.forbidden('Access denied');
}

export async function getPaymentPlanByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const plan = await PaymentPlan.findOne({ projectId })
    .populate('createdBy', 'firstName lastName');
  return plan;
}

// ── List Payments for a Project ──

export async function listPaymentsByProject(
  projectId: string,
  actorId: string,
  actorRoles: Role[],
) {
  await assertPaymentProjectAccess(projectId, actorId, actorRoles);
  const payments = await Payment.find({ projectId })
    .populate('verifiedBy', 'firstName lastName')
    .sort({ createdAt: -1 });
  return payments;
}

// ── List Payments for Cashier (pending verification) ──

export async function listPendingPayments(query: {
  page?: string;
  limit?: string;
}) {
  const page = parseInt(query.page || '1');
  const limit = Math.min(parseInt(query.limit || '20'), 100);

  const [payments, total] = await Promise.all([
    Payment.find({ status: PaymentStageStatus.PROOF_SUBMITTED })
      .populate('projectId', 'title customerId')
      .sort({ createdAt: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Payment.countDocuments({ status: PaymentStageStatus.PROOF_SUBMITTED }),
  ]);

  return payments;
}

// ── Get Payment by ID ──

export async function getPaymentById(
  paymentId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const payment = await Payment.findById(paymentId)
    .populate('verifiedBy', 'firstName lastName');
  if (!payment) throw AppError.notFound('Payment not found');
  await assertPaymentProjectAccess(payment.projectId.toString(), actorId, actorRoles);
  return payment;
}

// ── Customer: Payment History (all payments) ──

export async function getMyPaymentHistory(customerId: string) {
  // Get all projects belonging to this customer
  const projects = await Project.find({ customerId }).select('_id title');
  const projectIds = projects.map(p => p._id);
  const projectMap = new Map(projects.map(p => [p._id.toString(), p.title]));

  // Get all project payments
  const projectPayments = await Payment.find({ projectId: { $in: projectIds } })
    .sort({ createdAt: -1 })
    .lean();

  // Get all ocular fee appointments (paid or pending)
  const ocularAppointments = await Appointment.find({
    customerId,
    type: 'ocular',
    ocularFee: { $gt: 0 },
    ocularFeeStatus: { $in: ['verified', 'pending', 'proof_submitted', 'declined'] },
  })
    .select('date ocularFee ocularFeePaid ocularFeeStatus ocularFeePaymentMethod formattedAddress createdAt')
    .sort({ createdAt: -1 })
    .lean();

  // Build unified timeline
  const history: Array<{
    _id: string;
    type: 'project_payment' | 'ocular_fee';
    amount: number;
    status: string;
    method?: string;
    referenceNumber?: string;
    receiptNumber?: string;
    description: string;
    date: string;
    declineReason?: string;
  }> = [];

  for (const p of projectPayments) {
    history.push({
      _id: p._id.toString(),
      type: 'project_payment',
      amount: p.amountPaid,
      status: p.status,
      method: p.method,
      referenceNumber: p.referenceNumber,
      receiptNumber: p.receiptNumber,
      description: projectMap.get(p.projectId.toString()) || 'Project Payment',
      date: (p.createdAt as Date).toISOString(),
      declineReason: p.declineReason,
    });
  }

  for (const a of ocularAppointments) {
    history.push({
      _id: a._id.toString(),
      type: 'ocular_fee',
      amount: a.ocularFee!,
      status: a.ocularFeePaid ? 'verified' : (a.ocularFeeStatus || 'pending'),
      method: a.ocularFeePaymentMethod,
      description: `Ocular Fee — ${a.formattedAddress || a.date}`,
      date: (a.createdAt as Date).toISOString(),
    });
  }

  // Sort by date descending
  history.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return history;
}

// ── Helpers ──

async function applyExcessCredit(plan: any, excessAmount: number): Promise<void> {
  // Find next pending stages and apply credit
  for (const stage of plan.stages) {
    if (excessAmount <= 0) break;
    if (stage.status === PaymentStageStatus.PENDING && stage.remainingBalance > 0) {
      const creditToApply = Math.min(excessAmount, stage.remainingBalance);
      stage.creditApplied += creditToApply;
      stage.amountPaid += creditToApply;
      stage.remainingBalance -= creditToApply;
      excessAmount -= creditToApply;

      if (stage.remainingBalance <= 0) {
        stage.status = PaymentStageStatus.VERIFIED;
        stage.remainingBalance = 0;
      }
    }
  }
}

async function generateNextReceiptNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const counter = await ReceiptCounter.findOneAndUpdate(
    { year },
    { $inc: { lastSeq: 1 } },
    { upsert: true, new: true },
  );
  return generateReceiptNumber(year, counter.lastSeq);
}

// ── Customer: Create PayMongo QRPH Checkout for a Stage ──

export async function createStageCheckout(
  stageId: string,
  customerId: string,
  origin: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');
  if (project.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only pay for your own projects');
  }

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest('This stage is not accepting payments');
  }

  // Allow advance payments — badges stay informational, no hard block

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;

  // Dev override: ₱1 flat for testing (same pattern as ocular fee)
  const checkoutAmount = env.NODE_ENV === 'production' ? remaining : 1;

  const description = `${project.title} — ${stage.label}`;
  const session = await createStageCheckoutSession({
    amount: checkoutAmount,
    description,
    stageId,
    projectId: plan.projectId.toString(),
    customerId,
    successUrl: `${origin}/payments?paid=1`,
    cancelUrl: `${origin}/payments?cancelled=1`,
  });

  // Store checkout session ID on the stage for webhook lookup
  stage.checkoutSessionId = session.id;
  await plan.save();

  logger.info(`Stage checkout session created: ${session.id} for stage ${stageId}`);

  return {
    checkoutUrl: session.attributes.checkout_url,
    sessionId: session.id,
    amount: checkoutAmount,
  };
}

// ── Handle PayMongo Webhook for Stage Payments ──

export async function handleStagePaymongoPayment(checkoutSessionId: string) {
  const plan = await PaymentPlan.findOne({
    'stages.checkoutSessionId': checkoutSessionId,
  });

  if (!plan) return null; // Not a stage payment

  const stage = plan.stages.find(s => s.checkoutSessionId === checkoutSessionId);
  if (!stage) return null;

  // Already verified — idempotent
  if (stage.status === PaymentStageStatus.VERIFIED) return plan;

  const project = await Project.findById(plan.projectId);
  if (!project) return null;

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;
  const amountPaid = env.NODE_ENV === 'production' ? remaining : 1;

  // Create Payment record
  const receiptNumber = await generateNextReceiptNumber();
  const payment = await Payment.create({
    projectId: plan.projectId,
    stageId: stage.stageId,
    method: PaymentMethod.QRPH,
    amountPaid,
    status: PaymentStageStatus.VERIFIED,
    verifiedAt: new Date(),
    receiptNumber,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Generate receipt PDF
  const customer = await User.findById(project.customerId);
  const totalPaidWebhook = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0) + amountPaid;
  const whCustomerAddr = customer?.addressData
    ? [customer.addressData.street, customer.addressData.barangay, customer.addressData.city, customer.addressData.province, customer.addressData.zip].filter(Boolean).join(', ')
    : (customer as any)?.address || '';
  const receiptKey = await generateAndUploadReceipt({
    receiptNumber,
    customerName: customer ? `${customer.firstName} ${customer.lastName}` : 'Customer',
    customerEmail: customer?.email || '',
    customerAddress: whCustomerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid,
    paymentMethod: 'qrph',
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: 'PayMongo (Auto)',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid: totalPaidWebhook,
    totalOutstanding: Math.max(0, plan.totalAmount - totalPaidWebhook),
  });
  if (receiptKey) {
    payment.receiptKey = receiptKey;
    await payment.save();
  }

  // Update stage
  stage.status = PaymentStageStatus.VERIFIED;
  stage.amountPaid += amountPaid;
  stage.remainingBalance = Math.max(0, stage.amount - stage.amountPaid);

  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId: project.customerId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid, verifiedVia: 'paymongo_webhook', receiptNumber },
  });

  // Notify customer
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Payment Confirmed via QR',
    `Your QRPH payment of ${formatCurrency(amountPaid)} for "${project.title}" — ${stage.label} has been confirmed. Receipt: ${receiptNumber}`,
    `/projects/${project._id}/payments`,
  );

  // Notify cashier
  const cashiers = await User.find({ roles: Role.CASHIER }).select('_id');
  for (const c of cashiers) {
    await createAndSendNotification(
      c._id,
      NotificationCategory.PAYMENT,
      'QRPH Payment Auto-Verified',
      `QRPH payment for "${project.title}" — ${stage.label} was automatically verified. Receipt: ${receiptNumber}`,
      `/projects/${project._id}/payments`,
    );
  }

  // Send email
  if (customer) {
    await sendPaymentVerifiedEmail(customer.email, {
      amount: formatCurrency(amountPaid),
      stageLabel: stage.label,
      receiptNumber,
    });
  }

  // Check if first stage (down payment / full payment) is verified → transition to fabrication
  const firstStageVerified = plan.stages[0]?.status === PaymentStageStatus.VERIFIED;
  if (firstStageVerified && project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
    await project.save();

    const allVerified = plan.stages.every(s => s.status === PaymentStageStatus.VERIFIED);
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      allVerified ? 'All Payments Verified' : 'Down Payment Verified',
      allVerified
        ? `All payments for "${project.title}" are verified! Your project is now moving to fabrication.`
        : `Your down payment for "${project.title}" has been verified! Your project is now moving to fabrication. Remaining payments can be made during the fabrication phase.`,
      `/projects/${project._id}`,
    );
  }

  return plan;
}

// ⚠️ DEV ONLY: Simulate Stage Payment ──

export async function simulateStagePayment(
  stageId: string,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest('This stage is not accepting payments');
  }

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const remaining = stage.remainingBalance > 0 ? stage.remainingBalance : stage.amount;

  const receiptNumber = await generateNextReceiptNumber();
  const payment = await Payment.create({
    projectId: plan.projectId,
    stageId: stage.stageId,
    method: PaymentMethod.QRPH,
    amountPaid: remaining,
    status: PaymentStageStatus.VERIFIED,
    verifiedBy: actorId as unknown as Types.ObjectId,
    verifiedAt: new Date(),
    receiptNumber,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Generate receipt PDF
  const simCustomer = await User.findById(project.customerId);
  const simTotalPaid = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0) + remaining;
  const simCustomerAddr = simCustomer?.addressData
    ? [simCustomer.addressData.street, simCustomer.addressData.barangay, simCustomer.addressData.city, simCustomer.addressData.province, simCustomer.addressData.zip].filter(Boolean).join(', ')
    : (simCustomer as any)?.address || '';
  const simReceiptKey = await generateAndUploadReceipt({
    receiptNumber,
    customerName: simCustomer ? `${simCustomer.firstName} ${simCustomer.lastName}` : 'Customer',
    customerEmail: simCustomer?.email || '',
    customerAddress: simCustomerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid: remaining,
    paymentMethod: 'qrph',
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: 'System (Simulated)',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid: simTotalPaid,
    totalOutstanding: Math.max(0, plan.totalAmount - simTotalPaid),
  });
  if (simReceiptKey) {
    payment.receiptKey = simReceiptKey;
    await payment.save();
  }

  stage.status = PaymentStageStatus.VERIFIED;
  stage.amountPaid = stage.amount;
  stage.remainingBalance = 0;

  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid: remaining, verifiedVia: 'simulate', receiptNumber },
    ipAddress: ip,
    userAgent: ua,
  });

  // Check if first stage verified → fabrication
  const firstStageVerified = plan.stages[0]?.status === PaymentStageStatus.VERIFIED;
  if (firstStageVerified && project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
    await project.save();
  }

  return { payment, receiptNumber };
}

// ── Cashier: Record Cash Payment (auto-verified) ──

export async function recordCashPayment(
  stageId: string,
  amountPaid: number,
  actorId: string,
  ip?: string,
  ua?: string,
) {
  const plan = await PaymentPlan.findOne({ 'stages.stageId': stageId });
  if (!plan) throw AppError.notFound('Payment stage not found');

  const stage = plan.stages.find(s => s.stageId === stageId);
  if (!stage) throw AppError.notFound('Stage not found');

  if (![PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED].includes(stage.status)) {
    throw AppError.badRequest('This stage is not accepting payments');
  }

  const project = await Project.findById(plan.projectId);
  if (!project) throw AppError.notFound('Project not found');

  const receiptNumber = await generateNextReceiptNumber();
  const payment = await Payment.create({
    projectId: plan.projectId,
    stageId: stage.stageId,
    method: PaymentMethod.CASH,
    amountPaid,
    status: PaymentStageStatus.VERIFIED,
    verifiedBy: actorId as unknown as Types.ObjectId,
    verifiedAt: new Date(),
    receiptNumber,
    creditFromPrevious: 0,
    excessCredit: 0,
  });

  // Generate receipt PDF
  const cashCustomer = await User.findById(project.customerId);
  const cashVerifier = await User.findById(actorId);
  const cashTotalPaid = plan.stages.reduce((sum, s) => sum + s.amountPaid, 0) + amountPaid;
  const cashCustomerAddr = cashCustomer?.addressData
    ? [cashCustomer.addressData.street, cashCustomer.addressData.barangay, cashCustomer.addressData.city, cashCustomer.addressData.province, cashCustomer.addressData.zip].filter(Boolean).join(', ')
    : (cashCustomer as any)?.address || '';
  const cashReceiptKey = await generateAndUploadReceipt({
    receiptNumber,
    customerName: cashCustomer ? `${cashCustomer.firstName} ${cashCustomer.lastName}` : 'Customer',
    customerEmail: cashCustomer?.email || '',
    customerAddress: cashCustomerAddr,
    projectTitle: project.title,
    stageName: stage.label,
    amountPaid,
    paymentMethod: 'cash',
    creditApplied: 0,
    excessCredit: 0,
    verifiedByName: cashVerifier ? `${cashVerifier.firstName} ${cashVerifier.lastName}` : 'Cashier',
    verifiedAt: payment.verifiedAt!,
    totalProjectCost: plan.totalAmount,
    totalPaid: cashTotalPaid,
    totalOutstanding: Math.max(0, plan.totalAmount - cashTotalPaid),
  });
  if (cashReceiptKey) payment.receiptKey = cashReceiptKey;

  // Update stage
  const totalPaid = stage.amountPaid + amountPaid;
  const remaining = stage.amount - totalPaid;

  if (remaining <= 0) {
    stage.status = PaymentStageStatus.VERIFIED;
    stage.amountPaid = totalPaid;
    stage.remainingBalance = 0;
    const excess = Math.abs(remaining);
    if (excess > 0) {
      payment.excessCredit = excess;
      await payment.save();
      await applyExcessCredit(plan, excess);
    }
  } else {
    stage.amountPaid = totalPaid;
    stage.remainingBalance = remaining;
  }

  if (!plan.isImmutable) plan.isImmutable = true;
  await plan.save();

  await AuditLog.create({
    action: AuditAction.PAYMENT_VERIFIED,
    actorId,
    targetType: 'payment',
    targetId: payment._id,
    details: { stageId: stage.stageId, amountPaid, method: 'cash', receiptNumber },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    project.customerId,
    NotificationCategory.PAYMENT,
    'Cash Payment Recorded',
    `A cash payment of ${formatCurrency(amountPaid)} for "${project.title}" — ${stage.label} has been recorded. Receipt: ${receiptNumber}`,
    `/projects/${project._id}/payments`,
  );

  if (cashCustomer) {
    await sendPaymentVerifiedEmail(cashCustomer.email, {
      amount: formatCurrency(amountPaid),
      stageLabel: stage.label,
      receiptNumber,
    });
  }

  // Check if first stage (down payment / full payment) is verified → fabrication
  const firstStageVerified = plan.stages[0]?.status === PaymentStageStatus.VERIFIED;
  if (firstStageVerified && project.status === ProjectStatus.PAYMENT_PENDING) {
    projectStateMachine.assertTransition(project.status, ProjectStatus.FABRICATION);
    project.status = ProjectStatus.FABRICATION;
    await project.save();

    const allVerified = plan.stages.every(s => s.status === PaymentStageStatus.VERIFIED);
    await createAndSendNotification(
      project.customerId,
      NotificationCategory.SYSTEM,
      allVerified ? 'All Payments Verified' : 'Down Payment Verified',
      allVerified
        ? `All payments for "${project.title}" are verified! Your project is now moving to fabrication.`
        : `Your down payment for "${project.title}" has been verified! Your project is now moving to fabrication. Remaining payments can be made during the fabrication phase.`,
      `/projects/${project._id}`,
    );
  }

  return { payment, receiptNumber };
}

// ── Get Receipt Download URL ──

export async function getReceiptDownloadUrl(
  paymentId: string,
  actorId: string,
  actorRoles: Role[],
) {
  const payment = await Payment.findById(paymentId);
  if (!payment) throw AppError.notFound('Payment not found');
  if (!payment.receiptKey) throw AppError.badRequest('No receipt available for this payment');

  await assertPaymentProjectAccess(payment.projectId.toString(), actorId, actorRoles);

  const url = await generateDownloadUrl(payment.receiptKey);
  return { url, key: payment.receiptKey };
}

// ── Cashier: List Overdue Payments ──

export async function listOverduePayments() {
  const plans = await PaymentPlan.find({
    'stages': {
      $elemMatch: {
        activatedAt: { $ne: null },
        status: { $in: [PaymentStageStatus.PENDING, PaymentStageStatus.DECLINED] },
      },
    },
  }).populate('projectId', 'title customerId');

  const overdueStages: Array<{
    projectId: string;
    projectTitle: string;
    customerId: string;
    customerName: string;
    stageId: string;
    stageLabel: string;
    amount: number;
    activatedAt: Date;
    daysSinceActivation: number;
    remindersSent: number;
    escalatedToCashier: boolean;
  }> = [];

  const now = new Date();

  for (const plan of plans) {
    const project = plan.projectId as any;
    if (!project?._id) continue;

    const customer = await User.findById(project.customerId).select('firstName lastName');
    const customerName = customer ? `${customer.firstName} ${customer.lastName}` : 'Unknown';

    for (const stage of plan.stages) {
      if (
        !stage.activatedAt ||
        stage.status === PaymentStageStatus.VERIFIED ||
        stage.status === PaymentStageStatus.PROOF_SUBMITTED
      ) {
        continue;
      }

      const daysSinceActivation = Math.floor(
        (now.getTime() - new Date(stage.activatedAt).getTime()) / (1000 * 60 * 60 * 24),
      );

      overdueStages.push({
        projectId: project._id.toString(),
        projectTitle: project.title,
        customerId: project.customerId.toString(),
        customerName,
        stageId: stage.stageId,
        stageLabel: stage.label,
        amount: stage.amount,
        activatedAt: stage.activatedAt,
        daysSinceActivation,
        remindersSent: stage.remindersSent,
        escalatedToCashier: stage.escalatedToCashier,
      });
    }
  }

  // Sort by most overdue first
  overdueStages.sort((a, b) => b.daysSinceActivation - a.daysSinceActivation);
  return overdueStages;
}