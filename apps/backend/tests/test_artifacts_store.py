# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the artifact byte-store layer (#252).

DB-free: exercises the factory, key-shaping, the Postgres conn-guard, and
protocol conformance. The service/route round-trip (which needs the
``eidan_db`` fixture) is a separate integration test — tracked, not here.
"""

from __future__ import annotations

from uuid import uuid4

import pytest
from eidan_backend.artifacts.store import (
    ArtifactStore,
    PostgresArtifactStore,
    S3ArtifactStore,
    make_artifact_store,
)


def test_default_backend_is_postgres(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("EIDAN_ARTIFACT_STORE", raising=False)
    store = make_artifact_store()
    assert isinstance(store, PostgresArtifactStore)
    assert store.backend == "postgres"


def test_postgres_store_satisfies_protocol() -> None:
    # runtime_checkable Protocol — guards against signature drift.
    assert isinstance(PostgresArtifactStore(), ArtifactStore)


def test_postgres_key_is_the_artifact_id() -> None:
    art_id = uuid4()
    key = PostgresArtifactStore().storage_key(user_id=str(uuid4()), artifact_id=art_id)
    assert key == str(art_id)


def test_s3_key_is_user_scoped() -> None:
    store = S3ArtifactStore(
        endpoint_url=None, bucket="b", region=None, access_key=None, secret_key=None
    )
    user_id = str(uuid4())
    art_id = uuid4()
    assert (
        store.storage_key(user_id=user_id, artifact_id=art_id) == f"{user_id}/{art_id}"
    )


@pytest.mark.asyncio
async def test_postgres_store_requires_connection() -> None:
    store = PostgresArtifactStore()
    with pytest.raises(RuntimeError, match="needs the caller's connection"):
        await store.put("k", b"data", content_type="text/plain", conn=None)
    with pytest.raises(RuntimeError, match="needs the caller's connection"):
        await store.read("k", conn=None)


def test_s3_backend_requires_bucket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_ARTIFACT_STORE", "s3")
    monkeypatch.delenv("EIDAN_ARTIFACT_S3_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="EIDAN_ARTIFACT_S3_BUCKET"):
        make_artifact_store()


def test_unknown_backend_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EIDAN_ARTIFACT_STORE", "ftp")
    with pytest.raises(RuntimeError, match="unknown EIDAN_ARTIFACT_STORE"):
        make_artifact_store()


def test_include_routers_mounts_artifact_download_route() -> None:
    # Both create_app() (tests) and create_app_from_env() (production) mount
    # routers via _include_routers, so testing the shared helper guarantees
    # the download route reaches prod — guards the drift Copilot caught.
    from eidan_backend.http.app import _include_routers
    from fastapi import FastAPI

    app = FastAPI()
    _include_routers(app)
    paths = {getattr(r, "path", None) for r in app.routes}
    assert "/api/artifacts/{artifact_id}" in paths
