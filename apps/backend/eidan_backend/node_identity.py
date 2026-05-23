# SPDX-License-Identifier: AGPL-3.0-or-later
"""Node identity + platform detection.

Every eidan backend process is one *node*. The pi sitting on your
desk, each Fly machine in each region, a Heroku dyno, a k8s pod —
all distinct nodes writing into the same Postgres. Telemetry
(``eidan.node_heartbeats`` + ``eidan.node_events``, see
``migrations/versions/20260523_*_init_node_telemetry.py``) needs a
stable identifier per node and a coarse ``node_type`` label so the
``/api/admin/nodes`` dashboard can group "the foreground Fly
machines" vs "the Pi worker" vs "my laptop dev process".

Resolution order, highest precedence first:

1. ``EIDAN_NODE_ID`` / ``EIDAN_NODE_TYPE`` env vars — operator
   override, always wins.
2. Platform fingerprints — ``FLY_MACHINE_ID`` (Fly), ``DYNO``
   (Heroku), ``KUBERNETES_SERVICE_HOST`` (k8s).
3. Fallback — short hostname, ``node_type='local'``.

The ``metadata`` block carries platform-specific labels (region,
app name, image ref, kubernetes namespace, …) so an operator
inspecting the heartbeat row can tell which Fly region / k8s pod
they're looking at without parsing the node_id string. Empty
fields are dropped so the row stays terse.

Detection is pure-Python with no DB or network calls; it runs once
per process at startup and the result is reused for every
heartbeat write and every event emission.
"""

from __future__ import annotations

import os
import platform
import socket
from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class NodeIdentity:
    """One instance per process, computed at bootstrap.

    Goes into every ``node_heartbeats`` UPSERT and every
    ``node_events`` row written by this process.
    """

    node_id: str
    node_type: str  # 'pi' | 'fly' | 'heroku' | 'k8s' | 'local'
    metadata: dict[str, Any] = field(default_factory=dict)


_VALID_NODE_TYPES = frozenset({"pi", "fly", "heroku", "k8s", "local"})


def _short_hostname() -> str:
    """First label of the hostname.

    Pi default hostnames look like ``kasha`` already; cloud machines
    often pick up FQDNs (``ip-10-0-0-1.eu-west-1.compute.internal``).
    The short form is what an operator types when they grep journald
    or look at the /api/admin/nodes list.
    """
    full = socket.gethostname() or "unknown"
    return full.split(".", 1)[0]


def _base_metadata() -> dict[str, Any]:
    """Cross-platform labels every node carries.

    Keep this terse — the platform-specific detector layers
    additional keys (region, app, dyno number, namespace) on top.
    """
    return {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "python": platform.python_version(),
    }


def _detect_fly() -> NodeIdentity | None:
    """Fly.io: ``FLY_MACHINE_ID`` is set on every Fly machine."""
    machine_id = os.environ.get("FLY_MACHINE_ID")
    if not machine_id:
        return None
    metadata = _base_metadata()
    for key, env in (
        ("fly_app", "FLY_APP_NAME"),
        ("fly_region", "FLY_REGION"),
        ("fly_image_ref", "FLY_IMAGE_REF"),
        ("fly_alloc_id", "FLY_ALLOC_ID"),
    ):
        value = os.environ.get(env)
        if value:
            metadata[key] = value
    return NodeIdentity(
        node_id=machine_id,
        node_type="fly",
        metadata=metadata,
    )


def _detect_heroku() -> NodeIdentity | None:
    """Heroku: ``DYNO`` looks like ``web.1`` / ``worker.2``.

    Dyno hostnames rotate on every restart, so the dyno *name* (the
    DYNO env var) is the stable-ish identifier. Heroku's app name
    isn't injected as an env var by default; operators who want it
    set ``EIDAN_NODE_METADATA_HEROKU_APP=<app>`` (or override
    ``EIDAN_NODE_ID`` outright).
    """
    dyno = os.environ.get("DYNO")
    if not dyno:
        return None
    metadata = _base_metadata()
    metadata["heroku_dyno"] = dyno
    return NodeIdentity(
        node_id=f"heroku-{dyno}",
        node_type="heroku",
        metadata=metadata,
    )


def _detect_kubernetes() -> NodeIdentity | None:
    """Kubernetes: every pod has ``KUBERNETES_SERVICE_HOST`` injected.

    The pod name (``HOSTNAME``) is stable enough for telemetry as
    long as deployments use a StatefulSet or operators set
    ``EIDAN_NODE_ID`` explicitly. With a Deployment the pod
    hostnames roll, which is fine — each new pod registers fresh
    and the old heartbeat decays into 'offline'.
    """
    if not os.environ.get("KUBERNETES_SERVICE_HOST"):
        return None
    metadata = _base_metadata()
    namespace = os.environ.get("POD_NAMESPACE") or os.environ.get(
        "KUBERNETES_NAMESPACE"
    )
    if namespace:
        metadata["k8s_namespace"] = namespace
    return NodeIdentity(
        node_id=_short_hostname(),
        node_type="k8s",
        metadata=metadata,
    )


def _detect_pi() -> NodeIdentity | None:
    """Raspberry Pi heuristic — ``platform.machine()`` reports
    ``aarch64`` (Pi 4/5 64-bit) on Pi OS.

    Not authoritative (a generic aarch64 server would also match)
    but operators can always pin with ``EIDAN_NODE_TYPE=pi``. The
    practical effect of getting this wrong is cosmetic: the
    /api/admin/nodes dashboard groups by node_type, so a
    misclassified node shows up under the wrong heading.
    """
    if platform.machine().lower() != "aarch64":
        return None
    metadata = _base_metadata()
    return NodeIdentity(
        node_id=_short_hostname(),
        node_type="pi",
        metadata=metadata,
    )


def _detect_local() -> NodeIdentity:
    """Fallback. Always succeeds."""
    return NodeIdentity(
        node_id=_short_hostname(),
        node_type="local",
        metadata=_base_metadata(),
    )


def detect() -> NodeIdentity:
    """Resolve the running process's node identity.

    Env overrides win. ``EIDAN_NODE_ID`` alone is enough — the
    detector still fills in ``node_type`` + metadata from the
    platform fingerprint. ``EIDAN_NODE_TYPE`` lets the operator
    override the auto-detected label (e.g. running on a fly machine
    but treating it as 'pi' for grouping). Unknown types fall back
    to 'local' with a structured logger warning at caller-side; we
    don't raise here because identity detection is on the boot hot
    path and a typo in ``EIDAN_NODE_TYPE`` should not block start.
    """
    # Run a detector chain. The first hit wins; absent any hit,
    # _detect_local() always succeeds.
    detected = (
        _detect_fly()
        or _detect_heroku()
        or _detect_kubernetes()
        or _detect_pi()
        or _detect_local()
    )

    override_id = os.environ.get("EIDAN_NODE_ID")
    override_type = os.environ.get("EIDAN_NODE_TYPE")

    node_id = override_id or detected.node_id
    if override_type and override_type in _VALID_NODE_TYPES:
        node_type = override_type
    else:
        node_type = detected.node_type

    return NodeIdentity(
        node_id=node_id,
        node_type=node_type,
        metadata=detected.metadata,
    )
