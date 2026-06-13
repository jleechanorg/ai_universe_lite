# Per-Gem Cloud Run Deploy Contract

> Mirrors `jleechanorg/ai_universe/deploy.sh`. Same parameters, same prod-guard, same secrets.

## Service

| Field | Value |
|-------|-------|
| Service name | `gem-<id>-<env>` (`dev` \| `staging` \| `prod`) |
| Image | `gcr.io/ai-universe-2025/gem-<id>:<semver>` |
| Region | `us-central1` |
| Project | `ai-universe-2025` |
| Port | 8080 |
| CPU | 1 |
| Memory | 512Mi |
| Timeout | 300s |
| Min instances | 0 |
| Max instances | 10 |
| Concurrency | 80 |
| Auth | Allow unauthenticated (MCP endpoint is public; auth is per-call via `claude mcp add`) |
| Service account | default compute SA with `roles/secretmanager.secretAccessor` |
| Labels | `gem-id=<id>`, `gem-version=<version>`, `gem-builder=true` |

## Env Vars (set at deploy time)

| Var | Source | Notes |
|-----|--------|-------|
| `NODE_ENV` | literal `production` | |
| `PORT` | literal `8080` | |
| `MCP_SESSION_STORE` | literal `memory` (default) | opt-in `redis` |
| `GEM_ID` | from spec | |
| `GEM_VERSION` | from spec | |
| `REF_BUCKET` | literal `ai-universe-lite-refs` | |
| `FIREBASE_PROJECT_ID` | literal `ai-universe-b3551` | **NEVER** `ai-universe-2025` |
| `MCP_SERVER_PORT` | literal `8080` | |
| `STORAGE_TYPE` | literal `firestore` | |
| `FIRESTORE_PROJECT_ID` | literal `ai-universe-b3551` | |

## Secrets (mounted from Secret Manager, `--set-secrets`)

| Secret | Source |
|--------|--------|
| `OPENAI_API_KEY` | `OPENAI_API_KEY:latest` (if gem needs it) |
| `ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY:latest` (if gem needs it) |
| `GEMINI_API_KEY` | `GEMINI_API_KEY:latest` (if gem needs it) |
| `PERPLEXITY_API_KEY` | `PERPLEXITY_API_KEY:latest` (if gem needs it) |
| `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY:latest` (if gem needs it) |
| `GROK_API_KEY` | `GROK_API_KEY:latest` (if gem needs it) |

Only the secrets the gem's spec `requiredEnv` lists are mounted.

## Prod Guard

Mirrored from `ai_universe/deploy.sh` lines 162-193:

```bash
if [[ "$ENVIRONMENT" == "prod" ]] && [[ "${GITHUB_ACTIONS:-false}" != "true" ]]; then
  echo "❌ PRODUCTION GEM DEPLOY BLOCKED"
  echo "Use: https://github.com/jleechanorg/ai_universe_lite/actions/workflows/gem-publish.yml"
  exit 1
fi
```

Override (Jeffrey-only, never committed): `ALLOW_LOCAL_PROD_DEPLOY=true` in `.env.local`.

## PR Previews

When a PR is opened in `gems/<id>/`, `gem-preview-pr.yml` (Phase 1) auto-deploys:

| Field | Value |
|-------|-------|
| Service | `gem-preview-pr-<PR_NUMBER>-<gemId>` |
| TTL | 6h |
| Idle shutoff | 1h with 0 traffic |
| Cleanup | Cloud Scheduler + cron job |

## Redis (opt-in)

To use a persistent session store:

```bash
gcloud run services update gem-<id>-<env> \
  --set-env-vars "MCP_SESSION_STORE=redis" \
  --set-env-vars "REDIS_HOST=10.x.x.x" \
  --set-env-vars "REDIS_PORT=6379"
```

The Redis instance is `ai-universe-redis-dev` or `ai-universe-redis-prod` (same as `ai_universe`).

## Disaster Recovery

- Image rollback: `./deploy.gem.sh <env> --rollback` (uses last-known-good tag).
- DB: Firestore is multi-region by default; no backup needed beyond Google's defaults.
- Secrets: rotate via `gcloud secrets versions add <name> --data-file=-`; new version auto-picked up at next deploy.
