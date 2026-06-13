# Gem-Builder — Architecture

> A single user prompt → a self-contained, shareable, versioned MCP "Gem" deployed to its own Cloud Run service.

## 8-Stage Pipeline

```
User prompt + refs  ─▶  [1. INTAKE]  ─▶  [2. BRAINSTORM]  ─▶  [3. SPEC]
                     │   (deterministic)   (managed agent)  (managed agent)
                     │
                     ▼
[8. REGISTRY HOOKS]  ◀──  [7. PUBLISH]  ◀──  [7.5 DEPLOY]  ◀──  [6. EVALUATE]  ◀──  [5. VERIFY]  ◀──  [4. BUILD]
(deterministic)         (deterministic)    (deterministic)   (managed agent)    (deterministic)    (deterministic)
```

**Where the LLM lives:** Stages 2, 3, 6 only. Everything else is plain TypeScript + gcloud.

**Why mixed:** LLM judgment for *what to build* and *whether it's good*. Determinism for *building, deploying, publishing* — fast, reproducible, debuggable.

## Per-Stage Summary

| # | Stage | Type | Input | Output | Stage Doc |
|---|-------|------|-------|--------|-----------|
| 1 | Intake | deterministic | `CreateGemRequest` | `IntakeOutput` | [01-intake.md](../backend/src/agents/stages/01-intake.md) |
| 2 | Brainstorm | managed agent | `IntakeOutput` | `BrainstormOutput` | [02-brainstorm.md](../backend/src/agents/stages/02-brainstorm.md) |
| 3 | Spec | managed agent | `BrainstormOutput` | `GemSpec` | [03-spec.md](../backend/src/agents/stages/03-spec.md) |
| 4 | Build | deterministic | `GemSpec` | `GemBuildResult` | [04-build.md](../backend/src/agents/stages/04-build.md) |
| 5 | Verify | deterministic | `GemBuildResult` | `VerifyReport` | [05-verify.md](../backend/src/agents/stages/05-verify.md) |
| 6 | Evaluate | managed agent | `VerifyReport` + source | `EvaluationReport` | [06-evaluate.md](../backend/src/agents/stages/06-evaluate.md) |
| 7 | Publish | deterministic | `EvaluationReport` | `GemRegistryEntry` | [07-publish.md](../backend/src/agents/stages/07-publish.md) |
| 7.5 | Deploy | deterministic | `GemBuildResult` | Cloud Run URL | [07.5-deploy.md](../backend/src/agents/stages/07.5-deploy.md) |
| 8 | Registry Hooks | deterministic | `GemRegistryEntry` | cross-repo PRs | [08-registry-hooks.md](../backend/src/agents/stages/08-registry-hooks.md) |

## Key Design Decisions

### 1. LLM only at the gates

Stages 2/3/6 produce things that are inherently fuzzy:
- "What features should this gem have?" (brainstorm)
- "How should the system prompt + tool schemas look?" (spec)
- "Does this gem actually work well, and resist prompt injection?" (evaluate)

Stages 1, 4, 5, 7, 7.5, 8 are mechanical: templating, type-checking, CRUD, `gcloud run deploy`. Putting LLMs in those would add tokens, variance, and a class of bugs (hallucinated env vars, etc.) for no benefit.

### 2. JSON-typed output at every LLM stage

`BrainstormOutput`, `GemSpec`, `EvaluationReport` are all Zod-validated before the pipeline advances. A model that returns prose gets a 1-shot retry with the Zod error injected; second failure = `pipeline.failed`.

### 3. The pipeline is idempotent and resumable

`PipelineRun` (Firestore `gem_runs/<runId>`) is the source of truth. Each stage reads/writes its slot. If the server crashes mid-`04-build`, the next resume picks up at the next stage.

### 4. Each gem is a separate Cloud Run service

Not a single multi-tenant MCP server. Why:
- Per-gem resource isolation (one runaway gem can't OOM the others).
- Per-gem rate limiting.
- Per-gem secret scope.
- Per-gem deploy / rollback.
- Per-gem custom domain (Phase 1+).

Cost: more Cloud Run services. Mitigated by `min-instances=0` + 10-instance cap.

### 5. Reuses `ai_universe`'s deploy contract

Same project, same region, same registry, same env vars, same prod guard, same PR preview pattern. The only delta is the image tag prefix (`gem-<id>` vs `repo-name`).

### 6. Gem = deterministic templates

`templates/server.ts.tmpl`, `templates/tool.ts.tmpl`, etc. are checked in. Stage 4 renders them with the spec injected. Output is committed to `gems/<id>/` for inspection (gitignored except `ai-rpg`).

## Data Flow

```
                                  ┌─ GCS gs://ai-universe-lite-refs/intake/<intakeId>/*
                                  │  (refs)
                                  │
[1 INTAKE] ─ intakeId ─┐          │
                       │          │
                       ▼          │
              ┌──────────────────┐│
              │  gem_runs/<runId>││
              │  state: PipelineState
              │  stage: <active> │
              └──────────────────┘│
                       │          │
[2 BRAINSTORM] ◀────────┤          │  (loads refs from GCS)
                       │          │
[3 SPEC] ◀──────────────┤          │  (loads refs from GCS)
                       │          │
[4 BUILD] ─ gemDir ────┤          │
                       │          │
[5 VERIFY] ─ errors[] ─┤          │  (npm install, tsc, eslint, jest)
                       │          │
[6 EVALUATE] ─ score ───┤          │  (managed agent, probes)
                       │          │
[7 PUBLISH] ─ entry ────┤          │  (Firestore write + shareToken)
                       │          │
[7.5 DEPLOY] ─ url ─────┤          │  (gcloud run deploy, prod-guard)
                       │          │
[8 HOOKS] ─ PRs ────────┘          │  (frontend, convo MCP, audit log)
```

## Failure Semantics

| Stage | Failure mode | User sees |
|-------|--------------|-----------|
| 1 | GCS ref missing | `400 ref_not_found` |
| 2 | LLM returned invalid JSON | retry once, then `failed@02-brainstorm` |
| 3 | Spec validation failed | retry once, then `failed@03-spec` |
| 4 | (deterministic) | `failed@04-build` with stack trace |
| 5 | `npm install`/tsc/eslint/jest failed | `failed@05-verify` with `errors[]` |
| 6 | Eval score < threshold | `failed@06-evaluate` with `probeScores[]` |
| 7 | Firestore write failed | retry once, then `failed@07-publish` |
| 7.5 | `gcloud run deploy` failed | `failed@07.5-deploy` with gcloud output |
| 8 | Cross-repo PR open failed | non-fatal; gem still published |

In all cases, `GET /api/gems/<runId>` returns the current state + the `error` field.

## What's NOT in v1

- Human-in-the-loop brainstorm approval (Phase 1+)
- Per-gem custom domain (Phase 1+)
- Public gem search / discoverability UI (Phase 2)
- Per-gem billing (Phase 3)
- Cross-gem tool composition (Phase 3+)
