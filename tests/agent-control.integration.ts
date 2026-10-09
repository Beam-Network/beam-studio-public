import { StudioSessionManager } from "../apps/api/src/auth/session-manager.js";
import { registerStudioRequestContext } from "../apps/api/src/auth/request-context.js";
import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  randomBytes,
  sign as signMessage,
} from "node:crypto";
import test from "node:test";
import Fastify from "fastify";
import pg from "pg";
import WebSocket from "ws";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  type PgPool,
} from "@beam-studio/db";
import { AgentControlRepository } from "../apps/api/src/agent-control/repository.js";
import { AgentGateway } from "../apps/api/src/agent-control/gateway.js";
import { registerAgentControlRoutes } from "../apps/api/src/agent-control/routes.js";

const maintenanceUrl =
  process.env.BEAM_TEST_POSTGRES_URL ?? "postgresql:///postgres";
const databaseName = `beam_agent_control_${randomBytes(6).toString("hex")}`;
const databaseUrl = databaseUrlForName(maintenanceUrl, databaseName);

let pool: PgPool;
let repository: AgentControlRepository;
let gateway: AgentGateway;
let studioOrigin: string;
let closeServer: () => Promise<void>;

test.before(async () => {
  await createDatabase();
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  pool = createPostgresPool(databaseUrl);
  await ensurePostgresMigrations(pool);
  repository = new AgentControlRepository(pool, "integration-token-secret");
  const server = Fastify({ logger: false });
  gateway = new AgentGateway(repository, {
    info(payload, message) {
      if (process.env.BEAM_TEST_DEBUG) console.error(message, payload);
    },
    warn(payload, message) {
      if (process.env.BEAM_TEST_DEBUG) console.error(message, payload);
    },
    error() {},
  });
  server.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    void reply.code(status).send({
      code: (error as { code?: string }).code ?? "integration_error",
      error: error.message,
      statusCode: status,
    });
  });
  const sessions = new StudioSessionManager();
  registerStudioRequestContext(server, sessions);
  await registerAgentControlRoutes(server, {
    repository,
    gateway,
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert.ok(address && typeof address !== "string");
  studioOrigin = `http://127.0.0.1:${address.port}`;
  closeServer = async () => {
    sessions.shutdown();
    await gateway.close();
    await server.close();
  };
});

test.after(async () => {
  await closeServer?.();
  await pool?.end();
  await dropDatabase();
});

test("enrollment, outbound session, fencing, redelivery, and remote close", async () => {
  const organizationId = "org_agent_integration";
  const enrollment = await repository.createEnrollment({
    organizationId,
    machineName: "integration-edge",
    createdById: "user_integration",
  });
  assert.match(enrollment.code, /^BM-/);
  assert.deepEqual(
    await repository.getEnrollment(organizationId, enrollment.enrollmentId),
    {
      enrollmentId: enrollment.enrollmentId,
      machineName: "integration-edge",
      status: "pending",
      expiresAt: enrollment.expiresAt,
      consumedAt: null,
      agentId: null,
      agentStatus: null,
    },
  );
  await assert.rejects(
    repository.getEnrollment("org_other", enrollment.enrollmentId),
    /Enrollment was not found/,
  );

  const identity = generateKeyPairSync("ed25519");
  const publicDer = identity.publicKey.export({ format: "der", type: "spki" });
  const canonicalAgentId = "agt_0123456789abcdef0123456789abcdef";
  const enrolledResponse = await fetch(`${studioOrigin}/agent-control/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: enrollment.code,
      publicKey: publicDer.subarray(publicDer.length - 32).toString("base64url"),
      machineName: "integration-edge",
      agentId: canonicalAgentId,
    }),
  });
  assert.equal(enrolledResponse.status, 201);
  const enrolled = (await enrolledResponse.json()) as {
    agentId: string;
    credential: string;
  };
  assert.equal(enrolled.agentId, canonicalAgentId);
  assert.ok(enrolled.credential);
  const consumedEnrollment = await repository.getEnrollment(
    organizationId,
    enrollment.enrollmentId,
  );
  assert.equal(consumedEnrollment.status, "consumed");
  assert.equal(consumedEnrollment.agentId, enrolled.agentId);
  assert.equal(consumedEnrollment.agentStatus, "offline");

  const replayEnrollment = await fetch(`${studioOrigin}/agent-control/v1/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: enrollment.code,
      publicKey: publicDer.subarray(publicDer.length - 32).toString("base64url"),
    }),
  });
  assert.equal(replayEnrollment.status, 404);
  assert.equal((await repository.listAgents("org_other")).length, 0);

  const first = await connectAgent(enrolled, identity.privateKey, 0, 0);
  const firstWelcome = await first.messages.nextType("server.welcome");
  assert.equal(firstWelcome.payload.sessionGeneration, 1);
  await eventually(async () => {
    assert.equal((await repository.listAgents(organizationId))[0]?.status, "online");
    assert.equal(
      (await repository.getEnrollment(organizationId, enrollment.enrollmentId))
        .agentStatus,
      "online",
    );
  });

  // A second authenticated outbound connection fences and replaces the first.
  const second = await connectAgent(enrolled, identity.privateKey, 0, 0);
  const secondWelcome = await second.messages.nextType("server.welcome");
  assert.equal(secondWelcome.payload.sessionGeneration, 2);
  const replaced = await first.messages.nextType("session.replaced");
  assert.equal(replaced.payload.sessionGeneration, 2);

  const create = await repository.createCommand({
    organizationId,
    agentId: enrolled.agentId,
    operation: "tunnel.create",
    payload: { kind: "http", target: "127.0.0.1:3000", public: false },
    idempotencyKey: "integration-create-tunnel",
    requestedById: "user_integration",
  });
  assert.equal(create.state, "queued");
  assert.equal(await gateway.dispatchAgent(enrolled.agentId), true);
  const delivered = await second.messages.nextType("command");
  assert.equal(delivered.payload.commandId, create.id);

  let tunnelEffects = 0;
  const agentJournal = new Map<string, Record<string, unknown>>();
  if (!agentJournal.has(delivered.payload.commandId)) {
    tunnelEffects += 1;
    agentJournal.set(delivered.payload.commandId, {
      endpoint: { id: "ep_integration", status: "active", target: "127.0.0.1:3000" },
    });
  }
  second.socket.send(agentEnvelope("command.accepted", {
    agentId: enrolled.agentId,
    commandId: create.id,
    sequence: 1,
    sessionGeneration: 2,
    state: "accepted",
  }));
  second.socket.send(agentEnvelope("command.progress", {
    agentId: enrolled.agentId,
    commandId: create.id,
    sequence: 2,
    sessionGeneration: 2,
    state: "running",
  }));
  await eventually(async () => {
    assert.equal((await repository.listCommands(organizationId, enrolled.agentId))[0]?.state, "running");
  });
  second.socket.terminate();
  await onceClosed(second.socket);

  const third = await connectAgent(enrolled, identity.privateKey, 1, 2);
  const thirdWelcome = await third.messages.nextType("server.welcome");
  assert.equal(thirdWelcome.payload.sessionGeneration, 3);
  const redelivered = await third.messages.nextType("command");
  assert.equal(redelivered.payload.commandId, create.id);
  if (!agentJournal.has(redelivered.payload.commandId)) tunnelEffects += 1;
  assert.equal(tunnelEffects, 1, "redelivery duplicated the tunnel side effect");
  third.socket.send(agentEnvelope("command.completed", {
    agentId: enrolled.agentId,
    commandId: create.id,
    sequence: 3,
    sessionGeneration: 3,
    state: "completed",
    result: agentJournal.get(create.id),
  }));
  await eventually(async () => {
    const command = (await repository.listCommands(organizationId, enrolled.agentId))[0];
    assert.equal(command?.state, "completed");
    assert.equal((command?.result?.endpoint as { id?: string })?.id, "ep_integration");
  });

  await assert.rejects(
    repository.applyCommandEvent(String(firstWelcome.payload.connectionId), "command.completed", {
      agentId: enrolled.agentId,
      commandId: create.id,
      sequence: 99,
      sessionGeneration: 1,
      state: "completed",
      result: {},
    }),
    /Agent authentication failed/,
  );

  const close = await repository.createCommand({
    organizationId,
    agentId: enrolled.agentId,
    operation: "endpoint.close",
    payload: { id: "ep_integration" },
    idempotencyKey: "integration-close-tunnel",
  });
  await gateway.dispatchAgent(enrolled.agentId);
  const closeDelivery = await third.messages.nextType("command");
  assert.equal(closeDelivery.payload.commandId, close.id);
  third.socket.send(agentEnvelope("command.completed", {
    agentId: enrolled.agentId,
    commandId: close.id,
    sequence: 4,
    sessionGeneration: 3,
    state: "completed",
    result: { endpoint: { id: "ep_integration", status: "closing" } },
  }));
  await eventually(async () => {
    assert.equal((await repository.listCommands(organizationId, enrolled.agentId))[0]?.state, "completed");
  });

  await repository.revokeAgent(organizationId, enrolled.agentId, "user_integration");
  await assert.rejects(issueToken(enrolled, identity.privateKey));
  await gateway.close();
});

async function connectAgent(
  enrolled: { agentId: string; credential: string },
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
  lastCommandSequence: number,
  lastEventSequence: number,
) {
  const accessToken = await issueToken(enrolled, privateKey);
  const socket = new WebSocket(
    studioOrigin.replace(/^http/, "ws") + "/agent-control/v1/connect",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const messages = new MessageQueue(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(agentEnvelope("agent.hello", {
    agentId: enrolled.agentId,
    bootId: `boot_${randomBytes(8).toString("hex")}`,
    daemonVersion: "integration",
    protocolMin: 1,
    protocolMax: 1,
    capabilities: ["endpoints", "rooms"],
    platform: process.platform,
    architecture: process.arch,
    machineName: "integration-edge",
    lastCommandSequence,
    lastEventSequence,
  }));
  return { socket, messages };
}

async function issueToken(
  enrolled: { agentId: string; credential: string },
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const credentialId = enrolled.credential.split(".")[0]!;
  const nonce = randomBytes(24).toString("base64url");
  const issuedAt = new Date().toISOString();
  const proof = `beam-studio-agent-token-v1\n${enrolled.agentId}\n${credentialId}\n${nonce}\n${issuedAt}`;
  const signature = signMessage(null, Buffer.from(proof), privateKey).toString("base64url");
  const response = await fetch(`${studioOrigin}/agent-control/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ credential: enrolled.credential, nonce, issuedAt, signature }),
  });
  if (!response.ok) throw new Error(`token request failed: ${response.status}`);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function agentEnvelope(type: string, payload: Record<string, unknown>) {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    messageId: `msg_${randomBytes(8).toString("hex")}`,
    sentAt: new Date().toISOString(),
    payload,
  });
}

class MessageQueue {
  private readonly queued: Array<Record<string, any>> = [];
  private readonly waiters: Array<(message: Record<string, any>) => void> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as Record<string, any>;
      const waiter = this.waiters.shift();
      if (waiter) waiter(message);
      else this.queued.push(message);
    });
  }

  async nextType(type: string) {
    const deadline = Date.now() + 5_000;
    const observed: string[] = [];
    while (Date.now() < deadline) {
      let message: Record<string, any>;
      try {
        message = await this.next(deadline - Date.now());
      } catch (error) {
        throw new Error(`timed out waiting for ${type}; observed ${observed.join(", ") || "nothing"}`, { cause: error });
      }
      if (message.type === type) return message;
      observed.push(String(message.type));
    }
    throw new Error(`timed out waiting for ${type}`);
  }

  private next(timeout: number) {
    const queued = this.queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("message timeout")), Math.max(timeout, 1));
      this.waiters.push((message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
  }
}

async function eventually(assertion: () => Promise<void>) {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

function onceClosed(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function createDatabase() {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await client.end();
  }
}

async function dropDatabase() {
  const client = new pg.Client({ connectionString: maintenanceUrl });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

function databaseUrlForName(url: string, name: string) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}
