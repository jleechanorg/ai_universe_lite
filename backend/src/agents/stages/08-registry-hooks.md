# AI Universe Lite — Stage 8 Registry Hooks

**Deterministic.** Cross-repo coordination after a successful publish.

## Behavior

After `07-publish` succeeds, this stage:

1. **Frontend embed PR** — opens a PR in `jleechanorg/ai_universe_frontend` to register the new gem's share URL route + `<GemEmbed>` config block.
2. **Convo MCP route** — if the gem uses `conversation_*` tools, opens a PR in `jleechanorg/ai_universe_convo_mcp` to whitelist the gem's `agent_id`.
3. **Discoverability index** — if `visibility="public"`, posts to a shared "Gems" channel (#ai-universe-gems on Slack, Phase 1) with a one-line install command.
4. **Audit log** — appends a row to Firestore `gem_audit_log` collection (deploy, publish, share, view, install events).

## Failure handling

A failed cross-repo PR **does not** unpublish the gem. The gem is live; the embed route simply appears 1-2 days later. The user gets a Slack DM with the link to the frontend PR.

## Why deterministic

This is bookkeeping. No LLM.

## Why a separate stage

Future-compat: when gem manifests need to register with other AI Universe surfaces (search index, billing, analytics), they slot in here.
