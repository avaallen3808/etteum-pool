import { BaseProvider, type ChatCompletionRequest, type ChatCompletionResponse, type ModelInfo, type ProviderResult } from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
// UncloseAI — API accepts any non-empty string as key for identification
// Base: https://api.uncloseai.com/v1  (fallback https://uncloseai.com/api/v1)
// Models: solidrust/Hermes-3-Llama-3.1-8B-AWQ verified, plus generic
// Free, no quota published
const BASES = ["https://api.uncloseai.com/v1", "https://uncloseai.com/api/v1"];
const MODELS_URLS = BASES.map((b) => `${b}/models`);
const CHAT_URLS = BASES.map((b) => `${b}/chat/completions`);
interface Def { id: string; upstream: string; context_window: number; max_output: number; }
const LIST: Def[] = [
  { id: "uncloseai-hermes-3-8b", upstream: "solidrust/Hermes-3-Llama-3.1-8B-AWQ", context_window: 32000, max_output: 4000 },
  { id: "uncloseai-llama-3.1-70b", upstream: "meta-llama/Meta-Llama-3.1-70B-Instruct", context_window: 32000, max_output: 4000 },
  { id: "uncloseai-qwen2-72b", upstream: "Qwen/Qwen2-72B-Instruct", context_window: 32000, max_output: 4000 },
  { id: "uncloseai-deepseek-v3", upstream: "deepseek-ai/DeepSeek-V3", context_window: 32000, max_output: 4000 },
];
function norm(m: string): string {
  const l = m.toLowerCase().trim();
  if (l.startsWith("uncloseai/")) return l.slice(10);
  if (l.startsWith("uncloseai-")) return l.slice(10);
  if (l.startsWith("unc/")) return l.slice(4);
  if (l.startsWith("unc-")) return l.slice(4);
  return l;
}
const MAP: Record<string, Def> = Object.fromEntries(LIST.flatMap((d) => [[d.id.toLowerCase(), d], [norm(d.id), d], [`uncloseai/${norm(d.id)}`, d], [`unc-${norm(d.id)}`, d], [d.upstream.toLowerCase(), d]]));
export class UncloseAiProvider extends BaseProvider {
  name = "uncloseai";
  override nativeFormat: "openai" | "anthropic" = "openai";
  override ownsModel(m: string): boolean { const l = m.toLowerCase(); if (MAP[l]) return true; if (l.startsWith("unc-") || l.startsWith("unc/") || l.startsWith("uncloseai-") || l.startsWith("uncloseai/")) return true; return !!MAP[norm(m)]; }
  supportedModels: ModelInfo[] = LIST.map((d) => ({ id: d.id, object: "model" as const, created: Date.now(), owned_by: "uncloseai", context_window: d.context_window, max_output: d.max_output, thinking: false, vision: false, creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const }));
  private resolve(m: string): Def | null {
    const l = m.toLowerCase();
    if (MAP[l]) return MAP[l];
    const n = norm(m);
    if (MAP[n]) return MAP[n];
    if (l.startsWith("unc-") || l.startsWith("uncloseai-") || l.startsWith("unc/") || l.startsWith("uncloseai/")) {
      const up = n; return { id: m, upstream: up, context_window: 32000, max_output: 4000 };
    }
    return null;
  }
  private key(a: Account): string { try { return decrypt(a.password); } catch { return a.password || "x"; } }
  // UncloseAI accepts any non-empty string — if no key stored, use "x"
  private apiKey(a: Account): string { const k = this.key(a); return k && k.trim() ? k.trim() : "x"; }
  async chatCompletion(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> { const d = this.resolve(r.model); if (!d) return { success: false, error: `Unknown UncloseAI model: ${r.model}` }; return this.chat(a, d, r); }
  async chatCompletionStream(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> { const d = this.resolve(r.model); if (!d) return { success: false, error: `Unknown UncloseAI model: ${r.model}` }; return this.stream(a, d, r); }
  async refreshToken(): Promise<{ success: boolean; tokens?: string; error?: string }> { return { success: true }; }
  async validateAccount(a: Account): Promise<boolean> { return true; } // any string works
  async fetchQuota(a: Account): Promise<{ success: boolean; quota?: { limit: number; remaining: number; used: number; resetAt?: Date | string | null }; error?: string }> {
    // No quota endpoint — treat as unlimited. Try models probe but don't fail if 401 (any string ok)
    const k = this.apiKey(a);
    for (const url of MODELS_URLS) {
      try { const r = await this.fetchWithTimeout(url, { method: "GET", headers: { Authorization: `Bearer ${k}` } }); if (r.ok) { await r.text().catch(() => ""); return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } }; } } catch {}
    }
    return { success: true, quota: { limit: -1, remaining: -1, used: 0, resetAt: null } };
  }
  private async chat(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.apiKey(a);
    const b: Record<string, unknown> = { model: d.upstream, messages: this.msgs(r.messages), stream: false };
    if (r.max_tokens !== undefined) b.max_tokens = r.max_tokens;
    for (const url of CHAT_URLS) {
      try {
        const resp = await this.fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}` }, body: JSON.stringify(b) });
        const e = await this.err(resp, "UncloseAI chat"); if (e && e.rateLimited) return e; if (e && resp.status >= 500) continue; if (e) return e;
        const data = (await resp.json()) as ChatCompletionResponse; const ch = data.choices?.[0]; if (!ch) return { success: false, error: "No choices" }; const pt = data.usage?.prompt_tokens ?? this.estimateMessagesTokens(r.messages); const ct = data.usage?.completion_tokens ?? this.estimateTokens(typeof ch.message?.content === "string" ? ch.message.content : ""); data.model = r.model; return { success: true, response: data, promptTokens: pt, completionTokens: ct, tokensUsed: pt + ct };
      } catch (e) { const msg = e instanceof Error ? e.message : String(e); if (msg.includes("fetch")) continue; return { success: false, error: msg }; }
    }
    return { success: false, error: "UncloseAI all endpoints failed" };
  }
  private async stream(a: Account, d: Def, r: ChatCompletionRequest): Promise<ProviderResult> {
    const k = this.apiKey(a);
    const b: Record<string, unknown> = { model: d.upstream, messages: this.msgs(r.messages), stream: true };
    if (r.max_tokens !== undefined) b.max_tokens = r.max_tokens;
    for (const url of CHAT_URLS) {
      try {
        const resp = await this.fetchWithTimeout(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${k}`, Accept: "text/event-stream" }, body: JSON.stringify(b) });
        const e = await this.err(resp, "UncloseAI stream"); if (e && resp.status >= 500) continue; if (e) return e;
        if (!resp.body) continue;
        return { success: true, stream: this.pass(resp.body, r.model), promptTokens: 0, completionTokens: 0, tokensUsed: 0 };
      } catch {}
    }
    return { success: false, error: "UncloseAI stream all endpoints failed" };
  }
  private async err(resp: Response, label: string): Promise<ProviderResult | null> {
    if (resp.ok) return null;
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
export async function activateUncloseAiKey(apiKey: string): Promise<{ email: string; metadata: Record<string, unknown> }> {
  const t = (apiKey || "x").trim() || "x";
  // Try models probe but don't require success — any non-empty string is valid
  for (const url of MODELS_URLS) {
    try { const r = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${t}` } }); if (r.ok) { await r.text().catch(() => ""); break; } } catch {}
  }
  const h = t.slice(-8).toLowerCase().replace(/[^a-z0-9]/g, "x") || "default";
  return { email: `uncloseai-${h}@uncloseai`, metadata: { validated_at: new Date().toISOString() } };
}
