import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderResult,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";

// ============================================================================
// Groq — Fast LLM Inference, OpenAI-compatible
//
// Base URL: https://api.groq.com/openai/v1
// Auth: Authorization: Bearer gsk_...
// Docs: https://console.groq.com/docs/openai
//
// Free tier (no CC): 30 RPM, 14.400 req/day, 30k TPM.
// All models below are available on free tier with rate limits.
// IDs exposed as `groq/<id>` and `gq-<id>` plus native for convenience.
// ============================================================================

const GROQ_BASE = "https://api.groq.com/openai/v1";
const CHAT_URL = `${GROQ_BASE}/chat/completions`;
const MODELS_URL = `${GROQ_BASE}/models`;

interface GroqModelDef {
  id: string;
  upstream: string;
  context_window: number;
  max_output: number;
  vision?: boolean;
}

const GROQ_MODELS: GroqModelDef[] = [
  { id: "groq-llama-3.1-8b-instant", upstream: "llama-3.1-8b-instant", context_window: 128000, max_output: 8000 },
  { id: "groq-llama-3.3-70b-versatile", upstream: "llama-3.3-70b-versatile", context_window: 128000, max_output: 8000 },
  { id: "groq-llama-3.1-70b-versatile", upstream: "llama-3.1-70b-versatile", context_window: 128000, max_output: 8000 },
  { id: "groq-mixtral-8x7b-32768", upstream: "mixtral-8x7b-32768", context_window: 32768, max_output: 4000 },
  { id: "groq-gemma2-9b-it", upstream: "gemma2-9b-it", context_window: 8192, max_output: 4000 },
  { id: "groq-qwen3-32b", upstream: "qwen/qwen3-32b", context_window: 128000, max_output: 8000 },
  { id: "groq-deepseek-r1-distill-llama-70b", upstream: "deepseek-r1-distill-llama-70b", context_window: 128000, max_output: 8000 },
  { id: "groq-deepseek-r1-distill-qwen-32b", upstream: "deepseek-r1-distill-qwen-32b", context_window: 128000, max_output: 8000 },
  { id: "groq-kimi-k2-instruct", upstream: "moonshotai/kimi-k2-instruct", context_window: 128000, max_output: 8000 },
  { id: "groq-llama-3.2-90b-vision-preview", upstream: "llama-3.2-90b-vision-preview", context_window: 128000, max_output: 8000, vision: true },
];

function normalizeModelId(model: string): string {
  const lower = model.toLowerCase().trim();
  if (lower.startsWith("groq/")) return lower.slice(5);
  if (lower.startsWith("gq-")) return lower.slice(3);
  if (lower.startsWith("groq-")) return lower.slice(5);
  return lower;
}

const MODEL_BY_ID: Record<string, GroqModelDef> = Object.fromEntries(
  GROQ_MODELS.flatMap((m) => {
    const lower = m.id.toLowerCase();
    const short = normalizeModelId(m.id);
    const upstreamLower = m.upstream.toLowerCase();
    return [
      [lower, m],
      [short, m],
      [`groq/${short}`, m],
      [`gq-${short}`, m],
      [upstreamLower, m],
    ];
  })
);

export class GroqProvider extends BaseProvider {
  name = "groq";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    const lower = model.toLowerCase();
    if (MODEL_BY_ID[lower]) return true;
    const n = normalizeModelId(model);
    return !!MODEL_BY_ID[n] || !!MODEL_BY_ID[lower];
  }

  supportedModels: ModelInfo[] = GROQ_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "groq",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: false,
    vision: m.vision ?? false,
    creditUnit: "token" as const,
    creditRate: 0,
    creditSource: "estimated" as const,
  }));

  private resolveModel(model: string): GroqModelDef | null {
    const lower = model.toLowerCase();
    if (MODEL_BY_ID[lower]) return MODEL_BY_ID[lower];
    const n = normalizeModelId(model);
    return MODEL_BY_ID[n] ?? MODEL_BY_ID[lower] ?? null;
  }

  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Groq model: ${request.model}` };
    return this.chatCompletionChat(account, def, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Groq model: ${request.model}` };
    return this.chatCompletionStreamChat(account, def, request);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  async fetchQuota(account: Account): Promise<{
    success: boolean;
    quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null };
    error?: string;
  }> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    try {
      const resp = await this.fetchWithTimeout(MODELS_URL, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (resp.status === 401 || resp.status === 403) return { success: false, error: `expired: HTTP ${resp.status}` };
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Groq quota probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      await resp.text().catch(() => "");
      return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionChat(account: Account, def: GroqModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toOpenAIRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "Groq chat");
      if (err) return err;
      const data = (await resp.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };
      const promptTokens = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages);
      const completionTokens = data.usage?.completion_tokens ?? this.estimateTokens(typeof choice.message?.content === "string" ? choice.message.content : "");
      data.model = request.model;
      return { success: true, response: data, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamChat(account: Account, def: GroqModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toOpenAIRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "Groq chat stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "Groq response missing body" };
      const stream = this.passthroughOpenAIStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async handleErrorResponse(resp: Response, label: string): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) return { success: false, error: `expired: HTTP ${resp.status}` };
    if (resp.status === 429) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: text || "Rate limited", rateLimited: true };
    }
    const text = await resp.text().catch(() => "");
    return { success: false, error: `${label} HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }

  private toOpenAIRequest(request: ChatCompletionRequest, def: GroqModelDef, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: def.upstream,
      messages: this.normalizeMessagesForOpenAI(request.messages),
      stream,
    };
    if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.frequency_penalty !== undefined) body.frequency_penalty = request.frequency_penalty;
    if (request.presence_penalty !== undefined) body.presence_penalty = request.presence_penalty;
    if (request.tools && request.tools.length > 0) body.tools = this.normalizeToolsForOpenAI(request.tools);
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  private contentBlocksToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as unknown as Array<Record<string, unknown>>)
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        const t = (b as Record<string, unknown>).text;
        if (typeof t === "string") return t;
        const c = (b as Record<string, unknown>).content;
        if (typeof c === "string") return c;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private normalizeToolsForOpenAI(tools: unknown[]): unknown[] {
    return (tools as unknown as Array<Record<string, unknown>>)
      .map((t) => {
        const tt = t as Record<string, unknown>;
        const type = tt.type as string | undefined;
        const fn = tt.function as Record<string, unknown> | undefined;
        if (type === "function" && fn?.name) return t;
        if (tt.name) {
          return {
            type: "function",
            function: {
              name: tt.name,
              description: (tt.description as string) || "",
              parameters: (tt.input_schema as unknown) || (tt.parameters as unknown) || { type: "object", properties: {} },
            },
          };
        }
        return null;
      })
      .filter(Boolean) as unknown[];
  }

  private normalizeMessagesForOpenAI(messages: ChatCompletionRequest["messages"]): unknown[] {
    const out: unknown[] = [];
    for (const msg of messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (m.role === "tool") {
        out.push({ role: "tool", tool_call_id: m.tool_call_id, content: this.contentBlocksToText(m.content) });
        continue;
      }
      if (m.role === "system") {
        out.push({ role: "system", content: this.contentBlocksToText(m.content) });
        continue;
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
        const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? this.contentBlocksToText(m.content) : null;
        out.push({ role: "assistant", content, tool_calls: m.tool_calls });
        continue;
      }
      if (typeof m.content === "string") {
        out.push({ role: m.role, content: m.content });
        continue;
      }
      if (!Array.isArray(m.content)) {
        if (m.role === "assistant" && m.content == null) continue;
        out.push({ role: m.role, content: "" });
        continue;
      }
      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const textParts: string[] = [];
      const imageParts: unknown[] = [];
      const toolCalls: unknown[] = [];
      const toolResults: Array<{ id: string; content: string }> = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") { textParts.push(b.text); continue; }
        if (b.type === "image_url" && (b.image_url as Record<string, unknown>)?.url) { imageParts.push({ type: "image_url", image_url: b.image_url }); continue; }
        if (b.type === "image" && (b.source as Record<string, unknown>)?.type === "base64") {
          const src = b.source as Record<string, unknown>;
          imageParts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } });
          continue;
        }
        if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify((b.input as unknown) || {}) } });
          continue;
        }
        if (b.type === "tool_result") {
          toolResults.push({ id: b.tool_use_id as string, content: typeof b.content === "string" ? b.content as string : JSON.stringify(b.content) });
          continue;
        }
      }
      if (toolResults.length > 0) {
        for (const tr of toolResults) out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      }
      if (toolCalls.length > 0) {
        out.push({ role: "assistant", content: textParts.join("\n") || null, tool_calls: toolCalls });
        continue;
      }
      if (imageParts.length > 0) {
        const content: unknown[] = [];
        if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n") });
        content.push(...(imageParts as unknown[]));
        out.push({ role: m.role, content });
        continue;
      }
      out.push({ role: m.role, content: textParts.join("\n") });
    }
    return out;
  }

  private passthroughOpenAIStream(upstream: ReadableStream<Uint8Array>, originalModel: string): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              const payload = dataLine.slice(6).trim();
              if (!payload) continue;
              if (payload === "[DONE]") {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
                return;
              }
              try {
                const chunk = JSON.parse(payload);
                chunk.id = id;
                chunk.model = originalModel;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              } catch {
                // skip malformed
              }
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) {
          try { controller.error(err); } catch {}
        } finally {
          try { reader.releaseLock(); } catch {}
        }
      },
    });
  }
}

export interface GroqActivation {
  email: string;
  metadata: Record<string, unknown>;
}

export async function activateGroqKey(apiKey: string): Promise<GroqActivation> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");
  if (!trimmed.startsWith("gsk_")) throw new Error("Groq API key must start with gsk_");
  const resp = await fetch(MODELS_URL, { method: "GET", headers: { Authorization: `Bearer ${trimmed}` } });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Invalid API key (HTTP ${resp.status})`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Groq validation HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  await resp.text().catch(() => "");
  const hash = trimmed.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const email = `groq-${hash}@groq`;
  return { email, metadata: { validated_at: new Date().toISOString() } };
}
