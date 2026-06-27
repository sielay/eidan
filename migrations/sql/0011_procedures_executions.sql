-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Procedures execution history table

CREATE TABLE eidan.procedure_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    procedure_id uuid,
    procedure_name text NOT NULL,
    status text DEFAULT 'completed'::text NOT NULL,
    result jsonb,
    error text,
    duration_ms integer,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT procedure_executions_pkey PRIMARY KEY (id),
    CONSTRAINT procedure_executions_status_chk CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT procedure_executions_user_id_fkey FOREIGN KEY (user_id) REFERENCES eidan.users(id) ON DELETE CASCADE,
    CONSTRAINT procedure_executions_procedure_id_fkey FOREIGN KEY (procedure_id) REFERENCES eidan.knowledge(id) ON DELETE SET NULL
);

CREATE INDEX idx_procedure_executions_user_recent ON eidan.procedure_executions USING btree (user_id, created_at DESC);
CREATE INDEX idx_procedure_executions_procedure ON eidan.procedure_executions USING btree (procedure_id, created_at DESC);
