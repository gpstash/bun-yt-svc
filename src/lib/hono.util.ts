import { HttpError } from '@/lib/http.lib';

/**
 * Return true when the error represents a client-aborted request.
 * - HttpError with code 'EABORT'
 * - DOMException/AbortError by name
 */
export function isClientAbort(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof HttpError && err.code === 'EABORT') return true;
  const name = (err as any)?.name as string | undefined;
  return name === 'AbortError' || name === 'DOMException';
}

export const STATUS_CLIENT_CLOSED_REQUEST = 499; // Nginx non-standard
