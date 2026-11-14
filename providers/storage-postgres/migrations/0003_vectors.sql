-- Embedding search with pgvector. The embedding column has no fixed
-- dimension so one table holds every model; vector_models pins each model to
-- one dimension, and the storage creates one partial HNSW index per model on
-- first use, for example:
--   create index ... using hnsw ((embedding::vector(1024)) vector_cosine_ops)
--   where model = 'bge-m3'
-- Vectors of different models are never compared.

create extension if not exists vector;

create table if not exists {{schema}}.vector_models (
  model text primary key,
  dimensions integer not null check (dimensions > 0),
  index_name text,
  created_at timestamptz not null default now()
);

create table if not exists {{schema}}.vectors (
  tenant_id text not null,
  model text not null,
  id text not null,
  video_id text not null,
  start_sec double precision not null,
  end_sec double precision not null,
  text text not null,
  embedding vector not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, model, id)
);

create index if not exists vectors_video_idx on {{schema}}.vectors (tenant_id, video_id, model);
