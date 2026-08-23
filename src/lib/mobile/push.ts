/**
 * MOB-003 — Push-subscription validation and persistence helpers.
 *
 * No actual push delivery is implemented; this is the safe groundwork that lets
 * a mobile client register a subscription and lets a future sender know whom to
 * target, without fabricating or replaying messages.
 */
import { z } from "zod";

export const PushSubscriptionSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type PushSubscriptionInput = z.infer<typeof PushSubscriptionSchema>;

export interface PushSubscriptionRow {
  id: string;
  company_id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
}

export function normalizeSubscription(input: unknown): PushSubscriptionInput {
  return PushSubscriptionSchema.parse(input);
}
