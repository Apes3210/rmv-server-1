/**
 * One-time script to set CORS rules on the R2 bucket.
 *
 * Usage:
 *   node scripts/set-r2-cors.mjs
 *
 * Requires these env vars (from .env):
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 */

import 'dotenv/config';
import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME = 'rmv-uploads',
} = process.env;

if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
  console.error('Missing R2 credentials in environment');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const corsRules = {
  CORSRules: [
    {
      AllowedOrigins: [
        'https://www.rmvfabrication.app',
        'https://rmvfabrication.app',
        'http://localhost:5173',       // dev
      ],
      AllowedMethods: ['PUT', 'GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    },
  ],
};

try {
  await client.send(
    new PutBucketCorsCommand({
      Bucket: R2_BUCKET_NAME,
      CORSConfiguration: corsRules,
    }),
  );
  console.log(`✅ CORS rules set on bucket "${R2_BUCKET_NAME}"`);
  console.log(JSON.stringify(corsRules, null, 2));
} catch (err) {
  console.error('❌ Failed to set CORS rules:', err);
  process.exit(1);
}
