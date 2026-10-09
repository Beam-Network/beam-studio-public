import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorRoomError } from "./coordinator-client.js";
import { retryableCoordinatorControlError } from "./room-storage-hybrid.js";
import {
  HYBRID_SCHEMA,
  storageManifest,
  storageRouteLifetime,
  validateStorageRouteRequest,
  verifyProviderParts,
  verifyFinalObject,
} from "./room-storage-hybrid.js";

test("finalization retains size and identity checks for providers without metadata readback", () => {
  const provider = {
    provider: "huggingface",
    endpoint_url: "https://s3.hf.co/team",
  } as any;
  const head = {
    size: 100,
    etag: "content-identity",
    metadata: {},
    versionId: undefined,
  };
  verifyFinalObject(provider, head, "operation", 100);
  assert.throws(
    () => verifyFinalObject(provider, { ...head, size: 99 }, "operation", 100),
    /identity_mismatch/,
  );
  assert.throws(
    () => verifyFinalObject(provider, { ...head, etag: "" }, "operation", 100),
    /identity_mismatch/,
  );
  for (const strict of [
    { provider: "r2" },
    { ...provider, endpoint_url: "https://custom.example" },
  ]) {
    assert.throws(
      () => verifyFinalObject(strict as any, head, "operation", 100),
      /identity_mismatch/,
    );
    verifyFinalObject(
      strict as any,
      { ...head, metadata: { "beam-room-operation-id": "operation" } },
      "operation",
      100,
    );
  }
});

test("worker route requests reject obsolete or widened authority", () => {
  const request = {
    schema_version: HYBRID_SCHEMA,
    lease_id: "lease",
    transfer_id: "publication",
    lane_id: "lane",
    attempt: 1,
    worker_id: "worker",
    chunk_index: 0,
    content_md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
  };
  assert.deepEqual(validateStorageRouteRequest(request), request);
  for (const patch of [
    { schema_version: "room-storage-transfer/v1" },
    { chunk_index: -1 },
    { attempt: 0 },
    { destination: "https://untrusted.example" },
    { worker_id: "" },
    { content_md5: "invalid" },
  ]) {
    assert.throws(() => validateStorageRouteRequest({ ...request, ...patch }));
  }
});

test("routes expire within both the publication and assignment", () => {
  const future = (seconds: number) =>
    new Date(Date.now() + seconds * 1000 + 500).toISOString();
  assert.equal(storageRouteLifetime(future(100), future(200)), 60);
  assert.equal(storageRouteLifetime(future(12), future(200)), 12);
  assert.equal(storageRouteLifetime(future(200), future(8)), 8);
  assert.throws(() => storageRouteLifetime(future(-1), future(100)), /expired/);
});

test("coordinator outages are retryable but permission and contract errors are terminal", () => {
  for (const status of [408, 429, 502, 503]) {
    assert.equal(
      retryableCoordinatorControlError(
        new CoordinatorRoomError("unavailable", status, "unavailable"),
      ),
      true,
    );
  }
  for (const status of [400, 401, 403, 404, 409]) {
    assert.equal(
      retryableCoordinatorControlError(
        new CoordinatorRoomError("rejected", status, "rejected"),
      ),
      false,
    );
  }
  assert.equal(
    retryableCoordinatorControlError(
      new CoordinatorRoomError(
        "too large",
        502,
        "coordinator_response_too_large",
      ),
    ),
    false,
  );
  assert.equal(
    retryableCoordinatorControlError(new Error("room_storage_source_mutated")),
    false,
  );
});

for (const loseOwnership of [false, true]) {
  test(
    `coordinator restart ${loseOwnership ? "stops on ownership loss" : "resumes the existing upload"}`,
    { timeout: 5000 },
    async () => {
      const job = preparedJob();
      const ownership = new AbortController();
      const saved: unknown[][] = [];
      let polls = 0,
        failures = 0,
        cancellations = 0;
      const adapter = new RoomStorageHybridAdapter(
        {
          query: async (_sql: string, values: unknown[]) => {
            saved.push(values);
            return { rows: [], rowCount: 1 };
          },
        } as any,
        {
          load: async () => null,
          provider: async () => ({
            provider: "s3",
            bucket: "bucket",
            key: "file",
            region: "us-east-1",
            access_key_id: "test",
            secret_access_key: "test",
          }),
          destination: async () => {
            throw Error("must retain prepared destination");
          },
          command: async () => {
            throw Error("must retain registered source");
          },
          currentStatus: async () => "running",
          recordFailure: async () => {
            failures++;
          },
          publicUrl: () => "https://adapter.example",
        },
      );
      await adapter.execute(
        job,
        {
          token: "fixture",
          client: {
            organizationObjectStatus: async () => {
              polls++;
              if (polls === 1) {
                if (loseOwnership) setTimeout(() => ownership.abort(), 10);
                throw new CoordinatorRoomError(
                  "coordinator restarting",
                  503,
                  "coordinator_unavailable",
                );
              }
              return {
                status: {
                  publisher: {
                    room_transfer: {
                      status: "completed",
                      full_delivery_verified: true,
                    },
                  },
                },
              };
            },
            organizationObjectExecution: async () => ({
              execution: {
                targets: [{ member_id: "bucket", state: "completed" }],
              },
            }),
            cancelOrganizationStorageTransfer: async () => {
              cancellations++;
            },
          },
        } as any,
        {},
        [],
        [{ id: "binding", resourceId: "resource" }],
        ownership.signal,
      );
      assert.equal(failures, 0);
      assert.equal(cancellations, 0);
      assert.equal(job.preparation?.targets[0]?.upload_id, "upload");
      assert.equal(job.publicationId, "publication");
      assert.equal(polls, loseOwnership ? 1 : 2);
      if (!loseOwnership)
        assert(saved.some((values) => values[1] === "completed"));
    },
  );
}

test("provider audits require exact accepted consecutive parts", () => {
  const file = {
    size_bytes: 100,
    chunk_size_bytes: 40,
    chunk_count: 3,
    identity: "source",
  };
  const receipts = [0, 1, 2].map((index) => ({
    chunk_index: index,
    part_number: index + 1,
    upload_id: "upload",
    lease_id: `lease-${index}`,
    etag: `part-${index}`,
    range_sha256: "a".repeat(64),
  }));
  const parts = receipts.map((receipt, index) => ({
    partNumber: receipt.part_number,
    etag: `"${receipt.etag}"`,
    size: index === 2 ? 20 : 40,
    uploadedAt: "2026-10-06T10:00:08.000Z",
  }));
  assert.ok(
    verifyProviderParts(file, { upload_id: "upload" }, receipts, parts).every(
      (part) => part.verified,
    ),
  );
  const audited = verifyProviderParts(file, { upload_id: "upload" },
    receipts.map(r => ({ ...r, uploaded_at: "2099-01-01T00:00:00Z" })), parts);
  assert.ok(audited.every(part => part.uploaded_at === "2026-10-06T10:00:08.000Z"));
  assert.equal(verifyProviderParts(file, { upload_id: "upload" }, receipts,
    parts.map(({ uploadedAt, ...part }) => part))[0]?.uploaded_at, undefined);
  assert.equal(verifyProviderParts(file, { upload_id: "upload" }, receipts,
    [{ ...parts[0]!, etag: "wrong" }])[0]?.uploaded_at, undefined);
  assert.equal(verifyProviderParts(file, { upload_id: "upload" }, receipts,
    [{ ...parts[0]!, etag: "wrong" }])[0]?.reason, "etag_mismatch");
  assert.equal(
    verifyProviderParts(
      file,
      { upload_id: "upload" },
      receipts,
      parts.slice(1),
    )[0]?.verified,
    false,
  );
  assert.equal(
    verifyProviderParts(file, { upload_id: "upload" }, receipts, [
      { ...parts[0]!, size: 39 },
    ])[0]?.verified,
    false,
  );
  assert.throws(
    () =>
      verifyProviderParts(file, { upload_id: "different" }, receipts, parts),
    /receipt_invalid/,
  );
  assert.throws(
    () =>
      verifyProviderParts(
        file,
        { upload_id: "upload" },
        [...receipts, receipts[0]!],
        parts,
      ),
    /receipt_invalid/,
  );
  assert.equal(
    storageManifest(file, receipts),
    storageManifest(file, [...receipts].reverse()),
  );
  assert.throws(
    () => storageManifest(file, receipts.slice(1)),
    /manifest_invalid/,
  );
});

import http from "node:http";
import {
  RoomStorageHybridAdapter,
  retryableProviderControlError,
  type HybridJob,
} from "./room-storage-hybrid.js";

test("transient provider control errors are retryable, identity failures are not", () => {
  for (const error of [
    { name: "TimeoutError" },
    { name: "AbortError" },
    { code: "ECONNRESET" },
    { $metadata: { httpStatusCode: 503 } },
  ])
    assert.equal(retryableProviderControlError(error), true);
  assert.equal(
    retryableProviderControlError(
      new Error("room_storage_final_identity_mismatch"),
    ),
    false,
  );
  assert.equal(
    retryableProviderControlError({ $metadata: { httpStatusCode: 403 } }),
    false,
  );
});

function preparedJob(): HybridJob {
  return {
    id: "job",
    organizationId: "org",
    leaseOwner: "owner",
    environmentTemplateKey: "dev",
    roomId: "room",
    channelId: "channel",
    publicationId: "publication",
    sourceMemberId: "source",
    sourceLocator: { type: "agent_path", path: "/fixtures/source" },
    targetMemberIds: ["bucket"],
    ttlSeconds: 300,
    allowPartial: false,
    coordinatorStarted: true,
    workflowRunId: "run",
    workflowStepRunId: "step",
    preparation: {
      schema: HYBRID_SCHEMA,
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      filename: "file",
      file: {
        size_bytes: 4,
        chunk_size_bytes: 4,
        chunk_count: 1,
        identity: "immutable",
      },
      sourceKind: "agent",
      sourceAgentId: "agent",
      targets: [
        {
          memberId: "bucket",
          bindingId: "binding",
          objectKey: "file",
          resource_id: "resource",
          operation_id: "operation",
          size_bytes: 4,
          upload_id: "upload",
        },
      ],
    },
  };
}

test(
  "cancellation interrupts a slow provider audit without waiting for provider response",
  { timeout: 10_000 },
  async () => {
    let auditing = false,
      auditDisconnected = false,
      revoked = false,
      aborted = false;
    const server = http.createServer((request, response) => {
      if (aborted && request.method === "GET") {
        response.writeHead(404, { "content-type": "application/xml" });
        response.end("<Error><Code>NoSuchUpload</Code></Error>");
        return;
      }
      if (request.method === "HEAD") {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "GET") {
        auditing = true;
        response.on("close", () => {
          auditDisconnected = true;
        });
        return;
      }
      if (request.method === "DELETE") {
        assert.equal(revoked, true);
        aborted = true;
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(500);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const queries: { sql: string; values: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, values: unknown[]) => {
        queries.push({ sql, values });
        return { rows: [{ id: "job" }], rowCount: 1 };
      },
    };
    const job = preparedJob();
    const coordinator = {
      token: "fixture-token",
      client: {
        cancelOrganizationStorageTransfer: async () => {
          revoked = true;
          return {};
        },
        organizationObjectStatus: async () => ({
          status: { publisher: { room_transfer: { status: "in_progress" } } },
        }),
        organizationObjectExecution: async () => ({
          execution: {
            targets: [
              {
                member_id: "bucket",
                state: "pending",
                provider_results: [{ chunk_index: 0 }],
              },
            ],
          },
        }),
      },
    };
    const address = server.address() as { port: number };
    const adapter = new RoomStorageHybridAdapter(pool as any, {
      load: async () => null,
      provider: async () => ({
        provider: "s3",
        bucket: "bucket",
        key: "file",
        region: "us-east-1",
        access_key_id: "test",
        secret_access_key: "test",
        endpoint_url: `http://127.0.0.1:${address.port}`,
      }),
      destination: async () => {
        throw Error("unexpected destination preparation");
      },
      command: async () => {
        throw Error("unexpected agent command");
      },
      currentStatus: async () => (auditing ? "cancel_requested" : "running"),
      recordFailure: async () => {},
      publicUrl: () => "https://adapter.example",
    });
    try {
      await adapter.execute(
        job,
        coordinator as any,
        {},
        [],
        [{ id: "binding", resourceId: "resource" }],
        new AbortController().signal,
      );
      assert.equal(revoked, true);
      assert.equal(aborted, true);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(auditDisconnected, true);
      assert.ok(
        queries.some(
          (query) =>
            query.sql.includes("ELSE 'cancelled' END") &&
            query.sql.includes("lease_owner=$3"),
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

test("lost job ownership never cancels the replacement publication or creates uploads", async () => {
  const job = preparedJob();
  const queries: string[] = [];
  let cancelled = false;
  const adapter = new RoomStorageHybridAdapter(
    {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as any,
    {
      load: async () => null,
      provider: async () => ({
        provider: "s3",
        bucket: "bucket",
        key: "file",
        access_key_id: "test",
        secret_access_key: "test",
        region: "us-east-1",
      }),
      destination: async () => {
        throw Error("unexpected");
      },
      command: async () => {
        throw Error("unexpected");
      },
      currentStatus: async () => "running",
      recordFailure: async () => {},
      publicUrl: () => "https://adapter.example",
    },
  );
  await adapter.execute(
    job,
    {
      client: {
        cancelOrganizationStorageTransfer: async () => {
          cancelled = true;
        },
      },
    } as any,
    {},
    [],
    [{ id: "binding", resourceId: "resource" }],
    new AbortController().signal,
  );
  assert.equal(cancelled, false);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /lease_owner=\$4/);
});

test("failure cleanup retains completed recipients and the original provider error", async () => {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url?.split("?")[0]}`);
    if (request.method === "DELETE") {
      response.writeHead(204).end();
    } else if (request.method === "GET") {
      response.writeHead(404, { "content-type": "application/xml" });
      response.end("<Error><Code>NoSuchUpload</Code></Error>");
    } else {
      response
        .writeHead(200, {
          "content-length": "4",
          etag: '"etag"',
          "x-amz-meta-beam-room-operation-id": "operation",
        })
        .end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const job = preparedJob();
  job.preparation!.targets.push({
    ...job.preparation!.targets[0]!,
    memberId: "done",
    operation_id: "done-operation",
    objectKey: "done",
  });
  const cause = new Error("room_storage_final_identity_mismatch");
  let recorded = false,
    revoked = false;
  const adapter = new RoomStorageHybridAdapter(
    { query: async () => ({ rows: [], rowCount: 1 }) } as any,
    {
      load: async () => null,
      provider: async (_org, _binding, key) => ({
        provider: "s3",
        bucket: "fixture",
        key,
        region: "us-east-1",
        access_key_id: "test",
        secret_access_key: "test",
        endpoint_url: `http://127.0.0.1:${address.port}`,
        force_path_style: true,
      }),
      destination: async () => {
        throw new Error("unexpected");
      },
      command: async () => {
        throw new Error("unexpected");
      },
      currentStatus: async () => {
        throw cause;
      },
      recordFailure: async (_job, error) => {
        assert.equal(error, cause);
        recorded = true;
      },
      publicUrl: () => "https://adapter.example",
    },
  );
  try {
    await assert.rejects(
      adapter.execute(
        job,
        {
          token: "test",
          client: {
            cancelOrganizationStorageTransfer: async () => {
              assert.equal(recorded, true);
              revoked = true;
            },
            organizationObjectExecution: async () => ({
              execution: {
                targets: [{ member_id: "done", state: "completed" }],
              },
            }),
          },
        } as any,
        {},
        [],
        [{ id: "binding", resourceId: "resource" }],
        new AbortController().signal,
      ),
      (error: any) => {
        assert.equal(error, cause);
        assert.equal(Reflect.get(error, "cleanupIncomplete"), true);
        return true;
      },
    );
    assert.equal(revoked, true);
    assert.deepEqual(requests, [
      "DELETE /fixture/file",
      "GET /fixture/file",
      "HEAD /fixture/file",
      "GET /fixture/file",
      "HEAD /fixture/file",
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("registers an agent source before starting the coordinator transfer", async () => {
  const job = { ...preparedJob(), coordinatorStarted: false };
  const calls: string[] = [];
  const adapter = new RoomStorageHybridAdapter(
    {
      query: async (sql: string) => ({
        rows: [],
        // Hold the lease through ensureMultipart, then drop it right after the
        // coordinator start so execution unwinds as a benign ownership loss
        // instead of continuing into a real provider.
        rowCount: /coordinator_started=true/.test(sql) ? 0 : 1,
      }),
    } as any,
    {
      load: async () => null,
      provider: async () => ({
        provider: "s3",
        bucket: "bucket",
        key: "file",
        access_key_id: "test",
        secret_access_key: "test",
        region: "us-east-1",
      }),
      destination: async () => {
        throw Error("unexpected");
      },
      command: async (
        _job: HybridJob,
        _agentId: string,
        operation:
          | "room.storage.source.inspect"
          | "room.storage.source.register",
      ) => {
        calls.push(operation);
        return {};
      },
      currentStatus: async () => "running",
      recordFailure: async () => {},
      publicUrl: () => "https://adapter.example",
    },
  );

  await adapter.execute(
    job,
    {
      client: {
        startOrganizationStorageTransfer: async () => {
          calls.push("coordinator.start");
        },
      },
    } as any,
    {},
    [],
    [{ id: "binding", resourceId: "resource" }],
    new AbortController().signal,
  );

  assert.deepEqual(calls, [
    "room.storage.source.register",
    "coordinator.start",
  ]);
});

test("revoked artifact authority prevents source registration and Core start", async () => {
  const job: HybridJob = {
    ...preparedJob(),
    coordinatorStarted: false,
    sourceLocator: {
      type: "artifact_copy",
      assignmentId: "assignment",
      attempt: 1,
      port: "result",
      index: 0,
      artifactId: "artifact",
      copyId: "copy",
      sha256: `sha256:${"a".repeat(64)}`,
      sizeBytes: 4,
      retentionObligationId: "hold:0",
      requiredUntil: new Date(Date.now() + 86_400_000).toISOString(),
      storageMemberIds: ["bucket"],
    },
    preparation: { ...preparedJob().preparation!, targets: [] },
  };
  const calls: string[] = [];
  const adapter = new RoomStorageHybridAdapter(
    { query: async () => ({ rows: [], rowCount: 1 }) } as any,
    {
      load: async () => null,
      provider: async () => {
        throw new Error("unexpected provider");
      },
      destination: async () => {
        throw new Error("unexpected destination");
      },
      command: async () => {
        calls.push("register");
        return {};
      },
      authorize: async () => {
        throw new Error("room grant revoked");
      },
      currentStatus: async () => "running",
      recordFailure: async () => {},
      publicUrl: () => "https://adapter.example",
    },
  );
  await assert.rejects(
    adapter.execute(
      job,
      {
        client: {
          startOrganizationStorageTransfer: async () => {
            calls.push("Core start");
          },
        },
      } as any,
      {},
      [],
      [],
      new AbortController().signal,
    ),
    /room grant revoked/,
  );
  assert.deepEqual(calls, []);
});

test("cancellation reconciles provider completion after a lost coordinator acknowledgement", async (t) => {
  for (const proved of [true, false]) {
    await t.test(
      proved
        ? "durable manifest proves completion"
        : "missing proof remains retryable",
      async () => {
        const job = preparedJob();
        const receipts = [
          {
            chunk_index: 0,
            part_number: 1,
            upload_id: "upload",
            etag: "part",
            range_sha256: "a".repeat(64),
            lease_id: "lease",
          },
        ];
        const parts = [{ partNumber: 1, etag: "part", size: 4 }];
        const recorded: { sql: string; values: unknown[] }[] = [];
        const requests: string[] = [];
        const server = http.createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          if (request.method === "DELETE") {
            assert.match(request.url!, /uploadId=upload/);
            response
              .writeHead(404, { "content-type": "application/xml" })
              .end("<Error><Code>NoSuchUpload</Code></Error>");
          } else if (request.method === "GET") {
            response
              .writeHead(404, { "content-type": "application/xml" })
              .end("<Error><Code>NoSuchUpload</Code></Error>");
          } else if (request.method === "HEAD") {
            response
              .writeHead(200, {
                "content-length": "4",
                etag: '"final"',
                "x-amz-meta-beam-room-operation-id": "operation",
              })
              .end();
          } else {
            response.writeHead(500).end();
          }
        });
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const port = (server.address() as { port: number }).port;
        const adapter = new RoomStorageHybridAdapter(
          {
            query: async (sql: string, values: unknown[]) => {
              recorded.push({ sql, values });
              if (sql.includes("SELECT parts_json"))
                return {
                  rows: proved
                    ? [
                        {
                          parts_json: {
                            manifest: storageManifest(
                              job.preparation!.file,
                              receipts,
                            ),
                            receipts,
                            parts,
                          },
                        },
                      ]
                    : [],
                  rowCount: proved ? 1 : 0,
                };
              return { rows: [], rowCount: 1 };
            },
          } as any,
          {
            load: async () => null,
            provider: async () => ({
              provider: "s3",
              bucket: "fixture",
              key: "file",
              region: "us-east-1",
              access_key_id: "test",
              secret_access_key: "test",
              endpoint_url: `http://127.0.0.1:${port}`,
              force_path_style: true,
            }),
            destination: async () => {
              throw Error("unexpected");
            },
            command: async () => {
              throw Error("unexpected");
            },
            currentStatus: async () => "cancel_requested",
            recordFailure: async () => {
              throw Error("cancellation must not become a generic failure");
            },
            publicUrl: () => "https://adapter.example",
          },
        );
        try {
          await adapter.execute(
            job,
            {
              token: "test",
              client: {
                cancelOrganizationStorageTransfer: async () => {
                  throw new CoordinatorRoomError(
                    "lost acknowledgement",
                    503,
                    "coordinator_request_failed",
                  );
                },
                organizationObjectStatus: async () => ({
                  status: {
                    publisher: { room_transfer: { status: "cancelled" } },
                  },
                }),
                organizationObjectExecution: async () => ({
                  execution: {
                    targets: [
                      {
                        member_id: "bucket",
                        state: "cancelled",
                        provider_results: receipts,
                      },
                    ],
                  },
                }),
              },
            } as any,
            {},
            [],
            [{ id: "binding", resourceId: "resource" }],
            new AbortController().signal,
          );
          const settlement = recorded.find((query) =>
            query.sql.includes("status=CASE WHEN $4"),
          );
          assert.ok(settlement);
          assert.equal(settlement.values[3], !proved);
          assert.equal(
            settlement.values[1],
            proved ? null : "room_storage_cleanup_incomplete",
          );
          assert.equal(
            recorded.some((query) =>
              query.sql.includes("SET state='completed'"),
            ),
            proved,
          );
          assert.ok(requests.some((request) => request.startsWith("HEAD ")));
          assert.ok(
            !recorded.some((query) =>
              query.sql.includes("SET state='aborted'"),
            ),
          );
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      },
    );
  }
});

test("uncertain publication revocation remains pending without aborting provider uploads", async () => {
  const job = preparedJob();
  let settled: unknown[] = [];
  const adapter = new RoomStorageHybridAdapter(
    {
      query: async (_sql: string, values: unknown[]) => {
        settled = values;
        return { rows: [], rowCount: 1 };
      },
    } as any,
    {
      load: async () => null,
      provider: async () => ({
        provider: "s3",
        bucket: "fixture",
        key: "file",
        region: "us-east-1",
        access_key_id: "test",
        secret_access_key: "test",
        endpoint_url: "http://127.0.0.1:1",
      }),
      destination: async () => {
        throw Error("unexpected");
      },
      command: async () => {
        throw Error("unexpected");
      },
      currentStatus: async () => "cancel_requested",
      recordFailure: async () => {
        throw Error("unexpected failure");
      },
      publicUrl: () => "https://adapter.example",
    },
  );
  await adapter.execute(
    job,
    {
      token: "test",
      client: {
        cancelOrganizationStorageTransfer: async () => {
          throw Error("unavailable");
        },
        organizationObjectStatus: async () => ({
          status: { publisher: { room_transfer: { status: "in_progress" } } },
        }),
      },
    } as any,
    {},
    [],
    [{ id: "binding", resourceId: "resource" }],
    new AbortController().signal,
  );
  assert.equal(settled[1], "room_storage_cleanup_incomplete");
  assert.equal(settled[3], true);
});
