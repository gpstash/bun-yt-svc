import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set. Drizzle client will not be initialized.');
}

export const queryClient = DATABASE_URL
  ? postgres(DATABASE_URL, {
    prepare: true,
    max: 5,
    // Supported by postgres-js
    connect_timeout: 10,
    idle_timeout: 0,
    // Pool max connection lifetime (supported in recent versions)
    max_lifetime: 60 * 30 // 30 minutes
  })
  : undefined;

export const db = queryClient ? drizzle(queryClient) : undefined;
