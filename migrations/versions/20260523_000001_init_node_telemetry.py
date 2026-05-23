# SPDX-License-Identifier: AGPL-3.0-or-later
"""init eidan.node_heartbeats + eidan.node_events

Revision ID: 20260523000001
Revises: 20260521000001
Create Date: 2026-05-23

Per-node telemetry tables. Every backend process (the Pi at home,
each Fly machine, a Heroku dyno, a k8s pod) writes its own
liveness UPSERT and a stream of activity events into the shared
Postgres. The ``eidan_backend.node_identity`` module resolves the
``(node_id, node_type, metadata)`` triple at boot; the
``eidan_backend.telemetry`` emitter wraps both writes.

Modelled on the potem ``private.agent_heartbeats`` +
``private.node_events`` pair (``apps/pi-node`` + ``apps/api``,
docs in CLAUDE.md memory ``related_repos``). Two differences from
potem's shape:

- ``conversation_id`` (eidan's unit of work) replaces potem's
  ``job_id``. Both are nullable; an event can be a free-floating
  scheduler tick that doesn't belong to any conversation.
- Tables live in the ``eidan`` schema, not a separate ``private``
  schema, because eidan does not have potem's ``service_role`` vs
  ``anon`` split. Read-side access is gated at the HTTP route, not
  via RLS, because node identity is host-global (no ``user_id`` —
  multiple users share one Pi).

Retention posture matches ``llm_calls`` (see CLAUDE.md
``Conventions``): the table is immutable, retention is a separate
purge job concern. No ``deleted_at`` column.

The ``seq`` column on ``node_events`` is allocated by the emitter
under a per-node advisory lock, not by a sequence, so concurrent
writers from the *same* node don't fight for a shared sequence
across processes. In practice one node = one process, so contention
is theoretical; the advisory-lock pattern is just defensive.
"""
from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "20260523000001"
down_revision: str | None = "20260521000001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ---- node_heartbeats ----------------------------------------------------
    # One row per node. UPSERT every 30s while the process is alive;
    # the row decays into "offline" once last_seen falls behind a
    # dead-node threshold the read path applies (no DB-side cleanup —
    # we want the trail to persist for post-mortem).
    op.create_table(
        "node_heartbeats",
        sa.Column("node_id", sa.Text(), primary_key=True),
        # Coarse label for grouping in the UI. Constrained to the
        # set the detector knows about; an unknown value would mean
        # a typo in EIDAN_NODE_TYPE that slipped through the
        # detector's allow-list — fail loud at insert time rather
        # than display "unknown" rows.
        sa.Column("node_type", sa.Text(), nullable=False),
        sa.Column(
            "status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'online'"),
        ),
        sa.Column(
            "last_seen",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "metadata",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column(
            "created_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "node_type IN ('pi', 'fly', 'heroku', 'k8s', 'local')",
            name="node_heartbeats_node_type_check",
        ),
        sa.CheckConstraint(
            "status IN ('online', 'offline', 'degraded')",
            name="node_heartbeats_status_check",
        ),
        schema="eidan",
    )

    # updated_at trigger so the /api/admin/nodes dashboard can show
    # "row last touched at X" independently of last_seen (which is
    # heartbeat-write time). They're usually the same; they diverge
    # if the emitter changes status without a heartbeat refresh.
    op.execute(
        """
        CREATE TRIGGER trg_node_heartbeats_updated_at
        BEFORE UPDATE ON eidan.node_heartbeats
        FOR EACH ROW
        EXECUTE FUNCTION eidan.set_updated_at();
        """
    )

    # Read-path index: the dashboard query sorts by last_seen DESC
    # to surface live nodes first. last_seen alone is enough; the
    # PK already covers node_id lookups.
    op.create_index(
        "node_heartbeats_last_seen_idx",
        "node_heartbeats",
        [sa.text("last_seen DESC")],
        schema="eidan",
    )

    # ---- node_events --------------------------------------------------------
    # Append-only activity stream per node. seq is unique per node
    # (allocated by the emitter via SELECT MAX(seq)+1 under an
    # advisory lock) so /api/admin/nodes/<id>/events?after_seq=N
    # supports incremental polling identically across nodes.
    op.create_table(
        "node_events",
        sa.Column("node_id", sa.Text(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column(
            "ts",
            sa.TIMESTAMP(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        # Nullable because not every event ties to a conversation —
        # scheduler ticks, plugin lifecycle, boot/shutdown rows
        # are node-scoped only. No FK to eidan.conversations: a
        # conversation may be soft-deleted, but we want the event
        # trail to survive that.
        sa.Column(
            "conversation_id",
            postgresql.UUID(as_uuid=True),
            nullable=True,
        ),
        # Soft FK back to the heartbeat row. ON DELETE CASCADE so a
        # node-id rename (delete heartbeat, register fresh) cleans
        # up the orphan event trail. In practice we never delete
        # heartbeat rows — the trail builds up — but the constraint
        # encodes the invariant.
        sa.ForeignKeyConstraint(
            ["node_id"],
            ["eidan.node_heartbeats.node_id"],
            ondelete="CASCADE",
            name="node_events_node_id_fkey",
        ),
        sa.PrimaryKeyConstraint("node_id", "seq", name="node_events_pkey"),
        schema="eidan",
    )

    # Read indexes: the live tail wants (node_id, seq DESC) for the
    # default "last 200 events" view; (node_id, ts DESC) for any
    # human-time-window query that doesn't already know the seq.
    op.create_index(
        "node_events_node_seq_idx",
        "node_events",
        ["node_id", sa.text("seq DESC")],
        schema="eidan",
    )
    op.create_index(
        "node_events_node_ts_idx",
        "node_events",
        ["node_id", sa.text("ts DESC")],
        schema="eidan",
    )
    # Conversation-scoped queries (the agent asking "what happened
    # on this turn?") want a partial index on conversation_id so
    # the planner doesn't scan the whole node trail.
    op.create_index(
        "node_events_conversation_idx",
        "node_events",
        ["conversation_id"],
        postgresql_where=sa.text("conversation_id IS NOT NULL"),
        schema="eidan",
    )


def downgrade() -> None:
    op.drop_index(
        "node_events_conversation_idx",
        table_name="node_events",
        schema="eidan",
    )
    op.drop_index(
        "node_events_node_ts_idx",
        table_name="node_events",
        schema="eidan",
    )
    op.drop_index(
        "node_events_node_seq_idx",
        table_name="node_events",
        schema="eidan",
    )
    op.drop_table("node_events", schema="eidan")

    op.drop_index(
        "node_heartbeats_last_seen_idx",
        table_name="node_heartbeats",
        schema="eidan",
    )
    op.execute(
        "DROP TRIGGER IF EXISTS trg_node_heartbeats_updated_at "
        "ON eidan.node_heartbeats"
    )
    op.drop_table("node_heartbeats", schema="eidan")
