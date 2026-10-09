import {
  abortMultipartUpload,
  inspectDestinationObject,
  listMultipartParts,
  type ProviderDestinationConfig,
} from "@beam-network/sdk";
import { providerReturnsObjectMetadata } from "@beam-studio/shared";

const providerOperations = {
  abortMultipartUpload,
  inspectDestinationObject,
  listMultipartParts,
};

// A successful Abort request alone does not prove cleanup: an in-flight part or
// Complete request may have won the race. Retain uncertain sessions for operators.
export async function abortRoomMultipartUpload(
  input: {
    destination: ProviderDestinationConfig;
    objectKey: string;
    uploadId: string;
    metadata: Record<string, string>;
    signal: AbortSignal;
  },
  operations = providerOperations,
): Promise<void> {
  const { destination, objectKey, uploadId, signal } = input;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      await operations.abortMultipartUpload(
        destination,
        objectKey,
        uploadId,
        signal,
      );
    } catch (error) {
      if ((error as Error)?.name !== "NoSuchUpload") throw error;
    }
    try {
      await operations.listMultipartParts(
        destination,
        objectKey,
        uploadId,
        signal,
      );
      continue;
    } catch (error) {
      if ((error as Error)?.name !== "NoSuchUpload") throw error;
    }
    let head: Awaited<ReturnType<typeof inspectDestinationObject>>;
    try {
      head = await operations.inspectDestinationObject(
        destination,
        objectKey,
        signal,
      );
    } catch (error) {
      if (["NotFound", "NoSuchKey"].includes((error as Error)?.name)) return;
      throw error;
    }
    if (
      !providerReturnsObjectMetadata(
        destination.provider,
        (destination as { endpoint_url?: string }).endpoint_url,
      ) ||
      Object.entries(input.metadata).every(
        ([key, value]) => head.metadata[key] === value,
      )
    ) {
      throw new Error("room_storage_cleanup_incomplete");
    }
    return;
  }
  throw new Error("room_storage_cleanup_incomplete");
}
