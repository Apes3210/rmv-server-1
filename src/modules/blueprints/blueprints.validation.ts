import { z } from 'zod';
import { BlueprintComponent } from '../../utils/constants.js';

const quotationSchema = z.object({
  materials: z.number().min(0),
  labor: z.number().min(0),
  fees: z.number().min(0),
  total: z.number().min(0),
  lineItems: z.array(z.object({
    label: z.string().min(1).max(200),
    quantity: z.number().min(1),
    materials: z.number().min(0),
    labor: z.number().min(0),
    amount: z.number().min(0),
  })).optional(),
  validityDays: z.number().min(1).max(365).optional(),
  breakdown: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(200).optional(),
  engineerNotes: z.string().max(3000).optional(),
  paymentMilestones: z.array(z.object({
    label: z.string().min(1).max(200),
    description: z.string().min(1).max(500),
  })).max(6).optional(),
});

export const uploadBlueprintSchema = z.object({
  projectId: z.string().min(1),
  blueprintKey: z.string().min(1),
  designKey: z.string().min(1),
  costingKey: z.string().min(1),
  quotation: quotationSchema.optional(),
});

export const revisionUploadSchema = z.object({
  blueprintKey: z.string().min(1),
  designKey: z.string().min(1),
  costingKey: z.string().min(1),
  quotation: quotationSchema.optional(),
});

export const approveBlueprintSchema = z.object({
  component: z.nativeEnum(BlueprintComponent),
});

export const requestRevisionSchema = z.object({
  notes: z.string().min(1).max(2000).trim(),
  refKeys: z.array(z.string()).max(5).default([]),
});

export const acceptBlueprintSchema = z.object({
  paymentType: z.enum(['full', 'installment']),
});

const draftFileSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(255),
  size: z.number().min(0),
  uploadedAt: z.coerce.date(),
});

const draftQuotationSchema = z.object({
  lineItems: z.array(z.object({
    label: z.string().max(200),
    quantity: z.number().min(1),
    materials: z.string().max(100),
    labor: z.string().max(100),
  })).max(100).optional(),
  fees: z.string().max(100).optional(),
  validityDays: z.string().max(10).optional(),
  breakdown: z.string().max(5000).optional(),
  estimatedDuration: z.string().max(200).optional(),
  engineerNotes: z.string().max(3000).optional(),
  paymentMilestones: z.array(z.object({
    label: z.string().max(200),
    description: z.string().max(500),
  })).max(6).optional(),
}).optional();

export const upsertBlueprintDraftSchema = z.object({
  mode: z.enum(['initial', 'revision']),
  sourceBlueprintId: z.string().min(1).optional(),
  files: z.object({
    blueprint: draftFileSchema.nullable().optional(),
    design: draftFileSchema.nullable().optional(),
    costing: draftFileSchema.nullable().optional(),
  }).optional(),
  quotation: draftQuotationSchema,
});

export type UploadBlueprintInput = z.infer<typeof uploadBlueprintSchema>;
export type RevisionUploadInput = z.infer<typeof revisionUploadSchema>;
export type ApproveBlueprintInput = z.infer<typeof approveBlueprintSchema>;
export type RequestRevisionInput = z.infer<typeof requestRevisionSchema>;
export type AcceptBlueprintInput = z.infer<typeof acceptBlueprintSchema>;
export type UpsertBlueprintDraftInput = z.infer<typeof upsertBlueprintDraftSchema>;
