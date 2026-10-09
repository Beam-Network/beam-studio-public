import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * Mirrors otherTargetCount in budget-alert-bar.tsx. The component is TSX and
 * these suites are plain node:test, so the rule is pinned here rather than
 * importing through a JSX toolchain.
 */
function otherTargetCount(alerts, shown) {
  const key = (a) => a.apiKey?.id ?? a.project?.id ?? `${a.targetType}:organization`;
  const shownKey = key(shown);
  return new Set(alerts.map(key).filter((id) => id !== shownKey)).size;
}

const keyAlert = (id, threshold) => ({
  targetType: "api_key",
  threshold,
  apiKey: { id, name: id, prefix: `b1m_${id}` },
  project: null,
});

test("one key crossing 50, 80 and 95 is one budget, not three alerts", () => {
  // Exactly what shipped: a single charge crossed all three and the bar read
  // "+2 more alerts", as if two other things were wrong.
  const alerts = [keyAlert("k1", 95), keyAlert("k1", 80), keyAlert("k1", 50)];
  assert.equal(otherTargetCount(alerts, alerts[0]), 0);
});

test("a second key in trouble is counted", () => {
  const alerts = [keyAlert("k1", 95), keyAlert("k1", 50), keyAlert("k2", 80)];
  assert.equal(otherTargetCount(alerts, alerts[0]), 1);
});

test("keys and projects are counted apart", () => {
  const alerts = [
    keyAlert("k1", 95),
    { targetType: "project", threshold: 80, apiKey: null, project: { id: "p1", name: "Promo" } },
    { targetType: "project", threshold: 50, apiKey: null, project: { id: "p1", name: "Promo" } },
  ];
  assert.equal(otherTargetCount(alerts, alerts[0]), 1, "one other budget: the project");
});

test("a single alert has nothing else to report", () => {
  const alerts = [keyAlert("k1", 100)];
  assert.equal(otherTargetCount(alerts, alerts[0]), 0);
});
