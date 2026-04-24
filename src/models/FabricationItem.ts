import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IFabricationItem extends Document {
  _id: Types.ObjectId;
  projectId: Types.ObjectId;
  projectItemId?: Types.ObjectId;
  title: string;
  description?: string;
  quantity: number;
  isCompleted: boolean;
  completedAt?: Date;
  workerNotes?: string;
  photoKeys?: string[]; // Optional photos per item
  createdAt: Date;
  updatedAt: Date;
}

const fabricationItemSchema = new Schema<IFabricationItem>(
  {
    projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
    projectItemId: { type: Schema.Types.ObjectId, ref: 'ProjectItem' },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    quantity: { type: Number, required: true, default: 1, min: 1 },
    isCompleted: { type: Boolean, default: false },
    completedAt: { type: Date },
    workerNotes: { type: String, trim: true },
    photoKeys: [{ type: String }],
  },
  { timestamps: true }
);

fabricationItemSchema.index({ projectId: 1 });
fabricationItemSchema.index({ projectItemId: 1 });
fabricationItemSchema.index({ isCompleted: 1 });

export const FabricationItem = mongoose.model<IFabricationItem>('FabricationItem', fabricationItemSchema);
