import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");

const sharedSchema = read("packages/shared/src/room-workflow.ts");
const workflowFactory = read("apps/api/src/studio/room-workflows.ts");
const requestConfig = section(
  read("apps/api/src/studio/routes.ts"),
  "async function roomWorkflowConfigForRequest",
  "function isJsonObject",
);
const actionForm = read(
  "apps/studio/src/features/workflows/room-transfer-config-form.tsx",
);
const recipientPicker = read(
  "apps/studio/src/features/workflows/room-recipient-picker.tsx",
);
const quickSend = read(
  "apps/studio/src/features/rooms/room-transfers-page.tsx",
);
const workflowRuns = read("apps/api/src/studio/workflow-runs.ts");
const studioStore = read("apps/api/src/studio/store.ts");
const workflowDefinitions = read("packages/db/src/workflow-definitions.ts");
const workflowActionConfig = read(
  "packages/core/src/workflows/action-config.ts",
);
const orchestrator = read("apps/orchestrator/src/postgresOrchestration.ts");
const workerActionConfig = read("apps/worker/src/services/actionConfig.ts");

assertIncludes(sharedSchema, 'roomTransferActionVersion = "2.1.2"');
assertExcludes(sharedSchema, ".max(1000)");
assertExcludes(actionForm, "fetchRoomsSnapshot");
assertIncludes(actionForm, "room-workflow-room-options");
assertIncludes(recipientPicker, "Everyone eligible");
assertIncludes(recipientPicker, "Select all matching");
assertIncludes(
  recipientPicker,
  "No eligible members match the current filters.",
);
assertIncludes(recipientPicker, "Clear all · Everyone eligible");
assertExcludes(recipientPicker, "1000");
assertIncludes(
  sharedSchema,
  "environmentTemplateKey: beamEnvironmentTemplateKeySchema",
);
assertExcludes(sharedSchema, "coordinatorUrl: z.");
assertExcludes(sharedSchema, "environment: z.");
assertIncludes(
  workflowFactory,
  "actionVersionRange: roomTransferActionVersion",
);
for (const [name, source] of [
  ["room workflow request", requestConfig],
  ["room-transfer editor", actionForm],
  ["room quick-send", quickSend],
]) {
  assertExcludes(source, "coordinatorUrl:", name);
}
assertIncludes(workflowRuns, "captureWorkflowTreePg", "workflow run launch");
assertIncludes(studioStore, "assertWorkflowActionConfig", "Studio authoring");
assertIncludes(studioStore, "captureWorkflowTreePg", "Studio authoring");
assertIncludes(
  workflowDefinitions,
  "export async function captureWorkflowTreePg",
  "workflow definition capture",
);
assertIncludes(
  workflowDefinitions,
  "assertWorkflowActionConfig",
  "workflow definition capture",
);
assertIncludes(
  workflowDefinitions,
  "resolveWorkflowRoomContext",
  "workflow definition capture",
);
assertIncludes(
  workflowActionConfig,
  "resolveActionRoomContext",
  "workflow action config validation",
);
assertIncludes(
  workflowActionConfig,
  "assertActionConfig",
  "workflow action config validation",
);
assertIncludes(
  workflowActionConfig,
  "requireResolvedRoom",
  "workflow action config validation",
);
assertIncludes(orchestrator, "captureWorkflowTreePg", "Action Dispatcher");
assertIncludes(orchestrator, "assertActionConfig", "Action Dispatcher");
assertIncludes(workerActionConfig, "assertActionConfig", "Action Runner");

console.log(
  "Room-transfer config surfaces use the template-only 2.1.2 contract without a Studio recipient cap.",
);

function assertIncludes(source, value, name = "contract surface") {
  if (!source.includes(value)) throw new Error(`${name} is missing ${value}`);
}

function assertExcludes(source, value, name = "contract surface") {
  if (source.includes(value))
    throw new Error(`${name} still contains ${value}`);
}

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  if (from < 0 || to < 0) throw new Error(`Could not inspect ${start}`);
  return source.slice(from, to);
}
