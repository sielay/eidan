-- Drop dead tables with no readers (leftover audit, 2026-06-24).
--   behaviour_dlq            — legacy trigger dead-letter queue; never written. Its only reader was
--                              the admin "triggers" pane (removed); triggers now live in
--                              eidan.agent_triggers.
--   node_capability_overrides — zero code references anywhere (incl. external/matbot).
--   plugin_state              — zero code references anywhere.
-- eidan.agent_context is intentionally KEPT — it backs the /api/agent persona/context settings.
-- Idempotent.
DROP TABLE IF EXISTS eidan.behaviour_dlq;
DROP TABLE IF EXISTS eidan.node_capability_overrides;
DROP TABLE IF EXISTS eidan.plugin_state;
