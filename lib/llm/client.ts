import { env } from "@/lib/env";

/**
 * Thin OpenAI-compatible client for llama-server.
 *
 * Two servers, one per GPU:
 *   coordinator (:8081) — text, tool calling, JSON extraction
 *   vision      (:8082) — vision/OCR, loaded with --mmproj
 *
 * Everything degrades: a missing server must never break the app, because the
 * deterministic extractor already produces a usable profile without any model.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface JsonSchemaFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface ChatOptions {
  baseUrl?: string;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  jsonSchema?: JsonSchemaFormat;
  tools?: unknown[];
  toolChoice?: "auto" | "none" | "required";
  signal?: AbortSignal;
  /**
   * Qwen3.5 is a reasoning model: by default it burns the token budget in
   * `reasoning_content` and returns empty `content`. We disable the thinking
   * pass unless a caller explicitly wants the chain of thought.
   */
  thinking?: boolean;
}

export interface ChatResult {
  text: string;
  /** Present only if the model emitted a thinking pass. */
  reasoning: string;
  toolCalls: Array<{ name: string; arguments: string }>;
  raw: unknown;
  ms: number;
}

export class LlmUnavailableError extends Error {
  constructor(baseUrl: string, cause?: unknown) {
    super(`llama-server unreachable at ${baseUrl} — is it running? (npm run servers)`);
    this.name = "LlmUnavailableError";
    this.cause = cause;
  }
}

export function coordinatorUrl(): string {
  return env.coordinator.url;
}

export function visionUrl(): string {
  return env.vision.url;
}

function composeSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  return AbortSignal.any([timeout, external]);
}

/** POST /v1/chat/completions. Throws LlmUnavailableError only on connection failure. */
export async function chat(options: ChatOptions): Promise<ChatResult> {
  const baseUrl = options.baseUrl ?? env.coordinator.url;
  const timeoutMs = options.timeoutMs ?? env.timeouts.chatMs;
  const started = Date.now();

  const body: Record<string, unknown> = {
    model: options.model ?? "local",
    messages: options.messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 2048,
    stream: false,
    // Verified against b11982: without this, Qwen3.5 returns empty `content`
    // with finish_reason=length and a full `reasoning_content` block.
    chat_template_kwargs: { enable_thinking: options.thinking === true },
  };

  if (options.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: options.jsonSchema.name,
        strict: options.jsonSchema.strict ?? true,
        schema: options.jsonSchema.schema,
      },
    };
  }
  if (options.tools) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice ?? "auto";
  }

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: composeSignal(timeoutMs, options.signal),
    });
  } catch (error) {
    throw new LlmUnavailableError(baseUrl, error);
  }

  // Some builds reject response_format; retry once without the constraint and
  // let the caller parse defensively.
  if (!response.ok && response.status === 400 && (body.response_format || body.chat_template_kwargs)) {
    delete body.response_format;
    delete body.chat_template_kwargs;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: composeSignal(timeoutMs, options.signal),
      });
    } catch (error) {
      throw new LlmUnavailableError(baseUrl, error);
    }
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 400);
    throw new Error(`llama-server ${baseUrl} -> HTTP ${response.status}: ${detail}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
      };
    }>;
  };

  const message = json.choices?.[0]?.message;
  return {
    text: (message?.content ?? "").trim(),
    reasoning: (message?.reasoning_content ?? "").trim(),
    toolCalls: (message?.tool_calls ?? []).map((call) => ({
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })),
    raw: json,
    ms: Date.now() - started,
  };
}

/** GET /health — resolves false instead of throwing. */
export async function isHealthy(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(env.timeouts.healthMs),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Extracts the first balanced JSON object from a model reply. Small models love
 * to wrap JSON in prose or fences even when told not to.
 */
export function extractJson<T = unknown>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
