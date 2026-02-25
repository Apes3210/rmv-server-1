import mongoose, { Schema, Document, Types } from 'mongoose';

export interface IRefreshToken extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  token: string;
  userAgent?: string;
  ipAddress?: string;
  clientHints?: {
    uaPlatformVersion?: string;
    uaBrands?: string;
    uaMobile?: string;
    uaPlatform?: string;
  };
  expiresAt: Date;
  createdAt: Date;
}

const refreshTokenSchema = new Schema<IRefreshToken>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    token: { type: String, required: true, unique: true },
    userAgent: { type: String },
    ipAddress: { type: String },
    clientHints: {
      type: new Schema(
        {
          uaPlatformVersion: String,
          uaBrands: String,
          uaMobile: String,
          uaPlatform: String,
        },
        { _id: false },
      ),
      default: undefined,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

refreshTokenSchema.index({ userId: 1 });
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RefreshToken = mongoose.model<IRefreshToken>('RefreshToken', refreshTokenSchema);
