-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Per-job execution targeting (#407): pin a job to a node and/or override the model/provider it
-- runs under. All nullable — null target_node = any capable node may claim (the default), null
-- model/provider = the handler's defaults.
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS target_node text;
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS model       text;
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS provider    text;
-- Forward-compat seam for scoped capability grants (future): which secrets/tools a job may use, e.g.
-- {"secrets":["EIDAN_X_TOKEN"],"tools":["http","bash"]}. The runtime will scope the job's principal
-- to this when present; null = inherit the owner's full access (today's behaviour).
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS grants jsonb;
