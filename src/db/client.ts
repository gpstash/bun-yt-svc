import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set. Drizzle client will not be initialized.');
}

export const queryClient = DATABASE_URL
  ? postgres(DATABASE_URL, { prepare: true, max: 5 })
  : undefined;

export const db = queryClient ? drizzle(queryClient) : undefined;
