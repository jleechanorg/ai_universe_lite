import { z } from "zod";

// ====== Pipeline identifiers ======
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

// ====== Intake ======
export const IntakeInputSchema = z.object({
  prompt: z.string().min(8).max(8000),
  refPaths: z.array(z.string()).default([]),
  authorUid: z.string().min(1),
  visibility: z.enum(["private", "unlisted", "public"]).default("unlisted"),
});
export type IntakeInput = z.infer<typeof IntakeInputSchema>;

export const IntakeOutputSchema = z.object({
  intakeId: z.string(),
  gcsRefPrefix: z.string(),
  authorUid: z.string(),
  prompt: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
});
export type IntakeOutput = z.infer<typeof IntakeOutputSchema>;

// ====== Brainstorm ======
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
  modelNeeds: z.array(
    z.enum(["openai", "anthropic", "gemini", "perplexity", "openrouter", "grok"]),
  ),
  reasoning: z.string(),
});
export type BrainstormOutput = z.infer<typeof BrainstormOutputSchema>;

// ====== Spec ======
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
});
export type ToolSpec = z.infer<typeof ToolSpecSchema>;

export const GemSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(2).max(60),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().min(20).max(280),
  systemPrompt: z.string().min(80).max(8000),
  tools: z.array(ToolSpecSchema).min(1).max(12),
  requiredEnv: z.array(z.string()).default([]),
  authorUid: z.string(),
  brainstorm: BrainstormOutputSchema,
});
export type GemSpec = z.infer<typeof GemSpecSchema>;

// ====== Build ======
export const GemBuildResultSchema = z.object({
  gemDir: z.string(),
  files: z.array(z.string()),
  entrypoint: z.string(),
  imageTag: z.string(),
});
export type GemBuildResult = z.infer<typeof GemBuildResultSchema>;

// ====== Verify ======
export const VerifyReportSchema = z.object({
  typeCheckOk: z.boolean(),
  lintOk: z.boolean(),
  unitTestsOk: z.boolean(),
  unitTestCount: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  errors: z.array(z.string()).default([]),
});
export type VerifyReport = z.infer<typeof VerifyReportSchema>;

// ====== Evaluate ======
export const ProbeScoreSchema = z.object({
  probe: z.string(),
  category: z.enum(["happy_path", "edge_case", "adversarial", "red_team"]),
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

// ====== Publish ======
export const GemRegistryEntrySchema = z.object({
  gemId: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  authorUid: z.string(),
  visibility: z.enum(["private", "unlisted", "public"]),
  shareToken: z.string(),
  installCommand: z.string(),
  cloudRunUrl: z.string().nullable(),
  status: z.enum(["building", "live", "deleted"]),
  createdAtIso: z.string(),
  updatedAtIso: z.string(),
});
export type GemRegistryEntry = z.infer<typeof GemRegistryEntrySchema>;

// ====== Pipeline state ======
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

// ====== API request/response ======
export const CreateGemRequestSchema = IntakeInputSchema;
export type CreateGemRequest = IntakeInput;

export const CreateGemResponseSchema = z.object({
  runId: z.string(),
  intakeId: z.string(),
  pollUrl: z.string(),
  estimatedSeconds: z.number().int(),
});
export type CreateGemResponse = z.infer<typeof CreateGemResponseSchema>;
