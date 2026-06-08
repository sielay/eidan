# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the host capability registry (#249)."""

from __future__ import annotations

import pytest
from eidan_backend.capabilities import CapabilityRegistry, JobCapability


def test_empty_registry_snapshots_empty() -> None:
    reg = CapabilityRegistry()
    assert reg.is_empty() is True
    assert reg.snapshot() == []


def test_register_preserves_insertion_order_and_shape() -> None:
    reg = CapabilityRegistry()
    reg.register([JobCapability(kind="code", capacity=2)])
    reg.register([JobCapability(kind="business", capacity=1)])
    assert reg.is_empty() is False
    # Insertion order preserved so the advertised snapshot is deterministic.
    assert reg.snapshot() == [
        {"kind": "code", "capacity": 2},
        {"kind": "business", "capacity": 1},
    ]


def test_register_accepts_multiple_in_one_call() -> None:
    reg = CapabilityRegistry()
    reg.register(
        [
            JobCapability(kind="code", capacity=3),
            JobCapability(kind="business", capacity=1),
        ]
    )
    assert reg.snapshot() == [
        {"kind": "code", "capacity": 3},
        {"kind": "business", "capacity": 1},
    ]


def test_duplicate_kind_is_a_wiring_error() -> None:
    """One kind is served by one plugin; a second registration of the
    same kind raises, mirroring ToolRegistry's fail-loud posture."""
    reg = CapabilityRegistry()
    reg.register([JobCapability(kind="code", capacity=2)])
    with pytest.raises(ValueError, match="code"):
        reg.register([JobCapability(kind="code", capacity=4)])


def test_duplicate_kind_within_batch_raises() -> None:
    reg = CapabilityRegistry()
    with pytest.raises(ValueError, match="duplicate"):
        reg.register(
            [JobCapability(kind="code", capacity=2), JobCapability(kind="code", capacity=3)]
        )


def test_invalid_entry_leaves_registry_unchanged() -> None:
    """Validation is atomic: a bad entry partway through a batch rejects
    the whole batch rather than leaving a partial snapshot (so we never
    persist invalid JSON into node_heartbeats.served_kinds)."""
    reg = CapabilityRegistry()
    with pytest.raises(ValueError, match="capacity"):
        reg.register(
            [JobCapability(kind="code", capacity=2), JobCapability(kind="business", capacity=0)]
        )
    # Neither was committed — the valid one ahead of the bad one rolled back.
    assert reg.snapshot() == []


def test_empty_kind_rejected() -> None:
    reg = CapabilityRegistry()
    with pytest.raises(ValueError, match="non-empty"):
        reg.register([JobCapability(kind="", capacity=1)])
