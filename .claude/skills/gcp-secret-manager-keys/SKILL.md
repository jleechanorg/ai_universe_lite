---
name: gcp-secret-manager-keys
description: How to read API keys (OpenAI, Anthropic, Gemini, Perplexity, OpenRouter, Grok) from GCP Secret Manager. Ported from jleechanorg/ai_universe.
---

# GCP Secret Manager — API Key Access

The AI Universe Lite backend reads LLM provider keys from GCP Secret Manager. Keys are **never** stored in env vars or `.env` files (except in `.env.local` for local dev, which is gitignored).

## Required secrets

| Secret name (in GCP) | Provider |
|----------------------|----------|
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GEMINI_API_KEY` | Google Gemini |
| `PERPLEXITY_API_KEY` | Perplexity |
| `OPENROUTER_API_KEY` | OpenRouter |
| `GROK_API_KEY` | xAI Grok |

All in project `ai-universe-2025`.

## Local dev

The Cloud Run service account has `roles/secretmanager.secretAccessor`. For local dev, the developer's `gcloud auth login` identity must have the same role. Run:

```bash
gcloud projects add-iam-policy-binding ai-universe-2025 \
  --member="user:$(gcloud config get-value account)" \
  --role="roles/secretmanager.secretAccessor"
```

## Reading keys from code

```ts
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";

const client = new SecretManagerServiceClient();

export async function readSecret(name: string): Promise<string> {
  const [version] = await client.accessSecretVersion({
    name: `projects/ai-universe-2025/secrets/${name}/versions/latest`,
  });
  const payload = version.payload?.data?.toString();
  if (!payload) throw new Error(`Empty secret: ${name}`);
  return payload;
}
```

Used by `backend/src/stores/secrets.ts` (Phase 1) and by per-gem `loadGemContext` when it lazy-loads `ctx.callLlm(model, prompt)`.

## Cache strategy

`backend/src/stores/secrets.ts` caches each secret in memory for 5 minutes (configurable via `SECRET_CACHE_TTL_SEC`). Cloud Run instances are short-lived; cache hit rate is high within an instance lifetime.

## Test the wiring

```bash
cd backend
npm run prepare:shared-libs
./scripts/test-api-keys.sh
```

Expected output: 6 ✅ lines, 0 ❌ lines.

## Rotate

```bash
echo -n "<new-key>" | gcloud secrets versions add OPENAI_API_KEY --data-file=- --project=ai-universe-2025
```

New version auto-picks up at next deploy (or next cache TTL in dev).

## Source

Ported from `jleechanorg/ai_universe`'s `gcp-secret-manager-keys` skill. Project and secret names are identical.
