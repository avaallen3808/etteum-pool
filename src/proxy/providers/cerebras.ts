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
// Cerebras — Wafer-Scale Inference, OpenAI-compatible
// Base: https://api.cerebras.ai/v1
// Auth: Bearer csk_... (also sk-...)
// Free: 1M tokens/day, 5 RPM, 30k TPM, 8k context
// Models verified 2026-05-31: gpt-oss-120b, zai-glm-4.7 (catalog volatile)
// ============================================================================
const CEREBRAS_BASE = "https://api.cerebras.ai/v1";
const CHAT_URL = `${CEREBRAS_BASE}/chat/completions`;
const MODELS_URL = `${CEREBRAS_BASE}/models`;
interface Def { id: string; upstream: string; context_window: number; max_output: number; }
const MODELS: Def[] = [
  { id: "cerebras-gpt-oss-120b", upstream: "gpt-oss-120b", context_window: 8192, max_output: 4000 },
  { id: "cerebras-glm-4.7", upstream: "zai-glm-4.7", context_window: 8192, max_output: 4000 },
  { id: "cerebras-llama-3.3-70b", upstream: "llama-3.3-70b", context_window: 8192, max_output: 4000 },
  { id: "cerebras-qwen3-32b", upstream: "qwen3-32b", context_window: 8192, max_output: 4000 },
];
function norm(m: string): string {
  const l = m.toLowerCase().trim();
  if (l.startsWith("cerebras/")) return l.slice(9);
  if (l.startsWith("cerebras-")) return l.slice(9);
  if (l.startsWith("cb-")) return l.slice(3);
  return l;
}
const MAP: Record<string, Def> = Object.fromEntries(
  MODELS.flatMap((d) => {
    const l = d.id.toLowerCase();
    const s = norm(d.id);
    return [[l, d], [s, d], [`cerebras/${s}`, d], [`cb-${s}`, d], [d.upstream.toLowerCase(), d]];
  })
);
export class CerebrasProvider extends BaseProvider {
  name = "cerebras";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override ownsModel(m: string): boolean {
    const l = m.toLowerCase();
    if (MAP[l]) return true;
    return !!MAP[norm(m)];
  }
  supportedModels: ModelInfo[] = MODELS.map((d) => ({
    id: d.id, object: "model" as const, created: Date.now(), owned_by: "cerebras",
    context_window: d.context_window, max_output: d.max_output, thinking: false, vision: false,
    creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const,
  }));
  private resolve(m: string): Def | null {
    const l = m.toLowerCase();
    if (MAP[l]) return MAP[l];
    return MAP[norm(m)] ?? null;
  }
  private key(a: Account): string { try { return decrypt(a.password); } catch { return ""; } }
  async chatCompletion(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> {
    const d = this.resolve(r.model);
    if (!d) return { success: false, error: `Unknown Cerebras model: ${r.model}` };
    return this.chat(a, d, r);
  }
  async chatCompletionStream(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> {
    const d = this.resolve(r.model);
    if (!d) return { success: false, error: `Unknown Cerebras model: ${r.model}` };
    return this.stream(a, d, r);
  }
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> { return { success: true }; }
  async validateAccount(a: Account): Promise<boolean> { return !!this.key(a); }
  async fetchQuota(a: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    try {
      const r = await this.fetchWithTimeout(MODELS_URL, { method: "GET", headers: { Authorization: `Bearer ${k}` } });
      if (r.status === 401 || r.status === 403) return { success: false, error: `expired: HTTP ${r.status}` };
      if (!r.ok) { const t = await r.text().catch(() => ""); return { success: false, error: `Cerebras HTTP ${r.status}: ${t.slice(0,160)}` }; }
      await r.text().catch(() => ""); return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async chat(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    const body = this.toReq(r, d, false);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify(body) });
      const e = await this.err(resp, "Cerebras chat"); if (e) return e;
      const data = (await resp.json()) as ChatCompletionResponse;
      const ch = data.choices?.[0]; if (!ch) return { success: false, error: "No choices" };
      const pt = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(r.messages);
      const ct = data.usage?.completion_tokens ?? this.estimateTokens(typeof ch.message?.content === "string" ? ch.message.content : "");
      data.model = r.model;
      return { success: true, response: data, promptTokens: pt, completionTokens: ct, tokensUsed: pt + ct };
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async stream(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    const body = this.toReq(r, d, true);
    try {
      const resp = await this.fetchWithTimeout(CHAT_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}`, Accept: "text/event-stream" }, body: JSON.stringify(body) });
      const e = await this.err(resp, "Cerebras stream"); if (e) return e;
      if (!resp.body) return { success: false, error: "Cerebras missing body" };
      return { success: true, stream: this.passthrough(resp.body, r.model), promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
    } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async err(resp: Response, label: string): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) return { success: false, error: `expired: HTTP ${resp.status}` };
    if (resp.status === 429) { const t = await resp.text().catch(() => ""); return { success: false, error: t || "Rate limited", rateLimited: true }; }
    const t = await resp.text().catch(() => ""); return { success: false, error: `${label} HTTP ${resp.status}: ${t.slice(0,300)}` };
  }
  private toReq(r: ChatCompletionRequest, d: Def, stream: boolean): Record<string, unknown> {
    const b: Record<string, unknown> = { model: d.upstream, messages: this.normMsgs(r.messages), stream };
    if (r.max_tokens !== undefined) b.max_tokens = r.max_tokens;
    if (r.temperature !== undefined) b.temperature = r.temperature;
    if (r.top_p !== undefined) b.top_p = r.top_p;
    if (r.tools && (r.tools as unknown[]).length > 0) b.tools = this.normTools(r.tools as unknown[]);
    if (r.tool_choice !== undefined) b.tool_choice = r.tool_choice;
    return b;
  }
  private txt(c: unknown): string {
    if (typeof c === "string") return c;
    if (!Array.isArray(c)) return "";
    return (c as unknown as Array<Record<string, unknown>>).map((x) => (typeof x.text === "string" ? x.text : "")).filter(Boolean).join("\n");
  }
  private normTools(t: unknown[]): unknown[] {
    return (t as unknown as Array<Record<string, unknown>>).map((x) => {
      const tt = x as Record<string, unknown>; const fn = tt.function as Record<string, unknown> | undefined;
      if (tt.type === "function" && fn?.name) return x;
      if (tt.name) return { type: "function", function: { name: tt.name, description: (tt.description as string) || "", parameters: (tt.input_schema as unknown) || (tt.parameters as unknown) || { type: "object", properties: {} } } };
      return null;
    }).filter(Boolean) as unknown[];
  }
  private normMsgs(m: ChatCompletionRequest["messages"]): unknown[] {
    const o: unknown[] = [];
    for (const msg of m) {
      const x = msg as unknown as Record<string, unknown>;
      if (x.role === "tool") { o.push({ role: "tool", tool_call_id: x.tool_call_id, content: this.txt(x.content) }); continue; }
      if (x.role === "system") { o.push({ role: "system", content: this.txt(x.content) }); continue; }
      if (x.role === "assistant" && Array.isArray(x.tool_calls) && (x.tool_calls as unknown[]).length > 0) { o.push({ role: "assistant", content: typeof x.content === "string" ? x.content : this.txt(x.content) || null, tool_calls: x.tool_calls }); continue; }
      if (typeof x.content === "string") { o.push({ role: x.role, content: x.content }); continue; }
      o.push({ role: x.role, content: this.txt(x.content) });
    }
    return o;
  }
  private passthrough(up: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
    const id = this.generateId(); const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start: async (c) => {
        const r = up.getReader(); const dec = new TextDecoder(); let b = "";
        try {
          while (true) {
            const { value, done } = await r.read(); if (done) break;
            b += dec.decode(value, { stream: true }); const p = b.split("\n\n"); b = p.pop() || "";
            for (const part of p) {
              const l = part.split("\n").find((x) => x.startsWith("data: ")); if (!l) continue;
              const pay = l.slice(6).trim(); if (!pay) continue;
              if (pay === "[DONE]") { c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); return; }
              try { const j = JSON.parse(pay); j.id = id; j.model = model; c.enqueue(enc.encode(`data: ${JSON.stringify(j)}\n\n`)); } catch {}
            }
          }
          c.enqueue(enc.encode("data: [DONE]\n\n")); c.close();
        } catch (e) { try { c.error(e); } catch {} } finally { try { r.releaseLock(); } catch {} }
      },
    });
  }
}
export async function activateCerebrasKey(apiKey: string): Promise<{ email: string; metadata: Record<string, unknown> }> {
  const t = apiKey.trim(); if (!t) throw new Error("API key empty");
  const r = await fetch(MODELS_URL, { method: "GET", headers: { Authorization: `Bearer ${t}` } });
  if (r.status === 401 || r.status === 403) throw new Error(`Invalid API key (HTTP ${r.status})`);
  if (!r.ok) { const x = await r.text().catch(() => ""); throw new Error(`Cerebras HTTP ${r.status}: ${x.slice(0,200)}`); }
  await r.text().catch(() => "");
  const h = t.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  return { email: `cerebras-${h}@cerebras`, metadata: { validated_at: new Date().toISOString() } };
}
