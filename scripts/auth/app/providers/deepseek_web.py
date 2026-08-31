
from __future__ import annotations
import asyncio
import json
import os
import re
from typing import Any
from app.providers.base import ProviderAdapter, NormalizedAccount
from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError

DEEPSEEK_LOGIN_URL = "https://chat.deepseek.com/sign_in"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")
class DeepSeekWebProviderAdapter(ProviderAdapter):
    name = "deepseek-web"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "deepseek-web account must be email|password")
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(ErrorCode.input_missing_required_field, "deepseek-web requires email and password")
        if not _EMAIL_RE.match(email):
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "deepseek-web email invalid")
        return NormalizedAccount(provider=self.name, identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        try:
            from camoufox.async_api import AsyncCamoufox
            kwargs: dict[str, Any] = {
                "headless": os.getenv("BATCHER_CAMOUFOX_HEADLESS", "true").lower() == "true",
                "os": "windows",
                "block_webrtc": True,
            }
            proxy_url = os.getenv("BATCHER_PROXY_URL", "")
            if proxy_url:
                from urllib.parse import urlparse
                parsed = urlparse(proxy_url)
                proxy_cfg: dict[str, Any] = {"server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"}
                if parsed.username:
                    proxy_cfg["username"] = parsed.username
                if parsed.password:
                    proxy_cfg["password"] = parsed.password
                kwargs["proxy"] = proxy_cfg
                kwargs["geoip"] = True
            manager = AsyncCamoufox(**kwargs)
            browser = await manager.__aenter__()
            page = await browser.new_page()
            page.set_default_timeout(15000)
            await page.goto(DEEPSEEK_LOGIN_URL, wait_until="domcontentloaded", timeout=20000)
            await asyncio.sleep(3)
            return {"manager": manager, "browser": browser, "page": page}
        except Exception as exc:
            raise RetryableBatcherError(ErrorCode.browser_start_failed, str(exc) or "deepseek-web bootstrap failed") from exc

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        page = session["page"]
        email = account.identifier
        password = account.secret
        # Try to find login button/link
        try:
            # Click login if needed
            for sel in ['text="Log in"', 'text="Sign in"', 'a[href*="auth"]', 'button:has-text("Log in")']:
                try:
                    loc = page.locator(sel).first
                    if await loc.is_visible(timeout=2000):
                        await loc.click()
                        await asyncio.sleep(2)
                        break
                except:
                    continue
            # Fill email
            email_filled = False
            for sel in ['input[type="email"]', 'input[name="email"]', 'input[placeholder*="Email"]', '#email']:
                try:
                    loc = page.locator(sel).first
                    if await loc.is_visible(timeout=3000):
                        await loc.fill(email)
                        email_filled = True
                        break
                except:
                    continue
            if email_filled:
                # Try to find next/continue
                for sel in ['button:has-text("Continue")', 'button:has-text("Next")', 'button[type="submit"]']:
                    try:
                        loc = page.locator(sel).first
                        if await loc.is_visible(timeout=2000):
                            await loc.click()
                            await asyncio.sleep(2)
                            break
                    except:
                        continue
            # Fill password
            for sel in ['input[type="password"]', 'input[name="password"]', 'input[placeholder*="Password"]']:
                try:
                    loc = page.locator(sel).first
                    if await loc.is_visible(timeout=5000):
                        await loc.fill(password)
                        break
                except:
                    continue
            # Submit
            for sel in ['button:has-text("Log in")', 'button:has-text("Sign in")', 'button[type="submit"]']:
                try:
                    loc = page.locator(sel).first
                    if await loc.is_visible(timeout=2000):
                        await loc.click()
                        break
                except:
                    continue
            await asyncio.sleep(5)
            # Check for error
            try:
                err = await page.locator('text="Invalid" , text="incorrect" , text="Wrong"').first.text_content(timeout=2000)
                if err:
                    raise NonRetryableBatcherError(ErrorCode.auth_invalid_credentials, err.strip()[:200])
            except:
                pass
            return {"authenticated": True}
        except NonRetryableBatcherError:
            raise
        except Exception as exc:
            raise RetryableBatcherError(ErrorCode.auth_failed, f"deepseek-web auth failed: {exc}") from exc

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        page = session["page"]
        try:
            await page.wait_for_url("**/chat.deepseek.com/**", timeout=10000)
        except:
            pass
        await asyncio.sleep(3)
        # Try to get userToken from localStorage
        for _ in range(5):
            try:
                token = await page.evaluate("() => localStorage.getItem('userToken') || localStorage.getItem('token') || ''")
                if token and len(token) > 20:
                    # token may be JSON
                    if token.startswith('"'):
                        try:
                            token = json.loads(token)
                        except:
                            pass
                    if isinstance(token, dict):
                        token = token.get("token") or token.get("access_token") or str(token)
                    token = str(token).strip().strip('"').strip("'")
                    if len(token) > 20:
                        return {"userToken": token, "cookie": f"userToken={token}"}
            except:
                pass
            await asyncio.sleep(2)
        # Fallback: try to get from cookies
        try:
            cookies = await page.context.cookies()
            for c in cookies:
                if c["name"] in ("userToken", "token", "session"):
                    return {"userToken": c["value"], "cookie": f"{c['name']}={c['value']}"}
        except:
            pass
        raise RetryableBatcherError(ErrorCode.token_fetch_failed, "deepseek-web: could not extract userToken after login")

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        return {"limit": 1000, "remaining": 999, "used": 1}

    async def cleanup_session(self, session: Any) -> None:
        try:
            manager = session.get("manager")
            if manager:
                await manager.__aexit__(None, None, None)
        except:
            pass
