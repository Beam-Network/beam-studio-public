import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const roomRoot = new URL("./", import.meta.url);
const studioRoot = new URL("../../", roomRoot);

test("room labels are editable and replace technical IDs in primary UI labels", async () => {
  const [data, list, settings, frame, shell] = await Promise.all([
    readFile(new URL("room-data.ts", roomRoot), "utf8"),
    readFile(new URL("rooms-page.tsx", roomRoot), "utf8"),
    readFile(new URL("room-settings-page.tsx", roomRoot), "utf8"),
    readFile(new URL("room-page-frame.tsx", roomRoot), "utf8"),
    readFile(new URL("components/app-shell.tsx", studioRoot), "utf8"),
  ]);

  assert.match(data, /label: text\(raw\.label\)/);
  assert.match(data, /function roomDisplayName/);
  assert.match(data, /"PATCH"[\s\S]*\/studio\/rooms/);
  assert.match(list, /placeholder="e\.g\. Production transfers"/);
  assert.match(list, /roomDisplayName\(room\)/);
  assert.match(settings, /title="Display label"/);
  assert.match(settings, /updateRoomLabel\(roomId/);
  assert.match(frame, /roomDisplayName\(room\)/);
  assert.match(shell, /name: roomDisplayName\(room\)/);
});
