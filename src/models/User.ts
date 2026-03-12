import mongoose, { Schema, Document, Types } from 'mongoose';
import { Role } from '../utils/constants.js';

export interface IUserAddress {
  street?: string;
  barangay?: string;
  city?: string;
  province?: string;
  zip?: string;
  country?: string;
  lat?: number;
  lng?: number;
  formattedAddress?: string;
}

export interface IUser extends Document {
  _id: Types.ObjectId;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  phone: string;
  address?: string;          // Legacy plain-text address (kept for backwards compat)
  addressData?: IUserAddress; // Structured address with map pin
  roles: Role[];
  isEmailVerified: boolean;
  isActive: boolean;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
  twoFactorEnabled: boolean;
  twoFactorMethod: 'email';
  expiresAt?: Date; // For temporary outsourced accounts
  notificationPreferences: {
    appointment: boolean;
    payment: boolean;
    blueprint: boolean;
    fabrication: boolean;
    project: boolean;
  };
  themePreference: 'light' | 'dark' | 'system';
  signatureKey?: string; // R2 key for e-signature PNG
  provider: 'local' | 'google';
  firebaseUid?: string;
  photoURL?: string;
  deletedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    address: { type: String, trim: true },
    addressData: {
      type: new Schema(
        {
          street: { type: String, trim: true },
          barangay: { type: String, trim: true },
          city: { type: String, trim: true },
          province: { type: String, trim: true },
          zip: { type: String, trim: true },
          country: { type: String, trim: true, default: 'Philippines' },
          lat: { type: Number },
          lng: { type: Number },
          formattedAddress: { type: String, trim: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    roles: {
      type: [{ type: String, enum: Object.values(Role) }],
      required: true,
      default: [Role.CUSTOMER],
    },
    isEmailVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    mustChangePassword: { type: Boolean, default: false },
    isSuperAdmin: { type: Boolean, default: false },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorMethod: { type: String, enum: ['email'], default: 'email' },
    expiresAt: { type: Date },
    notificationPreferences: {
      appointment: { type: Boolean, default: true },
      payment: { type: Boolean, default: true },
      blueprint: { type: Boolean, default: true },
      fabrication: { type: Boolean, default: true },
      project: { type: Boolean, default: true },
    },
    themePreference: { type: String, enum: ['light', 'dark', 'system'], default: 'light' },
    signatureKey: { type: String },
    provider: { type: String, enum: ['local', 'google'], default: 'local' },
    firebaseUid: { type: String, unique: true, sparse: true },
    photoURL: { type: String },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Indexes
userSchema.index({ roles: 1 });
userSchema.index({ isActive: 1 });
userSchema.index({ expiresAt: 1 }, { sparse: true });

// Exclude soft-deleted by default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const excludeDeletedMiddleware = function (this: any, next?: any) {
  const query = this.getFilter();
  if (query.deletedAt === undefined) {
    this.where({ deletedAt: null });
  }
  if (typeof next === 'function') {
    next();
  }
};
(userSchema as any).pre('find', excludeDeletedMiddleware);
(userSchema as any).pre('findOne', excludeDeletedMiddleware);
(userSchema as any).pre('countDocuments', excludeDeletedMiddleware);
(userSchema as any).pre('findOneAndUpdate', excludeDeletedMiddleware);

export const User = mongoose.model<IUser>('User', userSchema);
