#!/usr/bin/env bash
# deploy-gem.sh — deploy a single gem to Cloud Run
# Usage: ./scripts/deploy-gem.sh <gem-id> <env>
#   env: dev | staging | prod (prod blocked locally)
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <gem-id> <env>"
  exit 1
fi

GEM_ID="$1"
ENV="$2"

# === Prod guard (mirrors ai_universe/deploy.sh lines 162-193) ===
if [[ "$ENV" == "prod" ]] && [[ "${GITHUB_ACTIONS:-false}" != "true" ]] && [[ "${ALLOW_LOCAL_PROD_DEPLOY:-false}" != "true" ]]; then
  echo "❌ PRODUCTION GEM DEPLOY BLOCKED"
  echo "Use: https://github.com/jleechanorg/ai_universe_lite/actions/workflows/gem-publish.yml"
  exit 1
fi

GEM_DIR="$(cd "$(dirname "$0")/.." && pwd)/gems/$GEM_ID"
if [ ! -d "$GEM_DIR" ]; then
  echo "❌ Gem dir not found: $GEM_DIR"
  exit 1
fi

echo "🚀 Deploying gem '$GEM_ID' to env '$ENV'"
echo "   gem dir: $GEM_DIR"
echo "   service: gem-$GEM_ID-$ENV"
echo "   image:   gcr.io/ai-universe-2025/gem-$GEM_ID:$(jq -r .version "$GEM_DIR/package.json")"

# The actual gcloud invocation lives in templates/deploy.gem.sh.tmpl.
# This top-level script just enforces the prod-guard and dispatches.
cd "$GEM_DIR"
bash deploy.gem.sh "$ENV"
