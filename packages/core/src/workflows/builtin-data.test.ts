import assert from "node:assert/strict";
import { test } from "node:test";
import {
  builtinDataActions,
  LocalActionRegistry,
  runActionHarness,
  runLinearWorkflow,
  type WorkflowRunStore,
  type WorkflowStepRunRecord,
} from "../index.js";

test("runs first-party data actions with config bindings and artifacts", async () => {
  const registry = new LocalActionRegistry();
  for (const action of builtinDataActions) {
    registry.registerPackage({
      source: "builtin",
      manifest: action.manifest,
      execute: action.execute,
    });
  }
  const store = memoryStore();

  const uploads: Array<{ endpoint: unknown; content: string }> = [];

  await runLinearWorkflow(
    {
      workflowRunId: "wfr_data",
      templateId: "wft_data",
      templateSnapshot: { content: "id,name\n1,Ada" },
      runtimeInputs: {},
      steps: [
        {
          id: "endpoint",
          position: 0,
          enabled: true,
          actionPackage: "@beam/object-storage-endpoint",
          versionRange: "1.1.0",
          config: {
            provider: "s3",
            bucket: "beam-fixtures",
            objectKey: "outgoing/report.csv",
            credentialId: "cred_s3",
          },
          inputBindings: {},
        },
        {
          id: "upload",
          position: 1,
          enabled: true,
          actionPackage: "@beam/upload",
          versionRange: "1.0.0",
          config: { mediaType: "text/csv" },
          inputBindings: {
            endpoint: "${steps.endpoint.outputs.endpoint}",
            content: "${workflow.config.content}",
          },
        },
      ],
    },
    {
      registry,
      store,
      beam: {
        objectStorage: {
          upload: async (endpoint: unknown, content: string) => {
            uploads.push({ endpoint, content });
            return { bytes: Buffer.byteLength(content) };
          },
        },
      },
    },
  );

  assert.equal(store.workflowStatus, "completed");
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.content, "id,name\n1,Ada");
  assert.equal(
    store.outputs.get("upload")?.uri,
    "s3://beam-fixtures/outgoing/report.csv",
  );
  assert.equal(store.outputs.get("upload")?.bytes, 13);
  assert.equal(store.artifactCount, 1);
});

test("object storage endpoint emits a reusable endpoint object", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/object-storage-endpoint",
  );
  assert.ok(action);

  const result = await runActionHarness(action.execute, {
    config: {
      name: "Input object",
      provider: "custom-s3",
      bucket: "beam-fixtures",
      objectKey: "incoming/report.csv",
      credentialId: "cred_s3",
      endpointUrl: "https://storage.example.test",
    },
  });

  assert.deepEqual(result.outputs?.endpoint, {
    name: "Input object",
    provider: "custom-s3",
    bucket: "beam-fixtures",
    objectKey: "incoming/report.csv",
    sourceType: "file",
    endpointUrl: "https://storage.example.test",
    credentialId: "cred_s3",
  });
  assert.equal(result.outputs?.uri, "s3://beam-fixtures/incoming/report.csv");
});

test("download requires a worker object storage adapter", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/download",
  );
  assert.ok(action);

  await assert.rejects(
    () =>
      runActionHarness(action.execute, {
        inputs: {
          endpoint: {
            provider: "s3",
            bucket: "beam-fixtures",
            objectKey: "incoming/report.csv",
            credentialId: "cred_s3",
          },
        },
      }),
    /object storage adapter/,
  );
});

test("upload requires a worker object storage adapter", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/upload",
  );
  assert.ok(action);

  await assert.rejects(
    () =>
      runActionHarness(action.execute, {
        inputs: {
          endpoint: {
            provider: "s3",
            bucket: "beam-fixtures",
            objectKey: "outgoing/report.csv",
            credentialId: "cred_s3",
          },
          content: "id,name\n1,Ada",
        },
      }),
    /object storage adapter/,
  );
});

test("object storage delete deletes exact file endpoints", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/object-storage-delete",
  );
  assert.ok(action);
  const deleted: unknown[] = [];

  const result = await runActionHarness(
    action.execute,
    {
      config: {
        endpoints: [
          {
            provider: "r2",
            bucket: "beam-bucx-15",
            objectKey: "r2-1tb/scheduled/lane-7/object-a.bin",
            credentialId: "cred_ben_r2",
          },
          {
            provider: "r2",
            bucket: "beam-bucx-15",
            objectKey: "r2-1tb/scheduled/lane-7/object-b.bin",
            credentialId: "cred_ben_r2",
          },
        ],
      },
    },
    {
      beam: {
        objectStorage: {
          delete: async (endpoint: unknown) => {
            deleted.push(endpoint);
            const target = endpoint as { bucket: string; objectKey: string };
            return { uri: `s3://${target.bucket}/${target.objectKey}` };
          },
        },
      },
    },
  );

  assert.equal(deleted.length, 2);
  assert.equal(result.outputs?.deletedCount, 2);
  assert.deepEqual(result.outputs?.uris, [
    "s3://beam-bucx-15/r2-1tb/scheduled/lane-7/object-a.bin",
    "s3://beam-bucx-15/r2-1tb/scheduled/lane-7/object-b.bin",
  ]);
});

test("object storage delete rejects directory and wildcard endpoints", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/object-storage-delete",
  );
  assert.ok(action);

  await assert.rejects(
    () =>
      runActionHarness(action.execute, {
        inputs: {
          endpoint: {
            provider: "r2",
            bucket: "beam-bucx-15",
            objectKey: "r2-1tb/scheduled/lane-7/",
            sourceType: "directory",
            credentialId: "cred_ben_r2",
          },
        },
      }),
    /exact file object keys/,
  );

  await assert.rejects(
    () =>
      runActionHarness(action.execute, {
        inputs: {
          provider: "r2",
          bucket: "beam-bucx-15",
          objectKey: "r2-1tb/scheduled/lane-7/*.bin",
          credentialId: "cred_ben_r2",
        },
      }),
    /wildcard object keys/,
  );
});

test("object storage delete requires a worker object storage adapter", async () => {
  const action = builtinDataActions.find(
    (entry) => entry.manifest.name === "@beam/object-storage-delete",
  );
  assert.ok(action);

  await assert.rejects(
    () =>
      runActionHarness(action.execute, {
        inputs: {
          endpoint: {
            provider: "r2",
            bucket: "beam-bucx-15",
            objectKey: "r2-1tb/scheduled/lane-7/object-a.bin",
            credentialId: "cred_ben_r2",
          },
        },
      }),
    /object storage adapter/,
  );
});

function memoryStore() {
  const stepRuns = new Map<string, WorkflowStepRunRecord>();
  const outputs = new Map<string, Record<string, unknown>>();
  const store: WorkflowRunStore & {
    artifactCount: number;
    outputs: Map<string, Record<string, unknown>>;
    workflowStatus: string | null;
  } = {
    artifactCount: 0,
    outputs,
    workflowStatus: null,
    async createStepRun({ workflowRunId, step, attempt }) {
      const run = {
        id: `wsr_${step.id}`,
        workflowRunId,
        stepId: step.id,
        status: "queued",
        attempt,
        state: {},
        externalRef: null,
      } satisfies WorkflowStepRunRecord;
      stepRuns.set(run.id, run);
      return run;
    },
    async updateStepRun(stepRunId, patch) {
      const stepRun = stepRuns.get(stepRunId);
      assert.ok(stepRun);
      if (patch.output) {
        outputs.set(stepRun.stepId, patch.output);
      }
      if (patch.artifacts) {
        store.artifactCount += patch.artifacts.length;
      }
    },
    async updateWorkflowRun(_workflowRunId, patch) {
      store.workflowStatus = patch.status;
    },
    async log() {},
  };
  return store;
}
