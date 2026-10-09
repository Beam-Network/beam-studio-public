import assert from "node:assert/strict";
import test from "node:test";
import { abortRoomMultipartUpload } from "./room-multipart-cleanup.js";

const missing = (name: string) => Object.assign(new Error(name), { name });
const input = {
  destination: {
    provider: "r2" as const,
    bucket: "fixture",
    key: "object",
    access_key_id: "test-key",
    secret_access_key: "test-secret",
  },
  objectKey: "object",
  uploadId: "upload",
  metadata: { "beam-transfer-id": "execution" },
  signal: AbortSignal.timeout(5000),
};
const operations = {
  abortMultipartUpload: async () => {},
  listMultipartParts: async () => {
    throw missing("NoSuchUpload");
  },
  inspectDestinationObject: async () => {
    throw missing("NotFound");
  },
};

test("an existing HF object without metadata is uncertain cleanup, never a successful abort", async () => {
  await assert.rejects(
    abortRoomMultipartUpload(
      {
        ...input,
        destination: {
          ...input.destination,
          provider: "huggingface",
          endpoint_url: "https://s3.hf.co/team",
        } as any,
      },
      {
        ...operations,
        inspectDestinationObject: async () => ({
          size: 100,
          etag: "etag",
          versionId: undefined,
          metadata: {},
        }),
      },
    ),
    /room_storage_cleanup_incomplete/,
  );
});

test("abort is verified through upload absence", async () => {
  let calls = 0;
  await abortRoomMultipartUpload(input, {
    ...operations,
    listMultipartParts: async () => {
      if (++calls === 1) return [];
      throw missing("NoSuchUpload");
    },
  });
  assert.equal(calls, 2);
});

test("active uploads remain cleanup failures after bounded attempts", async () => {
  await assert.rejects(
    abortRoomMultipartUpload(input, {
      ...operations,
      listMultipartParts: async () => [],
    }),
    /room_storage_cleanup_incomplete/,
  );
});

test("a completed object from this execution is not reported as aborted", async () => {
  await assert.rejects(
    abortRoomMultipartUpload(input, {
      ...operations,
      inspectDestinationObject: async () => ({
        size: 100,
        etag: "etag",
        versionId: undefined,
        metadata: input.metadata,
      }),
    }),
    /room_storage_cleanup_incomplete/,
  );
});

test("an unrelated existing object is retained without claiming this upload completed", async () => {
  await abortRoomMultipartUpload(input, {
    ...operations,
    inspectDestinationObject: async () => ({
      size: 100,
      etag: "etag",
      versionId: undefined,
      metadata: { "beam-transfer-id": "earlier" },
    }),
  });
});
