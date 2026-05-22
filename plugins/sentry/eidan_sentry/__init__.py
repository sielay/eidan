"""Eidan core plugin — Sentry continuous-thinking loop.

See ``docs/SENTRY_FEATURE_SPEC.md`` for the full design. Phase 1
implementation lives in :mod:`eidan_sentry.plugin` (entry point),
:mod:`eidan_sentry.loop` (the tick body), and
:mod:`eidan_sentry.patterns` (the deterministic detectors).
"""
