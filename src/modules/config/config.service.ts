import { Config, Holiday, AuditLog, BlockedSlot } from '../../models/index.js';
import { AppError, ErrorCode } from '../../utils/appError.js';
import { AuditAction } from '../../utils/constants.js';
import type { UpdateConfigInput, CreateHolidayInput, CreateBlockedSlotInput, BulkBlockSlotsInput, BulkUnblockSlotsInput } from './config.validation.js';

const LEGACY_SHOP_COORDS = {
  lat: 14.6617,
  lng: 120.9567,
};

const MAPULANG_LUPA_SHOP_COORDS = {
  lat: 14.7020893,
  lng: 121.0000338,
};

const DAHLIA_EXT_PLUS_CODE_COORDS = {
  lat: 14.6995125,
  lng: 121.053703125,
};

export async function getConfig(key: string) {
  const config = await Config.findOne({ key });
  if (!config) throw AppError.notFound(`Config key "${key}" not found`);
  return config;
}

/** Get a config value with fallback (no throw). */
export async function getConfigValue<T = unknown>(key: string, fallback: T): Promise<T> {
  const config = await Config.findOne({ key });
  return config ? (config.value as T) : fallback;
}

/** Get all payment-related installment config in one call. */
export async function getInstallmentConfig() {
  const [surcharge, split, labels, descriptions] = await Promise.all([
    getConfigValue<number>('installment_surcharge_percent', 10),
    getConfigValue<number[]>('installment_split', [30, 40, 30]),
    getConfigValue<string[]>('installment_stage_labels', ['Down Payment', 'Mid-Project', 'Final Payment']),
    getConfigValue<string[]>('installment_stage_descriptions', ['Due upon contract signing', 'Due when fabrication is complete', 'Due after installation & acceptance']),
  ]);
  return { surchargePercent: surcharge, split, stageLabels: labels, stageDescriptions: descriptions };
}

export async function listConfigs() {
  return Config.find().sort({ key: 1 });
}

export async function upsertConfig(
  key: string,
  input: UpdateConfigInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const config = await Config.findOneAndUpdate(
    { key },
    {
      value: input.value,
      description: input.description,
      updatedBy: adminId,
    },
    { upsert: true, new: true },
  );

  await AuditLog.create({
    action: AuditAction.CONFIG_UPDATED,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: { key, value: input.value },
    ipAddress: ip,
    userAgent: ua,
  });

  return config;
}

export async function listHolidays(year?: string) {
  const filter: Record<string, unknown> = {};
  if (year) filter.date = { $regex: `^${year}` };

  return Holiday.find(filter).sort({ date: 1 });
}

export async function createHoliday(
  input: CreateHolidayInput,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await Holiday.findOne({ date: input.date });
  if (existing) throw AppError.conflict('Holiday already exists on this date', ErrorCode.DUPLICATE_ENTRY);

  const holiday = await Holiday.create({
    date: input.date,
    name: input.name,
    createdBy: adminId,
  });

  await AuditLog.create({
    action: AuditAction.HOLIDAY_CREATED,
    actorId: adminId,
    targetType: 'holiday',
    targetId: holiday._id,
    details: { date: input.date, name: input.name },
    ipAddress: ip,
    userAgent: ua,
  });

  return holiday;
}

export async function deleteHoliday(
  holidayId: string,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const holiday = await Holiday.findByIdAndDelete(holidayId);
  if (!holiday) throw AppError.notFound('Holiday not found');

  await AuditLog.create({
    action: AuditAction.HOLIDAY_DELETED,
    actorId: adminId,
    targetType: 'holiday',
    targetId: holiday._id,
    details: { date: holiday.date, name: holiday.name },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: true };
}

export async function toggleMaintenance(
  enabled: boolean,
  adminId: string,
  ip?: string,
  ua?: string,
) {
  const config = await Config.findOneAndUpdate(
    { key: 'maintenance_mode' },
    { value: enabled, updatedBy: adminId },
    { upsert: true, new: true },
  );

  await AuditLog.create({
    action: AuditAction.MAINTENANCE_TOGGLED,
    actorId: adminId,
    targetType: 'config',
    targetId: config._id,
    details: { enabled },
    ipAddress: ip,
    userAgent: ua,
  });

  return { maintenanceMode: enabled };
}

export async function isMaintenanceMode(): Promise<boolean> {
  const config = await Config.findOne({ key: 'maintenance_mode' });
  return config?.value === true;
}

// ── Blocked Slots ──

export async function listBlockedSlots(date?: string) {
  const filter: Record<string, unknown> = {};
  if (date) filter.date = date;
  return BlockedSlot.find(filter).sort({ date: 1, slotCode: 1 }).populate('blockedBy', 'firstName lastName');
}

export async function createBlockedSlot(
  input: CreateBlockedSlotInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const existing = await BlockedSlot.findOne({ date: input.date, slotCode: input.slotCode, type: input.type });
  if (existing) throw AppError.conflict('This slot is already blocked', ErrorCode.DUPLICATE_ENTRY);

  const slot = await BlockedSlot.create({
    date: input.date,
    slotCode: input.slotCode,
    type: input.type,
    reason: input.reason,
    blockedBy: userId,
  });

  await AuditLog.create({
    action: AuditAction.SLOT_BLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    targetId: slot._id,
    details: { date: input.date, slotCode: input.slotCode, type: input.type, reason: input.reason },
    ipAddress: ip,
    userAgent: ua,
  });

  return slot;
}

export async function deleteBlockedSlot(
  slotId: string,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const slot = await BlockedSlot.findByIdAndDelete(slotId);
  if (!slot) throw AppError.notFound('Blocked slot not found');

  await AuditLog.create({
    action: AuditAction.SLOT_UNBLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    targetId: slot._id,
    details: { date: slot.date, slotCode: slot.slotCode, type: slot.type },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: true };
}

export async function bulkCreateBlockedSlots(
  input: BulkBlockSlotsInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const docs = input.slots.map((s) => ({
    date: input.date,
    slotCode: s.slotCode,
    type: s.type,
    reason: input.reason,
    blockedBy: userId,
  }));

  let created = 0;
  let skipped = 0;

  try {
    const result = await BlockedSlot.insertMany(docs, { ordered: false });
    created = result.length;
    skipped = docs.length - created;
  } catch (err: unknown) {
    // BulkWriteError — some succeeded, some duplicates
    const bwe = err as { code?: number; insertedDocs?: unknown[] };
    if (bwe.code === 11000) {
      created = (bwe.insertedDocs ?? []).length;
      skipped = docs.length - created;
    } else {
      throw err;
    }
  }

  if (created > 0) {
    await AuditLog.create({
      action: AuditAction.SLOTS_BULK_BLOCKED,
      actorId: userId,
      targetType: 'blockedSlot',
      details: {
        date: input.date,
        slots: input.slots,
        reason: input.reason,
        created,
        skipped,
      },
      ipAddress: ip,
      userAgent: ua,
    });
  }

  return { created, skipped };
}

export async function bulkDeleteBlockedSlots(
  input: BulkUnblockSlotsInput,
  userId: string,
  ip?: string,
  ua?: string,
) {
  const slots = await BlockedSlot.find({ _id: { $in: input.ids } });
  if (!slots.length) throw AppError.notFound('No blocked slots found for the given IDs');

  const details = slots.map((s) => ({ date: s.date, slotCode: s.slotCode, type: s.type }));
  await BlockedSlot.deleteMany({ _id: { $in: input.ids } });

  await AuditLog.create({
    action: AuditAction.SLOTS_BULK_UNBLOCKED,
    actorId: userId,
    targetType: 'blockedSlot',
    details: { slots: details, count: slots.length },
    ipAddress: ip,
    userAgent: ua,
  });

  return { deleted: slots.length };
}

export async function seedDefaultConfigs(): Promise<void> {
  const defaults: Record<string, { value: unknown; description: string }> = {
    maintenance_mode: {
      value: false,
      description: 'Enable/disable maintenance mode',
    },
    ocular_fee_config: {
      value: {
        baseFee: 350,
        baseKm: 10,
        extraRatePerKm: 60,
        maxDistanceKm: 100,
      },
      description: 'Legacy ocular visit fee configuration (backward compatibility)',
    },
    shopLatitude: {
      value: DAHLIA_EXT_PLUS_CODE_COORDS.lat,
      description: 'Shop latitude used as routing origin for ocular visits',
    },
    shopLongitude: {
      value: DAHLIA_EXT_PLUS_CODE_COORDS.lng,
      description: 'Shop longitude used as routing origin for ocular visits',
    },
    baseCoveredKm: {
      value: 10,
      description: 'Distance covered by the base ocular fee for outside-NCR visits',
    },
    baseFee: {
      value: 350,
      description: 'Minimum ocular transportation fee (outside NCR)',
    },
    perKmRate: {
      value: 60,
      description: 'Additional ocular transportation fee per kilometer outside base coverage',
    },
    maxDistanceKm: {
      value: 100,
      description: 'Maximum serviceable distance for ocular visits',
    },
    ncrPolygonFile: {
      value: 'src/modules/maps/data/ncr-boundary.json',
      description: 'GeoJSON file path used for NCR point-in-polygon validation',
    },
    installment_surcharge_percent: {
      value: 10,
      description: 'Surcharge percentage applied to installment payments (e.g. 10 = 10%)',
    },
    installment_split: {
      value: [30, 40, 30],
      description: 'Installment split percentages for each stage (must sum to 100)',
    },
    installment_stage_labels: {
      value: ['Down Payment', 'Mid-Project', 'Final Payment'],
      description: 'Labels for each installment stage corresponding to installment_split',
    },
    installment_stage_descriptions: {
      value: ['Due upon contract signing', 'Due when fabrication is complete', 'Due after installation & acceptance'],
      description: 'Default milestone descriptions for each installment stage',
    },
  };

  for (const [key, { value, description }] of Object.entries(defaults)) {
    await Config.findOneAndUpdate(
      { key },
      { $setOnInsert: { value, description } },
      { upsert: true },
    );
  }

  // One-time migration from known previous seeded coordinates to
  // exact Plus Code location: M3X3+RF4, Dahlia Ext, Quezon City.
  await Config.updateOne(
    {
      key: 'shopLatitude',
      value: {
        $in: [
          LEGACY_SHOP_COORDS.lat,
          String(LEGACY_SHOP_COORDS.lat),
          MAPULANG_LUPA_SHOP_COORDS.lat,
          String(MAPULANG_LUPA_SHOP_COORDS.lat),
          14.7004606,
          '14.7004606',
        ],
      },
    },
    { $set: { value: DAHLIA_EXT_PLUS_CODE_COORDS.lat } },
  );
  await Config.updateOne(
    {
      key: 'shopLongitude',
      value: {
        $in: [
          LEGACY_SHOP_COORDS.lng,
          String(LEGACY_SHOP_COORDS.lng),
          MAPULANG_LUPA_SHOP_COORDS.lng,
          String(MAPULANG_LUPA_SHOP_COORDS.lng),
          121.0553413,
          '121.0553413',
        ],
      },
    },
    { $set: { value: DAHLIA_EXT_PLUS_CODE_COORDS.lng } },
  );
}
