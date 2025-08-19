-- Ensure custom schema exists
create schema if not exists "yt-svc";

-- Transcripts table
create table if not exists "yt-svc"."transcripts" (
  "video_id" text not null references "yt-svc"."videos"("id") on delete cascade on update cascade,
  "language" text not null,
  "segments" jsonb not null,
  "created_at" timestamp with time zone default now() not null,
  "updated_at" timestamp with time zone default now() not null,
  constraint transcripts_video_language_unique unique ("video_id", "language")
);

-- RLS 
alter table "yt-svc"."transcripts" enable row level security;
alter table "yt-svc"."transcripts" force row level security;

-- Drop old policies if exist
drop policy if exists "transcripts_select_all" on "yt-svc"."transcripts";
drop policy if exists "transcripts_insert_all" on "yt-svc"."transcripts";
drop policy if exists "transcripts_update_all" on "yt-svc"."transcripts";
drop policy if exists "transcripts_delete_all" on "yt-svc"."transcripts";

-- Revoke public
revoke all on table "yt-svc"."transcripts" from public;

-- Grants
grant usage on schema "yt-svc" to authenticated, service_role;
grant select on table "yt-svc"."transcripts" to authenticated;
grant all on table "yt-svc"."transcripts" to service_role;

-- Policies
create policy "transcripts_read_authenticated" on "yt-svc"."transcripts"
  for select
  to authenticated
  using (true);

create policy "transcripts_write_service" on "yt-svc"."transcripts"
  for all
  to service_role
  using (true)
  with check (true);

-- Indexes
create index if not exists transcripts_video_id_idx on "yt-svc"."transcripts" ("video_id");
create index if not exists transcripts_language_idx on "yt-svc"."transcripts" ("language");
create index if not exists transcripts_created_at_idx on "yt-svc"."transcripts" ("created_at");
