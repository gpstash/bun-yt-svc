-- Ensure custom schema exists
create schema if not exists "yt-svc";

-- Captions table
create table if not exists "yt-svc"."captions" (
  "video_id" text not null references "yt-svc"."videos"("id") on delete cascade on update cascade,
  "language" text not null,
  "target_language" text,
  "segments" jsonb not null,
  "words" jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint captions_video_language_target_unique unique ("video_id", "language", "target_language")
);

-- RLS 
alter table "yt-svc"."captions" enable row level security;
alter table "yt-svc"."captions" force row level security;

-- Drop old policies if exist
drop policy if exists "captions_select_all" on "yt-svc"."captions";
drop policy if exists "captions_insert_all" on "yt-svc"."captions";
drop policy if exists "captions_update_all" on "yt-svc"."captions";
drop policy if exists "captions_delete_all" on "yt-svc"."captions";

-- Revoke public
revoke all on table "yt-svc"."captions" from public;

-- Grants
-- grant usage on schema "yt-svc" to authenticated, service_role;
-- grant select on table "yt-svc"."captions" to authenticated;
-- grant all on table "yt-svc"."captions" to service_role;

-- -- Policies
-- create policy "captions_read_authenticated" on "yt-svc"."captions"
--   for select
--   to authenticated
--   using (true);

-- create policy "captions_write_service" on "yt-svc"."captions"
--   for all
--   to service_role
--   using (true)
--   with check (true);

-- Indexes
create index if not exists captions_video_id_idx on "yt-svc"."captions" ("video_id");
create index if not exists captions_language_idx on "yt-svc"."captions" ("language");
create index if not exists captions_target_language_idx on "yt-svc"."captions" ("target_language");
create index if not exists captions_created_at_idx on "yt-svc"."captions" ("created_at");
