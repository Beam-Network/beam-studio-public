import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ActionResult } from "@beam-studio/core";
import {
  artifactManifestCommitment,
  coreArtifactEvidence,
} from "./action-artifact-core-evidence.js";

const bytes = Buffer.from("recipient verified bytes");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const result: ActionResult = {
  artifacts: [
    {
      type: "file",
      name: "result.txt",
      mediaType: "text/plain",
      uri: `data:text/plain;base64,${bytes.toString("base64")}`,
      metadata: { port: "result", bytes: bytes.length, sha256 },
    },
  ],
  artifactManifest: {
    version: "room-artifact-manifest/v1",
    publicationId: "assignment",
    artifacts: [
      {
        artifactId: "artifact",
        port: "result",
        index: 0,
        sha256,
        sizeBytes: bytes.length,
        mediaType: "text/plain",
      },
    ],
    locations: [],
    transfers: [
      {
        artifactId: "artifact",
        destinationMemberId: "recipient",
        publicationId: "publication",
        transferId: "core-transfer",
        roomId: "room",
        channelId: "objects",
        sourceMemberId: "source",
        status: "completed",
        fullDeliveryVerified: true,
      },
    ],
  },
};
const status = {
  publisher: {
    preflight: {
      publication_id: "publication",
      room_id: "room",
      channel_id: "objects",
      publisher_member_id: "source",
    },
    room_transfer: {
      status: "completed",
      full_delivery_verified: true,
      transfer_id: "core-transfer",
    },
    deliveries: [
      {
        member_id: "recipient",
        state: "delivered",
        verified_at: "2029-01-01T00:00:00Z",
        verification_basis: "recipient_final_receipt",
      },
    ],
  },
};
const execution = {
  publication_id: "publication",
  transfer_id: "core-transfer",
  file_size_bytes: bytes.length,
  chunk_size_bytes: 8,
  chunk_count: Math.ceil(bytes.length / 8),
  targets: [
    {
      member_id: "recipient",
      state: "completed",
      finalization: {
        transfer_id: "core-transfer",
        target_member_id: "recipient",
        file_size_bytes: bytes.length,
        manifest_sha256: artifactManifestCommitment(bytes, 8),
      },
    },
  ],
};

test("Core final receipt binds every chunk to the accepted artifact bytes", () => {
  const evidence = coreArtifactEvidence(
    result,
    "publication",
    { status },
    { execution },
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.contentHashVerified, true);
  assert.equal(evidence[0]?.sha256, sha256);
});

test("partial, wrong recipient, or changed bytes cannot provide acceptance evidence", () => {
  assert.deepEqual(
    coreArtifactEvidence(
      result,
      "publication",
      {
        status: {
          ...status,
          publisher: {
            ...status.publisher,
            room_transfer: {
              ...status.publisher.room_transfer,
              full_delivery_verified: false,
            },
          },
        },
      },
      { execution },
    ),
    [],
  );
  assert.deepEqual(
    coreArtifactEvidence(
      result,
      "publication",
      { status },
      {
        execution: {
          ...execution,
          targets: [{ ...execution.targets[0], member_id: "other" }],
        },
      },
    ),
    [],
  );
  assert.deepEqual(
    coreArtifactEvidence(
      result,
      "publication",
      { status },
      {
        execution: {
          ...execution,
          targets: [
            {
              ...execution.targets[0],
              finalization: {
                ...execution.targets[0]!.finalization,
                manifest_sha256: "0".repeat(64),
              },
            },
          ],
        },
      },
    ),
    [],
  );
  assert.deepEqual(
    coreArtifactEvidence(
      {
        ...result,
        artifacts: [
          {
            ...result.artifacts![0]!,
            uri: "data:text/plain;base64,eA==",
          },
        ],
      },
      "publication",
      { status },
      { execution },
    ),
    [],
  );
});
