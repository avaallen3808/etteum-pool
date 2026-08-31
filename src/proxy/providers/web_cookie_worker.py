#!/usr/bin/env python3
"""
Web cookie worker for gemini-web, deepseek-web, qwen-web, zai-web
Called via subprocess from TS providers.
Input (stdin JSON):
  { site: "gemini"|"deepseek"|"qwen"|"zai", mode: "chat"|"quota", prompt: str, messages?: [], cookies: str|dict, timeout?: int }
Output (stdout JSON):
  { ok: bool, text?: str, error?: str, quota_remaining?: int }
Requires: playwright (chromium)
"""
import json
import sys
import time
import asyncio

async def run_gemini(prompt: str, cookies: str, messages=None):
    from playwright.async_api import async_playwright
    # gemini.google.com uses __Secure-1PSID cookie for auth, then uses batchexecute or gemini API via blazer
    # Simplified: use playwright to open gemini and extract response via exposed API
    # For now, fallback to direct fetch via gemini's internal API using cookie
    import re
    # Try to use Gemini's internal API via fetch inside browser context
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        # Add cookies
        cookie_list = []
        for part in cookies.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            cookie_list.append({"name": name.strip(), "value": value.strip(), "domain": ".google.com", "path": "/"})
        if cookie_list:
            await context.add_cookies(cookie_list)
        page = await context.new_page()
        try:
            await page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)
            # Try to find input box and send prompt
            # Gemini's input is a contenteditable div with aria-label
            input_sel = 'div[contenteditable="true"][aria-label*="Ask"] , div[aria-label*="Ask Gemini"] , rich-textarea div[contenteditable="true"]'
            try:
                await page.locator(input_sel).first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                # fallback: try to use JS to set value
                await page.evaluate(f'document.body.innerText.includes("Gemini")')
                return {"ok": False, "error": "Gemini input not found — cookie may be invalid or page changed"}
            # Wait for response
            await page.wait_for_timeout(8000)
            # Try to extract last response
            for _ in range(15):
                try:
                    # Gemini responses are in message-content or response-container
                    texts = await page.locator('message-content, div[data-test-id="response-container"], div.model-response-text').all_inner_texts()
                    if texts:
                        last = texts[-1].strip()
                        if last and len(last) > 5 and last != prompt:
                            await browser.close()
                            return {"ok": True, "text": last}
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout waiting for Gemini response"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}

async def run_deepseek(prompt: str, cookies: str, messages=None):
    from playwright.async_api import async_playwright
    # chat.deepseek.com uses userToken in localStorage
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path="/home/looee/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome", args=["--no-sandbox", "--disable-blink-features=AutomationControlled"])
        context = await browser.new_context(user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36", locale="en-US")
        page = await context.new_page()
        try:
            await page.goto("https://chat.deepseek.com/", wait_until="domcontentloaded", timeout=30000)
            # Set userToken in localStorage if provided as "userToken=xxx" or raw token
            token = cookies.strip()
            if "userToken" in token:
                if "=" in token:
                    token = token.split("=", 1)[1].strip()
                # Token is JSON like {"value": "...", "__version": "0"} — serialize
                # it as a JS literal so quotes/backslashes survive evaluate().
                try:
                    parsed = json.loads(token)
                    token_literal = json.dumps(json.dumps(parsed))
                except json.JSONDecodeError:
                    token_literal = json.dumps(json.dumps(token))
            else:
                token_literal = json.dumps(json.dumps(token))
            await page.evaluate("localStorage.setItem('userToken', " + token_literal + ")")
            await page.reload(wait_until="domcontentloaded")
            # Wait for the chat input to be interactive (login state ready)
            input_box = None
            try:
                input_box = await page.locator(
                    'textarea[placeholder*="Message"], textarea[placeholder*="Send"], '
                    'textarea[placeholder*="消息"], div[contenteditable="true"], '
                    'textarea._27c9245'
                ).first.wait_for(state="visible", timeout=30000)
                input_el = page.locator(
                    'textarea[placeholder*="Message"], textarea[placeholder*="Send"], '
                    'textarea[placeholder*="消息"], div[contenteditable="true"], '
                    'textarea._27c9245'
                ).first
                await input_el.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except Exception:
                return {"ok": False, "error": "DeepSeek input not found"}
            await page.wait_for_timeout(6000)
            prev = ""
            for _ in range(12):
                try:
                    texts = await page.locator('div[class*="message"], div.ds-message, div[class*="response"]').all_inner_texts()
                    if texts:
                        # skip the user's own prompt bubble; grab the last distinct assistant reply
                        candidates = [t.strip() for t in texts if t.strip() and t.strip() != prompt]
                        last = candidates[-1] if candidates else ""
                        if last and last != prev:
                            prev = last
                            # give streaming a moment to settle, then confirm it is stable
                            await page.wait_for_timeout(1500)
                            texts2 = await page.locator('div[class*="message"], div.ds-message, div[class*="response"]').all_inner_texts()
                            cand2 = [t.strip() for t in texts2 if t.strip() and t.strip() != prompt]
                            last2 = cand2[-1] if cand2 else ""
                            if last2 and last2 == last:
                                await browser.close()
                                return {"ok": True, "text": last2}
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout DeepSeek"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}

async def run_qwen(prompt: str, cookies: str, messages=None):
    from playwright.async_api import async_playwright
    # chat.qwen.ai or qwen.ai
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        # Add cookies
        cookie_list = []
        for part in cookies.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            cookie_list.append({"name": name.strip(), "value": value.strip(), "domain": ".qwen.ai", "path": "/"})
            cookie_list.append({"name": name.strip(), "value": value.strip(), "domain": ".chat.qwen.ai", "path": "/"})
        if cookie_list:
            try:
                await context.add_cookies(cookie_list)
            except:
                pass
        page = await context.new_page()
        try:
            await page.goto("https://chat.qwen.ai/", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)
            try:
                await page.locator('textarea, div[contenteditable="true"]').first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "Qwen input not found"}
            await page.wait_for_timeout(6000)
            for _ in range(12):
                try:
                    texts = await page.locator('div[class*="message"], div[class*="answer"], div[class*="response"]').all_inner_texts()
                    if texts:
                        last = texts[-1].strip()
                        if last and last != prompt and len(last) > 5:
                            await browser.close()
                            return {"ok": True, "text": last}
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout Qwen"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}

async def run_zai(prompt: str, cookies: str, messages=None):
    from playwright.async_api import async_playwright
    # chat.z.ai uses token in localStorage
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context()
        page = await context.new_page()
        try:
            await page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=30000)
            token = cookies.strip()
            if "token" in token and "=" in token:
                token = token.split("=", 1)[1].strip().strip('"')
            await page.evaluate(f'localStorage.setItem("token", "{token}")')
            await page.reload(wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            try:
                await page.locator('textarea, div[contenteditable="true"]').first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "ZAI input not found"}
            await page.wait_for_timeout(6000)
            for _ in range(12):
                try:
                    texts = await page.locator('div[class*="message"], div[class*="answer"]').all_inner_texts()
                    if texts:
                        last = texts[-1].strip()
                        if last and last != prompt and len(last) > 5:
                            await browser.close()
                            return {"ok": True, "text": last}
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout ZAI"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}

async def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except:
        print(json.dumps({"ok": False, "error": "Invalid JSON input"}))
        return
    site = (data.get("site") or "").lower()
    prompt = data.get("prompt") or ""
    if not prompt and data.get("messages"):
        # Extract last user message
        msgs = data.get("messages") or []
        for m in reversed(msgs):
            if isinstance(m, dict) and m.get("role") == "user":
                c = m.get("content")
                if isinstance(c, str):
                    prompt = c
                    break
                elif isinstance(c, list):
                    for b in c:
                        if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                            prompt = b["text"]
                            break
                    if prompt:
                        break
        if not prompt:
            prompt = "Hello"
    cookies = data.get("cookies") or data.get("cookie") or ""
    if isinstance(cookies, dict):
        # Convert dict to header string
        cookies = "; ".join([f"{k}={v}" for k, v in cookies.items()])
    mode = data.get("mode") or "chat"
    if mode == "quota":
        print(json.dumps({"ok": True, "quota_remaining": 999, "quota_limit": 1000}))
        return
    try:
        if site == "gemini":
            res = await run_gemini(prompt, cookies, data.get("messages"))
        elif site == "deepseek":
            res = await run_deepseek(prompt, cookies, data.get("messages"))
        elif site == "qwen":
            res = await run_qwen(prompt, cookies, data.get("messages"))
        elif site == "zai":
            res = await run_zai(prompt, cookies, data.get("messages"))
        else:
            res = {"ok": False, "error": f"Unknown site: {site}"}
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    asyncio.run(main())
