import { Appointment, RefundRequest, AuditLog } from '../../models/index.js';
import { AppError } from '../../utils/appError.js';
import {
  AppointmentStatus, AuditAction, NotificationCategory, RefundRequestStatus, Role,
} from '../../utils/constants.js';
import { createAndSendNotification, notifyRole } from '../notifications/socket.service.js';
import { formatCurrency } from '../../utils/helpers.js';
import type { SubmitRefundRequestInput, DenyRefundRequestInput } from './refunds.validation.js';
import type { Types } from 'mongoose';

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
    throw AppError.badRequest('Only verified (paid) ocular fees can be refunded');
  }

  // Block if appointment is on_the_way or completed — customer should contact admin
  if ([AppointmentStatus.ON_THE_WAY, AppointmentStatus.COMPLETED].includes(appointment.status as AppointmentStatus)) {
    throw AppError.badRequest(
      'Refund requests are not available once the visit is on the way or completed. Please contact the admin directly.',
    );
  }

  // Check no existing pending refund for this appointment
  const existingPending = await RefundRequest.findOne({
    appointmentId: input.appointmentId,
    status: RefundRequestStatus.PENDING,
  });
  if (existingPending) {
    throw AppError.conflict('You already have a pending refund request for this appointment');
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

  return refundRequest;
}

// ── Cashier/Admin: List Refund Requests ──

export async function listRefundRequests(query: { status?: string; page?: string; limit?: string }) {
  const filter: Record<string, unknown> = {};
  if (query.status) filter.status = query.status;

  const page = Math.max(1, parseInt(query.page || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(query.limit || '20')));
  const skip = (page - 1) * limit;

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

  return refund;
}

// ── Customer: List own refund requests ──

export async function listMyRefundRequests(customerId: string) {
  return RefundRequest.find({ customerId })
    .populate('appointmentId', 'date slotCode type ocularFee formattedAddress')
    .populate('reviewedBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .lean();
}
