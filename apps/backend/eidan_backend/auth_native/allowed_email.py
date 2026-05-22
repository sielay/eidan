# SPDX-License-Identifier: AGPL-3.0-or-later
"""Single-operator allow-list (`docs/011 §13`).

Today Eidan is single-operator: the host accepts magic-link requests
for exactly one email address. The pin is in
``EIDAN_AUTH_ALLOWED_EMAIL`` rather than a database row because:

- The deployment context already has a config file (.env / secrets
  manager); one more env var is cheaper than a DDL + admin UI.
- A single-row table needs UPDATE permissions + drift detection
  the env var avoids.
- Future multi-user variants of Eidan (in the paid baseline
  bundle) replace this module with a proper allow-list table; the
  function signature stays the same so callers don't change.
"""

from __future__ import annotations

import logging
import os
from email.utils import parseaddr

logger = logging.getLogger(__name__)


def get_allowed_email() -> str | None:
    """Return the configured operator email, lower-cased + stripped.

    ``None`` when the var is unset OR can't be parsed as an email.
    Callers should treat ``None`` as "auth is not configured" and
    refuse to issue magic links — silently allowing any email when
    no pin is set would be a security regression (the whole point
    of the pin is to refuse strangers).
    """
    raw = os.environ.get("EIDAN_AUTH_ALLOWED_EMAIL", "").strip()
    if not raw:
        return None
    _, addr = parseaddr(raw)
    if not addr or "@" not in addr:
        logger.warning(
            "[auth-native] EIDAN_AUTH_ALLOWED_EMAIL is set but does "
            "not look like a valid email; treating as unset"
        )
        return None
    return addr.lower()


def email_is_allowed(candidate: str) -> bool:
    """Constant-time-ish comparison of a candidate against the pin.

    Returns ``False`` when the pin is unset — refuse-by-default
    posture per the module docstring. Case-insensitive (emails are
    case-insensitive in the local part per RFC 5321 §2.4 in
    practice, even if the standard preserves case).
    """
    pinned = get_allowed_email()
    if pinned is None:
        return False
    return candidate.strip().lower() == pinned


__all__ = ["email_is_allowed", "get_allowed_email"]
