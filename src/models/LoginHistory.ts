import mongoose, { Schema, Document, Types } from 'mongoose';

export interface ILoginHistory extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  ipAddress: string;
  userAgent: string;
  browser: string;
  os: string;
  device: string;
  location: string;
  status: 'success' | 'failed';
  failReason?: string;
  createdAt: Date;
}

const loginHistorySchema = new Schema<ILoginHistory>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    browser: { type: String, default: 'Unknown' },
    os: { type: String, default: 'Unknown' },
    device: { type: String, default: 'desktop' },
    location: { type: String, default: 'Unknown' },
    status: { type: String, enum: ['success', 'failed'], required: true },
    failReason: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

loginHistorySchema.index({ userId: 1, createdAt: -1 });

// Static method to record a login and cap at 20 per user
loginHistorySchema.statics.record = async function (
  data: Partial<ILoginHistory> & { userId: Types.ObjectId },
) {
  const doc = await this.create(data);

  // Keep only the most recent 20 entries per user
  const oldest = await this.find({ userId: data.userId })
    .sort({ createdAt: -1 })
    .skip(20)
    .select('_id')
    .lean();

  if (oldest.length > 0) {
    await this.deleteMany({ _id: { $in: oldest.map((d: { _id: Types.ObjectId }) => d._id) } });
  }

  return doc;
};

export const LoginHistory = mongoose.model<ILoginHistory>('LoginHistory', loginHistorySchema) as mongoose.Model<ILoginHistory> & {
  record: (data: Partial<ILoginHistory> & { userId: Types.ObjectId }) => Promise<ILoginHistory>;
};
