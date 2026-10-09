import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  roomStorageProviderRouteTtlSeconds,
  roomStorageWorkerRouteBaseUrl,
  roomStorageSafeErrorCode,
  roomStorageSafeErrorMessage,
  roomStoragePendingStatus,
  roomStorageExecutionStatus,
  roomStorageTerminalFailure,
} from "./room-storage-transfer-manager.js";

test("adapter failure preserves Runtime coverage and cannot masquerade as user cancellation", () => {
  const deliveries = [
    { member_id: "done", state: "delivered", completed_chunks: 3 },
  ];
  const status = {
    publisher: {
      deliveries,
      room_transfer: { status: "cancelled", transfer_id: "publication" },
    },
  };
  const job = {
    status: "running",
    errorCode: "room_storage_final_identity_mismatch",
    errorMessage: "Final object identity mismatch.",
  };
  assert.equal(
    roomStorageExecutionStatus(status, job).publisher.room_transfer.status,
    "in_progress",
  );
  const failed = roomStorageExecutionStatus(status, {
    ...job,
    status: "failed",
  });
  assert.equal(failed.publisher.room_transfer.status, "failed");
  assert.equal(failed.publisher.room_transfer.error_code, job.errorCode);
  assert.deepEqual(failed.publisher.deliveries, deliveries);
  assert.equal(
    roomStorageExecutionStatus(status, {
      status: "cancelled",
      errorCode: null,
    }),
    status,
  );
  assert.equal(
    roomStorageExecutionStatus(status, {
      status: "cancelled",
      errorCode: "room_storage_cleanup_incomplete",
    }).publisher.room_transfer.status,
    "cancelled",
  );
});

test("successful Runtime coverage waits for verified storage finalization", () => {
  for (const terminal of ["completed", "partial"]) {
    const deliveries = [
      { member_id: "done", state: "delivered", completed_chunks: 21 },
    ];
    const status = {
      publisher: {
        state: terminal,
        deliveries,
        room_transfer: {
          status: terminal,
          ...(terminal === "completed" ? { full_delivery_verified: true } : {}),
          transfer_id: "publication",
          file: { chunk_count: 21 },
        },
      },
    };
    for (const phase of [
      "queued",
      "preparing",
      "running",
      "cancel_requested",
    ]) {
      const projected = roomStorageExecutionStatus(status, {
        status: phase,
        errorCode: null,
      });
      assert.equal(projected.publisher.state, "active");
      assert.equal(projected.publisher.room_transfer.status, "in_progress");
      assert.equal(projected.publisher.deliveries, deliveries);
      assert.deepEqual(projected.publisher.room_transfer.file, {
        chunk_count: 21,
      });
      assert.equal(status.publisher.room_transfer.status, terminal);
    }
    const uncertain = roomStorageExecutionStatus(status, {
      status: terminal,
      errorCode: "room_storage_cleanup_incomplete",
    });
    assert.equal(uncertain.publisher.room_transfer.status, "in_progress");
    assert.equal(
      roomStorageExecutionStatus(status, { status: terminal, errorCode: null }),
      status,
    );
    assert.equal(roomStorageExecutionStatus(status, null), status);
    const failed = roomStorageExecutionStatus(status, {
      status: "failed",
      errorCode: "room_storage_final_identity_mismatch",
    });
    assert.equal(failed.publisher.room_transfer.status, "failed");
    assert.equal(
      failed.publisher.room_transfer.error_code,
      "room_storage_final_identity_mismatch",
    );
  }
});

test("a completed storage job cannot promote unverified Core delivery", () => {
  for (const proof of [false, undefined]) {
    const status = {
      publisher: {
        state: "completed",
        room_transfer: { status: "completed", full_delivery_verified: proof },
      },
    };
    for (const job of [null, { status: "completed", errorCode: null }]) {
      const projected = roomStorageExecutionStatus(status, job);
      assert.equal(projected.publisher.state, "failed");
      assert.equal(projected.publisher.room_transfer.status, "failed");
      assert.equal(
        projected.publisher.room_transfer.error_code,
        "room_transfer_delivery_unverified",
      );
    }
  }
});

test("room storage provider routes outlive the room TTL and BeamCore freshness floor", () => {
  assert.equal(roomStorageProviderRouteTtlSeconds(60), 900);
  assert.equal(roomStorageProviderRouteTtlSeconds(600), 900);
  assert.equal(roomStorageProviderRouteTtlSeconds(601), 901);
  assert.equal(roomStorageProviderRouteTtlSeconds(3_600), 3_900);
});

test("room storage agent routes use the public HTTPS Studio API origin", () => {
  assert.equal(
    roomStorageWorkerRouteBaseUrl({
      env: {
        BEAM_STUDIO_API_URL: "http://tasks.beam-studio-api-jkdvt8:8787",
      },
      transferStudioUrl: "https://studio.example.test",
    }),
    "https://api.studio.example.test",
  );
  assert.equal(
    roomStorageWorkerRouteBaseUrl({
      env: {
        BEAM_STUDIO_PUBLIC_API_URL: "https://api.custom.example/",
        BEAM_STUDIO_API_URL: "http://tasks.beam-studio-api-jkdvt8:8787",
      },
      transferStudioUrl: "https://studio.example.test",
    }),
    "https://api.custom.example",
  );
  assert.throws(
    () =>
      roomStorageWorkerRouteBaseUrl({
        env: {
          BEAM_STUDIO_API_URL: "http://tasks.beam-studio-api-jkdvt8:8787",
        },
        transferStudioUrl: "http://localhost:3000",
      }),
    /room_storage_public_api_url_unavailable/,
  );
});

test("Hippius room storage uses the standard runtime capability window", () => {
  const source = readFileSync(
    new URL("./room-storage-transfer-manager.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /binding\.providerProfileId === "hippius"[\s\S]+multipart_part_last_modified: false[\s\S]+assignment_timeout_ms: 60_000/,
  );
});

test("room storage errors retain safe authoritative lifecycle codes", () => {
  assert.equal(
    roomStorageSafeErrorCode(new Error("room_storage_destination_exists")),
    "room_storage_destination_exists",
  );
  assert.equal(
    roomStorageSafeErrorCode({ code: "provider_transfer_failed" }),
    "provider_transfer_failed",
  );
  assert.equal(
    roomStorageSafeErrorCode(
      new Error(
        'Beam lifecycle request failed with 400: {"code":"transfer_plan_invalid","message":"source src_0 expires too soon"}',
      ),
    ),
    "transfer_plan_invalid",
  );
  assert.equal(
    roomStorageSafeErrorCode(
      new Error("https://signed.example.invalid/?secret=value"),
    ),
    "room_storage_transfer_failed",
  );
  assert.equal(
    roomStorageSafeErrorCode({
      code: "command_failed",
      message:
        'room storage route request failed: 409 Conflict {"error":"room_storage_source_mutated"}',
    }),
    "room_storage_source_mutated",
  );
  assert.equal(
    roomStorageSafeErrorCode({
      code: "command_failed",
      message:
        'room storage route request failed: 409 Conflict {"code":"request_error","error":"room_storage_source_mutated","statusCode":409}',
    }),
    "room_storage_source_mutated",
  );
});

test("room storage errors retain redacted diagnostic messages", () => {
  assert.equal(
    roomStorageSafeErrorMessage({
      code: "command_failed",
      message:
        "room storage provider upload failed: 403 <Error><Code>AccessDenied</Code><Message>policy denied</Message></Error>",
    }),
    "room storage provider upload failed: 403 <Error><Code>AccessDenied</Code><Message>policy denied</Message></Error>",
  );
  assert.equal(
    roomStorageSafeErrorMessage(
      new Error(
        "room storage route request failed: 500 https://signed.example.invalid/upload?X-Amz-Signature=abc route_token=secret-token",
      ),
    ),
    "room storage route request failed: 500 [redacted-url] route_token=[redacted]",
  );
});

test("pre-coordinator status reports bucket source and recipient failure evidence", () => {
  const status = roomStoragePendingStatus({
    publicationId: "btr_pub_test",
    status: "failed",
    file: null,
    transferId: null,
    errorCode: "transfer_plan_invalid",
    sourceMemberId: "btr_member_source",
    sourceLocator: { type: "bucket_object", objectKey: "source/file.bin" },
    targetMemberIds: ["btr_member_target"],
  });

  assert.deepEqual(status.publisher.source, {
    member_id: "btr_member_source",
    kind: "object_storage",
    locator: { type: "bucket_object", objectKey: "source/file.bin" },
  });
  assert.deepEqual(status.publisher.deliveries, [
    {
      member_id: "btr_member_target",
      state: "failed",
      completed_chunks: 0,
      protection: "unknown",
      unavailable_reason: "transfer_plan_invalid",
    },
  ]);
});

test("preparation status cannot invent completed recipient evidence", () => {
  const status = roomStoragePendingStatus({
    publicationId: "btr_pub_test",
    status: "completed",
    file: {
      size_bytes: 104857600,
      chunk_size_bytes: 41943040,
      chunk_count: 3,
      identity: "identity",
    },
    transferId: null,
    errorCode: null,
    sourceMemberId: "btr_member_source",
    sourceLocator: { type: "bucket_object", objectKey: "source/file.bin" },
    targetMemberIds: ["btr_member_target"],
  });

  assert.equal(status.publisher.state, "active");
  assert.equal(status.publisher.room_transfer.status, "pending");
  assert.equal(status.publisher.deliveries[0]?.state, "pending");
  assert.equal(status.publisher.deliveries[0]?.completed_chunks, 0);
  assert.equal(status.publisher.deliveries[0]?.protection, "unknown");
});

test("pre-coordinator status suppresses stale error codes outside failure states", () => {
  const status = roomStoragePendingStatus({
    publicationId: "btr_pub_test",
    status: "completed",
    file: {
      size_bytes: 1,
      chunk_size_bytes: 1,
      chunk_count: 1,
      identity: "identity",
    },
    transferId: "transfer-1",
    errorCode: "room_storage_transfer_failed",
    sourceMemberId: "btr_member_source",
    sourceLocator: { type: "bucket_object", objectKey: "source/file.bin" },
    targetMemberIds: ["btr_member_target"],
  });

  assert.equal(status.publisher.room_transfer.error_code, undefined);
  assert.equal(status.publisher.deliveries[0]?.unavailable_reason, undefined);
});

const accessDenied =
  "destination_access_denied: The destination storage refused Beam's requests (403 AccessDenied). Check that the credentials allow writes to this bucket and path and are not restricted to specific IP addresses or networks.";

test("a failed or partial Beam transfer leaves its error message verbatim on the job", () => {
  assert.deepEqual(roomStorageTerminalFailure("failed", accessDenied), {
    errorCode: "destination_access_denied",
    errorMessage: accessDenied,
  });
  assert.deepEqual(roomStorageTerminalFailure("partial", accessDenied), {
    errorCode: null,
    errorMessage: accessDenied,
  });
  assert.deepEqual(
    roomStorageTerminalFailure("failed", "Transfer expired before delivery."),
    {
      errorCode: "room_storage_transfer_failed",
      errorMessage: "Transfer expired before delivery.",
    },
  );
  assert.equal(
    roomStorageTerminalFailure("failed", "https://storage.example: refused")
      ?.errorCode,
    "room_storage_transfer_failed",
  );
  for (const terminal of ["completed", "cancelled"] as const)
    assert.equal(roomStorageTerminalFailure(terminal, accessDenied), null);
  for (const message of [null, undefined, "", "  "])
    assert.equal(roomStorageTerminalFailure("failed", message), null);

  const source = readFileSync(
    new URL("./room-storage-transfer-manager.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /roomStorageTerminalFailure\(\s*terminal,\s*status\.error_message,?\s*\)/,
  );
});

test("room clients read Beam's failure reason from room_transfer.error_message", () => {
  const runtime = (state: string) => ({
    publisher: {
      state,
      deliveries: [{ member_id: "target", state: "failed" }],
      room_transfer: { status: state, transfer_id: "publication" },
    },
  });
  const failed = roomStorageExecutionStatus(runtime("failed"), {
    status: "failed",
    errorCode: "destination_access_denied",
    errorMessage: accessDenied,
  });
  assert.equal(failed.publisher.room_transfer.status, "failed");
  assert.equal(
    failed.publisher.room_transfer.error_code,
    "destination_access_denied",
  );
  assert.equal(failed.publisher.room_transfer.error_message, accessDenied);

  const partial = roomStorageExecutionStatus(runtime("partial"), {
    status: "partial",
    errorCode: null,
    errorMessage: accessDenied,
  });
  assert.equal(partial.publisher.state, "partial");
  assert.equal(partial.publisher.room_transfer.status, "partial");
  assert.equal(partial.publisher.room_transfer.error_code, undefined);
  assert.equal(partial.publisher.room_transfer.error_message, accessDenied);

  const pending = roomStoragePendingStatus({
    publicationId: "btr_pub_test",
    status: "failed",
    file: null,
    transferId: "transfer-1",
    errorCode: "destination_access_denied",
    errorMessage: accessDenied,
    sourceMemberId: "btr_member_source",
    sourceLocator: { type: "bucket_object", objectKey: "source/file.bin" },
    targetMemberIds: ["btr_member_target"],
  });
  assert.equal(pending.publisher.room_transfer.error_message, accessDenied);
});
