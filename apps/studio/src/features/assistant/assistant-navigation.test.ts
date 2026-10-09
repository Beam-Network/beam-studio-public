import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../registry/markdown.js";
import {
  assistantEntityHref,
  STUDIO_ASSISTANT_NAVIGATION,
  STUDIO_ASSISTANT_ROUTE_PATTERNS,
  isStudioAssistantHref,
} from "@beam-studio/shared";
import {
  registryPackagePath,
  registryPackageNameFromParams,
} from "../registry/registry-data.js";

test("assistant route validation matches Studio's generated router", () => {
  const source = readFileSync(
    new URL("../../routeTree.gen.ts", import.meta.url),
    "utf8",
  );
  const routes = [
    ...new Set(
      [...source.matchAll(/fullPath: '([^']+)'/g)].map((match) => match[1]),
    ),
  ].sort();
  assert.ok(routes.length > 0);
  assert.deepEqual([...STUDIO_ASSISTANT_ROUTE_PATTERNS].sort(), routes);
  for (const item of STUDIO_ASSISTANT_NAVIGATION)
    assert.ok(isStudioAssistantHref(item.href));
});

test("assistant action links open the same scoped package as Registry navigation", () => {
  for (const packageName of [
    "@beam/slack",
    "@beam/http-request",
    "@custom/my-action",
  ]) {
    const href = assistantEntityHref("registry_action", packageName)!;
    assert.equal(href, registryPackagePath({ packageName }));
    const [, , scope, name] = href.split("/");
    assert.equal(registryPackageNameFromParams(scope!, name!), packageName);
  }
});

test("saved assistant replies render only valid Studio routes as links", () => {
  const value = "[Slack](/actions/slack) [Registry](/registry/@beam/slack)";
  const html = renderToStaticMarkup(
    createElement(MarkdownContent, { assistantLinks: true, value }),
  );
  assert.ok(!html.includes('href="/actions/slack"'));
  assert.ok(html.includes("Slack"));
  assert.ok(html.includes('href="/registry/@beam/slack"'));
  const readme = renderToStaticMarkup(
    createElement(MarkdownContent, { value }),
  );
  assert.ok(readme.includes('href="/actions/slack"'));
});
