-- Retire the legacy `routines` feature: it was generalised into agents (triggers) + procedures, and the
-- @eidandev/routines plugin is no longer in CORE_PLUGINS. Drop its tables so neither existing nor fresh
-- databases keep empty, unused `eidan.routines` / `eidan.routine_runs` around. Idempotent (IF EXISTS).
DROP TABLE IF EXISTS eidan.routine_runs CASCADE;
DROP TABLE IF EXISTS eidan.routines CASCADE;
