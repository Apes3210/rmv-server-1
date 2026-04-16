import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as configService from './config.service.js';

export const listConfigs = asyncHandler(async (req: Request, res: Response) => {
  const configs = await configService.listConfigs();
  res.json({ success: true, data: configs });
});

export const getConfig = asyncHandler(async (req: Request, res: Response) => {
  const config = await configService.getConfig((req.params.key as string));
  res.json({ success: true, data: config });
});

export const upsertConfig = asyncHandler(async (req: Request, res: Response) => {
  const config = await configService.upsertConfig((req.params.key as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: config });
});

export const previewConfigImpact = asyncHandler(async (req: Request, res: Response) => {
  const preview = await configService.previewConfigImpact(req.params.key as string, req.body.value);
  res.json({ success: true, data: preview });
});

export const listConfigVersions = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.listConfigVersions(
    req.params.key as string,
    req.query.limit ? Number(req.query.limit) : undefined,
  );
  res.json({ success: true, data: result });
});

export const rollbackConfigVersion = asyncHandler(async (req: Request, res: Response) => {
  const config = await configService.rollbackConfigVersion(
    req.params.key as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: config });
});

export const listHolidays = asyncHandler(async (req: Request, res: Response) => {
  const holidays = await configService.listHolidays(req.query.year as string);
  res.json({ success: true, data: holidays });
});

export const createHoliday = asyncHandler(async (req: Request, res: Response) => {
  const holiday = await configService.createHoliday(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: holiday });
});

export const deleteHoliday = asyncHandler(async (req: Request, res: Response) => {
  await configService.deleteHoliday((req.params.id as string), req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, message: 'Holiday deleted' });
});

export const toggleMaintenance = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.toggleMaintenance(req.body.enabled, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});

export const scheduleMaintenance = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.scheduleMaintenance(
    new Date(req.body.scheduledAt),
    req.body.reason,
    req.userId!,
    req.ip,
    req.get('user-agent')
  );
  res.json({ success: true, data: result });
});


export const listBlockedSlots = asyncHandler(async (req: Request, res: Response) => {
  const slots = await configService.listBlockedSlots(req.query.date as string);
  res.json({ success: true, data: slots });
});

export const createBlockedSlot = asyncHandler(async (req: Request, res: Response) => {
  const slot = await configService.createBlockedSlot(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: slot });
});

export const deleteBlockedSlot = asyncHandler(async (req: Request, res: Response) => {
  await configService.deleteBlockedSlot(req.params.id as string, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, message: 'Blocked slot removed' });
});

export const bulkCreateBlockedSlots = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.bulkCreateBlockedSlots(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: result });
});

export const bulkDeleteBlockedSlots = asyncHandler(async (req: Request, res: Response) => {
  const result = await configService.bulkDeleteBlockedSlots(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: result });
});
