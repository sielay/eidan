-- Constrain venture_resources.provider to the known integration universe, paired to the resource
-- kind (was free text). This is the DB backstop over ALL known providers; the application-layer
-- adapter registry (packages/charles-ventures/src/providers.ts) further gates attach to only
-- adapter-backed ('available') providers. Keep this list a superset of the registry; add a provider
-- here when it becomes known, flip it to 'available' in the registry when its adapter ships.
-- Additive; drop-if-exists keeps it idempotent.

-- Data step: normalise well-formed legacy values (trim + lowercase) so they conform without
-- guessing at genuinely unsupported providers. This recovers the common case ("LinkedIn" ->
-- "linkedin"); anything still non-conforming is left for Track V cleanup (V1/V2) — see below.
UPDATE plugin_ventures.venture_resources
   SET provider = lower(btrim(provider))
 WHERE provider <> lower(btrim(provider));

ALTER TABLE plugin_ventures.venture_resources
    DROP CONSTRAINT IF EXISTS vr_provider_chk;

-- NOT VALID: enforce the CHECK on every new/updated row immediately, but do NOT reject
-- pre-existing legacy rows that may reference a provider with no adapter yet. A bare
-- ADD CONSTRAINT (no NOT VALID) would fail the whole migration/deploy on the first such row —
-- the V3 defect (charles ventures_resource_cleanup, Track V). Once V1 (registry-driven
-- providers) + V2 (external_ref resolution) have reconciled live data, a follow-up migration can
-- promote it: ALTER TABLE plugin_ventures.venture_resources VALIDATE CONSTRAINT vr_provider_chk;
ALTER TABLE plugin_ventures.venture_resources
    ADD CONSTRAINT vr_provider_chk CHECK (
        (kind = 'social_account'    AND provider IN ('manual', 'x', 'linkedin', 'instagram', 'facebook', 'threads', 'bluesky', 'mastodon', 'tiktok', 'youtube'))
     OR (kind = 'mailing_list'      AND provider IN ('manual', 'mailchimp', 'ses'))
     OR (kind = 'analytics_property' AND provider IN ('manual', 'ga4', 'vercel', 'plausible'))
    ) NOT VALID;
