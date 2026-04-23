import mongoose, { Schema, Document, Types } from 'mongoose';
import { StaffAvailabilityStatus } from '../utils/constants.js';

export interface IAvailabilitySession extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  availabilityStatus: StaffAvailabilityStatus;
  availabilityNote?: string;
  shiftStartAt?: Date;
  shiftEndAt?: Date;
  closedAt?: Date;
  reminderSentAt?: Date;
  createdBy: Types.ObjectId;
  updatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const availabilitySessionSchema = new Schema<IAvailabilitySession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    availabilityStatus: {
      type: String,
      enum: Object.values(StaffAvailabilityStatus),
      required: true,
    },
    availabilityNote: { type: String, trim: true, maxlength: 240 },
    shiftStartAt: { type: Date },
    shiftEndAt: { type: Date },
    closedAt: { type: Date },
    reminderSentAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

availabilitySessionSchema.index(
  { userId: 1 },
  {
    unique: true,
    partialFilterExpression: { closedAt: { $exists: false } },
  },
);
availabilitySessionSchema.index({ userId: 1, updatedAt: -1 });
availabilitySessionSchema.index({ closedAt: 1, shiftEndAt: 1, reminderSentAt: 1 });

export const AvailabilitySession = mongoose.model<IAvailabilitySession>(
  'AvailabilitySession',
  availabilitySessionSchema,
);
