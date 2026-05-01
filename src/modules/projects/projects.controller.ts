import type { Request, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as projectsService from './projects.service.js';

export const createProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.createProject(req.body, req.userId!, req.ip, req.get('user-agent'));
  res.status(201).json({ success: true, data: project });
});

export const updateProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.updateProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const assignEngineers = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignEngineers((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const reassignProjectSalesStaff = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.reassignProjectSalesStaff(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const assignFabricationStaff = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.assignFabricationStaff((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const transitionProject = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.transitionProject((req.params.id as string), req.body, req.userId!, req.ip, req.get('user-agent'));
  res.json({ success: true, data: project });
});

export const getProjectByVisitReportId = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.getProjectByVisitReportId(req.params.visitReportId as string);
  res.json({ success: true, data: project });
});

export const getProjectById = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.getProjectById((req.params.id as string), req.userId!, req.userRoles!);
  res.json({ success: true, data: project });
});

export const listProjects = asyncHandler(async (req: Request, res: Response) => {
  const result = await projectsService.listProjects(req.query as any, req.userId!, req.userRoles!);
  res.json({ success: true, data: result });
});

export const addMediaKeys = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.addMediaKeys((req.params.id as string), req.body.keys, req.userId!);
  res.json({ success: true, data: project });
});

export const removeMediaKey = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.removeMediaKey((req.params.id as string), req.body.key, req.userId!);
  res.json({ success: true, data: project });
});

export const generateContract = asyncHandler(async (req: Request, res: Response) => {
  const result = await projectsService.generateContract(
    req.params.id as string,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: { originalKey: result.originalKey, copyKey: result.copyKey } });
});

export const uploadSignedContract = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.uploadSignedContract(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const getContractDownloadUrl = asyncHandler(async (req: Request, res: Response) => {
  const copy = (req.query.copy as string) === 'copy' ? 'copy' : 'original';
  const result = await projectsService.getContractDownloadUrl(
    req.params.id as string,
    copy,
    req.userId!,
    req.userRoles!,
  );
  res.json({ success: true, data: result });
});

export const signContract = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.signContract(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const signEngineerContract = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.signEngineerContract(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const reviewInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.reviewInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const resubmitInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.resubmitInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const backfillInitialDesign = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.backfillInitialDesign(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const selectPaymentPlan = asyncHandler(async (req: Request, res: Response) => {
  const result = await projectsService.selectPaymentPlan(
    req.params.id as string,
    req.body,
    req.userId!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: result });
});

export const confirmInstallation = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.confirmInstallation(
    req.params.id as string,
    req.userId!,
    req.userRoles!,
    (req.body?.projectItemId || req.query.projectItemId) as string | undefined,
  );
  res.json({ success: true, data: project });
});

export const submitProjectReview = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.submitProjectReview(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});

export const skipProjectReview = asyncHandler(async (req: Request, res: Response) => {
  const project = await projectsService.skipProjectReview(
    req.params.id as string,
    req.body,
    req.userId!,
    req.userRoles!,
    req.ip,
    req.get('user-agent'),
  );
  res.json({ success: true, data: project });
});
