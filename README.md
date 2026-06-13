# AI Universe Lite — Gems

> **One prompt → one self-contained, shareable MCP server, deployed to its own Cloud Run service.**

`ai_universe_lite` is the gem registry + builder for AI Universe. It turns a natural-language prompt (plus optional reference file uploads) into a versioned, installable MCP "Gem" that anyone can attach to Claude / Cursor / a custom client. Each gem runs on its own Google Cloud Run service using the same convo MCP, frontend, and deploy pattern as the main `jleechanorg/ai_universe` repo.

**Example:**

```
/gem-create "make me an MCP server that runs AI RPG campaigns with character sheets, dice, combat"
   --ref worldarchitect_ai_combined_prompts.md
```

Produces a `ai-rpg` gem at `gems/ai-rpg/`, deploys it to `https://gem-ai-rpg-<hash>-uc.a.run.app/mcp`, and publishes a share URL `https://ai-universe.app/gems/<shareToken>` with a one-line `claude mcp add` install command.

## Architecture

8-stage pipeline (see `docs/gem-builder.md` for full design):

```
User prompt + refs  →  [1. INTAKE]  →  [2. BRAINSTORM]  →  [3. SPEC]
                    →  [4. BUILD (deterministic)]  →  [5. VERIFY]
                    →  [6. EVALUATE (managed agent)]  →  [7. PUBLISH]
                    →  [7.5 DEPLOY to Cloud Run]  →  [8. REGISTRY HOOKS]
```

- **Stages 2, 3, 6** are managed Claude agents (heavy LLM work)
- **Stages 1, 4, 5, 7, 7.5, 8** are deterministic (no LLM in the loop)

## Repos in the constellation

- `jleechanorg/ai_universe_lite` — **this repo** (gem registry + builder + per-gem images)
- `jleechanorg/ai_universe` — source of `@ai-universe/mcp-server-utils` and the convo MCP pattern
- `jleechanorg/ai_universe_convo_mcp` — standalone convo MCP server (A2A); reused by every gem
- `jleechanorg/ai_universe_frontend` — Vite + React frontend; gains `/gems/:shareToken` route + `<GemEmbed>` component

## Stack

- **Language:** TypeScript (Node 22)
- **MCP:** FastMCP + Zod schemas
- **Auth:** Firebase Auth (`ai-universe-b3551`)
- **Storage:** Firestore (gem registry) + GCS (`gs://ai-universe-lite-refs` for uploaded refs)
- **Registry:** GCR (`gcr.io/ai-universe-2025/gem-<id>:<semver>`)
- **Deploy:** Google Cloud Run (`us-central1`), pattern cloned from `ai_universe/deploy.sh`
- **Frontend:** Vite + React (in `jleechanorg/ai_universe_frontend`)
- **LLM:** Managed Claude agents via `@google-cloud/secret-manager` for API keys

## Quickstart (local dev)

```bash
git clone https://github.com/jleechanorg/ai_universe_lite.git
cd ai_universe_lite
npm install
npm run prepare:shared-libs
cd backend && npm run dev   # builder server on port 8080
```

## Quickstart (create your first gem)

```bash
./scripts/create-gem.sh "make me an MCP server that does X"
```

or with a reference file:

```bash
./scripts/create-gem.sh "make me an MCP server that does X" --ref ./my-doc.pdf
```

The pipeline runs end-to-end and returns a share URL + install command when done.

## Deploy

Local `staging` and `dev` deploys:

```bash
./deploy.sh staging
./deploy.sh dev
```

**Production gem deploys are blocked locally** — use the `gem-publish.yml` GitHub Actions workflow (manual approval).

## Documentation

- `docs/gem-builder.md` — architecture, schemas, pipeline stages
- `docs/gem-authoring.md` — how to author a gem manually
- `docs/cloudrun-deploy.md` — per-gem deploy contract (parity with `ai_universe/deploy.sh`)
- `docs/reference-uploads.md` — how uploaded files become gem resources
- `.hermes/plans/2026-06-13_140410-ai-universe-lite-gem-builder-v2.md` — full design plan

## License

Private (jleechanorg). All rights reserved.
