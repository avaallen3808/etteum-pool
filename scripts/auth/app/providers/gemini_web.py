from __future__ import annotations
import re
from typing import Any
from app.providers.base import ProviderAdapter, NormalizedAccount
from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError

GEMINI_COOKIE_HINT = "Paste the full cookie header, the __Secure-1PSID value, or the JSON export from gemini.google.com (include __Secure-1PSIDTS and __Secure-1PSIDCC when available)."
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")

class GeminiWebProviderAdapter(ProviderAdapter):
    """
    Gemini Web cookie-paste adapter.
    Mode: Single (email|password) where password = full cookie header or __Secure-1PSID from gemini.google.com.
    Injected as Cookie: header on each API call.
    """
    name = "gemini-web"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "gemini-web account must be email|password")
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(ErrorCode.input_missing_required_field, "gemini-web requires email and password")
        if "@" not in email:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "gemini-web email must contain @")
        # Must contain __Secure-1PSID somewhere (it's the auth cookie)
        if "__Secure-1PSID" not in password:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "gemini-web: cookie missing __Secure-1PSID — " + GEMINI_COOKIE_HINT)
        return NormalizedAccount(provider=self.name, identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        """No browser needed — cookie-paste mode."""
        return None

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        cookie = account.secret
        if "__Secure-1PSID" not in cookie:
            raise NonRetryableBatcherError(ErrorCode.auth_invalid_credentials, "gemini-web: cookie missing __Secure-1PSID")
        return {"authenticated": True, "cookie": cookie}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        return {"cookie": account.secret}

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        return {"limit": 60, "remaining": 59, "used": 1}

    async def cleanup_session(self, session: Any) -> None:
        pass