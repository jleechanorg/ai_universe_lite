import { z } from "zod";

// =====================================================================
// Pipeline identifiers
// ---------------------------------------------------------------------
// Pipeline stages: the canonical 9 values used everywhere
// (firestore store, agent handlers, orchestrator). Mirrors the union
// declared in firestore.ts so the two stay in lockstep.
// =====================================================================
export const PIPELINE_STAGES = [
  "intake",
  "brainstorm",
  "spec",
  "build",
  "verify",
  "evaluate",
  "publish",
  "deploy",
  "registry-hooks",
] as const;
export const PipelineStageSchema = z.enum(PIPELINE_STAGES);
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const STAGE_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
] as const;
export const StageStatusSchema = z.enum(STAGE_STATUSES);
export type StageStatus = (typeof STAGE_STATUSES)[number];

// Display names (e.g. "02-brainstorm") for the orchestrator and the
// /api/gems/<runId> polling response. These are NOT the same as the
// PipelineStage enum above; the orchestrator maps between them.
export const STAGE_NAMES = [
  "01-intake",
  "02-brainstorm",
  "03-spec",
  "04-build",
  "05-verify",
  "06-evaluate",
  "07-publish",
  "07.5-deploy",
  "08-registry-hooks",
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

// =====================================================================
// Visibility
// =====================================================================
export const GEM_VISIBILITIES = ["private", "unlisted", "public"] as const;
export const GemVisibilitySchema = z.enum(GEM_VISIBILITIES);
export type GemVisibility = (typeof GEM_VISIBILITIES)[number];

// =====================================================================
// Intake
// =====================================================================
export const IntakeInputSchema = z.object({
  prompt: z.string().min(8).max(8000),
  refPaths: z.array(z.string()).default([]),
  authorUid: z.string().min(1),
  visibility: GemVisibilitySchema.default("unlisted"),
});
export type IntakeInput = z.infer<typeof IntakeInputSchema>;

export const IntakeOutputSchema = z.object({
  intakeId: z.string(),
  gcsRefPrefix: z.string(),
  authorUid: z.string(),
  prompt: z.string(),
  visibility: GemVisibilitySchema,
});
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

// =====================================================================
// Brainstorm
// =====================================================================
export const MODEL_PROVIDERS = [
  "openai",
  "anthropic",
  "gemini",
  "perplexity",
  "openrouter",
  "grok",
] as const;
export const ModelProviderSchema = z.enum(MODEL_PROVIDERS);
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const BrainstormOutputSchema = z.object({
  featureSet: z.array(z.string()).min(1),
  tools: z.array(
    z.object({
      name: z.string(),
      purpose: z.string(),
      inputs: z.array(z.string()),
      outputs: z.array(z.string()),
    }),
  ),
  modelNeeds: z.array(ModelProviderSchema),
  reasoning: z.string(),
});
export type BrainstormOutput = z.infer<typeof BrainstormOutputSchema>;

// =====================================================================
// Spec
// =====================================================================
export const ToolSpecSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string().min(8),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean().default(false),
      description: z.string().optional(),
    }),
  ),
  output: z.object({
    type: z.string(),
    schema: z.unknown().optional(),
  }),
  prompt: z.string().optional(),
  model: z.string().optional(),
  /**
   * Optional JSON Schema (Zod-compatible) describing the tool's
   * input parameters. The Stage 3 spec-generator emits this so the
   * Stage 4 builder can render the Zod object literally into the
   * generated tool file. Older shapes used `inputs[]` only.
   */
  parameters: z
    .object({
      type: z.literal("object").default("object"),
      properties: z.record(z.string(), z.unknown()).default({}),
      required: z.array(z.string()).default([]),
    })
    .partial()
    .optional(),
  /**
   * Optional TypeScript source string of the tool's `execute` body.
   * Stored as a string so the spec is portable and diff-friendly.
   * Stage 4 inlines this into `src/tools/<name>.ts`.
   */
  execute: z.string().optional(),
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

/**
 * A single probe for Stage 5 (verifier) and Stage 6 (evaluator).
 * `name` typically starts with the tool name (`"roll_dice:basic"`)
 * so we can filter probes per tool.
 */
export const TestProbeSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()).default({}),
  expected: z.string(),
});
export type TestProbe = z.infer<typeof TestProbeSchema>;

/**
 * The published gem spec. Stage 3 (spec-generator) produces this from
 * a BrainstormOutput; Stage 4 (builder) renders it into a gem source
 * tree; Stage 7 (publisher) persists it (via the gems/ collection).
 */
export const GemSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(20).max(280),
  systemPrompt: z.string().min(80).max(8000),
  tools: z.array(ToolSpecSchema).min(1).max(12),
  requiredEnv: z.array(z.string()).default([]),
  /**
   * Optional npm dependencies the gem needs at runtime. Stage 4
   * merges these into the generated `package.json` (alongside the
   * always-present runtime + fastmcp + zod entries).
   */
  dependencies: z.array(z.string()).default([]),
  /**
   * Optional test probes the Stage 5 verifier and Stage 6
   * evaluator run. Stage 3 emits at least 1 happy-path probe per
   * tool; the evaluator adds 3 edge + 2 adversarial probes.
   */
  testProbes: z.array(TestProbeSchema).default([]),
  authorUid: z.string(),
  brainstorm: BrainstormOutputSchema,
});
export type GemSpec = z.infer<typeof GemSpecSchema>;

// =====================================================================
// Build
// =====================================================================
export const GemBuildResultSchema = z.object({
  gemDir: z.string(),
  files: z.array(z.string()),
  entrypoint: z.string(),
  imageTag: z.string(),
});
export type GemBuildResult = z.infer<typeof GemBuildResultSchema>;

// =====================================================================
// Verify
// =====================================================================
export const VerifyReportSchema = z.object({
  typeCheckOk: z.boolean(),
  lintOk: z.boolean(),
  unitTestsOk: z.boolean(),
  unitTestCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  errors: z.array(z.string()).default([]),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

// =====================================================================
// Evaluate
// =====================================================================
export const PROBE_CATEGORIES = [
  "happy_path",
  "edge_case",
  "adversarial",
  "red_team",
] as const;
export const ProbeCategorySchema = z.enum(PROBE_CATEGORIES);
export type ProbeCategory = (typeof PROBE_CATEGORIES)[number];

export const ProbeScoreSchema = z.object({
  probe: z.string(),
  category: ProbeCategorySchema,
  passed: z.boolean(),
  rationale: z.string(),
  raw: z.string().optional(),
});
export type ProbeScore = z.infer<typeof ProbeScoreSchema>;

export const EvaluationReportSchema = z.object({
  overallScore: z.number().min(0).max(1),
  passed: z.boolean(),
  probeScores: z.array(ProbeScoreSchema),
  evaluatorModel: z.string(),
  evaluatedAtIso: z.string(),
  notes: z.string().optional(),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

// =====================================================================
// Publish
// =====================================================================
export const GEM_STATUSES = ["building", "live", "deleted"] as const;
export const GemStatusSchema = z.enum(GEM_STATUSES);
export type GemStatus = (typeof GEM_STATUSES)[number];

export const GemRegistryEntrySchema = z.object({
  gemId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  shareToken: z.string(),
  installCommand: z.string(),
  cloudRunUrl: z.string().nullable(),
  status: GemStatusSchema,
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type GemRegistryEntry = z.infer<typeof GemRegistryEntrySchema>;

// =====================================================================
// Pipeline state (in-memory orchestration snapshot)
// =====================================================================
export const PipelineStateSchema = z.object({
  intake: IntakeOutputSchema.nullable(),
  brainstorm: BrainstormOutputSchema.nullable(),
  spec: GemSpecSchema.nullable(),
  build: GemBuildResultSchema.nullable(),
  verify: VerifyReportSchema.nullable(),
  evaluate: EvaluationReportSchema.nullable(),
  publish: GemRegistryEntrySchema.nullable(),
});
export type PipelineState = z.infer<typeof PipelineStateSchema>;

export const PipelineRunSchema = z.object({
  runId: z.string(),
  intakeId: z.string(),
  stage: z.enum([
    "queued",
    "01-intake",
    "02-brainstorm",
    "03-spec",
    "04-build",
    "05-verify",
    "06-evaluate",
    "07-publish",
    "07.5-deploy",
    "08-registry-hooks",
    "complete",
    "failed",
  ]),
  state: PipelineStateSchema,
  error: z.string().nullable(),
  startedAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type PipelineRun = z.infer<typeof PipelineRunSchema>;

// =====================================================================
// API request/response
// =====================================================================
export const CreateGemRequestSchema = IntakeInputSchema;
export type CreateGemRequest = IntakeInput;

export const CreateGemResponseSchema = z.object({
  runId: z.string(),
  intakeId: z.string(),
  pollUrl: z.string(),
  estimatedSeconds: z.number().int(),
});
export type CreateGemResponse = z.infer<typeof CreateGemResponseSchema>;

// =====================================================================
// Persistence schemas (Firestore document shapes)
// ---------------------------------------------------------------------
// These mirror the local interfaces declared in stores/firestore.ts so
// the store + orchestrator + agents can all read/write the same shape.
// Firestore reads return `any`, so the schema's role is documentation
// and an external `parse()` boundary for tests.
// =====================================================================

/** Optional error blob attached to a GemRun when the latest stage failed. */
export const RunErrorSchema = z.object({
  stage: PipelineStageSchema,
  message: z.string(),
  atIso: z.string(),
});
export type RunError = z.infer<typeof RunErrorSchema>;

// ---- Intake ----
export const NewGemIntakeSchema = z.object({
  prompt: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  refPaths: z.array(z.string()).optional(),
});
export type NewGemIntake = z.infer<typeof NewGemIntakeSchema>;

export const GemIntakeSchema = z.object({
  intakeId: z.string(),
  prompt: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  refPaths: z.array(z.string()),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type GemIntake = z.infer<typeof GemIntakeSchema>;

// ---- Run ----
export const NewGemRunSchema = z.object({
  intakeId: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema.optional(),
});
export type NewGemRun = z.infer<typeof NewGemRunSchema>;

export const GemRunSchema = z.object({
  runId: z.string(),
  intakeId: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  currentStage: PipelineStageSchema,
  currentStatus: StageStatusSchema,
  stageStatuses: z.record(PipelineStageSchema, StageStatusSchema).default({}),
  lastError: RunErrorSchema.nullable().optional(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type GemRun = z.infer<typeof GemRunSchema>;

// ---- Gem (published artifact, gems/ collection) ----
export const NewGemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  runId: z.string(),
  intakeId: z.string(),
});
export type NewGem = z.infer<typeof NewGemSchema>;

export const GemSchema = z.object({
  gemId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authorUid: z.string(),
  visibility: GemVisibilitySchema,
  shareToken: z.string(),
  runId: z.string(),
  intakeId: z.string(),
  cloudRunUrl: z.string().nullable(),
  status: GemStatusSchema,
  deployedAtIso: z.string().nullable().optional(),
  deployedEnv: z.string().nullable().optional(),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type Gem = z.infer<typeof GemSchema>;

// ---- Audit log (append-only) ----
export const NewAuditEntrySchema = z.object({
  action: z.string(),
  gemId: z.string().optional(),
  authorUid: z.string().optional(),
  runId: z.string().optional(),
  intakeId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type NewAuditEntry = z.infer<typeof NewAuditEntrySchema>;

export const AuditEntrySchema = z.object({
  entryId: z.string(),
  action: z.string(),
  gemId: z.string().optional(),
  authorUid: z.string().optional(),
  runId: z.string().optional(),
  intakeId: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  atIso: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

// =====================================================================
// Stage 5 (verifier) — chunk 2's preferred shape
// ---------------------------------------------------------------------
// The stage docs use a slightly different VerifyReport shape than the
// original schema above. We export the more granular chunk-2 shape so
// the verifier can populate it without lossy downcasting.
// =====================================================================
export const VerifyStepStatusSchema = z.enum(["pass", "fail", "skip"]);
export type VerifyStepStatus = z.infer<typeof VerifyStepStatusSchema>;

export const VerifyLogsSchema = z.object({
  typeCheck: z.string().default(""),
  lint: z.string().default(""),
  tests: z.string().default(""),
  build: z.string().default(""),
});
export type VerifyLogs = z.infer<typeof VerifyLogsSchema>;

export const VerifyRunReportSchema = z.object({
  typeCheck: VerifyStepStatusSchema,
  lint: VerifyStepStatusSchema,
  tests: VerifyStepStatusSchema,
  build: VerifyStepStatusSchema,
  logs: VerifyLogsSchema,
  durationMs: z.number().int().nonnegative().default(0),
});
export type VerifyRunReport = z.infer<typeof VerifyRunReportSchema>;

// =====================================================================
// Stage 6 (evaluator) — per-probe result with input/expected/actual
// =====================================================================
export const EvaluationProbeSchema = z.object({
  name: z.string(),
  category: ProbeCategorySchema,
  input: z.record(z.string(), z.unknown()),
  expected: z.string(),
  actual: z.string(),
  pass: z.boolean(),
  notes: z.string().optional(),
});
export type EvaluationProbe = z.infer<typeof EvaluationProbeSchema>;

export const EvaluationProbeSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type EvaluationProbeSummary = z.infer<typeof EvaluationProbeSummarySchema>;

export const EvaluationRunReportSchema = z.object({
  probes: z.array(EvaluationProbeSchema),
  summary: EvaluationProbeSummarySchema,
  evaluatorModel: z.string().default("claude-sonnet-4-20250514"),
  evaluatedAtIso: z.string(),
});
export type EvaluationRunReport = z.infer<typeof EvaluationRunReportSchema>;

// =====================================================================
// Stage 7 (publisher) result shape
// =====================================================================
export const PublishResultSchema = z.object({
  shareToken: z.string(),
  installCommand: z.string(),
  gemId: z.string(),
  runId: z.string(),
  createdAtIso: z.string(),
});
export type PublishResult = z.infer<typeof PublishResultSchema>;

// =====================================================================
// Stage 7.5 (deployer) result shape
// =====================================================================
export const DEPLOY_ENVS = ["dev", "staging", "prod"] as const;
export const DeployEnvSchema = z.enum(DEPLOY_ENVS);
export type DeployEnv = (typeof DEPLOY_ENVS)[number];

export const DeployResultSchema = z.object({
  cloudRunUrl: z.string(),
  deployedAt: z.string(),
  deployedEnv: DeployEnvSchema,
  semver: z.string(),
  gemId: z.string(),
});
export type DeployResult = z.infer<typeof DeployResultSchema>;

// =====================================================================
// Stage 8 (registry-hooks) result shape
// =====================================================================
export const RegistryHooksResultSchema = z.object({
  frontendPrUrl: z.string().nullable(),
  landingPrUrl: z.string().nullable(),
  auditLogIds: z.array(z.string()),
});
export type RegistryHooksResult = z.infer<typeof RegistryHooksResultSchema>;
