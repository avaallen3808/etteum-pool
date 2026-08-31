import { BaseProvider, type ChatCompletionRequest, type ChatCompletionResponse, type ModelInfo, type ProviderResult } from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
// Mistral Experiment tier — all models free 1B tokens/mo, 1 req/sec
// Base: https://api.mistral.ai/v1  Auth: Bearer ...
const BASE = "https://api.mistral.ai/v1";
const CHAT = `${BASE}/chat/completions`;
const MODELS = `${BASE}/models`;
interface Def { id: string; upstream: string; context_window: number; max_output: number; }
const LIST: Def[] = [
  { id: "mistral-small", upstream: "mistral-small-latest", context_window: 32000, max_output: 4000 },
  { id: "mistral-large", upstream: "mistral-large-latest", context_window: 128000, max_output: 8000 },
  { id: "mistral-codestral", upstream: "codestral-latest", context_window: 32000, max_output: 4000 },
  { id: "mistral-pixtral-12b", upstream: "pixtral-12b-2409", context_window: 32000, max_output: 4000 },
  { id: "mistral-nemo", upstream: "open-mistral-nemo", context_window: 128000, max_output: 4000 },
];
function norm(m: string): string {
  const l = m.toLowerCase().trim();
  if (l.startsWith("mistral/")) return l.slice(8);
  if (l.startsWith("mistral-")) return l.slice(8);
  return l;
}
const MAP: Record<string, Def> = Object.fromEntries(LIST.flatMap((d) => [[d.id.toLowerCase(), d], [norm(d.id), d], [`mistral/${norm(d.id)}`, d], [`mistral-${norm(d.id)}`, d], [d.upstream.toLowerCase(), d]]));
export class MistralProvider extends BaseProvider {
  name = "mistral";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override ownsModel(m: string): boolean { const l = m.toLowerCase(); if (MAP[l]) return true; return !!MAP[norm(m)]; }
  supportedModels: ModelInfo[] = LIST.map((d) => ({ id: d.id, object: "model" as const, created: Date.now(), owned_by: "mistral", context_window: d.context_window, max_output: d.max_output, thinking: false, vision: d.id.includes("pixtral"), creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const }));
  private resolve(m: string): Def | null { const l = m.toLowerCase(); if (MAP[l]) return MAP[l]; return MAP[norm(m)] ?? null; }
  private key(a: Account): string { try { return decrypt(a.password); } catch { return ""; } }
  async chatCompletion(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> { const d = this.resolve(r.model); if (!d) return { success: false, error: `Unknown Mistral model: ${r.model}` }; return this.chat(a, d, r); }
  async chatCompletionStream(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> { const d = this.resolve(r.model); if (!d) return { success: false, error: `Unknown Mistral model: ${r.model}` }; return this.stream(a, d, r); }
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> { return { success: true }; }
  async validateAccount(a: Account): Promise<boolean> { return !!this.key(a); }
  async fetchQuota(a: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    try { const r = await this.fetchWithTimeout(MODELS, { method: "GET", headers: { Authorization: `Bearer ${k}` } }); if (r.status === 401 || r.status === 403) return { success: false, error: `expired: HTTP ${r.status}` }; if (!r.ok) { const t = await r.text().catch(() => ""); return { success: false, error: `Mistral HTTP ${r.status}: ${t.slice(0,160)}` }; } await r.text().catch(() => ""); return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } }; } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async chat(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    const b: Record<string, unknown> = { model: d.upstream, messages: this.msgs(r.messages), stream: false };
    if (r.max_tokens !== undefined) b.max_tokens = r.max_tokens;
    if (r.temperature !== undefined) b.temperature = r.temperature;
    if (r.top_p !== undefined) b.top_p = r.top_p;
    try { const resp = await this.fetchWithTimeout(CHAT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify(b) }); const e = await this.err(resp, "Mistral chat"); if (e) return e; const data = (await resp.json()) as ChatCompletionResponse; const ch = data.choices?.[0]; if (!ch) return { success: false, error: "No choices" }; const pt = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(r.messages); const ct = data.usage?.completion_tokens ?? this.estimateTokens(typeof ch.message?.content === "string" ? ch.message.content : ""); data.model = r.model; return { success: true, response: data, promptTokens: pt, completionTokens: ct, tokensUsed: pt + ct }; } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async stream(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.key(a); if (!k) return { success: false, error: "No API key" };
    const b: Record<string, unknown> = { model: d.upstream, messages: this.msgs(r.messages), stream: true };
    if (r.max_tokens !== undefined) b.max_tokens = r.max_tokens;
    if (r.temperature !== undefined) b.temperature = r.temperature;
    if (r.top_p !== undefined) b.top_p = r.top_p;
    try { const resp = await this.fetchWithTimeout(CHAT, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}`, Accept: "text/event-stream" }, body: JSON.stringify(b) }); const e = await this.err(resp, "Mistral stream"); if (e) return e; if (!resp.body) return { success: false, error: "Mistral missing body" }; return { success: true, stream: this.pass(resp.body, r.model), promptTokens: 0, completionTokens: 0, tokensUsed: 0 }; } catch (e) { return { success: false, error: e instanceof Error ? e.message : String(e) }; }
  }
  private async err(resp: Response, label: string): Promise<ProviderResult | null> {
    if (resp.ok) return null;
    if (resp.status === 401 || resp.status === 403) return { success: false, error: `expired: HTTP ${resp.status}` };
    if (resp.status === 429) { const t = await resp.text().catch(() => ""); return { success: false, error: t || "Rate limited", rateLimited: true }; }
    const t = await resp.text().catch(() => ""); return { success: false, error: `${label} HTTP ${resp.status}: ${t.slice(0,300)}` };
  }
  private txt(c: unknown): string { if (typeof c === "string") return c; if (!Array.isArray(c)) return ""; return (c as unknown as Array<Record<string, unknown>>).map((x) => (typeof x.text === "string" ? x.text : "")).filter(Boolean).join("\n"); }
  private msgs(m: ChatCompletionRequest["messages"]): unknown[] {
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
  private pass(up: ReadableStream<Uint8Array>, model: string): ReadableStream<Uint8Array> {
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
export async function activateMistralKey(apiKey: string): Promise<{ email: string; metadata: Record<string, unknown> }> {
  const t = apiKey.trim(); if (!t) throw new Error("API key empty");
  const r = await fetch(MODELS, { method: "GET", headers: { Authorization: `Bearer ${t}` } });
  if (r.status === 401 || r.status === 403) throw new Error(`Invalid API key (HTTP ${r.status})`);
  if (!r.ok) { const x = await r.text().catch(() => ""); throw new Error(`Mistral HTTP ${r.status}: ${x.slice(0,200)}`); }
  await r.text().catch(() => "");
  const h = t.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x");
  return { email: `mistral-${h}@mistral`, metadata: { validated_at: new Date().toISOString() } };
}
