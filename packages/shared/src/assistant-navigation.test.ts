import assert from "node:assert/strict";
import test from "node:test";
import {
  assistantContextHrefs,
  isStudioAssistantHref,
} from "./assistant-navigation.js";
import { sanitizeAssistantMarkdownLinks } from "./studio-ai-assistant.js";

test("invented action links become plain text, including saved replies", () => {
  for (const action of [
    "http-request",
    "slack",
    "transfer",
    "upload",
    "download",
    "fan-out",
    "join",
    "webhook",
  ]) {
    assert.equal(
      sanitizeAssistantMarkdownLinks(`[${action}](/actions/${action})`),
      action,
    );
    assert.equal(
      sanitizeAssistantMarkdownLinks(
        `[${action}](https://studio.local/actions/${action})`,
      ),
      action,
    );
  }
});

test("new replies may link only to exact context hrefs, including scoped Registry actions", () => {
  const hrefs = assistantContextHrefs({
    actions: [
      { href: "/registry/@beam/slack" },
      { href: "/registry/@custom/my-action" },
    ],
    workflows: [{ href: "/workflows/wft_1/editor" }],
    navigation: [{ href: "/registry" }],
    description: "/registry/@beam/invented",
  });
  const valid =
    "[Slack](/registry/@beam/slack), [Custom](/registry/@custom/my-action), [Workflow](/workflows/wft_1/editor), [Registry](/registry)";
  assert.equal(sanitizeAssistantMarkdownLinks(valid, hrefs), valid);
  assert.equal(
    sanitizeAssistantMarkdownLinks(
      "[Unknown](/registry/@beam/invented) [Other](/workflows/wft_2/editor)",
      hrefs,
    ),
    "Unknown Other",
  );
  assert.equal(
    sanitizeAssistantMarkdownLinks(
      "[Slack](https://studio/registry/@beam/slack)",
      hrefs,
    ),
    "[Slack](/registry/@beam/slack)",
  );
});

test("code samples and external documentation remain intact", () => {
  const content =
    "[Docs](https://example.com/actions/slack)\n`[Example](/actions/slack)`\n```md\n[Example](/actions/slack)\n```";
  assert.equal(sanitizeAssistantMarkdownLinks(content, new Set()), content);
});

test("route validation rejects nonexistent routes, protocol-relative URLs and traversal", () => {
  for (const href of [
    "/actions/slack",
    "//example.com",
    "/registry/@beam/..",
    "/registry/@beam/%2e%2e",
    "/registry/@beam/%ZZ",
    "/registry\\@beam\\slack",
  ]) {
    assert.equal(isStudioAssistantHref(href), false, href);
  }
  for (const href of [
    "/",
    "/registry/@beam/slack",
    "/registry/@custom/my-action",
    "/workflows/wft_1/editor",
    "/credentials/new?name=S3",
  ]) {
    assert.equal(isStudioAssistantHref(href), true, href);
  }
});
