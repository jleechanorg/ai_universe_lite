# Gem-Builder — Architecture

> A single user prompt → a self-contained, shareable, versioned MCP "Gem" deployed to its own Cloud Run service.

## Summary

The gem-builder is an 8-stage pipeline that turns a natural-language prompt (plus optional
reference uploads) into a live MCP server, deployed to its own Cloud Run service, registered
in a Firestore registry, and announced via cross-repo PRs. Three stages (Brainstorm, Spec,
Evaluate) are managed Claude agents; the other five are deterministic TypeScript + `gcloud`.
The pipeline is **resumable**, **idempotent**, and **idempotent on retry** — every stage
writes a slot in `gem_runs/<runId>` so a crash mid-build can be resumed from the next stage.

## Table of Contents

- [1. Overview](#1-overview)
- [2. The 8 stages at a glance](#2-the-8-stages-at-a-glance)
- [3. Per-stage detail](#3-per-stage-detail)
  - [3.1 Stage 1 — INTAKE](#31-stage-1--intake)
  - [3.2 Stage 2 — BRAINSTORM](#32-stage-2--brainstorm)
  - [3.3 Stage 3 — SPEC](#33-stage-3--spec)
  - [3.4 Stage 4 — BUILD](#34-stage-4--build)
  - [3.5 Stage 5 — VERIFY](#35-stage-5--verify)
  - [3.6 Stage 6 — EVALUATE](#36-stage-6--evaluate)
  - [3.7 Stage 7 — PUBLISH](#37-stage-7--publish)
  - [3.8 Stage 7.5 — DEPLOY](#38-stage-75--deploy)
  - [3.9 Stage 8 — REGISTRY HOOKS](#39-stage-8--registry-hooks)
- [4. Resumable / idempotent state machine](#4-resumable--idempotent-state-machine)
- [5. Per-stage timeouts and cost](#5-per-stage-timeouts-and-cost)
- [6. Observability: Firestore + audit log](#6-observability-firestore--audit-log)
- [7. Failure semantics](#7-failure-semantics)
- [8. What's NOT in Phase 1](#8-whats-not-in-phase-1)
- [See also](#see-also)

## 1. Overview

```
                  User prompt + refs (multipart, POST /api/gems)
                                  │
                                  ▼
  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │ 1. INTAKE  │─▶│ 2. BRAIN-  │─▶│ 3. SPEC    │─▶│ 4. BUILD   │
  │ determin-  │  │ STORM LLM  │  │ LLM        │  │ determin-  │
  │ istic      │  │ (claude-   │  │ (claude-   │  │ istic      │
  │            │  │ sonnet-4)  │  │ sonnet-4)  │  │            │
  └────────────┘  └────────────┘  └────────────┘  └────────────┘
                                                       │
                                  ┌────────────┐  ┌─────▼──────┐
                                  │ 6. EVALUATE│◀─│ 5. VERIFY  │
                                  │ LLM        │  │ determin-  │
                                  │ (claude-   │  │ istic      │
                                  │ sonnet-4)  │  │            │
                                  └────────────┘  └────────────┘
                                       │                ▲
                                       ▼                │
                                  ┌────────────┐        │
                                  │ 7. PUBLISH │────────┘
                                  │ determin-  │  (writes only after eval passes)
                                  │ istic      │
                                  └────────────┘
                                       │
                                       ▼
                                  ┌────────────┐
                                  │7.5 DEPLOY  │  (Cloud Run, prod-guard mirrored
                                  │ determin-  │   from ai_universe/deploy.sh)
                                  │ istic      │
                                  └────────────┘
                                       │
                                       ▼
                                  ┌────────────┐
                                  │8. REGISTRY │  (cross-repo PRs + audit log;
                                  │  HOOKS     │   soft-fail — does not unpublish)
                                  │ determin-  │
                                  │ istic      │
                                  └────────────┘
```

**Where the LLM lives:** Stages 2, 3, 6 only. Everything else is plain TypeScript + `gcloud` + `git`.

**Why mixed:** LLM judgment for *what to build* (Brainstorm), *how to specify it* (Spec), and
*whether it actually works well* (Evaluate). Determinism for *normalizing inputs, building,
verifying, publishing, deploying, hooking* — fast, reproducible, debuggable, auditable.

## 2. The 8 stages at a glance

| # | Stage | Type | Input → Output | Stage source | Doc |
|---|-------|------|----------------|--------------|-----|
| 1 | Intake | deterministic | `CreateGemRequest` → `IntakeOutput` | `backend/src/agents/stages/01-intake.ts` | [01-intake.md](../backend/src/agents/stages/01-intake.md) |
| 2 | Brainstorm | managed agent | `IntakeOutput` → `BrainstormOutput` | `backend/src/agents/stages/02-brainstorm.ts` | [02-brainstorm.md](../backend/src/agents/stages/02-brainstorm.md) |
| 3 | Spec | managed agent | `BrainstormOutput` → `GemSpec` | `backend/src/agents/stages/03-spec.ts` | [03-spec.md](../backend/src/agents/stages/03-spec.md) |
| 4 | Build | deterministic | `GemSpec` → `GemBuildResult` | `backend/src/agents/stages/04-build.ts` | [04-build.md](../backend/src/agents/stages/04-build.md) |
| 5 | Verify | deterministic | `GemBuildResult` → `VerifyReport` | `backend/src/agents/stages/05-verify.ts` | [05-verify.md](../backend/src/agents/stages/05-verify.md) |
| 6 | Evaluate | managed agent | `VerifyReport` + source → `EvaluationReport` | `backend/src/agents/stages/06-evaluate.ts` | [06-evaluate.md](../backend/src/agents/stages/06-evaluate.md) |
| 7 | Publish | deterministic | `EvaluationReport` → `GemRegistryEntry` | `backend/src/agents/stages/07-publish.ts` | [07-publish.md](../backend/src/agents/stages/07-publish.md) |
| 7.5 | Deploy | deterministic | `GemBuildResult` → Cloud Run URL | `backend/src/agents/stages/07.5-deploy.ts` | [07.5-deploy.md](../backend/src/agents/stages/07.5-deploy.md) |
| 8 | Registry Hooks | deterministic | `GemRegistryEntry` → cross-repo PRs + audit log | `backend/src/agents/stages/08-registry-hooks.ts` | [08-registry-hooks.md](../backend/src/agents/stages/08-registry-hooks.md) |

The pipeline orchestrator lives at `backend/src/agents/runner.ts` (it dispatches each stage
handler in order, advances `stage` on success, and is responsible for resume logic; the
schema for `PipelineRun` is `backend/src/lib/schema.ts → PipelineRunSchema`).

## 3. Per-stage detail

For every stage: input shape, output shape, who's responsible (LLM vs deterministic),
retry policy, and the observability hooks (which Firestore slots get written, which audit
log entries get appended). All schemas are Zod-defined in `backend/src/lib/schema.ts`.

### 3.1 Stage 1 — INTAKE

- **Source:** `backend/src/agents/stages/01-intake.ts`
- **Type:** deterministic
- **Input shape** — `IntakeInputSchema`:

  ```ts
  {
    prompt: string,             // 8..8000 chars
    refPaths: string[],          // 0..N GCS paths (already uploaded via POST /api/refs)
    authorUid: string,           // Firebase UID
    visibility: "private" | "unlisted" | "public",  // default "unlisted"
  }
  ```

- **Output shape** — `IntakeOutputSchema`:

  ```ts
  {
    intakeId: "intk_<16>",          // e.g. "intk_a1b2c3d4e5f6g7h8"
    gcsRefPrefix: "intake/<intakeId>/",
    authorUid: string,
    prompt: string,
    visibility: "private" | "unlisted" | "public",
  }
  ```

- **Responsibility:** deterministic. Pure normalizer — generates the `intakeId`, moves the
  user's uploaded refs from `gs://ai-universe-lite-refs/tmp/<uploadId>/...` to
  `gs://ai-universe-lite-refs/intake/<intakeId>/...`, persists an `IntakeOutput` row to
  `gem_intakes/<intakeId>`, and creates a fresh `PipelineRun` at `gem_runs/<runId>` with
  `stage="01-intake"` and the `intake` slot populated.

- **Retry policy:** single retry on Firestore write failure; second failure → HTTP 503
  `intake_persist_failed`. No LLM to retry; the stage either normalizes correctly or it
  doesn't.

- **Firestore writes:**
  - `gem_intakes/<intakeId>` — full `IntakeOutput`
  - `gem_runs/<runId>` — new doc, `stage="01-intake"`, `state.intake=<output>`

- **Audit log entries:**
  - `gem_audit_log` row: `{ type: "intake.created", runId, intakeId, authorUid, visibility, ts }`

- **Timeout:** 5 s
- **Cost:** ~0 (no LLM, no Cloud Run egress)

### 3.2 Stage 2 — BRAINSTORM

- **Source:** `backend/src/agents/stages/02-brainstorm.ts` (wraps `backend/src/agents/brainstormer.ts`)
- **Type:** managed Claude agent
- **Input shape** — the previous stage's `IntakeOutput` (so the agent has the prompt +
  `gcsRefPrefix` to fetch refs from).
- **Output shape** — `BrainstormOutputSchema`:

  ```ts
  {
    featureSet: string[],        // >= 1, e.g. ["character sheet", "dice roller", "initiative tracker"]
    tools: { name, purpose, inputs[], outputs[] }[],
    modelNeeds: ("openai" | "anthropic" | "gemini" | "perplexity" | "openrouter" | "grok")[],
    reasoning: string,           // markdown, 80..2000 chars
  }
  ```

- **Responsibility:** LLM. Loads the system prompt and reference docs from the intake GCS
  prefix, activates the `superpowers-brainstorming` skill (vendored in
  `.claude/skills/superpowers-brainstorming`), and returns the validated
  `BrainstormOutput`.

- **Retry policy:** two attempts total. On validation failure (model returned prose, or
  Zod schema mismatch), the model is called again with the validation error injected. On
  the second failure, the pipeline transitions to `failed` with `stage="02-brainstorm"`.

- **LLM config:** `claude-sonnet-4` default (overridable via `BRAINSTORM_MODEL`); reads
  `ANTHROPIC_API_KEY` from GCP Secret Manager (never from env).

- **Firestore writes:**
  - `gem_runs/<runId>` — `stage="02-brainstorm"`, `state.brainstorm=<output>`, `updatedAtIso`

- **Audit log entries:**
  - On success: `{ type: "brainstorm.completed", runId, intakeId, model, featureCount, ts }`
  - On failure: `{ type: "brainstorm.failed", runId, attempt, error, ts }`

- **Timeout:** 60 s
- **Cost:** ~$0.05–$0.15 (one brainstorm agent call against `claude-sonnet-4`)

### 3.3 Stage 3 — SPEC

- **Source:** `backend/src/agents/stages/03-spec.ts` (wraps `backend/src/agents/spec-generator.ts`)
- **Type:** managed Claude agent
- **Input shape** — the `BrainstormOutput` (from `state.brainstorm`) + the same GCS ref
  prefix.
- **Output shape** — `GemSpecSchema`:

  ```ts
  {
    id: "ai-rpg",                  // kebab-case, [a-z][a-z0-9-]{1,40}
    name: "AI RPG Engine",         // 2..60 chars
    version: "0.1.0",              // semver
    description: string,           // 20..280 chars
    systemPrompt: string,          // 80..8000 chars
    tools: ToolSpec[],             // 1..12 tools
    requiredEnv: string[],         // e.g. ["ANTHROPIC_API_KEY"]
    authorUid: string,
    brainstorm: BrainstormOutput,  // embedded for traceability
  }
  ```

  Each `ToolSpec`:

  ```ts
  {
    name: "roll_dice",             // snake_case
    description: string,           // >= 8 chars
    inputs: [{ name, type, required, description? }],
    output: { type, schema?: unknown },
    prompt?: string,               // LLM tool body
    model?: string,                // e.g. "claude-sonnet-4"
  }
  ```

- **Responsibility:** LLM. Activates `superpowers-brainstorming` skill in `mode=spec-generation`,
  loads refs, returns a `GemSpec` that Zod-validates.

- **Retry policy:** two attempts. Validation failure → re-call with the Zod error message
  injected into the prompt. Second failure → `failed@03-spec`.

- **LLM config:** `claude-sonnet-4` default (overridable via `SPEC_MODEL`); reads
  `ANTHROPIC_API_KEY` from Secret Manager.

- **Firestore writes:**
  - `gem_runs/<runId>` — `stage="03-spec"`, `state.spec=<GemSpec>`

- **Audit log entries:**
  - On success: `{ type: "spec.generated", runId, toolCount, requiredEnv, ts }`
  - On failure: `{ type: "spec.failed", runId, attempt, validationErrors, ts }`

- **Timeout:** 60 s
- **Cost:** ~$0.10–$0.30 (one spec-generation call; longer than brainstorm because the
  output is larger)

### 3.4 Stage 4 — BUILD

- **Source:** `backend/src/agents/stages/04-build.ts`
- **Type:** deterministic
- **Input shape** — the validated `GemSpec`.
- **Output shape** — `GemBuildResultSchema`:

  ```ts
  {
    gemDir: "gems/ai-rpg/",
    files: string[],                  // relative paths
    entrypoint: "src/server.ts",
    imageTag: "gcr.io/ai-universe-2025/gem-ai-rpg:0.1.0",
  }
  ```

- **Responsibility:** deterministic. Pure templating.

  1. Create `gems/<id>/` directory structure.
  2. Render these templates (in `templates/`):
     - `server.ts.tmpl` → `src/server.ts`
     - `tool.ts.tmpl` (one per spec tool) → `src/tools/<tool_name>.ts`
     - `Dockerfile.gem.tmpl` → `Dockerfile.gem`
     - `cloudbuild.gem.tmpl` → `cloudbuild.gem.yaml`
     - `deploy.gem.sh.tmpl` → `deploy.gem.sh`
     - auto-generated `README.md` from gem metadata
     - per-tool `__tests__/<tool_name>.test.ts` skeletons
  3. Write the rendered files to `gems/<id>/` (gitignored except for `ai-rpg`, the v1
     reference gem which is committed).

- **What it does NOT do:** run `npm install`, build the Docker image, call any LLM, touch
  Cloud Run.

- **Retry policy:** no retry. If template rendering throws (missing field, bad regex),
  the failure is deterministic and the user gets a stack trace with `stage="04-build"`.

- **Firestore writes:**
  - `gem_runs/<runId>` — `stage="04-build"`, `state.build=<GemBuildResult>`

- **Audit log entries:**
  - On success: `{ type: "build.rendered", runId, gemId, fileCount, imageTag, ts }`
  - On failure: `{ type: "build.failed", runId, stack, ts }`

- **Timeout:** 10 s
- **Cost:** ~0

### 3.5 Stage 5 — VERIFY

- **Source:** `backend/src/agents/stages/05-verify.ts`
- **Type:** deterministic
- **Input shape** — the `GemBuildResult.gemDir`.
- **Output shape** — `VerifyReportSchema`:

  ```ts
  {
    typeCheckOk: boolean,
    lintOk: boolean,
    unitTestsOk: boolean,
    unitTestCount: integer >= 0,
    durationMs: integer >= 0,
    errors: string[],            // collected from all 3 steps
  }
  ```

- **Responsibility:** deterministic. Runs the standard verification suite on the generated gem:

  ```bash
  cd gems/<id>/
  npm install --no-audit --no-fund
  npm run type-check      # tsc --noEmit
  npm run lint            # eslint src
  npm test                # jest (per-tool unit tests)
  ```

- **Retry policy:** no retry. Verification is a contract — a failure is a real failure. The
  `errors[]` array is surfaced to the user via the `GET /api/gems/<runId>` polling endpoint.

- **Firestore writes:**
  - `gem_runs/<runId>` — `stage="05-verify"`, `state.verify=<VerifyReport>`

- **Audit log entries:**
  - On success: `{ type: "verify.passed", runId, gemId, unitTestCount, durationMs, ts }`
  - On failure: `{ type: "verify.failed", runId, gemId, errors, ts }`

- **Timeout:** 180 s (npm install is the long pole on a cold cache)
- **Cost:** ~0 (no LLM)

### 3.6 Stage 6 — EVALUATE

- **Source:** `backend/src/agents/stages/06-evaluate.ts` (wraps `backend/src/agents/evaluator.ts`)
- **Type:** managed Claude agent
- **Input shape** — the `VerifyReport` + the generated gem source at `gems/<id>/`.
- **Output shape** — `EvaluationReportSchema`:

  ```ts
  {
    overallScore: 0..1,
    passed: boolean,
    probeScores: ProbeScore[],         // see below
    evaluatorModel: "claude-sonnet-4",
    evaluatedAtIso: string,
    notes?: string,
  }
  ```

  Each `ProbeScore`:

  ```ts
  {
    probe: string,
    category: "happy_path" | "edge_case" | "adversarial" | "red_team",
    passed: boolean,
    rationale: string,
    raw?: string,
  }
  ```

- **Responsibility:** LLM. The evaluator agent runs a **fixed probe set**:
  - 5 happy-path probes (one per spec tool minimum)
  - 3 edge-case probes (empty inputs, oversize inputs, bad types)
  - 2 adversarial probes (prompt injection, jailbreak, "ignore previous instructions")
  - 2+ red-team probes (probe the gem's own prompt-injection resistance against its tools)

  Backend computes `overallScore` (mean of pass booleans) and `passed` (score ≥
  `GEM_EVAL_MIN_PASS_RATE` **and** no red_team probe failed when
  `gemEvalHardFailOnRedTeam=true`, the default).

- **Retry policy:** two attempts. On `passed=false` after the first attempt, the evaluator
  re-runs (one shot) to disambiguate flakiness. Persistent `passed=false` → `failed@06-evaluate`
  with `probeScores[]` populated so the user can see what broke.

- **LLM config:** `claude-sonnet-4` default; reads `ANTHROPIC_API_KEY` from Secret Manager.

- **Firestore writes:**
  - `gem_runs/<runId>` — `stage="06-evaluate"`, `state.evaluate=<EvaluationReport>`

- **Audit log entries:**
  - On success: `{ type: "evaluate.passed", runId, gemId, overallScore, ts }`
  - On failure: `{ type: "evaluate.failed", runId, gemId, overallScore, failingProbes, ts }`

- **Meta-eval:** `scripts/eval-meta.ts` (run via `npm run gem:meta-eval`) re-runs the
  evaluator on the evaluator's own outputs. Catches drift in the evaluator over time.
  Becomes CI in Phase 1+.

- **Timeout:** 120 s
- **Cost:** ~$0.20–$0.50 (one evaluator agent call, longer output)

### 3.7 Stage 7 — PUBLISH

- **Source:** `backend/src/agents/stages/07-publish.ts`
- **Type:** deterministic
- **Input shape** — the `EvaluationReport` (gates on `passed=true`).
- **Output shape** — `GemRegistryEntrySchema`:

  ```ts
  {
    gemId, name, version, description, authorUid,
    visibility, shareToken, installCommand,
    cloudRunUrl,        // populated later by Stage 7.5
    status: "building" | "live" | "deleted",
    createdAtIso, updatedAtIso,
  }
  ```

- **Responsibility:** deterministic. Publishing is a CRUD op — LLM in this path is a bug.

  1. Generate `shareToken` (20 chars, custom alphabet `a-z0-9`).
  2. Generate `installCommand` (per-client — `claude mcp add --transport http <id> https://<cloudRunUrl>/mcp`).
  3. Write to Firestore `gems/<gemId>` (key: `gemId`).
  4. Set `status="building"` initially; Stage 7.5 transitions to `"live"` once deploy
     completes.

- **Visibility semantics:**
  - `private` — only `authorUid` can read; share URL returns 404.
  - `unlisted` — anyone with the share token can read; not indexed.
  - `public` — indexed at `/api/registry`; share URL still works.

- **Soft delete:** setting `status="deleted"` keeps the share URL alive (returns 410 Gone)
  for 30 days, then a Cloud Scheduler job (Phase 1) hard-deletes it.

- **Retry policy:** single retry on Firestore write failure; second failure → `failed@07-publish`.

- **Firestore writes:**
  - `gems/<gemId>` — new doc, `GemRegistryEntry` with `status="building"`, `cloudRunUrl=null`
  - `gem_runs/<runId>` — `stage="07-publish"`, `state.publish=<GemRegistryEntry>`

- **Audit log entries:**
  - On success: `{ type: "gem.published", runId, gemId, authorUid, visibility, shareToken, ts }`
  - On failure: `{ type: "publish.failed", runId, attempt, error, ts }`

- **Timeout:** 5 s
- **Cost:** ~0

### 3.8 Stage 7.5 — DEPLOY

- **Source:** `backend/src/agents/stages/07.5-deploy.ts`
- **Type:** deterministic
- **Input shape** — the `GemBuildResult` (for `imageTag`) + the `GemRegistryEntry` (for
  `gemId`, `version`).
- **Output shape** — a `cloudRunUrl: string` that gets written back onto the
  `GemRegistryEntry` (transitioning `status` from `"building"` → `"live"`).
- **Responsibility:** deterministic. Cloud Run deploy via the same `deploy.sh` contract
  as `jleechanorg/ai_universe`. See `docs/cloudrun-deploy.md` for the full contract.

  1. `gcloud builds submit` against `gems/<id>/cloudbuild.gem.yaml`.
  2. `gcloud run deploy gem-<id>-<env>` with the standard env-var set and the secrets the
     spec's `requiredEnv` lists.
  3. Patch `gems/<gemId>` in Firestore with `cloudRunUrl=https://gem-<id>-<env>-<project-num>.a.run.app`
     and `status="live"`.

- **Service name pattern:** `gem-<id>-<env>` where `<env>` ∈ `dev` | `staging` | `prod`.
  Production deploys are gated by the `gem-publish.yml` GitHub Actions workflow with manual
  approval; local `prod` deploys are **blocked** (`ALLOW_LOCAL_PROD_DEPLOY=true` override
  exists but is Jeffrey-only and never committed).

- **Retry policy:** one retry on transient `gcloud` failure (network, IAM token refresh).
  Hard failure (bad image, missing secret, quota exhausted) → `failed@07.5-deploy` with
  the full `gcloud` output.

- **Firestore writes:**
  - `gems/<gemId>` — patches `cloudRunUrl` and `status="live"` on success; rolls back to
    `status="building"` on retry, then `status="failed"` (rare) on hard failure.

- **Audit log entries:**
  - On start: `{ type: "deploy.started", runId, gemId, env, imageTag, ts }`
  - On success: `{ type: "deploy.succeeded", runId, gemId, env, cloudRunUrl, durationMs, ts }`
  - On failure: `{ type: "deploy.failed", runId, gemId, env, error, gcloudTail, ts }`

- **Timeout:** 600 s (Cloud Build can be slow on a cold cache)
- **Cost:** Cloud Run + Cloud Build usage per deploy. The image itself is small (~150 MB
  node:22-alpine + the gem's `node_modules`). Typical deploy: <$0.05 in Cloud Build
  minutes.

### 3.9 Stage 8 — REGISTRY HOOKS

- **Source:** `backend/src/agents/stages/08-registry-hooks.ts`
- **Type:** deterministic
- **Input shape** — the published `GemRegistryEntry` (with `cloudRunUrl` set).
- **Output shape** — the cross-repo PRs that were opened, plus audit-log rows. The
  `PipelineRun` is transitioned to `complete` once Stage 8 finishes.
- **Responsibility:** deterministic. Cross-repo coordination. See
  [`docs/cross-repo-hooks.md`](./cross-repo-hooks.md) for the full contract.

  1. Open a **frontend embed PR** in `jleechanorg/ai_universe_frontend` that registers
     the gem's share URL route + `<GemEmbed>` config block.
  2. Open a **landing-page PR** (if applicable) in `jleechanorg/ai_universe_landing` that
     adds a card to the public registry page.
  3. If `visibility="public"`, post a one-line "new gem available" message to the
     `#ai-universe-gems` Slack channel.
  4. Append the final audit-log row: `{ type: "gem.live", runId, gemId, cloudRunUrl, ts }`.

- **Retry policy:** none. A failed cross-repo PR is **non-fatal** — the gem is already
  live; the embed route simply appears 1-2 days later. The user gets a Slack DM with the
  failed PR link.

- **Firestore writes:**
  - `gems/<gemId>` — append `hookRuns[]` (per-PR status)
  - `gem_runs/<runId>` — `stage="08-registry-hooks"` → `complete` on success

- **Audit log entries:**
  - `{ type: "hooks.frontend.pr_opened", runId, gemId, prUrl, ts }`
  - `{ type: "hooks.landing.pr_opened", runId, gemId, prUrl, ts }`
  - `{ type: "hooks.slack.posted", runId, gemId, channel, ts }`
  - `{ type: "hooks.completed", runId, gemId, okCount, failCount, ts }`
  - On any failure: `{ type: "hooks.failed", runId, gemId, prName, error, ts }`

- **Timeout:** 120 s
- **Cost:** ~0 (just `gh` CLI + Slack webhook calls)

## 4. Resumable / idempotent state machine

`PipelineRun` (Firestore `gem_runs/<runId>`) is the source of truth for pipeline state.
The shape is `PipelineRunSchema`:

```ts
{
  runId: "run_<12>",                // e.g. "run_a1b2c3d4e5f6"
  intakeId: "intk_<16>",
  stage: "queued" | "01-intake" | ... | "08-registry-hooks" | "complete" | "failed",
  state: {
    intake:    IntakeOutput | null,
    brainstorm:BrainstormOutput | null,
    spec:      GemSpec | null,
    build:     GemBuildResult | null,
    verify:    VerifyReport | null,
    evaluate:  EvaluationReport | null,
    publish:   GemRegistryEntry | null,
  },
  error: string | null,
  startedAtIso: string,
  updatedAtIso: string,
}
```

**Resumability rule:** before any stage writes its output, the runner reads the current
`stage` and `state` and skips any stage whose output slot is already non-null. The runner
then writes the new stage's output to its slot, bumps `stage` to the next stage, and
updates `updatedAtIso`.

**Idempotency rule:** every stage's output is a deterministic function of the previous
stage's output (and, for stages 2/3/6, the model + refs). Re-running an LLM stage is
allowed (it will re-call the model); re-running a deterministic stage with the same input
is a no-op (the slot is already filled, skip). The only side effects that are NOT
automatically idempotent are Stages 7.5 (Cloud Run deploy) and 8 (cross-repo PRs); both
are guarded by the `cloudRunUrl` and `hookRuns[]` fields on the registry entry.

**Crash recovery:** if the backend process crashes mid-`04-build`, the next `GET /api/gems/<runId>`
poll (or the next `POST /api/gems/resume`) re-reads the `PipelineRun` doc, sees
`stage="04-build"` and `state.build=null`, and re-invokes the build stage with the
preserved `state.spec`. Nothing is recomputed from scratch.

**Resume endpoint:** `POST /api/gems/:runId/resume` (auth: same as the original creator).
Returns 200 with the current `PipelineRun` and 409 if the run is already `complete` or
`failed`.

## 5. Per-stage timeouts and cost

| # | Stage | Type | Timeout (s) | Cost (USD) | Notes |
|---|-------|------|------------:|-----------:|-------|
| 1 | Intake | deterministic | 5 | 0 | Firestore write + GCS `mv` |
| 2 | Brainstorm | LLM | 60 | $0.05–$0.15 | `claude-sonnet-4`, 1 call + 1 retry |
| 3 | Spec | LLM | 60 | $0.10–$0.30 | `claude-sonnet-4`, longer output |
| 4 | Build | deterministic | 10 | 0 | Template rendering only |
| 5 | Verify | deterministic | 180 | 0 | `npm install` is the long pole |
| 6 | Evaluate | LLM | 120 | $0.20–$0.50 | `claude-sonnet-4`, 10+ probes |
| 7 | Publish | deterministic | 5 | 0 | Firestore write + `shareToken` gen |
| 7.5 | Deploy | deterministic | 600 | <$0.05 | Cloud Build + Cloud Run deploy |
| 8 | Registry Hooks | deterministic | 120 | 0 | `gh` CLI + Slack webhook |
| **Total** | | | **~20 min** | **~$0.50–$1.00** | LLM stages dominate cost |

P50 end-to-end wall-clock for a simple gem (e.g. `ai-rpg`): **~3 minutes** (dominated by
Stage 5 `npm install`). P95: **~10 minutes** (Cloud Build cold cache + a retry on Stage 6).

## 6. Observability: Firestore + audit log

### Firestore collections touched

| Collection | Doc | Written by | Fields |
|------------|-----|------------|--------|
| `gem_intakes/<intakeId>` | `IntakeOutput` | Stage 1 | `intakeId, gcsRefPrefix, authorUid, prompt, visibility` |
| `gem_runs/<runId>` | `PipelineRun` | all stages (each writes its `state.<slot>` + bumps `stage`) | see §4 |
| `gems/<gemId>` | `GemRegistryEntry` | Stages 7, 7.5 | full entry + `cloudRunUrl`, `status`, `hookRuns[]` |
| `gem_audit_log/<auto-id>` | append-only row | all stages | see per-stage audit entries in §3 |

### Audit log shape

Every audit row:

```ts
{
  type: string,        // e.g. "gem.published", "deploy.failed", "hooks.frontend.pr_opened"
  runId: string,
  intakeId?: string,
  gemId?: string,
  ts: string,          // ISO 8601
  // ...per-type fields (see §3)
}
```

The audit log is append-only (Firestore append via `add()` not `set()`), lives in the
`ai-universe-b3551` project, and is the canonical record for "what happened to this
gem." It powers the `#ai-universe-gems` Slack channel's read-only mirror and the
admin `/api/audit` tool.

### Logging

Backend uses `pino` (see `backend/src/lib/logger.ts`). Every stage logs:

```json
{
  "level": "info",
  "service": "ai-universe-lite-backend",
  "stage": "06-evaluate",
  "runId": "run_a1b2c3d4e5f6",
  "gemId": "ai-rpg",
  "ts": "2026-06-13T17:18:00.000Z",
  "msg": "evaluate.passed"
}
```

Errors include the full stack. Logs ship to Cloud Logging via the standard `pino` →
`@google-cloud/logging-winston` sink.

## 7. Failure semantics

| Stage | Failure mode | User sees | Recoverable? |
|-------|--------------|-----------|--------------|
| 1 | GCS ref missing | HTTP 400 `ref_not_found` | Re-upload + retry |
| 1 | Author uid invalid | HTTP 401 `invalid_author` | Fix auth |
| 1 | Firestore write fails | HTTP 503 `intake_persist_failed` (after 1 retry) | Re-POST |
| 2 | LLM invalid JSON | 1 retry, then `failed@02-brainstorm` with rationale | Edit prompt + re-run from 2 |
| 3 | Spec validation fail | 1 retry, then `failed@03-spec` with Zod issues | Edit spec by hand + re-run from 3 |
| 4 | Template render throws | `failed@04-build` with stack | Fix spec / template, re-run from 4 |
| 5 | `npm install`/tsc/eslint/jest fails | `failed@05-verify` with `errors[]` | Fix the gem source, re-run from 5 |
| 6 | Eval score < threshold | `failed@06-evaluate` with `probeScores[]` | Re-run from 6 with `--from=02-brainstorm` |
| 7 | Firestore write fails | 1 retry, then `failed@07-publish` | Re-run from 7 |
| 7.5 | `gcloud run deploy` fails (transient) | 1 retry | Auto |
| 7.5 | `gcloud run deploy` fails (hard) | `failed@07.5-deploy` with `gcloudTail` | Fix infra, re-run from 7.5 |
| 8 | Cross-repo PR open fails | non-fatal; `failed@08-registry-hooks` warning + Slack DM | Manual retry via `gh` CLI |

In all cases, `GET /api/gems/<runId>` returns the current state + the `error` field.

## 8. What's NOT in Phase 1

- **Human-in-the-loop** brainstorm approval (Phase 1+; today the user gets the brainstorm
  in the pipeline timeline and can abort, but cannot edit it)
- **Per-gem custom domain** (Phase 1+; today the URL is `gem-<id>-<env>-<num>.a.run.app`)
- **Public gem search / discoverability UI** (Phase 2)
- **Per-gem billing** (Phase 3)
- **Cross-gem tool composition** (Phase 3+)
- **Multi-region deploy** (Phase 2+; today everything is `us-central1`)

## See also

- [`docs/gem-authoring.md`](./gem-authoring.md) — how to author a new gem (the
  *downstream* view: "I have a `gems/<id>/` and want to extend it")
- [`docs/cross-repo-hooks.md`](./cross-repo-hooks.md) — what Stage 8 (Registry Hooks)
  actually does, including rollback (the *upstream* view: "I need to roll back a gem")
- [`docs/reference-uploads.md`](./reference-uploads.md) — how uploaded files become
  ref bundles (the input to Stages 2 and 3)
- [`docs/cloudrun-deploy.md`](./cloudrun-deploy.md) — full per-gem Cloud Run deploy
  contract (the contract that Stage 7.5 implements)
- [`backend/src/agents/stages/01-intake.md`](../backend/src/agents/stages/01-intake.md)
  through [`08-registry-hooks.md`](../backend/src/agents/stages/08-registry-hooks.md) —
  per-stage source-of-truth
- [`backend/src/lib/schema.ts`](../backend/src/lib/schema.ts) — Zod schemas for every
  pipeline I/O
- [`backend/README.md`](../backend/README.md) — backend layout, scripts, tests
- [`AGENTS.md`](../AGENTS.md) — repo-level guidelines (deploy contract, coding style, security)
