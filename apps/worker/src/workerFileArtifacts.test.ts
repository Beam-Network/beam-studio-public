import assert from "node:assert/strict";
import { test } from "node:test";
import { publishWorkerArtifact } from "./services/workerFileArtifacts.js";

const artifact = {
  type: "file",
  name: "result.txt",
  uri: "data:text/plain;base64,aGVsbG8=",
  mediaType: "text/plain",
  metadata: {
    port: "result",
    bytes: 5,
    sha256:
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
};

test("Runner publishes verified port bytes without persisting inline data twice", async () => {
  let content = "";
  const result = await publishWorkerArtifact(artifact, {
    config: {},
    inputs: {},
    fileServer: {
      async publishLocalFile(input) {
        content = Buffer.from(input.source as Buffer).toString("utf8");
        return {
          uri: "beam-worker://runner/export" as const,
          exportId: "export",
          workerId: "runner",
          size: 5,
          etag: "etag",
          mediaType: "text/plain",
          expiresAt: "2030-01-01T00:00:00.000Z",
          supportsRange: true as const,
        };
      },
    },
  });
  assert.equal(content, "hello");
  assert.equal(result.uri, "beam-worker://runner/export");
  assert.doesNotMatch(JSON.stringify(result), /aGVsbG8=/);
  assert.deepEqual(
    await publishWorkerArtifact(artifact, { config: {}, inputs: {} }),
    artifact,
  );
  await assert.rejects(
    publishWorkerArtifact(
      { ...artifact, metadata: { ...artifact.metadata, bytes: 4 } },
      {
        config: {},
        inputs: {},
        fileServer: {
          async publishLocalFile() {
            throw new Error("must not publish");
          },
        },
      },
    ),
    /integrity/,
  );
});
