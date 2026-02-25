import admin from 'firebase-admin';
import { env } from './env.js';

let firebaseApp: admin.app.App | null = null;

export function getFirebaseAdmin(): admin.app.App {
  if (firebaseApp) return firebaseApp;

  const b64 = env.FIREBASE_SERVICE_ACCOUNT_B64;
  if (!b64) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_B64 is not set');
  }

  const serviceAccount = JSON.parse(
    Buffer.from(b64, 'base64').toString('utf-8'),
  );

  firebaseApp = admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  return firebaseApp;
}

export async function verifyFirebaseIdToken(idToken: string): Promise<{ uid: string; email?: string; name?: string; picture?: string; [key: string]: unknown }> {
  const app = getFirebaseAdmin();
  const decoded = await app.auth().verifyIdToken(idToken);
  return decoded as { uid: string; email?: string; name?: string; picture?: string; [key: string]: unknown };
}
