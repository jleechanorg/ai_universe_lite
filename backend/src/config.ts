import { z } from "zod";

const ConfigSchema = z.object({
  nodeEnv: z.enum(["development", "test", "production"]).default("development"),
  port: z.coerce.number().int().positive().default(8080),
  gcpProjectId: z.string().default("ai-universe-2025"),
  firebaseProjectId: z.string().default("ai-universe-b3551"),
  refBucket: z.string().default("ai-universe-lite-refs"),
  gemImageRegistry: z.string().default("gcr.io/ai-universe-2025"),
  region: z.string().default("us-central1"),
  gemBuildTimeoutSec: z.coerce.number().int().positive().default(600),
  gemEvalMinPassRate: z.coerce.number().min(0).max(1).default(0.6),
  gemEvalHardFailOnRedTeam: z.boolean().default(true),
  allowLocalProdDeploy: z.boolean().default(false),
  githubActions: z.boolean().default(false),
  // LLM provider keys — read on demand from Secret Manager, never logged
  llmProviderSecretNames: z
    .record(z.string(), z.string())
    .default({
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY",
      perplexity: "PERPLEXITY_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      grok: "GROK_API_KEY",
    }),
  // Default brain and eval models
  brainstormModel: z.string().default("claude-sonnet-4"),
  specModel: z.string().default("claude-sonnet-4"),
  evaluatorModel: z.string().default("claude-sonnet-4"),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  const parsed = ConfigSchema.parse({
    nodeEnv: process.env.NODE_ENV,
    port: process.env.PORT,
    gcpProjectId: process.env.GCP_PROJECT_ID,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
    refBucket: process.env.REF_BUCKET,
    gemImageRegistry: process.env.GEM_IMAGE_REGISTRY,
    region: process.env.GCP_REGION,
    gemBuildTimeoutSec: process.env.GEM_BUILD_TIMEOUT_SEC,
    gemEvalMinPassRate: process.env.GEM_EVAL_MIN_PASS_RATE,
    gemEvalHardFailOnRedTeam: process.env.GEM_EVAL_HARD_FAIL_ON_RED_TEAM,
    allowLocalProdDeploy: process.env.ALLOW_LOCAL_PROD_DEPLOY === "true",
    githubActions: process.env.GITHUB_ACTIONS === "true",
    llmProviderSecretNames: process.env.LLM_PROVIDER_SECRET_NAMES
      ? JSON.parse(process.env.LLM_PROVIDER_SECRET_NAMES)
      : undefined,
    brainstormModel: process.env.BRAINSTORM_MODEL,
    specModel: process.env.SPEC_MODEL,
    evaluatorModel: process.env.EVALUATOR_MODEL,
  });
  cached = parsed;
  return parsed;
}

export function resetConfigForTest(): void {
  cached = null;
}
