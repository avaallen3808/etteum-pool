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
// B.AI — Unified LLM API (https://docs.b.ai/llmservice/api/)
// Base URL: https://api.b.ai/v1
// Auth: Authorization: Bearer sk-...  (also x-api-key)
// Endpoints:
//   GET  /models            — list models
//   POST /chat/completions  — OpenAI Chat
//   POST /responses         — OpenAI Responses
//   POST /messages          — Anthropic Messages
//
// This provider uses /chat/completions as primary (OpenAI-compatible).
// It accepts any model via `bai-<model>` / `bai/<model>` prefix and
// strips the prefix for upstream. A small curated list is exposed for
// dashboard visibility; unknown `bai-` models are also proxied dynamically.
// ============================================================================

const BAI_BASE = "https://api.b.ai/v1";
const CHAT_URL = `${BAI_BASE}/chat/completions`;
const RESPONSES_URL = `${BAI_BASE}/responses`;
const MESSAGES_URL = `${BAI_BASE}/messages`;
const MODELS_URL = `${BAI_BASE}/models`;

interface BaiModelDef {
  id: string;
  upstream: string;
  context_window: number;
  max_output: number;
  route: "chat" | "responses" | "messages";
}

const BAI_MODELS: BaiModelDef[] = [
  // Curated examples — actual availability depends on B.AI account's enabled models.
  // All are via `bai-` prefix; upstream is without prefix.
  { id: "bai-gpt-5", upstream: "gpt-5", context_window: 128000, max_output: 16000, route: "chat" },
  { id: "bai-gpt-5-mini", upstream: "gpt-5-mini", context_window: 128000, max_output: 8000, route: "chat" },
  { id: "bai-claude-sonnet-4.5", upstream: "claude-sonnet-4.5", context_window: 200000, max_output: 16000, route: "messages" },
  { id: "bai-claude-opus-4.5", upstream: "claude-opus-4.5", context_window: 200000, max_output: 16000, route: "messages" },
  { id: "bai-gemini-3-flash", upstream: "gemini-3-flash", context_window: 1000000, max_output: 8000, route: "chat" },
  { id: "bai-deepseek-v3", upstream: "deepseek-v3", context_window: 128000, max_output: 8000, route: "chat" },
  { id: "bai-qwen3-235b", upstream: "qwen3-235b", context_window: 128000, max_output: 8000, route: "chat" },
  { id: "bai-glm-4.7", upstream: "glm-4.7", context_window: 128000, max_output: 8000, route: "chat" },
  { id: "bai-kimi-k2", upstream: "kimi-k2", context_window: 128000, max_output: 8000, route: "chat" },
  { id: "bai-grok-4", upstream: "grok-4", context_window: 128000, max_output: 8000, route: "chat" },
];

function normalizeModelId(model: string): string {
  const lower = model.toLowerCase().trim();
  if (lower.startsWith("bai/")) return lower.slice(4);
  if (lower.startsWith("bai-")) return lower.slice(4);
  if (lower.startsWith("b.ai/")) return lower.slice(5);
  if (lower.startsWith("b.ai-")) return lower.slice(5);
  return lower;
}

const MODEL_BY_ID: Record<string, BaiModelDef> = Object.fromEntries(
  BAI_MODELS.flatMap((m) => {
    const lower = m.id.toLowerCase();
    const short = normalizeModelId(m.id);
    return [
      [lower, m],
      [short, m],
      [`bai/${short}`, m],
      [`bai-${short}`, m],
    ];
  })
);

export class BaiProvider extends BaseProvider {
  name = "bai";
  override nativeFormat: "openai" | "anthropic" = "openai";

  override ownsModel(model: string): boolean {
    const lower = model.toLowerCase();
    if (MODEL_BY_ID[lower]) return true;
    // Accept any bai- prefix dynamically
    if (lower.startsWith("bai-") || lower.startsWith("bai/") || lower.startsWith("b.ai-") || lower.startsWith("b.ai/")) return true;
    const n = normalizeModelId(model);
    return !!MODEL_BY_ID[n];
  }

  supportedModels: ModelInfo[] = BAI_MODELS.map((m) => ({
    id: m.id,
    object: "model" as const,
    created: Date.now(),
    owned_by: "bai",
    context_window: m.context_window,
    max_output: m.max_output,
    thinking: false,
    vision: false,
    creditUnit: "token" as const,
    creditRate: 0,
    creditSource: "estimated" as const,
  }));

  private resolveModel(model: string): BaiModelDef | null {
    const lower = model.toLowerCase();
    if (MODEL_BY_ID[lower]) return MODEL_BY_ID[lower];
    const n = normalizeModelId(model);
    if (MODEL_BY_ID[n]) return MODEL_BY_ID[n];
    // Dynamic fallback: any bai- model → chat route
    if (lower.startsWith("bai-") || lower.startsWith("bai/") || lower.startsWith("b.ai-") || lower.startsWith("b.ai/")) {
      const upstream = n || lower.replace(/^bai[-/]/, "").replace(/^b\.ai[-/]/, "");
      return {
        id: model,
        upstream,
        context_window: 128000,
        max_output: 8000,
        route: "chat",
      };
    }
    return null;
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
    if (!def) return { success: false, error: `Unknown B.AI model: ${request.model}` };
    if (def.route === "responses") return this.chatCompletionResponses(account, def, request);
    if (def.route === "messages") return this.chatCompletionMessages(account, def, request);
    return this.chatCompletionChat(account, def, request);
  }

  async chatCompletionStream(account: Account, request: ChatCompletionRequest): Promise<ProviderResult> {
    const def = this.resolveModel(request.model);
    if (!def) return { success: false, error: `Unknown B.AI model: ${request.model}` };
    if (def.route === "responses") return this.chatCompletionStreamResponses(account, def, request);
    if (def.route === "messages") return this.chatCompletionStreamMessages(account, def, request);
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
        return { success: false, error: `B.AI quota probe HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      await resp.text().catch(() => "");
      return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Chat Completions ───────────────────────────────────────────────
  private async chatCompletionChat(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toOpenAIRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI chat");
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

  private async chatCompletionStreamChat(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toOpenAIRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI chat stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "B.AI response missing body" };
      const stream = this.passthroughOpenAIStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Responses API ──────────────────────────────────────────────────
  private async chatCompletionResponses(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toResponsesRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(RESPONSES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI responses");
      if (err) return err;
      const data = (await resp.json()) as unknown;
      const response = this.fromResponsesResponse(data, request.model);
      const promptTokens = response.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = response.usage.completion_tokens || 0;
      return { success: true, response, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamResponses(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toResponsesRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(RESPONSES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI responses stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "B.AI response missing body" };
      const stream = this.transformResponsesStream(resp.body, request.model);
      return { success: true, stream, promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ── Anthropic Messages ─────────────────────────────────────────────
  private async chatCompletionMessages(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toAnthropicRequest(request, def, false);
    try {
      const resp = await this.fetchWithTimeout(MESSAGES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI messages");
      if (err) return err;
      const data = (await resp.json()) as unknown;
      const response = this.fromAnthropicResponse(data, request.model);
      const promptTokens = response.usage.prompt_tokens || this.estimateMessagesTokens(request.messages);
      const completionTokens = response.usage.completion_tokens || 0;
      return { success: true, response, promptTokens, completionTokens, tokensUsed: promptTokens + completionTokens };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async chatCompletionStreamMessages(account: Account, def: BaiModelDef, request: ChatCompletionRequest): Promise<ProviderResult> {
    const apiKey = this.getApiKey(account);
    if (!apiKey) return { success: false, error: "No API key" };
    const body = this.toAnthropicRequest(request, def, true);
    try {
      const resp = await this.fetchWithTimeout(MESSAGES_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "anthropic-version": "2023-06-01", Accept: "text/event-stream" },
        body: JSON.stringify(body),
      });
      const err = await this.handleErrorResponse(resp, "B.AI messages stream");
      if (err) return err;
      if (!resp.body) return { success: false, error: "B.AI response missing body" };
      const stream = this.transformAnthropicStream(resp.body, request.model);
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

  // ── Request shaping (shared helpers) ───────────────────────────────
  private toOpenAIRequest(request: ChatCompletionRequest, def: BaiModelDef, stream: boolean): Record<string, unknown> {
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
    if (request.tools && (request.tools as unknown[]).length > 0) body.tools = this.normalizeToolsForOpenAI(request.tools as unknown[]);
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  private toResponsesRequest(request: ChatCompletionRequest, def: BaiModelDef, stream: boolean): Record<string, unknown> {
    const input = this.messagesToResponsesInput(request.messages);
    const body: Record<string, unknown> = { model: def.upstream, input, stream };
    if (request.max_tokens !== undefined) body.max_output_tokens = request.max_tokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.tools && (request.tools as unknown[]).length > 0) body.tools = this.normalizeToolsForResponses(request.tools as unknown[]);
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  private toAnthropicRequest(request: ChatCompletionRequest, def: BaiModelDef, stream: boolean): Record<string, unknown> {
    const systemParts: string[] = [];
    const messages: Array<Record<string, unknown>> = [];
    for (const msg of request.messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (m.role === "system") {
        const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
        if (text) systemParts.push(text);
        continue;
      }
      const role = m.role === "tool" ? "user" : (m.role as string);
      if (m.role === "tool") {
        const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? (m.content as unknown as Array<Record<string, unknown>>).map((b) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n") : "";
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content }] });
        continue;
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
        const blocks: unknown[] = [];
        if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.tool_calls as unknown as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          let input: unknown = {};
          try { input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments as string) : fn.arguments || {}; } catch { input = { _raw: fn.arguments }; }
          blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input });
        }
        messages.push({ role: "assistant", content: blocks });
        continue;
      }
      messages.push({ role, content: m.content });
    }
    const body: Record<string, unknown> = { model: def.upstream, messages, max_tokens: Math.min((request.max_tokens as number) || 4096, def.max_output), stream };
    if (systemParts.length > 0) body.system = systemParts.join("\n\n");
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.top_p !== undefined) body.top_p = request.top_p;
    if (request.tools && (request.tools as unknown[]).length > 0) {
      body.tools = (request.tools as unknown as Array<Record<string, unknown>>).map((t) => {
        if ((t as Record<string, unknown>).name && (t as Record<string, unknown>).input_schema) return t;
        const fn = (t as Record<string, unknown>).function as Record<string, unknown>;
        if (!fn?.name) return null;
        return { name: fn.name, description: fn.description || "", input_schema: fn.parameters || { type: "object", properties: {} } };
      }).filter(Boolean);
    }
    if (request.tool_choice !== undefined) body.tool_choice = request.tool_choice;
    return body;
  }

  private messagesToResponsesInput(messages: ChatCompletionRequest["messages"]): unknown[] {
    const out: unknown[] = [];
    for (const msg of messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (m.role === "tool") {
        out.push({ role: "user", content: [{ type: "input_text", text: this.contentBlocksToText(m.content) }] });
        continue;
      }
      if (m.role === "system") { out.push({ role: "system", content: this.contentBlocksToText(m.content) }); continue; }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
        const text = typeof m.content === "string" ? m.content : this.contentBlocksToText(m.content);
        const item: Record<string, unknown> = { role: "assistant", content: text || "" };
        if (m.tool_calls) item.tool_calls = m.tool_calls;
        out.push(item);
        continue;
      }
      if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
      if (Array.isArray(m.content)) {
        const text = this.contentBlocksToText(m.content);
        if (text) out.push({ role: m.role, content: text });
        else out.push({ role: m.role, content: "" });
        continue;
      }
      out.push({ role: m.role, content: "" });
    }
    return out;
  }

  private normalizeToolsForResponses(tools: unknown[]): unknown[] {
    return (tools as unknown as Array<Record<string, unknown>>).map((t) => {
      const tt = t as Record<string, unknown>;
      const fn = tt.function as Record<string, unknown>;
      if (tt.type === "function" && fn?.name) return { type: "function", name: fn.name, description: fn.description || "", parameters: fn.parameters || { type: "object", properties: {} } };
      if (tt.name) return { type: "function", name: tt.name, description: tt.description || "", parameters: (tt.input_schema as unknown) || (tt.parameters as unknown) || { type: "object", properties: {} } };
      return null;
    }).filter(Boolean) as unknown[];
  }

  private fromResponsesResponse(data: unknown, originalModel: string): ChatCompletionResponse {
    const d = data as Record<string, unknown>;
    let text = "";
    const toolCalls: unknown[] = [];
    if (Array.isArray(d.output)) {
      for (const item of d.output as unknown as Array<Record<string, unknown>>) {
        if (item?.type === "message" && Array.isArray(item.content)) {
          for (const c of item.content as unknown as Array<Record<string, unknown>>) {
            if (c?.type === "output_text" && typeof c.text === "string") text += c.text;
            if (c?.type === "text" && typeof c.text === "string") text += c.text;
          }
        }
        if (item?.type === "function_call") {
          toolCalls.push({ id: (item.call_id as string) || (item.id as string) || `call_${toolCalls.length}`, type: "function" as const, function: { name: (item.name as string) || "", arguments: typeof item.arguments === "string" ? item.arguments as string : JSON.stringify(item.arguments || {}) } });
        }
      }
    }
    if (!text && typeof d.output_text === "string") text = d.output_text as string;
    const inputTokens = Number((d.usage as Record<string, unknown>)?.input_tokens ?? (d.usage as Record<string, unknown>)?.prompt_tokens) || 0;
    const outputTokens = Number((d.usage as Record<string, unknown>)?.output_tokens ?? (d.usage as Record<string, unknown>)?.completion_tokens) || 0;
    const message: Record<string, unknown> = { role: "assistant", content: text };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return {
      id: (d.id as string) || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{ index: 0, message: message as unknown as ChatCompletionResponse["choices"][0]["message"], finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
  }

  private fromAnthropicResponse(data: unknown, originalModel: string): ChatCompletionResponse {
    const d = data as Record<string, unknown>;
    const content = Array.isArray(d.content) ? d.content as unknown as Array<Record<string, unknown>> : [];
    const textContent = content.filter((c) => c?.type === "text").map((c) => c.text || "").join("");
    const toolCalls = content.filter((c) => c?.type === "tool_use").map((c, i) => ({ id: (c.id as string) || `call_${i}`, type: "function" as const, function: { name: (c.name as string) || "", arguments: JSON.stringify(c.input || {}) } }));
    const inputTokens = Number((d.usage as Record<string, unknown>)?.input_tokens) || 0;
    const outputTokens = Number((d.usage as Record<string, unknown>)?.output_tokens) || 0;
    const finishReason = d.stop_reason === "tool_use" ? "tool_calls" : d.stop_reason === "max_tokens" ? "length" : "stop";
    const message: Record<string, unknown> = { role: "assistant", content: textContent };
    if (toolCalls.length > 0) message.tool_calls = toolCalls;
    return {
      id: (d.id as string) || this.generateId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: originalModel,
      choices: [{ index: 0, message: message as unknown as ChatCompletionResponse["choices"][0]["message"], finish_reason: finishReason as ChatCompletionResponse["choices"][0]["finish_reason"] }],
      usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    };
  }

  private contentBlocksToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as unknown as Array<Record<string, unknown>>).map((b) => {
      if (!b || typeof b !== "object") return "";
      const t = (b as Record<string, unknown>).text;
      if (typeof t === "string") return t;
      const c = (b as Record<string, unknown>).content;
      if (typeof c === "string") return c;
      return "";
    }).filter(Boolean).join("\n");
  }

  private normalizeToolsForOpenAI(tools: unknown[]): unknown[] {
    return (tools as unknown as Array<Record<string, unknown>>).map((t) => {
      const tt = t as Record<string, unknown>;
      const type = tt.type as string | undefined;
      const fn = tt.function as Record<string, unknown> | undefined;
      if (type === "function" && fn?.name) return t;
      if (tt.name) return { type: "function", function: { name: tt.name, description: (tt.description as string) || "", parameters: (tt.input_schema as unknown) || (tt.parameters as unknown) || { type: "object", properties: {} } } };
      return null;
    }).filter(Boolean) as unknown[];
  }

  private normalizeMessagesForOpenAI(messages: ChatCompletionRequest["messages"]): unknown[] {
    const out: unknown[] = [];
    for (const msg of messages) {
      const m = msg as unknown as Record<string, unknown>;
      if (m.role === "tool") { out.push({ role: "tool", tool_call_id: m.tool_call_id, content: this.contentBlocksToText(m.content) }); continue; }
      if (m.role === "system") { out.push({ role: "system", content: this.contentBlocksToText(m.content) }); continue; }
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0) {
        const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? this.contentBlocksToText(m.content) : null;
        out.push({ role: "assistant", content, tool_calls: m.tool_calls });
        continue;
      }
      if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
      if (!Array.isArray(m.content)) { if (m.role === "assistant" && m.content == null) continue; out.push({ role: m.role, content: "" }); continue; }
      const blocks = m.content as unknown as Array<Record<string, unknown>>;
      const textParts: string[] = [];
      const imageParts: unknown[] = [];
      const toolCalls: unknown[] = [];
      const toolResults: Array<{ id: string; content: string }> = [];
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") { textParts.push(b.text); continue; }
        if (b.type === "image_url" && (b.image_url as Record<string, unknown>)?.url) { imageParts.push({ type: "image_url", image_url: b.image_url }); continue; }
        if (b.type === "image" && (b.source as Record<string, unknown>)?.type === "base64") { const src = b.source as Record<string, unknown>; imageParts.push({ type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } }); continue; }
        if (b.type === "tool_use") { toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify((b.input as unknown) || {}) } }); continue; }
        if (b.type === "tool_result") { toolResults.push({ id: b.tool_use_id as string, content: typeof b.content === "string" ? b.content as string : JSON.stringify(b.content) }); continue; }
      }
      if (toolResults.length > 0) for (const tr of toolResults) out.push({ role: "tool", tool_call_id: tr.id, content: tr.content });
      if (toolCalls.length > 0) { out.push({ role: "assistant", content: textParts.join("\n") || null, tool_calls: toolCalls }); continue; }
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
              if (payload === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
              try { const chunk = JSON.parse(payload); chunk.id = id; chunk.model = originalModel; controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)); } catch {}
            }
          }
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) { try { controller.error(err); } catch {} } finally { try { reader.releaseLock(); } catch {} }
      },
    });
  }

  private transformResponsesStream(upstream: ReadableStream<Uint8Array>, originalModel: string): ReadableStream<Uint8Array> {
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
          const chunk = { id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: { ...(emittedRole ? {} : { role: "assistant" }), content: delta || undefined } as unknown, finish_reason: (finish as unknown) || null }] };
          if (!emittedRole && delta) emittedRole = true;
          if (!emittedRole) { (chunk.choices[0] as unknown as Record<string, unknown>).delta = { role: "assistant" }; emittedRole = true; }
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
              let dataPayload = "";
              for (const line of lines) if (line.startsWith("data: ")) dataPayload = line.slice(6).trim();
              if (!dataPayload || dataPayload === "[DONE]") continue;
              try {
                const data = JSON.parse(dataPayload) as Record<string, unknown>;
                if (data?.type === "response.output_text.delta" && typeof data.delta === "string") { emit(data.delta as string); continue; }
                if (data?.type === "response.text.delta" && typeof data.delta === "string") { emit(data.delta as string); continue; }
                if ((data as unknown as Record<string, unknown>)?.choices) {
                  const c = (data as unknown as Record<string, unknown>).choices as unknown as Array<Record<string, unknown>>;
                  const delta = (c?.[0]?.delta as Record<string, unknown>)?.content;
                  if (typeof delta === "string") { emit(delta); continue; }
                }
                if (typeof data.delta === "string" && !data.type) { emit(data.delta as string); continue; }
                if (data?.type === "response.completed" || data?.type === "response.done") { emit("", "stop"); continue; }
                if (typeof data.output_text === "string") { emit(data.output_text as string); continue; }
              } catch { if (dataPayload && !dataPayload.startsWith("{")) emit(dataPayload); }
            }
          }
          const doneChunk = { id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) { try { controller.error(err); } catch {} } finally { try { reader.releaseLock(); } catch {} }
      },
    });
  }

  private transformAnthropicStream(upstream: ReadableStream<Uint8Array>, originalModel: string): ReadableStream<Uint8Array> {
    const id = this.generateId();
    const created = Math.floor(Date.now() / 1000);
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const reader = upstream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let emittedRole = false;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const parts = buffer.split("\n\n");
            buffer = parts.pop() || "";
            for (const part of parts) {
              const lines = part.split("\n");
              let event = "";
              let dataStr = "";
              for (const line of lines) {
                if (line.startsWith("event: ")) event = line.slice(7).trim();
                if (line.startsWith("data: ")) dataStr = line.slice(6);
              }
              if (!dataStr) continue;
              if (dataStr === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
              try {
                const data = JSON.parse(dataStr) as Record<string, unknown>;
                if (event === "content_block_delta" && (data.delta as Record<string, unknown>)?.type === "text_delta" && typeof (data.delta as Record<string, unknown>).text === "string") {
                  const delta = (data.delta as Record<string, unknown>).text as string;
                  const chunk = { id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: { ...(emittedRole ? {} : { role: "assistant" }), content: delta }, finish_reason: null }] };
                  if (!emittedRole) emittedRole = true;
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  continue;
                }
                if (event === "message_delta" && (data.delta as Record<string, unknown>)?.stop_reason) {
                  const reason = (data.delta as Record<string, unknown>).stop_reason as string;
                  const finish = reason === "tool_use" ? "tool_calls" : "stop";
                  const chunk = { id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: {}, finish_reason: finish }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  continue;
                }
                if (event === "message_stop") {
                  const chunk = { id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  continue;
                }
              } catch {}
            }
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: originalModel, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch (err) { try { controller.error(err); } catch {} } finally { try { reader.releaseLock(); } catch {} }
      },
    });
  }
}

export interface BaiActivation {
  email: string;
  metadata: Record<string, unknown>;
}

export async function activateBaiKey(apiKey: string): Promise<BaiActivation> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("API key is empty");
  const resp = await fetch(MODELS_URL, { method: "GET", headers: { Authorization: `Bearer ${trimmed}` } });
  if (resp.status === 401 || resp.status === 403) throw new Error(`Invalid API key (HTTP ${resp.status})`);
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`B.AI validation HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }
  await resp.text().catch(() => "");
  const hash = trimmed.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  const email = `bai-${hash}@bai`;
  return { email, metadata: { validated_at: new Date().toISOString() } };
}
