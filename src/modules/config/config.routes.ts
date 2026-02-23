import { Router } from 'express';
import * as ctrl from './config.controller.js';
import { authenticate } from '../../middleware/auth.js';
import { authorize } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { Role } from '../../utils/constants.js';
import { updateConfigSchema, createHolidaySchema, maintenanceToggleSchema, createBlockedSlotSchema, bulkBlockSlotsSchema, bulkUnblockSlotsSchema } from './config.validation.js';

const router = Router();

// All admin only
router.get('/configs', authenticate, authorize(Role.ADMIN), ctrl.listConfigs);
router.get('/configs/:key', authenticate, authorize(Role.ADMIN), ctrl.getConfig);
router.put('/configs/:key', authenticate, authorize(Role.ADMIN), validate(updateConfigSchema), ctrl.upsertConfig);

router.get('/holidays', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), ctrl.listHolidays);
router.post('/holidays', authenticate, authorize(Role.ADMIN), validate(createHolidaySchema), ctrl.createHoliday);
router.delete('/holidays/:id', authenticate, authorize(Role.ADMIN), ctrl.deleteHoliday);

router.post('/maintenance', authenticate, authorize(Role.ADMIN), validate(maintenanceToggleSchema), ctrl.toggleMaintenance);

router.get('/blocked-slots', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), ctrl.listBlockedSlots);
router.post('/blocked-slots/bulk', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(bulkBlockSlotsSchema), ctrl.bulkCreateBlockedSlots);
router.delete('/blocked-slots/bulk', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(bulkUnblockSlotsSchema), ctrl.bulkDeleteBlockedSlots);
router.post('/blocked-slots', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), validate(createBlockedSlotSchema), ctrl.createBlockedSlot);
router.delete('/blocked-slots/:id', authenticate, authorize(Role.ADMIN, Role.APPOINTMENT_AGENT), ctrl.deleteBlockedSlot);

export default router;
