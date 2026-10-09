# BEAM Transfer Studio

Self-hosted transfer studio for Beam.

This repository is structured as a self-hosted TypeScript product with a
Studio UI, an HTTP API, an Action Dispatcher, Action Runners, an MCP
server, and a future Electron desktop app.

## Apps

- `apps/studio`: TanStack Start user interface.
- `apps/api`: synchronous HTTP API, authentication, CRUD, and commands.
- `apps/orchestrator`: Beam Studio Action Dispatcher, the durable asynchronous workflow state machine.
- `apps/worker`: Beam Studio Action Runner, the action and transfer executor.
- `apps/mcp-server`: MCP server exposing Beam tools to agents.
- `apps/desktop`: future Electron shell.

## Packages

- `packages/core`: product domain logic.
- `packages/db`: Drizzle schema, migrations, and repositories.
- `packages/vault`: local encrypted credential storage.
- `packages/shared`: shared schemas, types, and constants.
- `packages/ui`: shared React UI primitives.

Beam transfers run exclusively through the autonomous `@beam/transfer`
artifact resolved from the public Registry. Studio does not embed a Beam SDK
or a builtin transfer implementation.

## Self-hosting

Install on a Linux host with systemd, Docker Engine and Docker Compose v2:

```bash
export BEAM_STUDIO_PUBLIC_URL=https://studio.example.com  # the URL users open
curl -fsSL https://cdn.b1m.ai/studio/install.sh | sudo -E sh
```

A new installation serves nobody until it is claimed. The first run is:

1. open the Studio at `BEAM_STUDIO_PUBLIC_URL`;
2. sign in with Beam Auth;
3. claim the installation in **Settings → Access** (`/settings/access`) with
   the claim code the installer prints (`sudo beam-updater claim-code` prints
   it again);
4. choose the join policy and admit organizations there;
5. store an organization Beam API key under **Credentials**;
6. create rooms (from the Beam CLI until releases ship a Studio room consumer).

[First run](docs/self-update.md#first-run) gives the exact commands, including
how to print the claim code on the host, and a troubleshooting table for `421`,
`403`, `409` and `503` answers. [Self-update](docs/self-update.md) covers the
installer options, configuration, remote MCP access and updates.

## Architecture Notes

- [Workflow contracts and composition](docs/workflow-composition.md): frozen
  definitions, child calls and public outputs.
- [Workflow invocation billing](docs/workflow-billing.md): durable reservations,
  explicit retry attempts and asynchronous settlement recovery.

- [Desktop and hybrid execution](docs/desktop-hybrid-execution-architecture.md):
  Electron supervision, local and remote workers, subprocess isolation, and
  VPS deployment modes.
- [Self-update supervisor](docs/self-update.md): signed releases, the host
  updater, the systemd installer, database backups, and rollback behavior.
- [Agent control architecture](docs/agent-control-architecture.md): outbound
  WSS enrollment and direct control of standalone or worker-associated
  `beam-agentd` machines.

## UI Design Standards

- [Border radius scale](docs/studio-border-radius-standard.md): target radii,
  structural exceptions, shared tokens, and the deferred migration plan.
- [Table pages](docs/studio-table-pages-standard.md): layout and density rules
  for Studio collection pages.

## Local Development

Install dependencies. Runtime configuration is split into three ignored
profiles:

```bash
pnpm install
```

- `.env.local`: local machine and personal secrets; loaded by the existing
  development scripts.
- `.env.dev`: shared development configuration.
- `.env.prod`: production configuration; blank secrets must be injected by the
  deployment platform.

With the `rp` shell helper, every app follows
`rp <profile> pnpm dev:<app>`:

```bash
rp dev pnpm dev:stack
```

Docker Compose can select one directly:

```bash
BEAM_STUDIO_ENV_FILE=.env.dev docker compose up
BEAM_STUDIO_ENV_FILE=.env.prod docker compose up -d
```

For routine development, run only the process you need:

```bash
rp local pnpm dev:studio        # Vite studio
rp local pnpm dev:api           # Studio API
rp local pnpm dev:orchestrator  # orchestration service
rp local pnpm dev:worker        # transfer worker
rp local pnpm dev:mcp           # MCP server on MCP_SERVER_PORT, default 8766
rp local pnpm dev:desktop       # desktop shell
```

To start the Studio, API, orchestrator, and worker together:

```bash
rp local pnpm dev:stack
```

This command checks that the PostgreSQL target is reachable and starts a local
NATS JetStream server when port 4222 is not already in use. Install the local
server once with `brew install nats-server` if needed. The NATS process started
by the command is stopped with the application stack on `Ctrl+C`.

`rp local pnpm dev` starts all workspace dev tasks through Turbo. Use it when
you really want the whole stack running locally.

### Beam Studio PostgreSQL Target

`DATABASE_URL` points to the PostgreSQL `beam_studio` database:

```bash
DATABASE_URL=postgres://beam:beam@127.0.0.1:5432/beam_studio
ORCHESTRATION_DATABASE_MODE=postgresql
```

`BEAM_STUDIO_SECRET_KEY` is required in every environment, with no default and
no fallback. Services refuse to start without it, and refuse the placeholder
values this repository has shipped. Generate one with `openssl rand -hex 32`;
`pnpm dev:stack` writes one into `.env.local` for local development.

Agent control derives its token secret from that key, so
`BEAM_STUDIO_AGENT_TOKEN_SECRET` is optional and only needed to key agent tokens
separately.

### Rotating the vault key

`BEAM_STUDIO_SECRET_KEY` is the key new secrets are written under.
`BEAM_STUDIO_SECRET_KEY_RETIRED` is a comma-separated list of keys that may
still be read, and is empty except during a rotation. A retired key can never
encrypt. Both are held to the same standard — a placeholder or a short value is
refused wherever it appears, because a retired key an attacker knows is no
better than an active one.

Every ciphertext records the id of the key that wrote it: `HMAC(key,
"beam-studio.key-id.v1")`, truncated. The id is one-way, so it is safe in
`encryption_key_id`, in logs and in operator output. A value whose key is not on
the ring fails with that id named, rather than surfacing as a decryption error
that looks like corruption.

```bash
# 1. Keep the current key readable, and make a new one active.
BEAM_STUDIO_SECRET_KEY_RETIRED=$OLD_KEY
BEAM_STUDIO_SECRET_KEY=$(openssl rand -hex 32)

# 2. Restart every service, so nothing is still writing under the old key.
# 3. Re-encrypt everything under the new key.
pnpm --filter @beam-studio/api vault:rotate
```

The rotation is idempotent and resumable: a value already under the active key
is skipped, so an interrupted run is finished by running it again. It covers
`secrets.credential_versions`, `assistant.provider_settings`, webhook trigger
tokens in `workflow.triggers`, the legacy `public` API-key tables where the
optional orchestration chain created them, and the OAuth refresh-token files
under `~/.beam-studio/oauth-session.json.sessions/` — the last of these
being the easiest to forget and the one that signs every user out if it is.

**A key may be dropped from the retired list only when the rotation reports
`complete`.** That line means no stored value anywhere still needs it. The
command exits non-zero until then, so a pipeline cannot treat a partial rotation
as a finished one. A value no configured key can read is reported and left
untouched, never rewritten — the report going `INCOMPLETE` is what stops an
operator from dropping the key that would have read it. Before dropping a key,
also account for anything outside the live tables: queued worker task snapshots
holding an encrypted credential, superseded credential versions retained by
policy, and any database backup you might restore from, which was taken under
the key you are about to remove.

Signing secrets derived from the vault key — session cookies, agent tokens, the
operations token — are verified against every key on the ring, not just the
active one. A rotation therefore does not sign everyone out or 401 a configured
scraper; that happens when the old key is finally dropped, which is a deliberate
step rather than a side effect of changing a variable. Media tickets live 60
seconds and are not covered, because a client simply requests another.

A Studio Room consumer can bootstrap from only the Studio API URL and
`BEAM_STUDIO_SHARED_SECRET`. The API side also configures
`BEAM_STUDIO_CONSUMER_ORGANIZATION_ID`. Room browsing, room creation, quick-send,
and room-transfer workflows resolve their coordinator from the selected Beam
environment template. Studio creates key-bound, one-time Studio and
coordinator enrollments; the consumer redeems the coordinator enrollment
directly and persists its individual Beam credential.

For Docker Compose, the URL is built from `POSTGRES_PASSWORD` against the
in-network host `postgres:5432`. That variable has no default and is read by
Compose interpolation, so it belongs in the project-root `.env` or the shell:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
```

Compose refuses to start until it is set, rather than falling back to a shared
password. For a Homebrew/local PostgreSQL instance, set `DATABASE_URL` to a
local role that exists and owns the `beam_studio` database.

Create/apply the clean Beam Studio target schema and static catalogs with:

```bash
pnpm --filter @beam-studio/db db:studio:init
```

The older orchestration migration chain is still available while code paths are
being retired:

```bash
pnpm --filter @beam-studio/db db:pg:migrate
```

It no longer owns MCP tokens. Those live in `mcp.tokens` and `mcp.audit_events`,
which `db:studio:init` creates, so MCP authentication works on a database built
from the target schema alone. Every query used to name the tables unqualified,
which resolved to `public.*` tables that only this optional command created — so
whether the MCP plane authenticated at all depended on whether someone had run
it. The stale `public` pair is dropped when the target schema is applied.

The current cutover adapter preserves the existing synchronous repository API
while the orchestration SQL is moved to PostgreSQL-native repositories.

The MCP server binds to `127.0.0.1` by default and requires a database-backed
MCP token for every MCP request. Create, scope, expire, revoke, and audit tokens
from `/mcp`, then send one as `Authorization: Bearer <token>`.
The token creation result is shown once with copy and download controls. Store
it securely before dismissing the result; record listings expose only metadata,
and the token cannot be recovered from its stored hash.

### Beam authentication and account data

Studio is the public OAuth client `beam-studio` with scope `studio:access`; it
has no client secret. Production uses:

```bash
BEAM_AUTH_URL=https://auth.b1m.ai
BEAM_API_URL=https://api.b1m.ai
```

The local Studio API performs OAuth Device Authorization Grant calls against
`/oauth/device/authorize` and `/oauth/token`. The browser only receives the
user code, verification URLs, expiry, polling interval, and an opaque local
attempt ID. Approval is determined exclusively by polling; there is no popup
callback or browser message dependency.

Each browser has its own signed session cookie, OAuth access token, and rotating
refresh token. Multiple users can share one Studio API instance with independent
accounts and organization contexts. Device login attempts are also bound to the
browser that initiated them. Tabs in the same browser profile share cookies;
use separate profiles to connect different accounts on the same computer.

Short-lived access tokens remain in API-process memory. Each refresh token is
encrypted with the Studio vault, written owner-only, and atomically replaced in
its own file under `~/.beam-studio/oauth-session.json.sessions/`.
`BEAM_STUDIO_AUTH_STORE_PATH` changes the base path; `.sessions/` is appended to
it. Keep that directory and `BEAM_STUDIO_SECRET_KEY` stable across restarts.
The legacy single-session file is never loaded into browser sessions.

Authentication is deny-by-default. Every route declares a policy at
registration — `{ config: { auth: auth.read() } }` and friends from
`apps/api/src/auth/policy.ts` — and a route registered without one aborts
startup. Authentication used to be selected by testing the route path against
the `/studio/` prefix, which left every route outside it unauthenticated unless
its author remembered a check.

The kernel verifies session routes itself. Credentials that are checked against
per-resource state — capability tokens, agent proofs, MCP tokens, the webhook
trigger secret — stay verified in their handler, and the kernel holds those
routes to a proof obligation: a success response from one that never recorded an
accepted credential is turned into a 500.

The unauthenticated surface is pinned in
`apps/api/src/auth/public-routes.snapshot.ts` and asserted by
`apps/api/src/auth/kernel.conformance.test.ts`. It is currently five routes:
`/health`, `/studio/health`, `/studio/contracts`, and the two auth routes that
must work before anyone is signed in — starting a device grant, and logout.

Every Studio business request requires a browser session and an organization
verified against that account's Beam memberships. Unknown organizations and
projects are rejected; missing organization context never means all tenants.
There is no development bypass. `BEAM_STUDIO_AUTH_BYPASS` used to fabricate a
`SUPERADMIN` principal with no organization verification, which made
`services` nullable and was the one path where the invariant above did not
hold. It is removed, so the membership check is unconditional.

For local development, sign in normally against a Beam instance by pointing
`BEAM_AUTH_URL` and `BEAM_API_URL` at it. Tests inject a session through
`StudioSessionManager`'s `createServices` seam, which exercises the real
verification path rather than skipping it.

Logout revokes and clears only the current browser's tokens, including when
remote revocation fails. Old shared-session cookies are rejected: existing users
must sign in again after upgrading. Other OAuth migration details are in
[`AUTH_OAUTH_MIGRATION.md`](./AUTH_OAUTH_MIGRATION.md).

MCP production controls:

```bash
MCP_SERVER_URL=http://localhost:8766/mcp
MCP_CORS_ORIGINS=http://localhost:3000,https://studio.example.com
MCP_AUTH_RATE_LIMIT_PER_MINUTE=60
MCP_TOKEN_RATE_LIMIT_PER_MINUTE=120
```

`MCP_CORS_ORIGINS` has no fallback: unset allows nothing cross-origin. It used
to default to `*`, which on a server that binds loopback by default is the
configuration a DNS-rebinding attack wants. MCP clients are not browsers and
send no `Origin`, so they are unaffected. A wildcard is still possible, but has
to be asked for.

A disallowed `Origin` is refused for every method, not only the preflight — a
cross-origin `POST /mcp` used to run the tool call regardless.

Studio API CORS controls:

```bash
STUDIO_CORS_ORIGIN=https://studio.example.com,http://localhost:3004
STUDIO_CORS_ALLOW_TUNNEL_ORIGINS=true   # local development only
```

`STUDIO_CORS_ORIGIN` is the complete list of origins that receive
`Access-Control-Allow-Credentials`. In production it has no fallback: if it is
unset, no cross-origin request is credentialed. Outside production it defaults to
the local Studio ports. The deployment script sets it from the service's public
URL, so deployed environments are always explicit.

`STUDIO_CORS_EXTRA_ORIGINS` adds further origins to that list at deploy time. A
Studio app can be reachable on more than the one domain the deployment script
manages, because a deployment platform may keep additional bindings that were
added separately; each of those hosts must be named here.

`STUDIO_CORS_ALLOW_TUNNEL_ORIGINS` additionally trusts `*.sslip.io` origins for
local tunnel work. sslip.io resolves whatever IP is embedded in the hostname, so
anyone can serve a page from a name under it — trusting the suffix is equivalent
to allowing every origin, with credentials. It is therefore opt-in, and it is
ignored when `NODE_ENV=production`.

`Access-Control-Allow-Private-Network` is returned only for a preflight that
actually sends `Access-Control-Request-Private-Network`.

Every HTTP listener validates `Host` against `BEAM_STUDIO_ALLOWED_HOSTS` before
routing, and refuses an unlisted name with `421`. See **Network exposure** for
why loopback names and IP literals need no entry.

`/agent-control/v1/connect` applies the inverse rule. It is a machine endpoint
authenticated by a bearer token, which a browser cannot set on a WebSocket, and
browsers always send `Origin` on a handshake while native clients never do — so
a handshake carrying an `Origin` at all is refused.

The session cookie's `Secure` attribute follows the request scheme, including
`X-Forwarded-Proto` from a terminating proxy, rather than `NODE_ENV`.
`BEAM_STUDIO_SECURE_COOKIES` still overrides it either way.

### Studio AI Assistant

Configure the Studio assistant from **Settings → BEAM AI**. Studio sends model
catalog and chat-completion requests to `${BEAM_API_URL}/api/ai/v1` with the
short-lived `beam-studio` OAuth access token. Completion requests also include
the selected `X-Organization-Id`, so the Beam API can authorize membership,
enforce organization credits, and account for SayGM usage.

The upstream SayGM credential stays in the Beam API and is never stored by
Studio. Studio persists only the user's selected model (shared by chat,
copilot, and operation plans) and its model-catalog cache. A model can still be
overridden from the chat composer.

### Beam environment templates

Studio defaults to the built-in PROD Beam template. When
`BEAM_STUDIO_DEV_SETTINGS_ENABLED` is unset or `false`, the UI hides Beam
environment controls and the API ignores browser-provided template overrides
for room operations. Public/customer deployments therefore use PROD
BeamCore, coordinator, Control NATS, Auth, API, and Registry targets by default.

A deployment that needs the DEV template sets `BEAM_STUDIO_DEV_SETTINGS_ENABLED=true`.
General Settings then shows Beam environment templates. The built-in `prod`
template is always present, deployment-owned, and remains the default; the
built-in `dev` template is available for development work, and operators can
add or edit non-PROD templates by stable key. A template contains only its key,
name, and Beam endpoint URLs. Screens that need Beam room context select a
template, not raw endpoint URLs. The database migration rewrites existing
room-transfer workflows from `environment` to `environmentTemplateKey` so they
continue targeting the same Beam fleet. Room-transfer configs contain no endpoint
URL; the API resolves the selected template at command time. Studio validates
configs against the locked Registry manifest both when saving and before any
manual, event, scheduled, or child workflow run is queued.

`BEAM_DEFAULT_REGISTRY_URL` owns the built-in PROD template's Registry endpoint.
`BEAM_ACTION_REGISTRY_URL` independently selects the catalog used to install
workflow actions. A deployment can install from a different Registry while
keeping the PROD template's endpoints unchanged. Existing
workflow locks retain their immutable artifact URLs and checksums; changing
the installation catalog does not retarget or reinstall them.

## Developer Workflow

The normal inner loop is edit, then run targeted checks for the touched package. Do not run a full build after every code change; reserve `pnpm build` for release, Docker, or broad integration verification.

Common targeted checks:

```bash
pnpm --filter @beam-studio/studio lint
pnpm --filter @beam-studio/api lint
pnpm --filter @beam-studio/orchestrator lint
pnpm --filter @beam-studio/worker lint
pnpm --filter @beam-studio/mcp-server lint
pnpm --filter @beam-studio/shared lint
pnpm --filter @beam-studio/core lint
pnpm --filter @beam-studio/vault lint
```

Run the worker scheduler tests when changing queueing, locking, retry, dead-letter, scheduling, cancellation, or worker heartbeat behavior:

```bash
pnpm --filter @beam-studio/worker test
```

Some app packages consume workspace packages through generated `dist` output. If you add or change exported types/functions in a shared package and a dependent package cannot resolve them, refresh just that package:

```bash
pnpm --filter @beam-studio/shared build
pnpm --filter @beam-studio/core build
pnpm --filter @beam-studio/vault build
```

Use root scripts for broad checks only when the change crosses many packages:

```bash
pnpm lint
pnpm typecheck
pnpm build
```

## Web Studio Pages

- `/login`: starts the unified Beam Auth device flow, opens the Beam Auth authorization URL, shows the studio code, polls the local auth token endpoint, and returns to the requested callback URL after login.
- `/dashboard`: shows the operational summary for transfers, schedules, runs, and endpoints; links to CSV export; surfaces recent transfer templates, recent runs, and execution logs; allows launching a transfer immediately.
- `/transfers`: lists and filters transfer templates by name and state; shows the selected transfer details; provides tabs for overview metrics, endpoint management, run history, and transfer settings; supports enable/disable, run now, update, delete, and endpoint create/delete actions.
- `/transfers/new`: creates a new transfer template bound to a Beam API key, with description, frequency, transfer type, parallelism, notification targets, enabled/test/progressive options.
- `/transfers/[id]`: redirects to `/transfers?jobId=[id]` so direct transfer links open the selected template in the studio view.
- `/runs`: lists execution runs with transfer/status filters, CSV export, status badges, timestamps, and error summaries.
- `/runs/[id]`: shows one run in detail, including status metrics, transfer records, Beam transfer IDs, errors, execution logs, CSV export, and cancel action.
- `/schedules`: lists recurring schedules with transfer, frequency, status, next run, updated time, pause/enable action, delete action, and create schedule entry point.
- `/schedules/new`: creates a recurring schedule for an existing transfer template, with frequency, next run timestamp, and enabled state.
- `/schedules/[id]`: shows one schedule in detail with status, next run, update metadata, open-transfer shortcut, pause/enable, and delete actions.
- `/api-keys`: syncs organization API keys from the Beam API, displays organization and local keys, warns when sync fails, and allows adding or deleting local keys.
- `/credentials`: manages local provider credentials in the encrypted vault, including provider kind, JSON payload storage, preview, updated time, and deletion.
- `/settings`: displays runtime configuration, database URL/resolved path, transfer/run counts, and Beam default URLs.
- `/settings/access`: claims an unclaimed installation with its claim code; for the owning organization, sets the join policy (closed, request to join, open), admits pending organizations and revokes admitted ones.
- `/mcp`: manages MCP agent access with endpoint snippets, health status, scoped and expiring tokens, exposed tools/resources, token usage summaries, and recent audit activity.

## MCP Client Access

Create a token from `/mcp`, copy it once, then configure an MCP client with the
server URL and bearer header:

Local environments use `http://localhost:8766/mcp`. A self-hosted install
publishes MCP on the host's loopback only; see
[Remote MCP access](docs/self-update.md#remote-mcp-access) to reach it from
another machine.

```json
{
  "mcpServers": {
    "beam-studio": {
      "url": "http://localhost:8766/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
```

Available scopes:

- `read:runs`: read run status, recent runs, and Beam transfer status.
- `read:transfers`: read transfer templates exposed as resources.
- `read:credentials`: list provider credentials with safe previews.
- `read:api_keys`: list Beam API key metadata without secrets.
- `write:transfers`: create transfer templates.
- `run:transfers`: queue transfer templates.
- `write:schedules`: create recurring schedules.
- `cancel:runs`: cancel queued or running runs.

A token request must name at least one scope, and every name must be recognised.
An unknown scope is rejected with `400 mcp_scopes_invalid` naming the offending
value; it is never dropped from the request, because silently filtering a
misspelled scope grants something other than what was asked for.

### Driving Studio with a token

The same token authenticates machine callers against the HTTP API, not only the
MCP surface, so a script or CI job can create and run workflows and transfers,
manage schedules and credentials, and read runs and dashboards:

```bash
curl -H "Authorization: Bearer beam_mcp_..." https://studio.example.com/studio/runs
```

The token's organization must be listed as admitted in **Settings → Access**,
on the API and on the MCP server alike; otherwise the call is refused with
`403 instance_organization_forbidden`. An open join policy does not admit a
token on its own.

A route grants this only when it can honour it. Roughly half the Studio surface
does. The rest needs the signed-in user's Beam session — the assistant, the AI
settings, the account and context routes, and everything under rooms and agents,
which obtain coordinator delegation with the user's own bearer. A token has no
session to delegate, so those stay browser-only rather than silently doing
something weaker.

The MCP token admin routes are excluded on purpose: a token must not be able to
mint another one.

The organization comes from the token, never from a request header, so a token
cannot be pointed at another tenant. A scope the route requires but the token
was not issued gets `403 machine_scope_required:<scope>`.

Beam is asked whether that organization is still active, using the
organization's own stored Beam API key — the only credential Studio holds that
speaks for an organization with nobody signed in. If Beam rejects it, the token
gets `403 machine_token_organization_revoked` even though the token itself is
unexpired. Answers are cached for five minutes, and a recent success is
honoured for thirty while Beam is unreachable, so an upstream blip does not
lock every machine caller out at once.

This verifies the organization, not that the token's issuing user is still a
member: checking the user needs a credential that speaks for the user, and a
token has none. When Studio holds no key for the organization, or key
verification is not configured, the check is skipped rather than failed — the
token's own expiry and revocation remain the control.

### MCP tools and resources

Each tool and resource requires the scopes listed below, as defined in
`MCP_TOOL_SCOPE_REQUIREMENTS` and `MCP_RESOURCE_SCOPE_REQUIREMENTS` in
`packages/shared/src/mcp.ts`. A call without them fails with
`MCP token is missing required scope: <scope>`. MCP uses only the eight scopes
listed above. This includes the workflow and room tools, which require the
transfer and run scopes. The other token scopes (`read:workflows`,
`write:workflows`, `run:workflows`, `read:schedules`, `write:credentials`,
`read:rooms`, `write:rooms`, `read:agents`, `read:registry`, `read:settings`,
`read:dashboard`) only gate HTTP API routes (see
[Driving Studio with a token](#driving-studio-with-a-token)).

Resources:

| Resource                    | Required scope   | Content                     |
| --------------------------- | ---------------- | --------------------------- |
| `beam://recent-runs`        | `read:runs`      | The 20 most recent runs     |
| `beam://transfer-templates` | `read:transfers` | Up to 50 transfer templates |

Workflow and room tools. The MCP server forwards these to the API at
`POST /mcp/workflows/<tool>` (`BEAM_STUDIO_API_URL`). The API checks the token
and its scopes again.

| Tool                              | Required scope    | Purpose                                                                 |
| --------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `beam.list_rooms`                 | `read:transfers`  | Discover rooms, object channels, memberships and agents in a template   |
| `beam.list_room_storage_members`  | `read:transfers`  | List the object-storage bucket memberships of a room                    |
| `beam.attach_room_storage_member` | `write:transfers` | Attach a bucket from a Studio credential to a room object channel       |
| `beam.update_room_storage_member` | `write:transfers` | Change a bucket member's source delegates and destination behaviour     |
| `beam.remove_room_storage_member` | `write:transfers` | Remove a bucket membership from a room                                  |
| `beam.create_room_workflow`       | `write:transfers` | Create a room workflow from an enrolled agent's local file (idempotent) |
| `beam.create_workflow`            | `write:transfers` | Create a workflow template                                              |
| `beam.get_workflow`               | `read:transfers`  | Read a workflow graph and its frozen action locks                       |
| `beam.update_workflow_graph`      | `write:transfers` | Replace a workflow graph, with the same validation as Studio            |
| `beam.run_workflow`               | `run:transfers`   | Run a workflow through the normal credit and execution gates            |
| `beam.retry_workflow_run`         | `run:transfers`   | Retry a failed or cancelled workflow run                                |
| `beam.get_workflow_run`           | `read:runs`       | Inspect steps, members, tasks, attempts, artifacts and failure causes   |
| `beam.cancel_workflow_run`        | `cancel:runs`     | Request cancellation of a workflow run                                  |

Transfer tools, answered by the MCP server from the Studio database:

| Tool                       | Required scope     | Purpose                                                       |
| -------------------------- | ------------------ | ------------------------------------------------------------- |
| `beam.list_api_keys`       | `read:api_keys`    | List Beam API key metadata; secrets are never returned        |
| `beam.list_credentials`    | `read:credentials` | List provider credentials with a safe payload preview         |
| `beam.create_transfer`     | `write:transfers`  | Create a transfer template                                    |
| `beam.run_transfer_now`    | `run:transfers`    | Queue a transfer template for immediate execution             |
| `beam.schedule_transfer`   | `write:schedules`  | Create a recurring schedule for a transfer template           |
| `beam.cancel_run`          | `cancel:runs`      | Cancel a queued run or request cancellation of a running one  |
| `beam.get_run_status`      | `read:runs`        | Read a run's status, transfer rows and recent logs            |
| `beam.get_transfer_status` | `read:runs`        | Read the latest recorded status for a Beam transfer ID or run |
| `beam.list_recent_runs`    | `read:runs`        | List recent runs, optionally filtered by transfer or status   |

## Network exposure

Studio is installed on machines its operator controls, so every service binds
`127.0.0.1` unless told otherwise, and only the Studio web server is expected to
be told otherwise. Containers set `0.0.0.0` explicitly, because there the
container network is the boundary; what matters then is which ports are
*published*.

| Listener | Bind variable | Default | Published |
| --- | --- | --- | --- |
| studio 3004 | `HOST` | `0.0.0.0` | yes |
| api 8787 | `API_BIND_HOST` | `127.0.0.1` | loopback |
| mcp 8766 | `MCP_SERVER_HOST` | `127.0.0.1` | loopback |
| orchestrator 8788 | `ORCHESTRATOR_BIND_HOST` | `127.0.0.1` | no |
| worker observability 8790 | `WORKER_OBSERVABILITY_BIND_HOST` | `127.0.0.1` | no |
| worker file server 8791 | `WORKER_FILE_SERVER_HOST` | `127.0.0.1` | no |
| postgres, nats | — | — | no |

`BEAM_STUDIO_ALLOWED_HOSTS` lists the DNS names this installation answers to.
Loopback names, IP literals and single-label names are always accepted, so an
install reached at `http://<ip>:3004` needs no configuration, and services
addressing each other as `http://api:8787` over the container network keep
working — an IP `Host` cannot be produced by
DNS rebinding. A DNS name has to be listed, otherwise a rebound name could drive
the local install from a page the operator happens to visit. The installer
derives it from `BEAM_STUDIO_PUBLIC_URL`; the deploy script derives it from the
public URLs it already declares.

### The Studio API proxy

`/__studio_api/*` forwards to `STUDIO_API_PROXY_TARGET`, which has no default —
unset disables it. The Studio SPA uses it only when the API URL baked into the
bundle is a loopback address and the page is not, which is the client-run
install where the API is deliberately bound to `127.0.0.1`. The hosted
deployment builds against the public API URL and calls it cross-origin instead,
so it is not configured with a target at all.

Because the proxy is a path into the API, it requires positive evidence that the
caller is the Studio SPA on the Studio origin: `Sec-Fetch-Site: same-origin` for
HTTP, and an `Origin` equal to the page's own for the WebSocket upgrade, where
browsers always send one and CORS does not apply. It also replaces any inbound
`x-forwarded-*` rather than passing it through, so a caller cannot choose what
the API's rate limits and audit records see.

### Operational endpoints

`/metrics`, and the orchestrator's `/ready`, `/workers/load` and
`/commands/publication`, expose operational data rather than tenant data, so
they take a single deployment-wide credential instead of a session or a scoped
token. It is derived from `BEAM_STUDIO_SECRET_KEY`
(`HMAC-SHA256(key, "beam-studio.ops.v1")`, base64url) rather than being its own
variable: a new variable would have to be threaded through `.env.example`, both
Compose files, the release template, the installer, the deploy script and the CI
secrets, and any service that missed it would fail closed at an awkward hour.
Rotating the key rotates the token.

`/health` stays open to callers from inside the container, because every Docker
and deployment-platform healthcheck fetches `http://127.0.0.1:<port>/health` from there. No
healthcheck command changes.

The orchestrator has no public domain. It serves worker load and command
publication state, which nothing outside the deployment needs; other services
reach it over the internal network.

### Logging

The api, orchestrator, worker and mcp services write JSON logs (pino) to
stdout at the level in `LOG_LEVEL` (`fatal`, `error`, `warn`, `info`, `debug`,
`trace` or `silent`; default `info`). An unknown value falls back to `info`
with a warning rather than stopping the service.

The API writes one `request completed` line per request, with method, route,
path, status, error `code`, duration and correlation id. Writes are `info`,
4xx responses `warn` and 5xx `error`; successful reads are `debug`, because
the Studio UI polls, and `/health`, `/studio/health` and `/metrics` are only
logged when they fail. Credential headers, cookies, API keys, tokens,
credential payloads, request bodies and secret path or query values are
redacted at every level. The shared redaction list is
`packages/shared/src/logging.ts`.

### Workflow webhook triggers

`POST /hooks/workflows/:workflowId/:triggerId/:token` starts a workflow run, and the
token in the path is the whole credential. It stays in the path deliberately: senders
such as Salesforce Flows cannot reliably set custom headers.

Because a run costs credits, each trigger is rate limited — 120 deliveries per minute by
default, `rateLimitPerMinute` on the trigger config to change it. Exceeding it returns
`429` with `Retry-After`. The count lives in `workflow.webhook_deliveries` rather than in
process memory, so it survives a restart and applies across the API's replicas; the same
statement prunes the window it just counted.

A bad token and an unknown trigger remain deliberately indistinguishable, both `404`.

#### Signed bodies

A path token says nothing about the body, so a captured request replays forever. A
trigger may therefore require an HMAC, enabled with "Require a signed body" or
`requireSignature` on the trigger config. It is off by default, because requiring a
header would break exactly the senders the path token exists for.

The sender sends two headers:

```text
X-Beam-Timestamp: 1758844800
X-Beam-Signature: v1=<hex HMAC-SHA256 of "v1:<timestamp>:<raw body>">
```

The key is the trigger's signing secret, shown next to the webhook URL once the trigger
is saved. It is derived from `BEAM_STUDIO_SECRET_KEY`, the trigger id and the token, so
nothing extra is stored and rotating the secret URL rotates the signing secret with it.

The timestamp is inside the signed string, so a captured request cannot be moved into
the acceptance window. It must be within 300 seconds of the server clock, and a
signature already spent is refused — `workflow.webhook_deliveries` holds a partial
unique index on `(trigger_id, signature)`, and rows are retained for the signature
window rather than the shorter rate window so the proof is still there.

A rejected signature answers `401` with a `details.reason` of `missing`, `malformed`,
`stale`, `mismatch` or `replayed`. That is deliberately distinguishable from the `404` a
bad token gets: the caller has already proven it holds the token, and a customer wiring
up HMAC has to be told which part is wrong.

The route keeps the body bytes exactly as received. Re-serialising the parsed JSON would
produce a different string and reject every sender whose formatting is not byte-identical
to ours, so the `/hooks/*` route is registered in its own Fastify scope with a
content-type parser that retains the raw buffer.

The token is encrypted with the Studio vault at rest, like every other secret Studio
stores, so a read of `workflow.triggers.config_json` no longer yields a working
credential. It cannot be hashed instead: the token _is_ the URL, so Studio has to be able
to show it again. A token that does not decrypt — a lost or rotated
`BEAM_STUDIO_SECRET_KEY` — never authorizes a run, and the trigger has to be re-saved to
mint a new one. Rows written before this are converted in place at boot by
`encryptPlaintextWebhookTokens`, keeping each token's value so configured senders keep
working.

Trigger tokens are no longer regenerated when read. A stored token that failed validation
used to be replaced on every read, so the webhook URL Studio displayed differed each time
and never matched the stored one — silently breaking the URL configured upstream.

`JsonPanel` redacts secret-shaped keys, so neither a trigger's live token nor its signing
secret is rendered into the run and workflow views where it would reach screenshots and
support sessions.

## Deployment

Studio self-hosts with Docker Compose. Copy `.env.example`, set the values it
marks as required, and bring the stack up with `docker compose up -d`. See
[docs/self-update.md](docs/self-update.md) for the installer and updater.

A deployment defaults Beam environment endpoints to PROD:
`BEAM_DEFAULT_BASE_URL=https://beamcore.b1m.ai`,
`BEAM_DEFAULT_COORDINATOR_URL=https://coordinator.b1m.ai`,
`BEAM_DEFAULT_NATS_URL=tls://orch-gateway.b1m.ai:4222`, and `BEAM_ENV=prod`.
The DEV BeamCore target is available through the dev-only template selector.
Studio freezes standard Beam transfer target defaults when creating the root run.
Action Runners apply explicit step config, then the selected credential's frozen
connection metadata, then the frozen deployment defaults. Retries and child calls
keep that snapshot. Configure the API and Action Dispatcher with the Beam defaults;
Action Runner deployment changes cannot redirect an existing run. Room browsing, room creation, quick-send, and room-transfer action
configs resolve their coordinator through Beam environment templates. Internal
host-local health checks may still probe coordinator
processes directly, but Studio bootstrap and room-consumer enrollment must
receive public HTTPS coordinator URLs outside loopback.

Room control has no static credential. User-initiated requests obtain their
coordinator delegation with the user's Beam Auth session bearer. Work without a
user session (V3 resolution, execution authorization, Web Agent controller
provisioning, transfer evidence, storage jobs, consumer bootstrap, MCP) uses an
organization Beam API key that Studio already stores: the run's execution key or
the storage job's key when available, otherwise the organization's default
billing key. The coordinator verifies the key with the Beam API.
Without any stored organization key, room control reports
`room_authority_key_unavailable`.

Workflows may optionally share a room with their actions and nested workflows;
without a workflow room, room-transfer actions retain their own selection. See
[Workflow room context](docs/workflow-room-context.md) for inheritance and live
execution authorization. Both Dispatcher and Runners need `BEAM_STUDIO_API_URL`.


## Studio UI Setup

The Studio app uses TanStack Start, Tailwind CSS, and shadcn-style components.
Keep its Vite, Tailwind, and UI configuration scoped to `apps/studio`.

Verify Studio UI changes with:

```bash
pnpm --filter @beam-studio/studio lint
pnpm --filter @beam-studio/studio typecheck
```

## Docker

Docker Compose runs the Studio, API, MCP server, orchestrator, PostgreSQL, NATS,
and three worker containers:

```bash
BEAM_STUDIO_ENV_FILE=.env.dev docker compose up --build
```

- Studio: http://localhost:3004
- API: http://localhost:8787
- MCP: http://localhost:8766/mcp
- Orchestrator: http://localhost:8788
- Workers: `worker-1`, `worker-2`, and `worker-3`, no exposed ports

PostgreSQL and NATS publish no host ports. Services reach them over the Compose
network by service name, so a host mapping would only widen the database and the
task stream to anything that can route to the machine. Reach them through the
container instead:

```bash
docker compose exec postgres psql -U beam beam_studio
docker compose exec nats nats-server --help
```

Each app under `apps/` has its own Dockerfile. The compose file builds the
`studio`, `api`, `mcp`, `orchestrator`, and `worker` images from those app
Dockerfiles.

Initialize the PostgreSQL target schema when starting with a fresh database:

```bash
docker compose run --rm api pnpm --filter @beam-studio/db db:studio:init
```

`BEAM_STUDIO_SECRET_KEY` and `POSTGRES_PASSWORD` have no defaults. Compose reads
both by interpolation and refuses to start until they are set, so neither a
published placeholder nor a shared password can reach a running stack:

```bash
{
  echo "BEAM_STUDIO_SECRET_KEY=$(openssl rand -hex 32)"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
} >> .env
```

This no longer depends on `NODE_ENV`. Keying the check on it meant the guard was
off wherever the value happened to be `development`.

Room file automation is documented in
[Room transfer workflows](docs/room-transfer-workflows.md), including DEV/PROD
selection, API/MCP operations, deployment dependencies, and Phase 2 verification.

## License

Released under the [MIT License](LICENSE).
