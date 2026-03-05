import { z } from 'zod';
import { ServiceType, MeasurementUnit, Environment } from '../../utils/constants.js';

// ── Line Item ──
const lineItemSchema = z.object({
  label: z.string().min(1).max(200).trim(),
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  area: z.number().positive().optional(),
  thickness: z.number().positive().optional(),
  quantity: z.number().int().min(1).default(1),
  notes: z.string().max(500).trim().optional(),
});

// ── Site Conditions ──
const siteConditionsSchema = z.object({
  environment: z.nativeEnum(Environment).default(Environment.INDOOR),
  floorType: z.string().max(200).trim().optional(),
  wallMaterial: z.string().max(200).trim().optional(),
  hasElectrical: z.boolean().optional(),
  hasPlumbing: z.boolean().optional(),
  accessNotes: z.string().max(1000).trim().optional(),
  obstaclesOrConstraints: z.string().max(1000).trim().optional(),
});

// ── Legacy flat measurements (backward compat) ──
const legacyMeasurementsSchema = z.object({
  length: z.number().positive().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  area: z.number().positive().optional(),
  thickness: z.number().positive().optional(),
  unit: z.string().default('cm'),
  raw: z.string().max(2000).optional(),
});

// ── Create (new report for an existing appointment) ──
export const createVisitReportSchema = z.object({
  appointmentId: z.string().min(1),
  serviceType: z.nativeEnum(ServiceType),
  serviceTypeCustom: z.string().max(200).trim().optional(),
  visitType: z.enum(['ocular', 'consultation']).optional(),
});

// ── Update ──
export const updateVisitReportSchema = z.object({
  visitType: z.enum(['ocular', 'consultation']).optional(),
  actualVisitDateTime: z.string().datetime().optional(),

  serviceType: z.nativeEnum(ServiceType).optional(),
  serviceTypeCustom: z.string().max(200).trim().optional(),

  measurementUnit: z.nativeEnum(MeasurementUnit).optional(),
  lineItems: z.array(lineItemSchema).max(50).optional(),

  // Legacy flat measurements (backward compat)
  measurements: legacyMeasurementsSchema.optional(),

  siteConditions: siteConditionsSchema.optional(),

  materials: z.string().max(1000).trim().optional(),
  finishes: z.string().max(500).trim().optional(),
  preferredDesign: z.string().max(1000).trim().optional(),
  customerRequirements: z.string().max(2000).trim().optional(),
  notes: z.string().max(3000).trim().optional(),
  photoKeys: z.array(z.string()).max(20).optional(),
  videoKeys: z.array(z.string()).max(5).optional(),
  sketchKeys: z.array(z.string()).max(10).optional(),
  referenceImageKeys: z.array(z.string()).max(10).optional(),

  // Consultation-specific fields
  productsDiscussed: z.string().max(2000).trim().optional(),
  designPreferences: z.string().max(2000).trim().optional(),
  materialOptions: z.string().max(2000).trim().optional(),
  projectScope: z.string().max(2000).trim().optional(),
  recommendedOcularDate: z.string().datetime().optional(),
  recommendedOcularSlot: z.string().max(20).trim().optional(),
  linkedProjectId: z.string().optional(),
});

export const returnVisitReportSchema = z.object({
  reason: z.string().min(1).max(1000).trim(),
});

export type CreateVisitReportInput = z.infer<typeof createVisitReportSchema>;
export type UpdateVisitReportInput = z.infer<typeof updateVisitReportSchema>;
export type ReturnVisitReportInput = z.infer<typeof returnVisitReportSchema>;
