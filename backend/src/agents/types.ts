import type { Firestore } from "firebase-admin/firestore";
import type { Bucket } from "@google-cloud/storage";
import type { callClaude } from "./llm-client.js";

// =====================================================================
// Shared agent types
// ---------------------------------------------------------------------
// These types are the contract between the 8-stage pipeline, the
// orchestrator, and any per-stage agent handler. They intentionally
// have no behavior — only shapes — so they're cheap to import in
// both backend code and tests.
// =====================================================================

// ---- 8 pipeline stages ----
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

/**
 * Per-stage result envelope. Every stage handler returns this so the
 * orchestrator can do `result.status === "succeeded" ? next() : fail()`.
 * `data` is the typed output of that stage (BrainstormOutput,
 * GemSpec, …) — set on success; `error` is set on failure.
 */
export interface StageResult<T = unknown> {
  stage: PipelineStage;
  status: "succeeded" | "failed" | "skipped";
  data?: T;
  error?: {
    message: string;
    code: string;
    recoverable: boolean;
  };
}

/**
 * Stage handler signature. Each stage is a pure function of
 * (AgentContext, input) → StageResult. Side effects (firestore
 * writes, gcs uploads, llm calls) happen via the context.
 */
export type StageHandler<TInput, TOutput> = (
  ctx: AgentContext,
  input: TInput,
) => Promise<StageResult<TOutput>>;

/**
 * The minimal surface every stage needs. The orchestrator builds
 * one of these per run and hands it to every stage handler. Long-
 * lived clients (firestore, storage) are shared; secrets are passed
 * as a typed function so the handler doesn't need to know about
 * Secret Manager.
 */
export interface AgentContext {
  runId: string;
  intakeId: string;
  gemId: string;
  gemVersion: string;
  authorUid: string;

  /**
   * Per-run runtime hints. Stages 4–7 use this to know which model
   * to call, which env the gem needs, etc. Populated by stage 1
   * (intake) and stage 2 (brainstorm).
   */
  gemRuntimeCtx: Record<string, unknown>;

  /** Secret Manager accessor (cached 5 min internally). */
  secrets: {
    getSecret: (name: string) => Promise<string>;
  };

  /** Lazily-initialized Firestore client. */
  firestore: Firestore;

  /** Lazily-initialized GCS bucket. */
  storage: Bucket;

  /** LLM access surface. Other providers (OpenAI, Gemini, …) will be added here in later chunks. */
  llm: {
    callClaude: typeof callClaude;
  };
}
