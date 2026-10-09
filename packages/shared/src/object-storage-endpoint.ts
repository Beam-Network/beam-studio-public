import { z } from "zod";

/**
 * The safe, reusable descriptor emitted by @beam/object-storage-endpoint.
 * It contains references and provider routing metadata only; credential
 * payloads and signed routes never use this shape.
 */
export const objectStorageEndpointDescriptorSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    provider: z.string().trim().min(1).max(160),
    bucket: z.string().trim().min(1).max(1024),
    objectKey: z.string().max(4096),
    sourceType: z.enum(["file", "directory"]).default("file"),
    region: z.string().trim().min(1).max(255).optional(),
    storageLocation: z.string().trim().min(1).max(64).optional(),
    endpointUrl: z.string().url().max(2048).optional(),
    credentialId: z.string().trim().min(1).max(160),
  })
  .strict();

export type ObjectStorageEndpointDescriptor = z.infer<
  typeof objectStorageEndpointDescriptorSchema
>;

/** Shown where a storage credential is added or edited. */
export const STORAGE_NETWORK_HINT =
  "Use credentials without IP or network restrictions: Beam transfers data from many networks.";

/** Told to agents and the assistant where they choose storage. */
export const UNRESTRICTED_STORAGE_CREDENTIALS_RULE =
  "Storage credentials must not be IP- or network-restricted.";
