import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../lib/logger.js";
import type { DeployEnv, DeployResult } from "../lib/schema.js";
import { appendAuditLog, getGemById } from "../stores/firestore.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 7.5 — Deployer
// ---------------------------------------------------------------------
// Deterministic. Wraps `scripts/deploy-gem.sh` (the same Cloud Run
// contract as `jleechanorg/ai_universe/deploy.sh`) and writes the
// resulting cloudRunUrl back onto the gem registry row.
//
// Inputs:
//   - gemId  : registry id (kebab-case)
//   - env    : 'dev' | 'staging' | 'prod' (prod is gated)
//   - semver : the gem's semver; used to compose the GCR image tag
//   - gcrImage (optional): override the default
//     `gcr.io/ai-universe-2025/gem-<id>:<semver>` image. Falls back to
//     that default if absent.
//
// Prod guard: mirrors `scripts/deploy-gem.sh` lines 15-20. Local
// `prod` deploys are blocked unless GITHUB_ACTIONS or
// ALLOW_LOCAL_PROD_DEPLOY is set. The shell script enforces the same
// rule, so we return early with a clear error before shelling out —
// the script's stderr is not the first place the orchestrator should
// look for the reason.
//
// cloudRunUrl extraction: the gcloud `run deploy` command prints the
// deployed URL on its last line. We also fall back to
// `gcloud run services describe` if the script's stdout doesn't
// contain a parseable URL (it can be silenced by `--quiet`).
// =====================================================================

const REPO_ROOT = resolve(process.cwd());
const DEPLOY_SCRIPT = resolve(REPO_ROOT, "scripts", "deploy-gem.sh");
const DEFAULT_PROJECT = "ai-universe-2025";
const DEFAULT_REGION = "us-central1";
const DEFAULT_REGISTRY = `gcr.io/${DEFAULT_PROJECT}`;

const DEPLOY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes for build + deploy

interface DeployerInput {
  gemId: string;
  env: DeployEnv;
  semver: string;
  /** Optional explicit image; defaults to `gcr.io/.../gem-<id>:<semver>`. */
  gcrImage?: string;
}

interface SpawnOutcome {
  status: "pass" | "fail" | "skip";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

function defaultImage(gemId: string, semver: string): string {
  return `${DEFAULT_REGISTRY}/gem-${gemId}:${semver}`;
}

function assertProdGuard(env: DeployEnv): string | null {
  if (env !== "prod") return null;
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const allowed = process.env.ALLOW_LOCAL_PROD_DEPLOY === "true";
  if (inActions || allowed) return null;
  return (
    "prod gem deploys are blocked locally. " +
    "Set GITHUB_ACTIONS=true (in CI) or ALLOW_LOCAL_PROD_DEPLOY=true " +
    "(Jeffrey-only override) before retrying. " +
    "Production deploys normally go through " +
    "https://github.com/jleechanorg/ai_universe_lite/actions/workflows/gem-publish.yml"
  );
}

function runShell(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnOutcome> {
  return new Promise((resolveOutcome) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
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
      resolveOutcome({
        status: "fail",
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = !timedOut && (code === 0 || code === null);
      resolveOutcome({
        status: ok ? "pass" : "fail",
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
  });
}

const URL_RE = /https:\/\/[a-z0-9-]+-[a-z0-9-]+(?:\.|\.a\.)run\.app/i;
const SERVICE_URL_RE = /https:\/\/([a-z0-9][a-z0-9-]*-[a-z0-9-]+)\.a\.run\.app/i;

function parseCloudRunUrl(stdout: string, gemId: string, env: DeployEnv): string | null {
  // 1) gcloud's "Service URL: …" line.
  const serviceLine = stdout.match(/Service URL:\s*(\S+)/i);
  if (serviceLine && serviceLine[1]) {
    return serviceLine[1].trim();
  }
  // 2) gcloud's last-line "Deployed service …" with a URL.
  const m = stdout.match(URL_RE);
  if (m) return m[0];
  // 3) The deploy.gem.sh.tmpl template prints
  //    `✅ Deployed: https://<service>-<projectNum>.a.run.app`.
  const tpl = stdout.match(SERVICE_URL_RE);
  if (tpl) return tpl[0];
  // 4) Construct the conventional URL from gemId + env (Cloud Run
  //    defaults to <service>-<project-number>.a.run.app; we only know
  //    the project number from gcloud, so we can't fully reconstruct
  //    it here. Return null and let the caller fall back to
  //    `gcloud run services describe`.)
  void gemId;
  void env;
  return null;
}

async function fetchServiceUrl(
  service: string,
): Promise<string | null> {
  const outcome = await runShell(
    "gcloud",
    [
      "run",
      "services",
      "describe",
      service,
      "--region",
      DEFAULT_REGION,
      "--project",
      DEFAULT_PROJECT,
      "--format",
      "value(status.url)",
    ],
    REPO_ROOT,
    60_000,
  );
  if (outcome.status !== "pass") return null;
  const url = outcome.stdout.trim();
  return url.length > 0 ? url : null;
}

async function writeAudit(
  ctx: AgentContext,
  details: Record<string, unknown>,
): Promise<void> {
  try {
    await appendAuditLog({
      action: "deploy",
      gemId: ctx.gemId,
      authorUid: ctx.authorUid,
      runId: ctx.runId,
      intakeId: ctx.intakeId,
      details,
    });
  } catch (err) {
    logger.warn(
      { err, gemId: ctx.gemId, runId: ctx.runId },
      "deployer: audit-log append failed (non-fatal)",
    );
  }
}

/**
 * Stage 7.5 handler. Input: { gemId, env, semver, gcrImage? }.
 * Output: DeployResult.
 */
export const deployer: StageHandler<DeployerInput, DeployResult> = async (
  ctx: AgentContext,
  input: DeployerInput,
): Promise<StageResult<DeployResult>> => {
  const { gemId, env, semver, gcrImage } = input;

  if (!gemId || !env || !semver) {
    return {
      stage: "deploy",
      status: "failed",
      error: {
        message: `deployer: missing required field (gemId=${gemId}, env=${env}, semver=${semver})`,
        code: "MissingInput",
        recoverable: false,
      },
    };
  }

  // ---- Prod guard (mirror of scripts/deploy-gem.sh) ----
  const blocked = assertProdGuard(env);
  if (blocked) {
    await writeAudit(ctx, {
      env,
      semver,
      outcome: "blocked",
      reason: "prod_guard",
    });
    return {
      stage: "deploy",
      status: "failed",
      error: {
        message: blocked,
        code: "ProdGuardBlocked",
        recoverable: false,
      },
    };
  }

  // ---- Pre-flight: script must exist ----
  if (!existsSync(DEPLOY_SCRIPT)) {
    return {
      stage: "deploy",
      status: "failed",
      error: {
        message: `deployer: script not found at ${DEPLOY_SCRIPT}`,
        code: "DeployScriptMissing",
        recoverable: false,
      },
    };
  }

  // ---- Pre-flight: gem row must exist in the registry ----
  const gem = await getGemById(gemId).catch(() => null);
  if (!gem) {
    return {
      stage: "deploy",
      status: "failed",
      error: {
        message: `deployer: gem ${gemId} not found in registry — run Stage 7 publish first`,
        code: "GemNotFound",
        recoverable: false,
      },
    };
  }

  const image = gcrImage ?? defaultImage(gemId, semver);
  const service = `gem-${gemId}-${env}`;

  logger.info(
    { gemId, env, semver, service, image },
    "deployer: invoking deploy-gem.sh",
  );

  // ---- Shell out ----
  const args = [DEPLOY_SCRIPT, gemId, env, semver, image];
  const outcome = await runShell("bash", args, REPO_ROOT, DEPLOY_TIMEOUT_MS);

  if (outcome.status !== "pass") {
    await writeAudit(ctx, {
      env,
      semver,
      image,
      service,
      outcome: "failed",
      exitCode: outcome.exitCode,
      timedOut: outcome.timedOut,
      stdoutTail: outcome.stdout.slice(-2048),
      stderrTail: outcome.stderr.slice(-2048),
    });
    return {
      stage: "deploy",
      status: "failed",
      error: {
        message: `deploy-gem.sh failed for ${gemId} (env=${env}, exit=${outcome.exitCode ?? "n/a"}): ${outcome.stderr.slice(-1024) || outcome.stdout.slice(-1024)}`,
        code: outcome.timedOut ? "DeployTimeout" : "DeployFailed",
        recoverable: false,
      },
    };
  }

  // ---- Resolve cloudRunUrl ----
  let cloudRunUrl = parseCloudRunUrl(outcome.stdout, gemId, env);
  if (!cloudRunUrl) {
    cloudRunUrl = await fetchServiceUrl(service);
  }
  if (!cloudRunUrl) {
    // The deploy succeeded but we couldn't discover the URL. We still
    // return success with a sentinel URL so the registry row is
    // updated; the orchestrator can surface a "verify URL" follow-up.
    cloudRunUrl = `https://${service}-${DEFAULT_PROJECT}.a.run.app`;
    logger.warn(
      { gemId, env, service },
      "deployer: cloudRunUrl not discovered; using conventional fallback",
    );
  }

  const deployedAt = new Date().toISOString();

  // ---- Persist cloudRunUrl, deployedAt, deployedEnv on the gem row ----
  // The GemSchema in lib/schema.ts does not include `deployedAt` or
  // `deployedEnv`, so we patch the Firestore document directly with
  // extra fields. Firestore accepts arbitrary fields; downstream
  // readers tolerate the addition. (Future chunk will extend GemSchema.)
  try {
    await ctx.firestore
      .collection("gems")
      .doc(gemId)
      .set(
        {
          cloudRunUrl,
          deployedAt,
          deployedEnv: env,
          status: env === "prod" ? "live" : gem.status ?? "building",
          updatedAtIso: deployedAt,
        },
        { merge: true },
      );
  } catch (err) {
    logger.warn(
      { err, gemId, env },
      "deployer: failed to patch gem registry row (non-fatal)",
    );
  }

  await writeAudit(ctx, {
    env,
    semver,
    image,
    service,
    cloudRunUrl,
    outcome: "succeeded",
    durationMs: outcome.durationMs,
  });

  const result: DeployResult = {
    cloudRunUrl,
    deployedAt,
    deployedEnv: env,
    semver,
    gemId,
  };

  logger.info(
    { gemId, env, semver, cloudRunUrl, durationMs: outcome.durationMs },
    "deployer: gem deployed",
  );

  return { stage: "deploy", status: "succeeded", data: result };
};

export { assertProdGuard, parseCloudRunUrl, defaultImage };
export type { DeployerInput };
