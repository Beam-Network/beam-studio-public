import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { retainArtifactObjectVersion } from "./room-artifact-object-retention.js";

test("object retention locks the exact version before accepting a durable copy", async () => {
  const requiredUntil = new Date(Date.now() + 86_400_000).toISOString();
  const requests: string[] = [];
  let locked = false;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push(
      `${request.method} ${url.pathname} ${url.searchParams.get("versionId")}`,
    );
    if (
      url.pathname !== "/bucket/artifact" ||
      url.searchParams.get("versionId") !== "version-1"
    ) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        assert.match(body, /<Mode>COMPLIANCE<\/Mode>/);
        assert.match(body, /<RetainUntilDate>/);
        locked = true;
        response.writeHead(200).end();
      });
      return;
    }
    response
      .writeHead(200, { "content-type": "application/xml" })
      .end(
        `<Retention xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Mode>${locked ? "COMPLIANCE" : "GOVERNANCE"}</Mode><RetainUntilDate>${requiredUntil}</RetainUntilDate></Retention>`,
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = {
      provider: "s3-compatible",
      bucket: "bucket",
      key: "artifact",
      region: "us-east-1",
      endpoint_url: `http://127.0.0.1:${port}`,
      force_path_style: true,
      access_key_id: "test",
      secret_access_key: "test",
    };
    await retainArtifactObjectVersion(
      provider,
      "artifact",
      "version-1",
      requiredUntil,
      AbortSignal.timeout(15_000),
    );
    assert.deepEqual(
      requests.map((request) => request.split(" ")[0]),
      ["GET", "PUT", "GET"],
    );
    assert.equal(locked, true);
    requests.length = 0;
    await retainArtifactObjectVersion(
      provider,
      "artifact",
      "version-1",
      requiredUntil,
      AbortSignal.timeout(15_000),
    );
    assert.deepEqual(
      requests.map((request) => request.split(" ")[0]),
      ["GET"],
    );
    await assert.rejects(
      retainArtifactObjectVersion(
        provider,
        "artifact",
        undefined,
        requiredUntil,
        AbortSignal.timeout(15_000),
      ),
      /retention_unavailable/,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
