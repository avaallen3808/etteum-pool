import {
  BaseProvider,
  type ChatCompletionRequest,
  type ChatCompletionResponse,
  type ModelInfo,
  type ProviderHealthResult,
  type ProviderResult,
  type StreamChunk,
} from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";

// ============================================================================
// Opencode Zen — Free tier (https://opencode.ai/docs/zen)
//
// Base URL: https://opencode.ai/zen/v1
// Auth: Authorization: Bearer <OPENCODE_API_KEY>
//
// Free models (pricing = Free per 1M tokens, limited-time promo):
//   • big-pickle                      → /chat/completions
//   • deepseek-v4-flash-free          → /chat/completions
//   • mimo-v2.5-free                  → /chat/completions
//   • ling-3.0-flash-fin-free         → /chat/completions
//   • nemotron-3-ultra-free           → /chat/completions
//   • nemotron-3.5-lightning-free     → /chat/completions
//   • laguna-s-2.1-free               → /chat/completions
//   • muse-spark-1.2-contributor-free → /responses  (Responses API)
//
// Live catalog verified at https://opencode.ai/zen/v1/models (2026-08-31)
// = 8 free models total. Docker docs may lag; live list is source of truth.
//
// All models are exposed with their native IDs. We also accept
// `opencode/<id>` and `oc-<id>` aliases so clients can namespace them
// without colliding with other providers.
// ============================================================================

const OPENCODE_BASE = "https://opencode.ai/zen/v1";
const CHAT_URL = `${OPENCODE_BASE}/chat/completions`;
const RESPONSES_URL = `${OPENCODE_BASE}/responses`;
const MODELS_URL = `${OPENCODE_BASE}/models`;

type OpencodeRoute = "chat" | "responses";

interface OpencodeModelDef {
  id: string;
  upstream: string;
  route: OpencodeRoute;
  context_window: number;
  max_output: number;
  thinking?: boolean;
  vision?: boolean;
  creditRate: number; // 0 for free
}

const OPENCODE_MODELS: OpencodeModelDef[] = [
  {
    id: "big-pickle",
    upstream: "big-pickle",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "deepseek-v4-flash-free",
    upstream: "deepseek-v4-flash-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "mimo-v2.5-free",
    upstream: "mimo-v2.5-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "ling-3.0-flash-fin-free",
    upstream: "ling-3.0-flash-fin-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "nemotron-3-ultra-free",
    upstream: "nemotron-3-ultra-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "nemotron-3.5-lightning-free",
    upstream: "nemotron-3.5-lightning-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "laguna-s-2.1-free",
    upstream: "laguna-s-2.1-free",
    route: "chat",
    context_window: 128000,
    max_output: 16000,
    vision: false,
    creditRate: 0,
  },
  {
    id: "muse-spark-1.2-contributor-free",
    upstream: "muse-spark-1.2-contributor-free",
    route: "responses",
    context_window: 128000,
    max_output: 16000,
    vision: true,
    creditRate: 0,
  },
];

const MODEL_BY_ID: Record<string, OpencodeModelDef> = Object.fromEntries(
  OPENCODE_MODELS.flatMap((m) => {
    const lower = m.id.toLowerCase();
    return [
      [lower, m],
      [`opencode/${lower}`, m],
      [`opencode-zen/${lower}`, m],
      [`oc-${lower}`, m],
    ];
  })
);

function normalizeModelId(model: string): string {
  const lower = model.toLowerCase().trim();
  // strip opencode/ prefix variants for lookup
  if (lower.startsWith("opencode/")) return lower.slice("opencode/".length);
  if (lower.startsWith("opencode-zen/")) return lower.slice("opencode-zen/".length);
  if (lower.startsWith("oc-")) return lower.slice(3);
  return lower;
}

export class OpencodeProvider extends BaseProvider {
  name = "opencode";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    const n = normalizeModelId(model);
    // also check original lower for aliases
    return !!MODEL_BY_ID[model.toLowerCase()] || !!MODEL_BY_ID[n];
  }

  supportedModels: ModelInfo[] = OPENCODE_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "opencode",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: m.thinking ?? false,
    vision: m.vision ?? false,
    creditUnit: "token" as const,
    creditRate: m.creditRate,
    creditSource: "estimated" as const,
  }));

  private resolveModel(model: string): OpencodeModelDef | null {
    const lower = model.toLowerCase();
    if (MODEL_BY_ID[lower]) return MODEL_BY_ID[lower]!;
    const n = normalizeModelId(model);
    return MODEL_BY_ID[n] ?? null;
  }

  private getApiKey(account: Account): string {
    try {
      return decrypt(account.password);
    } catch {
      return "";
    }
  }

  // ── Provider Interface ─────────────────────────────────────────────

  async chatCompletion(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Opencode model: ${request.model}` };
    return def.route === "responses"
      ? this.chatCompletionResponses(account, def, request)
      : this.chatCompletionChat(account, def, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown Opencode model: ${request.model}` };
    return def.route === "responses"
      ? this.chatCompletionStreamResponses(account, def, request)
      : this.chatCompletionStreamChat(account, def, request);
  }

  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> {
    // API key is static
    return { success: true };
  }

  async validateAccount(account: Account): Promise<boolean> {
    return !!this.getApiKey(account);
  }

  /**
   * Probe /models as liveness check. Opencode returns 401 on bad key.
   * Free models have no quota numbers → report -1 sentinel (unlimited).
   */
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
      if (resp.status === 401 || resp.status === 403) {
        return { success: false, error: `expired: HTTP ${resp.status}` };
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        return { success: false, error: `Opencode quota probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      await resp.text().catch(() => "");
      return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Chat Completions route (/chat/completions) ─────────────────────

  private async chatCompletionChat(
    account: Account,
    def: OpencodeModelDef,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const err = await this.handleErrorResponse(resp, "Opencode chat");
      if (err) return err;

      const data = (await resp.json()) as ChatCompletionResponse;
      const choice = data.choices?.[0];
      if (!choice) return { success: false, error: "No choices in response" };

      const promptTokens = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(request.messages);
      const completionTokens =
        data.usage?.completion_tokens ??
        this.estimateTokens(typeof choice.message?.content === "string" ? choice.message.content : "");

      data.model = request.model;

      return {
        success: true,
        response: data,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamChat(
    account: Account,
    def: OpencodeModelDef,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toOpenAIRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      const err = await this.handleErrorResponse(resp, "Opencode chat stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "Opencode response missing body" };

      const stream = this.passthroughOpenAIStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Responses route (/responses) — for muse-spark-contributor-free ───

  private async chatCompletionResponses(
    account: Account,
    def: OpencodeModelDef,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toResponsesRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(RESPONSES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      const err = await this.handleErrorResponse(resp, "Opencode responses");
      if (err) return err;

      const data = (await resp.json()) as any;
      const response = this.fromResponsesResponse(data, request.model);
      const promptTokens = response.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = response.usage.completion_tokens || 0;

      return {
        success: true,
        response,
        promptTokens,
        completionTokens,
        tokensUsed: promptTokens + completionTokens,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamResponses(
    account: Account,
    def: OpencodeModelDef,
    request: ChatCompletionRequest
  ): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };

    const body = this.toResponsesRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(RESPONSES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      });

      const err = await this.handleErrorResponse(resp, "Opencode responses stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "Opencode response missing body" };

      const stream = this.transformResponsesStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Error mapping ──────────────────────────────────────────────────

  private async handleErrorResponse(resp: Response, label: string): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) {
      return { success: false, error: `expired: HTTP ${resp.status}` };
    }
    if (resp.status === 429) {
      const text = await resp.text().catch(() => "");
      return { success: false, error: text || "Rate limited", rateLimited: true };
    }
    const text = await resp.text().catch(() => "");
    return { success: false, error: `${label} HTTP ${resp.status}: ${text.slice(0, 300)}` };
  }

  // ── OpenAI request shaping (chat/completions) ─────────────────────

  private toOpenAIRequest(
    request: ChatCompletionRequest,
    def: OpencodeModelDef,
    stream: boolean
  ): Record<string, unknown> {
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

  // ── Responses request shaping ──────────────────────────────────────

  private toResponsesRequest(
    request: ChatCompletionRequest,
    def: OpencodeModelDef,
    stream: boolean
  ): Record<string, unknown> {
    // OpenAI Responses API: { model, input, stream }
    // input is array of { role, content } where content can be string or array.
    // We reuse normalized messages, converting tool messages to user with tool result.
    const input = this.messagesToResponsesInput(request.messages);
    const body: Record<string, unknown> = {
      model: def.upstream,
      input,
      stream,
    };
    if (request.max_tokens !== undefined) body.max_output_tokens = request.max_tokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.tools && request.tools.length > 0) body.tools = this.normalizeToolsForResponses(request.tools);
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  private messagesToResponsesInput(messages: ChatCompletionRequest["messages"]): any[] {
    const out: any[] = [];
    for (const msg of messages) {
      if (msg.role === "tool") {
        out.push({
          role: "user",
          content: [
            {
              type: "input_text",
              text: this.contentBlocksToText(msg.content),
            },
          ],
        });
        // Also include tool result as separate context if needed
        continue;
      }
      if (msg.role === "system") {
        out.push({ role: "system", content: this.contentBlocksToText(msg.content) });
        continue;
      }
      if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
        // Keep assistant text + tool calls
        const text = typeof msg.content === "string" ? msg.content : this.contentBlocksToText(msg.content);
        const item: any = { role: "assistant", content: text || "" };
        if ((msg as any).tool_calls) item.tool_calls = (msg as any).tool_calls;
        out.push(item);
        continue;
      }
      if (typeof msg.content === "string") {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (Array.isArray(msg.content)) {
        const text = this.contentBlocksToText(msg.content);
        if (text) out.push({ role: msg.role, content: text });
        else out.push({ role: msg.role, content: "" });
        continue;
      }
      out.push({ role: msg.role, content: "" });
    }
    return out;
  }

  private normalizeToolsForResponses(tools: any[]): any[] {
    // Responses API expects OpenAI function tools: { type:"function", name, description, parameters }
    return tools
      .map((t) => {
        if (t?.type === "function" && t.function?.name) {
          return {
            type: "function",
            name: t.function.name,
            description: t.function.description || "",
            parameters: t.function.parameters || { type: "object", properties: {} },
          };
        }
        if (t?.name) {
          return {
            type: "function",
            name: t.name,
            description: t.description || "",
            parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private fromResponsesResponse(data: any, originalModel: string): ChatCompletionResponse {
    // Responses API returns { id, output: [{type:"message", content:[{type:"output_text", text}]}], usage: {...} }
    // Fallback handling for { output_text } or { content }
    let text = "";
    let toolCalls: any[] = [];

    // Try output array
    if (Array.isArray(data?.output)) {
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
            if (c?.type === "text" && typeof c.text === "string") text += c.text;
          }
        }
        // responses tool calls are in output with type:"function_call"
        if (item?.type === "function_call") {
          toolCalls.push({
            id: item.call_id || item.id || `call_${toolCalls.length}`,
            type: "function" as const,
            function: {
              name: item.name || "",
              arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
            },
          });
        }
      }
    }

    // Alternative flat text field
    if (!text && typeof data?.output_text === "string") text = data.output_text;
    if (!text && typeof data?.content === "string") text = data.content;
    if (!text && Array.isArray(data?.content)) {
      text = data.content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text || "")
        .join("");
    }

    const inputTokens = Number(data?.usage?.input_tokens ?? data?.usage?.prompt_tokens) || 0;
    const outputTokens = Number(data?.usage?.output_tokens ?? data?.usage?.completion_tokens) || 0;

    const message: any = { role: "assistant", content: text };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    return {
      id: data?.id || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
      },
    };
  }

  // ── Normalization helpers (shared with chat route) ─────────────────

  private contentBlocksToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as any[])
      .map((b) => {
        if (!b || typeof b !== "object") return "";
        if (typeof b.text === "string") return b.text;
        if (typeof b.content === "string") return b.content;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  private normalizeToolsForOpenAI(tools: any[]): any[] {
    return tools
      .map((t) => {
        if (t?.type === "function" && t.function?.name) return t;
        if (t?.name) {
          return {
            type: "function",
            function: {
              name: t.name,
              description: t.description || "",
              parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
            },
          };
        }
        return null;
      })
      .filter(Boolean);
  }

  private normalizeMessagesForOpenAI(messages: ChatCompletionRequest["messages"]): any[] {
    const out: any[] = [];
    for (const msg of messages) {
      if (msg.role === "tool") {
        out.push({
          role: "tool",
          tool_call_id: (msg as any).tool_call_id,
          content: this.contentBlocksToText(msg.content),
        });
        continue;
      }
      if (msg.role === "system") {
        out.push({ role: "system", content: this.contentBlocksToText(msg.content) });
        continue;
      }
      if (msg.role === "assistant" && Array.isArray((msg as any).tool_calls) && (msg as any).tool_calls.length > 0) {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : Array.isArray(msg.content)
              ? this.contentBlocksToText(msg.content)
              : null;
        out.push({ role: "assistant", content, tool_calls: (msg as any).tool_calls });
        continue;
      }
      if (typeof msg.content === "string") {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) {
        if (msg.role === "assistant" && msg.content == null) continue;
        out.push({ role: msg.role, content: "" });
        continue;
      }
      const blocks = msg.content as any[];
      const textParts: string[] = [];
      const imageParts: any[] = [];
      const toolCalls: any[] = [];
      const toolResults: { id: string; content: string }[] = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") { textParts.push(b.text); continue; }
        if (b.type === "image_url" && b.image_url?.url) { imageParts.push({ type: "image_url", image_url: b.image_url }); continue; }
        if (b.type === "image" && b.source?.type === "base64") {
          imageParts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
          continue;
        }
        if (b.type === "image" && b.source?.type === "url" && b.source.url) {
          imageParts.push({ type: "image_url", image_url: { url: b.source.url } });
          continue;
        }
        if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
          continue;
        }
        if (b.type === "tool_result") {
          toolResults.push({ id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
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
        const content: any[] = [];
        if (textParts.length > 0) content.push({ type: "text", text: textParts.join("\n") });
        content.push(...imageParts);
        out.push({ role: msg.role, content });
        continue;
      }
      out.push({ role: msg.role, content: textParts.join("\n") });
    }
    return out;
  }

  // ── SSE passthrough ────────────────────────────────────────────────

  private passthroughOpenAIStream(
    upstream: ReadableStream<Uint8Array>,
    originalModel: string
  ): ReadableStream<Uint8Array> {
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
              } catch { /* skip malformed */ }
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

  /**
   * Transform Responses SSE → OpenAI Chat SSE.
   * Responses events: response.output_text.delta, response.completed, etc.
   * We emit ChatCompletion chunks so proxy edge stays OpenAI-compatible.
   */
  private transformResponsesStream(
    upstream: ReadableStream<Uint8Array>,
    originalModel: string
  ): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let emittedRole = false;

        const emit = (delta: string, finish?: string) => {
          const chunk: StreamChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model: originalModel,
            choices: [
              {
                index: 0,
                delta: {
                  ...(emittedRole ? {} : { role: "assistant" }),
                  content: delta || undefined,
                } as any,
                finish_reason: (finish as any) || null,
              },
            ],
          };
          if (!emittedRole && delta) emittedRole = true;
          // Always mark role on first chunk
          if (!emittedRole) {
            (chunk.choices[0] as any).delta.role = "assistant";
            emittedRole = true;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";

            for (const part of parts) {
              const lines = part.split("\n");
              let eventType = "";
              let dataPayload = "";
              for (const line of lines) {
                if (line.startsWith("event: ")) eventType = line.slice(7).trim();
                if (line.startsWith("data: ")) dataPayload = line.slice(6).trim();
              }
              if (!dataPayload || dataPayload === "[DONE]") continue;

              try {
                const data = JSON.parse(dataPayload);

                // Responses API delta variants
                if (data?.type === "response.output_text.delta" && typeof data.delta === "string") {
                  emit(data.delta);
                  continue;
                }
                if (data?.type === "response.text.delta" && typeof data.delta === "string") {
                  emit(data.delta);
                  continue;
                }
                // Some gateways emit OpenAI-like delta directly
                if (data?.choices?.[0]?.delta?.content) {
                  emit(data.choices[0].delta.content);
                  continue;
                }
                if (typeof data?.delta === "string" && !data?.type) {
                  emit(data.delta);
                  continue;
                }
                // Completed signal
                if (data?.type === "response.completed" || data?.type === "response.done") {
                  emit("", "stop");
                  continue;
                }
                // Fallback: if object has output_text
                if (typeof data?.output_text === "string") {
                  emit(data.output_text);
                  continue;
                }
              } catch {
                // plain text delta?
                if (dataPayload && !dataPayload.startsWith("{")) {
                  emit(dataPayload);
                }
              }
            }
          }
          // Ensure we close with DONE
          // Emit final stop if not already
          const doneChunk: StreamChunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model: originalModel,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
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

// ============================================================================
// Public helpers (used by accounts API for add-account flow)
// ============================================================================

export interface OpencodeActivation {
  email: string;
  metadata: Record<string, unknown>;
}

/**
 * Validate an Opencode API key and derive a stable email-like identifier.
 * Hits GET /models — cheapest authenticated endpoint.
 */
export async function activateOpencodeKey(apiKey: string): Promise<OpencodeActivation> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");
  if (trimmed.length < 10) throw new Error("API key looks too short");

  const resp = await fetch(MODELS_URL, {
    method: "GET",
    headers: { Authorization: `Bearer ${trimmed}` },
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Invalid API key (HTTP ${resp.status})`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Opencode validation HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  // Drain body
  await resp.text().catch(() => "");

  // Derive stable label from key hash — Opencode doesn't expose email via API
  const hash = trimmed.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const email = `opencode-${hash}@opencode`;

  return {
    email,
    metadata: { validated_at: new Date().toISOString() },
  };
}
