-- SPDX-License-Identifier: AGPL-3.0-or-later

CREATE TABLE IF NOT EXISTS eidan.affiliate_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  program_name text NOT NULL,
  provider text NOT NULL,
  category text NOT NULL CHECK (category IN ('book', 'content', 'tech', 'other')),
  commission_rate numeric(5, 2),
  commission_currency text DEFAULT 'USD',
  link_format text NOT NULL CHECK (link_format IN ('url', 'api', 'pixel')),
  signup_url text,
  api_endpoint text,
  api_docs_url text,
  approval_status text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'active')),
  relevance_score numeric(3, 1) DEFAULT 0,
  content_types jsonb DEFAULT '[]'::jsonb,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT unique_user_program UNIQUE (user_id, program_name, deleted_at IS NULL) WHERE deleted_at IS NULL
);

CREATE INDEX IF NOT EXISTS idx_affiliate_programs_user ON eidan.affiliate_programs(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_programs_category ON eidan.affiliate_programs(category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_affiliate_programs_status ON eidan.affiliate_programs(approval_status) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS eidan.affiliate_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  program_id uuid NOT NULL REFERENCES eidan.affiliate_programs(id) ON DELETE CASCADE,
  credential_type text NOT NULL CHECK (credential_type IN ('api_key', 'affiliate_id', 'tracking_code', 'custom')),
  key_vault_key text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_program_type UNIQUE (user_id, program_id, credential_type)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_credentials_user ON eidan.affiliate_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_credentials_program ON eidan.affiliate_credentials(program_id);

CREATE TABLE IF NOT EXISTS eidan.affiliate_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  program_id uuid NOT NULL REFERENCES eidan.affiliate_programs(id) ON DELETE CASCADE,
  content_id text,
  content_type text NOT NULL CHECK (content_type IN ('video', 'article', 'post', 'podcast', 'book', 'other')),
  generated_link text NOT NULL,
  link_type text NOT NULL CHECK (link_type IN ('direct_url', 'api_based', 'tracking_pixel')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_affiliate_links_user ON eidan.affiliate_links(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_links_program ON eidan.affiliate_links(program_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_links_content ON eidan.affiliate_links(content_id);

CREATE TABLE IF NOT EXISTS eidan.affiliate_discovery_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  programs_found integer NOT NULL,
  new_programs integer NOT NULL,
  source text,
  metadata jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_affiliate_discovery_log_user ON eidan.affiliate_discovery_log(user_id, discovered_at);
