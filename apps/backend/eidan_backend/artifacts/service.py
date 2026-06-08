# SPDX-License-Identifier: AGPL-3.0-or-later
"""Artifact service — metadata rows (``eidan.artifacts``) + the byte-store (#252).

:class:`ArtifactService` is the host-side object behind ``ctx.artifacts``
and the ``GET /api/artifacts/{id}`` download route. It owns the
metadata-row writes and delegates the bytes to a configured
:class:`~.store.ArtifactStore`. Everything is ``user_id``-scoped, so the
session-variable plumbing in :func:`~eidan_backend.db.acquire` makes
isolation real the day an RLS plugin lands (``docs/002 §5.2``).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import asyncpg

from ..db import acquire
from ..identity import Identity
from .store import ArtifactStore


@dataclass(frozen=True, slots=True)
class ArtifactRef:
    """What a producing tool gets back from ``ctx.artifacts.create()``.

    ``download_url`` is the relative path the UI / chat renders as a
    download chip (resolved against the backend origin client-side).
    """

    id: UUID
    kind: str
    filename: str
    mime_type: str
    size_bytes: int
    download_url: str


@dataclass(frozen=True, slots=True)
class ArtifactMeta:
    """Row metadata the download route needs to set response headers."""

    id: UUID
    filename: str
    mime_type: str
    size_bytes: int
    storage_key: str


class ArtifactService:
    def __init__(
        self,
        pool: asyncpg.Pool,
        store: ArtifactStore,
        *,
        download_base: str = "/api/artifacts",
    ) -> None:
        self._pool = pool
        self._store = store
        self._base = download_base.rstrip("/")

    async def create(
        self,
        identity: Identity,
        *,
        kind: str,
        filename: str,
        data: bytes,
        mime_type: str,
        message_id: UUID | None = None,
        conversation_id: UUID | None = None,
        metadata: dict[str, Any] | None = None,
        created_by: str = "agent",
    ) -> ArtifactRef:
        """Persist an artifact (metadata row + bytes) and return its ref.

        For the Postgres backend the metadata row and the blob write share
        one transaction, so a failed byte-write rolls the row back — no
        half-written artifacts.
        """
        artifact_id = uuid4()
        storage_key = self._store.storage_key(
            user_id=identity.user_id, artifact_id=artifact_id
        )
        size_bytes = len(data)
        async with acquire(self._pool, identity) as conn:
            await conn.execute(
                """
                INSERT INTO eidan.artifacts
                    (id, user_id, conversation_id, message_id, kind,
                     mime_type, filename, size_bytes, storage_key,
                     metadata, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
                """,
                artifact_id,
                UUID(identity.user_id),
                conversation_id,
                message_id,
                kind,
                mime_type,
                filename,
                size_bytes,
                storage_key,
                json.dumps(metadata or {}),
                created_by,
            )
            await self._store.put(storage_key, data, content_type=mime_type, conn=conn)
        return ArtifactRef(
            id=artifact_id,
            kind=kind,
            filename=filename,
            mime_type=mime_type,
            size_bytes=size_bytes,
            download_url=f"{self._base}/{artifact_id}",
        )

    async def read(
        self, identity: Identity, artifact_id: UUID
    ) -> tuple[ArtifactMeta, bytes] | None:
        """Return ``(meta, bytes)`` for an owned artifact, or ``None``.

        Ownership is enforced by the ``user_id`` predicate (and RLS once a
        policy is present). v1 reads the whole object into memory — fine
        for decks/PDFs; large-object streaming with a held-open connection
        is a later refinement.
        """
        async with acquire(self._pool, identity) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, filename, mime_type, size_bytes, storage_key
                FROM eidan.artifacts
                WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
                """,
                artifact_id,
                UUID(identity.user_id),
            )
            if row is None:
                return None
            data = await self._store.read(row["storage_key"], conn=conn)
        meta = ArtifactMeta(
            id=row["id"],
            filename=row["filename"],
            mime_type=row["mime_type"],
            size_bytes=row["size_bytes"],
            storage_key=row["storage_key"],
        )
        return meta, data
