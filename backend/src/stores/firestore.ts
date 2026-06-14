import { FieldValue, type Firestore } from "firebase-admin/firestore";
import { getFirestore } from "../lib/firebase.js";
import { logger } from "../lib/logger.js";
import { newIntakeId, newRunId, newShareToken } from "../lib/crypto.js";

// =====================================================================
// Persistence types
// ---------------------------------------------------------------------
// NOTE: These shapes were specified by the task ("schemas in
// schema.ts are the source of truth for field names") but the
// required types (NewGem, Gem, NewGemRun, GemRun, NewGemIntake,
// GemIntake, NewAuditEntry, AuditEntry) are NOT yet defined in
// backend/src/lib/schema.ts. They are declared locally here to keep
// the stores decoupled until the schema is updated. See final report.
// =====================================================================

// ---- Visibility & stage enums (also re-exported from schema if added) ----
export type GemVisibility = "private" | "unlisted" | "public";
export type PipelineStage =
  | "intake"
  | "brainstorm"
  | "spec"
  | "build"
  | "verify"
  | "evaluate"
  | "publish"
  | "deploy"
  | "registry-hooks";
export type StageStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

// ---- Intake (a user-prompt + uploaded refs, one per /gem-create) ----
export interface NewGemIntake {
  prompt: string;
  authorUid: string;
  visibility: GemVisibility;
  refPaths?: string[];
}

export interface GemIntake {
  intakeId: string;
  prompt: string;
  authorUid: string;
  visibility: GemVisibility;
  refPaths: string[];
  createdAtIso: string;
  updatedAtIso: string;
}

// ---- Run (orchestrates the 8-stage pipeline for one intake) ----
export interface NewGemRun {
  intakeId: string;
  authorUid: string;
  /** Optional initial visibility carried over from the intake. */
  visibility?: GemVisibility;
}

export interface GemRun {
  runId: string;
  intakeId: string;
  authorUid: string;
  visibility: GemVisibility;
  /** Current stage. `pending` until the orchestrator picks it up. */
  currentStage: PipelineStage;
  currentStatus: StageStatus;
  /** Per-stage status map — only present once that stage has run. */
  stageStatuses: Partial<Record<PipelineStage, StageStatus>>;
  /** Optional error blob from the most recent failed stage. */
  lastError?: { stage: PipelineStage; message: string; atIso: string } | null;
  createdAtIso: string;
  updatedAtIso: string;
}

// ---- Gem (the published artifact: registry entry + share token) ----
export interface NewGem {
  id: string;
  name: string;
  version: string;
  description: string;
  authorUid: string;
  visibility: GemVisibility;
  runId: string;
  intakeId: string;
}

export interface Gem {
  gemId: string;
  name: string;
  version: string;
  description: string;
  authorUid: string;
  visibility: GemVisibility;
  shareToken: string;
  runId: string;
  intakeId: string;
  cloudRunUrl: string | null;
  status: "building" | "live" | "deleted";
  createdAtIso: string;
  updatedAtIso: string;
}

// ---- Audit log (immutable, append-only) ----
export interface NewAuditEntry {
  action: string;
  gemId?: string;
  authorUid?: string;
  runId?: string;
  intakeId?: string;
  details?: Record<string, unknown>;
}

export interface AuditEntry {
  entryId: string;
  action: string;
  gemId?: string;
  authorUid?: string;
  runId?: string;
  intakeId?: string;
  details?: Record<string, unknown>;
  atIso: string;
}

// =====================================================================
// Collection names
// =====================================================================
const COL_RUNS = "gem_runs";
const COL_INTAKES = "gem_intakes";
const COL_GEMS = "gems";
const COL_AUDIT = "gem_audit_log";

// =====================================================================
// Internal helpers
// =====================================================================
function db(): Firestore {
  return getFirestore();
}

function nowIso(): string {
  return new Date().toISOString();
}

function serverTimestamp(): FieldValue {
  return FieldValue.serverTimestamp();
}

// =====================================================================
// gem_runs
// =====================================================================
export async function createGemRun(run: NewGemRun): Promise<GemRun> {
  const runId = newRunId();
  const now = nowIso();
  const doc: GemRun = {
    runId,
    intakeId: run.intakeId,
    authorUid: run.authorUid,
    visibility: run.visibility ?? "unlisted",
    currentStage: "intake",
    currentStatus: "pending",
    stageStatuses: {},
    lastError: null,
    createdAtIso: now,
    updatedAtIso: now,
  };
  await db().collection(COL_RUNS).doc(runId).set(doc);
  logger.info({ runId, intakeId: run.intakeId }, "gem run created");
  return doc;
}

export async function getGemRun(runId: string): Promise<GemRun | null> {
  const snap = await db().collection(COL_RUNS).doc(runId).get();
  if (!snap.exists) return null;
  return snap.data() as GemRun;
}

export async function updateGemRunStage(
  runId: string,
  stage: PipelineStage,
  status: StageStatus,
  error?: string,
): Promise<void> {
  const ref = db().collection(COL_RUNS).doc(runId);
  const update: Partial<GemRun> & { updatedAt: FieldValue } = {
    currentStage: stage,
    currentStatus: status,
    stageStatuses: { [stage]: status } as Partial<Record<PipelineStage, StageStatus>>,
    updatedAtIso: nowIso(),
    updatedAt: serverTimestamp(),
  };
  if (error !== undefined) {
    update.lastError = { stage, message: error, atIso: nowIso() };
  } else if (status === "succeeded") {
    update.lastError = null;
  }
  await ref.set(update, { merge: true });
  logger.debug({ runId, stage, status, error }, "gem run stage updated");
}

// =====================================================================
// gem_intakes
// =====================================================================
export async function createGemIntake(intake: NewGemIntake): Promise<GemIntake> {
  const intakeId = newIntakeId();
  const now = nowIso();
  const doc: GemIntake = {
    intakeId,
    prompt: intake.prompt,
    authorUid: intake.authorUid,
    visibility: intake.visibility,
    refPaths: intake.refPaths ?? [],
    createdAtIso: now,
    updatedAtIso: now,
  };
  await db().collection(COL_INTAKES).doc(intakeId).set(doc);
  logger.info({ intakeId, authorUid: intake.authorUid }, "gem intake created");
  return doc;
}

export async function getGemIntake(intakeId: string): Promise<GemIntake | null> {
  const snap = await db().collection(COL_INTAKES).doc(intakeId).get();
  if (!snap.exists) return null;
  return snap.data() as GemIntake;
}

// =====================================================================
// gems
// =====================================================================
export async function createGem(gem: NewGem): Promise<Gem> {
  // Use the gem id as the document id so getGemById is a point read.
  const gemId = gem.id;
  const now = nowIso();
  const doc: Gem = {
    gemId,
    name: gem.name,
    version: gem.version,
    description: gem.description,
    authorUid: gem.authorUid,
    visibility: gem.visibility,
    shareToken: newShareToken(),
    runId: gem.runId,
    intakeId: gem.intakeId,
    cloudRunUrl: null,
    status: "building",
    createdAtIso: now,
    updatedAtIso: now,
  };
  await db().collection(COL_GEMS).doc(gemId).set(doc);
  logger.info({ gemId, authorUid: gem.authorUid }, "gem created");
  return doc;
}

export async function getGemById(gemId: string): Promise<Gem | null> {
  const snap = await db().collection(COL_GEMS).doc(gemId).get();
  if (!snap.exists) return null;
  return snap.data() as Gem;
}

export async function getGemByShareToken(shareToken: string): Promise<Gem | null> {
  const q = await db()
    .collection(COL_GEMS)
    .where("shareToken", "==", shareToken)
    .limit(1)
    .get();
  if (q.empty) return null;
  return q.docs[0].data() as Gem;
}

export interface ListGemsOpts {
  visibility?: GemVisibility;
  authorUid?: string;
  limit?: number;
  cursor?: string;
}

export async function listGems(
  opts: ListGemsOpts = {},
): Promise<{ gems: Gem[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  let query = db().collection(COL_GEMS).orderBy("createdAtIso", "desc");
  if (opts.visibility) {
    query = query.where("visibility", "==", opts.visibility);
  }
  if (opts.authorUid) {
    query = query.where("authorUid", "==", opts.authorUid);
  }
  if (opts.cursor) {
    query = query.startAfter(opts.cursor);
  }
  query = query.limit(limit);
  const snap = await query.get();
  const gems = snap.docs.map((d) => d.data() as Gem);
  const last = snap.docs[snap.docs.length - 1];
  const nextCursor =
    snap.docs.length === limit && last ? last.get("createdAtIso") as string : undefined;
  return { gems, nextCursor };
}

// =====================================================================
// gem_audit_log (append-only)
// =====================================================================
export async function appendAuditLog(entry: NewAuditEntry): Promise<void> {
  const entryId = newRunId(); // small opaque id, no need for a separate generator
  const doc: AuditEntry = {
    entryId,
    action: entry.action,
    gemId: entry.gemId,
    authorUid: entry.authorUid,
    runId: entry.runId,
    intakeId: entry.intakeId,
    details: entry.details ?? {},
    atIso: nowIso(),
  };
  await db().collection(COL_AUDIT).doc(entryId).set(doc);
  logger.debug({ entryId, action: entry.action }, "audit log appended");
}

export interface ListAuditLogFilter {
  gemId?: string;
  authorUid?: string;
  action?: string;
  limit?: number;
}

export async function listAuditLog(
  filter: ListAuditLogFilter = {},
): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  let query = db().collection(COL_AUDIT).orderBy("atIso", "desc");
  if (filter.gemId) {
    query = query.where("gemId", "==", filter.gemId);
  }
  if (filter.authorUid) {
    query = query.where("authorUid", "==", filter.authorUid);
  }
  if (filter.action) {
    query = query.where("action", "==", filter.action);
  }
  query = query.limit(limit);
  const snap = await query.get();
  return snap.docs.map((d) => d.data() as AuditEntry);
}

// =====================================================================
// patch helpers (added in chunk 3 to unblock deployer + registry-hooks)
// =====================================================================

/** Partial-update a gem document. Returns the merged result. */
export async function updateGem(
  gemId: string,
  partial: Partial<Omit<Gem, "gemId" | "createdAtIso">>,
): Promise<Gem> {
  const ref = db().collection(COL_GEMS).doc(gemId);
  const patch = { ...partial, updatedAtIso: nowIso() };
  await ref.set(patch, { merge: true });
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`updateGem: gem ${gemId} disappeared after merge`);
  }
  return snap.data() as Gem;
}

/** Lookup a published gem by (gemId, semver) pair. */
export async function getGemBySemver(
  gemId: string,
  semver: string,
): Promise<Gem | null> {
  const q = await db()
    .collection(COL_GEMS)
    .where("gemId", "==", gemId)
    .where("version", "==", semver)
    .limit(1)
    .get();
  if (q.empty) return null;
  return q.docs[0].data() as Gem;
}
