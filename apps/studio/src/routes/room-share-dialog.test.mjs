import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceRoot = new URL("../", import.meta.url);

test("room sharing creates a bounded invitation and copies a Beam join command", async () => {
  const [dialog, frame, page, roomData] = await Promise.all([
    readFile(
      new URL("features/rooms/room-share-dialog.tsx", sourceRoot),
      "utf8",
    ),
    readFile(new URL("features/rooms/room-page-frame.tsx", sourceRoot), "utf8"),
    readFile(new URL("features/rooms/room-page.tsx", sourceRoot), "utf8"),
    readFile(new URL("features/rooms/room-data.ts", sourceRoot), "utf8"),
  ]);

  assert.match(dialog, /"room\.invitation\.create"/);
  assert.match(dialog, /const defaultInvitationUses = 200/);
  assert.match(dialog, /const maxInvitationUses = 512/);
  assert.match(dialog, /min=\{1\}/);
  assert.match(dialog, /maxUses < 1/);
  assert.doesNotMatch(dialog, /maxUses < 2/);
  assert.match(dialog, /Joining does not require a Beam/);
  assert.match(dialog, /max_uses:\s*requestedMaxUses/);
  assert.match(dialog, /ttl_seconds:\s*requestedTTLSeconds/);
  assert.match(dialog, /role_ids:\s*roleIds/);
  assert.match(dialog, /channel_access:\s*Object\.entries\(channelAccess\)/);
  assert.match(dialog, /Role granted on join/);
  assert.match(dialog, /type="radio"/);
  assert.match(dialog, /Included with the selected role/);
  assert.match(dialog, /Channel permissions/);
  assert.match(dialog, /bearer invitation/);
  // The binary comes from the room's environment, and `beam room join` is
  // canonical: `beam tunnel room` is only a compatibility alias for existing
  // scripts and must not be spread by freshly generated commands.
  assert.match(
    dialog,
    /\$\{beamCliBinary\(\)\} room join \$\{shellQuote\(roomId\)\} --invitation-token/,
  );
  assert.doesNotMatch(dialog, /beam tunnel room/);
  assert.match(
    dialog,
    /displayedCommand: roomJoinCommand\(room\.id, "\[REDACTED\]"\)/,
  );
  assert.match(
    dialog,
    /copyText\(invitationMutation\.data\.clipboardCommand\)/,
  );
  assert.match(dialog, /value=\{invitationMutation\.data\.displayedCommand\}/);
  assert.match(dialog, /navigator\.clipboard\?\.writeText/);
  assert.match(dialog, /document\.execCommand\("copy"\)/);
  assert.match(dialog, /<DialogTrigger asChild>\{trigger\}<\/DialogTrigger>/);
  assert.match(dialog, /RoomShareTrigger = forwardRef/);
  assert.match(dialog, /\{ disabled, room, \.\.\.props \}/);
  assert.match(dialog, /<Button\s+\{\.\.\.props\}/);
  assert.match(dialog, /ref=\{ref\}/);
  assert.match(frame, /trigger=\{<RoomShareTrigger room=\{room\} \/>\}/);
  assert.match(page, /trigger=\{<RoomShareTrigger room=\{room\} \/>\}/);
  assert.match(page, /Invite participant/);
  assert.match(roomData, /terminalStates\.has\(created\.command\.state\)/);
  assert.match(roomData, /completedRoomCommand\(created\.command, operation\)/);
});
