"""HTTP surface for the backend.

Wraps the Phase-1 agentic loop (``eidan_backend.loop``) in a FastAPI
application so a browser frontend (and the CLI's HTTP fallback) can
talk to it. The shape — endpoints, auth middleware, error envelope,
SSE transport — is pinned by:

- ``docs/005 §5.1`` — inbound persistence and the wire shape of ``/turn``.
- ``docs/014 §3`` — chat-panel data sources.
- ``docs/011 §4, §10`` — JWT extraction, auth middleware, typed 401/403
  responses.

The :func:`create_app` factory builds an app with the agentic loop's
dependencies (provider, DB pool, JWT validator) wired in via
``app.state`` so test code and the production entry point share one
codepath. The :func:`run` entry point starts uvicorn and is exposed
as the ``eidan-backend-http`` script.
"""

from __future__ import annotations

from .app import create_app
from .server import run

__all__ = ["create_app", "run"]
