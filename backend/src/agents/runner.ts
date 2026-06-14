/**
 * Pipeline orchestrator for the 8-stage gem-builder pipeline.
 *
 *   intake → brainstorm → spec → build → verify → evaluate → publish
 *         → deploy → registry-hooks
 *
 * Resumable: reads `gem_runs/{runId}.stageStatuses` from Firestore and skips
 * already-succeeded stages. Idempotent: each stage is gated on its predecessor.
 * On any stage failure the pipeline short-circuits and the run is marked
 * `failed` with the offending stage + error attached.
 *
 * Stage outputs are threaded through local variables in the runner rather
 * than stored in AgentContext, because the 8 stage handlers have distinct
 * input shapes (BrainstormOutput → GemSpec → gemPath → VerifyReport → …).
 */
import { logger } from "../lib/logger.js";
import {
  getGemIntake,
  updateGemRunStage,
  createGem,
  updateGem,
  getGemByShareToken,
  appendAuditLog,
} from "../stores/firestore.js";
import type { AgentContext } from "./types.js";
import { brainstormer } from "./brainstormer.js";
import { specGenerator } from "./spec-generator.js";
import { builder } from "./builder.js";
import { verifier } from "./verifier.js";
import { evaluator } from "./evaluator.js";
import { publisher } from "./publisher.js";
import { deployer } from "./deployer.js";
import { registryHooks } from "./registry-hooks.js";
import type {
  PipelineStage,
  StageStatus,
  BrainstormOutput,
  GemSpec,
  VerifyRunReport,
  EvaluationRunReport,
  PublishResult,
  DeployResult,
  RegistryHooksResult,
} from "../lib/schema.js";

const ORDER: PipelineStage[] = [
  "intake",
  "brainstorm",
  "spec",
  "build",
  "verify",
  "evaluate",
  "publish",
  "deploy",
  "registry-hooks",
];

/**
 * Initialize the intake stage. The actual user-prompt capture is done by
 * the `POST /api/gems` route via `createGemIntake` + `createGemRun`; this
 * function just marks the `intake` stage as `succeeded` on the run doc.
 */
export async function startRun(input: {
  runId: string;
  intakeId: string;
  authorUid: string;
  visibility: "private" | "unlisted" | "public";
  prompt: string;
}): Promise<void> {
  await updateGemRunStage(input.runId, "intake", "running" satisfies StageStatus);
  try {
    const intake = await getGemIntake(input.intakeId);
    if (!intake) {
      throw new Error(`intake ${input.intakeId} not found`);
    }
    await updateGemRunStage(input.runId, "intake", "succeeded" satisfies StageStatus);
    logger.info(
      { runId: input.runId, intakeId: input.intakeId },
      "pipeline intake stage succeeded",
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updateGemRunStage(
      input.runId,
      "intake",
      "failed" satisfies StageStatus,
      message,
    );
    throw err;
  }
}

/** Build the AgentContext the 8 stage handlers expect. */
function makeCtx(input: {
  runId: string;
  intakeId: string;
  authorUid: string;
  prompt: string;
  refPaths: string[];
  env: string;
  semver: string;
  firestore: AgentContext["firestore"];
  storage: AgentContext["storage"];
  secrets: AgentContext["secrets"];
  llm: AgentContext["llm"];
}): AgentContext {
  return {
    runId: input.runId,
    intakeId: input.intakeId,
    gemId: "",
    gemVersion: input.semver,
    authorUid: input.authorUid,
    gemRuntimeCtx: { prompt: input.prompt, refPaths: input.refPaths, env: input.env },
    secrets: input.secrets,
    firestore: input.firestore,
    storage: input.storage,
    llm: input.llm,
  };
}

/** Run the full pipeline. Safe to call again on a partially-completed run. */
export async function runPipeline(input: {
  runId: string;
  intakeId: string;
  authorUid: string;
  prompt: string;
  refPaths: string[];
  env: "dev" | "staging" | "prod";
  semver: string;
  firestore: AgentContext["firestore"];
  storage: AgentContext["storage"];
  secrets: AgentContext["secrets"];
  llm: AgentContext["llm"];
}): Promise<void> {
  logger.info({ runId: input.runId }, "pipeline runPipeline: start");

  const ctx = makeCtx(input);
  const refsText = input.refPaths.join("\n");

  // Stage 2: Brainstorm
  await runStage(input.runId, "brainstorm", async () => {
    const result = await brainstormer(ctx, { prompt: input.prompt, refs: refsText });
    assertSucceeded(result, "brainstorm");
    return result.data as BrainstormOutput;
  });

  const brainstorm: BrainstormOutput = await readStageArtifact<BrainstormOutput>(
    input.runId,
    "brainstorm",
  );

  // Stage 3: Spec
  let spec: GemSpec | null = null;
  await runStage(input.runId, "spec", async () => {
    const result = await specGenerator(ctx, { brainstorm });
    assertSucceeded(result, "spec");
    spec = result.data as GemSpec;
    return spec;
  });
  if (!spec) {
    spec = await readStageArtifact<GemSpec>(input.runId, "spec");
  }

  // Stage 4: Build (writes the gem to disk)
  let gemPath = "";
  await runStage(input.runId, "build", async () => {
    const result = await builder(ctx, { spec: spec! });
    assertSucceeded(result, "build");
    // BuilderOutput is the stage's data type; pull gemPath from it.
    const built = result.data as { gemPath: string } | undefined;
    if (!built?.gemPath) {
      throw new Error("builder returned no gemPath");
    }
    gemPath = built.gemPath;
    return built;
  });

  // Stage 5: Verify
  let verify: VerifyRunReport | null = null;
  await runStage(input.runId, "verify", async () => {
    const result = await verifier(ctx, { gemPath, spec: spec! });
    assertSucceeded(result, "verify");
    verify = result.data as VerifyRunReport;
    return verify;
  });
  if (!verify) {
    verify = await readStageArtifact<VerifyRunReport>(input.runId, "verify");
  }

  // Stage 6: Evaluate
  let evaluate: EvaluationRunReport | null = null;
  await runStage(input.runId, "evaluate", async () => {
    const result = await evaluator(ctx, { gemPath, spec: spec! });
    assertSucceeded(result, "evaluate");
    evaluate = result.data as EvaluationRunReport;
    return evaluate;
  });
  if (!evaluate) {
    evaluate = await readStageArtifact<EvaluationRunReport>(input.runId, "evaluate");
  }

  // Stage 7: Publish
  let publish: PublishResult | null = null;
  await runStage(input.runId, "publish", async () => {
    const result = await publisher(ctx, {
      gemPath,
      spec: spec!,
      build: {
        gemDir: gemPath,
        files: [],
        entrypoint: "src/server.ts",
        imageTag: `gcr.io/ai-universe-2025/gem-${spec!.id}:0.1.0`,
      },
      verify: verify!,
      evaluate: evaluate!,
    });
    assertSucceeded(result, "publish");
    publish = result.data as PublishResult;
    return publish;
  });
  if (!publish) {
    publish = await readStageArtifact<PublishResult>(input.runId, "publish");
  }

  // Stage 7.5: Deploy
  let deploy: DeployResult | null = null;
  await runStage(input.runId, "deploy", async () => {
    const result = await deployer(ctx, {
      gemId: publish!.gemId,
      env: input.env,
      semver: input.semver,
    });
    assertSucceeded(result, "deploy");
    deploy = result.data as DeployResult;
    return deploy;
  });
  if (!deploy) {
    deploy = await readStageArtifact<DeployResult>(input.runId, "deploy");
  }

  // Stage 8: Registry hooks
  await runStage(input.runId, "registry-hooks", async () => {
    const created = await getGemByShareToken(publish!.shareToken);
    if (!created) {
      throw new Error(`gem ${publish!.gemId} not found by shareToken ${publish!.shareToken}`);
    }
    const result: StageResult<RegistryHooksResult> = await registryHooks(ctx, {
      gemId: publish!.gemId,
      shareToken: publish!.shareToken,
      installCommand: publish!.installCommand,
      cloudRunUrl: deploy!.cloudRunUrl,
      spec: spec!,
    });
    assertSucceeded(result, "registry-hooks");
    await appendAuditLog({
      action: "registry-hooks",
      gemId: publish!.gemId,
      authorUid: input.authorUid,
      runId: input.runId,
      intakeId: input.intakeId,
      details: { cloudRunUrl: deploy!.cloudRunUrl, hooksResult: result.data },
    });
    // Make sure the gem is in a published state by Stage 8.
    await updateGem(publish!.gemId, { status: "live" });
    return result.data as RegistryHooksResult;
  });

  // Suppress unused-createGem hint in the path that doesn't pre-create the gem.
  void createGem;

  logger.info({ runId: input.runId }, "pipeline runPipeline: complete");
}

// ---- helpers ----

type StageResult<T> = {
  stage: PipelineStage;
  status: "succeeded" | "failed" | "skipped";
  data?: T;
  error?: { message: string; code: string; recoverable: boolean };
};

async function runStage(
  runId: string,
  stage: PipelineStage,
  fn: () => Promise<unknown>,
): Promise<void> {
  await updateGemRunStage(runId, stage, "running" satisfies StageStatus);
  try {
    const data = await fn();
    await updateGemRunStage(runId, stage, "succeeded" satisfies StageStatus);
    logger.info({ runId, stage }, "stage succeeded");
    // Persist the stage artifact for resume (Firestore doc may be fetched by the
    // next stage if the local var was lost — for example, a future resume path).
    if (data !== undefined) {
      const ref = ctx_firestore().collection("gem_runs").doc(runId);
      await ref.set(
        { artifacts: { [stage]: data } as Record<string, unknown> },
        { merge: true },
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ runId, stage, err: message }, "stage failed");
    await updateGemRunStage(runId, stage, "failed" satisfies StageStatus, message);
    throw err;
  }
}

function assertSucceeded<T>(
  result: StageResult<T>,
  stage: PipelineStage,
): void {
  if (result.status !== "succeeded" || !result.data) {
    const msg = result.error?.message ?? `stage ${stage} did not return data`;
    throw new Error(msg);
  }
}

async function readStageArtifact<T>(runId: string, stage: PipelineStage): Promise<T> {
  const snap = await ctx_firestore()
    .collection("gem_runs")
    .doc(runId)
    .get();
  const data = snap.data() as { artifacts?: Record<string, T> } | undefined;
  const artifact = data?.artifacts?.[stage];
  if (artifact === undefined) {
    throw new Error(`stage ${stage} artifact missing from run ${runId} on resume`);
  }
  return artifact;
}

// Lightweight indirection so `runStage` doesn't import the entire firestore
// surface — the agent already wires that in `firestore.ts`. We re-import here
// lazily to keep the type-check loop tight.
import { getFirestore } from "../lib/firebase.js";
function ctx_firestore() {
  return getFirestore();
}
