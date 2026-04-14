import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IBlueprintDraftFile {
  key: string;
  name: string;
  type: string;
  size: number;
  uploadedAt: Date;
}

export interface IBlueprintDraftQuotationLineItem {
  label: string;
  quantity: number;
  materials: string;
  labor: string;
}

export interface IBlueprintDraftQuotationMilestone {
  label: string;
  description: string;
}

export interface IBlueprintDraft extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  mode: 'initial' | 'revision';
  sourceBlueprintId?: Types.ObjectId;
  files: {
    blueprint?: IBlueprintDraftFile | null;
    design?: IBlueprintDraftFile | null;
    costing?: IBlueprintDraftFile | null;
  };
  quotation?: {
    lineItems?: IBlueprintDraftQuotationLineItem[];
    fees?: string;
    validityDays?: string;
    breakdown?: string;
    estimatedDuration?: string;
    engineerNotes?: string;
    paymentMilestones?: IBlueprintDraftQuotationMilestone[];
  };
  createdBy: Types.ObjectId;
  lastEditedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const blueprintDraftFileSchema = new Schema<IBlueprintDraftFile>(
  {
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, trim: true },
    size: { type: Number, required: true, min: 0 },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const blueprintDraftLineItemSchema = new Schema<IBlueprintDraftQuotationLineItem>(
  {
    label: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 1 },
    materials: { type: String, default: '' },
    labor: { type: String, default: '' },
  },
  { _id: false },
);

const blueprintDraftMilestoneSchema = new Schema<IBlueprintDraftQuotationMilestone>(
  {
    label: { type: String, default: '' },
    description: { type: String, default: '' },
  },
  { _id: false },
);

const blueprintDraftSchema = new Schema<IBlueprintDraft>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, unique: true },
    mode: {
      type: String,
      enum: ['initial', 'revision'],
      required: true,
    },
    sourceBlueprintId: { type: Schema.Types.ObjectId, ref: 'Blueprint' },
    files: {
      blueprint: { type: blueprintDraftFileSchema, default: null },
      design: { type: blueprintDraftFileSchema, default: null },
      costing: { type: blueprintDraftFileSchema, default: null },
    },
    quotation: {
      lineItems: { type: [blueprintDraftLineItemSchema], default: undefined },
      fees: { type: String, default: '' },
      validityDays: { type: String, default: '30' },
      breakdown: { type: String, default: '' },
      estimatedDuration: { type: String, default: '' },
      engineerNotes: { type: String, default: '' },
      paymentMilestones: { type: [blueprintDraftMilestoneSchema], default: undefined },
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    lastEditedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

blueprintDraftSchema.index({ projectId: 1 }, { unique: true });
blueprintDraftSchema.index({ sourceBlueprintId: 1 });

export const BlueprintDraft = mongoose.model<IBlueprintDraft>('BlueprintDraft', blueprintDraftSchema);
