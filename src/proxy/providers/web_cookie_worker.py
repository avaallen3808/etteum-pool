#!/usr/bin/env python3
"""
Web cookie worker for gemini-web, deepseek-web, qwen-web, zai-web
Called via subprocess from TS providers.
Input (stdin JSON):
  { site: "gemini"|"deepseek"|"qwen"|"zai", mode: "chat"|"step"|"quota",
    prompt: str, messages?: [], cookies: str|dict, timeout?: int }
Output (stdout JSON):
  mode "chat":   single line { ok: bool, text?: str, error?: str }
  mode "step":   one line per observed delta { delta: str }, then a final
                 result line { ok: bool, text?: str, error?: str }
  mode "quota":  { ok: true, quota_remaining: int }
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

RATE_LIMIT_PATTERNS = [
    "currently busy", "too many requests", "rate limit", "try again later",
    "服务繁忙", "稍后再试", "频率限制", "429",
    "too many", "please try again", "temporarily unavailable",
    "busy", "overloaded", "service busy",
]


async def check_rate_limited(page):
    try:
        text = await page.evaluate("document.body.innerText")
        text_lower = text.lower()
        for pat in RATE_LIMIT_PATTERNS:
            if pat in text_lower:
                return True
    except:
        pass
    return False


async def run_gemini(prompt, cookies, messages=None, emit=None):
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
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (Gemini)", "rate_limited": True}
            input_sel = 'div[contenteditable="true"][aria-label*="Ask"] , div[aria-label*="Ask Gemini"] , rich-textarea div[contenteditable="true"]'
            try:
                await page.locator(input_sel).first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "Gemini input not found — cookie may be invalid or page changed"}
            await page.wait_for_timeout(8000)
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (Gemini)", "rate_limited": True}
            prev = ""
            for _ in range(15):
                if await check_rate_limited(page):
                    await browser.close()
                    return {"ok": False, "error": "Rate limited (Gemini)", "rate_limited": True}
                try:
                    texts = await page.locator('message-content, div[data-test-id="response-container"], div.model-response-text').all_inner_texts()
                    if texts:
                        last = texts[-1].strip()
                        if last and len(last) > 5 and last != prompt and last != prev:
                            prev_before = prev
                            prev = last
                            if emit:
                                emit({"delta": last[len(prev_before):] if prev_before and last.startswith(prev_before) else last})
                            await page.wait_for_timeout(1500)
                            texts2 = await page.locator('message-content, div[data-test-id="response-container"], div.model-response-text').all_inner_texts()
                            last2 = texts2[-1].strip() if texts2 else ""
                            if last2 and len(last2) > 5 and last2 == last:
                                await browser.close()
                                return {"ok": True, "text": last2}
                except:
                    pass
                await page.wait_for_timeout(2000)
            await browser.close()
            return {"ok": False, "error": "Timeout waiting for Gemini response"}
        except Exception as e:
            await browser.close()
            return {"ok": False, "error": str(e)}


async def run_deepseek(prompt, cookies, messages=None, emit=None):
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
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (DeepSeek)", "rate_limited": True}
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
                if await check_rate_limited(page):
                    await browser.close()
                    return {"ok": False, "error": "Rate limited (DeepSeek)", "rate_limited": True}
                try:
                    texts = await page.locator('div[class*="message"], div.ds-message, div[class*="response"]').all_inner_texts()
                    candidates = [t.strip() for t in texts if t.strip() and t.strip() != prompt]
                    cur = candidates[-1] if candidates else ""
                    if cur and cur != prev:
                        if emit and prev and cur.startswith(prev):
                            emit({"delta": cur[len(prev):]})
                        elif emit:
                            emit({"delta": cur})
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

async def run_qwen(prompt, cookies, messages=None, emit=None):
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
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (Qwen)", "rate_limited": True}
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
                if await check_rate_limited(page):
                    await browser.close()
                    return {"ok": False, "error": "Rate limited (Qwen)", "rate_limited": True}
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
                        if cur and cur != last:
                            if emit and last and cur.startswith(last):
                                emit({"delta": cur[len(last):]})
                            elif emit:
                                emit({"delta": cur})
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


async def run_zai(prompt, cookies, messages=None, emit=None):
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
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (ZAI)", "rate_limited": True}
            try:
                await page.locator('textarea, div[contenteditable="true"]').first.fill(prompt, timeout=10000)
                await page.keyboard.press("Enter")
            except:
                return {"ok": False, "error": "ZAI input not found"}
            await page.wait_for_timeout(6000)
            if await check_rate_limited(page):
                await browser.close()
                return {"ok": False, "error": "Rate limited (ZAI)", "rate_limited": True}
            prev = ""
            for _ in range(12):
                if await check_rate_limited(page):
                    await browser.close()
                    return {"ok": False, "error": "Rate limited (ZAI)", "rate_limited": True}
                try:
                    texts = await page.locator('div[class*="markdown"]').all_inner_texts()
                    candidates = [t.strip() for t in texts if t.strip() and t.strip() != prompt and t.strip() != "Thinking..." and t.strip() != "Thinking" and not t.strip().startswith("Thinking")]
                    last = candidates[-1] if candidates else ""
                    if last:
                        # strip "Thought Process\n\n" prefix if present
                        if "Thought Process" in last:
                            last = last.split("Thought Process", 1)[-1].strip()
                            if last.startswith("\n"):
                                last = last[2:].strip()
                        if last != prev:
                            if emit and prev and last.startswith(prev):
                                emit({"delta": last[len(prev):]})
                            elif emit:
                                emit({"delta": last})
                            prev = last
                            await page.wait_for_timeout(1500)
                            texts2 = await page.locator('div[class*="markdown"]').all_inner_texts()
                            cand2 = [t.strip() for t in texts2 if t.strip() and t.strip() != prompt and not t.strip().startswith("Thinking")]
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
        data = json.load(sys.stdin)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad stdin: {e}"}))
        return
    site = data.get("site") or ""
    prompt = data.get("prompt") or "Hello"
    cookies = data.get("cookies") or data.get("cookie") or ""
    if isinstance(cookies, dict):
        cookies = "; ".join([f"{k}={v}" for k, v in cookies.items()])
    mode = data.get("mode") or "chat"
    if mode == "quota":
        print(json.dumps({"ok": True, "quota_remaining": 999, "quota_limit": 1000}))
        return

    emit = None
    if mode == "step":
        emit = lambda d: print(json.dumps(d), flush=True)

    try:
        if site == "gemini":
            res = await run_gemini(prompt, cookies, data.get("messages"), emit)
        elif site == "deepseek":
            res = await run_deepseek(prompt, cookies, data.get("messages"), emit)
        elif site == "qwen":
            res = await run_qwen(prompt, cookies, data.get("messages"), emit)
        elif site == "zai":
            res = await run_zai(prompt, cookies, data.get("messages"), emit)
        else:
            res = {"ok": False, "error": f"Unknown site: {site}"}
        if mode == "step" and res.get("ok"):
            res["done"] = True
        print(json.dumps(res), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
