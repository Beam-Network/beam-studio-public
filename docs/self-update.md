# Beam Studio self-update

Beam Studio updates separate three responsibilities:

- `https://cdn.b1m.ai/studio/latest.json` is the production signed control plane;
- the host `beam-updater` service is the execution plane;
- digest-addressed images in GHCR are the data plane.

The CDN contains only `install.sh` and `latest.json`. The control plane is
declarative: it cannot inject commands, services, volumes, or arbitrary Compose
content. The updater owns the deployment template and is the only component
allowed to invoke Docker on the host.

## Supported installation target

The first implementation supports:

- Linux with systemd;
- Docker Engine and Docker Compose v2;
- `amd64` and `arm64`;
- one Beam Studio installation per host;
- the signed `stable` release channel;
- manual update installation, with automatic recovery and rollback.

macOS is not a supported installation host: the installer requires Linux
systemd services. Run it on a Linux host or VM, not in a macOS terminal.

No Coolify, Portainer, Watchtower, public updater API, or GitHub repository
access is required to pull the public runtime packages. Externally managed
deployments do not run this self-update path.

## Install

After the stable control plane has been published:

```bash
curl -fsSL https://cdn.b1m.ai/studio/install.sh | sudo sh
```

The installer requires Docker Engine, Docker Compose v2, `curl`, systemd, and
standard Linux utilities. It installs missing `jq` and OpenSSL packages with
`apt-get`, `dnf`, `yum`, or `zypper`. Docker and Compose must already be installed.

The installer uses the `stable` channel and does not prompt. When
`/etc/beam-studio/updater.json` already exists, a rerun keeps the installed
channel.

Useful installation overrides:

```bash
export BEAM_STUDIO_PUBLIC_URL=https://studio.example.com
export BEAM_STUDIO_CHANNEL=stable
export BEAM_STUDIO_CDN_BASE_URL=https://cdn.b1m.ai/studio
curl -fsSL "$BEAM_STUDIO_CDN_BASE_URL/install.sh" | sudo -E sh
```

The updater shows one loading indicator per image while Docker pulls it, then
marks each image complete. When output is redirected, progress is printed once
per image without animated terminal control characters.

The installer defaults to `https://cdn.b1m.ai/studio`. An explicit
`BEAM_STUDIO_CDN_BASE_URL` overrides that default for local or isolated
testing.

The installer is idempotent. It preserves an existing
`/opt/beam-studio/.env`, installs the pinned release public key, extracts the
host updater and its compatible Compose template from the updater OCI package,
and asks the updater to apply the selected signed release. Continue with
[First run](#first-run): a new installation serves nobody until it is claimed.

### Public packages and authenticated rollback

Current releases use the public `beam-studio-runtime-web`,
`beam-studio-runtime-api`, `beam-studio-runtime-mcp`,
`beam-studio-runtime-action-runner`, `beam-studio-runtime-action-dispatcher`,
`beam-studio-runtime-room-consumer` and `beam-studio-runtime-updater` packages. These can be pulled anonymously by
digest. PostgreSQL and NATS also use public, digest-pinned images.

Earlier private packages and their release digests are retained for historical
installations and authenticated rollback. Read-only registry credentials for
them are supplied out of band as `BEAM_STUDIO_REGISTRY_USERNAME` and
`BEAM_STUDIO_REGISTRY_TOKEN`. The installer passes the token to `docker login`
through standard input and stores Docker credentials under
`/etc/beam-studio/docker`, protected by a root-only directory. It never writes
the token to Studio `.env`, updater configuration/state, process arguments, CDN
objects, or logs. Remove them afterwards with:

```bash
sudo docker --config /etc/beam-studio/docker logout ghcr.io
```

## First run

A fresh installation serves nobody until a team claims it. Follow these steps
in order after the installer reports `Beam Studio is installed`.

### 1. Open the Studio

Open the URL the installer prints as `Studio URL:`, which is
`BEAM_STUDIO_PUBLIC_URL` (default `http://localhost:3004`). On a remote host
installed with the default, open `http://<server-ip>:3004`: IP literals are
always accepted in `Host`. A DNS name must be listed in
`BEAM_STUDIO_ALLOWED_HOSTS`, otherwise every service answers `421`. The
installer derives that list from `BEAM_STUDIO_PUBLIC_URL`, so set the public
URL at install time (see [Install](#install)).

### 2. Sign in

On `/login`, choose **Continue with Beam Auth**, then approve the code Studio
shows at the Beam Auth verification URL. This pairs the browser session with
your Beam account; Studio has no accounts of its own.

On an unclaimed installation sign-in succeeds, but every request outside the
claim flow is refused with `403 instance_unclaimed`. On a claimed installation, an
account with no admitted organization is refused at sign-in: Studio shows
**This Studio is private** (`instance_private`) or **Waiting for the owner to
admit your organization** (`instance_join_pending`).

### 3. Claim the installation

Open **Settings → Access** (`/settings/access`), choose the Beam organization
that will own this Studio, enter the claim code and select **Claim this
Studio**. Beam must confirm that you belong to the organization you choose.
The first successful claim wins; a later one answers
`409 instance_already_claimed`.

The claim code is not stored anywhere. It is derived from
`BEAM_STUDIO_SECRET_KEY` in `/opt/beam-studio/.env`
(`packages/shared/src/instance-claim.ts`), and the installer prints it at the
end of an install, and of a rerun, for as long as the installation is not
claimed:

```text
Claim code: ABCD-EFGH-JKLM-NPQR
  Needed once: open https://studio.example.com/settings/access, sign in, and enter it to claim this Studio.
  Print it again with: sudo beam-updater claim-code
```

To print it again later, run on the host:

```bash
sudo beam-updater claim-code
```

The updater asks the running `api` container, which holds the same key the API
checks against, so the code it prints is always the one the claim accepts
(the command runs `/app/apps/api/dist/ops/instance-claim-code-cli.js` there).
On an installation that is already claimed it still prints the code, with a
note that it is no longer accepted.
Before any release is installed (the installer stopped before its first
`apply`, for example), there is no `api` container to ask, and the command
exits with `Beam Studio is not installed yet; run the installer first`.

The code goes to the terminal only. When the installer's output is not a
terminal (cloud-init, CI, a redirect), which would keep it in a log, the
installer shows the command above instead of the code.

Case and hyphens do not matter when you type the code. A code derived from a key in `BEAM_STUDIO_SECRET_KEY_RETIRED`
is accepted too, so a code written down before a key rotation keeps working
until that key is dropped. A wrong code answers `403 claim_code_invalid`. Treat
the code like the key it comes from: anyone who has it and a Beam account can
claim an unclaimed installation.

**Installations that were already in use.** A database that already had
organizations when it was upgraded to a release with instance access starts
`adopted` rather than `unclaimed`: it keeps serving those organizations, with
the join policy set to open, until someone claims it. Claiming it needs no code
when you choose an organization it already serves; do it right after the
upgrade.

Claiming an adopted installation does **not** close it. The join policy stays
`open`, so any Beam organization still admits itself on first use, until you
change it. Right after claiming, set **Who may join** to **Closed** or
**Request to join** in **Settings → Access** (see
[Decide who may use it](#4-decide-who-may-use-it)).

Until it is claimed:

- `/studio/updates/*` (**Settings → Beam Studio updates**) and every change in
  **Settings → Access** answer `403 instance_admin_required`, because nobody
  owns the installation.

Everything else keeps working, MCP included: the MCP server and the API apply
the same admission rules, so a token of an adopted organization is served on
port `8766` exactly as it is by the API. Adopted organizations are recorded as
admitted, so their tokens, agents and webhook triggers keep working. An
organization that first signed in after the upgrade is admitted only by the
open policy: its browser sessions work, but its machine callers (tokens,
agents, webhook triggers) are refused until it is admitted explicitly (see
[Machine callers](#machine-callers-tokens-agents-and-webhooks)).

Adoption admits whatever organizations already used the installation, so review
the **Organizations** list after claiming.

**Recovering ownership.** `BEAM_STUDIO_OWNER_ORGANIZATION_ID` sets the owner
when the API starts. It is a recovery lever for a claim that went to the wrong
organization, or an owning team that is gone. Set it in
`/opt/beam-studio/.env` to the right organization's ID and recreate the
containers ([Changing the configuration](#changing-the-configuration)). At each
API start it does exactly this:

| State it finds                    | What it does                                                                                                                                                                                                                         | API log                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `unclaimed` or `adopted`          | Claims the installation for the organization, without a code                                                                                                                                                                         | warn `Instance claimed for <org> by BEAM_STUDIO_OWNER_ORGANIZATION_ID`                                             |
| Claimed by another organization   | Moves ownership the same way the transfer API (`POST /studio/instance/access/transfer`) does, in one transaction: the previous owner becomes an admitted member (it keeps its access), then the named organization becomes the owner | warn `Instance ownership moved from <old> to <new> by BEAM_STUDIO_OWNER_ORGANIZATION_ID`                           |
| Claimed by the named organization | Nothing, and writes nothing. If that organization's own row was revoked, demoted or deleted, it is restored as admitted owner                                                                                                        | info `... already owns this instance; the variable can be unset` (warn `Owner row of <org> restored` for a repair) |

The named organization does not need to be admitted first; it is admitted as
owner, even if it was revoked. That is the "claim went to the wrong
organization" case: the right one has usually never been let in. The lever
never changes the join policy.

If it cannot be applied (the database refuses the write, for example), the API
logs an error, `BEAM_STUDIO_OWNER_ORGANIZATION_ID could not be applied;
instance ownership is unchanged and the API keeps serving`, and starts anyway:
a bad value never keeps the Studio down.

Clear the variable once ownership is right. While it is set, every API start
asserts it again, which undoes any later transfer at the next restart.

### 4. Decide who may use it

**Settings → Access** is editable by members of the owning organization whose
Beam role is not read-only. It has three parts:

- **Who may join** sets the join policy. A fresh installation is **Closed**
  when it is claimed. An adopted installation stays **Open** after its claim
  until you change it.
  - **Closed** (`closed`): only organizations you admit may use the Studio.
  - **Request to join** (`request`): a signed-in member of any other
    organization is refused, and their organization is recorded as a request.
  - **Open** (`open`): any Beam organization admits itself on first use.
- **Requests to join** lists pending organizations, each with an **Admit**
  button.
- **Organizations** lists admitted and revoked organizations. **Revoke** stops
  an organization's sessions and machine tokens at once and its agents at their
  next token refresh; its webhook triggers answer `404`. The owning organization cannot be revoked.

The page has no field to admit an organization by ID. Either switch to
**Request to join**, have one of the team's members sign in, admit it under
**Requests to join**, then switch back to **Closed**; or call the API that the
**Admit** button uses, `POST /studio/instance/access/organizations`, with the
organization's ID. It needs a signed-in session of the owning organization
(not read-only), so the simplest way is the browser's developer console on a
Studio tab where you are signed in with the owning organization selected:

```js
await fetch("/__studio_api/studio/instance/access/organizations", {
  method: "POST",
  credentials: "include",
  headers: {
    "content-type": "application/json",
    "x-organization-id": "<owning organization ID>",
  },
  body: JSON.stringify({ organizationId: "<organization ID to admit>" }),
}).then((response) => response.json());
// { organizationId: "<organization ID to admit>", status: "admitted" }
```

`/__studio_api` is the Studio web server's same-origin proxy to the API, so
the call carries your session cookie. Admitting an organization that was
revoked admits it again.

#### Machine callers: tokens, agents and webhooks

Machine callers act without a signed-in user, so they are served only for
organizations whose admission was recorded (listed as admitted under
**Organizations**), whatever the join policy:

- MCP tokens, on the MCP server and as `Authorization: Bearer beam_mcp_…` API
  calls: refused with `403 instance_organization_forbidden`.
- Agents: enrolling with an enrollment code
  (`POST /agent-control/v1/enroll`) and fetching an access token
  (`POST /agent-control/v1/token`) are refused with
  `403 instance_organization_forbidden`. A refused enrollment code is not
  consumed, so it works once the organization is admitted. An enrolled agent
  drops off at its next token refresh.
- Webhook triggers (`/hooks/workflows/...`): answer `404`, exactly like an
  unknown trigger.

An **Open** policy lets browser sessions in without recording the
organization, so under **Open** an organization that only admitted itself can
sign in and create an agent enrollment code or a webhook trigger, but the
agent cannot enroll and the webhook does not fire until you admit the
organization (**Admit**, or the call above). Earlier releases let agents and
webhooks of such organizations through; after upgrading, those stop until the
organization is admitted. The built-in `__local__` organization and
`BEAM_STUDIO_CONSUMER_ORGANIZATION_ID` (the Studio room consumer) are always
served, under every policy. The Studio room consumer of a release enrolls for
the owning organization, which is always admitted.

### 5. Create the instance key

Right after a claim, **Settings → Access** asks the owner to approve an
instance key in Beam Auth: open the link, check the code and approve. Approving
needs a role that can create API keys and run transfers in that organization
(owner, admin or developer). Beam then creates an organization API key for this
Studio, listed as "Studio: <host>" under API keys in the Beam Console, and
Studio stores it as the credential "Studio instance key".

- It is the organization's default key: new workflows, workflows that had no
  billing key, new Beam Transfer steps, room control and work without a
  signed-in user use it. Selectors show it as "(instance default)", and any
  other stored Beam key stays selectable.
- It is read-only under **Credentials**. **Settings → Access** rotates it (a new
  approval; the stored credential keeps its id and gets a new version) and
  revokes it.
- Nothing creates the key without the owner asking. An installation claimed
  before instance keys existed shows **Create instance key** and keeps using
  its stored keys until the owner creates one.
- Transferring ownership (in the product or with
  `BEAM_STUDIO_OWNER_ORGANIZATION_ID`) revokes the previous owner's key first;
  if Beam cannot confirm the revocation, ownership does not change.

You can still paste other keys: open **Credentials → New credentials**
(`/credentials/new`), choose **Beam** and paste an API key of the organization
from the Beam Console. Studio answers `503 room_authority_key_unavailable`
when the organization has no usable key at all.

### 6. Create rooms

Rooms are created on the **Rooms** page (`/rooms`) with **Create room**. Studio
first looks for an online Studio room consumer (an active `studio-room-consumer`
agent) for the organization. Without an enrolled one it answers
`409 room_consumer_unavailable`; when the consumer is offline it answers
`409 room_consumer_offline`. No credit is charged in either case.

Every release runs its own room consumer, the `room-consumer` service. It
is the Studio's agent in each room it creates: it holds the room's Admin role
and handles media sessions, live channel observation and the object inbox. It
enrolls by itself for the organization that owns the installation, so rooms
work once:

1. the installation is claimed ([step 3](#3-claim-the-installation)), and
2. that organization has a stored Beam API key
   ([step 5](#5-store-an-organization-beam-api-key)).

Until then it retries with backoff, logging `instance_unclaimed` or
`room_authority_key_unavailable`, and enrolls within a minute of the last step.
It then appears on the **Agents** page as an online agent with the
`studio-room-consumer` capability. Nothing has to be added to `.env`: it
bootstraps over the Compose network (`http://api:8787`) with
`BEAM_STUDIO_SHARED_SECRET`, which the installer generates. Its identity is kept
on the `beam-studio-room-consumer` volume, so restarts and updates reuse the
same agent instead of enrolling a new one. Check it with:

```bash
cd /opt/beam-studio
sudo docker compose --project-name beam-studio \
  --env-file /opt/beam-studio/.env \
  --file "$(sudo jq -r .currentComposePath /opt/beam-studio/state.json)" \
  logs --tail 50 room-consumer
```

Rooms are charged to the organization's key, as with the Beam CLI. The consumer
enrolls for the owning organization only; another admitted organization that
wants rooms in this Studio connects its own consumer from the **Agents** page, or
creates rooms with the Beam CLI (`beam`, with the Beam agent), using an API
key of that organization:

```bash
beam agent connect
beam room create --api-key "$BEAM_API_KEY"
```

`beam room create` charges the room to the named key, which also decides the
room's organization. Room features that depend on the Studio room consumer are
not available for rooms created this way.

Live media viewing in the browser also needs the consumer's UDP port
(`BEAM_STUDIO_MEDIA_UDP_PORT`, default `50400`, published on
`BEAM_STUDIO_MEDIA_UDP_BIND_ADDRESS`, default `0.0.0.0`) reachable from
browsers, and the host's public IP in `BEAM_STUDIO_MEDIA_PUBLIC_IP`. Optional
STUN or TURN URLs go in `BEAM_STUDIO_MEDIA_ICE_SERVERS`. Everything else works
without them.

### Troubleshooting

Every API refusal carries a stable `code` in its JSON body and in the API's
`request completed` log line (see **Logging** in the repository README).

| Symptom                                                                                   | Cause                                                                                              | Fix                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `421 Misdirected Request`, `code: host_not_allowed`                                       | The DNS name in `Host` is not in `BEAM_STUDIO_ALLOWED_HOSTS`                                       | Add the name (comma-separated) to `BEAM_STUDIO_ALLOWED_HOSTS` in `.env` and recreate the containers ([Changing the configuration](#changing-the-configuration)) |
| `403 instance_unclaimed`                                                                  | Nobody has claimed this installation yet                                                           | Claim it in **Settings → Access** with the claim code ([step 3](#3-claim-the-installation))                                                                     |
| `403 claim_code_invalid`                                                                  | The code was not derived from this installation's `BEAM_STUDIO_SECRET_KEY`                         | Read the code again with the command in [step 3](#3-claim-the-installation), on this host                                                                       |
| Sign-in ends with **This Studio is private** (`instance_private`)                         | None of your organizations is admitted and the join policy is **Closed**                           | Ask the owner to admit your organization ([step 4](#4-decide-who-may-use-it))                                                                                   |
| `403 instance_join_pending`                                                               | Your organization asked to join and has not been admitted                                          | The owner admits it under **Requests to join**                                                                                                                  |
| `403 instance_organization_forbidden` or `instance_organization_revoked`                  | The selected organization, or the organization of a token or agent, is not admitted or was revoked | The owner admits it under **Settings → Access**; tokens and agents need an explicit admission even when the policy is **Open**                                  |
| Studio unreachable after a host reboot; `api` exited with `not a directory`               | A release before the fix, see [Host reboot](#host-reboot)                                          | Follow [Host reboot](#host-reboot)                                                                                                                              |
| `403 instance_admin_required`                                                             | Only the owning organization may do this (updates, access settings)                                | Select the owning organization; on an adopted installation, claim it first                                                                                      |
| `409 room_consumer_unavailable`                                                           | The organization has no Studio room consumer the coordinator accepts; no credit was charged        | For the owning organization, check the `room-consumer` logs ([step 6](#6-create-rooms)); other organizations connect their own consumer or use the Beam CLI     |
| `409 room_consumer_offline`                                                               | The organization's Studio room consumer is not connected to Studio; no credit was charged          | Check that the `room-consumer` container runs and read its logs ([step 6](#6-create-rooms)); retry once it is online                                            |
| `503 room_consumer_not_ready` on a Room media tile or live channel                        | The room consumer could not load the Room; the message ends with the agent's error                 | Check the `room-consumer` logs and retry. If the message ends in `room not found`, update Studio so its consumer loads attached Rooms                           |
| `room-consumer` logs `instance_unclaimed` and retries                                     | Nobody has claimed this installation, so there is no organization to enroll for                    | Claim it ([step 3](#3-claim-the-installation)); the consumer enrolls on its next retry                                                                          |
| `room-consumer` logs `room_authority_key_unavailable` and retries                         | The owning organization has no stored Beam API key                                                 | Add one ([step 5](#5-store-an-organization-beam-api-key)); the consumer enrolls on its next retry                                                               |
| `room-consumer` logs `BEAM_STUDIO_SHARED_SECRET is not set` and waits                     | The host was installed before releases shipped a consumer and updated from Studio since            | Rerun the installer ([Install](#install)); it adds the secret to `.env` and starts the consumer                                                                 |
| `room-consumer` exits with `consumer_bootstrap_rejected`                                  | `BEAM_STUDIO_SHARED_SECRET` differs between the `api` and the consumer                             | Recreate the containers after editing `.env` ([Changing the configuration](#changing-the-configuration)) so both read the same value                            |
| `503 room_authority_key_unavailable`                                                      | The organization has no stored Beam API key                                                        | Add one ([step 5](#5-store-an-organization-beam-api-key))                                                                                                       |
| `503 database_unavailable`; `/health` answers `503` with `checks.database: "unavailable"` | PostgreSQL is restarting or unreachable. The services keep running and reconnect on their own      | Check the `postgres` container (`sudo docker ps`); retry once it is healthy                                                                                     |
| Not enough detail in the logs                                                             | `LOG_LEVEL` defaults to `info`; successful reads and refusal details are logged at `debug`         | Set `LOG_LEVEL=debug` in `.env` and recreate the containers; set it back afterwards                                                                             |

## Files

| Path                                                        | Purpose                                                           |
| ----------------------------------------------------------- | ----------------------------------------------------------------- |
| `/usr/local/bin/beam-updater`                               | Static updater executable extracted from the updater OCI package  |
| `/usr/local/share/beam-studio/compose.release.template.yml` | Template of the installed release (each update brings its own)    |
| `/etc/beam-studio/updater.json`                             | Host updater configuration                                        |
| `/etc/beam-studio/release-key.pem`                          | Pinned Ed25519 release public key                                 |
| `/etc/beam-studio/docker/`                                  | Root-only Docker registry configuration used during private tests |
| `/opt/beam-studio/.env`                                     | Installation secrets and settings                                 |
| `/opt/beam-studio/releases/`                                | Release templates, rendered Compose files and release descriptors |
| `/opt/beam-studio/backups/`                                 | PostgreSQL dumps                                                  |
| `/opt/beam-studio/state.json`                               | Persistent operation and release state                            |
| `/run/beam-studio/updater.sock`                             | Private control socket                                            |
| `/run/beam-studio/`                                         | Socket directory, mounted read-only into the `api` container      |

Rerunning the installer never changes a value in `/opt/beam-studio/.env`,
secrets included. It only appends the settings that the installer now writes and
the file does not define yet, so a host first installed by an older release
picks up new settings such as `BEAM_STUDIO_ALLOWED_HOSTS` and
`BEAM_STUDIO_SHARED_SECRET` (the room consumer's bootstrap secret, generated
once; no stored data depends on it). Derived settings
follow the `BEAM_STUDIO_PUBLIC_URL` already in the file. If `POSTGRES_PASSWORD`
or `BEAM_STUDIO_SECRET_KEY` is missing, the installer stops instead of
generating a new value, because a new value would not match the existing data.

## Host reboot

After a reboot, dockerd restarts the Studio containers before
`beam-updater.service` has created its socket: the updater drives Docker, so
its unit starts `After=docker.service` and cannot start first. The `api`
container therefore has to start without the socket.

It mounts the socket's directory, `BEAM_UPDATER_SOCKET_DIR` (default
`/run/beam-studio`, written to `.env` by the installer), read-only and at the
same path, rather than the socket file. Docker creates the directory if it is
missing, the API answers `503 updater_unavailable` for update requests until
the socket appears, and it sees the socket as soon as the updater creates it.
The unit sets `RuntimeDirectoryPreserve=yes`, so restarting the updater keeps
the directory the container has mounted. Keep the socket inside
`BEAM_UPDATER_SOCKET_DIR`.

Releases up to and including v1.0.4 mounted the socket file itself. Docker
then created a directory at `/run/beam-studio/updater.sock`, the `api`
container failed with `not a directory` (exit 127), and the updater refused to
start (`refusing to replace non-socket path`), so neither came back. The
updater now replaces an **empty** directory at the socket path (what Docker
leaves) and still refuses anything else there. A host still running such a
release after a reboot recovers with:

```bash
sudo rmdir /run/beam-studio/updater.sock   # only needed with an older beam-updater
sudo systemctl restart beam-updater.service
sudo docker compose --project-name beam-studio \
  --env-file /opt/beam-studio/.env \
  --file "$(sudo jq -r .currentComposePath /opt/beam-studio/state.json)" \
  up -d
```

Updating to a release with the directory mount, and rerunning the installer to
get the updated unit, prevents it.

## Changing the configuration

`/opt/beam-studio/.env` is the configuration of the installed release. The
updater passes it to Compose with `--env-file`, and the release template names
each variable it forwards to a container. A variable that the template does not
name never reaches a container, so adding one to `.env` does nothing unless the
template uses it. After you edit `.env`, recreate the containers with the
current release's rendered Compose file:

```bash
sudo docker compose --project-name beam-studio \
  --env-file /opt/beam-studio/.env \
  --file "$(sudo jq -r .currentComposePath /opt/beam-studio/state.json)" \
  up -d
```

This runs the same Compose file the updater deployed. It does not run the
updater's health checks or rollback, and the next update renders a new file
from the same `.env`.

Settings that operators commonly change:

| Variable                    | Default                 | Effect                                                                                          |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `BEAM_STUDIO_PUBLIC_URL`    | `http://localhost:3004` | URL users open; sets the API and MCP CORS origin                                                |
| `BEAM_STUDIO_ALLOWED_HOSTS` | derived by installer    | Comma-separated DNS names the services answer to; others get `421`                              |
| `STUDIO_BIND_ADDRESS`       | `0.0.0.0`               | Host interface the Studio port is published on                                                  |
| `STUDIO_PORT`               | `3004`                  | Host port of the Studio web server                                                              |
| `API_BIND_ADDRESS`          | `127.0.0.1`             | Host interface the API port `8787` is published on                                              |
| `MCP_BIND_ADDRESS`          | `127.0.0.1`             | Host interface the MCP port `8766` is published on; see [Remote MCP access](#remote-mcp-access) |
| `LOG_LEVEL`                 | `info`                  | Log level of the api, mcp, orchestrator and worker services (`debug` for more detail)           |

IP literals, loopback names and single-label names are always accepted in
`Host`, so an install opened at `http://<server-ip>:3004` needs no
`BEAM_STUDIO_ALLOWED_HOSTS` entry. A DNS name (the Studio name behind a reverse
proxy, or a separate MCP name) has to be listed. See **Network exposure** in the
repository README. Releases up to and including v1.0.4 do not forward
`BEAM_STUDIO_ALLOWED_HOSTS` to their containers, so on those releases Studio
answers `421` to every DNS name whatever `.env` says.

### Running a Compose file by hand

Since services bind `127.0.0.1` by default, each one listens
only on loopback unless told otherwise. Inside a container, that is the
container's own loopback, which other containers and published ports cannot
reach. The release template and `docker-compose.yml` therefore set these in each
service's `environment:`, which takes precedence over an env file:

| Service      | Variable                         | Container value |
| ------------ | -------------------------------- | --------------- |
| studio       | `HOST`                           | `0.0.0.0`       |
| api          | `API_BIND_HOST`                  | `0.0.0.0`       |
| mcp          | `MCP_SERVER_HOST`                | `0.0.0.0`       |
| orchestrator | `ORCHESTRATOR_BIND_HOST`         | `0.0.0.0`       |
| worker-N     | `WORKER_OBSERVABILITY_BIND_HOST` | `0.0.0.0`       |

`.env.example` shows `127.0.0.1` for these because it targets running the
services directly on one machine. If you write your own Compose file, or start
the images with `docker run --env-file`, set the values above yourself.
Otherwise the studio proxy cannot reach the api, workers cannot reach the
orchestrator, and the health checks fail. What reaches the host is decided by
the `ports:` you publish, not by these variables.

## Remote MCP access

The MCP server listens on port `8766` in its container. The release template
publishes it as `${MCP_BIND_ADDRESS:-127.0.0.1}:8766`, so by default only the
host itself reaches `http://127.0.0.1:8766/mcp`. To use it from another
machine, choose one of these:

- **SSH tunnel** (no configuration change):
  `ssh -N -L 8766:127.0.0.1:8766 <user>@<server>`, then point the client at
  `http://localhost:8766/mcp`.
- **Reverse proxy with TLS** (recommended). Leave `MCP_BIND_ADDRESS` at
  `127.0.0.1` and proxy a dedicated name such as `https://mcp.example.com` to
  `http://127.0.0.1:8766`. Use a separate name rather than a path under the
  Studio URL, because Studio serves its own `/mcp` page. If the proxy forwards
  the original `Host` (Caddy does by default), add that name to
  `BEAM_STUDIO_ALLOWED_HOSTS`, for example
  `BEAM_STUDIO_ALLOWED_HOSTS=studio.example.com,mcp.example.com`. Otherwise
  the MCP server answers `421`. Clients then use `https://mcp.example.com/mcp`.
- **Publish the port directly.** Set `MCP_BIND_ADDRESS=0.0.0.0` in `.env` and
  recreate the containers. Clients use `http://<server-ip>:8766/mcp`. Bearer
  tokens then cross the network unencrypted, so use this only on a trusted
  network or behind a firewall that limits who can connect.

Every MCP request needs an `Authorization: Bearer <token>` header with a token
created on Studio's `/mcp` page. An unknown, expired or revoked token gets `401`.
A valid token whose organization this installation does not admit gets
`403 instance_organization_forbidden`; see
[Decide who may use it](#4-decide-who-may-use-it). Native MCP clients send no `Origin` header and
are unaffected by CORS. The server rejects a browser request whose `Origin` is
not `BEAM_STUDIO_PUBLIC_URL` (the template sets `MCP_CORS_ORIGINS` to that
value).

`BEAM_STUDIO_MCP_PUBLIC_URL` (without the `/mcp` suffix) is passed to the MCP
container as `MCP_SERVER_URL`. No service reads `MCP_SERVER_URL` today, so
setting it does not change where clients connect or what Studio displays.
Configure clients with the URL you actually exposed.

## Upgrading from v1.0.3

The host updater (`/usr/local/bin/beam-updater`) does not update itself. Only
the installer replaces it. The v1.0.3 updater pulls images with
`docker compose pull <role>`, and v1.0.4's `worker` image backs the
`worker-1`…`worker-3` services rather than a service named `worker`. An update
started from Studio or with `beam-updater apply` on a v1.0.3 host therefore
fails at `Pulling image …: worker` (`pull worker image`) and leaves v1.0.3
running. To upgrade, rerun the installer. It keeps `/opt/beam-studio/.env` and
the installed channel, installs the current updater, and applies the release:

```bash
curl -fsSL https://cdn.b1m.ai/studio/install.sh | sudo sh
```

The v1.0.3 installer did not write `BEAM_STUDIO_ALLOWED_HOSTS`, and the v1.0.4
installer keeps an existing `.env` unchanged. On a host installed with v1.0.3
that is reached by a DNS name, rerun a newer installer (it appends the missing
setting, see above) or add `BEAM_STUDIO_ALLOWED_HOSTS=<studio hostname>` to
`.env`. On v1.0.4 this still
has no effect, as described in
[Changing the configuration](#changing-the-configuration).

## Signed control-plane contract

`latest.json` is one Ed25519-signed document that holds the active release of
each published channel. Each channel entry contains:

- a monotonically increasing `sequence`;
- a semantic `version` and full source commit;
- `minimumUpdaterVersion` and `deploymentSchemaVersion`;
- the updater OCI package by digest;
- the complete runtime image map by digest;
- backup, rollback, downgrade, publication, and release-note metadata.

Logical image keys such as `worker` and `orchestrator` are stable deployment
identifiers. Their repository values may change between releases, and have:
the runtime images now publish as `beam-studio-runtime-action-runner` (Beam Studio
Action Runner, which executes action packages) and
`beam-studio-runtime-action-dispatcher` (Beam Studio Action Dispatcher, which places
and supervises that execution). The schema, the logical keys and the internal
Compose service names are unchanged.

Rollback still resolves the previous repositories from the persisted image map,
so a release published under the old names remains recoverable.

Every image reference must be pinned by `@sha256` and come from an approved
namespace: Beam-built images under `ghcr.io/beam-network/` whose repository
names start with `beam-studio-`, and `docker.io/library/` for official images
such as PostgreSQL and NATS. Tags,
other registries, invalid signatures, unsupported schemas, and decreasing
sequences are rejected. Fields the updater does not know are ignored once the
signature has verified them, so later control planes may add fields.

## Release-defined deployment

The updater is deliberately generic: it knows no service, port, or database by
name, so changing the deployment never requires a new updater. Each release
describes itself:

- **Images.** The image map may hold any keys (`^[a-z][a-z0-9-]*$`). The key
  `worker-pool` fills the template placeholder `@IMAGE_WORKER_POOL@`; every key
  must have its placeholder and no placeholder may remain unresolved. Images
  are pulled in key order.
- **Template.** Applying a release extracts `/compose.release.template.yml`
  from the release's signed updater image and renders that, so environment,
  mounts, and services change with the release that needs them. The extracted
  template is kept beside the rendered `compose.yml`.
- **Health.** After `docker compose up --wait`, the updater probes every URL
  declared with the service label `beam.studio.health-url`. Compose resolves the
  value, so `http://127.0.0.1:${STUDIO_PORT:-3004}/health` follows the
  instance's port. Any non-2xx answer past the health timeout rolls back.
- **Backup.** The service labelled `beam.studio.backup: postgresql` is dumped
  with `pg_dump`, as its `POSTGRES_USER` into its `POSTGRES_DB`.

Releases published before these labels existed have no declarations; for them
the updater falls back to `healthUrl`, `studioHealthUrl`, and `database*` in
`updater.json`, whose defaults match those releases.

The updater persists the complete current, target, and previous image maps.
Rollback therefore uses the exact previous repository names and digests and
does not depend on the current CDN document.

## Publication

Create an Ed25519 key once and store the private key only in the repository
secret `BEAM_STUDIO_RELEASE_SIGNING_KEY`:

```bash
openssl genpkey -algorithm Ed25519 -out beam-studio-release-private.pem
openssl pkey \
  -in beam-studio-release-private.pem \
  -pubout \
  -out beam-studio-release-public.pem
```

Pushing a tag such as `studio-v1.4.0` publishes the `stable` channel, served
from `https://cdn.b1m.ai/studio`. Tagged updater binaries use the release tag
version and must satisfy the stable updater compatibility floor, `v1.0.0`.

The release pipeline:

1. tests the updater, generator, and installer;
2. verifies that it can list the channel's `studio/` prefix on the CDN bucket
   before starting expensive image builds;
3. builds the five Studio applications and updater OCI package for Linux
   `amd64` and `arm64`;
4. pushes human-readable version tags to GHCR and records their immutable
   multiarchitecture digests;
5. resolves digest-pinned PostgreSQL and NATS images;
6. verifies every referenced image and platform in the registry;
7. merges and signs the selected channel entry in `latest.json`;
8. renders `install.sh` with the pinned public key;
9. uploads `install.sh` and then atomically replaces `latest.json` as the final
   publication step;
10. reads the published object back and verifies it;
11. publishes GitHub release notes for provenance only.

Publication is serialized per channel so concurrent or delayed runs do not
overwrite a pointer unexpectedly. The bucket credentials need object read and
write access: the preflight is read-only, while the final publication uploads
and reads back both control-plane objects. A deliberate recovery can use a
newer sequence that points to older known-good image digests and sets explicit
downgrade metadata.

## Unix socket API

The browser must never call the updater directly. The authenticated Studio API
proxies narrow operations to it (see [Updating from Studio](#updating-from-studio)).
The socket itself exposes:

| Method | Path           | Purpose                                        |
| ------ | -------------- | ---------------------------------------------- |
| `GET`  | `/v1/health`   | Supervisor health                              |
| `GET`  | `/v1/status`   | Current, target, previous, and operation state |
| `GET`  | `/v1/check`    | Check the selected signed channel              |
| `POST` | `/v1/apply`    | Start applying the selected release            |
| `POST` | `/v1/rollback` | Restore the previous verified release          |

Accepted mutations return an `operationId`. CLI `--wait` follows only that
operation and uses a deadline covering both deployment and automatic rollback.

Host-side diagnostics:

```bash
sudo beam-updater status
sudo beam-updater check
sudo beam-updater apply --wait
sudo beam-updater rollback --wait
sudo beam-updater claim-code   # the instance claim code; see First run
sudo beam-updater uninstall    # revoke the instance key, then stop Studio
sudo journalctl -u beam-updater.service
```

### Releasing and uninstalling

**Settings → Access → Release this Studio** revokes the instance key at Beam,
removes the owner and leaves the Studio unclaimed: it serves nobody until it is
claimed again with its claim code. Workflows and credentials stay.

`sudo beam-updater uninstall` revokes the instance key from the running `api`
container (`/app/apps/api/dist/ops/instance-key-revoke-cli.js`), then runs
`docker compose down` for the current release. Data volumes and
`/opt/beam-studio` are kept. When the key cannot be revoked (Beam unreachable,
for example) it stops before touching the stack; fix the cause and retry, or
revoke "Studio: <host>" under API keys in the Beam Console and rerun with
`--force`. If the host is already gone, revoke that key in the Console.

## Updating from Studio

**Settings → Beam Studio updates** shows the channel chosen at installation,
the installed version, and the newest version on that channel. The channel is
read-only in Studio; change it by reinstalling with `BEAM_STUDIO_CHANNEL`. This
is unrelated to Registry package updates.

`BEAM_STUDIO_UPDATE_MODE` in `/opt/beam-studio/.env` controls the surface:

| Mode          | Studio behaviour                                                         |
| ------------- | ------------------------------------------------------------------------ |
| `managed`     | Shows versions; offers **Update** only when a newer release exists.      |
| `notify-only` | Shows versions and signals a newer release; no install button or action. |
| `disabled`    | Hides the feature; the API answers `404` and never contacts the updater. |

Only the installation's administrators may use it: members of the organization
that claimed the installation ([First run](#3-claim-the-installation)), with
that organization selected and a Beam role that is not read-only. Anyone else,
and everyone on an installation nobody has claimed yet, gets
`403 instance_admin_required`. Installation is never automatic: the
administrator must confirm it explicitly, and the API re-checks that a newer release exists before asking the
updater to apply it (never with `force`). Studio then follows the operation
through the updater status until it succeeds or fails, including automatic
rollback.

The Studio API routes use the `auth.instanceAdmin()` policy, so the request
must select the owning organization:

| Method | Path                     | Updater call                      |
| ------ | ------------------------ | --------------------------------- |
| `GET`  | `/studio/updates/status` | `GET /v1/status`                  |
| `GET`  | `/studio/updates/check`  | `GET /v1/check`                   |
| `POST` | `/studio/updates/apply`  | `GET /v1/check`, `POST /v1/apply` |

`apply` requires the body `{"confirm": true}`. Updater failures are reported
as `updater_unavailable` (503, socket unreachable), `updater_conflict` (409,
for example an operation already running), or `updater_*_failed` (502).
Rollback remains a host-side operation (`beam-updater rollback`).

## Update transaction

The supervisor performs these steps under an exclusive host lock:

1. fetch and verify the signed control plane and selected channel;
2. enforce sequence, updater, deployment-schema, registry, and digest rules;
3. render Compose locally from the updater-owned template and signed image map;
4. run `docker compose config --quiet`;
5. pull every image before modifying the active stack;
6. create a PostgreSQL custom-format dump when required;
7. replace the complete stack with `docker compose up --wait`;
8. verify both the Studio API and Studio HTTP readiness endpoints;
9. atomically switch the `current` release symlink;
10. preserve the complete previous release descriptor for rollback.

Every accepted apply or rollback has an operation ID and must finish as
`succeeded` or `failed`, including lock contention and missing rollback state.
On SIGTERM the service stops accepting operations, cancels active work, and
waits for bounded rollback/recovery.

Before opening its Unix socket after a restart, the updater reconciles any
non-terminal persisted operation. An interruption before deployment fails
without touching the current stack. An interruption after replacement begins
restores and verifies the last-known-good release. An interrupted first install
can validate its already prepared target. Failed automatic recovery is recorded
as a terminal state requiring manual intervention.

## Rollback and database limits

Automatic and manual rollback redeploy the exact locally persisted image map
and rendered Compose descriptor. Old GHCR repositories and referenced digests
must remain pullable for the full supported rollback window.

Container rollback does not automatically restore a PostgreSQL dump. Releases
marked `rollbackSafe` must keep database migrations compatible with at least
the preceding supported release. A database restore is a separate operator
decision because it can discard data written after the backup.
