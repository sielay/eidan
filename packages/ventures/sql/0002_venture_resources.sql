-- The M1 bridge (charles#14): external resources attached to a venture — social accounts,
-- mailing lists, analytics properties. Many resources -> one venture. Charles keeps only the
-- abstraction (which resource belongs to which venture); the data + credentials live outside
-- (Mailchimp / GA / the vendor), so external_ref is an opaque provider handle/id, never a secret.
-- Ported from the Alembic revision ventures20260609000002.

CREATE TABLE plugin_ventures.venture_resources (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    venture_id   uuid        NOT NULL REFERENCES plugin_ventures.ventures(id) ON DELETE CASCADE,
    user_id      uuid        NOT NULL,
    kind         text        NOT NULL,
    provider     text        NOT NULL,
    external_ref text        NOT NULL,
    label        text,
    status       text        NOT NULL DEFAULT 'active',
    metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vr_kind_chk CHECK (kind IN ('social_account', 'mailing_list', 'analytics_property')),
    CONSTRAINT vr_status_chk CHECK (status IN ('active', 'archived'))
);

CREATE INDEX idx_vr_venture ON plugin_ventures.venture_resources (venture_id);
CREATE INDEX idx_vr_user ON plugin_ventures.venture_resources (user_id);
-- The same external account isn't attached twice (per owner, while active).
CREATE UNIQUE INDEX uq_vr_provider_ref ON plugin_ventures.venture_resources (user_id, provider, external_ref) WHERE status = 'active';
