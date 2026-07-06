-- SPDX-License-Identifier: AGPL-3.0-or-later
-- CRM activities — audit trail for deals and contacts (calls, emails, notes, meetings, stage changes).

CREATE TABLE plugin_crm.activities (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid        NOT NULL,
    venture_id  uuid        NOT NULL,
    deal_id     uuid        REFERENCES plugin_crm.deals(id) ON DELETE SET NULL,
    contact_id  uuid        REFERENCES plugin_crm.contacts(id) ON DELETE SET NULL,
    kind        text        NOT NULL,
    body        text,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT crm_activities_kind_chk CHECK (kind IN ('call', 'email', 'note', 'meeting', 'stage_change'))
);

CREATE INDEX IF NOT EXISTS idx_crm_activities_user ON plugin_crm.activities (user_id, venture_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_deal ON plugin_crm.activities (deal_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_contact ON plugin_crm.activities (contact_id);
CREATE INDEX IF NOT EXISTS idx_crm_activities_occurred ON plugin_crm.activities (user_id, venture_id, occurred_at DESC);
