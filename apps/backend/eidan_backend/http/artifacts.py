# SPDX-License-Identifier: AGPL-3.0-or-later
"""``GET /api/artifacts/{id}`` — download an agent-produced artifact (#252).

A core route (not plugin-mounted) so auth + ownership are enforced
consistently: the path is *not* in the auth middleware's
``UNAUTHENTICATED_PATHS``, so it carries the access JWT and
``request.state.identity`` like every other resource route, and the
service scopes the lookup to ``identity.user_id``.
"""

from __future__ import annotations

from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

router = APIRouter()


@router.get("/api/artifacts/{artifact_id}")
async def download_artifact(request: Request, artifact_id: UUID) -> Response:
    """Stream one owned artifact back as a download.

    v1 returns the whole object in one body (fine for decks/PDFs). 404 if
    the artifact does not exist or is not owned by the caller.
    """
    identity = request.state.identity
    service = getattr(request.app.state, "artifact_service", None)
    if service is None:
        raise HTTPException(status_code=503, detail="artifact store not configured")

    result = await service.read(identity, artifact_id)
    if result is None:
        raise HTTPException(status_code=404, detail="artifact not found")
    meta, data = result

    # RFC 5987 filename* so non-ASCII deck titles survive the round-trip.
    disposition = f"attachment; filename*=UTF-8''{quote(meta.filename)}"
    return Response(
        content=data,
        media_type=meta.mime_type,
        headers={"Content-Disposition": disposition},
    )
