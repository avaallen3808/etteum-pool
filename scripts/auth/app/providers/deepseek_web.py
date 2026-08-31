from __future__ import annotations
import re
from typing import Any
from app.providers.base import ProviderAdapter, NormalizedAccount
from app.errors.codes import ErrorCode
from app.errors.exceptions import NonRetryableBatcherError, RetryableBatcherError

DEEPSEEK_LOGIN_URL = "https://chat.deepseek.com/sign_in"
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+$")

class DeepSeekWebProviderAdapter(ProviderAdapter):
    """
    DeepSeek Web cookie-paste adapter.
    Mode: Single (email|password) where password = raw userToken from chat.deepseek.com Local Storage.
    No browser automation needed. Token is injected as Cookie: userToken=<token> on API calls.
    """
    name = "deepseek-web"

    async def parse_account(self, raw_line: str) -> NormalizedAccount:
        parts = [p.strip() for p in raw_line.split("|")]
        if len(parts) != 2:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "deepseek-web account must be email|password (password = userToken from chat.deepseek.com Local Storage)")
        email, password = parts
        if not email or not password:
            raise NonRetryableBatcherError(ErrorCode.input_missing_required_field, "deepseek-web requires email and password")
        if not _EMAIL_RE.match(email):
            # Allow placeholder emails like web1@local for cookie-paste mode
            if "@" not in email:
                raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "deepseek-web email must contain @")
        if len(password) < 20:
            raise NonRetryableBatcherError(ErrorCode.input_invalid_format, "deepseek-web token looks too short — paste the full userToken from chat.deepseek.com DevTools → Application → Local Storage")
        return NormalizedAccount(provider=self.name, identifier=email, secret=password, raw=raw_line)

    async def bootstrap_session(self, account: NormalizedAccount) -> Any:
        """No browser needed — cookie-paste mode."""
        return None

    async def authenticate(self, account: NormalizedAccount, session: Any) -> dict[str, Any]:
        """Token is the password — no real auth step needed."""
        token = account.secret
        if not token or len(token) < 20:
            raise NonRetryableBatcherError(ErrorCode.auth_invalid_credentials, "deepseek-web: invalid userToken (too short)")
        return {"authenticated": True, "token": token}

    async def fetch_tokens(self, account: NormalizedAccount, auth_state: dict[str, Any], session: Any) -> dict[str, str]:
        """Return the password as userToken/cookie."""
        token = account.secret
        return {"userToken": token, "cookie": f"userToken={token}"}

    async def fetch_quota(self, account: NormalizedAccount, tokens: dict[str, str], session: Any) -> dict[str, Any] | None:
        return {"limit": 1000, "remaining": 999, "used": 1}

    async def cleanup_session(self, session: Any) -> None:
        pass