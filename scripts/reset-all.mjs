/**
 * reset-all.mjs
 * Wipes ALL data from MongoDB and Cloudflare R2 EXCEPT the super admin user.
 * 
 * Usage:  cd rmv-server && node scripts/reset-all.mjs
 */
import mongoose from 'mongoose';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'admin@rmvsteelfab.com';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}

// ─── Phase 1: Clear R2 Bucket ───────────────────────────────────────
async function clearR2() {
  if (!R2_ACCOUNT_ID || R2_ACCOUNT_ID === 'placeholder') {
    console.log('⏭️  R2 not configured, skipping bucket clear.');
    return;
  }

  console.log('\n🪣 Clearing R2 bucket:', R2_BUCKET_NAME);

  const r2 = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  let totalDeleted = 0;
  let continuationToken;

  // Paginate through all objects and delete in batches of 1000
  do {
    const list = await r2.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        MaxKeys: 1000,
        ContinuationToken: continuationToken,
      }),
    );

    const objects = list.Contents;
    if (!objects || objects.length === 0) break;

    const keys = objects.map((o) => ({ Key: o.Key }));

    await r2.send(
      new DeleteObjectsCommand({
        Bucket: R2_BUCKET_NAME,
        Delete: { Objects: keys, Quiet: true },
      }),
    );

    totalDeleted += keys.length;
    console.log(`   Deleted ${totalDeleted} objects so far...`);

    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  console.log(`✅ R2 cleared — ${totalDeleted} objects deleted.`);
}

// ─── Phase 2: Clear MongoDB ─────────────────────────────────────────
async function clearMongoDB() {
  console.log('\n🗄️  Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`   Connected: ${mongoose.connection.host}`);

  // 1. Find the super admin user BEFORE we drop anything
  const usersCol = db.collection('users');
  const superAdmin = await usersCol.findOne({ email: SUPER_ADMIN_EMAIL });

  if (!superAdmin) {
    console.error(`❌ Super admin (${SUPER_ADMIN_EMAIL}) not found! Aborting DB wipe.`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`   Found super admin: ${superAdmin.email} (${superAdmin._id})`);

  // 2. Get all collection names (skip system collections)
  const collections = await db.listCollections().toArray();
  const collectionNames = collections
    .map((c) => c.name)
    .filter((name) => !name.startsWith('system.'));

  console.log(`   Collections to clear: ${collectionNames.join(', ')}`);

  // 3. Drop all collections except 'users'
  for (const name of collectionNames) {
    if (name === 'users') continue; // handle users separately
    await db.collection(name).deleteMany({});
    console.log(`   🗑️  Cleared: ${name}`);
  }

  // 4. For 'users', delete everyone except the super admin
  const userResult = await usersCol.deleteMany({
    _id: { $ne: superAdmin._id },
  });
  console.log(`   🗑️  Cleared users: removed ${userResult.deletedCount}, kept super admin`);

  console.log('✅ MongoDB cleared — only super admin remains.');
  await mongoose.disconnect();
}

// ─── Run ─────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║    RMV System — Full Data Reset              ║');
  console.log('║    Keeping: Super Admin account only         ║');
  console.log('╚══════════════════════════════════════════════╝');

  await clearR2();
  await clearMongoDB();

  console.log('\n🎉 All done! Database and R2 bucket are fresh.');
  console.log('   Super admin can still log in with existing credentials.\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
