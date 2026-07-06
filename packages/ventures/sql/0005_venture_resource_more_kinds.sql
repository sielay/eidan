-- Widen venture_resources to three more resource kinds: github_repo, webpage, domain (charles
-- ventures). Mirrors the registry in src/providers.ts; keep the DB CHECKs a superset of it.
-- Additive + idempotent (drop-if-exists then re-add), same pattern as 0004. NOT VALID on the
-- provider CHECK so legacy rows referencing an as-yet-unconstrained provider don't fail the deploy.

ALTER TABLE plugin_ventures.venture_resources
    DROP CONSTRAINT IF EXISTS vr_kind_chk;
ALTER TABLE plugin_ventures.venture_resources
    ADD CONSTRAINT vr_kind_chk CHECK (
        kind IN ('social_account', 'mailing_list', 'analytics_property', 'github_repo', 'webpage', 'domain')
    );

ALTER TABLE plugin_ventures.venture_resources
    DROP CONSTRAINT IF EXISTS vr_provider_chk;
ALTER TABLE plugin_ventures.venture_resources
    ADD CONSTRAINT vr_provider_chk CHECK (
        (kind = 'social_account'    AND provider IN ('manual', 'x', 'linkedin', 'instagram', 'facebook', 'threads', 'bluesky', 'mastodon', 'tiktok', 'youtube'))
     OR (kind = 'mailing_list'      AND provider IN ('manual', 'mailchimp', 'ses'))
     OR (kind = 'analytics_property' AND provider IN ('manual', 'ga4', 'vercel', 'plausible'))
     OR (kind = 'github_repo'       AND provider IN ('manual', 'github'))
     OR (kind = 'webpage'           AND provider IN ('manual'))
     OR (kind = 'domain'            AND provider IN ('manual', 'godaddy', 'cyberfolks'))
    ) NOT VALID;
