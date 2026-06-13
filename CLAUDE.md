# CLAUDE.md - AI Development Protocol

**AI Universe Lite** = Gem registry + builder for AI Universe — shareable MCP servers from a prompt | TypeScript | FastMCP | Cloud Run | GCS | Firestore | Firebase Auth

## 🚨 CRITICAL: PROJECT CONTEXT

**Stack:** `backend/` (TypeScript MCP builder server) | Jest tests | Models: Cerebras, Claude (Sonnet 4), Gemini (2.5 Flash), Perplexity, OpenRouter (via Secret Manager) | GCP Cloud Run deploys

### Stack alignment with `jleechanorg/ai_universe`

| Concern | `ai_universe` | `ai_universe_lite` (this repo) |
|---------|---------------|-------------------------------|
| Project | `ai-universe-2025` | `ai-universe-2025` (same) |
| Region | `us-central1` | `us-central1` (same) |
| Registry | `gcr.io/ai-universe-2025/...` | `gcr.io/ai-universe-2025/gem-<id>:<semver>` (same) |
| Auth | Firebase `ai-universe-b3551` | Firebase `ai-universe-b3551` (same) |
| Shared lib | `@ai-universe/mcp-server-utils` | `@ai-universe/mcp-server-utils` (reused via npm workspace) |
| Convo MCP | `ai_universe_convo_mcp` | Reuses same `conversation_*` toolset |
| Frontend | `ai_universe_frontend` (Vite+React) | Adds `<GemEmbed>` + `/gems/:shareToken` route |
| Deploy | `ai_universe/deploy.sh` (cloned) | `deploy.sh` in this repo (cloned pattern) |
| Prod guard | Local `prod` blocked | Local `prod` blocked (mirrored) |
| PR preview | `repo-dev-pr-<N>` | `gem-preview-pr-<N>-<gemId>` |

**Never deviate from this alignment** without explicit Jeffrey approval.

### 🔐 Firebase Project

| Project | Purpose | ID |
|---------|---------|-----|
| Firebase Auth (all) | User authentication | `ai-universe-b3551` |

- **Auth var:** `AI_UNIVERSE_FIREBASE_PROJECT_ID=ai-universe-b3551`
- **Common mistake:** Using `ai-universe-2025` (the GCP project) for Firebase auth = HTTP 401
- **Local shells:** `~/.bashrc` may have `FIREBASE_PROJECT_ID=worldarchitecture-ai`. Keep AI Universe vars prefixed `AI_UNIVERSE_`.

## 🚀 AUTONOMY & INITIATIVE

**Be HIGHLY AUTONOMOUS. Act first, ask later.**

✅ JUST DO IT: Follow patterns, add tests, fix bugs, run tests, refactor, improve error handling, commit/push, create PRs
❓ ASK ONLY: Multiple approaches with significant trade-offs, breaking API changes, major architecture decisions, genuinely ambiguous requirements

**Execution:** Be a senior engineer. Finish 100%. Own outcomes. Chain actions (add → commit → push → PR).

### 🚨 CI FAILURE RULE

**ANY CI failure MUST be fixed. ZERO excuses.** Never say "pre-existing" or "unrelated" — just FIX IT.

## 🚫 ABSOLUTE REQUIREMENTS

- ❌ NEVER provide simulated/hypothetical code — production-grade only
- ❌ NEVER create files in project root (except config)
- ✅ ALWAYS prefer editing existing files over creating new ones
- ✅ ALWAYS search first before creating files
- ✅ File placement: Backend → `/backend/src/`, Tests → `/backend/src/test/`, Scripts → `/scripts/`, Tools → `/backend/src/tools/`, Agents → `/backend/src/agents/`, Templates → `/templates/`, Generated gems → `/gems/<gemId>/`

## 🔗 BEADS ISSUE TRACKING

```bash
export PATH="$PATH:$HOME/go/bin"
bd ready --json
bd create "..." -t feature -p 1
bd dep add <id1> <id2> --type blocks
bd close <id> --reason "..."
```

- **Auto-discovery protocol:** Auto-create bugs (P0) for crashes, test failures (P1), missing deps (P1), TODOs (P2). Link with `dep(..., type="discovered-from")`.
- **Cross-session memory:** Git-backed JSONL prevents agent amnesia.
- **Session end:** ALWAYS `sync()` or work is LOST.
- **Required checks:** `npm run type-check`, `npm run lint`, `npm run build`, `npm run test`, `npm run test:integration`, security audit.
- **ALL checks MUST be green to merge - NO exceptions.**

## 🚨 Production Deploy Guard

**Local `prod` deploys are BLOCKED.** This repo mirrors `ai_universe/deploy.sh` lines 162-193.

```bash
if [[ "$ENVIRONMENT" == "prod" ]] && [[ "${GITHUB_ACTIONS:-false}" != "true" ]]; then
    echo "❌ PRODUCTION GEM DEPLOY BLOCKED"
    echo "Use: https://github.com/jleechanorg/ai_universe_lite/actions/workflows/gem-publish.yml"
    exit 1
fi
```

**To deploy to production:** open a PR, get review + approval, then use the `gem-publish.yml` workflow with manual approval. Audit trail in GitHub Actions history.

## PR Workflow

Per the always-PR-never-local-edit rule:

1. Branch from `main`: `git checkout -b feature/<slug>`
2. Code, test, commit (conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `test:`)
3. Push: `git push -u origin <branch>`
4. Open PR: `gh pr create --base main --head <branch> --title "..." --body-file <file>`
5. Wait for CI green + review approval
6. Merge via squash (default) or merge commit

**Never merge your own PR for production-impacting changes** — get Jeffrey's review.

## Cross-PR Sync

When this repo's changes require changes in `ai_universe_frontend` (e.g. the `<GemEmbed>` component + `/gems/:shareToken` route), ship the frontend PR as a **separate** cross-repo PR after the gem registry is live. Use the same pattern as `ai_universe` for cross-PR coordination.
