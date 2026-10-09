import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const editor = readFileSync(
  new URL("./workflow-graph-editor.tsx", import.meta.url),
  "utf8",
);
const model = readFileSync(
  new URL("./workflow-graph-model.ts", import.meta.url),
  "utf8",
);
const runDetail = readFileSync(
  new URL("../runs/run-detail-view.tsx", import.meta.url),
  "utf8",
);
const runGraph = readFileSync(
  new URL("../runs/run-detail-graph.tsx", import.meta.url),
  "utf8",
);

test("advanced graph editor persists structured controls and validates them before save", () => {
  assert.match(editor, /createControlNodes/);
  assert.match(editor, /validateGraph\(\s*nodes,\s*edges,\s*actionsByName,\s*workflowQuery\.data\?\.template\.room/);
  assert.match(
    model,
    /graphVersion:\s*preferredGraphVersion === "workflow-graph\/v3"[\s\S]*controls\.length/,
  );
  assert.match(model, /body:\s*\{[\s\S]*edges:/);
  assert.match(model, /fanInX/);
});

test("invalid persisted graphs render an editor error instead of escaping to React", () => {
  assert.match(editor, /catch \(error\) \{[\s\S]*setGraphLoadError\(/);
  assert.match(
    editor,
    /activeTab === "editor" && graphLoadError[\s\S]*\{graphLoadError\}/,
  );
  assert.match(
    editor,
    /Workflow graph needs repair/,
  );
  assert.match(editor, /Remove invalid connection/);
  assert.match(
    editor,
    /pendingRepairLockChanges[\s\S]*repairGraphMutation\.mutate\(true\)/,
  );
  assert.match(editor, /repair\.payload,[\s\S]*confirmActionLockChanges/);
});

test("Studio imports graph V2 through its browser-safe Core subpath", () => {
  const modelSource = readFileSync(
    new URL("./workflow-graph-model.ts", import.meta.url),
    "utf8",
  );
  const typesSource = readFileSync(
    new URL("./workflow-graph-types.ts", import.meta.url),
    "utf8",
  );
  const validationSource = readFileSync(
    new URL("./workflow-graph-validation.ts", import.meta.url),
    "utf8",
  );
  for (const source of [modelSource, typesSource, validationSource]) {
    assert.match(source, /@beam-studio\/core\/workflows\/graph-v2/);
    assert.doesNotMatch(source, /from ["']@beam-studio\/core["']/);
  }
});

test("run detail paginates dynamic instances without expanding the graph canvas", () => {
  assert.match(
    runDetail,
    /regions\/\$\{encodeURIComponent\(controlId\)\}\/instances\?offset=\$\{offset\}&limit=50/,
  );
  assert.match(runDetail, /Retry failed instances/);
  assert.match(runDetail, /Cancel region/);
  assert.match(runDetail, /ConfirmationDialog/);
  assert.doesNotMatch(runDetail, /window\.confirm/);
  assert.match(runDetail, /Condition traces/);
  assert.doesNotMatch(runGraph, /dynamicInstances|instanceIndex/);
});
