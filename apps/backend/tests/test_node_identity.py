# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for :mod:`eidan_backend.node_identity`.

Detection has to work the same on developer laptops (no platform
env vars), Pis (aarch64 fingerprint), Fly machines (FLY_MACHINE_ID),
Heroku dynos (DYNO), and k8s pods (KUBERNETES_SERVICE_HOST). Each
test monkeypatches the relevant env to simulate the platform.

No DB, no asyncio — pure function calls."""

from __future__ import annotations

import pytest
from eidan_backend.node_identity import _VALID_NODE_TYPES, detect

# All env keys the detector reads. Tests start with these cleared so
# the laptop-running-tests doesn't accidentally inherit a fly token.
_DETECTOR_ENV = (
    "EIDAN_NODE_ID",
    "EIDAN_NODE_TYPE",
    "EIDAN_NODE_METADATA_HEROKU_APP",
    "FLY_MACHINE_ID",
    "FLY_APP_NAME",
    "FLY_REGION",
    "FLY_IMAGE_REF",
    "FLY_ALLOC_ID",
    "DYNO",
    "KUBERNETES_SERVICE_HOST",
    "POD_NAMESPACE",
    "KUBERNETES_NAMESPACE",
)


@pytest.fixture(autouse=True)
def _clean_detector_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in _DETECTOR_ENV:
        monkeypatch.delenv(key, raising=False)


def test_local_fallback_uses_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    """No platform env, no overrides — node_type=local, node_id is the
    short hostname."""
    identity = detect()
    assert identity.node_type == "local"
    assert identity.node_id  # never empty
    assert "." not in identity.node_id  # short form
    assert "hostname" in identity.metadata
    assert "platform" in identity.metadata
    assert "python" in identity.metadata


def test_fly_fingerprint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLY_MACHINE_ID", "m-test-abc123")
    monkeypatch.setenv("FLY_APP_NAME", "eidan-api")
    monkeypatch.setenv("FLY_REGION", "lhr")
    monkeypatch.setenv("FLY_IMAGE_REF", "registry.fly.io/eidan-api:deployment-01")
    identity = detect()
    assert identity.node_id == "m-test-abc123"
    assert identity.node_type == "fly"
    assert identity.metadata["fly_app"] == "eidan-api"
    assert identity.metadata["fly_region"] == "lhr"
    assert identity.metadata["fly_image_ref"].endswith("deployment-01")


def test_heroku_fingerprint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DYNO", "web.1")
    identity = detect()
    assert identity.node_id == "heroku-web.1"
    assert identity.node_type == "heroku"
    assert identity.metadata["heroku_dyno"] == "web.1"
    # Without EIDAN_NODE_METADATA_HEROKU_APP set the key is absent
    # (not just empty), so the dashboard knows not to render it.
    assert "heroku_app" not in identity.metadata


def test_heroku_metadata_app_env_picked_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Heroku doesn't inject the app name as an env var by default.
    Operators who want the label set EIDAN_NODE_METADATA_HEROKU_APP
    in the dyno config vars; the detector surfaces it on the
    heartbeat metadata."""
    monkeypatch.setenv("DYNO", "worker.2")
    monkeypatch.setenv("EIDAN_NODE_METADATA_HEROKU_APP", "eidan-prod")
    identity = detect()
    assert identity.metadata["heroku_app"] == "eidan-prod"


def test_kubernetes_fingerprint(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("POD_NAMESPACE", "eidan-prod")
    identity = detect()
    assert identity.node_type == "k8s"
    assert identity.metadata["k8s_namespace"] == "eidan-prod"
    # node_id falls back to short hostname under k8s — pod hostname
    # IS the pod name in practice, but we don't assert on a specific
    # value to keep the test portable.
    assert identity.node_id  # non-empty


def test_eidan_node_id_overrides_detected_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EIDAN_NODE_ID wins over platform fingerprint."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-detected")
    monkeypatch.setenv("EIDAN_NODE_ID", "operator-pinned")
    identity = detect()
    assert identity.node_id == "operator-pinned"
    # node_type still picked up from the platform fingerprint
    # (override is for the id; type also has its own env var).
    assert identity.node_type == "fly"


def test_eidan_node_type_overrides_detected_type(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """EIDAN_NODE_TYPE lets the operator regroup a node — useful when
    a Fly machine is functionally serving as a Pi-equivalent
    background worker, say."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-detected")
    monkeypatch.setenv("EIDAN_NODE_TYPE", "pi")
    identity = detect()
    assert identity.node_type == "pi"
    # id still from the fly fingerprint
    assert identity.node_id == "m-detected"


def test_invalid_eidan_node_type_falls_back_to_detected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A typo in EIDAN_NODE_TYPE doesn't propagate a bad enum into the
    CHECK-constrained heartbeats column."""
    monkeypatch.setenv("FLY_MACHINE_ID", "m-test")
    monkeypatch.setenv("EIDAN_NODE_TYPE", "raspberrypi")  # not in the valid set
    identity = detect()
    assert identity.node_type == "fly"  # fell back to detected


def test_valid_node_types_match_migration_check_constraint() -> None:
    """The CHECK constraint in
    migrations/versions/20260523_000001_init_node_telemetry.py
    enumerates the same set. If they drift the heartbeat insert
    will start raising 23514 — pin them with this contract test."""
    assert _VALID_NODE_TYPES == frozenset(
        {"pi", "fly", "heroku", "k8s", "local"}
    )
