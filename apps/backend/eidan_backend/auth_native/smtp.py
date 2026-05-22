# SPDX-License-Identifier: AGPL-3.0-or-later
"""Email delivery for magic links (`docs/011 §16`).

Two modes:

- **SMTP** (production): the operator sets ``EIDAN_SMTP_HOST``,
  ``EIDAN_SMTP_PORT``, ``EIDAN_SMTP_USER``, ``EIDAN_SMTP_PASSWORD``,
  ``EIDAN_SMTP_FROM``. The host connects + sends via ``aiosmtplib``.

- **Log** (dev / not-yet-configured): no SMTP_HOST set. The host
  logs the magic-link URL + code to ``logs/backend.log`` and ALSO
  echoes them on the ``/api/auth/magic-link`` response when
  ``EIDAN_DEPLOYMENT_MODE`` isn't ``production``. The operator
  pastes the URL into their browser without needing Mailpit /
  Inbucket running.

This file intentionally has zero plugin dependencies. The CLI's
``eidan login`` flow can use the same primitive when invoked
remotely (not implemented yet — phase 6).
"""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass
from email.message import EmailMessage

logger = logging.getLogger(__name__)


def is_production() -> bool:
    """Return True iff EIDAN_DEPLOYMENT_MODE=production. Used by the
    route handler to decide whether to echo the token on the
    response body (never in prod; always in dev)."""
    return os.environ.get("EIDAN_DEPLOYMENT_MODE", "").lower() == "production"


def smtp_configured() -> bool:
    """Quick probe: do we have an SMTP host to talk to?"""
    return bool(os.environ.get("EIDAN_SMTP_HOST"))


@dataclass(frozen=True, slots=True)
class SmtpSettings:
    host: str
    port: int
    user: str | None
    password: str | None
    from_addr: str
    starttls: bool


def _load_smtp_settings() -> SmtpSettings | None:
    """Build the settings dataclass from env vars. ``None`` when
    EIDAN_SMTP_HOST is not set (dev / log-only mode)."""
    host = os.environ.get("EIDAN_SMTP_HOST")
    if not host:
        return None
    return SmtpSettings(
        host=host,
        port=int(os.environ.get("EIDAN_SMTP_PORT", "587")),
        user=os.environ.get("EIDAN_SMTP_USER") or None,
        password=os.environ.get("EIDAN_SMTP_PASSWORD") or None,
        from_addr=os.environ.get(
            "EIDAN_SMTP_FROM", "eidan-no-reply@localhost"
        ),
        starttls=os.environ.get("EIDAN_SMTP_STARTTLS", "1") not in ("0", "false", "no"),
    )


async def send_magic_link_email(
    *,
    to_email: str,
    magic_link_url: str,
    code: str,
) -> bool:
    """Deliver a magic link.

    Returns True when SMTP delivery succeeded; False when no SMTP
    is configured (log-only mode). Never raises — SMTP errors are
    logged so a transient outage doesn't blow up the login flow;
    the operator sees the link in the backend log and can paste it
    manually as a fallback.
    """
    # The log line is always emitted so the operator can find the
    # link in logs/backend.log even when SMTP eventually succeeds —
    # invaluable when debugging "did the email send" without
    # diving into Mailpit.
    logger.info(
        "[auth-native] magic link issued to=%s code=%s url=%s",
        to_email,
        code,
        magic_link_url,
    )

    settings = _load_smtp_settings()
    if settings is None:
        # No SMTP configured. The route handler will echo the link
        # on the response body when not in production so dev still
        # works without Mailpit.
        return False

    try:
        # Import locally so the module's import-time cost is zero
        # when nobody calls send_magic_link_email (the common case
        # in unit tests).
        import aiosmtplib

        msg = EmailMessage()
        msg["From"] = settings.from_addr
        msg["To"] = to_email
        msg["Subject"] = "Sign in to Eidan"
        msg.set_content(
            "Hi,\n\n"
            "Click the link below to sign in to Eidan:\n\n"
            f"    {magic_link_url}\n\n"
            f"Or paste this code into the login form: {code}\n\n"
            "The link expires in 15 minutes. If you didn't request "
            "this, ignore this email.\n\n"
            "— Eidan\n"
        )

        await aiosmtplib.send(
            msg,
            hostname=settings.host,
            port=settings.port,
            username=settings.user,
            password=settings.password,
            start_tls=settings.starttls,
            timeout=10,
        )
        return True
    except asyncio.CancelledError:
        # Honour cancellation — don't swallow it as a generic error.
        raise
    except Exception as exc:  # noqa: BLE001 — never fail login on SMTP outage
        logger.warning(
            "[auth-native] SMTP send failed (link is in the log above): %s",
            exc,
        )
        return False


__all__ = [
    "is_production",
    "send_magic_link_email",
    "smtp_configured",
]
