import assert from "node:assert/strict";
import test from "node:test";
import { roomSourcePathIssue } from "./room-source-path";

test("validates source paths for the selected agent platform", () => {
  assert.equal(roomSourcePathIssue("/srv/file.bin", "linux"), null);
  assert.match(roomSourcePathIssue("file.bin", "linux")!, /absolute path/);
  assert.equal(roomSourcePathIssue("C:\\Transfers\\file.bin", "win32"), null);
  assert.match(roomSourcePathIssue("file.bin", "windows")!, /Windows path/);
});
