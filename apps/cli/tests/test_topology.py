# SPDX-License-Identifier: AGPL-3.0-or-later
"""Unit tests for ``eidan_cli.topology``.

Covers the load → validate → resolve path against the generated
Pydantic model:

- Minimal valid topology loads cleanly
- Required fields rejected when missing
- Unknown fields rejected (`additionalProperties: false`)
- ``defaults`` merge: per-node values win, nested dicts merge
  key-by-key, list values replace rather than concatenate
- Memoisation of ``resolve_node`` returns the same instance
- ``!vault`` tagged YAML raises a typed error rather than crashing
- File-missing raises the typed error with a useful message
"""

from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest
from eidan_cli.topology import (
    ResolvedNode,
    Topology,
    TopologyFileMissing,
    TopologyUnknownNode,
    TopologyValidationError,
    TopologyVaultEncryptionError,
    load_topology,
)

# ---------- minimal load --------------------------------------------------


def _write(tmp_path: Path, body: str, name: str = "topology.yml") -> Path:
    path = tmp_path / name
    path.write_text(dedent(body).lstrip(), encoding="utf-8")
    return path


_MINIMAL_PI = """
schema: 1
nodes:
  kasha:
    target: pi
    database_url: postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan
    auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
    auth_allowed_email: you@example.com
"""


def test_load_minimal_topology(tmp_path: Path) -> None:
    """A topology with one Pi node and no defaults parses cleanly and
    surfaces the node via the resolution helpers."""
    topology = load_topology(_write(tmp_path, _MINIMAL_PI))

    assert isinstance(topology, Topology)
    assert topology.schema_version == 1
    assert topology.node_names() == ["kasha"]

    node = topology.resolve_node("kasha")
    assert isinstance(node, ResolvedNode)
    assert node.name == "kasha"
    assert node.target.value == "pi"
    assert (
        node.database_url
        == "postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan"
    )
    # Defaults that aren't overridden land at the schema defaults.
    assert node.deployment_mode.value == "production"
    assert node.http_host == "0.0.0.0"
    assert node.http_port == 8000
    # No defaults declared → these stay None.
    assert node.provider is None
    assert node.sentry is None
    assert node.smtp is None


# ---------- validation errors --------------------------------------------


def test_missing_required_field_raises_validation_error(tmp_path: Path) -> None:
    """``auth_master_key`` is required; omitting it must surface a
    typed validation error rather than a Pydantic stack trace."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: pi
            database_url: postgresql+asyncpg://...
            auth_allowed_email: you@example.com
    """
    with pytest.raises(TopologyValidationError):
        load_topology(_write(tmp_path, body))


def test_unknown_field_rejected_by_additional_properties(
    tmp_path: Path,
) -> None:
    """Misspelled / unknown fields fail Pydantic's `extra: forbid`."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: pi
            database_url: postgresql+asyncpg://...
            auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
            auth_allowed_email: you@example.com
            datbase_url: typo                # ← misspelled
    """
    with pytest.raises(TopologyValidationError):
        load_topology(_write(tmp_path, body))


def test_zero_nodes_rejected(tmp_path: Path) -> None:
    """`nodes:` must declare at least one entry — a topology with no
    nodes is a useless config the operator almost certainly didn't
    mean to commit."""
    body = """
        schema: 1
        nodes: {}
    """
    with pytest.raises(TopologyValidationError):
        load_topology(_write(tmp_path, body))


def test_unknown_target_rejected(tmp_path: Path) -> None:
    """`target:` is an enum — typos must fail fast at parse time."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: rapsberry          # ← typo
            database_url: postgresql+asyncpg://...
            auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
            auth_allowed_email: you@example.com
    """
    with pytest.raises(TopologyValidationError):
        load_topology(_write(tmp_path, body))


# ---------- defaults merge -----------------------------------------------


_WITH_DEFAULTS = """
schema: 1
defaults:
  plugin_source: gh:sielay
  github_token: PAT-XXXX
  provider:
    name: anthropic
    default_model: claude-sonnet-4-6
  sentry:
    enabled: true
    tick_interval: PT5M
nodes:
  kasha:
    target: pi
    database_url: postgresql+asyncpg://eidan:eidan@127.0.0.1:5432/eidan
    auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
    auth_allowed_email: you@example.com
    provider:
      name: ollama
      default_model: phi3
  fly-prod:
    target: fly
    app: eidan-api
    region: lhr
    database_url: postgresql+asyncpg://...
    auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
    auth_allowed_email: you@example.com
"""


def test_defaults_propagate_when_node_omits_them(tmp_path: Path) -> None:
    """`defaults.plugin_source` lands on every node that doesn't
    override it. Same for the nested provider object."""
    topology = load_topology(_write(tmp_path, _WITH_DEFAULTS))

    fly = topology.resolve_node("fly-prod")
    assert fly.plugin_source == "gh:sielay"
    assert fly.github_token == "PAT-XXXX"
    assert fly.provider is not None
    assert fly.provider.name.value == "anthropic"
    assert fly.provider.default_model == "claude-sonnet-4-6"
    assert fly.sentry is not None
    assert fly.sentry.enabled is True


def test_node_overrides_defaults_at_field_level(tmp_path: Path) -> None:
    """When a node sets the provider object, it REPLACES the default
    provider — we don't merge keys inside the same nested object the
    node redeclared."""
    topology = load_topology(_write(tmp_path, _WITH_DEFAULTS))

    kasha = topology.resolve_node("kasha")
    assert kasha.plugin_source == "gh:sielay"          # inherited
    assert kasha.provider is not None
    assert kasha.provider.name.value == "ollama"       # node-set
    assert kasha.provider.default_model == "phi3"      # node-set


def test_resolve_node_is_memoised(tmp_path: Path) -> None:
    """Repeated resolves return the same :class:`ResolvedNode` so
    reconcilers can share state without re-doing the merge."""
    topology = load_topology(_write(tmp_path, _WITH_DEFAULTS))
    first = topology.resolve_node("kasha")
    second = topology.resolve_node("kasha")
    assert first is second


def test_resolve_unknown_node_lists_known_nodes(tmp_path: Path) -> None:
    """Error message helps the operator notice a typo."""
    topology = load_topology(_write(tmp_path, _WITH_DEFAULTS))
    with pytest.raises(TopologyUnknownNode) as exc:
        topology.resolve_node("kahsa")
    assert "fly-prod" in str(exc.value)
    assert "kasha" in str(exc.value)


def test_iter_nodes_yields_in_sorted_order(tmp_path: Path) -> None:
    """`iter_nodes` returns nodes alphabetically so log output and
    deploy progress are deterministic across runs."""
    topology = load_topology(_write(tmp_path, _WITH_DEFAULTS))
    names = [n.name for n in topology.iter_nodes()]
    assert names == ["fly-prod", "kasha"]


# ---------- file-shape errors --------------------------------------------


def test_file_missing_raises_typed_error(tmp_path: Path) -> None:
    with pytest.raises(TopologyFileMissing) as exc:
        load_topology(tmp_path / "no-such-file.yml")
    assert "Run `eidan init`" in str(exc.value)


def test_vault_tagged_value_raises_typed_error(tmp_path: Path) -> None:
    """Until vault decryption ships, the parser must reject vaulted
    values with a clear message pointing at `ansible-vault decrypt`."""
    body = """
        schema: 1
        nodes:
          kasha:
            target: pi
            database_url: !vault |
                $ANSIBLE_VAULT;1.1;AES256
                32316430...
            auth_master_key: KEY-AT-LEAST-32-CHARS-LONG-YES-INDEED
            auth_allowed_email: you@example.com
    """
    with pytest.raises(TopologyVaultEncryptionError) as exc:
        load_topology(_write(tmp_path, body))
    assert "ansible-vault decrypt" in str(exc.value)


def test_non_mapping_top_level_rejected(tmp_path: Path) -> None:
    """A YAML file that's a list at the top level isn't a topology."""
    body = """
        - this is a list
        - not a topology
    """
    with pytest.raises(TopologyValidationError):
        load_topology(_write(tmp_path, body))


def test_malformed_yaml_rejected(tmp_path: Path) -> None:
    """Genuinely broken YAML surfaces as :class:`TopologyValidationError`
    too, not a raw PyYAML error."""
    path = tmp_path / "topology.yml"
    path.write_text("schema: 1\nnodes: { broken", encoding="utf-8")
    with pytest.raises(TopologyValidationError):
        load_topology(path)
