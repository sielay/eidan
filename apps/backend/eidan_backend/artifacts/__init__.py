# SPDX-License-Identifier: AGPL-3.0-or-later
"""Artifact primitive — store, attach & serve agent-produced files (#252).

A plugin tool produces *bytes* (a rendered deck, a PDF, an export); this
package persists the metadata in ``eidan.artifacts`` and the bytes in a
pluggable, S3-shaped store, and the HTTP layer serves them back for
download. Generic substrate, like ``events`` / ``knowledge`` / ``notes`` —
not specific to any one feature.
"""

from __future__ import annotations

from .service import ArtifactMeta, ArtifactRef, ArtifactService
from .store import ArtifactStore, PostgresArtifactStore, make_artifact_store

__all__ = [
    "ArtifactMeta",
    "ArtifactRef",
    "ArtifactService",
    "ArtifactStore",
    "PostgresArtifactStore",
    "make_artifact_store",
]
