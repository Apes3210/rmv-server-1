/**
 * Migration script: Drop old unique indexes on appointmentId
 * from VisitReport and Project collections.
 *
 * This is needed because we now support multiple visit reports (and projects)
 * per appointment.
 *
 * Run once after deploying the schema change:
 *   npx tsx src/scripts/dropUniqueIndexes.ts
 *
 * Safe to run multiple times — it silently skips if indexes don't exist.
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/database.js';
import { logger } from '../utils/logger.js';

async function dropUniqueIndexes(): Promise<void> {
  try {
    await connectDB();
    const db = mongoose.connection.db!;

    // ── VisitReport: drop unique index on appointmentId ──
    const vrCollection = db.collection('visitreports');
    const vrIndexes = await vrCollection.indexes();
    const vrUnique = vrIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        'appointmentId' in idx.key,
    );

    if (vrUnique) {
      await vrCollection.dropIndex(vrUnique.name!);
      logger.info(`Dropped unique index "${vrUnique.name}" from visitreports`);
    } else {
      logger.info('No unique appointmentId index found on visitreports — already clean.');
    }

    // ── Project: drop unique index on appointmentId ──
    const projCollection = db.collection('projects');
    const projIndexes = await projCollection.indexes();
    const projUnique = projIndexes.find(
      (idx) =>
        idx.unique &&
        idx.key &&
        Object.keys(idx.key).length === 1 &&
        'appointmentId' in idx.key,
    );

    if (projUnique) {
      await projCollection.dropIndex(projUnique.name!);
      logger.info(`Dropped unique index "${projUnique.name}" from projects`);
    } else {
      logger.info('No unique appointmentId index found on projects — already clean.');
    }

    logger.info('Migration complete.');
    await mongoose.connection.close();
    process.exit(0);
  } catch (error) {
    logger.error('Migration failed:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
}

dropUniqueIndexes();
