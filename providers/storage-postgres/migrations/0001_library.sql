-- Library tables: saved contexts, their transcript segments with full-text
-- search, and ordered collections. Every row carries tenant_id and every
-- primary key starts with it, so tenants never see each other's rows.
-- {{schema}} is replaced with the quoted VID2CONTEXT_PG_SCHEMA at run time.

create table if not exists {{schema}}.videos (
  tenant_id text not null,
  id text not null,
  ref jsonb not null,
  title text not null,
  channel text,
  duration_sec double precision,
  origin text not null,
  language text not null,
  ts_config regconfig not null default 'simple',
  saved_at timestamptz not null default now(),
  context jsonb not null,
  primary key (tenant_id, id)
);

create index if not exists videos_saved_at_idx on {{schema}}.videos (tenant_id, saved_at desc, id desc);

create table if not exists {{schema}}.segments (
  tenant_id text not null,
  video_id text not null,
  idx integer not null,
  start_sec double precision not null,
  end_sec double precision not null,
  text text not null,
  speaker text,
  ts_config regconfig not null default 'simple',
  tsv tsvector generated always as (to_tsvector(ts_config, text)) stored,
  primary key (tenant_id, video_id, idx),
  foreign key (tenant_id, video_id) references {{schema}}.videos (tenant_id, id) on delete cascade
);

create index if not exists segments_tsv_idx on {{schema}}.segments using gin (tsv);

create table if not exists {{schema}}.collections (
  tenant_id text not null,
  id text not null,
  name text not null,
  description text,
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);

create index if not exists collections_updated_at_idx on {{schema}}.collections (tenant_id, updated_at desc);

create table if not exists {{schema}}.collection_items (
  tenant_id text not null,
  collection_id text not null,
  video_id text not null,
  position integer not null,
  added_at timestamptz not null default now(),
  primary key (tenant_id, collection_id, video_id),
  foreign key (tenant_id, collection_id) references {{schema}}.collections (tenant_id, id) on delete cascade
);

create index if not exists collection_items_video_idx on {{schema}}.collection_items (tenant_id, video_id);
