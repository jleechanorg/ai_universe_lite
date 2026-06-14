import Anthropic from "@anthropic-ai/sdk";
import { getSecret } from "../stores/secrets.js";

// =====================================================================
// LLM client — Claude (Anthropic) only for v1.
// ---------------------------------------------------------------------
// - Reads the API key from Secret Manager on first use; subsequent
//   calls reuse the cached key for the lifetime of the process
//   (5-minute TTL is owned by secrets.getSecret()).
// - Default model: claude-sonnet-4-20250514.
// - Throws a typed LlmError on failure so callers can branch on
//   recoverability without sniffing strings.
// =====================================================================

export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-20250514";
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.7;

export interface CallClaudeOpts {
  maxTokens?: number;
  temperature?: number;
}

/**
 * Typed LLM error. `recoverable` is a hint to the orchestrator:
 * true → retry the same stage (transient 5xx / 429);
 * false → mark stage failed and surface to the user.
 */
export class LlmError extends Error {
  public readonly errorClass: string;
  public readonly statusCode?: number;
  public readonly recoverable: boolean;
  constructor(
    errorClass: string,
    message: string,
    opts: { statusCode?: number; recoverable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "LlmError";
    this.errorClass = errorClass;
    this.statusCode = opts.statusCode;
    this.recoverable = opts.recoverable ?? false;
    if (opts.cause !== undefined) {
      // Attach cause for debugging; not all TS lib versions include the
      // `cause` constructor option.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

let clientPromise: Promise<Anthropic> | null = null;

/**
 * Lazily build an Anthropic SDK client. The first call fetches the
 * API key from Secret Manager; subsequent calls reuse the same
 * client (and the same cached key) for the life of the process.
 */
async function getClient(): Promise<Anthropic> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const apiKey = await getSecret("ANTHROPIC_API_KEY");
      return new Anthropic({ apiKey });
    })();
  }
  return clientPromise;
}

function isRecoverable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode;
  if (status === 408 || status === 409 || status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // SDK / network errors usually have a code like "ECONNRESET",
  // "ETIMEDOUT", or "ENOTFOUND" — treat those as transient.
  const code = (err as { code?: string }).code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  return false;
}

/**
 * Call Claude with a system + user message and return the assistant
 * text. Throws LlmError on any failure. The caller is responsible
 * for the retry policy — this function is a single, non-retrying
 * call.
 */
export async function callClaude(
  model: string = DEFAULT_CLAUDE_MODEL,
  systemPrompt: string,
  userMessage: string,
  opts: CallClaudeOpts = {},
): Promise<string> {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const temperature = opts.temperature ?? DEFAULT_TEMPERATURE;
  let client: Anthropic;
  try {
    client = await getClient();
  } catch (err) {
    throw new LlmError("AnthropicClientInit", "failed to initialize anthropic client", {
      cause: err,
      recoverable: false,
    });
  }
  try {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });
    // Concatenate text blocks in order; drop non-text blocks (tool_use
    // is not used in v1 but be defensive).
    const parts: string[] = [];
    for (const block of response.content) {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("");
  } catch (err) {
    const errorClass = (err as { constructor?: { name?: string } }).constructor?.name
      ?? "AnthropicError";
    const status = (err as { status?: number; statusCode?: number }).status
      ?? (err as { statusCode?: number }).statusCode;
    const message = err instanceof Error ? err.message : String(err);
    throw new LlmError(errorClass, message, {
      statusCode: typeof status === "number" ? status : undefined,
      recoverable: isRecoverable(err),
      cause: err,
    });
  }
}
