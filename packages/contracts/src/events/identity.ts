import { z } from "zod";

export const IDENTITY_USER_REGISTERED = "identity.user_registered" as const;

// Carries the email because the intended consumer is a welcome-email sender. No consumer
// exists yet (Phase 6 emits only) — and the no-PII-in-logs rule still applies: identity
// logs the userId, never the address.
export const UserRegisteredPayloadSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
});
export type UserRegisteredPayload = z.infer<typeof UserRegisteredPayloadSchema>;
