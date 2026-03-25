import { Appointment, RefundRequest, AuditLog, User } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import {
  AppointmentStatus, AuditAction, NotificationCategory, RefundRequestStatus, Role,
} from '../../utils/constants.js';
import { createAndSendNotification, notifyRole, emitRoleEvent } from '../notifications/socket.service.js';
import {
  sendRefundApprovedEmail,
  sendRefundDeniedEmail,
  sendRefundDispatchedEmail,
  sendRefundReconciledEmail,
} from '../notifications/email.service.js';
import { formatCurrency } from '../../utils/helpers.js';
import type {
  SubmitRefundRequestInput,
  DenyRefundRequestInput,
  UpdateMyRefundRequestInput,
  CancelMyRefundRequestInput,
  DispatchRefundRequestInput,
  ReconcileRefundRequestInput,
} from './refunds.validation.js';
import type { Types } from 'mongoose';

function appendRefundTrailEvent(
  refund: any,
  input: {
    event: 'submitted' | 'updated' | 'approved' | 'denied' | 'cancelled' | 'dispatched' | 'reconciled';
    actorId?: string;
    note?: string;
    referenceNumber?: string;
    amount?: number;
  },
) {
  refund.dispatchTrail = refund.dispatchTrail || [];
  refund.dispatchTrail.push({
    event: input.event,
    at: new Date(),
    actorId: input.actorId,
    note: input.note,
    referenceNumber: input.referenceNumber,
    amount: input.amount,
  });
}

// ── Customer: Submit Refund Request ──

export async function submitRefundRequest(
  input: SubmitRefundRequestInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const appointment = await Appointment.findById(input.appointmentId);
  if (!appointment) throw AppError.notFound('Appointment not found');

  // Must be the appointment owner
  if (appointment.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only request refunds for your own appointments');
  }

  // Must have a paid ocular fee
  if (!appointment.ocularFee || appointment.ocularFee <= 0) {
    throw AppError.badRequest('This appointment has no ocular fee to refund');
  }

  if (appointment.ocularFeeStatus !== 'verified') {
    throw AppError.badRequest(
      'Only verified (paid) ocular fees can be refunded',
      ErrorCode.REFUND_NOT_ALLOWED,
      { helpPath: '/help/payments-refunds/refunds#checklist' },
    );
  }

  // Block if appointment is on_the_way or completed — customer should contact admin
  if ([AppointmentStatus.ON_THE_WAY, AppointmentStatus.COMPLETED].includes(appointment.status as AppointmentStatus)) {
    throw AppError.badRequest(
      'Refund requests are not available once the visit is on the way or completed. Please contact the admin directly.',
      ErrorCode.REFUND_NOT_ALLOWED,
      { helpPath: '/help/payments-refunds/refunds#checklist' },
    );
  }

  // Check no existing pending refund for this appointment
  const existingPending = await RefundRequest.findOne({
    appointmentId: input.appointmentId,
    status: RefundRequestStatus.PENDING,
  });
  if (existingPending) {
    throw AppError.conflict(
      'You already have a pending refund request for this appointment',
      ErrorCode.REFUND_ALREADY_PENDING,
      { helpPath: '/help/payments-refunds/refunds#checklist' },
    );
  }

  const refundRequest = await RefundRequest.create({
    appointmentId: input.appointmentId,
    customerId,
    reason: input.reason,
    refundMethod: input.refundMethod,
    accountName: input.accountName,
    accountNumber: input.accountNumber,
    bankName: input.bankName,
    amount: appointment.ocularFee,
    status: RefundRequestStatus.PENDING,
  });
  appendRefundTrailEvent(refundRequest, {
    event: 'submitted',
    actorId: customerId,
    note: input.reason,
    amount: appointment.ocularFee,
  });
  await refundRequest.save();

  await AuditLog.create({
    action: AuditAction.REFUND_REQUESTED,
    actorId: customerId,
    targetType: 'refund_request',
    targetId: refundRequest._id,
    details: {
      appointmentId: input.appointmentId,
      amount: appointment.ocularFee,
      refundMethod: input.refundMethod,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify cashiers
  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'New Refund Request',
    `Customer requested a refund of ${formatCurrency(appointment.ocularFee)} for ocular fee.`,
    `/refund-requests/${refundRequest._id}`,
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'refund_submitted',
    refundId: refundRequest._id.toString(),
    appointmentId: input.appointmentId,
    amount: appointment.ocularFee,
  });

  return refundRequest;
}

// ── Cashier/Admin: List Refund Requests ──

export async function listRefundRequests(query: { status?: string; search?: string; page?: string; limit?: string }) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const page = Math.max(1, parseInt(query.page || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(query.limit || '20')));
  const skip = (page - 1) * limit;

  // If search is provided, first find matching customer IDs then add to filter
  if (query.search) {
    const { User } = await import('../../models/index.js');
    const escapedSearch = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escapedSearch, 'i');

    const matchingUsers = await User.find({
      $or: [
        { firstName: regex },
        { lastName: regex },
        { email: regex },
      ],
    }).select('_id').lean();

    const userIds = matchingUsers.map((u) => u._id);
    filter.$or = [
      { customerId: { $in: userIds } },
      { reason: regex },
      { accountName: regex },
    ];
  }

  const [requests, total] = await Promise.all([
    RefundRequest.find(filter)
      .populate('customerId', 'firstName lastName email phone')
      .populate('appointmentId', 'date slotCode type ocularFee formattedAddress')
      .populate('reviewedBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    RefundRequest.countDocuments(filter),
  ]);

  return { requests, total, page, limit, totalPages: Math.ceil(total / limit) };
}

// ── Cashier/Admin: Approve Refund ──

export async function approveRefundRequest(
  refundId: string,
  reviewerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (refund.status !== RefundRequestStatus.PENDING) {
    throw AppError.badRequest('This refund request has already been processed');
  }

  refund.status = RefundRequestStatus.APPROVED;
  refund.reviewedBy = reviewerId as unknown as Types.ObjectId;
  refund.reviewedAt = new Date();
  appendRefundTrailEvent(refund, {
    event: 'approved',
    actorId: reviewerId,
    amount: refund.amount,
  });
  await refund.save();

  // Update appointment ocular fee status to refunded
  await Appointment.findByIdAndUpdate(refund.appointmentId, {
    ocularFeeStatus: 'refunded',
    ocularFeeRefundReason: refund.reason,
    ocularFeeRefundedBy: reviewerId,
    ocularFeeRefundedAt: new Date(),
  });

  await AuditLog.create({
    action: AuditAction.REFUND_APPROVED,
    actorId: reviewerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      appointmentId: refund.appointmentId.toString(),
      amount: refund.amount,
      customerId: refund.customerId.toString(),
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    refund.customerId.toString(),
    NotificationCategory.PAYMENT,
    'Refund Approved',
    `Your refund request of ${formatCurrency(refund.amount)} has been approved. The refund will be processed to your ${refund.refundMethod === 'gcash' ? 'GCash' : 'bank'} account.`,
    `/appointments/${refund.appointmentId}`,
  );

  const customer = await User.findById(refund.customerId);
  if (customer) {
    await sendRefundApprovedEmail(customer.email, {
      amount: formatCurrency(refund.amount),
      refundMethod: refund.refundMethod === 'gcash' ? 'GCash' : 'Bank Transfer',
      appointmentId: refund.appointmentId.toString(),
      refundId: refund._id.toString(),
    });
  }

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'refund_approved',
    refundId: refund._id.toString(),
    appointmentId: refund.appointmentId.toString(),
  });

  return refund;
}

// ── Cashier/Admin: Deny Refund ──

export async function denyRefundRequest(
  refundId: string,
  input: DenyRefundRequestInput,
  reviewerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (refund.status !== RefundRequestStatus.PENDING) {
    throw AppError.badRequest('This refund request has already been processed');
  }

  refund.status = RefundRequestStatus.DENIED;
  refund.reviewedBy = reviewerId as unknown as Types.ObjectId;
  refund.reviewedAt = new Date();
  refund.denialReason = input.denialReason;
  appendRefundTrailEvent(refund, {
    event: 'denied',
    actorId: reviewerId,
    note: input.denialReason,
    amount: refund.amount,
  });
  await refund.save();

  await AuditLog.create({
    action: AuditAction.REFUND_DENIED,
    actorId: reviewerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      appointmentId: refund.appointmentId.toString(),
      amount: refund.amount,
      denialReason: input.denialReason,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  // Notify customer
  await createAndSendNotification(
    refund.customerId.toString(),
    NotificationCategory.PAYMENT,
    'Refund Request Denied',
    `Your refund request of ${formatCurrency(refund.amount)} has been denied. Reason: ${input.denialReason}`,
    `/appointments/${refund.appointmentId}`,
  );

  const customer = await User.findById(refund.customerId);
  if (customer) {
    await sendRefundDeniedEmail(customer.email, {
      reason: input.denialReason,
      appointmentId: refund.appointmentId.toString(),
      refundId: refund._id.toString(),
    });
  }

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'refund_denied',
    refundId: refund._id.toString(),
    appointmentId: refund.appointmentId.toString(),
  });

  return refund;
}

// ── Customer: List own refund requests ──

export async function listMyRefundRequests(customerId: string) {
  const rows = await RefundRequest.find({ customerId })
    .populate('appointmentId', 'date slotCode type ocularFee formattedAddress')
    .populate('reviewedBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .lean();

  return rows.map((row) => ({
    ...row,
    timeline: [
      {
        key: 'requested',
        label: 'Request submitted',
        at: row.createdAt,
      },
      ...(row.status !== RefundRequestStatus.PENDING
        ? [{
            key: row.status,
            label:
              row.status === RefundRequestStatus.APPROVED
                ? 'Refund approved'
                : row.status === RefundRequestStatus.DENIED
                  ? 'Refund denied'
                  : 'Refund cancelled',
            at: row.reviewedAt ?? row.cancelledAt ?? row.updatedAt,
            note: row.denialReason ?? row.cancelledReason,
          }]
        : []),
      ...((row.dispatchTrail || []).map((event: any, idx: number) => ({
        key: `${event.event}-${idx}`,
        label: event.event.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        at: event.at,
        note: event.note,
      }))),
    ],
  }));
}

export async function updateMyRefundRequest(
  refundId: string,
  input: UpdateMyRefundRequestInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (refund.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only update your own refund request');
  }

  if (refund.status !== RefundRequestStatus.PENDING) {
    throw AppError.badRequest(
      'Only pending refund requests can be edited',
      ErrorCode.REFUND_NOT_PENDING,
      { helpPath: '/help/payments-refunds/refunds#checklist' },
    );
  }

  refund.reason = input.reason;
  refund.refundMethod = input.refundMethod;
  refund.accountName = input.accountName;
  refund.accountNumber = input.accountNumber;
  refund.bankName = input.refundMethod === 'bank_transfer' ? input.bankName : undefined;
  appendRefundTrailEvent(refund, {
    event: 'updated',
    actorId: customerId,
    note: 'Customer updated refund destination details',
    amount: refund.amount,
  });
  await refund.save();

  await AuditLog.create({
    action: AuditAction.REFUND_UPDATED,
    actorId: customerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      refundMethod: refund.refundMethod,
      accountName: refund.accountName,
      accountNumber: refund.accountNumber,
      bankName: refund.bankName,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Refund Request Updated',
    `A customer updated refund request details for ${formatCurrency(refund.amount)}.`,
    `/refund-requests/${refund._id}`,
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'refund_updated',
    refundId: refund._id.toString(),
    appointmentId: refund.appointmentId.toString(),
  });

  return refund;
}

export async function cancelMyRefundRequest(
  refundId: string,
  input: CancelMyRefundRequestInput,
  customerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (refund.customerId.toString() !== customerId) {
    throw AppError.forbidden('You can only cancel your own refund request');
  }

  if (refund.status !== RefundRequestStatus.PENDING) {
    throw AppError.badRequest(
      'Only pending refund requests can be cancelled',
      ErrorCode.REFUND_NOT_PENDING,
      { helpPath: '/help/payments-refunds/refunds#checklist' },
    );
  }

  refund.status = RefundRequestStatus.CANCELLED;
  refund.cancelledAt = new Date();
  refund.cancelledReason = input.reason?.trim() || undefined;
  appendRefundTrailEvent(refund, {
    event: 'cancelled',
    actorId: customerId,
    note: refund.cancelledReason,
    amount: refund.amount,
  });
  await refund.save();

  await AuditLog.create({
    action: AuditAction.REFUND_CANCELLED,
    actorId: customerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      reason: refund.cancelledReason,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  await notifyRole(
    Role.CASHIER,
    NotificationCategory.PAYMENT,
    'Refund Request Cancelled',
    `A customer cancelled a pending refund request for ${formatCurrency(refund.amount)}.`,
    `/refund-requests/${refund._id}`,
  );

  emitRoleEvent(Role.CASHIER, 'payments:queue-updated', {
    type: 'refund_cancelled',
    refundId: refund._id.toString(),
    appointmentId: refund.appointmentId.toString(),
  });

  return refund;
}

export async function dispatchRefundRequest(
  refundId: string,
  input: DispatchRefundRequestInput,
  reviewerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (refund.status !== RefundRequestStatus.APPROVED) {
    throw AppError.badRequest('Only approved refund requests can be dispatched', ErrorCode.REFUND_NOT_ALLOWED);
  }

  refund.dispatchedAt = new Date();
  refund.dispatchedBy = reviewerId as unknown as Types.ObjectId;
  refund.dispatchReferenceNumber = input.referenceNumber;
  refund.dispatchNote = input.note;
  appendRefundTrailEvent(refund, {
    event: 'dispatched',
    actorId: reviewerId,
    note: input.note,
    referenceNumber: input.referenceNumber,
    amount: input.amount ?? refund.amount,
  });
  await refund.save();

  await AuditLog.create({
    action: AuditAction.REFUND_DISPATCHED,
    actorId: reviewerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      referenceNumber: input.referenceNumber,
      amount: input.amount ?? refund.amount,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  const customer = await User.findById(refund.customerId);
  if (customer) {
    await sendRefundDispatchedEmail(customer.email, {
      amount: formatCurrency(input.amount ?? refund.amount),
      referenceNumber: input.referenceNumber,
      appointmentId: refund.appointmentId.toString(),
      refundId: refund._id.toString(),
    });
  }

  return refund;
}

export async function reconcileRefundRequest(
  refundId: string,
  input: ReconcileRefundRequestInput,
  reviewerId: string,
  ip?: string,
  ua?: string,
) {
  const refund = await RefundRequest.findById(refundId);
  if (!refund) throw AppError.notFound('Refund request not found');

  if (!refund.dispatchedAt) {
    throw AppError.badRequest('Refund must be dispatched before reconciliation', ErrorCode.REFUND_NOT_ALLOWED);
  }

  refund.reconciledAt = new Date();
  refund.reconciledBy = reviewerId as unknown as Types.ObjectId;
  refund.reconciliationNote = input.note;
  appendRefundTrailEvent(refund, {
    event: 'reconciled',
    actorId: reviewerId,
    note: input.note,
    referenceNumber: refund.dispatchReferenceNumber,
    amount: input.amount ?? refund.amount,
  });
  await refund.save();

  await AuditLog.create({
    action: AuditAction.REFUND_RECONCILED,
    actorId: reviewerId,
    targetType: 'refund_request',
    targetId: refund._id,
    details: {
      referenceNumber: refund.dispatchReferenceNumber,
      amount: input.amount ?? refund.amount,
      note: input.note,
    },
    ipAddress: ip,
    userAgent: ua,
  });

  const customer = await User.findById(refund.customerId);
  if (customer) {
    await sendRefundReconciledEmail(customer.email, {
      appointmentId: refund.appointmentId.toString(),
      refundId: refund._id.toString(),
    });
  }

  return refund;
}
