-- Alter captions to support storing translations
-- Add target_language column (nullable)
alter table "yt-svc"."captions" add column if not exists "target_language" text;

-- Drop old unique constraint and create new composite including target_language
do $$ begin
  alter table "yt-svc"."captions" drop constraint if exists captions_video_language_unique;
exception when undefined_object then
  -- ignore
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
      where conname = 'captions_video_language_target_unique'
  ) then
    alter table "yt-svc"."captions"
      add constraint captions_video_language_target_unique unique ("video_id", "language", "target_language");
  end if;
end $$;

-- Index target_language for lookups
create index if not exists captions_target_language_idx on "yt-svc"."captions" ("target_language");
