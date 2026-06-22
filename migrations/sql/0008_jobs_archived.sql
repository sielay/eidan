-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Soft-archive for delegation jobs (#407): hide a settled job from the active board without deleting
-- it. Additive + nullable; the board filters `archived_at IS NULL` by default.
ALTER TABLE eidan.jobs ADD COLUMN IF NOT EXISTS archived_at timestamptz;
