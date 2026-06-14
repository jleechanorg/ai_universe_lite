import { initializeApp, getApps, type App, applicationDefault } from "firebase-admin/app";
import { getAuth as adminGetAuth, type Auth } from "firebase-admin/auth";
import { getFirestore as adminGetFirestore, type Firestore } from "firebase-admin/firestore";
import { loadConfig } from "../config.js";
import { logger } from "./logger.js";

// Singleton handles — lazy-init on first access.
let app: App | null = null;
let firestoreInstance: Firestore | null = null;
let authInstance: Auth | null = null;

const PROJECT_ID_FALLBACK = "ai-universe-b3551";

/**
 * Resolve the firebase project id, preferring the explicit env var
 * (FIREBASE_PROJECT_ID) and falling back to the config default.
 */
function resolveProjectId(): string {
  const fromEnv = process.env.FIREBASE_PROJECT_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  try {
    const cfg = loadConfig();
    return cfg.firebaseProjectId || PROJECT_ID_FALLBACK;
  } catch {
    return PROJECT_ID_FALLBACK;
  }
}

/**
 * Initialize the default firebase-admin app exactly once. Subsequent
 * calls return the cached app instance. Uses application default
 * credentials (works on Cloud Run with the default compute SA) and
 * pins the project id to FIREBASE_PROJECT_ID.
 */
export function getFirebaseApp(): App {
  if (app) return app;
  const existing = getApps();
  if (existing.length > 0) {
    app = existing[0] as App;
    return app;
  }
  const projectId = resolveProjectId();
  logger.info({ projectId }, "initializing firebase-admin app");
  app = initializeApp({
    credential: applicationDefault(),
    projectId,
  });
  return app;
}

/**
 * Lazily-initialized Firestore client. Resolves the project id from
 * env / config so callers don't have to plumb it through.
 */
export function getFirestore(): Firestore {
  if (firestoreInstance) return firestoreInstance;
  const a = getFirebaseApp();
  // Pass projectId explicitly so emulator / multi-project setups work.
  firestoreInstance = adminGetFirestore(a, resolveProjectId());
  return firestoreInstance;
}

/**
 * Lazily-initialized Firebase Auth client.
 */
export function getAuth(): Auth {
  if (authInstance) return authInstance;
  const a = getFirebaseApp();
  authInstance = adminGetAuth(a);
  return authInstance;
}

/**
 * Test-only: reset all cached handles so a new app can be created
 * with different credentials. Production code should never call this.
 */
export function _resetFirebaseForTest(): void {
  app = null;
  firestoreInstance = null;
  authInstance = null;
}
