# AI Universe Lite — Gems

> **One prompt → one self-contained, shareable MCP server, deployed to its own Cloud Run service.**

**AI Universe Lite** is the gem registry + builder for the AI Universe constellation. It
turns a natural-language prompt (plus optional reference file uploads) into a versioned,
installable MCP "Gem" that anyone can attach to Claude / Cursor / a custom client. Each
gem runs on its own Google Cloud Run service, reuses the convo MCP pattern from
`jleechanorg/ai_universe`, and is announced via cross-repo PRs to the frontend and
landing page. **Built for:** solo developers, indie hackers, and small teams who want to
ship a custom MCP server in minutes without writing deploy YAML.

**Example:**

```
/gem-create "make me an MCP server that runs AI RPG campaigns with character sheets, dice, combat"
   --ref worldarchitect_ai_combined_prompts.md
```

Produces a `ai-rpg` gem at `gems/ai-rpg/`, deploys it to
`https://gem-ai-rpg-<hash>-uc.a.run.app/mcp`, and publishes a share URL
`https://ai-universe.app/gems/<shareToken>` with a one-line `claude mcp add` install
command.

## Quick start

```bash
# Requires Node 22+
git clone https://github.com/jleechanorg/ai_universe_lite.git
cd ai_universe_lite/backend
npm install
npm run dev                # builder server on port 8080
```

## Try it now

The v1 reference gem (`ai-rpg`) is already published. Install it with:

```bash
npx fastmcp install --from @ai-universe-lite/gem-ai-rpg ai-rpg
```

## Architecture

```
                    User prompt + refs
                           │
                           ▼
  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
  │ 1. INTAKE   │─▶│ 2. BRAIN-   │─▶│ 3. SPEC     │─▶│ 4. BUILD    │  deterministic
  │ determin-   │  │  STORM LLM  │  │   LLM       │  │ determin-   │  except
  │ istic       │  │ (claude-    │  │ (claude-    │  │ istic       │  stages 2/3/6
  │             │  │ sonnet-4)   │  │ sonnet-4)   │  │             │
  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘
                                                          │
                                  ┌─────────────┐  ┌──────▼──────┐
                                  │ 6. EVALUATE │◀─│ 5. VERIFY   │  deterministic
                                  │   LLM       │  │ determin-   │
                                  │ (claude-    │  │ istic       │
                                  │  sonnet-4)  │  │             │
                                  └─────────────┘  └─────────────┘
                                       │
                                       ▼
                                  ┌─────────────┐
                                  │ 7. PUBLISH  │  Firestore + shareToken
                                  └─────────────┘
                                       │
                                       ▼
                                  ┌─────────────┐
                                  │ 7.5 DEPLOY  │  Cloud Run (prod-guard mirrors
                                  └─────────────┘  ai_universe/deploy.sh)
                                       │
                                       ▼
                                  ┌─────────────┐
                                  │ 8. REGISTRY │  cross-repo PRs (frontend +
                                  │  HOOKS      │  landing) + audit log;
                                  │             │  soft-fail — does not unpublish
                                  └─────────────┘
```

The pipeline is **resumable** (state lives in Firestore `gem_runs/<runId>`) and
**idempotent on retry** (each stage writes a slot; resume picks up at the next
stage). See [`docs/gem-builder.md`](./docs/gem-builder.md) for the full design.

## Phase roadmap

| Phase | Status | What it delivers |
|-------|--------|------------------|
| **Phase 0** | ✅ Done | Repo scaffold, FastMCP backend skeleton, Zod schemas, GCS bucket terraform, Cloud Run deploy contract, v0 docs |
| **Phase 1** | 🟡 In progress | Working 8-stage pipeline (`runner.ts` + 8 stage handlers), v1 reference gem (`ai-rpg`), shared-libs staging, prod-guard, ref-uploads end-to-end |
| **Phase 2** | ⏳ Planned | GCR→Artifact Registry migration, Workload Identity Federation (WIF) for cross-repo PRs, cross-gem tool reuse, public gem search UI |
| **Phase 3** | ⏳ TBD | Per-gem billing, public gem marketplace, multi-region deploy, custom domains, human-in-the-loop brainstorm approval |

## Repos in the constellation

- `jleechanorg/ai_universe_lite` — **this repo** (gem registry + builder + per-gem images)
- `jleechanorg/ai_universe` — source of `@ai-universe/mcp-server-utils` and the convo MCP pattern
- `jleechanorg/ai_universe_convo_mcp` — standalone convo MCP server (A2A); reused by every gem
- `jleechanorg/ai_universe_frontend` — Vite + React frontend; gains `/gems/:shareToken` route + `<GemEmbed>` component
- `jleechanorg/ai_universe_landing` — public gallery at `ai-universe.app/`; Phase 1 hook target

## Stack

- **Language:** TypeScript (Node 22)
- **MCP:** FastMCP + Zod schemas
- **Auth:** Firebase Auth (`ai-universe-b3551`)
- **Storage:** Firestore (gem registry) + GCS (`gs://ai-universe-lite-refs` for uploaded refs)
- **Registry:** GCR (`gcr.io/ai-universe-2025/gem-<id>:<semver>`)
- **Deploy:** Google Cloud Run (`us-central1`), pattern cloned from `ai_universe/deploy.sh`
- **Frontend:** Vite + React (in `jleechanorg/ai_universe_frontend`)
- **LLM:** Managed Claude agents (`claude-sonnet-4`) via `@google-cloud/secret-manager` for API keys

## Documentation (Phase 1)

- [`docs/gem-builder.md`](./docs/gem-builder.md) — the 8-stage pipeline architecture:
  per-stage input/output, retry policy, observability, timeouts, costs, resumability
- [`docs/gem-authoring.md`](./docs/gem-authoring.md) — how to author a new gem
  (concrete enough to copy `gems/ai-rpg/` and adapt in <1 hour)
- [`docs/cross-repo-hooks.md`](./docs/cross-repo-hooks.md) — what Stage 8 does to the
  other repos, how to soft-fail, how to roll back
- [`docs/reference-uploads.md`](./docs/reference-uploads.md) — how `--ref` files
  become runtime-readable references (intake → retrieval → GC)

## Deploy

Local `staging` and `dev` deploys:

```bash
./scripts/deploy-gem.sh <gem-id> staging
./scripts/deploy-gem.sh <gem-id> dev
```

**Production gem deploys are blocked locally** — use the `gem-publish.yml` GitHub
Actions workflow (manual approval). See [`docs/cloudrun-deploy.md`](./docs/cloudrun-deploy.md)
for the full per-gem deploy contract.

## License

Private (jleechanorg). All rights reserved.
