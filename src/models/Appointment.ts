import mongoose, { Schema, Document, Types } from 'mongoose';
import { AppointmentStatus, AppointmentType, SlotCode, PaymentMethod, ServiceType, MeasurementUnit, Environment } from '../utils/constants.js';
import type { ILineItem, ISiteConditions } from './VisitReport.js';

// ── Customer Site Details (pre-visit info from customer) ──
export type SiteDetailsStatus = 'pending' | 'submitted' | 'skipped';

export interface ICustomerSiteDetails {
  serviceType?: string;
  serviceTypeCustom?: string;
  measurementUnit?: string;
  lineItems?: ILineItem[];
  siteConditions?: ISiteConditions;
  materials?: string;
  finishes?: string;
  preferredDesign?: string;
  customerRequirements?: string;
  notes?: string;
  photoKeys?: string[];
  videoKeys?: string[];
  sketchKeys?: string[];
  referenceImageKeys?: string[];
}

export interface IAppointment extends Document {
  _id: Types.ObjectId;
  customerId: Types.ObjectId;
  type: AppointmentType;
  date: string; // YYYY-MM-DD Asia/Manila
  slotCode: SlotCode;
  status: AppointmentStatus;

  // Ocular-specific
  salesStaffId?: Types.ObjectId;
  latitude?: number;
  longitude?: number;
  formattedAddress?: string;
  customerAddress?: string;
  customerLocation?: {
    lat: number;
    lng: number;
  };
  distanceKm?: number;
  ocularFee?: number;
  ocularFeeBreakdown?: {
    label: string;
    baseFee: number;
    baseCoveredKm: number;
    perKmRate: number;
    additionalDistanceKm: number;
    additionalFee: number;
    total: number;
    isWithinNCR: boolean;
  };
  ocularFeePaymentMethod?: PaymentMethod;
  ocularFeePaid?: boolean;
  ocularFeeProofKey?: string;
  ocularFeeReferenceNumber?: string;
  ocularFeeStatus?: 'pending' | 'proof_submitted' | 'verified' | 'declined';
  ocularFeeDeclineReason?: string;
  ocularFeeVerifiedBy?: Types.ObjectId;
  paymongoCheckoutSessionId?: string;
  paymongoCheckoutUrl?: string;

  // Notes
  customerNotes?: string;
  internalNotes?: string;

  // Cancellation
  cancellationReason?: string;
  cancelledBy?: Types.ObjectId;

  // Rescheduling
  rescheduleCount: number;
  maxReschedules: number;
  rescheduleReason?: string;

  // Customer-provided site details (for office appointments, mandatory before confirmation)
  customerSiteDetails?: ICustomerSiteDetails;
  siteDetailsStatus: SiteDetailsStatus;

  // Booking metadata
  bookedBy: Types.ObjectId; // Customer or Agent who created
  confirmedBy?: Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new Schema<IAppointment>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(AppointmentType), required: true },
    date: { type: String, required: true }, // YYYY-MM-DD
    slotCode: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(AppointmentStatus),
      default: AppointmentStatus.REQUESTED,
    },

    salesStaffId: { type: Schema.Types.ObjectId, ref: 'User' },
    latitude: { type: Number },
    longitude: { type: Number },
    formattedAddress: { type: String },
    customerAddress: { type: String },
    customerLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    distanceKm: { type: Number },
    ocularFee: { type: Number },
    ocularFeeBreakdown: {
      label: String,
      baseFee: Number,
      baseCoveredKm: Number,
      perKmRate: Number,
      additionalDistanceKm: Number,
      additionalFee: Number,
      total: Number,
      isWithinNCR: Boolean,
    },
    ocularFeePaymentMethod: { type: String, enum: Object.values(PaymentMethod) },
    ocularFeePaid: { type: Boolean, default: false },
    ocularFeeProofKey: { type: String },
    ocularFeeReferenceNumber: { type: String },
    ocularFeeStatus: { type: String, enum: ['pending', 'proof_submitted', 'verified', 'declined'], default: 'pending' },
    ocularFeeDeclineReason: { type: String },
    ocularFeeVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paymongoCheckoutSessionId: { type: String },
    paymongoCheckoutUrl: { type: String },

    customerNotes: { type: String },
    internalNotes: { type: String },

    cancellationReason: { type: String },
    cancelledBy: { type: Schema.Types.ObjectId, ref: 'User' },

    rescheduleCount: { type: Number, default: 0 },
    maxReschedules: { type: Number, default: 3 },
    rescheduleReason: { type: String },

    // Customer-provided site details
    customerSiteDetails: {
      serviceType: { type: String, enum: [...Object.values(ServiceType)] },
      serviceTypeCustom: { type: String, trim: true },
      measurementUnit: { type: String, enum: Object.values(MeasurementUnit) },
      lineItems: [{
        label: { type: String, trim: true },
        length: { type: Number },
        width: { type: Number },
        height: { type: Number },
        area: { type: Number },
        thickness: { type: Number },
        quantity: { type: Number, default: 1, min: 1 },
        notes: { type: String },
        _id: false,
      }],
      siteConditions: {
        environment: { type: String, enum: Object.values(Environment) },
        floorType: { type: String },
        wallMaterial: { type: String },
        hasElectrical: { type: Boolean },
        hasPlumbing: { type: Boolean },
        accessNotes: { type: String },
        obstaclesOrConstraints: { type: String },
        _id: false,
      },
      materials: { type: String },
      finishes: { type: String },
      preferredDesign: { type: String },
      customerRequirements: { type: String },
      notes: { type: String },
      photoKeys: [{ type: String }],
      videoKeys: [{ type: String }],
      sketchKeys: [{ type: String }],
      referenceImageKeys: [{ type: String }],
      _id: false,
    },
    siteDetailsStatus: {
      type: String,
      enum: ['pending', 'submitted', 'skipped'],
      default: 'pending',
    },

    bookedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

appointmentSchema.index({ customerId: 1, status: 1 });
appointmentSchema.index({ salesStaffId: 1, date: 1 });
appointmentSchema.index({ date: 1, slotCode: 1 });
appointmentSchema.index({ status: 1 });

export const Appointment = mongoose.model<IAppointment>('Appointment', appointmentSchema);
