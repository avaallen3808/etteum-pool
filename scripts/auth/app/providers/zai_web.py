from __future__ import annotations
import re
from typing import Any
from app.providers.base import ProviderAdapter, NormalizedAccount
from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")

class ZaiWebProviderAdapter(ProviderAdapter):
    """
    Z.ai Web cookie-paste adapter.
    Mode: Single (email|password) where password = raw token value from chat.z.ai localStorage.
    Use bookmarklet on chat.z.ai to get the token.
    Injected as token=<value> cookie on API calls.
    OmniRoute handles per-request CAPTCHA via browser transport; for cookie-paste mode we just inject the token.
    """
    name = "zai-web"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "zai-web account must be email|password (password = token from chat.z.ai Local Storage)")
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(ErrorCode.input_missing_required_field, "zai-web requires email and password")
        if "@" not in email:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "zai-web email must contain @")
        if len(password) < 20:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "zai-web token looks too short — paste the full token from chat.z.ai DevTools → Application → Local Storage")
        return NormalizedAccount(provider=self.name, identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        return None

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        token = account.secret
        if not token or len(token) < 20:
            raise NonRetryableBatcherError(ErrorCode.auth_invalid_credentials, "zai-web: invalid token (too short)")
        return {"authenticated": True, "token": token}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        token = account.secret
        return {"token": token, "cookie": f"token={token}"}

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        return {"limit": 1000, "remaining": 999, "used": 1}

    async def cleanup_session(self, session: Any) -> None:
        pass