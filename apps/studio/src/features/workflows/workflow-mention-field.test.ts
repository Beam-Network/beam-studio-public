import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMention,
  detectMentionQuery,
  matchNodes,
  matchValues,
  resolveMentionReference,
} from "./workflow-mention-field";

test("an @ opens a mention and captures what follows it", () => {
  assert.deepEqual(detectMentionQuery("@", 1), { start: 0, text: "" });
  assert.deepEqual(detectMentionQuery("@trans", 6), {
    start: 0,
    text: "trans",
  });
  assert.deepEqual(detectMentionQuery("Transfer @trans", 15), {
    start: 9,
    text: "trans",
  });
});

test("prose does not open a mention", () => {
  assert.equal(detectMentionQuery("the transfer failed", 19), null);
  // A space ends the mention, so a sentence after one stops matching.
  assert.equal(detectMentionQuery("@transfer failed badly", 22), null);
});

test("the mention tracks the caret, not the end of the text", () => {
  // Caret sits inside the first mention while a second exists later.
  assert.deepEqual(detectMentionQuery("@one and @two", 4), {
    start: 0,
    text: "one",
  });
});

test("inserting replaces only the mention fragment", () => {
  const result = applyMention("@trans", 0, 6, "${steps.wfs_1.name}");
  assert.equal(result.text, "${steps.wfs_1.name}");
  assert.equal(result.caret, "${steps.wfs_1.name}".length);
});

test("inserting mid-sentence keeps the surrounding text", () => {
  const value = "Transfer @tr failed";
  const query = detectMentionQuery(value, 12);
  assert.ok(query);
  const result = applyMention(value, query.start, 12, "${steps.wfs_1.name}");
  assert.equal(result.text, "Transfer ${steps.wfs_1.name} failed");
  assert.equal(result.caret, "Transfer ${steps.wfs_1.name}".length);
});

test("two references can be built in one field", () => {
  const first = applyMention("@a", 0, 2, "${steps.wfs_1.name}");
  const withSecond = `${first.text} @d`;
  const query = detectMentionQuery(withSecond, withSecond.length);
  assert.ok(query);
  const second = applyMention(
    withSecond,
    query.start,
    withSecond.length,
    "${decisions.dec_1.branch}",
  );
  assert.equal(second.text, "${steps.wfs_1.name} ${decisions.dec_1.branch}");
});

const nodes = [
  {
    id: "wfs_1",
    label: "Nightly EU transfer",
    kind: "step" as const,
    values: [
      {
        expression: "${steps.wfs_1.name}",
        field: "name",
        hint: "the node's label",
      },
      {
        expression: "${steps.wfs_1.status}",
        field: "status",
        hint: "completed, failed",
      },
      {
        expression: "${steps.wfs_1.error}",
        field: "error",
        hint: "failure message",
      },
    ],
  },
  {
    id: "dec_1",
    label: "Transfer finished",
    kind: "decision" as const,
    values: [
      {
        expression: "${decisions.dec_1.branch}",
        field: "branch",
        hint: "true or false",
      },
    ],
  },
];

test("the first stage filters nodes by their name", () => {
  assert.deepEqual(
    matchNodes(nodes, "").map((node) => node.label),
    ["Nightly EU transfer", "Transfer finished"],
  );
  assert.deepEqual(
    matchNodes(nodes, "nightly").map((node) => node.label),
    ["Nightly EU transfer"],
  );
  // Matching is on the operator's name, not the id.
  assert.deepEqual(matchNodes(nodes, "wfs_1"), []);
});

test("node matching is case-insensitive and matches anywhere in the name", () => {
  assert.deepEqual(
    matchNodes(nodes, "TRANSFER").map((node) => node.id),
    ["wfs_1", "dec_1"],
  );
});

test("the second stage filters that node's values", () => {
  const step = nodes[0]!;
  assert.deepEqual(
    matchValues(step, "").map((value) => value.field),
    ["name", "status", "error"],
  );
  assert.deepEqual(
    matchValues(step, "err").map((value) => value.field),
    ["error"],
  );
  // The hint is searchable too, so "failed" finds status.
  assert.deepEqual(
    matchValues(step, "failed").map((value) => value.field),
    ["status"],
  );
});

test("a node with no matching value yields an empty second stage", () => {
  assert.deepEqual(matchValues(nodes[1]!, "status"), []);
});

test("nested paths beneath a declared output keep a readable node reference", () => {
  const httpNodes = [
    {
      id: "pool",
      label: "Read routing pools",
      kind: "step" as const,
      values: [
        {
          expression: "${steps.pool.outputs.body}",
          field: "outputs.body",
          hint: "response body",
        },
      ],
    },
  ];

  const resolved = resolveMentionReference(
    httpNodes,
    "${steps.pool.outputs.body.pools.qualifying.eligible}",
  );
  assert.equal(resolved?.node.label, "Read routing pools");
  assert.equal(resolved?.entry.field, "outputs.body");
  assert.equal(resolved?.suffix, "pools.qualifying.eligible");
});

test("a path outside every declared value remains unknown", () => {
  assert.equal(
    resolveMentionReference(nodes, "${steps.missing.outputs.body.value}"),
    null,
  );
  assert.equal(
    resolveMentionReference(nodes, "${steps.wfs_1.status.detail}"),
    null,
  );
});
