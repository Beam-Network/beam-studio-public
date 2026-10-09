import Fastify from "fastify";
import { registerRoomMemberActionHost } from "./action-host.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import {
  createPostgresPool,
  ensurePostgresMigrations,
  WorkflowAuthorityUnavailableError,
  acquireWorkflowRunAuthorityPg,
  withPostgresTransaction,
  type PgPool,
} from "@beam-studio/db";
import { sandboxRpcMethodsForAction } from "@beam-studio/action-runtime";
import { RoomMemberActionAssignments } from "./action-assignments.js";
import { freezeRegistryArtifactUrl } from "../studio/registry-artifact-url.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RoomMemberAssignmentLifecycle } from "./action-assignment-lifecycle.js";
import { AgentControlRepository } from "./repository.js";
import { AgentGateway } from "./gateway.js";
import { RoomStorageTransferManager } from "./room-storage-transfer-manager.js";

const source = process.env.BEAM_TEST_POSTGRES_URL;
const database = `workflow_executor_${randomBytes(6).toString("hex")}`;
let pool: PgPool,
  maintenance: PgPool,
  repository: AgentControlRepository,
  assignments: RoomMemberActionAssignments,
  lifecycle: RoomMemberAssignmentLifecycle;
let authorityUnavailable = false;
const room = {
  environmentTemplateKey: "dev",
  roomId: `btr_room_${"a".repeat(26)}`,
};
const manifest = {
  name: "@test/compute",
  version: "1.0.0",
  runtime: { placements: ["room-members"] },
  execution: { runtime: "node", isolation: "sandboxed-esm" },
  permissions: [],
} as any;
const target = {
  kind: "room-member",
  memberIds: ["executor"],
  channelId: "requests",
  requesterMemberId: "requester",
};
const snapshot = {
  room: { room_id: room.roomId, state: "active" },
  memberships: [
    {
      room_id: room.roomId,
      member_id: "executor",
      kind: "agent",
      agent_id: "agent",
      state: "active",
    },
    {
      room_id: room.roomId,
      member_id: "requester",
      kind: "agent",
      agent_id: "initiator",
      state: "active",
    },
  ],
  channels: [
    {
      room_id: room.roomId,
      channel_id: "requests",
      kind: "request-reply",
      state: "active",
    },
  ],
  grants: [
    {
      room_id: room.roomId,
      channel_id: "requests",
      subject_type: "member",
      subject_id: "executor",
      actions: ["respond"],
      state: "active",
    },
    {
      room_id: room.roomId,
      channel_id: "requests",
      subject_type: "member",
      subject_id: "requester",
      actions: ["request"],
      state: "active",
    },
  ],
};
before(async () => {
  if (!source) return;
  process.env.BEAM_STUDIO_ALLOW_NON_TARGET_DATABASE = "true";
  maintenance = createPostgresPool(source);
  await maintenance.query(`CREATE DATABASE ${database}`);
  const url = new URL(source);
  url.pathname = `/${database}`;
  pool = createPostgresPool(url.toString());
  await ensurePostgresMigrations(pool);
  await pool.query(`INSERT INTO identity.organizations(id,slug,name) VALUES('org','org','Executor test');
    INSERT INTO workflow.templates(id,organization_id,name) VALUES('workflow','org','Compute');
    INSERT INTO workflow.steps(id,workflow_template_id,kind,action_package_name,action_version_range,position) VALUES('step','workflow','action','@test/compute','1.0.0',0);
    INSERT INTO agent_control.agents(id,organization_id,name,public_key,status,session_generation,capabilities_json) VALUES('agent','org','Member','test-public-key','online',1,'["action-execution/v1"]');
    INSERT INTO agent_control.sessions(id,agent_id,generation,boot_id,connection_owner) VALUES('session','agent',1,'boot','test');`);
  await pool.query(
    "UPDATE agent_control.agents SET action_execution_json=$1::jsonb WHERE id='agent'",
    [
      JSON.stringify({
        protocol: "action-execution/v1",
        processOwnership: "action-process-ownership/v1",
        runtimes: [{ name: "node", version: "22.20.0" }],
        isolations: ["sandboxed-esm"],
        hostOperations: sandboxRpcMethodsForAction(manifest),
        permissions: [],
        allowedActions: ["@test/compute"],
        capacity: 2,
        maxLeaseSeconds: 60,
      }),
    ],
  );
  repository = new AgentControlRepository(pool, [
    "executor-test-secret-with-sufficient-length",
  ]);
  const gateway = new AgentGateway(repository, {
    info() {},
    warn() {},
    error() {},
  });
  assignments = new RoomMemberActionAssignments(
    pool,
    repository,
    gateway,
    async () => {
      if (authorityUnavailable) throw new WorkflowAuthorityUnavailableError();
      return { room, roomSnapshot: snapshot };
    },
  );
  lifecycle = new RoomMemberAssignmentLifecycle(
    pool,
    assignments,
    repository,
    gateway,
  );
});
after(async () => {
  await pool?.end();
  if (maintenance) {
    await maintenance.query(`DROP DATABASE IF EXISTS ${database}`);
    await maintenance.end();
  }
});
async function fixture(name: string, step: Record<string, unknown> = {}) {
  await pool.query(
    "UPDATE agent_control.sessions SET heartbeat_at=now() WHERE id='session'",
  );
  await pool.query(
    `INSERT INTO execution.workflow_runs(id,organization_id,workflow_template_id,status,resolved_steps_json) VALUES($1,'org','workflow','running',$2::jsonb)`,
    [
      name,
      JSON.stringify([
        {
          id: "step",
          kind: "action",
          actionPackage: "@test/compute",
          config: {},
          executionTarget: target,
          executionRoom: room,
          manifestSnapshot: manifest,
          artifactChecksum: "sha256:" + "a".repeat(64),
          registryArtifactUrl: "https://registry.test/action.mjs",
          ...step,
        },
      ]),
    ],
  );
  await pool.query(
    `INSERT INTO execution.workflow_run_authority
      (workflow_run_id,owner_id,lease_expires_at)
     VALUES($1,'test',now()+interval '1 hour')`,
    [name],
  );
  await pool.query(
    `INSERT INTO execution.workflow_step_runs(id,workflow_run_id,workflow_step_id,action_package_name,resolved_version,checksum,source_registry,resolved_placement,status) VALUES($1,$2,'step','@test/compute','1.0.0','checksum','registry','room-members','queued')`,
    [`${name}-step`, name],
  );
  await pool.query(
    `INSERT INTO execution.workflow_tasks(id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum) VALUES($1,'org',$2,$3,'step','step','@test/compute','queued','checksum')`,
    [`${name}-task`, name, `${name}-step`],
  );
  return `${name}-task`;
}
async function row(id: string) {
  return (
    await pool.query(
      "SELECT * FROM execution.executor_assignments WHERE id=$1",
      [id],
    )
  ).rows[0]!;
}
function success(assignment: Record<string, any>) {
  return {
    operation: "action.invoke",
    state: "completed",
    session_generation: assignment.session_generation,
    payload_json: {
      authorityGeneration: Number(assignment.authority_generation),
    },
    result_json: {
      assignmentId: assignment.id,
      attempt: assignment.attempt,
      cleanupConfirmed: true,
      result: { outputs: { answer: 42 } },
    },
  };
}

test(
  "concurrent dispatch and uncertain delivery create one durable assignment and invocation",
  { skip: !source },
  async () => {
    const task = await fixture("concurrent");
    const [first, second] = await Promise.all([
      assignments.dispatch(task),
      assignments.dispatch(task),
    ]);
    assert.equal(first.assignmentId, second.assignmentId);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM agent_control.commands WHERE operation='action.invoke'",
        )
      ).rows[0]!.n,
      1,
    );
    const assignment = await row(first.assignmentId);
    assert.equal(assignment.attempt, 1);
    assert.equal(
      (await assignments.dispatch(task)).assignmentId,
      assignment.id,
    );
    const capability = (
      await pool.query(
        "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
        [assignment.id],
      )
    ).rows[0]!.authorization_token;
    await assignments.authorizeAssignment(assignment.id, capability);
    await assert.rejects(
      assignments.authorizeAssignment(assignment.id, "wrong"),
      /executor_capability_invalid/,
    );
    assert.equal(await lifecycle.settle(assignment, success(assignment)), true);
    await lifecycle.settle(assignment, success(assignment));
    assert.deepEqual(
      (
        await pool.query(
          "SELECT output_json FROM execution.workflow_step_runs WHERE id=$1",
          ["concurrent-step"],
        )
      ).rows[0]!.output_json,
      { answer: 42 },
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM execution.workflow_events WHERE workflow_run_id=$1",
          ["concurrent"],
        )
      ).rows[0]!.n,
      1,
    );
  },
);

test(
  "logical partitions keep queued task identities while plan admission is full",
  { skip: !source },
  async () => {
    const firstTask = await fixture("partition-admission");
    const secondTask = "partition-admission-task-2";
    await pool.query(
      `INSERT INTO execution.workflow_tasks
       (id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,task_kind,action_package_name,status,input_checksum,shard_index,shard_count,metadata_json)
       VALUES($1,'org','partition-admission','partition-admission-step','step','step-shard','@test/compute','queued','checksum',1,2,$2::jsonb)`,
      [
        secondTask,
        JSON.stringify({
          logicalPartition: {
            version: "logical/v1",
            index: 1,
            count: 2,
            eligibleMemberIds: ["executor"],
          },
        }),
      ],
    );
    await pool.query(
      `UPDATE execution.workflow_tasks SET task_kind='step-shard',shard_index=0,shard_count=2,metadata_json=$2::jsonb WHERE id=$1`,
      [
        firstTask,
        JSON.stringify({
          logicalPartition: {
            version: "logical/v1",
            index: 0,
            count: 2,
            eligibleMemberIds: ["executor"],
          },
        }),
      ],
    );
    await pool.query(
      `INSERT INTO execution.execution_plans
       (id,organization_id,workflow_run_id,workflow_step_run_id,workflow_step_id,mode,shard_count,metadata_json)
       VALUES('partition-admission-plan','org','partition-admission','partition-admission-step','step','map-reduce',2,'{"partitionPlanVersion":"logical/v1","maxParallelism":1}')`,
    );
    await pool.query(
      `INSERT INTO execution.execution_plan_shards
       (id,execution_plan_id,workflow_task_id,shard_index,shard_kind,status)
       VALUES('partition-admission-shard-1','partition-admission-plan',$1,0,'step-shard','planned'),
             ('partition-admission-shard-2','partition-admission-plan',$2,1,'step-shard','planned')`,
      [firstTask, secondTask],
    );
    const first = await assignments.dispatch(firstTask);
    await assert.rejects(
      assignments.dispatch(secondTask),
      /executor_partition_admission_full/,
    );
    assert.deepEqual(
      (
        await pool.query(
          "SELECT id,status,attempt_count FROM execution.workflow_tasks WHERE id=$1",
          [secondTask],
        )
      ).rows[0],
      { id: secondTask, status: "queued", attempt_count: 0 },
    );
    await pool.query(
      "UPDATE execution.executor_assignments SET state='completed',cleanup_confirmed_at=now() WHERE id=$1",
      [first.assignmentId],
    );
    await pool.query(
      "UPDATE execution.workflow_tasks SET status='completed' WHERE id=$1",
      [firstTask],
    );
    const second = await assignments.dispatch(secondTask);
    assert.equal((await row(second.assignmentId)).task_id, secondTask);
    await pool.query(
      "UPDATE execution.executor_assignments SET state='completed',cleanup_confirmed_at=now() WHERE id=$1",
      [second.assignmentId],
    );
  },
);

test(
  "a retry moves to another frozen eligible member without changing the task",
  { skip: !source },
  async () => {
    const taskId = await fixture("partition-retry");
    await pool.query(
      `INSERT INTO agent_control.agents
       (id,organization_id,name,public_key,status,session_generation,capabilities_json,action_execution_json)
       SELECT 'backup-agent',organization_id,'Backup',$1,status,session_generation,capabilities_json,action_execution_json
       FROM agent_control.agents WHERE id='agent'`,
      [randomBytes(32).toString("base64")],
    );
    await pool.query(
      `INSERT INTO agent_control.sessions(id,agent_id,generation,boot_id,connection_owner)
       VALUES('backup-session','backup-agent',1,'backup-boot','test')`,
    );
    await pool.query(
      `UPDATE execution.workflow_runs SET resolved_steps_json=jsonb_set(
        resolved_steps_json,'{0,executionTarget,memberIds}',
        '["executor","backup"]'::jsonb) WHERE id='partition-retry'`,
    );
    await pool.query(
      "UPDATE execution.workflow_tasks SET metadata_json=$2::jsonb WHERE id=$1",
      [
        taskId,
        JSON.stringify({
          logicalPartition: {
            version: "logical/v1",
            index: 0,
            count: 1,
            eligibleMemberIds: ["executor", "backup"],
          },
        }),
      ],
    );
    snapshot.memberships.push({
      room_id: room.roomId,
      member_id: "backup",
      kind: "agent",
      agent_id: "backup-agent",
      state: "active",
    });
    snapshot.grants.push({
      room_id: room.roomId,
      channel_id: "requests",
      subject_type: "member",
      subject_id: "backup",
      actions: ["respond"],
      state: "active",
    });
    let secondAssignmentId: string | null = null;
    try {
      const first = await assignments.dispatch(taskId);
      assert.equal((await row(first.assignmentId)).member_id, "executor");
      await pool.query(
        "UPDATE execution.executor_assignments SET state='failed',cleanup_confirmed_at=now() WHERE id=$1",
        [first.assignmentId],
      );
      await pool.query(
        `UPDATE execution.workflow_tasks SET status='retry_scheduled',claim_token=NULL,
         leased_by=NULL,locked_by=NULL,lease_expires_at=NULL,lock_expires_at=NULL WHERE id=$1`,
        [taskId],
      );
      snapshot.grants[0]!.state = "revoked";
      const second = await assignments.dispatch(taskId);
      secondAssignmentId = second.assignmentId;
      const assignment = await row(second.assignmentId);
      assert.equal(assignment.task_id, taskId);
      assert.equal(assignment.attempt, 2);
      assert.equal(assignment.member_id, "backup");
      assert.notEqual(second.assignmentId, first.assignmentId);
    } finally {
      if (secondAssignmentId)
        await pool.query(
          "UPDATE execution.executor_assignments SET state='completed',cleanup_confirmed_at=now() WHERE id=$1",
          [secondAssignmentId],
        );
      snapshot.grants[0]!.state = "active";
      snapshot.memberships.pop();
      snapshot.grants.pop();
    }
  },
);

test(
  "authority takeover fences an old result and waits for cleanup before retry",
  { skip: !source },
  async () => {
    const taskId = await fixture("authority-takeover");
    const first = await assignments.dispatch(taskId);
    const old = await row(first.assignmentId);
    assert.equal(Number(old.authority_generation), 1);
    await pool.query(
      `UPDATE execution.workflow_run_authority
       SET lease_expires_at=now()-interval '1 second'
       WHERE workflow_run_id=$1`,
      ["authority-takeover"],
    );
    const recovered = await withPostgresTransaction(pool, (client) =>
      acquireWorkflowRunAuthorityPg(
        client,
        "authority-takeover",
        "replacement",
      ),
    );
    assert.deepEqual(recovered, { generation: 2, takenOver: true });
    const previous = await row(first.assignmentId);
    assert.equal(previous.state, "reconciliation_required");
    assert.ok(previous.cancel_requested_at);
    const capability = (
      await pool.query(
        `SELECT authorization_token FROM execution.executor_assignment_capabilities
         WHERE assignment_id=$1`,
        [first.assignmentId],
      )
    ).rows[0]!.authorization_token;
    await assert.rejects(
      assignments.authorizeAssignment(first.assignmentId, capability),
      /executor_authority_fenced/,
    );
    assert.equal(
      (await assignments.dispatch(taskId)).assignmentId,
      first.assignmentId,
    );
    assert.equal(await lifecycle.settle(previous, success(previous)), true);
    const task = (
      await pool.query(
        "SELECT status,output_json FROM execution.workflow_tasks WHERE id=$1",
        [taskId],
      )
    ).rows[0]!;
    assert.equal(task.status, "retry_scheduled");
    assert.deepEqual(task.output_json, {});
    await pool.query(
      "UPDATE execution.workflow_tasks SET scheduled_at=now() WHERE id=$1",
      [taskId],
    );
    const next = await assignments.dispatch(taskId);
    assert.notEqual(next.assignmentId, first.assignmentId);
    const accepted = await row(next.assignmentId);
    assert.equal(Number(accepted.authority_generation), 2);
    assert.equal(await lifecycle.settle(accepted, success(accepted)), true);
  },
);

test(
  "revoked grants deny protected operations and prevent lease renewal",
  { skip: !source },
  async () => {
    const task = await fixture("revocation"),
      created = await assignments.dispatch(task),
      assignment = await row(created.assignmentId);
    const capability = (
      await pool.query(
        "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
        [assignment.id],
      )
    ).rows[0]!.authorization_token;
    snapshot.grants[0]!.state = "revoked";
    await assert.rejects(
      lifecycle.renew(assignment, capability),
      /respond grant/,
    );
    assert.equal(
      new Date((await row(assignment.id)).lease_expires_at).getTime(),
      new Date(assignment.lease_expires_at).getTime(),
    );
    snapshot.grants[0]!.state = "active";
    await lifecycle.requestCancellation(assignment.id);
    await assert.rejects(
      assignments.authorizeAssignment(assignment.id, capability),
      /expired_or_cancelled/,
    );
    await lifecycle.settle(assignment, success(assignment));
    assert.equal((await row(assignment.id)).state, "cancelled");
    assert.deepEqual(
      (
        await pool.query(
          "SELECT output_json FROM execution.workflow_step_runs WHERE id=$1",
          ["revocation-step"],
        )
      ).rows[0]!.output_json,
      {},
    );
  },
);

test(
  "authority outage cannot renew a lease, while confirmed revocation requests cancellation",
  { skip: !source },
  async () => {
    const task = await fixture("authority-cases");
    const created = await assignments.dispatch(task);
    const assignment = await row(created.assignmentId);
    try {
      authorityUnavailable = true;
      await lifecycle.tick();
      assert.equal((await row(assignment.id)).cancel_requested_at, null);
      assert.equal(
        new Date((await row(assignment.id)).lease_expires_at).getTime(),
        new Date(assignment.lease_expires_at).getTime(),
      );
      authorityUnavailable = false;
      snapshot.grants[0]!.state = "revoked";
      await lifecycle.tick();
      assert.ok((await row(assignment.id)).cancel_requested_at);
    } finally {
      authorityUnavailable = false;
      snapshot.grants[0]!.state = "active";
    }
  },
);

test(
  "dispatch freezes artifact references and later metadata changes cannot widen access",
  { skip: !source },
  async () => {
    const task = await fixture("artifact-plan");
    const sourceLocation = {
      manifestId: "accepted-manifest",
      artifactId: "source-artifact",
      sha256: `sha256:${"b".repeat(64)}`,
      sizeBytes: 3,
      mediaType: "application/octet-stream",
      location: {
        kind: "member",
        roomId: room.roomId,
        channelId: "objects",
        sourceMemberId: "requester",
        memberId: "executor",
        transferId: "copy",
      },
    };
    snapshot.channels.push({
      room_id: room.roomId,
      channel_id: "objects",
      kind: "object",
      state: "active",
    });
    snapshot.grants.push(
      {
        room_id: room.roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "requester",
        actions: ["publish"],
        state: "active",
      },
      {
        room_id: room.roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "executor",
        actions: ["subscribe"],
        state: "active",
      },
    );
    let assignment: Record<string, any> | undefined;
    try {
      await pool.query(
        `UPDATE execution.workflow_runs SET resolved_steps_json=jsonb_set(resolved_steps_json,'{0,manifestSnapshot,inputs}', '{"image":{"type":"artifact","required":true}}'::jsonb) WHERE id='artifact-plan'`,
      );
      await pool.query(
        "UPDATE agent_control.agents SET action_execution_json=action_execution_json||$1::jsonb WHERE id='agent'",
        [
          JSON.stringify({
            artifactPorts: "action-artifact-ports/v1",
            maxArtifactBytes: 131072,
          }),
        ],
      );
      await pool.query(
        "UPDATE execution.workflow_tasks SET metadata_json=$2::jsonb WHERE id=$1",
        [task, JSON.stringify({ artifactInputs: { image: [sourceLocation] } })],
      );
      const created = await assignments.dispatch(task);
      const current = await row(created.assignmentId);
      assignment = current;
      const command = (
        await pool.query(
          "SELECT payload_json FROM agent_control.commands WHERE id=$1",
          [current.command_id],
        )
      ).rows[0]!.payload_json;
      assert.equal(
        command.invocation.inputs.image.uri,
        "room-artifact:source-artifact",
      );
      assert.equal(command.invocation.storageReservationBytes, 131072);
      const capability = (
        await pool.query(
          "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
          [current.id],
        )
      ).rows[0]!.authorization_token;
      await pool.query(
        "UPDATE execution.workflow_tasks SET metadata_json=jsonb_set(metadata_json,'{artifactInputs,image,0,artifactId}','\"different\"') WHERE id=$1",
        [task],
      );
      await assert.rejects(
        assignments.authorizeAssignment(current.id, capability),
        /executor_artifact_plan_changed/,
      );
    } finally {
      if (assignment) {
        await lifecycle.requestCancellation(assignment.id);
        await lifecycle.settle(assignment, success(assignment));
      }
      snapshot.channels.pop();
      snapshot.grants.splice(-2);
    }
  },
);

test(
  "scoped loss report fences revocation and lease expiry, then marks the last copy unavailable",
  { skip: !source },
  async () => {
    const name = "artifact-loss";
    const task = await fixture(name);
    const frozen = {
      manifestId: "artifact-loss-manifest",
      artifactId: "artifact-loss-copy",
      sha256: `sha256:${"b".repeat(64)}`,
      sizeBytes: 3,
      mediaType: "application/octet-stream",
      location: {
        kind: "member",
        roomId: room.roomId,
        channelId: "objects",
        sourceMemberId: "requester",
        memberId: "executor",
        transferId: "delivered-copy",
      },
    };
    snapshot.channels.push({
      room_id: room.roomId,
      channel_id: "objects",
      kind: "object",
      state: "active",
    });
    snapshot.grants.push(
      {
        room_id: room.roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "requester",
        actions: ["publish"],
        state: "active",
      },
      {
        room_id: room.roomId,
        channel_id: "objects",
        subject_type: "member",
        subject_id: "executor",
        actions: ["subscribe"],
        state: "active",
      },
    );
    let assignment: Record<string, any> | undefined;
    const server = Fastify();
    try {
      await pool.query(
        `UPDATE execution.workflow_runs SET resolved_steps_json=jsonb_set(resolved_steps_json,'{0,manifestSnapshot,inputs}', '{"image":{"type":"artifact","required":true}}'::jsonb) WHERE id=$1`,
        [name],
      );
      await pool.query(
        "UPDATE agent_control.agents SET action_execution_json=action_execution_json||$1::jsonb WHERE id='agent'",
        [
          JSON.stringify({
            artifactPorts: "action-artifact-ports/v1",
            maxArtifactBytes: 131072,
          }),
        ],
      );
      await pool.query(
        "UPDATE execution.workflow_tasks SET metadata_json=$2::jsonb WHERE id=$1",
        [task, JSON.stringify({ artifactInputs: { image: [frozen] } })],
      );
      const created = await assignments.dispatch(task);
      const current = await row(created.assignmentId);
      assignment = current;
      const capability = (
        await pool.query(
          "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
          [current.id],
        )
      ).rows[0]!.authorization_token;
      await pool.query(
        `INSERT INTO execution.workflow_artifact_identities
         (artifact_id,workflow_run_id,task_id,sha256,size_bytes,media_type)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          frozen.artifactId,
          name,
          task,
          frozen.sha256,
          frozen.sizeBytes,
          frozen.mediaType,
        ],
      );
      await pool.query(
        `INSERT INTO execution.workflow_artifact_manifests
         (id,workflow_run_id,workflow_step_run_id,task_id,assignment_id,attempt,
          publication_id,artifact_identity_hash,artifacts_json,result_json,status)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'{}'::jsonb,'accepted')`,
        [
          frozen.manifestId,
          name,
          `${name}-step`,
          task,
          current.id,
          current.attempt,
          `${name}-publication`,
          "identity-hash",
          JSON.stringify([{ artifactId: frozen.artifactId }]),
        ],
      );
      await pool.query(
        `INSERT INTO execution.workflow_artifact_locations
         (manifest_id,artifact_id,kind,locator,member_id,room_id,channel_id,
          source_member_id,verified_at,verification_basis,durable_until)
         VALUES($1,$2,'member',$3,'executor',$4,'objects','requester',now(),
           'recipient_final_receipt',now()+interval '1 day')`,
        [
          frozen.manifestId,
          frozen.artifactId,
          frozen.location.transferId,
          room.roomId,
        ],
      );
      await pool.query(
        `INSERT INTO execution.workflow_artifact_transfers
         (manifest_id,artifact_id,destination_member_id,publication_id,transfer_id,
          room_id,channel_id,source_member_id,status,full_delivery_verified)
         VALUES($1,$2,'executor',$3,$4,$5,'objects','requester','completed',true)`,
        [
          frozen.manifestId,
          frozen.artifactId,
          `${name}-publication`,
          frozen.location.transferId,
          room.roomId,
        ],
      );
      registerRoomMemberActionHost(server, pool, assignments);
      const report = (
        payload: Record<string, unknown> = { reason: "missing" },
      ) =>
        server.inject({
          method: "POST",
          url: `/api/internal/executor-assignments/${current.id}/inputs/image/0/lost`,
          headers: { authorization: `Bearer ${capability}` },
          payload,
        });
      assert.equal(
        (await report({ reason: "missing", artifactId: "other" })).statusCode,
        403,
      );
      snapshot.grants.at(-1)!.state = "revoked";
      assert.equal((await report()).statusCode, 403);
      snapshot.grants.at(-1)!.state = "active";
      await pool.query(
        "UPDATE execution.executor_assignments SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [current.id],
      );
      assert.equal((await report()).statusCode, 403);
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM execution.workflow_artifact_locations WHERE manifest_id=$1",
            [frozen.manifestId],
          )
        ).rows[0]!.state,
        "available",
      );
      await pool.query(
        "UPDATE execution.executor_assignments SET lease_expires_at=now()+interval '1 minute' WHERE id=$1",
        [current.id],
      );
      await pool.query(
        "UPDATE execution.workflow_artifact_locations SET room_id='other-room' WHERE manifest_id=$1",
        [frozen.manifestId],
      );
      assert.equal((await report()).statusCode, 403);
      assert.equal(
        (
          await pool.query(
            "SELECT state FROM execution.workflow_artifact_locations WHERE manifest_id=$1",
            [frozen.manifestId],
          )
        ).rows[0]!.state,
        "available",
      );
      await pool.query(
        "UPDATE execution.workflow_artifact_locations SET room_id=$2 WHERE manifest_id=$1",
        [frozen.manifestId, room.roomId],
      );
      const lost = await report();
      assert.equal(lost.statusCode, 200, lost.body);
      assert.deepEqual(lost.json(), { recorded: true, status: "unavailable" });
      assert.deepEqual((await report({ reason: "corrupt" })).json(), {
        recorded: true,
        status: "unavailable",
      });
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM execution.workflow_artifact_manifests WHERE id=$1",
            [frozen.manifestId],
          )
        ).rows[0]!.status,
        "unavailable",
      );
    } finally {
      await server.close();
      if (assignment) {
        await lifecycle.requestCancellation(assignment.id);
        await lifecycle.settle(assignment, success(assignment));
      }
      snapshot.channels.pop();
      snapshot.grants.splice(-2);
    }
  },
);

test(
  "artifact storage jobs persist distinct output slots and fence an expired assignment",
  { skip: !source },
  async () => {
    const name = "artifact-storage-job";
    const task = await fixture(name);
    const created = await assignments.dispatch(task);
    const assignment = await row(created.assignmentId);
    const manager = new RoomStorageTransferManager(
      pool,
      repository,
      new AgentGateway(repository, {
        info() {},
        warn() {},
        error() {},
      }),
      { info() {}, warn() {} },
    );
    manager.stop();
    const publish = Reflect.get(manager, "enqueueJob").bind(manager) as (
      value: Record<string, unknown>,
    ) => Promise<Record<string, any>>;
    const requiredUntil = new Date(Date.now() + 900_000).toISOString();
    const base = {
      organizationId: "org",
      environmentTemplateKey: "dev",
      roomId: room.roomId,
      channelId: "objects",
      workflowRunId: name,
      workflowStepRunId: `${name}-step`,
      apiKeyId: "room-key",
      sourceMemberId: "executor",
      sourceLocator: {
        type: "artifact_copy",
        assignmentId: assignment.id,
        attempt: assignment.attempt,
        port: "result",
        index: 0,
        artifactId: "artifact",
        copyId: "copy",
        sha256: `sha256:${"a".repeat(64)}`,
        sizeBytes: 3,
        retentionObligationId: "hold:0",
        requiredUntil,
        storageMemberIds: ["bucket"],
      },
      targetMemberIds: ["bucket"],
      ttlSeconds: 900,
      allowPartial: false,
      publicationId: null,
      originKind: "workflow",
      originKey: `artifact:${assignment.id}:${assignment.attempt}:result:0:0`,
      initiatorAgentId: null,
      initiatorMemberId: null,
      assignmentFence: {
        assignmentId: assignment.id,
        attempt: assignment.attempt,
        agentId: assignment.executor_id,
      },
    };
    try {
      const first = await publish(base);
      assert.equal((await publish(base)).id, first.id);
      assert.ok(
        Math.floor((Date.parse(requiredUntil) - Date.now()) / 1000) <
          base.ttlSeconds,
      );
      const replay = await manager.enqueueArtifactCopy({
        organizationId: base.organizationId,
        environmentTemplateKey: base.environmentTemplateKey,
        roomId: base.roomId,
        channelId: base.channelId,
        workflowRunId: base.workflowRunId,
        workflowStepRunId: base.workflowStepRunId,
        roomApiKeyId: "revoked-room-key",
        sourceMemberId: base.sourceMemberId,
        sourceAgentId: assignment.executor_id,
        targetMemberIds: base.targetMemberIds,
        assignmentId: assignment.id,
        attempt: assignment.attempt,
        port: "result",
        index: 0,
        artifactId: "artifact",
        copyId: "copy",
        sha256: base.sourceLocator.sha256,
        sizeBytes: 3,
        retentionObligationId: "hold:0",
        requiredUntil,
        recoveryGeneration: 0,
        roomSnapshot: {},
      });
      assert.equal(replay.status, "queued");
      assert.deepEqual(replay.storageMemberIds, ["bucket"]);
      assert.equal(
        (
          await pool.query(
            "SELECT workflow_run_id,workflow_step_run_id,source_locator_json FROM studio.room_storage_transfer_jobs WHERE id=$1",
            [first.id],
          )
        ).rows[0]!.workflow_step_run_id,
        `${name}-step`,
      );
      await assert.rejects(
        publish({
          ...base,
          sourceLocator: { ...base.sourceLocator, copyId: "other" },
        }),
        /idempotency key/,
      );
      await pool.query(
        "UPDATE execution.executor_assignments SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
        [assignment.id],
      );
      await assert.rejects(
        publish({
          ...base,
          originKey: `artifact:${assignment.id}:${assignment.attempt}:result:1:0`,
        }),
        /no longer active/,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM studio.room_storage_transfer_jobs WHERE workflow_run_id=$1",
            [name],
          )
        ).rows[0]!.n,
        1,
      );
      const reported = [
        {
          transport: "hybrid",
          artifactId: "artifact",
          recoveryGeneration: 0,
          publicationId: first.publicationId,
          transferId: "",
          state: "prepared",
        },
      ];
      const confirmationInput = {
        organizationId: "org",
        assignmentId: assignment.id,
        attempt: assignment.attempt,
      };
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          reported,
        ),
        [],
      );
      await lifecycle.requestCancellation(assignment.id);
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          reported,
        ),
        [],
        "a known job without provider cleanup cannot be confirmed",
      );
      await pool.query(
        `UPDATE studio.room_storage_transfer_jobs
         SET status='cancelled',provider_cleanup_confirmed_at=now()
         WHERE id=$1`,
        [first.id],
      );
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          reported,
        ),
        [
          {
            artifactId: "artifact",
            recoveryGeneration: 0,
            publicationId: first.publicationId,
            transferId: "",
            state: "cancelled",
            cleanupConfirmed: true,
          },
        ],
      );
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          [{ ...reported[0], recoveryGeneration: 1, publicationId: "" }],
        ),
        [
          {
            artifactId: "artifact",
            recoveryGeneration: 1,
            publicationId: "",
            transferId: "",
            state: "cancelled",
            cleanupConfirmed: true,
          },
        ],
      );
      await pool.query(
        "UPDATE studio.room_storage_transfer_jobs SET status='completed',transfer_id='transfer-verified' WHERE id=$1",
        [first.id],
      );
      assert.deepEqual(
        await manager.waitForArtifactCopiesCancellation(
          assignment.id,
          assignment.attempt,
        ),
        { completedDelivery: true },
      );
      Reflect.set(manager, "artifactCopyResult", async () => ({
        status: "completed",
        transferId: "transfer-verified",
        fullDeliveryVerified: true,
      }));
      const completedReceipt = {
        ...reported[0],
        transferId: "transfer-verified",
        state: "running",
      };
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          [completedReceipt],
        ),
        [
          {
            artifactId: "artifact",
            recoveryGeneration: 0,
            publicationId: first.publicationId,
            transferId: "transfer-verified",
            state: "completed",
            cleanupConfirmed: true,
            fullDeliveryVerified: true,
          },
        ],
      );
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          [{ ...completedReceipt, transferId: "wrong-transfer" }],
        ),
        [],
      );
      Reflect.set(manager, "artifactCopyResult", async () => ({
        status: "completed",
        transferId: "transfer-verified",
        fullDeliveryVerified: false,
      }));
      assert.deepEqual(
        await manager.hybridTransferConfirmationsForAssignment(
          confirmationInput,
          [completedReceipt],
        ),
        [],
      );
    } finally {
      await lifecycle.requestCancellation(assignment.id);
      await lifecycle.settle(assignment, success(assignment));
    }
  },
);

test(
  "expired leases and stale session results cannot revive execution",
  { skip: !source },
  async () => {
    const task = await fixture("expired"),
      created = await assignments.dispatch(task),
      assignment = await row(created.assignmentId);
    const stale = success(assignment);
    stale.session_generation = 999;
    assert.equal(await lifecycle.settle(assignment, stale), false);
    await pool.query(
      "UPDATE execution.executor_assignments SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [assignment.id],
    );
    await lifecycle.settle(assignment, success(assignment));
    assert.equal((await row(assignment.id)).state, "failed");
    assert.deepEqual(
      (
        await pool.query(
          "SELECT output_json FROM execution.workflow_step_runs WHERE id=$1",
          ["expired-step"],
        )
      ).rows[0]!.output_json,
      {},
    );
  },
);

test(
  "scoped host state commits are fenced and cleanup retains its restricted capability",
  { skip: !source },
  async () => {
    const task = await fixture("host"),
      created = await assignments.dispatch(task),
      assignment = await row(created.assignmentId);
    const capability = (
      await pool.query(
        "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
        [assignment.id],
      )
    ).rows[0]!.authorization_token;
    const server = Fastify();
    registerRoomMemberActionHost(server, pool, assignments);
    const invoke = (method: string, args: unknown[]) =>
      server.inject({
        method: "POST",
        url: `/api/internal/executor-assignments/${assignment.id}/host`,
        headers: { authorization: `Bearer ${capability}` },
        payload: { method, args },
      });
    try {
      assert.equal(
        (await invoke("state.patch", [{ committed: true }])).statusCode,
        200,
      );
      assert.deepEqual((await invoke("state.get", [])).json().value, {
        committed: true,
      });
      assert.equal(
        (
          await invoke("beam.files.publishTempFile", [
            { tempFilePath: "private" },
          ])
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: `/api/internal/executor-assignments/${assignment.id}/inputs/image/0/authorize`,
            headers: { authorization: `Bearer ${capability}` },
            payload: {},
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await server.inject({
            method: "POST",
            url: `/api/internal/executor-assignments/${assignment.id}/artifacts/authorize`,
            headers: { authorization: `Bearer ${capability}` },
            payload: {
              operation: "output.publish",
              port: "result",
              artifactId: "artifact",
              sha256: `sha256:${"a".repeat(64)}`,
              sizeBytes: 1,
            },
          })
        ).statusCode,
        403,
      );
      await lifecycle.requestCancellation(assignment.id);
      assert.equal(
        (await invoke("state.patch", [{ stale: true }])).statusCode,
        403,
      );
      assert.equal(
        (await invoke("logger.info", ["Cancellation cleanup pending"]))
          .statusCode,
        200,
      );
      assert.deepEqual(
        (
          await pool.query(
            "SELECT state_json FROM execution.workflow_step_runs WHERE id=$1",
            ["host-step"],
          )
        ).rows[0]!.state_json,
        { committed: true },
      );
      await lifecycle.settle(assignment, success(assignment));
      assert.equal((await invoke("logger.info", ["Late"])).statusCode, 403);
    } finally {
      await server.close();
    }
  },
);

test(
  "stopped room execution waits for independent publication cleanup",
  { skip: !source },
  async () => {
    const task = await fixture("cleanup"),
      created = await assignments.dispatch(task),
      assignment = await row(created.assignmentId);
    await pool.query(
      "UPDATE execution.workflow_runs SET resolved_steps_json=jsonb_set(resolved_steps_json,'{0,actionPackage}','\"@beam/room-transfer\"') WHERE id='cleanup'",
    );
    await pool.query(
      'UPDATE execution.workflow_step_runs SET resource_execution_json=\'{"state":"active"}\', state_json=\'{"publishRequested":true,"beamStatus":"running"}\' WHERE id=\'cleanup-step\'',
    );
    await lifecycle.requestCancellation(assignment.id);
    assert.equal(
      await lifecycle.settle(assignment, success(assignment)),
      false,
    );
    const stopped = await row(assignment.id);
    assert.ok(stopped.executor_stopped_at);
    assert.equal(stopped.cleanup_confirmed_at, null);
    assert.equal(
      (
        await pool.query(
          "SELECT status,claim_token FROM execution.workflow_tasks WHERE id=$1",
          [task],
        )
      ).rows[0]!.status,
      "running",
    );
    await pool.query(
      'UPDATE execution.workflow_step_runs SET resource_execution_json=\'{"state":"cancelled"}\', state_json=state_json||\'{"cancellationStatus":"confirmed"}\' WHERE id=\'cleanup-step\'',
    );
    assert.equal(await lifecycle.settle(assignment, success(assignment)), true);
    assert.equal((await row(assignment.id)).state, "cancelled");
  },
);

test(
  "a private Registry artifact reaches the member through a signed URL frozen into its invocation",
  { skip: !source },
  async () => {
    const bytes = Buffer.from(
      `export default async () => ({ id: "${randomBytes(8).toString("hex")}" });`,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requests: Array<{ url: string; authorization?: string }> = [];
    const registry = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
      });
      if (request.url?.startsWith(`/registry/v1/artifacts/sha256/${sha256}?`))
        response.end(bytes);
      else response.writeHead(404).end();
    });
    await new Promise<void>((resolve) =>
      registry.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    const plainUrl = `${origin}/registry/v1/packages/%40test/compute/versions/1.0.0/artifact`;
    const signedUrl = `${origin}/registry/v1/artifacts/sha256/${sha256}?exp=4102444800&sig=signed`;
    const frozen: Array<{ organizationId: string; step: string }> = [];
    const signing = new RoomMemberActionAssignments(
      pool,
      repository,
      new AgentGateway(repository, { info() {}, warn() {}, error() {} }),
      async () => ({ room, roomSnapshot: snapshot }) as any,
      undefined,
      (run, step) =>
        freezeRegistryArtifactUrl(run, step, async (input) => {
          frozen.push({
            organizationId: input.organizationId,
            step: String(input.step.id),
          });
          return signedUrl;
        }),
    );
    const task = await fixture("signed", {
      sourceRegistry: "public-registry",
      resolvedVersion: "1.0.0",
      artifactChecksum: `sha256:${sha256}`,
      registryArtifactUrl: plainUrl,
      provenance: { registryVisibility: "private" },
    });
    const server = Fastify();
    try {
      const created = await signing.dispatch(task);
      assert.deepEqual(frozen, [{ organizationId: "org", step: "step" }]);
      const assignment = await row(created.assignmentId);
      const invocation = (
        await pool.query(
          "SELECT payload_json->'invocation' AS invocation FROM agent_control.commands WHERE id=$1",
          [assignment.command_id],
        )
      ).rows[0]!.invocation;
      assert.equal(invocation.step.registryArtifactUrl, signedUrl);
      assert.equal(invocation.step.artifactChecksum, `sha256:${sha256}`);
      // The run keeps its durable reference; only the assignment is signed.
      const run = (
        await pool.query(
          "SELECT resolved_steps_json FROM execution.workflow_runs WHERE id='signed'",
        )
      ).rows[0]!;
      assert.equal(run.resolved_steps_json[0].registryArtifactUrl, plainUrl);

      const capability = (
        await pool.query(
          "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
          [assignment.id],
        )
      ).rows[0]!.authorization_token;
      registerRoomMemberActionHost(server, pool, signing);
      const response = await server.inject({
        method: "GET",
        url: `/api/internal/executor-assignments/${assignment.id}/artifact`,
        headers: { authorization: `Bearer ${capability}` },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, bytes);
      // Studio downloads the frozen signed URL as given and adds no credential.
      assert.deepEqual(requests, [
        { url: signedUrl.slice(origin.length), authorization: undefined },
      ]);
      await lifecycle.settle(assignment, success(assignment));
    } finally {
      await server.close();
      await new Promise((resolve) => registry.close(resolve));
    }
  },
);

test("signing failures only block dispatch of a private Registry action", async () => {
  const run = { organization_id: "org" };
  const failing = async () => {
    throw new Error("Registry unavailable");
  };
  assert.equal(
    await freezeRegistryArtifactUrl(
      run,
      { sourceRegistry: "builtin" },
      failing,
    ),
    null,
  );
  assert.equal(
    await freezeRegistryArtifactUrl(
      run,
      {
        sourceRegistry: "public-registry",
        provenance: { registryVisibility: "public" },
      },
      failing,
    ),
    null,
  );
  await assert.rejects(
    freezeRegistryArtifactUrl(
      run,
      {
        sourceRegistry: "public-registry",
        provenance: { registryVisibility: "private" },
      },
      failing,
    ),
    (error: unknown) =>
      error instanceof WorkflowAuthorityUnavailableError &&
      error.code === "executor_artifact_url_unavailable",
  );
  await assert.rejects(
    freezeRegistryArtifactUrl(
      run,
      { sourceRegistry: "public-registry" },
      async () => {
        throw Object.assign(new Error("changed"), {
          code: "registry_artifact_checksum_mismatch",
        });
      },
    ),
    (error: unknown) =>
      (error as { code?: string }).code ===
      "executor_artifact_integrity_changed",
  );
});

test(
  "Studio's artifact read re-signs an expired URL once and keeps the frozen sha256",
  { skip: !source },
  async () => {
    const bytes = Buffer.from(
      `export default async () => ({ id: "${randomBytes(8).toString("hex")}" });`,
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requests: string[] = [];
    const registry = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url?.includes("sig=renewed")) response.end(bytes);
      else
        response
          .writeHead(403, { "content-type": "application/json" })
          .end(JSON.stringify({ code: "artifact_url_expired" }));
    });
    await new Promise<void>((resolve) =>
      registry.listen(0, "127.0.0.1", resolve),
    );
    const origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
    const path = `/registry/v1/artifacts/sha256/${sha256}`;
    const signing = new RoomMemberActionAssignments(
      pool,
      repository,
      new AgentGateway(repository, { info() {}, warn() {}, error() {} }),
      async () => ({ room, roomSnapshot: snapshot }) as any,
      undefined,
      async () => `${origin}${path}?exp=1&sig=expired`,
    );
    const task = await fixture("renewal", {
      sourceRegistry: "public-registry",
      resolvedVersion: "1.0.0",
      artifactChecksum: `sha256:${sha256}`,
      registryArtifactUrl: `${origin}/plain`,
      provenance: { registryVisibility: "private" },
    });
    const renewals: Array<{ organizationId: string; checksum: string }> = [];
    const server = Fastify();
    registerRoomMemberActionHost(
      server,
      pool,
      signing,
      undefined,
      async (run, step) => {
        renewals.push({
          organizationId: String(run.organization_id),
          checksum: String(step.artifactChecksum),
        });
        return `${origin}${path}?exp=2&sig=renewed`;
      },
    );
    try {
      const assignment = await row((await signing.dispatch(task)).assignmentId);
      const capability = (
        await pool.query(
          "SELECT authorization_token FROM execution.executor_assignment_capabilities WHERE assignment_id=$1",
          [assignment.id],
        )
      ).rows[0]!.authorization_token;
      const response = await server.inject({
        method: "GET",
        url: `/api/internal/executor-assignments/${assignment.id}/artifact`,
        headers: { authorization: `Bearer ${capability}` },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.rawPayload, bytes);
      // The run's checksum, not the expired URL, is what the renewal is bound to.
      assert.deepEqual(renewals, [
        { organizationId: "org", checksum: `sha256:${sha256}` },
      ]);
      // The expired URL is not retried; the renewed one is used once.
      assert.deepEqual(requests, [
        `${path}?exp=1&sig=expired`,
        `${path}?exp=2&sig=renewed`,
      ]);
      await lifecycle.settle(assignment, success(assignment));
    } finally {
      await server.close();
      await new Promise((resolve) => registry.close(resolve));
    }
  },
);
