import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { logger } from "../lib/logger.js";

// =====================================================================
// GCP Secret Manager wrapper
// ---------------------------------------------------------------------
// - 5-minute in-memory cache (Map<name, {value, expiresAt}>).
// - Known LLM provider secret names surfaced via listAvailableSecrets().
// - getProjectId() falls back to the deploy contract default so local
//   dev and CI both work without explicit env wiring.
// =====================================================================

const PROJECT_FALLBACK = "ai-universe-2025";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

const KNOWN_LLM_SECRETS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "PERPLEXITY_API_KEY",
  "OPENROUTER_API_KEY",
  "GROK_API_KEY",
] as const;

export type LlmSecretName = (typeof KNOWN_LLM_SECRETS)[number];

interface CacheEntry {
  value: string;
  expiresAt: number;
}

let client: SecretManagerServiceClient | null = null;
const cache = new Map<string, CacheEntry>();

function getClient(): SecretManagerServiceClient {
  if (client) return client;
  client = new SecretManagerServiceClient();
  return client;
}

/**
 * Resolve the GCP project id used to scope Secret Manager lookups.
 * Reads GCP_PROJECT_ID first, then falls back to the deploy contract
 * default (ai-universe-2025) so local dev works.
 */
export function getProjectId(): string {
  const fromEnv = process.env.GCP_PROJECT_ID;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return PROJECT_FALLBACK;
}

function buildResourceName(secretName: string): string {
  return `projects/${getProjectId()}/secrets/${secretName}/versions/latest`;
}

/**
 * Read a secret value. Results are cached in-memory for 5 minutes to
 * keep the per-request cost low and to avoid Secret Manager quotas
 * when an agent hits the same provider multiple times in a run.
 */
export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const c = getClient();
  const [version] = await c.accessSecretVersion({ name: buildResourceName(name) });
  const payload = version?.payload?.data;
  if (!payload) {
    throw new Error(`secret ${name} returned empty payload`);
  }
  const value =
    typeof payload === "string"
      ? payload
      : Buffer.from(payload as Uint8Array).toString("utf8");
  cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  logger.debug({ secret: name, cached: false }, "secret loaded");
  return value;
}

/**
 * Return the names of the 6 known LLM provider secrets. Use this to
 * surface which providers are configured to the operator (e.g. in
 * the /api/admin/healthz response) without reading any values.
 */
export async function listAvailableSecrets(): Promise<string[]> {
  // Return a copy so callers can't mutate the internal constant.
  return [...KNOWN_LLM_SECRETS];
}

/**
 * Test-only: clear the in-memory cache. Production code should never
 * need to call this.
 */
export function _resetSecretCacheForTest(): void {
  cache.clear();
  client = null;
}
