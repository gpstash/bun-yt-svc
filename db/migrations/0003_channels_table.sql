-- Ensure custom schema exists
create schema if not exists "yt-svc";

-- Channels table mirrors drizzle schema in src/db/schema.ts
create table if not exists "yt-svc"."channels" (
  "id" text primary key not null,
  "title" text not null,
  "description" text not null,
  "url" text not null,
  "vanity_url" text not null,
  "is_family_safe" boolean not null,
  "keywords" jsonb not null,
  "avatar" jsonb not null,
  "thumbnail" jsonb not null,
  "tags" jsonb not null,
  "is_unlisted" boolean not null,
  "subscriber_count" text not null,
  "view_count" text not null,
  "joined_date" text not null,
  "video_count" text not null,
  "country" text not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- Optional: indexes for common queries
create index if not exists channels_created_at_idx on "yt-svc"."channels" ("created_at");
create index if not exists channels_title_fts_idx on "yt-svc"."channels"
  using gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("description", '')));
