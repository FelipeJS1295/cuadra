import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  api: z.object({
    version: z.string(),
    uptimeSeconds: z.number(),
  }),
  database: z.object({
    connected: z.boolean(),
    serverTime: z.string().nullable(),
    version: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
