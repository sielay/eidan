# SPDX-License-Identifier: AGPL-3.0-or-later
"""topology.yml loading + per-node resolution.

The `eidan deploy` CLI reads its source of truth from an operator-
private YAML file (default `.eidan/topology.yml`, overridable via
`--topology=<path>` so a private ops repo can hold it). One node per
host the operator runs an eidan backend on; the reconcilers each
consume a fully-resolved per-node view.

This module is responsible for:

- Parsing the YAML (PyYAML, safe-loader, no `!vault` decryption — see
  below).
- Validating the parsed dict against the generated Pydantic model
  (`eidan_schemas.generated.core.deploy.Topology_schema`).
- Deep-merging the optional top-level `defaults:` block into each
  node so reconcilers see a single resolved object.

Vault-encrypted scalars are not supported in this PR — the parser
raises :class:`TopologyVaultEncryptionError` with a message pointing
the operator at `ansible-vault decrypt` so the file's vault layer
sits *outside* the parser today. Per-value `!vault` tag support
lands in a follow-up.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import yaml
from eidan_schemas.generated.core.deploy.Topology_schema import (
    Defaults,
    Node,
    Provider,
    Sentry,
    Smtp,
)
from eidan_schemas.generated.core.deploy.Topology_schema import (
    Topology as _TopologyModel,
)
from pydantic import ValidationError


class TopologyError(Exception):
    """Base class for topology parse / resolution problems."""


class TopologyFileMissing(TopologyError):
    """Raised when the path passed to :func:`load_topology` does not exist.

    Separate exception class so the CLI can print a friendly hint
    (`run `eidan init` to scaffold one`) instead of a generic
    file-not-found.
    """


class TopologyVaultEncryptionError(TopologyError):
    """Raised when the YAML contains ansible-vault tagged values.

    Vault-decryption is intentionally out of scope for the initial
    parser (see module docstring). The error message points the
    operator at `ansible-vault decrypt` as the manual workaround.
    """


class TopologyValidationError(TopologyError):
    """Raised when the parsed dict fails Pydantic validation.

    Wraps the underlying :class:`pydantic.ValidationError` so callers
    don't have to take a Pydantic dep just to catch parse failures.
    The original is attached as `__cause__` for debugging.
    """


class TopologyUnknownNode(TopologyError):
    """Raised by :meth:`Topology.resolve_node` when the name is not in
    the topology. Distinct from :class:`KeyError` so the CLI can show
    "did you mean …?" rather than a stack trace."""


class _VaultTagDetector(yaml.SafeLoader):
    """Custom SafeLoader that surfaces ansible-vault tags explicitly.

    PyYAML's default SafeLoader treats unknown tags as an error, but
    the message is opaque (`could not determine a constructor for the
    tag ...`). We register a dedicated constructor that raises a
    typed exception so :func:`load_topology` can re-raise as
    :class:`TopologyVaultEncryptionError` with a useful message.
    """


def _vault_tag_constructor(_loader: yaml.SafeLoader, node: yaml.Node) -> None:
    raise TopologyVaultEncryptionError(
        "Found ansible-vault tagged value at "
        f"line {node.start_mark.line + 1}. Per-value vault decryption "
        "is not yet supported by the topology parser. As an interim, "
        "decrypt the file in place with:\n\n"
        "  ansible-vault decrypt path/to/topology.yml\n\n"
        "Re-encrypt before committing. Transparent vault support "
        "lands in a follow-up PR."
    )


# `!vault` is the tag ansible-vault emits for both block-scalar and
# inline-scalar encrypted values. Register the constructor so we get a
# typed error instead of PyYAML's generic ConstructorError.
_VaultTagDetector.add_constructor("!vault", _vault_tag_constructor)


def _deep_merge_defaults(
    base: dict[str, Any] | None, override: dict[str, Any] | None
) -> dict[str, Any]:
    """Recursively merge ``override`` on top of ``base``.

    Used to apply `defaults:` to each node. Per-node values win; any
    key present in the node (even when ``None``) blocks the default
    from leaking in. Nested dicts merge key-by-key; lists are
    replaced, not concatenated (defaults rarely make sense for lists
    like ``bundles`` or ``disable`` anyway).
    """
    if base is None:
        return dict(override or {})
    if override is None:
        return dict(base)
    out: dict[str, Any] = dict(base)
    for key, override_value in override.items():
        base_value = out.get(key)
        if isinstance(base_value, dict) and isinstance(override_value, dict):
            out[key] = _deep_merge_defaults(base_value, override_value)
        else:
            out[key] = override_value
    return out


class ResolvedNode:
    """Per-node view with `defaults:` already merged in.

    Reconcilers consume :class:`ResolvedNode`, not raw :class:`Node`,
    so they never have to remember whether a field was set on the
    node or only in defaults. Exposed as an attribute-access wrapper
    around the Pydantic :class:`Node` for ergonomics; the underlying
    model is available as :attr:`raw` for callers that need the full
    Pydantic API.
    """

    __slots__ = ("name", "raw")

    def __init__(self, name: str, raw: Node) -> None:
        self.name = name
        self.raw = raw

    def __getattr__(self, item: str) -> Any:
        return getattr(self.raw, item)

    def __repr__(self) -> str:
        return f"ResolvedNode(name={self.name!r}, target={self.raw.target.value})"


class Topology:
    """Loaded topology with per-node resolution helpers.

    Wraps the generated Pydantic model so callers get a stable API
    (`resolve_node`, `iter_nodes`, `node_names`) regardless of any
    future schema-side refactors.
    """

    __slots__ = ("_model", "_resolved")

    def __init__(self, model: _TopologyModel) -> None:
        self._model = model
        self._resolved: dict[str, ResolvedNode] = {}

    @property
    def schema_version(self) -> int:
        return self._model.schema_

    @property
    def defaults(self) -> Defaults | None:
        return self._model.defaults

    def node_names(self) -> list[str]:
        """Sorted list of node names declared in the topology."""
        return sorted(self._model.nodes.keys())

    def resolve_node(self, name: str) -> ResolvedNode:
        """Return the node with `defaults:` merged in.

        Memoised — repeated calls for the same node return the same
        :class:`ResolvedNode`. Raises :class:`TopologyUnknownNode` if
        ``name`` isn't in the topology.
        """
        if name in self._resolved:
            return self._resolved[name]
        nodes_root = self._model.nodes
        if name not in nodes_root:
            known = ", ".join(self.node_names()) or "<none>"
            raise TopologyUnknownNode(
                f"unknown node {name!r}; known nodes: {known}"
            )
        # Round-trip through dict so the deep-merge can layer in the
        # defaults via a clean dictionary apply. Pydantic re-validates
        # on construction, so a malformed merge surfaces here rather
        # than at reconcile time. ``warnings=False`` silences a known
        # datamodel-codegen quirk: enum fields with string defaults (e.g.
        # ``deployment_mode: DeploymentMode = "production"``) emit a
        # serializer warning on every dump because the model carries the
        # raw string from validate rather than an enum instance. The
        # downstream ``model_validate`` coerces it back to the enum
        # cleanly, so the warning is cosmetic — but noisy.
        defaults_dict = (
            self._model.defaults.model_dump(exclude_none=True, warnings=False)
            if self._model.defaults is not None
            else {}
        )
        node_dict = nodes_root[name].model_dump(exclude_none=True, warnings=False)
        merged = _deep_merge_defaults(defaults_dict, node_dict)
        try:
            resolved_node = Node.model_validate(merged)
        except ValidationError as exc:
            raise TopologyValidationError(
                f"resolved node {name!r} failed re-validation after "
                f"defaults merge: {exc}"
            ) from exc
        resolved = ResolvedNode(name=name, raw=resolved_node)
        self._resolved[name] = resolved
        return resolved

    def iter_nodes(self) -> Iterator[ResolvedNode]:
        """Yield every node, resolved, in declared (sorted) order."""
        for name in self.node_names():
            yield self.resolve_node(name)


def load_topology(path: Path) -> Topology:
    """Read ``path``, parse, validate, return a :class:`Topology`.

    Raises:
        TopologyFileMissing: ``path`` does not exist.
        TopologyVaultEncryptionError: file contains ansible-vault
            tagged scalars (see module docstring).
        TopologyValidationError: the parsed YAML fails Pydantic
            validation against the schema.
    """
    if not path.exists():
        raise TopologyFileMissing(
            f"topology file not found at {path}. Run `eidan init` "
            "to scaffold one, or pass --topology=<path> to point at "
            "an existing file."
        )
    raw_text = path.read_text(encoding="utf-8")
    try:
        parsed = yaml.load(raw_text, Loader=_VaultTagDetector)
    except TopologyVaultEncryptionError:
        raise
    except yaml.YAMLError as exc:
        raise TopologyValidationError(
            f"{path} is not valid YAML: {exc}"
        ) from exc

    if not isinstance(parsed, dict):
        raise TopologyValidationError(
            f"{path}: top-level must be a mapping (got "
            f"{type(parsed).__name__})"
        )

    try:
        model = _TopologyModel.model_validate(parsed)
    except ValidationError as exc:
        raise TopologyValidationError(
            f"{path} failed schema validation: {exc}"
        ) from exc
    # `minProperties: 1` on `nodes` doesn't survive datamodel-codegen
    # (it's a JSON-Schema-only constraint), so enforce it here. A
    # topology with zero nodes is a useless config the operator
    # almost certainly didn't mean to commit.
    if not model.nodes:
        raise TopologyValidationError(
            f"{path}: `nodes` must declare at least one node "
            "(an empty topology has nothing to reconcile)"
        )
    return Topology(model)


__all__ = [
    "Defaults",
    "Node",
    "Provider",
    "ResolvedNode",
    "Sentry",
    "Smtp",
    "Topology",
    "TopologyError",
    "TopologyFileMissing",
    "TopologyUnknownNode",
    "TopologyValidationError",
    "TopologyVaultEncryptionError",
    "load_topology",
]
