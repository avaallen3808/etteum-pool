from __future__ import annotations
import re
from typing import Any
from app.providers.base import ProviderAdapter, NormalizedAccount
from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")

class QwenWebProviderAdapter(ProviderAdapter):
    """
    Qwen Web cookie-paste adapter.
    Mode: Single (email|password) where password = full cookie string from chat.qwen.ai.
    Use bookmarklet on chat.qwen.ai to get the cookie.
    Injected as Cookie: header on each API call.
    """
    name = "qwen-web"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "qwen-web account must be email|password (password = cookie from chat.qwen.ai)")
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(ErrorCode.input_missing_required_field, "qwen-web requires email and password")
        if "@" not in email:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "qwen-web email must contain @")
        if len(password) < 30:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "qwen-web cookie looks too short — paste the full cookie from chat.qwen.ai DevTools or bookmarklet")
        return NormalizedAccount(provider=self.name, identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        return None

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        cookie = account.secret
        if not cookie or len(cookie) < 30:
            raise NonRetryableBatcherError(ErrorCode.auth_invalid_credentials, "qwen-web: invalid cookie (too short)")
        return {"authenticated": True, "cookie": cookie}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        return {"cookie": account.secret}

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        return {"limit": 1000, "remaining": 999, "used": 1}

    async def cleanup_session(self, session: Any) -> None:
        pass