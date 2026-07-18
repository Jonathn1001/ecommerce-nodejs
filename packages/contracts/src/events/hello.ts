import { z } from "zod";

export const HELLO_CREATED = "hello.created" as const;

export const HelloCreatedPayloadSchema = z.object({
  helloId: z.string().min(1),
  name: z.string().min(1),
});

export type HelloCreatedPayload = z.infer<typeof HelloCreatedPayloadSchema>;
