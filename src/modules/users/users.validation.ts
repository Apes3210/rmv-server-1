import { z } from 'zod';
import { Role } from '../../utils/constants.js';

const phoneRegex = /^\+639\d{9}$/;

export const createUserSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  firstName: z.string().min(1).max(50).trim(),
  lastName: z.string().min(1).max(50).trim(),
  phone: z.union([
    z.string().regex(phoneRegex, 'Must be a valid PH mobile (+63 9XX)'),
    z.literal(''),
  ]).optional().transform(v => v === '' ? undefined : v),
  roles: z.array(z.nativeEnum(Role)).min(1),
  password: z.string().min(8),
  expiresAt: z.string().datetime().optional(), // ISO string for temp accounts
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).max(50).trim().optional(),
  lastName: z.string().min(1).max(50).trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  roles: z.array(z.nativeEnum(Role)).min(1).optional(),
  password: z.string().min(8).optional(),
  isActive: z.boolean().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

export const updateProfileSchema = z.object({
  firstName: z.string().min(1).max(50).trim().optional(),
  lastName: z.string().min(1).max(50).trim().optional(),
  phone: z.string().regex(phoneRegex).optional(),
  address: z.string().max(500).trim().optional(),
  addressData: z.object({
    street: z.string().max(200).trim().optional().or(z.literal('')),
    barangay: z.string().max(100).trim().optional().or(z.literal('')),
    city: z.string().max(100).trim().optional().or(z.literal('')),
    province: z.string().max(100).trim().optional().or(z.literal('')),
    zip: z.string().max(10).trim().optional().or(z.literal('')),
    country: z.string().max(50).trim().optional().or(z.literal('')),
    lat: z.number().optional(),
    lng: z.number().optional(),
    formattedAddress: z.string().max(500).trim().optional().or(z.literal('')),
  }).optional(),
  notificationPreferences: z.object({
    appointment: z.boolean().optional(),
    payment: z.boolean().optional(),
    blueprint: z.boolean().optional(),
    fabrication: z.boolean().optional(),
    project: z.boolean().optional(),
    emailNotifications: z.boolean().optional(),
  }).optional(),
  themePreference: z.enum(['light', 'dark', 'system']).optional(),
});

export const salesAvailabilitySchema = z.object({
  salesStaffId: z.string().min(1),
  unavailableDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
});

export const deleteAccountSchema = z.object({
  password: z.string().optional(),
  confirmation: z.literal('DELETE', { message: 'Type DELETE to confirm' }),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type DeleteAccountInput = z.infer<typeof deleteAccountSchema>;
