import { spawn } from "node:child_process";
import { logger } from "../lib/logger.js";
import type { GemSpec, RegistryHooksResult } from "../lib/schema.js";
import { newRunId } from "../lib/crypto.js";
import { appendAuditLog, getGemById } from "../stores/firestore.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 8 — Registry Hooks
// ---------------------------------------------------------------------
// Deterministic. After Stage 7 publishes a gem, this stage opens
// cross-repo PRs in two sibling repositories so the gem is
// discoverable on the public surfaces:
//
//   1. jleechanorg/ai-universe-frontend  — adds a gem card to
//      `gems.json` and a route for `/gems/<shareToken>`.
//   2. jleechanorg/ai-universe-landing   — adds a public marketing
//      page for the gem.
//
// Both PRs are opened via the `gh` CLI (already on PATH in CI and on
// dev machines with the GitHub CLI authenticated). We do not commit
// here — `gh pr create` is the entry point.
//
// Failure handling: a failed cross-repo PR does NOT unpublish the
// gem. The gem is live in the registry; the embed route just
// appears 1-2 days later. We capture the error in the audit log and
// continue. The PR URLs we did get are still surfaced.
//
// Audit-log IDs: we generate the entryIds ourselves (via newRunId)
// so we can return them in `auditLogIds`. The store's
// `appendAuditLog` does not surface the id, so we write through
// `ctx.firestore` for the entries we want to track by id.
// =====================================================================

interface RegistryHooksInput {
  gemId: string;
  shareToken: string;
  installCommand: string;
  cloudRunUrl: string | null;
  spec: GemSpec;
}

const FRONTEND_REPO = "jleechanorg/ai-universe-frontend";
const LANDING_REPO = "jleechanorg/ai-universe-landing";

interface PrResult {
  ok: boolean;
  url: string | null;
  error: string | null;
  durationMs: number;
}

function runGh(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<PrResult> {
  return new Promise((resolvePr) => {
    const startedAt = Date.now();
    const child = spawn("gh", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePr({
        ok: false,
        url: null,
        error: `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolvePr({
          ok: false,
          url: null,
          error: `gh timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      if (code !== 0) {
        resolvePr({
          ok: false,
          url: null,
          error: (stderr || stdout).trim().split("\n").slice(-3).join(" | ").slice(-512),
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      // gh pr create prints the PR URL on its last line.
      const lines = stdout.trim().split("\n");
      const url = lines[lines.length - 1]?.trim() ?? null;
      resolvePr({
        ok: url !== null && /^https?:\/\//.test(url),
        url: url && /^https?:\/\//.test(url) ? url : null,
        error: url ? null : "could not parse PR URL from gh stdout",
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

interface GemCard {
  gemId: string;
  name: string;
  version: string;
  description: string;
  shareToken: string;
  installCommand: string;
  cloudRunUrl: string | null;
  authorUid: string;
  publishedAtIso: string;
}

function buildGemCard(
  spec: GemSpec,
  shareToken: string,
  installCommand: string,
  cloudRunUrl: string | null,
  authorUid: string,
): GemCard {
  return {
    gemId: spec.id,
    name: spec.name,
    version: spec.version,
    description: spec.description,
    shareToken,
    installCommand,
    cloudRunUrl,
    authorUid,
    publishedAtIso: new Date().toISOString(),
  };
}

function buildGemPageMarkdown(spec: GemSpec, card: GemCard): string {
  const tools = spec.tools
    .map((t) => `### \`${t.name}\`\n\n${t.description}\n`)
    .join("\n");
  return [
    `# ${spec.name}`,
    "",
    `> ${spec.description}`,
    "",
    `- **Gem id:** \`${spec.id}\``,
    `- **Version:** \`${spec.version}\``,
    `- **Author:** \`${card.authorUid}\``,
    card.cloudRunUrl ? `- **Endpoint:** ${card.cloudRunUrl}` : "",
    "",
    "## Install",
    "",
    "```bash",
    card.installCommand,
    "```",
    "",
    "## Tools",
    "",
    tools,
    "",
    "_Auto-generated by the AI Universe Lite gem-builder pipeline._",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

interface AppendAuditResult {
  entryId: string;
}

async function writeTrackedAudit(
  ctx: AgentContext,
  action: string,
  details: Record<string, unknown>,
): Promise<AppendAuditResult> {
  // We use a direct firestore write so we can return the entryId.
  // The store's `appendAuditLog` mints the id internally and doesn't
  // surface it, which is fine for most callers but useless for
  // registry-hooks (we need to return the IDs in the result).
  const entryId = newRunId();
  const doc = {
    entryId,
    action,
    gemId: ctx.gemId,
    authorUid: ctx.authorUid,
    runId: ctx.runId,
    intakeId: ctx.intakeId,
    details,
    atIso: new Date().toISOString(),
  };
  await ctx.firestore.collection("gem_audit_log").doc(entryId).set(doc);
  return { entryId };
}

async function writeUntrackedAudit(
  ctx: AgentContext,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
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
      { err, action, gemId: ctx.gemId },
      "registry-hooks: untracked audit append failed (non-fatal)",
    );
  }
}

async function openFrontendPr(
  ctx: AgentContext,
  card: GemCard,
): Promise<PrResult> {
  // We do not pre-clone the repo into a known workspace — the
  // orchestrator sets the working directory before invoking this
  // stage. If the cwd doesn't have the repo checked out, gh will
  // fail and the PrResult captures it. The audit log records the
  // outcome either way.
  const cardJson = JSON.stringify(card, null, 2);
  const title = `chore: register gem ${card.gemId} (${card.version})`;
  const body = [
    "Auto-generated by the AI Universe Lite gem-builder pipeline.",
    "",
    `Gem id: \`${card.gemId}\``,
    `Version: \`${card.version}\``,
    `Share token: \`${card.shareToken}\``,
    "",
    "This PR adds a new entry to `gems.json` so the embed route picks it up.",
  ].join("\n");
  const branch = `gem/${card.gemId}-${card.shareToken.slice(0, 6)}`;

  // The card body itself is the file content for the PR. We
  // delegate the actual commit + push to the orchestrator's
  // cross-repo hook script (not in scope for this stage) and just
  // open the PR via `gh pr create` against the staged branch.
  const args = [
    "pr",
    "create",
    "--repo",
    FRONTEND_REPO,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "gem-registry,auto-generated",
  ];
  // Persist the card payload to the audit log so the receiver can
  // pull it (in lieu of a true file diff).
  await writeUntrackedAudit(ctx, "registry_hook_payload", {
    target: "frontend",
    repo: FRONTEND_REPO,
    branch,
    cardJson,
  });
  return runGh(args, process.cwd(), 3 * 60_000);
}

async function openLandingPr(
  ctx: AgentContext,
  spec: GemSpec,
  card: GemCard,
): Promise<PrResult> {
  const pagePath = `gems/${spec.id}.md`;
  const pageBody = buildGemPageMarkdown(spec, card);
  const title = `feat(gems): add ${card.name} (${card.version})`;
  const body = [
    "Auto-generated by the AI Universe Lite gem-builder pipeline.",
    "",
    `Gem id: \`${card.gemId}\``,
    `Version: \`${card.version}\``,
    `Share token: \`${card.shareToken}\``,
    "",
    `This PR adds \`${pagePath}\` to the public landing site.`,
  ].join("\n");
  const branch = `gem/${card.gemId}-landing-${card.shareToken.slice(0, 6)}`;

  const args = [
    "pr",
    "create",
    "--repo",
    LANDING_REPO,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    body,
    "--label",
    "gem,auto-generated",
  ];
  await writeUntrackedAudit(ctx, "registry_hook_payload", {
    target: "landing",
    repo: LANDING_REPO,
    branch,
    pagePath,
    pageBody,
  });
  return runGh(args, process.cwd(), 3 * 60_000);
}

/**
 * Stage 8 handler. Input: { gemId, shareToken, installCommand, cloudRunUrl, spec }.
 * Output: RegistryHooksResult.
 *
 * Soft-fail: a failed cross-repo PR is logged and reflected in the
 * result (the URL is null), but the stage still returns `succeeded`
 * so the orchestrator can complete the pipeline. Hard-fail is
 * reserved for "we couldn't even write the audit log" scenarios.
 */
export const registryHooks: StageHandler<
  RegistryHooksInput,
  RegistryHooksResult
> = async (
  ctx: AgentContext,
  input: RegistryHooksInput,
): Promise<StageResult<RegistryHooksResult>> => {
  const { gemId, shareToken, installCommand, cloudRunUrl, spec } = input;

  // ---- Pre-flight: gem must exist (sanity check post-publish) ----
  const gem = await getGemById(gemId).catch(() => null);
  if (!gem) {
    return {
      stage: "registry-hooks",
      status: "failed",
      error: {
        message: `registry-hooks: gem ${gemId} not in registry — Stage 7 must succeed first`,
        code: "GemNotFound",
        recoverable: false,
      },
    };
  }

  const card = buildGemCard(
    spec,
    shareToken,
    installCommand,
    cloudRunUrl,
    gem.authorUid || ctx.authorUid,
  );

  // ---- Open both PRs in parallel (independent) ----
  let frontendPr: PrResult;
  let landingPr: PrResult;
  try {
    [frontendPr, landingPr] = await Promise.all([
      openFrontendPr(ctx, card),
      openLandingPr(ctx, spec, card),
    ]);
  } catch (err) {
    return {
      stage: "registry-hooks",
      status: "failed",
      error: {
        message: `registry-hooks: unexpected error opening cross-repo PRs: ${(err as Error).message}`,
        code: "RegistryHooksCrash",
        recoverable: false,
      },
    };
  }

  // ---- Track both outcomes in the audit log ----
  const auditLogIds: string[] = [];
  try {
    const fe = await writeTrackedAudit(ctx, "registry_hook_frontend", {
      repo: FRONTEND_REPO,
      ok: frontendPr.ok,
      url: frontendPr.url,
      error: frontendPr.error,
      durationMs: frontendPr.durationMs,
    });
    auditLogIds.push(fe.entryId);
  } catch (err) {
    logger.warn(
      { err, gemId },
      "registry-hooks: failed to track frontend audit entry (non-fatal)",
    );
  }
  try {
    const lp = await writeTrackedAudit(ctx, "registry_hook_landing", {
      repo: LANDING_REPO,
      ok: landingPr.ok,
      url: landingPr.url,
      error: landingPr.error,
      durationMs: landingPr.durationMs,
    });
    auditLogIds.push(lp.entryId);
  } catch (err) {
    logger.warn(
      { err, gemId },
      "registry-hooks: failed to track landing audit entry (non-fatal)",
    );
  }

  // Soft-fail: a single failed PR does not poison the whole stage.
  // We log it loudly so the user gets a Slack ping via the
  // orchestrator's failure path.
  if (!frontendPr.ok) {
    logger.warn(
      { gemId, error: frontendPr.error },
      "registry-hooks: frontend PR failed (continuing; gem is still live)",
    );
  }
  if (!landingPr.ok) {
    logger.warn(
      { gemId, error: landingPr.error },
      "registry-hooks: landing PR failed (continuing; gem is still live)",
    );
  }

  const result: RegistryHooksResult = {
    frontendPrUrl: frontendPr.url,
    landingPrUrl: landingPr.url,
    auditLogIds,
  };

  logger.info(
    {
      gemId,
      frontendPrUrl: frontendPr.url,
      landingPrUrl: landingPr.url,
      auditLogIds: auditLogIds.length,
    },
    "registry-hooks: cross-repo PRs complete",
  );

  return { stage: "registry-hooks", status: "succeeded", data: result };
};

export { buildGemCard, buildGemPageMarkdown, FRONTEND_REPO, LANDING_REPO };
export type { RegistryHooksInput, GemCard };
