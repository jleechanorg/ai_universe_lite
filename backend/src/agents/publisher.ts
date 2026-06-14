import { newShareToken } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import type {
  EvaluationRunReport,
  GemBuildResult,
  GemSpec,
  PublishResult,
  VerifyRunReport,
} from "../lib/schema.js";
import {
  appendAuditLog,
  createGem,
  getGemById,
} from "../stores/firestore.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 7 — Publisher
// ---------------------------------------------------------------------
// Deterministic. Writes the validated gem to the Firestore `gems/<id>`
// collection, mints a share token + install command, and appends an
// audit-log entry for the publish action.
//
// Idempotency: if a gem with the same id already exists (e.g. a retry
// of the same orchestrator run, or a deliberate republish), we
// re-mint the share token and install command on the existing record
// rather than failing. The audit log captures every republish so the
// history is never lost.
//
// Output: `PublishResult { shareToken, installCommand, gemId, runId,
// createdAtIso }` — the orchestrator surfaces this on the
// /api/gems/<runId> polling endpoint.
// =====================================================================

interface PublisherInput {
  gemPath: string;
  spec: GemSpec;
  build: GemBuildResult;
  verify: VerifyRunReport;
  evaluate: EvaluationRunReport;
}

function buildInstallCommand(gemId: string): string {
  // Pattern mirrors the example in the Stage 7 spec:
  //   npx fastmcp install --from gem-<id>@npm <id>
  // We emit a leading space-separated form so it pastes cleanly into
  // a terminal. The npm package name `gem-<id>` matches the
  // `@ai-universe-lite/gem-<id>` private-name used by Stage 4.
  return `npx fastmcp install --from gem-${gemId}@npm ${gemId}`;
}

async function writeAudit(
  ctx: AgentContext,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  // Firestore has no enforced transaction here; we accept the small
  // window where the gem write succeeds but the audit write fails.
  // The next publish (or a re-run) will close the gap.
  try {
    await appendAuditLog({
      action,
      gemId: ctx.gemId,
      authorUid: ctx.authorUid,
      runId: ctx.runId,
      intakeId: ctx.intakeId,
      details,
    });
  } catch (err) {
    logger.warn(
      { err, action, gemId: ctx.gemId, runId: ctx.runId },
      "publisher: audit-log append failed (non-fatal)",
    );
  }
}

/**
 * Stage 7 handler. Input: { gemPath, spec, build, verify, evaluate }.
 * Output: PublishResult.
 */
export const publisher: StageHandler<PublisherInput, PublishResult> = async (
  ctx: AgentContext,
  input: PublisherInput,
): Promise<StageResult<PublishResult>> => {
  const { spec } = input;
  const gemId = spec.id;

  if (!gemId) {
    return {
      stage: "publish",
      status: "failed",
      error: {
        message: "publisher: spec.id is empty — cannot mint share token",
        code: "MissingGemId",
        recoverable: false,
      },
    };
  }

  try {
    // ---- Re-mint share token + install command (deterministic) ----
    const shareToken = newShareToken();
    const installCommand = buildInstallCommand(gemId);

    // ---- Upsert the gem registry row ----
    // Check first; if it exists, we patch in the new share token +
    // install command. If it doesn't, we go through createGem so the
    // store's defaults (status="building", createdAtIso, etc.) are
    // applied consistently.
    const existing = await getGemById(gemId).catch(() => null);

    let gem: { gemId: string; createdAtIso: string };
    if (existing) {
      // Republish: keep the original createdAtIso, refresh shareToken
      // + installCommand. We use a direct firestore write because the
      // store does not yet expose updateGem().
      await ctx.firestore
        .collection("gems")
        .doc(gemId)
        .set(
          {
            shareToken,
            installCommand,
            version: spec.version,
            name: spec.name,
            description: spec.description,
            updatedAtIso: new Date().toISOString(),
          },
          { merge: true },
        );
      gem = { gemId: existing.gemId, createdAtIso: existing.createdAtIso };
      logger.info({ gemId, runId: ctx.runId }, "publisher: gem republished");
    } else {
      const created = await createGem({
        id: gemId,
        name: spec.name,
        version: spec.version,
        description: spec.description,
        authorUid: ctx.authorUid || spec.authorUid,
        visibility: "unlisted",
        runId: ctx.runId,
        intakeId: ctx.intakeId,
      });
      // createGem() mints its own shareToken internally. If we want
      // the shareToken we just generated, we patch the row to use it.
      // This keeps the store's invariant ("shareToken is always set")
      // and still gives the caller the exact token we just minted.
      await ctx.firestore
        .collection("gems")
        .doc(gemId)
        .set(
          {
            shareToken,
            installCommand,
            updatedAtIso: new Date().toISOString(),
          },
          { merge: true },
        );
      gem = { gemId: created.gemId, createdAtIso: created.createdAtIso };
      logger.info({ gemId, runId: ctx.runId }, "publisher: gem created");
    }

    // ---- Audit log ----
    await writeAudit(ctx, "publish", {
      shareToken,
      installCommand,
      version: spec.version,
      toolCount: spec.tools.length,
      verifyTypeCheck: input.verify.typeCheck,
      verifyLint: input.verify.lint,
      verifyTests: input.verify.tests,
      verifyBuild: input.verify.build,
      evalPassed: input.evaluate.summary.passed,
      evalTotal: input.evaluate.summary.total,
    });

    const result: PublishResult = {
      shareToken,
      installCommand,
      gemId: gem.gemId,
      runId: ctx.runId,
      createdAtIso: gem.createdAtIso,
    };

    return { stage: "publish", status: "succeeded", data: result };
  } catch (err) {
    return {
      stage: "publish",
      status: "failed",
      error: {
        message: `publisher failed: ${(err as Error).message}`,
        code: "PublisherError",
        recoverable: false,
      },
    };
  }
};

export { buildInstallCommand };
export type { PublisherInput };
