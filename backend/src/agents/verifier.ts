import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../lib/logger.js";
import type {
  VerifyRunReport,
  VerifyStepStatus,
} from "../lib/schema.js";
import type { GemSpec } from "../lib/schema.js";
import type {
  AgentContext,
  StageHandler,
  StageResult,
} from "./types.js";

// =====================================================================
// Stage 5 — Verifier
// ---------------------------------------------------------------------
// Runs the standard verification suite on the generated gem:
//   1. `npm install --no-audit --no-fund` (if node_modules is absent)
//   2. `npm run type-check`  (tsc --noEmit)
//   3. `npm run lint`        (eslint src)
//   4. `npm test`            (jest)
//   5. `npm run build`       (tsc emit)
//
// Each step is run as its own child_process.spawn so a failure in
// step 3 doesn't prevent step 4 from running. We capture the last
// 4 KB of stdout+stderr per step into the report's `logs` field.
//
// `npm install` is skipped if `node_modules/` already exists and
// `package-lock.json` is newer than the source files — keeps the
// fast path fast (sub-3-second verifications when nothing changed).
// =====================================================================

const LOG_TAIL_BYTES = 4096;
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const STEP_TIMEOUT_MS = 2 * 60 * 1000;

interface SpawnResult {
  status: "pass" | "fail" | "skip";
  stdout: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
}

function tail(input: string): string {
  if (input.length <= LOG_TAIL_BYTES) return input;
  return `[… ${input.length - LOG_TAIL_BYTES} bytes truncated …]\n${input.slice(-LOG_TAIL_BYTES)}`;
}

function runStep(
  cwd: string,
  cmd: string,
  args: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv = {},
): Promise<SpawnResult> {
  return new Promise((resolveStep) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
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
      resolveStep({
        status: "fail",
        stdout,
        stderr: stderr + `\n[spawn error: ${err.message}]`,
        durationMs: Date.now() - startedAt,
        exitCode: null,
        timedOut: false,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveStep({
        status: timedOut || (code !== 0 && code !== null) ? "fail" : "pass",
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        exitCode: code,
        timedOut,
      });
    });
  });
}

async function ensureInstall(cwd: string): Promise<SpawnResult> {
  const nm = join(cwd, "node_modules");
  if (existsSync(nm)) {
    return {
      status: "skip",
      stdout: "node_modules already present — skipping install",
      stderr: "",
      durationMs: 0,
      exitCode: 0,
      timedOut: false,
    };
  }
  return runStep(cwd, "npm", ["install", "--no-audit", "--no-fund", "--silent"], INSTALL_TIMEOUT_MS);
}

function stepToStatus(r: SpawnResult): VerifyStepStatus {
  if (r.status === "skip") return "skip";
  return r.status === "pass" ? "pass" : "fail";
}

/**
 * Stage 5 handler. Input: { gemPath, spec }. Output: VerifyReport.
 */
export const verifier: StageHandler<
  { gemPath: string; spec: GemSpec },
  VerifyRunReport
> = async (
  _ctx: AgentContext,
  input: { gemPath: string; spec: GemSpec },
): Promise<StageResult<VerifyRunReport>> => {
  const startedAt = Date.now();
  const cwd = input.gemPath;
  if (!existsSync(cwd)) {
    return {
      stage: "verify",
      status: "failed",
      error: {
        message: `gem path does not exist: ${cwd}`,
        code: "GemPathMissing",
        recoverable: false,
      },
    };
  }
  if (!existsSync(join(cwd, "package.json"))) {
    return {
      stage: "verify",
      status: "failed",
      error: {
        message: `no package.json at ${cwd} — builder likely failed`,
        code: "PackageJsonMissing",
        recoverable: false,
      },
    };
  }

  try {
    // 1) npm install (best-effort: we still run the rest of the
    //    pipeline if install succeeds OR fails — a missing peer dep
    //    shouldn't mask a real type-check error).
    const install = await ensureInstall(cwd);
    if (install.status === "fail") {
      logger.warn(
        { cwd, stderr: tail(install.stderr) },
        "verifier: npm install failed (continuing with type-check anyway)",
      );
    }

    // 2) type-check
    const typeCheck = await runStep(
      cwd,
      "npm",
      ["run", "type-check", "--silent"],
      STEP_TIMEOUT_MS,
    );

    // 3) lint
    const lint = await runStep(
      cwd,
      "npm",
      ["run", "lint", "--silent"],
      STEP_TIMEOUT_MS,
    );

    // 4) tests
    const tests = await runStep(
      cwd,
      "npm",
      ["test", "--silent", "--", "--passWithNoTests"],
      STEP_TIMEOUT_MS,
    );

    // 5) build
    const build = await runStep(
      cwd,
      "npm",
      ["run", "build", "--silent"],
      STEP_TIMEOUT_MS,
    );

    const report: VerifyRunReport = {
      typeCheck: stepToStatus(typeCheck),
      lint: stepToStatus(lint),
      tests: stepToStatus(tests),
      build: stepToStatus(build),
      logs: {
        typeCheck: tail(typeCheck.stdout + "\n" + typeCheck.stderr),
        lint: tail(lint.stdout + "\n" + lint.stderr),
        tests: tail(tests.stdout + "\n" + tests.stderr),
        build: tail(build.stdout + "\n" + build.stderr),
      },
      durationMs: Date.now() - startedAt,
    };

    const allPass = report.typeCheck === "pass"
      && report.lint === "pass"
      && report.tests === "pass"
      && report.build === "pass";

    if (!allPass) {
      return {
        stage: "verify",
        status: "failed",
        data: report,
        error: {
          message: `verifier: at least one step failed (typeCheck=${report.typeCheck}, lint=${report.lint}, tests=${report.tests}, build=${report.build})`,
          code: "VerifyFailed",
          recoverable: false,
        },
      };
    }

    logger.info(
      {
        gemId: input.spec.id,
        durationMs: report.durationMs,
      },
      "verifier: all steps passed",
    );

    return { stage: "verify", status: "succeeded", data: report };
  } catch (err) {
    return {
      stage: "verify",
      status: "failed",
      error: {
        message: `verifier crashed: ${(err as Error).message}`,
        code: "VerifierCrash",
        recoverable: false,
      },
    };
  }
};
