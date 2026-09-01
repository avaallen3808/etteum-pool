import { BaseProvider, type ChatCompletionRequest, type ChatCompletionResponse, type ModelInfo, type ProviderResult } from "./base";
import type { Account } from "../../db/schema";
import { decrypt } from "../../utils/crypto";
import { config } from "../../config";
import path from "path";
const WORKER = path.join(import.meta.dir, "web_cookie_worker.py");
interface Out { ok: boolean; text?: string; error?: string }
export class QwenWebProvider extends BaseProvider {
  name = "qwen-web";
  supportedModels: ModelInfo[] = [
    { id: "qwen-web", object: "model" as const, created: Date.now(), owned_by: "qwen-web", context_window: 128000, max_output: 4000, thinking: false, vision: false, creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const },
    { id: "qwen3-max-web", object: "model" as const, created: Date.now(), owned_by: "qwen-web", context_window: 128000, max_output: 4000, thinking: false, vision: false, creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const },
    { id: "qwen3.7-plus-web", object: "model" as const, created: Date.now(), owned_by: "qwen-web", context_window: 128000, max_output: 8000, thinking: true, vision: false, creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const },
    { id: "qwen3.8-max-web", object: "model" as const, created: Date.now(), owned_by: "qwen-web", context_window: 128000, max_output: 8000, thinking: true, vision: false, creditUnit: "token" as const, creditRate: 0, creditSource: "estimated" as const },
  ];
  override ownsModel(m: string): boolean { const l=m.toLowerCase(); return l.startsWith("qwen-web") || l==="qwen_web" || l.startsWith("qwen3-web") || l.startsWith("qwen3."); }
  private getCookie(a: Account): string { const t=(a.tokens as unknown as Record<string,unknown>); if(t?.token) return String(t.token); if(t?.cookie) return String(t.cookie); try{ const c=decrypt(a.password); if(c) return c; }catch{} return ""; }
  private async run(input: Record<string,unknown>, to:number): Promise<Out> {
    const tmp=`/tmp/qwen_${Date.now()}_${Math.random().toString(36).slice(2)}.json`;
    await Bun.write(tmp, JSON.stringify(input));
    try {
      const proc=Bun.spawn([config.pythonPath, WORKER], { stdin: Bun.file(tmp), stdout:"pipe", stderr:"pipe" });
      const timer=setTimeout(()=>proc.kill(), to);
      try{ await proc.exited; const out=await new Response(proc.stdout).text(); if(!out.trim()){ const e=await new Response(proc.stderr).text(); return {ok:false, error:e.trim()||"empty"}; } return JSON.parse(out.trim()); } finally{ clearTimeout(timer); try{ await Bun.file(tmp).exists() && (await import("fs/promises")).unlink(tmp); }catch{} }
    } catch(e){ try{(await import("fs/promises")).unlink(tmp);}catch{} return {ok:false, error:String(e)}; }
  }
  async chatCompletion(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> {
    const c=this.getCookie(a); if(!c) return {success:false, error:"No Qwen cookie (paste Cookie header from chat.qwen.ai)"};
    const last=[...r.messages].reverse().find((m)=>m.role==="user"); const prompt=typeof last?.content==="string"?last.content:JSON.stringify(last?.content||"");
    const res=await this.run({site:"qwen", prompt, messages:r.messages, cookies:c},60000);
    if(!res.ok) return {success:false, error:res.error||"Qwen web failed"};
    const text=res.text||""; const resp: ChatCompletionResponse={ id:this.generateId(), object:"chat.completion", created:Math.floor(Date.now()/1000), model:r.model, choices:[{index:0, message:{role:"assistant", content:text}, finish_reason:"stop"}], usage:{prompt_tokens:this.estimateMessagesTokens(r.messages), completion_tokens:this.estimateTokens(text), total_tokens:this.estimateMessagesTokens(r.messages)+this.estimateTokens(text)} };
    return {success:true, response:resp, promptTokens:resp.usage.prompt_tokens, completionTokens:resp.usage.completion_tokens, tokensUsed:resp.usage.total_tokens};
  }
  async chatCompletionStream(a: Account, r: ChatCompletionRequest): Promise<ProviderResult> {
    const c=this.getCookie(a); if(!c) return {success:false, error:"No Qwen cookie (paste Cookie header from chat.qwen.ai)"};
    const last=[...r.messages].reverse().find((m)=>m.role==="user"); const prompt=typeof last?.content==="string"?last.content:JSON.stringify(last?.content||"");
    return this.webWorkerStream({ worker: WORKER, tmpPrefix: "qwen", site: "qwen", prompt, messages: r.messages, cookies: c, model: r.model, timeoutMs: 60000 });
  }
  async refreshToken(): Promise<{success:boolean; tokens?:string; error?:string}> { return {success:false, error:"Qwen web requires cookie refresh"}; }
  async validateAccount(a: Account): Promise<boolean> { return !!this.getCookie(a); }
  async fetchQuota(a: Account): Promise<{success:boolean; quota?:{limit:number; remaining:number; used:number; resetAt?:Date|string|null}; error?:string}> {
    const c=this.getCookie(a); if(!c) return {success:false, error:"No cookie"};
    const r=await this.run({site:"qwen", mode:"quota", cookies:c},15000);
    if(!r.ok) return {success:false, error:r.error||"Quota failed"};
    return {success:true, quota:{limit:1000, remaining:999, used:0, resetAt:null}};
  }
}
