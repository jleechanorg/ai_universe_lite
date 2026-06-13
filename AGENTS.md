# Repository Guidelines

This monorepo contains the **AI Universe Lite gem-builder pipeline**, the shared TypeScript libraries, operational scripts, and the v1 demo gem (`ai-rpg`).

Use the updated READMEs (`README.md`, `backend/README.md`) as the source of truth for structure, capabilities, and setup details.

## 🎯 Skills Integration Protocol

**MANDATORY:** Before starting any task, check both `.claude/skills/` and `~/.claude/skills/` for relevant specialized instructions.

### Skills Directory Structure

- **Project Skills:** `.claude/skills/` — shared with team, checked into repository
- **User Skills:** `~/.claude/skills/` — personal customizations (gitignored)
- If a directory is absent, treat that scope as having no active skills rather than skipping the check entirely.

### Current Project Skills

- `superpowers-brainstorming` — vendored copy from `~/.claude/skills/superpowers-brainstorming/SKILL.md`; used by Stage 2 of the gem-builder pipeline
- `gem-create` — the user-facing entry point: `/gem-create "<prompt>"`
- `gcp-secret-manager-keys` — ported from `ai_universe`; how to read API keys from GCP Secret Manager

**Protocol:** When a task involves server operations, deployments, or API credentials, the corresponding skill will automatically activate. Follow its instructions precisely.

## Project Structure & Module Organization

- `backend/`: FastMCP server (`src/server.ts`) that orchestrates the 8-stage gem-builder pipeline; agents, tools, Express middleware, gem REST API.
- `templates/`: deterministic gem-server templates (`server.ts.tmpl`, `tool.ts.tmpl`, `Dockerfile.gem.tmpl`, `cloudbuild.gem.tmpl`, `deploy.gem.sh.tmpl`, etc.).
- `gems/`: generated gem source. `gems/ai-rpg/` is committed as the v1 reference demo. All other `gems/*` paths are gitignored.
- `infra/terraform/`: GCS bucket, GCR repo, Cloud Run service account, Secret Manager bindings.
- `docs/`: architecture, gem-authoring, deploy contract, reference-uploads.
- `scripts/`: operational helpers — `create-gem.sh`, `test-api-keys.sh`, `deploy-gem.sh`.
- `.claude/skills/`: vendored skills (superpowers-brainstorming, gem-create, gcp-secret-manager-keys).

## 🚀 AGENT AUTONOMY & INITIATIVE REQUIREMENTS

**MANDATORY:** Agents must operate with MAXIMUM AUTONOMY and PROACTIVE INITIATIVE. Execute tasks fully without constant confirmation requests.

### Autonomous Behavior Standards

- ✅ EXECUTE IMMEDIATELY: Don't ask "should I do X?" — just do X if it's part of completing the task
- ✅ FOLLOW PATTERNS: Examine existing code (especially `ai_universe`'s patterns) and replicate automatically
- ✅ COMPLETE FULLY: Tasks end when 100% done (tested, documented, committed, pushed), not at 80% with "next steps"
- ✅ FIX PROACTIVELY: When you encounter bugs/issues, fix them immediately
- ✅ CHAIN OPERATIONS: Code → test → fix → commit → push → PR, not just the first step

### Permission NOT Required For

- Adding tests following existing patterns
- Fixing bugs discovered during work
- Running and fixing test failures
- Following naming/structure conventions
- Improving error handling or type safety
- Committing completed work
- Pushing to feature branches
- Creating PRs for finished work
- Updating docs for code you changed

### Only Ask When

- Genuinely ambiguous requirements with multiple valid interpretations
- Breaking changes to public APIs
- Major architectural shifts (new services, DB changes)
- Trade-offs with SIGNIFICANT downstream impact
- Security-sensitive operations you're uncertain about

## 🚫 ZERO-TOLERANCE POLICY ON SIMULATED CODE

- ❌ Never return fabricated, placeholder, or "pretend" code. All code must reflect exact changes that will be applied to repository files.
- ❌ Avoid describing theoretical implementations without delivering the concrete edits.
- ✅ If requirements are genuinely unclear AND wrong assumptions would waste significant work, request clarification. Otherwise use best judgment based on codebase patterns.

## 🔗 Beads Issue Tracking (bd)

**RECOMMENDED:** Use Beads for issue tracking and agent memory across sessions.

- Hash-based IDs for collision-free multi-worker support
- Auto-discovery of ready work
- Git-native JSONL sync

**Usage via CLI:**

```bash
export PATH="$PATH:$HOME/go/bin"
bd ready --json
bd create "Implement feature X" -t feature -p 1 --json
bd dep add <id1> <id2> --type blocks
bd update <id> --status in_progress
bd close <id> --reason "Done"
```

The `gem-builder-v1` epic (28 sub-beads) lives in `.beads/`.

## Deploy Contract

**Mirror of `jleechanorg/ai_universe/deploy.sh`. Same parameters, same secrets, same prod-guard.**

- **Project:** `ai-universe-2025`
- **Region:** `us-central1`
- **Registry:** GCR (`gcr.io/ai-universe-2025/gem-<id>:<semver>`)
- **Service account:** default compute SA with `roles/secretmanager.secretAccessor`
- **Redis:** opt-in to `ai-universe-redis-dev` / `ai-universe-redis-prod`; default `MCP_SESSION_STORE=memory`
- **Resources:** 1 vCPU, 512Mi memory, 300s timeout, min 0, max 10, concurrency 80, port 8080
- **Env vars (set at deploy time):** `NODE_ENV=production,PORT=8080,MCP_SESSION_STORE=memory,GEM_ID,GEM_VERSION,REF_BUCKET,FIREBASE_PROJECT_ID=ai-universe-b3551,MCP_SERVER_PORT=8080,STORAGE_TYPE=firestore,FIRESTORE_PROJECT_ID=ai-universe-b3551`
- **Secrets (Secret Manager):** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `PERPLEXITY_API_KEY`, `OPENROUTER_API_KEY`, `GROK_API_KEY` (whatever the gem needs)
- **Prod-guard:** local `prod` deploys blocked; must use `gem-publish.yml` GitHub Actions with manual approval
- **PR previews:** `gem-preview-pr-<PR_NUMBER>-<gemId>`, 6h auto-cleanup, 1h idle shutoff

## Shared-libs Staging

`backend/scripts/prepare_shared_libs.sh` mirrors `ai_universe`'s flow:

1. `cd backend && npm run prepare:shared-libs` — builds each `shared-libs/packages/*/dist` once
2. For each package, copy `package.json` + `tsconfig.json` + `README.md` + `dist/` (NEVER `src/`) into the build context
3. `node scripts/verify-shared-libs-staging.mjs` validates (fails if `src/` accidentally staged)
4. CI gate: build fails if `src/` is in any staged package

## Coding Style

- 2-space indentation, TypeScript ESM modules
- PascalCase types, camelCase symbols, kebab-case filenames
- Trailing commas, double-quoted strings
- Zod schemas for all input/output; never trust runtime input
- Self-explanatory code; JSDoc only on public helpers

## Security

- Load all secrets via Secret Manager (`@google-cloud/secret-manager`); never commit real keys
- Per-gem rate limiting (Cloud Run ingress + per-gem service)
- Reference-file uploads: 50 MB/file, 200 MB/gem, MIME whitelist
- Production gem deploys require manual approval via `gem-publish.yml`
- Per-gem soft-delete: share URL returns 410 Gone (recoverable)
- Public visibility promotion: manual via `gem_promote` admin tool (Jeffrey-only, audit-logged)
