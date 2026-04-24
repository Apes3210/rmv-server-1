import { z } from 'zod';
import { FabricationStatus } from '../../utils/constants.js';

export const createFabricationUpdateSchema = z.object({
  projectId: z.string().min(1),
  projectItemId: z.string().min(1).optional(),
  status: z.nativeEnum(FabricationStatus),
  notes: z.string().min(1).max(2000).trim(),
  photoKeys: z.array(z.string().min(1)).max(10).optional(),
});

export const updateFabricationUpdateSchema = z.object({
  notes: z.string().min(1).max(2000).trim().optional(),
  photoKeys: z.array(z.string().min(1)).max(10).optional(),
}).refine((d) => d.notes !== undefined || d.photoKeys !== undefined, {
  message: 'At least one field (notes or photoKeys) must be provided',
});

export type CreateFabricationUpdateInput = z.infer<typeof createFabricationUpdateSchema>;
export type UpdateFabricationUpdateInput = z.infer<typeof updateFabricationUpdateSchema>;
