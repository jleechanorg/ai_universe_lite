#!/usr/bin/env bash
# test-api-keys.sh — ported from jleechanorg/ai_universe/test-api-keys.sh
# Tests that all required API keys are readable from Secret Manager.
# Run from backend/ dir.
set -euo pipefail

PROJECT="${GCP_PROJECT_ID:-ai-universe-2025}"

declare -a SECRETS=(
  "OPENAI_API_KEY"
  "ANTHROPIC_API_KEY"
  "GEMINI_API_KEY"
  "PERPLEXITY_API_KEY"
  "OPENROUTER_API_KEY"
  "GROK_API_KEY"
)

echo "🔑 Testing API key reads from Secret Manager (project: $PROJECT)"

pass=0
fail=0
for secret in "${SECRETS[@]}"; do
  if gcloud secrets describe "$secret" --project="$PROJECT" >/dev/null 2>&1; then
    val="$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT" 2>/dev/null | head -c 8 || true)"
    if [ -n "$val" ]; then
      echo "  ✅ $secret: readable (${val}...)"
      pass=$((pass + 1))
    else
      echo "  ❌ $secret: empty"
      fail=$((fail + 1))
    fi
  else
    echo "  ❌ $secret: secret not found in $PROJECT"
    fail=$((fail + 1))
  fi
done

echo
echo "Passed: $pass | Failed: $fail"
[ "$fail" -eq 0 ] || exit 1
