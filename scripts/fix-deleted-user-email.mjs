/**
 * One-time fix: scramble emails on soft-deleted user records
 * so the unique index allows re-registration with the same email.
 *
 * Usage:  node scripts/fix-deleted-user-email.mjs
 *
 * Requires MONGODB_URI env var (reads from .env automatically).
 */

import 'dotenv/config';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI not set');
  process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log('✅ Connected to MongoDB');

const db = mongoose.connection.db;
const usersCol = db.collection('users');

// Find all soft-deleted users whose emails haven't been scrambled yet
const deletedUsers = await usersCol
  .find({ deletedAt: { $ne: null }, email: { $not: /^deleted_/ } })
  .toArray();

console.log(`Found ${deletedUsers.length} soft-deleted user(s) to fix…`);

for (const u of deletedUsers) {
  const newEmail = `deleted_${u.deletedAt.getTime()}_${u.email}`;
  await usersCol.updateOne(
    { _id: u._id },
    { $set: { email: newEmail }, $unset: { firebaseUid: '' } },
  );
  console.log(`  ✓ ${u.email} → ${newEmail}`);
}

console.log('Done.');
await mongoose.disconnect();
