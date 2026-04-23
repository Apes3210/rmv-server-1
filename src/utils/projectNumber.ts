import { ProjectCounter } from '../models/Config.js';

/**
 * Generates an immutable project number in the format RMV-YYYY-#####
 * where ##### is a zero-padded counter that resets each year.
 */
export async function generateProjectNumber(): Promise<string> {
  const currentYear = new Date().getFullYear();
  
  // Use findOneAndUpdate with upsert for atomic increment
  const counter = await ProjectCounter.findOneAndUpdate(
    { year: currentYear },
    { $inc: { lastSeq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const seqStr = String(counter.lastSeq).padStart(5, '0');
  return `RMV-${currentYear}-${seqStr}`;
}
