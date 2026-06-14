#!/usr/bin/env bash
# deploy.sh — Cloud Run deploy for the ai-rpg gem.
# Mirrors templates/deploy.gem.sh.tmpl and scripts/deploy-gem.sh lines 15-20.
# Usage: ./deploy.sh <env>
#   env: dev | staging | prod (prod blocked locally — see prod-guard below)
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <env>"
  exit 1
fi

ENV="$1"

# === Prod guard (mirrors scripts/deploy-gem.sh lines 15-20 and
#     docs/cloudrun-deploy.md) ============================================
if [[ "$ENV" == "prod" ]] && [[ "${GITHUB_ACTIONS:-false}" != "true" ]] && [[ "${ALLOW_LOCAL_PROD_DEPLOY:-false}" != "true" ]]; then
  echo "❌ PRODUCTION GEM DEPLOY BLOCKED"
  echo "Use: https://github.com/jleechanorg/ai_universe_lite/actions/workflows/gem-publish.yml"
  exit 1
fi

GEM_ID="$(jq -r .name package.json | sed 's/@ai-universe-lite\/gem-//')"
GEM_VERSION="$(jq -r .version package.json)"
SERVICE="gem-${GEM_ID}-${ENV}"
REGION="us-central1"
PROJECT="ai-universe-2025"
REGISTRY="gcr.io/${PROJECT}"
IMAGE="${REGISTRY}/gem-${GEM_ID}:${GEM_VERSION}"

echo "🚀 Deploying ${SERVICE} (${IMAGE})"

# 1. Build + push image via Cloud Build.
gcloud builds submit \
  --config cloudbuild.yaml \
  --substitutions="_REGISTRY=${REGISTRY},_GEM_ID=${GEM_ID},_GEM_VERSION=${GEM_VERSION}" \
  --project="$PROJECT"

# 2. Deploy to Cloud Run.
# Env vars come from docs/cloudrun-deploy.md "Env Vars (set at deploy time)".
# Secrets come from docs/cloudrun-deploy.md "Secrets (mounted from Secret Manager)".
# Only the secrets this gem's spec actually needs are mounted; for v1 the
# ai-rpg gem uses the narrator's Anthropic model, so we mount ANTHROPIC_API_KEY.
# Other LLM keys are mounted defensively in case future tools are added.
gcloud run deploy "$SERVICE" \
  --image "$IMAGE" \
  --region "$REGION" \
  --project "$PROJECT" \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 --memory 512Mi --timeout 300 \
  --min-instances 0 --max-instances 10 --concurrency 80 \
  --service-account "$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')-compute@developer.gserviceaccount.com" \
  --set-env-vars "NODE_ENV=production,PORT=8080,MCP_SESSION_STORE=memory,GEM_ID=${GEM_ID},GEM_VERSION=${GEM_VERSION},REF_BUCKET=ai-universe-lite-refs,FIREBASE_PROJECT_ID=ai-universe-b3551,MCP_SERVER_PORT=8080,STORAGE_TYPE=firestore,FIRESTORE_PROJECT_ID=ai-universe-b3551" \
  --set-secrets "OPENAI_API_KEY=OPENAI_API_KEY:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,GEMINI_API_KEY=GEMINI_API_KEY:latest,PERPLEXITY_API_KEY=PERPLEXITY_API_KEY:latest,OPENROUTER_API_KEY=OPENROUTER_API_KEY:latest,GROK_API_KEY=GROK_API_KEY:latest" \
  --labels "gem-id=${GEM_ID},gem-version=${GEM_VERSION},gem-builder=true"

echo "✅ Deployed: https://${SERVICE}-${PROJECT}.a.run.app"
