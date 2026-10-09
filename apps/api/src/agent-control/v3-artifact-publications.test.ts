import assert from "node:assert/strict";
import { test } from "node:test";
import { freezeV3OutputPublications } from "./action-assignments.js";

test("a logical task retains a local copy and transfers only to other members", () => {
  const routes = {
    counts: {
      roomId: "room",
      channelId: "objects",
      targetMemberIds: ["alice", "bob"],
      retentionObligationId: "retention",
      requiredUntil: "2099-01-01T00:00:00Z",
      availability: "temporary",
    },
  };
  const alice = freezeV3OutputPublications(routes, "objects", "alice");
  assert.equal(alice.counts.sourceMemberId, "alice");
  assert.deepEqual(alice.counts.targetMemberIds, ["bob"]);
  const bob = freezeV3OutputPublications(routes, "objects", "bob");
  assert.deepEqual(bob.counts.targetMemberIds, ["alice"]);
  assert.deepEqual(routes.counts.targetMemberIds, ["alice", "bob"]);
  assert.throws(() => freezeV3OutputPublications(routes, "request", "alice"),
    /executor_artifact_publication_invalid/);
});

test("a terminal output freezes a publication with no remote recipients", () => {
  const publications = freezeV3OutputPublications({
    counts: {
      roomId: "room", channelId: "objects", targetMemberIds: [],
      retentionObligationId: "terminal-retention",
      requiredUntil: "2099-01-01T00:00:00Z",
      availability: "temporary",
    },
  }, "objects", "alice");
  assert.equal(publications.counts.sourceMemberId, "alice");
  assert.deepEqual(publications.counts.targetMemberIds, []);
});
