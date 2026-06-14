import { Router, type Request, type Response, type NextFunction } from "express";
import { logger } from "../lib/logger.js";
import { HttpError } from "../lib/errors.js";
import { loadConfig } from "../config.js";
import {
  CreateGemRequestSchema,
  CreateGemResponseSchema,
  type CreateGemResponse,
} from "../lib/schema.js";
import {
  createGemRun,
  createGemIntake,
  getGemRun,
  getGemById,
} from "../stores/firestore.js";
import { getSecret } from "../stores/secrets.js";
import { getFirestore } from "../lib/firebase.js";
import { initBucket } from "../stores/storage.js";
import { callClaude } from "../agents/llm-client.js";
import { runPipeline, startRun } from "../agents/runner.js";
import type { AgentContext } from "../agents/types.js";

const router = Router();

/**
 * POST /api/gems — Create a new gem build.
 * Returns immediately with {runId, intakeId, pollUrl, estimatedSeconds};
 * the pipeline runs fire-and-forget in the background.
 */
router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = CreateGemRequestSchema.parse(req.body);
    const intake = await createGemIntake({
      prompt: parsed.prompt,
      authorUid: parsed.authorUid,
      visibility: parsed.visibility,
      refPaths: parsed.refPaths,
    });
    const run = await createGemRun({
      intakeId: intake.intakeId,
      authorUid: parsed.authorUid,
      visibility: parsed.visibility,
    });
    const config = loadConfig();
    const body: CreateGemResponse = CreateGemResponseSchema.parse({
      runId: run.runId,
      intakeId: intake.intakeId,
      pollUrl: `/api/gems/${run.runId}`,
      estimatedSeconds: config.gemBuildTimeoutSec,
    });

    // Fire-and-forget: start the orchestrator in the background.
    const env = (process.env.DEPLOY_ENV ?? "dev") as "dev" | "staging" | "prod";
    void (async () => {
      try {
        await startRun({
          runId: run.runId,
          intakeId: intake.intakeId,
          authorUid: parsed.authorUid,
          visibility: parsed.visibility,
          prompt: parsed.prompt,
        });
        await runPipeline({
          runId: run.runId,
          intakeId: intake.intakeId,
          authorUid: parsed.authorUid,
          prompt: parsed.prompt,
          refPaths: parsed.refPaths,
          env,
          semver: "0.1.0",
          firestore: getFirestore(),
          storage: await initBucket(),
          secrets: { getSecret },
          llm: { callClaude },
        });
      } catch (err) {
        logger.error(
          {
            runId: run.runId,
            err: err instanceof Error ? err.message : String(err),
          },
          "background pipeline failed",
        );
      }
    })();

    res.status(202).json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gems/:runId — Poll the current pipeline state.
 */
router.get("/:runId", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const runId = String(req.params.runId);
    if (!runId) throw new HttpError(400, "missing_runId", "runId is required");
    const run = await getGemRun(runId);
    if (!run) throw new HttpError(404, "run_not_found", `run ${runId} not found`);
    res.json(run);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/gems/:gemId/install — Public install metadata for a published gem.
 */
router.get("/:gemId/install", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const gemId = String(req.params.gemId);
    const gem = await getGemById(gemId);
    if (!gem) throw new HttpError(404, "gem_not_found", `gem ${gemId} not found`);
    res.json({
      gemId: gem.gemId,
      name: gem.name,
      version: gem.version,
      shareToken: gem.shareToken,
      installCommand: `npx fastmcp install --from gem-${gem.gemId}@npm ${gem.gemId}`,
      cloudRunUrl: gem.cloudRunUrl,
    });
  } catch (err) {
    next(err);
  }
});

// Suppress unused-import warning for the AgentContext type re-export in tests.
export type { AgentContext };
export { router as gemsRouter };
