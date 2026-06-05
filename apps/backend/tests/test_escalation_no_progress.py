# SPDX-License-Identifier: AGPL-3.0-or-later
"""The no_progress escalation reason (#186 / docs/027 §7).

DB-backed: confirms migration 20260605_000003 widened the
escalations_reason_chk CHECK so a governed loop that bails on the
no-progress detector can record its escalation.
"""

from __future__ import annotations

from uuid import UUID

import pytest
from eidan_backend.db import create_pool
from eidan_backend.escalations import (
    Escalation,
    EscalationReason,
    EscalationSeverity,
    record_escalation,
)
from eidan_backend.persistence import upsert_user

from .conftest import build_identity


@pytest.mark.asyncio
async def test_no_progress_escalation_is_accepted(eidan_db: str) -> None:
    identity = build_identity()
    uid = UUID(identity.user_id)
    pool = await create_pool(eidan_db)
    try:
        async with pool.acquire() as conn:
            await upsert_user(conn, user_id=uid, email=identity.email)
            row_id = await record_escalation(
                conn,
                escalation=Escalation(
                    severity=EscalationSeverity.MEDIUM,
                    reason_class=EscalationReason.NO_PROGRESS,
                    user_id=uid,
                    suggested_action="loop stalled — needs a human",
                ),
            )
            reason = await conn.fetchval(
                "SELECT reason_class FROM eidan.escalations WHERE id = $1", row_id
            )
            assert reason == "no_progress"
    finally:
        await pool.close()
