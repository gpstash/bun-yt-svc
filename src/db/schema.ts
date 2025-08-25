import { text, boolean, integer, bigint, jsonb, timestamp, pgSchema, uniqueIndex } from 'drizzle-orm/pg-core';

// Use custom PostgreSQL schema: "yt-svc"
const ytSvc = pgSchema('yt-svc');

export const videos = ytSvc.table('videos', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  description: text('description').notNull(),
  thumbnails: jsonb('thumbnails').$type<Array<{ url: string; width: number; height: number }>>().notNull(),
  category: text('category').notNull(),
  tags: jsonb('tags').$type<string[]>().notNull(),
  duration: integer('duration').notNull(),
  channel: jsonb('channel').$type<{ id: string; name: string; url: string }>().notNull(),
  viewCount: bigint('view_count', { mode: 'number' }).notNull(),
  likeCount: bigint('like_count', { mode: 'number' }).notNull(),
  isPrivate: boolean('is_private').notNull(),
  isUnlisted: boolean('is_unlisted').notNull(),
  isFamilySafe: boolean('is_family_safe').notNull(),
  publishDateRaw: text('publish_date_raw').notNull(),
  publishDateFormatted: text('publish_date_formatted').notNull(),
  transcriptLanguages: jsonb('transcript_languages').$type<string[]>().notNull(),
  hasTranscripts: boolean('has_transcripts').notNull(),
  captionLanguages: jsonb('caption_languages').$type<Array<{ name: string; languageCode: string; rtl: boolean; isTranslatable: boolean }>>().notNull(),
  hasCaptions: boolean('has_captions').notNull(),
  captionTranslationLanguages: jsonb('caption_translation_languages').$type<Array<{ languageCode: string; name: string }>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Store full transcript payloads keyed by video + language
export const transcripts = ytSvc.table('transcripts', {
  videoId: text('video_id').notNull().references(() => videos.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  language: text('language').notNull(),
  segments: jsonb('segments').$type<Array<{ text: string; start: number; end: number }>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => {
  return {
    // Ensure one row per (videoId, language)
    uniq: uniqueIndex('transcripts_video_language_unique').on(t.videoId, t.language),
  };
});


// Store full caption payloads keyed by video + language, with segments and words
export const captions = ytSvc.table('captions', {
  videoId: text('video_id').notNull().references(() => videos.id, { onDelete: 'cascade', onUpdate: 'cascade' }),
  language: text('language').notNull(),
  targetLanguage: text('target_language'),
  segments: jsonb('segments').$type<Array<{ text: string; start: number; end: number }>>().notNull(),
  words: jsonb('words').$type<Array<{ text: string; start: number; end: number }>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => {
  return {
    uniq: uniqueIndex('captions_video_language_target_unique').on(t.videoId, t.language, t.targetLanguage),
  };
});


// Channels table to persist parsed channel info
export const channels = ytSvc.table('channels', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  url: text('url').notNull(),
  vanityUrl: text('vanity_url').notNull(),
  isFamilySafe: boolean('is_family_safe').notNull(),
  keywords: jsonb('keywords').$type<string[]>().notNull(),
  avatars: jsonb('avatars').$type<Array<{ url: string; width: number; height: number }> | { url: string; width: number; height: number }>().notNull(),
  thumbnails: jsonb('thumbnails').$type<Array<{ url: string; width: number; height: number }> | { url: string; width: number; height: number }>().notNull(),
  tags: jsonb('tags').$type<string[]>().notNull(),
  isUnlisted: boolean('is_unlisted').notNull(),
  subscriberCount: bigint('subscriber_count', { mode: 'number' }).notNull(),
  viewCount: bigint('view_count', { mode: 'number' }).notNull(),
  joinedDate: text('joined_date').notNull(),
  videoCount: bigint('video_count', { mode: 'number' }).notNull(),
  country: text('country').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Playlists table to persist lightweight playlist info
export const playlists = ytSvc.table('playlists', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  subtitle: text('subtitle'),
  author: jsonb('author').$type<{ id?: string; name?: string; url?: string }>().notNull(),
  videoCount: bigint('video_count', { mode: 'number' }).notNull(),
  viewCount: bigint('view_count', { mode: 'number' }).notNull(),
  lastUpdated: text('last_updated'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
