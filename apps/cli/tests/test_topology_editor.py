# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for the topology mutation helpers + Rich views.

Covers:

- disable_plugin adds an entry; idempotent on re-add
- enable_plugin removes an entry; no-op when absent
- Round-trip preserves comments + formatting
- Vault-tagged scalars round-trip without decryption
- Unknown node surfaces the typed error
- render_node_list / render_node_show produce non-empty output for a
  realistic topology
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest
from eidan_cli.topology import load_topology
from eidan_cli.topology_editor import (
    TopologyEditUnknownNode,
    disable_plugin,
    enable_plugin,
)
from eidan_cli.topology_view import render_node_list, render_node_show
from rich.console import Console

# ---------- fixtures ----------


_TOPOLOGY = """\
# This is the operator's hand-authored topology. Comments
# below should survive a round-trip edit.
schema: 1

defaults:
  plugin_source: gh:sielay         # in-line comment too
  github_token: PAT-XXXX

nodes:
  kasha:
    target: pi
    host: 192.168.1.100
    ssh_user: pi
    database_url: postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan
    auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
    auth_allowed_email: you@example.com
    bundles: [eidan-pro]
    disable:
      - imap                       # already disabled here
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    database_url: postgresql+asyncpg://...
    auth_master_key: A-KEY-LONGER-THAN-THIRTY-TWO-CHARS-FOR-VALIDATION
    auth_allowed_email: you@example.com
"""


def _write(tmp_path: Path, body: str = _TOPOLOGY) -> Path:
    path = tmp_path / "topology.yml"
    path.write_text(body, encoding="utf-8")
    return path


# ---------- disable_plugin ----------


def test_disable_plugin_adds_to_disable_list(tmp_path: Path) -> None:
    path = _write(tmp_path)

    changed = disable_plugin(path, node_name="kasha", plugin="sentry")

    assert changed is True
    loaded = load_topology(path)
    node = loaded.resolve_node("kasha")
    disabled = [d.root if hasattr(d, "root") else str(d) for d in node.disable]
    assert "imap" in disabled
    assert "sentry" in disabled


def test_disable_plugin_is_idempotent(tmp_path: Path) -> None:
    """Re-disabling an already-disabled plugin is a no-op (no file
    modification, returns False)."""
    path = _write(tmp_path)
    before = path.read_text(encoding="utf-8")

    changed = disable_plugin(path, node_name="kasha", plugin="imap")

    assert changed is False
    assert path.read_text(encoding="utf-8") == before


def test_disable_plugin_creates_disable_list_if_missing(tmp_path: Path) -> None:
    """For a node that doesn't carry a `disable:` field yet, the editor
    creates one."""
    path = _write(tmp_path)
    changed = disable_plugin(path, node_name="fly-prod", plugin="sentry")

    assert changed is True
    loaded = load_topology(path)
    node = loaded.resolve_node("fly-prod")
    disabled = [d.root if hasattr(d, "root") else str(d) for d in node.disable]
    assert disabled == ["sentry"]


# ---------- enable_plugin ----------


def test_enable_plugin_removes_from_disable_list(tmp_path: Path) -> None:
    path = _write(tmp_path)

    changed = enable_plugin(path, node_name="kasha", plugin="imap")

    assert changed is True
    loaded = load_topology(path)
    node = loaded.resolve_node("kasha")
    disabled = [d.root if hasattr(d, "root") else str(d) for d in (node.disable or [])]
    assert "imap" not in disabled


def test_enable_plugin_noop_when_not_disabled(tmp_path: Path) -> None:
    """Enabling a plugin that wasn't disabled returns False and
    doesn't touch the file."""
    path = _write(tmp_path)
    before = path.read_text(encoding="utf-8")

    changed = enable_plugin(path, node_name="kasha", plugin="sentry")

    assert changed is False
    assert path.read_text(encoding="utf-8") == before


def test_enable_plugin_noop_when_node_has_no_disable_field(tmp_path: Path) -> None:
    """`fly-prod` has no `disable:` field — enabling anything there is
    just a no-op."""
    path = _write(tmp_path)
    before = path.read_text(encoding="utf-8")

    changed = enable_plugin(path, node_name="fly-prod", plugin="anything")

    assert changed is False
    assert path.read_text(encoding="utf-8") == before


# ---------- comment / formatting preservation ----------


def test_round_trip_preserves_comments(tmp_path: Path) -> None:
    """The operator's comments must survive a mutation. PyYAML would
    strip them; ruamel.yaml round-trip preserves them."""
    path = _write(tmp_path)

    disable_plugin(path, node_name="kasha", plugin="sentry")
    after = path.read_text(encoding="utf-8")

    assert "operator's hand-authored topology" in after
    assert "in-line comment too" in after
    assert "already disabled here" in after


def test_round_trip_preserves_vault_tag(tmp_path: Path) -> None:
    """Vault-encrypted scalars must round-trip as opaque tagged values
    — the editor never decrypts."""
    body = dedent(
        """\
        schema: 1
        nodes:
          kasha:
            target: pi
            host: 192.168.1.100
            ssh_user: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: !vault |
              $ANSIBLE_VAULT;1.1;AES256;default
              32316430
            auth_allowed_email: you@example.com
            disable:
              - imap
        """
    )
    path = _write(tmp_path, body)

    disable_plugin(path, node_name="kasha", plugin="sentry")
    after = path.read_text(encoding="utf-8")

    assert "!vault" in after
    assert "$ANSIBLE_VAULT;1.1;AES256;default" in after
    assert "32316430" in after


# ---------- error paths ----------


def test_unknown_node_raises_typed_error(tmp_path: Path) -> None:
    path = _write(tmp_path)
    with pytest.raises(TopologyEditUnknownNode):
        disable_plugin(path, node_name="kahsa", plugin="imap")


# ---------- render views ----------


def test_render_node_list_prints_every_node(tmp_path: Path) -> None:
    path = _write(tmp_path)
    loaded = load_topology(path)

    console = Console(record=True, width=200)
    render_node_list(loaded, console=console)
    out = console.export_text()

    assert "kasha" in out
    assert "fly-prod" in out
    assert "eidan-pro" in out  # bundles column
    assert "imap" in out  # disabled column


def test_render_node_show_renders_resolved_view(tmp_path: Path) -> None:
    path = _write(tmp_path)
    loaded = load_topology(path)
    node = loaded.resolve_node("kasha")

    console = Console(record=True, width=200)
    render_node_show(node, console=console)
    out = console.export_text()

    assert "kasha" in out
    assert "pi@192.168.1.100" in out
    assert "eidan-pro" in out
    assert "auth_master_key" in out
    # Master key value is not echoed — only length + dim marker.
    assert "A-KEY-LONGER-THAN" not in out
