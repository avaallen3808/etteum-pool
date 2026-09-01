#!/usr/bin/env python3
"""
Token Harvester for Web Providers (qwen-web, deepseek-web, zai-web)
===============================================================
Opens Playwright browser to each provider's login page, waits for
you to log in manually, then extracts the auth token from localStorage
and saves it to a JSON file for bulk import.

Usage:
  # Harvest a single provider (opens browser, waits for login)
  python3 harvest_token.py qwen-web

  # Harvest all three providers in sequence
  python3 harvest_token.py all

  # Import saved tokens into the pool database
  python3 harvest_token.py --import

  # Show what's been harvested so far
  python3 harvest_token.py --list

  # Clear all saved tokens
  python3 harvest_token.py --clear
"""

import asyncio
import json
import os
import sys
import time
import sqlite3
from pathlib import Path
from datetime import datetime, timezone

# ── config ──────────────────────────────────────────────────────────────
CHROME = "/home/looee/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome"
TOKEN_FILE = Path.home() / ".etteum" / "harvested_tokens.json"
DB_PATH = Path("/home/looee/apps/etteum-pool/data/poolprox3.db")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

PROVIDERS = {
    "qwen-web": {
        "url": "https://chat.qwen.ai/",
        "key": "token",
        "label": "Qwen (chat.qwen.ai)",
        "validate": lambda v: len(v) > 40 and v.count(".") == 2,
    },
    "deepseek-web": {
        "url": "https://chat.deepseek.com/",
        "key": "userToken",
        "label": "DeepSeek (chat.deepseek.com)",
        "validate": lambda v: len(v) > 20,
    },
    "zai-web": {
        "url": "https://chat.z.ai/",
        "key": "token",
        "label": "Z.AI (chat.z.ai)",
        "validate": lambda v: len(v) > 40 and v.count(".") >= 2,
    },
}

# ── helpers ─────────────────────────────────────────────────────────────

def load_saved():
    """Load previously harvested tokens."""
    if TOKEN_FILE.exists():
        try:
            return json.loads(TOKEN_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return []


def save_tokens(tokens):
    """Save token list to file."""
    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps(tokens, indent=2))
    print(f"  💾 Saved to {TOKEN_FILE}")


def list_tokens():
    """Pretty-print harvested tokens."""
    tokens = load_saved()
    if not tokens:
        print("  No tokens harvested yet.")
        return
    print(f"  {'ID':<4} {'Provider':<16} {'Email':<30} {'Status':<10} {'Token (first 30)':<40}")
    print(f"  {'─'*4} {'─'*16} {'─'*30} {'─'*10} {'─'*40}")
    for i, t in enumerate(tokens):
        tok_preview = t["token"][:30] + "..." if len(t["token"]) > 30 else t["token"]
        print(f"  {i:<4} {t['provider']:<16} {t.get('email','?'):<30} {t.get('status','?'):<10} {tok_preview:<40}")


def import_to_db(tokens):
    """Import harvested tokens into the pool database."""
    if not DB_PATH.exists():
        print(f"  ❌ Database not found: {DB_PATH}")
        return

    db = sqlite3.connect(str(DB_PATH))
    now = int(time.time() * 1000)
    imported = 0
    skipped = 0

    for t in tokens:
        provider = t["provider"]
        email = t.get("email", f"harvested_{int(time.time())}@gmail.com")
        token = t["token"]

        # Check if this token already exists for this provider
        existing = db.execute(
            "SELECT id FROM accounts WHERE provider=? AND tokens LIKE ?",
            (provider, f"%{token[:20]}%")
        ).fetchone()
        if existing:
            print(f"  ⏭  {provider}/{email} — already exists (id={existing[0]})")
            skipped += 1
            continue

        try:
            db.execute(
                """INSERT INTO accounts (provider, email, password, status, enabled, tokens, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (provider, email, "harvested_token", "active", 1, json.dumps({"token": token}), now, now),
            )
            db.commit()
            print(f"  ✅ {provider}/{email} — imported")
            imported += 1
        except sqlite3.IntegrityError as e:
            print(f"  ⚠️  {provider}/{email} — {e}")
            skipped += 1

    db.close()
    print(f"\n  📊 Result: {imported} imported, {skipped} skipped")


# ── core harvester ──────────────────────────────────────────────────────

async def harvest_provider(provider_name: str, email_hint: str = "") -> dict | None:
    """
    Open Playwright browser, navigate to provider login page, wait for
    manual login, extract token from localStorage, return it.
    """
    info = PROVIDERS[provider_name]
    print(f"\n  🌐 Opening {info['label']}...")
    print(f"  🔑 Watching localStorage['{info['key']}']")
    print(f"  👤 Log in manually in the browser window.")
    print(f"     (Closing the browser cancels)\n")

    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            executable_path=CHROME,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        ctx = await browser.new_context(
            user_agent=UA,
            locale="en-US",
            viewport={"width": 1280, "height": 800},
        )
        page = await ctx.new_page()

        try:
            await page.goto(info["url"], wait_until="domcontentloaded", timeout=30000)
            print(f"  ⏳ Waiting for you to log in... (polling every 2s)")

            token = None
            for attempt in range(180):  # 6 minutes max
                try:
                    val = await page.evaluate(f"localStorage.getItem('{info['key']}')")
                    if val and info["validate"](val):
                        token = val
                        print(f"\n  ✅ Token captured! ({len(token)} chars)")
                        break
                except Exception:
                    pass

                if attempt % 15 == 0 and attempt > 0:
                    print(f"  ⏳ Still waiting... ({attempt*2}s elapsed)")

                try:
                    await page.wait_for_timeout(2000)
                except Exception:
                    break

            if not token:
                print(f"\n  ❌ No token found after 6 minutes.")
                return None

            # Try to get the email from the page too
            email = email_hint
            if not email:
                try:
                    email = await page.evaluate(
                        """() => {
                            const els = document.querySelectorAll('[class*="email"], [class*="account"], [class*="user"]');
                            for (const el of els) {
                                const t = el.textContent.trim();
                                if (t.includes('@')) return t;
                            }
                            return '';
                        }"""
                    )
                except Exception:
                    pass

            return {
                "provider": provider_name,
                "email": email or f"{provider_name.split('-')[0]}_user_{int(time.time())}@gmail.com",
                "token": token,
                "harvested_at": datetime.now(timezone.utc).isoformat(),
                "status": "active",
            }

        except Exception as e:
            print(f"  ❌ Error: {e}")
            return None
        finally:
            await browser.close()


# ── main ────────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]

    if not args:
        print(__doc__)
        return

    # Simple commands
    if args[0] == "--list":
        list_tokens()
        return
    if args[0] == "--clear":
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
            print("  🗑️  Token file cleared.")
        else:
            print("  Nothing to clear.")
        return
    if args[0] == "--import":
        tokens = load_saved()
        if not tokens:
            print("  No tokens to import. Harvest some first.")
            return
        print(f"  📦 Importing {len(tokens)} tokens to pool database...")
        import_to_db(tokens)
        return

    # Harvest mode
    target = args[0]
    email_hint = args[1] if len(args) > 1 else ""

    if target == "all":
        results = []
        for pname in ["qwen-web", "deepseek-web", "zai-web"]:
            result = asyncio.run(harvest_provider(pname, email_hint))
            if result:
                results.append(result)
                print(f"\n  ✨ {pname} → {result['email']} ({len(result['token'])} chars)")

        if results:
            existing = load_saved()
            # Merge: keep existing + new, dedup by provider+token
            seen = {(t["provider"], t["token"][:40]) for t in existing}
            for r in results:
                if (r["provider"], r["token"][:40]) not in seen:
                    existing.append(r)
            save_tokens(existing)
            print(f"\n  🎉 Harvested {len(results)} new token(s). Total stored: {len(existing)}")
        else:
            print("\n  😕 No tokens harvested.")

    elif target in PROVIDERS:
        result = asyncio.run(harvest_provider(target, email_hint))
        if result:
            existing = load_saved()
            seen = {(t["provider"], t["token"][:40]) for t in existing}
            if (result["provider"], result["token"][:40]) not in seen:
                existing.append(result)
            save_tokens(existing)
            print(f"\n  ✨ {target} → {result['email']} ({len(result['token'])} chars)")
            print(f"  📦 Total stored: {len(existing)}")
        else:
            print(f"\n  😕 No token harvested for {target}.")
    else:
        print(f"  ❌ Unknown provider: {target}")
        print(f"     Options: {', '.join(PROVIDERS.keys())}, all, --import, --list, --clear")
        sys.exit(1)


if __name__ == "__main__":
    main()