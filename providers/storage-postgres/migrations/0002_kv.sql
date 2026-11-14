-- Small JSON state for features (watch lists, jobs, API keys, checkpoints).
-- The C collation makes key order bytewise and lets prefix scans use the
-- primary key index.

create table if not exists {{schema}}.kv (
  tenant_id text not null,
  key text collate "C" not null,
  value jsonb not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, key)
);

create index if not exists kv_expires_at_idx on {{schema}}.kv (expires_at) where expires_at is not null;
