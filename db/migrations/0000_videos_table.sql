-- Ensure custom schema exists at the very beginning
create schema if not exists "yt-svc";

-- Base table
CREATE TABLE "yt-svc"."videos" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"description" text NOT NULL,
	"thumbnails" jsonb NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb NOT NULL,
	"duration" integer NOT NULL,
	"channel" jsonb NOT NULL,
	"view_count" bigint NOT NULL,
	"like_count" bigint NOT NULL,
	"is_private" boolean NOT NULL,
	"is_unlisted" boolean NOT NULL,
	"is_family_safe" boolean NOT NULL,
	"publish_date_raw" text NOT NULL,
	"publish_date_formatted" text NOT NULL,
	"transcript_languages" jsonb NOT NULL,
	"has_transcripts" boolean NOT NULL,
	"caption_languages" jsonb NOT NULL,
	"has_captions" boolean NOT NULL,
	"caption_translation_languages" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

  -- Enable Row Level Security (RLS)
  alter table "yt-svc"."videos" enable row level security;
  -- Enforce RLS even for table owner
  alter table "yt-svc"."videos" force row level security;

  -- Remove any prior permissive policies (idempotent in case of re-runs)
  drop policy if exists "videos_select_all" on "yt-svc"."videos";
  drop policy if exists "videos_insert_all" on "yt-svc"."videos";
  drop policy if exists "videos_update_all" on "yt-svc"."videos";
  drop policy if exists "videos_delete_all" on "yt-svc"."videos";

  -- Ensure public has no direct privileges
  revoke all on table "yt-svc"."videos" from public;

  -- Ensure Supabase roles can access schema and table (RLS still applies)
  -- grant usage on schema "yt-svc" to authenticated, service_role;
  -- grant select on table "yt-svc"."videos" to authenticated;
  -- grant all on table "yt-svc"."videos" to service_role;

  -- -- Allow only Supabase 'authenticated' role to read
  -- create policy "videos_read_authenticated" on "yt-svc"."videos"
  --   for select
  --   to authenticated
  --   using (true);

  -- -- Allow only Supabase 'service_role' to write (insert/update/delete)
  -- create policy "videos_write_service" on "yt-svc"."videos"
  --   for all
  --   to service_role
  --   using (true)
  --   with check (true);

-- Indexes
create index if not exists videos_created_at_idx on "yt-svc"."videos" ("created_at");
create index if not exists videos_publish_date_idx on "yt-svc"."videos" ("publish_date_formatted");
create index if not exists videos_view_count_idx on "yt-svc"."videos" ("view_count");
create index if not exists videos_channel_id_idx on "yt-svc"."videos" (("channel"->>'id'));
create index if not exists videos_tags_gin_idx on "yt-svc"."videos" using gin ("tags");
create index if not exists videos_fts_idx on "yt-svc"."videos"
using gin (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("description", '')));
