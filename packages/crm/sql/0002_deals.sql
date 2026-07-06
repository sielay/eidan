-- SPDX-License-Identifier: AGPL-3.0-or-later
-- CRM deals — pipeline deals scoped to ventures, optionally linked to contacts.

CREATE TABLE plugin_crm.deals (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid        NOT NULL,
    venture_id      uuid        NOT NULL,
    contact_id      uuid        REFERENCES plugin_crm.contacts(id) ON DELETE SET NULL,
    name            text        NOT NULL,
    value_cents     bigint      NOT NULL DEFAULT 0,
    currency        text        NOT NULL DEFAULT 'GBP',
    stage           text        NOT NULL,
    position        integer     NOT NULL DEFAULT 0,
    expected_close  date,
    metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_user ON plugin_crm.deals (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_venture ON plugin_crm.deals (venture_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON plugin_crm.deals (venture_id, stage) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON plugin_crm.deals (contact_id) WHERE deleted_at IS NULL AND contact_id IS NOT NULL;
