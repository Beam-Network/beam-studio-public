import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const routeTree = readFileSync(join(sourceRoot, "routeTree.gen.ts"), "utf8");
const routeSourceRoot = join(sourceRoot, "routes");
const rootSource = readFileSync(join(routeSourceRoot, "__root.tsx"), "utf8");
const appShellSource = readFileSync(
  join(sourceRoot, "components", "app-shell.tsx"),
  "utf8",
);
const homeSource = readFileSync(join(routeSourceRoot, "new.tsx"), "utf8");
const markdownSource = readFileSync(
  join(sourceRoot, "features", "registry", "markdown.tsx"),
  "utf8",
);
const workflowEditorSource = readFileSync(
  join(sourceRoot, "features", "workflows", "workflow-graph-editor.tsx"),
  "utf8",
);
const contextualChatSource = readFileSync(
  join(sourceRoot, "components", "studio-assistant-chat.tsx"),
  "utf8",
);
const modelSelectorSource = readFileSync(
  join(sourceRoot, "components", "assistant-model-selector.tsx"),
  "utf8",
);
const dataPageSource = readFileSync(
  join(sourceRoot, "components", "data-page.tsx"),
  "utf8",
);
const authSource = readFileSync(join(routeSourceRoot, "auth.tsx"), "utf8");

const smokeRoutes = [
  "/new",
  "/dashboard",
  "/credentials",
  "/transfers",
  "/runs",
  "/schedules",
  "/workflows",
  "/registry",
  "/rooms",
  "/orchestration",
  "/mcp",
  "/settings",
  "/settings/access",
];

test("phase 1 smoke routes are present in the generated route tree", () => {
  for (const route of smokeRoutes) {
    // A nested route is emitted with its own segment as `path` and its full
    // path only in the route maps, so match either spelling.
    assert.match(
      routeTree,
      new RegExp(
        `(path: '${escapeRegExp(route)}'|fullPath: '${escapeRegExp(route)}')`,
      ),
      `${route} is missing from the generated route tree`,
    );
  }
});

test("phase 1 smoke routes have source route modules", () => {
  for (const route of smokeRoutes) {
    const fileName = `${route.slice(1).replaceAll("/", ".")}.tsx`;
    assert.equal(existsSync(join(routeSourceRoot, fileName)), true, fileName);
  }
});

test("room pages use the shared searchable breadcrumb selector", () => {
  assert.match(appShellSource, /hasRoomSelector/);
  assert.match(appShellSource, /searchPlaceholder="Find room\.\.\."/);
  // Selecting another room keeps the section the user is already on, so the
  // target carries an optional section suffix rather than being a bare room id.
  assert.match(
    appShellSource,
    /to: `\/rooms\/\$\{option\.id\}\$\{section \? `\/\$\{section\}` : ""\}` as never/,
  );
});

test("room routes use live agent-control data instead of fixtures", () => {
  const roomRouteFiles = [
    "rooms.tsx",
    "rooms.$id.tsx",
    "rooms.$id.channels.tsx",
    "rooms.$id.channels.$channelId.tsx",
    "rooms.$id.channels.$channelId.details.tsx",
    "rooms.$id.members.tsx",
    "rooms.$id.activity.tsx",
    "rooms.$id.settings.tsx",
  ];
  const routeSources = roomRouteFiles.map((file) =>
    readFileSync(join(routeSourceRoot, file), "utf8"),
  );
  const roomDataSource = readFileSync(
    join(sourceRoot, "features", "rooms", "room-data.ts"),
    "utf8",
  );
  const roomPageFrameSource = readFileSync(
    join(sourceRoot, "features", "rooms", "room-page-frame.tsx"),
    "utf8",
  );
  const roomChannelsSource = readFileSync(
    join(sourceRoot, "features", "rooms", "room-channels-page.tsx"),
    "utf8",
  );
  const roomChannelRouteSource = readFileSync(
    join(routeSourceRoot, "rooms.$id.channels.$channelId.tsx"),
    "utf8",
  );

  for (const source of routeSources) {
    assert.doesNotMatch(source, /MockRoom|mock-room/);
  }
  assert.match(
    roomDataSource,
    /apiFetch<CoordinatorRoomsPayload>\("\/studio\/rooms"/,
  );
  assert.doesNotMatch(
    roomDataSource,
    /sendAndWait\("room\.(?:list|get|channels\.list|memberships\.list|roles\.list)"/,
  );
  assert.doesNotMatch(
    roomPageFrameSource,
    /headerStart|Back to rooms|ArrowLeft/,
  );
  assert.match(roomPageFrameSource, /<h1[^>]*>[\s\S]*\{title\}[\s\S]*<\/h1>/);
  assert.doesNotMatch(
    roomPageFrameSource,
    /<h1[^>]*>[\s\S]*\{room\.id\}[\s\S]*<\/h1>/,
  );
  assert.doesNotMatch(
    appShellSource,
    /mock-room-data|defaultMockRoom|mockRooms/,
  );
  assert.match(appShellSource, /title="Channels"/);
  assert.match(routeTree, /fullPath: '\/rooms\/\$id\/channels\/\$channelId'/);
  assert.match(
    routeTree,
    /fullPath: '\/rooms\/\$id\/channels\/\$channelId\/details'/,
  );
  assert.match(roomChannelsSource, /<Dialog open=\{open\}/);
  assert.match(
    roomChannelRouteSource,
    /<RoomPage channelId=\{channelId\} roomId=\{id\}/,
  );
  assert.match(roomChannelRouteSource, /<Outlet \/>/);
  assert.doesNotMatch(routeTree, /fullPath: '\/rooms\/\$id\/channels\/new'/);
});

test("Studio metadata uses the Beam product description", () => {
  assert.match(
    rootSource,
    /Build, run, and monitor data transfer workflows and automations with Beam Studio\./,
  );
  assert.doesNotMatch(rootSource, /TanStack Studio/);
});

test("workflow run details keep the workflow route context", () => {
  assert.match(routeTree, /fullPath: '\/workflows\/\$id\/runs\/\$runId'/);
  assert.equal(
    existsSync(join(routeSourceRoot, "workflows.$id.runs.$runId.tsx")),
    true,
  );
});

test("retired Job sections are absent from the router", () => {
  for (const section of ["overview", "runs", "settings"]) {
    assert.equal(routeTree.includes(`fullPath: '/jobs/$id/${section}'`), false);
    assert.equal(
      existsSync(join(routeSourceRoot, `jobs.$id.${section}.tsx`)),
      false,
    );
  }
});

test("agent sections use canonical nested routes", () => {
  for (const section of [
    "overview",
    "tunnels",
    "destinations",
    "rooms",
    "logs",
    "activity",
    "settings",
  ]) {
    assert.equal(
      routeTree.includes(`fullPath: '/agents/$id/${section}'`),
      true,
    );
    assert.equal(
      existsSync(join(routeSourceRoot, `agents.$id.${section}.tsx`)),
      true,
    );
  }
});

test("canonical workflow history replaces the retired Job run route", () => {
  assert.doesNotMatch(routeTree, /fullPath: '\/jobs\/\$id\/runs\/\$runId'/);
  assert.equal(
    existsSync(join(routeSourceRoot, "jobs.$id.runs.$runId.tsx")),
    false,
  );
});

test("Home keeps read-only assistant responses out of operation plan cards", () => {
  assert.match(homeSource, /function isReadOnlyPlan/);
  assert.match(homeSource, /operation\.risk === "read"/);
  assert.match(homeSource, /message\.plan && !isReadOnlyPlan\(message\.plan\)/);
});

test("Home shows the assistant chat without requiring BEAM AI setup", () => {
  assert.doesNotMatch(homeSource, /Configure BEAM AI to use Home/);
  assert.doesNotMatch(homeSource, /<AssistantPanel/);
  assert.doesNotMatch(homeSource, /!assistantReady \|\| !value/);
  assert.match(homeSource, /\/studio\/ai\/models\/discover/);
  assert.match(homeSource, /apiSend\("PATCH", "\/studio\/ai\/settings"/);
  assert.match(homeSource, /onModelChange=\{selectModel\}/);
  assert.match(homeSource, /Your organization has no credits left/);
  assert.match(homeSource, /toHundredths\(activeOrganization\.credits\) <= 0/);
  assert.match(homeSource, /request\.errorCode === "quota"/);
  assert.match(
    homeSource,
    /conversationsQuery\.data\.conversations\.length === 0/,
  );
  assert.match(homeSource, /Add credits in Beam Console/);
  assert.match(homeSource, /consoleUrl=\{consoleUrl\}/);
  assert.match(
    homeSource,
    /queryKey: \["\/studio\/assistant\/conversations", activeOrganizationId, userId\]/,
  );
  assert.match(homeSource, /selectionDisabled=/);
});

test("assistant Markdown and entity mentions use navigable Studio links", () => {
  assert.match(markdownSource, /normalizeAssistantMarkdownLinks/);
  assert.match(homeSource, /assistantEntityHref/);
  assert.match(homeSource, /title={`Open \$\{match\[2\]\}/);
  assert.match(homeSource, /href={href}/);
});

test("workflow editor uses the universal contextual Studio chat", () => {
  assert.match(workflowEditorSource, /<StudioAssistantChat/);
  assert.match(workflowEditorSource, /variant="editor"/);
  assert.match(workflowEditorSource, /workflow:\s*\{/);
  assert.match(
    contextualChatSource,
    /absolute bottom-4 left-1\/2[\s\S]*w-\[min\(680px/,
  );
  assert.match(contextualChatSource, /<AssistantComposer/);
  assert.match(contextualChatSource, /variant="editor"/);
  assert.match(contextualChatSource, /<AssistantPlanCard/);
  assert.match(contextualChatSource, /renderUserMessage/);
  assert.match(contextualChatSource, /idempotencyKey/);
});

test("workflow editor keeps chat visible and supports BEAM AI model setup", () => {
  assert.doesNotMatch(
    contextualChatSource,
    /if \(!assistantReady\) \{\s*return null;/,
  );
  assert.match(contextualChatSource, /\/studio\/ai\/models\/discover/);
  assert.match(
    contextualChatSource,
    /apiSend\("PATCH", "\/studio\/ai\/settings"/,
  );
  assert.match(contextualChatSource, /selectionDisabled=\{composerBusy\}/);
  assert.match(
    contextualChatSource,
    /disabled=\{!assistantReady \|\| composerBusy\}/,
  );
});

test("assistant model selectors use the searchable grouped popover", () => {
  assert.match(dataPageSource, /<AssistantModelSelector/);
  assert.match(homeSource, /<AssistantModelSelector/);
  assert.match(modelSelectorSource, /Search models\.\.\./);
  assert.match(modelSelectorSource, /Recommended/);
  assert.match(modelSelectorSource, /All compatible models/);
});

test("OAuth device login is poll-driven, cancellable, and has no popup callback", () => {
  assert.match(authSource, /\/studio\/auth\/device\/authorize/);
  assert.match(authSource, /\/studio\/auth\/device\/poll/);
  assert.match(authSource, /\/studio\/auth\/device\/cancel/);
  assert.match(authSource, /apiGet<SessionPayload>\("\/studio\/session"\)/);
  assert.match(authSource, /apiGet\("\/studio\/organizations"\)/);
  assert.match(authSource, /verification_uri_complete/);
  assert.match(authSource, /Copy verification URL/);
  assert.match(authSource, /formatRemaining/);
  assert.match(authSource, /beforeunload/);
  assert.doesNotMatch(
    authSource,
    /postMessage|addEventListener\("message"|popup=yes/,
  );
});

test("settings hosts child routes instead of rendering alone", () => {
  const settingsSource = readFileSync(
    join(routeSourceRoot, "settings.tsx"),
    "utf8",
  );
  // Without the outlet, /settings/access renders nothing.
  assert.match(settingsSource, /<Outlet \/>/);
});

test("the sign-in page explains a Studio that does not serve the caller", () => {
  // A refused account is signed in to Beam successfully; restarting the device
  // flow would not change the answer, so these have to read differently from a
  // failed login.
  assert.match(authSource, /instance_private/);
  assert.match(authSource, /instance_join_pending/);
  assert.match(authSource, /This Studio is private/);
});

test("the access page leads with an organization name and keeps the id", () => {
  const accessSource = readFileSync(
    join(sourceRoot, "features", "settings", "instance-access-page.tsx"),
    "utf8",
  );
  // Studio can only resolve a name for an organization the viewer belongs to,
  // so the id has to stay visible rather than being replaced by a placeholder.
  assert.match(accessSource, /function OrganizationLabel/);
  const fallback = accessSource.slice(
    accessSource.indexOf("if (!name)"),
    accessSource.indexOf("if (!name)") + 200,
  );
  assert.match(fallback, /\{organizationId\}/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
