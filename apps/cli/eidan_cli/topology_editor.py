# SPDX-License-Identifier: AGPL-3.0-or-later
"""Round-trip topology.yml editor — preserve comments + formatting.

The operator's ``topology.yml`` is hand-authored with explanatory
comments and intentional ordering. CLI mutations
(``eidan plugin enable/disable``) need to surgically modify single
fields without flattening the operator's careful formatting; PyYAML
would strip every comment on dump, so we use ruamel.yaml's
round-trip loader instead.

Vault-encrypted scalars (``!vault |`` tagged values) round-trip as
opaque tagged scalars — the editor never decrypts. Every mutation
implemented here touches structural fields (the ``disable:`` list)
that are never vaulted, so the vault layer stays intact across an
edit.
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap, CommentedSeq


class TopologyEditError(Exception):
    """Base class for topology mutation failures."""


class TopologyEditUnknownNode(TopologyEditError):
    """Raised when an enable/disable target references a node not in
    the file."""


# ---------- vault tag passthrough -----------------------------------------


class _OpaqueVaultScalar:
    """Container for a vault-tagged scalar so ruamel round-trips it
    unchanged. We never decrypt; mutations only touch the
    ``disable:`` list, which is plain text."""

    yaml_tag = "!vault"

    def __init__(self, value: str, style: str | None = None) -> None:
        self.value = value
        self.style = style

    @classmethod
    def from_yaml(cls, constructor: Any, node: Any) -> _OpaqueVaultScalar:
        return cls(node.value, style=node.style)

    @classmethod
    def to_yaml(cls, representer: Any, data: _OpaqueVaultScalar) -> Any:
        return representer.represent_scalar(
            cls.yaml_tag, data.value, style=data.style
        )


def _yaml() -> YAML:
    """Configured round-trip YAML instance.

    Indented as the operator likely wrote it (2-space mapping, 4-space
    sequence) and with a healthy line width so long lock-file paths
    don't wrap mid-string."""
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.indent(mapping=2, sequence=4, offset=2)
    y.width = 4096
    # Make ruamel surface !vault tags as our passthrough instead of
    # raising on the unknown tag.
    y.constructor.add_constructor(
        _OpaqueVaultScalar.yaml_tag, _OpaqueVaultScalar.from_yaml
    )
    y.representer.add_representer(_OpaqueVaultScalar, _OpaqueVaultScalar.to_yaml)
    return y


# ---------- structural helpers --------------------------------------------


def _load_doc(path: Path) -> Any:
    if not path.exists():
        raise TopologyEditError(
            f"topology file not found at {path}. Run `eidan init` "
            "to scaffold one."
        )
    yaml = _yaml()
    with path.open("r", encoding="utf-8") as fh:
        return yaml.load(fh)


def _dump_doc(path: Path, doc: Any) -> None:
    yaml = _yaml()
    buf = io.StringIO()
    yaml.dump(doc, buf)
    path.write_text(buf.getvalue(), encoding="utf-8")


def _node(doc: Any, node_name: str) -> CommentedMap:
    nodes = doc.get("nodes")
    if not isinstance(nodes, CommentedMap):
        raise TopologyEditError(
            "topology has no `nodes:` mapping (or it's not a mapping)"
        )
    if node_name not in nodes:
        known = ", ".join(sorted(nodes.keys())) or "<none>"
        raise TopologyEditUnknownNode(
            f"unknown node {node_name!r}; known: {known}"
        )
    return nodes[node_name]


# ---------- public mutators -----------------------------------------------


def disable_plugin(path: Path, *, node_name: str, plugin: str) -> bool:
    """Add ``plugin`` to ``nodes.<node>.disable`` if not already there.

    Returns ``True`` if the file was modified (mutation happened),
    ``False`` if the plugin was already in the disable list.
    Idempotent on repeat invocations."""
    doc = _load_doc(path)
    node = _node(doc, node_name)
    disable = node.get("disable")
    if disable is None:
        disable = CommentedSeq()
        node["disable"] = disable
    if plugin in [str(item) for item in disable]:
        return False
    disable.append(plugin)
    _dump_doc(path, doc)
    return True


def enable_plugin(path: Path, *, node_name: str, plugin: str) -> bool:
    """Remove ``plugin`` from ``nodes.<node>.disable`` if present.

    Returns ``True`` if the file was modified, ``False`` if the
    plugin wasn't in the list (already enabled). Idempotent."""
    doc = _load_doc(path)
    node = _node(doc, node_name)
    disable = node.get("disable")
    if disable is None:
        return False
    indices = [
        idx for idx, item in enumerate(disable) if str(item) == plugin
    ]
    if not indices:
        return False
    # Iterate high-to-low so per-index deletions don't shift earlier
    # positions.
    for idx in reversed(indices):
        del disable[idx]
    if not disable:
        # Empty list is meaningful (operator set it deliberately) —
        # don't remove the field outright. Keep the key to make a
        # re-enable obvious in diffs.
        pass
    _dump_doc(path, doc)
    return True


__all__ = [
    "TopologyEditError",
    "TopologyEditUnknownNode",
    "disable_plugin",
    "enable_plugin",
]
