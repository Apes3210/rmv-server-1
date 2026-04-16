import { z } from 'zod';

export const updateConfigSchema = z.object({
  value: z.unknown(),
  description: z.string().max(200).trim().optional(),
});

export const createHolidaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  name: z.string().min(1).max(100).trim(),
});

export const maintenanceToggleSchema = z.object({
  enabled: z.boolean(),
});

export const previewConfigImpactSchema = z.object({
  value: z.unknown(),
});

export const rollbackConfigVersionSchema = z.object({
  versionId: z.string().min(1),
});

export const createBlockedSlotSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slotCode: z.enum(['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']),
  type: z.enum(['office', 'ocular']),
  reason: z.string().max(200).trim().optional(),
});

export const bulkBlockSlotsSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slots: z
    .array(
      z.object({
        slotCode: z.enum(['09:00', '10:00', '11:00', '13:00', '14:00', '15:00', '16:00']),
        type: z.enum(['office', 'ocular']),
      }),
    )
    .min(1)
    .max(14),
  reason: z.string().max(200).trim().optional(),
});

export const bulkUnblockSlotsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(14),
});

export const scheduleMaintenanceSchema = z.object({
  scheduledAt: z.string().datetime(),
  reason: z.string().max(500).trim().optional(),
});

export type UpdateConfigInput = z.infer<typeof updateConfigSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type CreateBlockedSlotInput = z.infer<typeof createBlockedSlotSchema>;
export type BulkBlockSlotsInput = z.infer<typeof bulkBlockSlotsSchema>;
export type BulkUnblockSlotsInput = z.infer<typeof bulkUnblockSlotsSchema>;
export type PreviewConfigImpactInput = z.infer<typeof previewConfigImpactSchema>;
export type RollbackConfigVersionInput = z.infer<typeof rollbackConfigVersionSchema>;
export type ScheduleMaintenanceInput = z.infer<typeof scheduleMaintenanceSchema>;

