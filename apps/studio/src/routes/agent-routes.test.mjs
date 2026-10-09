import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeRoot = new URL("./", import.meta.url);

test("agent inventory, enrollment, and detail routes expose the connected control workspace", async () => {
  const [inventory, enrollmentPage, detail, appShell] = await Promise.all([
    readFile(new URL("agents.tsx", routeRoot), "utf8"),
    readFile(new URL("agents.new.tsx", routeRoot), "utf8"),
    readFile(new URL("agents.$id.tsx", routeRoot), "utf8"),
    readFile(new URL("../components/app-shell.tsx", routeRoot), "utf8"),
  ]);

  assert.match(inventory, /createFileRoute\("\/agents"\)/);
  assert.match(inventory, /to="\/agents\/new"/);
  assert.match(enrollmentPage, /createFileRoute\("\/agents\/new"\)/);
  assert.match(enrollmentPage, /AgentEnrollmentFlow/);
  assert.match(inventory, /\/studio\/agents\/enrollments/);
  assert.match(inventory, /\[\s*"beam",\s*"studio",\s*"connect"/);
  // Only Rooms are offered: tunnel enrollment options stay behind the flag.
  assert.match(inventory, /studioEnv\.tunnelsEnabled \? "http" : "rooms"/);
  assert.match(
    detail,
    /studioEnv\.tunnelsEnabled \|\| !tunnelTabs\.has\(item\.id\)/,
  );
  assert.match(inventory, /role="switch"/);
  assert.match(inventory, /current=\{step\}/);
  assert.match(inventory, /orientation="vertical"/);
  assert.match(inventory, /Machine capabilities/);
  assert.match(inventory, /Tunnel kinds/);
  assert.match(inventory, /Web services/);
  assert.match(inventory, /File transfer/);
  assert.match(inventory, /Full control/);
  assert.match(inventory, /--allow-public/);
  assert.match(inventory, /--allow-kind/);
  assert.match(inventory, /--allow-root/);
  assert.match(inventory, /PowerShell/);
  assert.match(inventory, /powershellQuote/);
  assert.match(
    inventory,
    /Use HTTPS for every Studio API URL outside localhost/,
  );
  assert.match(inventory, /permissions\.rooms\s+\|\|/);
  assert.match(inventory, /navigator\.clipboard/);
  assert.match(inventory, /document\.execCommand\("copy"\)/);
  assert.match(inventory, /Renew code/);
  assert.match(
    inventory,
    /The secure connection is taking longer than expected/,
  );
  assert.match(inventory, /Agent connected/);
  assert.match(inventory, /Open agent/);
  assert.match(inventory, /agent\.status === "revoked"/);
  assert.match(inventory, /apiSend\("DELETE", `\/studio\/agents\/\$\{/);
  assert.match(inventory, /title="Delete revoked agent\?"/);
  assert.match(inventory, /confirmLabel="Delete agent"/);
  assert.match(inventory, /deleteMutation\.variables === agent\.id/);
  assert.doesNotMatch(inventory, /window\.confirm/);
  assert.match(detail, /createFileRoute\("\/agents\/\$id"\)/);
  assert.doesNotMatch(detail, /ArrowLeft/);
  assert.doesNotMatch(detail, /headerStart=/);
  assert.match(appShell, /searchPlaceholder="Find agent\.\.\."/);
  assert.match(
    appShell,
    /location\.pathname === "\/agents" \|\| Boolean\(routeInfo\.agentId\)/,
  );
  assert.match(
    appShell,
    /selectedId=\{routeInfo\.agentId \?\? ALL_AGENTS_ID\}/,
  );
  assert.match(
    appShell,
    /description: `\$\{agent\.status\} · \$\{agent\.id\}`/,
  );
  assert.match(appShell, /label: "All agents"/);
  assert.match(appShell, /option\.id === ALL_AGENTS_ID/);
  assert.match(appShell, /navigate\(\{ to: "\/agents" \}\)/);
  assert.match(
    appShell,
    /to: `\/agents\/\$\{option\.id\}\/\$\{section \|\| "overview"\}`/,
  );
  assert.match(
    detail,
    /<Navigate replace to={`\/agents\/\$\{id\}\/overview` as never} \/>/,
  );
  assert.match(detail, /return <Outlet \/>/);
  assert.match(detail, /to={`\/agents\/\$\{id\}\/\$\{tabID\}` as never}/);
  assert.match(detail, /<DialogTrigger asChild>/);
  // Starting a room is billable, so the agent page creates it on the
  // organization's delegated path with a chosen key rather than sending a
  // command — and a key secret to — the agent.
  assert.match(detail, /await runRoomCommand\(\s*null,\s*"room\.create",/);
  assert.doesNotMatch(detail, /sendAndWait\("room\.create"/);
  assert.match(detail, /<BillingKeySelect\s+beamTemplate={beamTemplate}/);
  assert.doesNotMatch(detail, /await sendAndWait\("room\.list"\)/);
  assert.match(
    detail,
    /query: roomsQuery,[\s\S]*roomControlAvailable,[\s\S]*= useRoomsData\(\)/,
  );
  assert.match(detail, /room\.agent\?\.id === agentId/);
  assert.doesNotMatch(detail, /latestResult\(commands, "room\.list"\)/);
  assert.match(detail, /The agent will adopt it when connected/);
  assert.match(detail, /title="Revoke this agent\?"/);
  assert.match(detail, /title="Close this room\?"/);
  assert.doesNotMatch(detail, /window\.confirm/);

  for (const operation of [
    "tunnel.create",
    "destination.create",
    "endpoint.close",
    "room.create",
    "room.join",
    "room.leave",
    "room.close",
    "room.role.assign",
    "room.channel.create",
    "room.grant.put",
    "logs.snapshot",
    "logs.subscribe",
    "logs.unsubscribe",
    "metrics.snapshot",
  ]) {
    assert.ok(
      detail.includes(operation),
      `missing agent UI operation ${operation}`,
    );
  }

  for (const section of [
    "overview",
    "tunnels",
    "destinations",
    "rooms",
    "logs",
    "activity",
    "settings",
  ]) {
    const source = await readFile(
      new URL(`agents.$id.${section}.tsx`, routeRoot),
      "utf8",
    );
    assert.match(
      source,
      new RegExp(`createFileRoute\\("/agents/\\$id/${section}"\\)`),
    );
    assert.match(source, new RegExp(`tab="${section}"`));
    if (section === "tunnels" || section === "destinations") {
      assert.match(
        source,
        /if \(!studioEnv\.tunnelsEnabled\)\s*return <Navigate replace to={`\/agents\/\$\{id\}\/overview` as never} \/>/,
      );
    }
  }
});
