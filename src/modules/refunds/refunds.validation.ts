import { z } from 'zod';

export const submitRefundRequestSchema = z.object({
  appointmentId: z.string().min(1),
  reason: z.string().min(1, 'Reason is required').max(1000).trim(),
  refundMethod: z.enum(['gcash', 'bank_transfer']),
  accountName: z.string().min(1, 'Account name is required').max(200).trim(),
  accountNumber: z.string().min(1, 'Account number is required').max(50).trim(),
  bankName: z.string().max(200).trim().optional(),
}).refine(
  (data) => data.refundMethod !== 'bank_transfer' || !!data.bankName?.trim(),
  { message: 'Bank name is required for bank transfer', path: ['bankName'] },
);

export const denyRefundRequestSchema = z.object({
  denialReason: z.string().min(1, 'Denial reason is required').max(1000).trim(),
});

export type SubmitRefundRequestInput = z.infer<typeof submitRefundRequestSchema>;
export type DenyRefundRequestInput = z.infer<typeof denyRefundRequestSchema>;
