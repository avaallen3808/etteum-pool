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

# Full Chrome binary + real UA required: bare headless shell gets blocked by
# CloudFront/AWS WAF on chat.deepseek.com and chat.qwen.ai.
CHROME_EXE = "/home/looee/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
CHROME_ARGS = ["--no-sandbox", "--disable-blink-features=AutomationControlled"]
REAL_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"


async def run_gemini(prompt, cookies, messages=None):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=CHROME_EXE, args=CHROME_ARGS)
        context = await browser.new_context(user_agent=REAL_UA, locale="en-US")
        cookie_list = []
        for part in cookies.split(";"):
            part = part.strip()
            if "=" not in part:
                continue
            name, value = part.split("=", 1)
            cookie_list.append({"name": name.strip(), "value": value.strip(), "domain": ".google.com", "path": "/"})
        if cookie_list:
            try:
                await context.add_cookies(cookie_list)
            except:
                pass
        page = await context.new_page()
        try:
            await page.goto("https://gemini.google.com/app", wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(3000)
            input_sel = 'div[contenteditable="true"][aria-label*="Ask"] , div[aria-label*="Ask Gemini"] , rich-textarea div[contenteditable="true"]'
            try:
                await page.locator(input_sel).first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "Gemini input not found — cookie may be invalid or page changed"}
            await page.wait_for_timeout(8000)
            for _ in range(15):
                try:
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


async def run_deepseek(prompt, cookies, messages=None):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=CHROME_EXE, args=CHROME_ARGS)
        context = await browser.new_context(user_agent=REAL_UA, locale="en-US")
        page = await context.new_page()
        try:
            await page.goto("https://chat.deepseek.com/", wait_until="domcontentloaded", timeout=30000)
            token = cookies.strip()
            if "userToken" in token:
                if "=" in token:
                    token = token.split("=", 1)[1].strip()
                try:
                    parsed = json.loads(token)
                    token_literal = json.dumps(parsed)
                except json.JSONDecodeError:
                    token_literal = json.dumps(token)
            else:
                token_literal = json.dumps(token)
            await page.evaluate("localStorage.setItem('userToken', " + token_literal + ")")
            await page.reload(wait_until="domcontentloaded")
            try:
                await page.locator(
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
            prev = ""
            for _ in range(15):
                try:
                    texts = await page.locator('div[class*="message"], div.ds-message, div[class*="response"]').all_inner_texts()
                    candidates = [t.strip() for t in texts if t.strip() and t.strip() != prompt]
                    cur = candidates[-1] if candidates else ""
                    if cur and cur != prev:
                        prev = cur
                        await page.wait_for_timeout(1500)
                        texts2 = await page.locator('div[class*="message"], div.ds-message, div[class*="response"]').all_inner_texts()
                        cand2 = [t.strip() for t in texts2 if t.strip() and t.strip() != prompt]
                        last2 = cand2[-1] if cand2 else ""
                        if last2 and last2 == cur:
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


async def run_qwen(prompt, cookies, messages=None):
    from playwright.async_api import async_playwright
    # Qwen auth: JWT in localStorage["token"] + desktop spoof so the frontend
    # attaches Authorization: Bearer to every API call. Desktop spoof requires:
    #   - window.electronAPI (injected via add_init_script before page load)
    #   - userAgent containing "AliDesktop(QWENCHAT/x.y.z)"
    token = cookies.strip()
    if token.lower().startswith("token="):
        token = token.split("=", 1)[1].strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()
    if len(token.split(".")) != 3 or len(token) < 40:
        return {"ok": False, "error": "Qwen requires a JWT token (localStorage.getItem('token') on chat.qwen.ai) — cookies no longer work"}
    DESKTOP_UA = REAL_UA + " AliDesktop(QWENCHAT/2.0.0)"
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=CHROME_EXE, args=CHROME_ARGS)
        context = await browser.new_context(user_agent=DESKTOP_UA, locale="en-US", viewport={"width": 1440, "height": 900})
        await context.add_init_script("window.electronAPI = {};")
        page = await context.new_page()
        try:
            await page.goto("https://chat.qwen.ai/", wait_until="domcontentloaded", timeout=40000)
            await page.wait_for_timeout(4000)
            await page.evaluate(f'localStorage.setItem("token", {json.dumps(token)})')
            await page.reload(wait_until="domcontentloaded")
            # Wait for the app's OWN auth request to return 200 (the app's
            # interceptor auto-attaches Authorization: Bearer via desktop
            # spoof — our own fetch() would miss the header).
            logged_in = False
            for attempt in range(2):
                for _ in range(10):
                    await page.wait_for_timeout(1500)
                    try:
                        body = await page.evaluate("document.body.innerText")
                        if "Log in" not in body and "Sign up" not in body:
                            logged_in = True
                            break
                    except:
                        pass
                if logged_in:
                    break
                if attempt == 0 and not logged_in:
                    await page.evaluate(f'localStorage.setItem("token", {json.dumps(token)})')
                    await page.reload(wait_until="domcontentloaded")
            if not logged_in:
                await browser.close()
                return {"ok": False, "error": "Qwen login wall still present — token rejected or expired"}
            # Wait for the chat input to be interactive
            input_el = page.locator('textarea, div[contenteditable="true"]').first
            try:
                await input_el.wait_for(state="visible", timeout=30000)
            except Exception:
                await browser.close()
                return {"ok": False, "error": "Qwen input not found"}
            await input_el.fill(prompt, timeout=10000)
            await page.keyboard.press("Enter")
            # Poll for the assistant answer: two identical reads = stream finished
            last = ""
            stable = 0
            deadline = time.time() + 60
            while time.time() < deadline:
                try:
                    texts = await page.locator('div.response-message-content.t2t').all_inner_texts()
                    cand = [t.strip() for t in texts if t.strip() and t.strip() != prompt and "Auto" != t.strip() and "AI-generated content" not in t]
                    cur = cand[-1] if cand else ""
                    if cur and cur == last:
                        stable += 1
                        if stable >= 2:
                            await browser.close()
                            return {"ok": True, "text": cur}
                    else:
                        last = cur
                        stable = 0
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout Qwen"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}


async def run_zai(prompt, cookies, messages=None):
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, executable_path=CHROME_EXE, args=CHROME_ARGS)
        context = await browser.new_context(user_agent=REAL_UA, locale="en-US")
        page = await context.new_page()
        try:
            await page.goto("https://chat.z.ai/", wait_until="domcontentloaded", timeout=30000)
            token = cookies.strip()
            if "token" in token and "=" in token:
                token = token.split("=", 1)[1].strip().strip('"')
            token_literal = json.dumps(token)
            await page.evaluate("localStorage.setItem('token', " + token_literal + ")")
            await page.reload(wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            try:
                await page.locator('textarea, div[contenteditable="true"]').first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "ZAI input not found"}
            await page.wait_for_timeout(6000)
            prev = ""
            for _ in range(12):
                try:
                    texts = await page.locator('div[class*="markdown"]').all_inner_texts()
                    candidates = [t.strip() for t in texts if t.strip() and t.strip() != prompt]
                    last = candidates[-1] if candidates else ""
                    if last:
                        # strip "Thought Process\n\n" prefix if present
                        if "Thought Process" in last:
                            last = last.split("Thought Process", 1)[-1].strip()
                            if last.startswith("\n"):
                                last = last[2:].strip()
                        if last != prev:
                            prev = last
                            await page.wait_for_timeout(1500)
                            texts2 = await page.locator('div[class*="markdown"]').all_inner_texts()
                            cand2 = [t.strip() for t in texts2 if t.strip() and t.strip() != prompt]
                            last2 = cand2[-1] if cand2 else ""
                            if "Thought Process" in last2:
                                last2 = last2.split("Thought Process", 1)[-1].strip()
                                if last2.startswith("\n"):
                                    last2 = last2[2:].strip()
                            if last2 and last2 == last:
                                await browser.close()
                                return {"ok": True, "text": last2}
                            elif last2 and last2 != last:
                                prev = last2
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
        print(json.dumps(res))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))


if __name__ == "__main__":
    asyncio.run(main())