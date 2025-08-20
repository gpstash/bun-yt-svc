import { z } from 'zod';

export const SingleIdSchema = z.object({
  id: z.string().trim().min(1, 'Bad Request'),
});

export const BatchIdsSchema = z.object({
  ids: z.array(z.string().trim().min(1, 'Bad Request'))
    .min(1, 'ids must not be empty')
    .max(50, 'Max 50 ids per request'),
});

export type SingleIdInput = z.infer<typeof SingleIdSchema>;
export type BatchIdsInput = z.infer<typeof BatchIdsSchema>;
