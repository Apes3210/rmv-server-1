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
  createdAt: Date;
  updatedAt: Date;
}

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
  },
  { timestamps: true },
);

refundRequestSchema.index({ appointmentId: 1 });
refundRequestSchema.index({ customerId: 1 });
refundRequestSchema.index({ status: 1 });

export const RefundRequest = mongoose.model<IRefundRequest>('RefundRequest', refundRequestSchema);
