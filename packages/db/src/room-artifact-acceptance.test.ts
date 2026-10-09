import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { ActionResult } from "@beam-studio/core";
import {
  assessRoomArtifactResult,
  freezeWorkflowArtifactInputPg,
} from "./room-artifact-acceptance.js";
import type { PgClient } from "./postgres.js";

const bytes = Buffer.from("artifact output");
const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const identity = {
  workflowRunId: "run",
  stepRunId: "step-run",
  taskId: "task",
  assignmentId: "assignment",
  attempt: 2,
};
const policy = {
  result: {
    roomId: "room",
    channelId: "objects",
    sourceMemberId: "source",
    targetMemberIds: ["recipient"],
    retentionObligationId: "hold",
    requiredUntil: "2030-01-02T00:00:00.000Z",
    availability: "temporary",
  },
};
const artifact = {
  type: "file",
  name: "result.txt",
  uri: `data:text/plain;base64,${bytes.toString("base64")}`,
  mediaType: "text/plain",
  metadata: {
    port: "result",
    bytes: bytes.length,
    sha256,
    ...identity,
  },
};
const entry = {
  artifactId: "artifact-1",
  port: "result",
  index: 0,
  sha256,
  sizeBytes: bytes.length,
  mediaType: "text/plain",
};
const location = {
  artifactId: "artifact-1",
  kind: "member",
  locator: "copy-1",
  memberId: "source",
  roomId: "room",
  channelId: "objects",
  sourceMemberId: "source",
  verifiedAt: "2029-01-01T00:00:00.000Z",
  verificationBasis: "local_hash",
  durableUntil: "2030-01-03T00:00:00.000Z",
  retentionObligationId: "hold:0",
};
const transfer = {
  artifactId: "artifact-1",
  destinationMemberId: "recipient",
  publicationId: "core-publication",
  transferId: "core-transfer",
  roomId: "room",
  channelId: "objects",
  sourceMemberId: "source",
  status: "completed",
  fullDeliveryVerified: true,
};
const recipientLocation = {
  ...location,
  locator: "core-transfer",
  memberId: "recipient",
  verificationBasis: "recipient_final_receipt",
  durableUntil: null,
  retentionObligationId: undefined,
};
const coreEvidence = [
  {
    artifactId: "artifact-1",
    publicationId: "core-publication",
    transferId: "core-transfer",
    destinationMemberId: "recipient",
    sha256,
    sizeBytes: bytes.length,
    verifiedAt: "2029-01-01T00:00:00.000Z",
    verificationBasis: "recipient_final_receipt" as const,
    contentHashVerified: true,
  },
];
const now = new Date("2029-01-02T00:00:00.000Z");

function result(overrides: Record<string, unknown> = {}): ActionResult {
  return {
    artifacts: [artifact],
    artifactManifest: {
      version: "room-artifact-manifest/v1",
      publicationId: "assignment",
      artifacts: [entry],
      locations: [location, recipientLocation],
      transfers: [transfer],
      ...overrides,
    } as ActionResult["artifactManifest"],
  };
}

test("acceptance requires retained availability and full frozen delivery", () => {
  const accepted = assessRoomArtifactResult(
    result(),
    policy,
    identity,
    now,
    coreEvidence,
  );
  assert.equal(accepted?.pendingReason, null);
  assert.equal(
    assessRoomArtifactResult(
      result({ locations: [recipientLocation] }),
      policy,
      identity,
      now,
      coreEvidence,
    )?.pendingReason,
    "artifact_availability_insufficient",
  );
  assert.equal(
    assessRoomArtifactResult(
      result({ transfers: [{ ...transfer, fullDeliveryVerified: false }] }),
      policy,
      identity,
      now,
      coreEvidence,
    )?.pendingReason,
    "artifact_transfer_incomplete",
  );
  assert.equal(
    assessRoomArtifactResult(
      result({ transfers: [] }),
      policy,
      identity,
      now,
      coreEvidence,
    )?.pendingReason,
    "artifact_transfer_incomplete",
  );
});

test("one Core transfer may verify distinct recipient copies", () => {
  const otherLocation = { ...recipientLocation, memberId: "other" };
  const otherTransfer = { ...transfer, destinationMemberId: "other" };
  const otherEvidence = { ...coreEvidence[0]!, destinationMemberId: "other" };
  const multi = result({
    locations: [location, recipientLocation, otherLocation],
    transfers: [transfer, otherTransfer],
  });
  const plan = {
    result: { ...policy.result, targetMemberIds: ["recipient", "other"] },
  };
  assert.equal(
    assessRoomArtifactResult(multi, plan, identity, now, [
      ...coreEvidence,
      otherEvidence,
    ])?.pendingReason,
    null,
  );
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result({ locations: [location, recipientLocation, recipientLocation] }),
        policy,
        identity,
        now,
        coreEvidence,
      ),
    /Location is duplicated/,
  );
});

test("temporary local copies require an explicit frozen policy and retention", () => {
  const local = location;
  const localPolicy = { result: { ...policy.result, targetMemberIds: [] } };
  assert.equal(
    assessRoomArtifactResult(
      result({ locations: [local], transfers: [] }),
      { result: { ...localPolicy.result, availability: "durable" } },
      identity,
      now,
    )?.pendingReason,
    "artifact_provider_evidence_unavailable",
  );
  assert.equal(
    assessRoomArtifactResult(
      result({ locations: [local], transfers: [] }),
      localPolicy,
      identity,
      now,
    )?.pendingReason,
    null,
  );
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result({
          locations: [{ ...local, retentionObligationId: "other" }],
          transfers: [],
        }),
        localPolicy,
        identity,
        now,
      ),
    /retention obligation/,
  );
});

test("durable acceptance requires independent provider readback and retention", () => {
  const durable = { result: { ...policy.result, availability: "durable" } };
  const storage = {
    ...recipientLocation,
    kind: "storage",
    durableUntil: null,
    verificationBasis: "provider_finalization",
  };
  const candidate = result({ locations: [location, storage] });
  const storageCoreEvidence = [
    {
      ...coreEvidence[0]!,
      verificationBasis: "provider_finalization" as const,
    },
  ];
  const proof = {
    artifactId: entry.artifactId,
    memberId: "recipient",
    locator: "core-transfer",
    sha256,
    sizeBytes: bytes.length,
    bucket: "bucket",
    objectKey: "key",
    versionId: "version",
    retainedUntil: "2030-01-03T00:00:00.000Z",
    verifiedAt: "2029-01-02T00:00:00.000Z",
  };
  assert.equal(
    assessRoomArtifactResult(
      candidate,
      durable,
      identity,
      now,
      storageCoreEvidence,
    )?.pendingReason,
    "artifact_provider_evidence_unavailable",
  );
  assert.equal(
    assessRoomArtifactResult(
      candidate,
      durable,
      identity,
      now,
      storageCoreEvidence,
      [proof],
    )?.pendingReason,
    null,
  );
  assert.equal(
    assessRoomArtifactResult(
      candidate,
      durable,
      identity,
      now,
      storageCoreEvidence,
      [{ ...proof, retainedUntil: "2030-01-01T00:00:00.000Z" }],
    )?.pendingReason,
    "artifact_provider_evidence_unavailable",
  );
  assert.equal(
    assessRoomArtifactResult(
      candidate,
      durable,
      identity,
      now,
      storageCoreEvidence,
      [{ ...proof, sha256: `sha256:${"0".repeat(64)}` }],
    )?.pendingReason,
    "artifact_provider_evidence_unavailable",
  );
});

test("a retained local CopyID can be frozen without a transfer row", async () => {
  const queries: string[] = [];
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return {
        rows: sql.includes("l.verification_basis='local_hash'")
          ? [
              {
                sha256,
                size_bytes: String(bytes.length),
                media_type: "text/plain",
                room_id: "room",
                channel_id: "objects",
                source_member_id: "source",
                member_id: "source",
                transfer_id: "copy-1",
              },
            ]
          : [],
      };
    },
  } as unknown as PgClient;
  const frozen = await freezeWorkflowArtifactInputPg(client, {
    manifestId: "manifest",
    artifactId: "artifact-1",
    destinationMemberId: "source",
  });
  assert.equal(frozen.location.transferId, "copy-1");
  assert.equal(frozen.location.memberId, "source");
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /o\.status='active'/);
  assert.match(queries[0]!, /l\.durable_until>now\(\)/);
});

test("changed bytes, provenance, destination, and attempt are rejected", () => {
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result({
          artifacts: [{ ...entry, sha256: `sha256:${"0".repeat(64)}` }],
        }),
        policy,
        identity,
        now,
      ),
    /bytes or provenance/,
  );
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result(),
        policy,
        { ...identity, attempt: 3 },
        now,
      ),
    /bytes or provenance/,
  );
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result({
          transfers: [{ ...transfer, destinationMemberId: "intruder" }],
        }),
        policy,
        identity,
        now,
      ),
    /unauthorized destination/,
  );
  assert.throws(
    () =>
      assessRoomArtifactResult(
        result({ publicationId: "another-assignment" }),
        policy,
        identity,
        now,
      ),
    /another assignment/,
  );
});
