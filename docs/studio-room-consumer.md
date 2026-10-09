# Studio room consumer facade

Studio keeps its synthetic organization identity as the administrative Room
owner. A containerized `beam-agentd --profile studio-consumer` is enrolled as a
separate real agent identity and receives the built-in Member and Admin roles
(`discover` + `subscribe` + `manage`). `POST /studio/room-consumers/:agentId/reconcile`
attaches that identity to every active organization Room, and has the agent
load each one, without exposing an invitation token to Studio.

The outbound Agent Gateway connection is an authenticated, bounded observation
bridge. Room payloads still enter and leave through the consumer agent's normal
coordinator and Worker assignments:

- message, datagram, command, and stream deliveries are ephemeral WebSocket
  observations and are never written to the Studio repository;
- command requests are observed with execution disabled;
- completed objects stay in the agent volume and are streamed to one requesting
  browser on demand, with a 256 MiB facade limit;
- media uses the bridge for SDP signaling only. The browser's WebRTC media path
  terminates at the assigned Worker.

`POST /studio/agents/:agentId/rooms/:roomId/channels/:channelId/media-session`
returns a signed WebSocket path valid for 60 seconds. The built-in player uses
the same endpoint and can expose it to another WebRTC consumer. The ticket is
organization-, agent-, Room-, and channel-scoped and must not be persisted.

The consumer image and its persistent-volume contract are documented with the
Beam agent that provides the `beam-studio-runtime-room-consumer` image.

## Attaching the consumer to a Room

The coordinator membership alone never reaches the consumer agent: until the
agent loads the Room, its room manager does not know it, and media, channels
and the object inbox fail later for lack of a Room key. Every attach (media
session, live channel connection, room creation, explicit reconciliation, and
the reconciliation after the consumer connects) therefore runs the same steps:

1. Studio refuses a consumer that is not online and connected to its Agent
   Gateway before calling the coordinator: `409 room_consumer_offline`.
2. The coordinator attaches the consumer
   (`PUT /studio/v1/rooms/{room}/consumers/{agent}`).
3. Studio sends the agent the `room.refresh` control command with
   `{ "room_id": "<room>" }` and waits up to 30 seconds for its result. The
   refresh makes the agent load the Room, its membership and its lease. A
   failed or unanswered refresh is reported as `503 room_consumer_not_ready`
   (retryable), with the message "The Studio room agent has not loaded the
   Room: " followed by the agent's error.

The media session endpoint answers these errors as JSON. A live channel
connection sends a `channel.error` with the code and message, then closes with
WebSocket code 1013. Room creation keeps the created (and paid) Room and returns
the message in `consumerAttachmentError`; a later reconciliation repairs it.

Attaches of the same consumer session and Room share one refresh while it runs,
and reuse a successful refresh for 60 seconds, the consumer lease. A new agent
session refreshes again. Each command costs the agent three control messages,
and the Agent Gateway disconnects an agent that sends more than 240 per minute,
so Studio sends one agent at most 40 refreshes per minute. Reconciling many
Rooms at once therefore spreads over several minutes.

## Beam environment isolation

A single Studio deployment can run separate DEV and PROD consumer identities. Each
uses its own persistent volume and explicitly sends `x-beam-environment-template`
on bootstrap, enrollment and authenticated control connections. Bootstrap has no
user session: it delegates with the organization's stored Beam API key, like
other background room operations; it does not use the old global coordinator token.
Reconnection refreshes only rooms the consumer has already joined; enrollment
alone attaches nothing, because the agent is not connected yet. New room
creation attaches the selected consumer. The explicit reconciliation
operation can attach it to all active organization rooms when requested. Repair
therefore does not automatically add a new identity to unrelated existing rooms.
Both consumers deploy together and share the same Studio API/bootstrap
secret. PROD Beam does not imply a second Studio deployment.

Room listing selects only an online consumer whose identity the selected
coordinator accepted, reusing the existing per-agent room inventories. When
none qualifies, `GET /studio/rooms` returns `consumer: null` with
`consumerUnavailableReason` set to `not_enrolled`, `not_authorized` or
`offline`, and the Rooms page shows that reason. Room creation probes consumer
candidates before attachment, accepts an authorized empty inventory, fails
closed on foreign identities or unavailable authorization, and answers
`409 room_consumer_offline` when every authorized consumer is offline. Online
status alone is never evidence of enrollment in the selected Beam environment.

Do not repoint a persisted consumer identity to another coordinator or share its
volume between environments. Retain the previous volume during enrollment repair;
create a separate PROD identity/volume and verify coordinator membership and a
stable identity across restart before considering it healthy.

## Scheduled file transfer sources

Room workflow sources are full enrolled agents advertising
`room-workflows/v1`. The Studio consumer profile remains an observation facade;
it is not substituted for the selected source agent. The Beam environment
template selector chooses the coordinator, independently from the Studio deployment.
See [Room transfer workflows](room-transfer-workflows.md) for source grants,
service credentials, billing, and persistent workflow execution.
