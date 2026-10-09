import { z } from "zod";
import { workflowRoomContextSchema } from "./workflow-room-context.js";
import { objectStorageEndpointDescriptorSchema } from "./object-storage-endpoint.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const json: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(json),
    z.record(json),
  ]),
);
const id = z.string().min(1).max(160);
const name = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine(
    (value) => !["constructor", "prototype", "__proto__"].includes(value),
    "Reserved binding name",
  );
const endpointUrl = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Endpoint bindings require an HTTP(S) URL without credentials, query parameters or a fragment");
export const workflowAgentBindingsSchema = z
  .record(name, z.object({ agentId: id }).strict())
  .refine(
    (value) => Object.keys(value).length <= 128,
    "At most 128 agent bindings are allowed",
  );
export const workflowResourceBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("credential"), credentialId: id }).strict(),
  z
    .object({
      kind: z.literal("storage"),
      endpoint: objectStorageEndpointDescriptorSchema.extend({
        endpointUrl: endpointUrl.optional(),
      }),
    })
    .strict(),
  z.object({ kind: z.literal("endpoint"), url: endpointUrl }).strict(),
  z
    .object({
      kind: z.literal("room-channel"),
      room: workflowRoomContextSchema,
      channelId: id,
    })
    .strict(),
  z.object({ kind: z.literal("data"), value: json }).strict(),
]);
export const workflowResourceBindingsSchema = z
  .record(name, workflowResourceBindingSchema)
  .refine(
    (value) => Object.keys(value).length <= 128,
    "At most 128 resource bindings are allowed",
  );
export const workflowReferencesSchema = z
  .object({
    agentBindings: workflowAgentBindingsSchema,
    resourceBindings: workflowResourceBindingsSchema,
  })
  .strict();
export type WorkflowReferences = z.infer<typeof workflowReferencesSchema>;
