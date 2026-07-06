-- SPDX-License-Identifier: AGPL-3.0-or-later
-- CRM contacts — venture-scoped contact records with basic metadata.

CREATE TABLE plugin_crm.contacts (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    venture_id  uuid        NOT NULL,
    name        text        NOT NULL,
    email       text,
    phone       text,
    company     text,
    role        text,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    deleted_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_user ON plugin_crm.contacts (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_venture ON plugin_crm.contacts (venture_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON plugin_crm.contacts (user_id, email) WHERE deleted_at IS NULL AND email IS NOT NULL;
