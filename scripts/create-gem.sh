#!/usr/bin/env bash
# create-gem.sh — main entrypoint for creating a gem
# Usage: ./scripts/create-gem.sh "make me an MCP server that does X" [--ref file]...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ $# -lt 1 ]; then
  echo "Usage: $0 \"<prompt>\" [--ref file]..."
  exit 1
fi

PROMPT="$1"
shift
REF_PATHS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      REF_PATHS+=("$2")
      shift 2
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

echo "🌌 Creating gem..."
echo "   Prompt: $PROMPT"
echo "   Refs:   ${REF_PATHS[*]:-<none>}"

# Phase 0: just call the backend HTTP API once implemented.
# For now, this is a placeholder that prints the next-step plan.
cat <<EOF
📋 Plan (matches docs/gem-builder.md):
   [1/8] INTAKE         — upload refs to gs://ai-universe-lite-refs/tmp/ + create gem_runs/<runId>
   [2/8] BRAINSTORM     — managed Claude agent (claude-sonnet-4) → BrainstormOutput
   [3/8] SPEC           — managed Claude agent → GemSpec
   [4/8] BUILD          — deterministic templates → gems/<id>/
   [5/8] VERIFY         — npm install + tsc + eslint + jest
   [6/8] EVALUATE       — managed Claude agent (probes: happy/edge/adversarial)
   [7/8] PUBLISH        — Firestore write + shareToken + install command
   [7.5/8] DEPLOY       — Cloud Run service (prod-guard mirrors ai_universe)
   [8/8] REGISTRY HOOKS — cross-repo PRs (frontend embed, convo MCP whitelist, audit log)

⚠️  Phase 0 scaffolding only — backend HTTP/MCP server not yet implemented (Phases 1-2).
EOF
