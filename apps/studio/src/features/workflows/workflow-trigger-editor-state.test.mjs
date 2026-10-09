import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const triggerEditorState = readFileSync(
  new URL("./workflow-trigger-editor-state.ts", import.meta.url),
  "utf8",
);

test("enabling a stale workflow schedule uses the shared future-run policy", () => {
  assert.match(triggerEditorState, /calculateNextRunAt/);
  assert.match(
    triggerEditorState,
    /draft\.enabled &&\s*!currentEnabled &&\s*isPastOrNow\(config\.nextRunAt/,
  );
  assert.match(triggerEditorState, /nextFutureScheduleRun\(config/);
  assert.match(triggerEditorState, /config\.frequency/);
  assert.match(triggerEditorState, /windowStartTime/);
  assert.match(triggerEditorState, /windowEndTime/);
  assert.match(triggerEditorState, /windowDays/);
});

test("workflow schedule enablement blocks when no future run is possible", () => {
  assert.match(
    triggerEditorState,
    /Schedule cannot be enabled until its timing allows a future run\./,
  );
  assert.match(triggerEditorState, /ok: false/);
});

test("custom trigger names are preserved across type changes", () => {
  assert.match(
    triggerEditorState,
    /if \(!trimmed \|\| trimmed === workflowTriggerDefaultName\(currentType\)\)/,
  );
  assert.match(triggerEditorState, /return currentName/);
});

test("default or blank trigger names follow the selected type", () => {
  assert.match(triggerEditorState, /return "On a schedule"/);
  assert.match(triggerEditorState, /return "Webhook HTTP"/);
  assert.match(triggerEditorState, /return "Trigger manually"/);
});
