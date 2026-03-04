import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as refundService from './refunds.service.js';

export const submitRefundRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await refundService.submitRefundRequest(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: result });
});

export const listRefundRequests = asyncHandler(async (req: Request, res: Response) => {
  const result = await refundService.listRefundRequests(req.query as Record<string, string>);
  res.json({ success: true, data: result });
});

export const approveRefundRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await refundService.approveRefundRequest(req.params.id as string, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});

export const denyRefundRequest = asyncHandler(async (req: Request, res: Response) => {
  const result = await refundService.denyRefundRequest(req.params.id as string, req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});

export const listMyRefundRequests = asyncHandler(async (req: Request, res: Response) => {
  const result = await refundService.listMyRefundRequests(req.userId!);
  res.json({ success: true, data: result });
});
