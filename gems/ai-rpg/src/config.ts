/**
 * config.ts — runtime configuration for the ai-rpg gem.
 *
 * Reads from environment variables with sane defaults. The deployed gem
 * gets these from Cloud Run / Secret Manager; local dev uses `.env`.
 */

export type AiRpgConfig = {
  gemId: string;
  gemVersion: string;
  refBucket: string;
  port: number;
};

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return raw;
}

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    return fallback;
  }
  return n;
}

export const config: AiRpgConfig = {
  gemId: readString("GEM_ID", "ai-rpg"),
  gemVersion: readString("GEM_VERSION", "0.1.0"),
  refBucket: readString("REF_BUCKET", "ai-universe-lite-refs"),
  port: readPort("PORT", 8080),
};
