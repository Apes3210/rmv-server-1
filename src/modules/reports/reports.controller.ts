import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as reportsService from './reports.service.js';

export const getDashboardSummary = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getDashboardSummary();
  res.json({ success: true, data });
});

export const getRevenueReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getRevenueReport(req.query as any);
  res.json({ success: true, data });
});

export const getPaymentStageReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getPaymentStageReport(req.query as any);
  res.json({ success: true, data });
});

export const getOutstandingReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getOutstandingReport();
  res.json({ success: true, data });
});

export const getProjectPipelineReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getProjectPipelineReport();
  res.json({ success: true, data });
});

export const getWorkloadReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getWorkloadReport();
  res.json({ success: true, data });
});

export const getConversionReport = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getConversionReport(req.query as any);
  res.json({ success: true, data });
});

export const getAuditLogs = asyncHandler(async (req: Request, res: Response) => {
  const data = await reportsService.getRecentAuditLogs({
    limit: req.query.limit ? Number(req.query.limit) : undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
  });
  res.json({ success: true, data });
});
