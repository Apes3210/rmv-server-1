import mongoose, { Schema, Document, Types } from 'mongoose';
import { RefundRequestStatus } from '../utils/constants.js';

export interface IRefundRequest extends Document {
  _id: Types.ObjectId;
  appointmentId: Types.ObjectId;
  customerId: Types.ObjectId;
  reason: string;
  refundMethod: 'gcash' | 'bank_transfer';
  accountName: string;
  accountNumber: string;
  bankName?: string; // Required when refundMethod is bank_transfer
  amount: number; // The ocular fee amount to refund
  status: RefundRequestStatus;
  reviewedBy?: Types.ObjectId; // Cashier/Admin who approved/denied
  reviewedAt?: Date;
  denialReason?: string;
  dispatchedAt?: Date;
  dispatchedBy?: Types.ObjectId;
  dispatchReferenceNumber?: string;
  dispatchNote?: string;
  reconciledAt?: Date;
  reconciledBy?: Types.ObjectId;
  reconciliationNote?: string;
  dispatchTrail: Array<{
    event: 'submitted' | 'updated' | 'approved' | 'denied' | 'cancelled' | 'dispatched' | 'reconciled';
    at: Date;
    actorId?: Types.ObjectId;
    note?: string;
    referenceNumber?: string;
    amount?: number;
  }>;
  cancelledAt?: Date;
  cancelledReason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const refundTrailEventSchema = new Schema(
  {
    event: {
      type: String,
      enum: ['submitted', 'updated', 'approved', 'denied', 'cancelled', 'dispatched', 'reconciled'],
      required: true,
    },
    at: { type: Date, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    note: { type: String, maxlength: 1000 },
    referenceNumber: { type: String, maxlength: 120 },
    amount: { type: Number, min: 0 },
  },
  { _id: false },
);

const refundRequestSchema = new Schema<IRefundRequest>(
  {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, required: true, maxlength: 1000 },
    refundMethod: { type: String, enum: ['gcash', 'bank_transfer'], required: true },
    accountName: { type: String, required: true, trim: true, maxlength: 200 },
    accountNumber: { type: String, required: true, trim: true, maxlength: 50 },
    bankName: { type: String, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: Object.values(RefundRequestStatus),
      default: RefundRequestStatus.PENDING,
    },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    denialReason: { type: String, maxlength: 1000 },
    dispatchedAt: { type: Date },
    dispatchedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    dispatchReferenceNumber: { type: String, maxlength: 120 },
    dispatchNote: { type: String, maxlength: 1000 },
    reconciledAt: { type: Date },
    reconciledBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reconciliationNote: { type: String, maxlength: 1000 },
    dispatchTrail: { type: [refundTrailEventSchema], default: [] },
    cancelledAt: { type: Date },
    cancelledReason: { type: String, maxlength: 1000 },
  },
  { timestamps: true },
);

refundRequestSchema.index({ appointmentId: 1 });
refundRequestSchema.index({ customerId: 1 });
refundRequestSchema.index({ status: 1 });

export const RefundRequest = mongoose.model<IRefundRequest>('RefundRequest', refundRequestSchema);
