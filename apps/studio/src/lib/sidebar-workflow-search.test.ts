import assert from "node:assert/strict";
import test from "node:test";
import { filterSidebarWorkflows } from "./sidebar-workflow-search";
const workflows = [
  { id: "eu", name: "Réplication Europe" },
  { id: "us", name: "US backup" },
  { id: "root", name: "Europe notifications" },
];
test("workflow search ignores accents, case and word order", () => {
  assert.deepEqual(
    filterSidebarWorkflows({ workflows, query: " EUROPE replication " }).map(
      (item) => item.id,
    ),
    ["eu"],
  );
});
test("workflow search includes every definition and supports ids", () => {
  assert.deepEqual(
    filterSidebarWorkflows({ workflows, query: "  " }),
    workflows,
  );
  assert.deepEqual(filterSidebarWorkflows({ workflows, query: "us" }), [
    workflows[1],
  ]);
  assert.deepEqual(
    filterSidebarWorkflows({ workflows, query: "not present" }),
    [],
  );
});
