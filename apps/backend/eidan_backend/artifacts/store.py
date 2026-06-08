# SPDX-License-Identifier: AGPL-3.0-or-later
"""Artifact byte-store — one S3-shaped interface, swappable backends (#252).

The store handles **bytes only**; metadata lives in ``eidan.artifacts``
(see :mod:`.service`). One interface, backend chosen by config:

- :class:`PostgresArtifactStore` — bytes in Postgres ``bytea``. The
  zero-dependency default: multi-instance-safe (one source of truth),
  one-click-export friendly (the own-your-data promise). Good for
  self-host and dev. Participates in the caller's transaction, so a
  failed artifact write rolls back cleanly.
- :class:`S3ArtifactStore` — any S3-compatible object store (Supabase
  Storage / AWS S3 / Cloudflare R2 / MinIO). The scale / hosted-platform
  path; per-tenant bucket-or-prefix. Requires ``aioboto3`` (a follow-up
  dependency add — see :meth:`S3ArtifactStore.put`).

``eidan`` is multi-instance by design, so local disk is intentionally not
a backend (instance B can't read instance A's file).

The ``conn`` keyword threads the caller's asyncpg connection to a
DB-backed store so its writes join the same transaction as the metadata
row; object stores ignore it. This keeps a single interface across a
transactional backend and a non-transactional one.
"""

from __future__ import annotations

import os
from typing import Any, Protocol, runtime_checkable
from uuid import UUID


@runtime_checkable
class ArtifactStore(Protocol):
    """Bytes in, bytes out, addressed by an opaque ``storage_key``."""

    backend: str

    def storage_key(self, *, user_id: str, artifact_id: UUID) -> str:
        """The key under which this backend will address the bytes."""
        ...

    async def put(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str,
        conn: Any | None = None,
    ) -> None: ...

    async def read(self, key: str, *, conn: Any | None = None) -> bytes: ...

    async def delete(self, key: str, *, conn: Any | None = None) -> None: ...


class PostgresArtifactStore:
    """Bytes in ``eidan.artifact_blobs`` — the zero-dependency default.

    Keyed by the artifact id (the ``bytea`` row CASCADE-deletes with its
    ``eidan.artifacts`` parent, so there are no orphaned bytes). Requires
    the caller's ``conn`` so the blob write lands in the same transaction
    as the metadata row.
    """

    backend = "postgres"

    def storage_key(self, *, user_id: str, artifact_id: UUID) -> str:
        # For the DB backend the key *is* the artifact id; user scoping is
        # enforced by RLS / the WHERE clause on the metadata row, not the key.
        return str(artifact_id)

    @staticmethod
    def _require(conn: Any | None) -> Any:
        if conn is None:
            raise RuntimeError(
                "PostgresArtifactStore needs the caller's connection "
                "(pass conn=...); the blob write must share the metadata "
                "row's transaction."
            )
        return conn

    async def put(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str,
        conn: Any | None = None,
    ) -> None:
        await self._require(conn).execute(
            "INSERT INTO eidan.artifact_blobs (artifact_id, data) "
            "VALUES ($1::uuid, $2)",
            key,
            data,
        )

    async def read(self, key: str, *, conn: Any | None = None) -> bytes:
        row = await self._require(conn).fetchrow(
            "SELECT data FROM eidan.artifact_blobs WHERE artifact_id = $1::uuid",
            key,
        )
        if row is None:
            raise FileNotFoundError(f"artifact bytes not found: {key}")
        return bytes(row["data"])

    async def delete(self, key: str, *, conn: Any | None = None) -> None:
        # Normally a no-op: the blob CASCADE-deletes with the artifacts row.
        # Provided for symmetry with the object-store backend.
        await self._require(conn).execute(
            "DELETE FROM eidan.artifact_blobs WHERE artifact_id = $1::uuid",
            key,
        )


class S3ArtifactStore:
    """Any S3-compatible object store, addressed by ``{user_id}/{id}``.

    Backend selected entirely by config (endpoint/bucket/credentials), so
    Supabase Storage ↔ S3 ↔ R2 ↔ MinIO is a config swap, no code change.

    NOTE: the concrete client needs ``aioboto3`` in the backend deps — a
    deliberate follow-up (``uv add aioboto3`` + ``uv lock``) under #252 so
    this "start" stays dependency-clean. The interface, config, and
    key-shaping are real now; the three methods raise until the dep lands.
    """

    backend = "s3"

    def __init__(
        self,
        *,
        endpoint_url: str | None,
        bucket: str,
        region: str | None,
        access_key: str | None,
        secret_key: str | None,
    ) -> None:
        self.endpoint_url = endpoint_url
        self.bucket = bucket
        self.region = region
        self._access_key = access_key
        self._secret_key = secret_key

    def storage_key(self, *, user_id: str, artifact_id: UUID) -> str:
        return f"{user_id}/{artifact_id}"

    def _client(self) -> Any:  # pragma: no cover - needs aioboto3
        try:
            import aioboto3  # type: ignore
        except ModuleNotFoundError as err:  # pragma: no cover
            raise RuntimeError(
                "S3 artifact backend requires 'aioboto3'. Add it: "
                "`uv add aioboto3 && uv lock` (issue #252 follow-up)."
            ) from err
        return aioboto3.Session().client(
            "s3",
            endpoint_url=self.endpoint_url,
            region_name=self.region,
            aws_access_key_id=self._access_key,
            aws_secret_access_key=self._secret_key,
        )

    async def put(
        self, key: str, data: bytes, *, content_type: str, conn: Any | None = None
    ) -> None:  # pragma: no cover - needs aioboto3
        async with self._client() as s3:
            await s3.put_object(
                Bucket=self.bucket, Key=key, Body=data, ContentType=content_type
            )

    async def read(
        self, key: str, *, conn: Any | None = None
    ) -> bytes:  # pragma: no cover
        async with self._client() as s3:
            obj = await s3.get_object(Bucket=self.bucket, Key=key)
            async with obj["Body"] as body:
                return await body.read()

    async def delete(
        self, key: str, *, conn: Any | None = None
    ) -> None:  # pragma: no cover
        async with self._client() as s3:
            await s3.delete_object(Bucket=self.bucket, Key=key)


def make_artifact_store() -> ArtifactStore:
    """Build the configured store. Defaults to the zero-dep Postgres backend.

    Config (env / gitignored topology — honours the gitignored-config policy):

    - ``EIDAN_ARTIFACT_STORE`` = ``postgres`` (default) | ``s3``
    - ``EIDAN_ARTIFACT_S3_ENDPOINT`` / ``_BUCKET`` / ``_REGION``
      / ``_ACCESS_KEY`` / ``_SECRET``  (for the s3 backend)
    """
    backend = os.environ.get("EIDAN_ARTIFACT_STORE", "postgres").strip().lower()
    if backend == "postgres":
        return PostgresArtifactStore()
    if backend == "s3":
        bucket = os.environ.get("EIDAN_ARTIFACT_S3_BUCKET")
        if not bucket:
            raise RuntimeError(
                "EIDAN_ARTIFACT_STORE=s3 requires EIDAN_ARTIFACT_S3_BUCKET"
            )
        return S3ArtifactStore(
            endpoint_url=os.environ.get("EIDAN_ARTIFACT_S3_ENDPOINT") or None,
            bucket=bucket,
            region=os.environ.get("EIDAN_ARTIFACT_S3_REGION") or None,
            access_key=os.environ.get("EIDAN_ARTIFACT_S3_ACCESS_KEY") or None,
            secret_key=os.environ.get("EIDAN_ARTIFACT_S3_SECRET") or None,
        )
    raise RuntimeError(f"unknown EIDAN_ARTIFACT_STORE: {backend!r}")
