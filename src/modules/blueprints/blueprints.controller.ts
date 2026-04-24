import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as blueprintsService from './blueprints.service.js';

export const uploadBlueprint = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.uploadBlueprint(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: blueprint });
});

export const uploadRevision = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.uploadRevision((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: blueprint });
});

export const approveComponent = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.approveComponent((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: blueprint });
});

export const requestRevision = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.requestRevision((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: blueprint });
});

export const getBlueprintById = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.getBlueprintById(
    (req.params.id as string),
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: blueprint });
});

export const listBlueprintsByProject = asyncHandler(async (req: Request, res: Response) => {
  const blueprints = await blueprintsService.listBlueprintsByProject(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
    req.query.projectItemId as string | undefined,
  );
  res.json({ success: true, data: blueprints });
});

export const getLatestBlueprint = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.getLatestBlueprint(
    (req.params.projectId as string),
    req.userId!,
    req.userRoles!,
    req.query.projectItemId as string | undefined,
  );
  res.json({ success: true, data: blueprint });
});

export const getBlueprintDraft = asyncHandler(async (req: Request, res: Response) => {
  const draft = await blueprintsService.getBlueprintDraft(
    (req.params.projectId as string),
    req.userId!,
    req.query.projectItemId as string | undefined,
  );
  res.json({ success: true, data: draft });
});

export const upsertBlueprintDraft = asyncHandler(async (req: Request, res: Response) => {
  const draft = await blueprintsService.upsertBlueprintDraft(
    (req.params.projectId as string),
    req.body,
    req.userId!,
  );
  res.json({ success: true, data: draft });
});

export const finalizeBlueprintDraft = asyncHandler(async (req: Request, res: Response) => {
  const blueprint = await blueprintsService.finalizeBlueprintDraft(
    (req.params.projectId as string),
    req.userId!,
    req.ip,
    req.get('user-agent'),
    req.query.projectItemId as string | undefined,
  );
  res.status(201).json({ success: true, data: blueprint });
});

export const deleteBlueprintDraft = asyncHandler(async (req: Request, res: Response) => {
  await blueprintsService.deleteBlueprintDraft(
    (req.params.projectId as string),
    req.userId!,
    req.query.projectItemId as string | undefined,
  );
  res.status(204).send();
});

export const acceptBlueprint = asyncHandler(async (req: Request, res: Response) => {
  const result = await blueprintsService.acceptBlueprint(
    (req.params.id as string),
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});
