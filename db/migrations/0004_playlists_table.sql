-- Ensure custom schema exists
create schema if not exists "yt-svc";

-- Playlists table mirrors drizzle schema in src/db/schema.ts
create table if not exists "yt-svc"."playlists" (
  "id" text primary key not null,
  "title" text not null,
  "description" text not null,
  "subtitle" text,
  "author" jsonb not null,
  "video_count" bigint not null,
  "view_count" bigint not null,
  "last_updated" text,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null
);

-- Optional indexes
create index if not exists playlists_created_at_idx on "yt-svc"."playlists" ("created_at");
