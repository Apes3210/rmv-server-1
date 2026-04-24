import mongoose, { Schema, Document, Types } from 'mongoose';
import { BlueprintStatus } from '../utils/constants.js';

export interface IBlueprint extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  projectItemId?: Types.ObjectId;
  version: number;
  status: BlueprintStatus;
  blueprintKey: string;  // R2 key for technical blueprint (fabricators)
  designKey: string;     // R2 key for design/rendering (customer-facing)
  costingKey: string;    // R2 key for costing PDF
  blueprintApproved: boolean;
  costingApproved: boolean;
  uploadedBy: Types.ObjectId; // Engineer
  revisionNotes?: string; // Customer's revision request notes
  revisionRefKeys: string[]; // Customer's reference file attachments
  // Quotation / costing breakdown
  quotation?: {
    materials: number;
    labor: number;
    fees: number;
    total: number;
    lineItems?: {
      label: string;
      quantity: number;
      materials: number;
      labor: number;
      amount: number;
    }[];
    validityDays?: number;
    breakdown?: string;
    estimatedDuration?: string;
    engineerNotes?: string;
    paymentMilestones?: { label: string; description: string }[];
  };
  createdAt: Date;
  updatedAt: Date;
}

const blueprintSchema = new Schema<IBlueprint>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },
    version: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: Object.values(BlueprintStatus),
      default: BlueprintStatus.UPLOADED,
    },
    blueprintKey: { type: String, required: true },
    designKey: { type: String, default: '' },
    costingKey: { type: String, required: true },
    blueprintApproved: { type: Boolean, default: false },
    costingApproved: { type: Boolean, default: false },
    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    revisionNotes: { type: String },
    revisionRefKeys: [{ type: String }],
    quotation: {
      materials: Number,
      labor: Number,
      fees: Number,
      total: Number,
      lineItems: [{
        label: { type: String, required: true },
        quantity: { type: Number, required: true, min: 1 },
        materials: { type: Number, required: true, min: 0 },
        labor: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 },
      }],
      validityDays: { type: Number, default: 30 },
      breakdown: String,
      estimatedDuration: String,
      engineerNotes: String,
      paymentMilestones: [{
        label: { type: String, required: true },
        description: { type: String, required: true },
      }],
    },
  },
  { timestamps: true },
);

// Unique version per project item. Legacy project-level blueprints keep projectItemId empty.
blueprintSchema.index({ projectId: 1, projectItemId: 1, version: 1 }, { unique: true });
blueprintSchema.index({ projectId: 1 });
blueprintSchema.index({ projectItemId: 1 });

export const Blueprint = mongoose.model<IBlueprint>('Blueprint', blueprintSchema);
