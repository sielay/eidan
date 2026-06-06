# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for ``eidan_backend.secrets.split_secret_key``.

This helper is the single source of truth for vault namespacing —
both the read path (``_read_native_vault``) and the ``eidan secret``
CLI writer call it, so set/get can never disagree on where a value
lives. These cases pin the contract.
"""

from __future__ import annotations

import pytest
from eidan_backend.secrets import split_secret_key


@pytest.mark.parametrize(
    ("key", "expected"),
    [
        ("slack.bot_token", ("slack", "bot_token")),
        ("plugin_sentry.smtp_password", ("plugin_sentry", "smtp_password")),
        # Only the FIRST dot splits scope from subkey.
        ("a.b.c", ("a", "b.c")),
        # No dot → core scope.
        ("standalone", ("core", "standalone")),
    ],
)
def test_split_secret_key(key: str, expected: tuple[str, str]) -> None:
    assert split_secret_key(key) == expected
