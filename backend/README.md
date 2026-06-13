# Backend — AI Universe Lite

The FastMCP server that orchestrates the 8-stage gem-builder pipeline.

## Responsibilities

- Expose the `gem_create` MCP tool and `POST /api/gems` HTTP endpoint (Stage 1 INTAKE).
- Drive the pipeline runner (`src/agents/runner.ts`) across 8 stages.
- Manage gem registry CRUD in Firestore (`ai-universe-b3551`).
- Verify shared-libs staging (calls `scripts/verify-shared-libs-staging.mjs` from `ai_universe`).
- Spawn per-gem Cloud Run deploys via the same `deploy.sh` contract.

## Layout

```
src/
  server.ts                 # FastMCP + Express entry
  config.ts                 # env, GCP, Firebase, LLM provider config
  agents/
    runner.ts               # pipeline orchestrator (8 stages, w/ resumable state)
    stages/
      01-intake.ts          # upload ref to GCS, normalize prompt
      02-brainstorm.ts      # managed Claude agent (uses superpowers-brainstorming)
      03-spec.ts            # managed Claude agent → JSON gem spec
      04-build.ts           # deterministic (templates → gems/<id>/)
      05-verify.ts          # type-check, lint, unit tests on generated gem
      06-evaluate.ts        # managed Claude agent + JSON schema + red-team probes
      07-publish.ts         # gem registry Firestore write + share URL
      07.5-deploy.ts        # Cloud Run deploy (gated: local prod blocked)
      08-registry-hooks.ts  # cross-repo PRs (frontend embed, convo MCP, etc.)
    brainstormer.ts         # Stage 2 agent (wraps superpowers-brainstorming skill)
    spec-generator.ts       # Stage 3 agent
    evaluator.ts            # Stage 6 agent
    meta-eval.ts            # backend MetaEval over the evaluator
    types.ts
  stores/
    firestore.ts            # gem registry CRUD
    storage.ts              # GCS ref uploads
    secrets.ts              # @google-cloud/secret-manager wrapper
  routes/
    gems.ts                 # /api/gems, /api/gems/:id, /api/gems/:id/install
    refs.ts                 # /api/refs (upload + sign)
    registry.ts             # /api/registry/:gemId (public read for share URLs)
  lib/
    firebase.ts             # firebase-admin init (ai-universe-b3551)
    logger.ts               # pino
    schema.ts               # zod schemas: Gem, GemSpec, GemBuildResult
    crypto.ts               # shareToken gen
  test/
    jest.setup.ts
    gem-builder/
      pipeline.unit.test.ts
      intake.unit.test.ts
      brainstorm.integration.test.ts
      spec.unit.test.ts
      build.unit.test.ts
      verify.integration.test.ts
      evaluate.integration.test.ts
      publish.unit.test.ts
      deploy.unit.test.ts
      full-pipeline.e2e.test.ts
      fixtures/
        worldarchitect_ai_combined_prompts.md
        ai-rpg-spec.json
scripts/
  prepare_shared_libs.sh    # mirrors ai_universe pattern
  verify-shared-libs-staging.mjs
  test-api-keys.sh          # ported from ai_universe/test-api-keys.sh
```

## Shared libs

- `@ai-universe/mcp-server-utils` — re-exports from `shared-libs/packages/mcp-server-utils/`
- `@ai-universe/gem-runtime` — re-exports from `shared-libs/packages/gem-runtime/`

These are file: deps; `npm install` runs `prepare:shared-libs` automatically.

## Develop

```bash
cd backend
npm install
npm run dev
```

Server runs on port 8080. `POST /api/gems` is the entry point. MCP `gem_create` tool is exposed for Claude/Cursor clients.
