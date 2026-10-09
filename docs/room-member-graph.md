# Room member graph

Every room overview ends with **Room connections**, a slowly rotating Canvas
projection of the room's permitted communication. It represents authorization,
not transfer traffic, reachability, executor placement or guaranteed delivery.

The bordered Room connections panel keeps its title and member/connection counts
in a full-width header. The graph sits on the left, with a floating, borderless
column on the right for icon-only rotation controls, the symbol key and member
details. The legend and graph share the panel background without a divider.
The icon controls align to the legend's right edge and use a subtle idle background.
Below 620 px of available room content, the layout stacks to keep controls and
labels readable. Selecting
a node shows its access and roles; expand its permissions and connections for
the exact channel/action evidence. Vertical dragging follows the pointer.

## Reading the graph

- Points represent agents; outlined diamonds identify the Studio organization
  owner and its enrolled room consumer. Storage members use the existing provider
  catalog's logos. Unknown providers remain visible as storage markers.
- An outer ring marks Owner/Admin roles. Filled, hollow and half-filled agent
  points mean send-and-receive, receive-only and send-only. A slashed point has
  no data permission. A separate status dot and opacity show availability.
- Solid double-arrow links allow both directions; dotted arrows allow one.
  Offline/inactive members remain visible. Inactive members have no links.
- All active channels are included. Click or hover a node for member details,
  including exact permissions and each connection's channel/action pair. Focus
  the graph and use arrow keys to explore members, Home/End to jump, and Escape
  to clear the selection. There are no channel or member dropdowns.
- Drag to rotate, scroll or use the zoom buttons, pause/resume, or reset the view.
  The initial and reset views use 130% zoom to make better use of the graph area.
  Reduced-motion preferences disable automatic rotation while retaining controls.

## Authorization and data

The client uses the existing room snapshot and cached storage-binding endpoint.
`room-permissions.ts` contains the exact-action evaluator shared with transfer
controls. Only active member/role assignments and active channel grants apply;
ownership, administrative status, discovery, management and observation do not
implicitly grant data access. Room-visible discovery remains discover-only.

On each active channel, a sender's `publish` matches another member's `subscribe`.
Request/reply channels instead match `request` with `respond`. Rights from
different channels are never paired. Aggregated links retain their directional
channel evidence. Object storage participates only in object channels. Closed
rooms, inactive channels/memberships, revoked grants/assignments and pending key
rotation remove affected connections. Execution still performs authoritative
coordinator authorization; this graph is an informational view.

The model's normalized key excludes lease versions, timestamps and presence.
Existing snapshot refreshes update presence without rebuilding topology or
resetting the camera. Provider details share the existing storage query cache;
there is no graph poller, public API, database migration or protocol change.

## Rendering limits

The graph uses deterministic spherical positions and a 2D Canvas projection,
with no physics/3D dependency. Animation runs outside React state, at most 30
frames/second and device-pixel ratio 2. Intersection/document visibility,
manual pause and reduced motion suspend its frame loop. Observers, input
handlers and scheduled frames are released on unmount.

Above 500 aggregated connections the canvas draws only the selected member's
connections and explains that limit. Every member remains visible/selectable.
The tests cover direct/role permissions, revocation, channel isolation,
request/reply, provider/service identity, stable normalization, dense selection
and frame lifecycle. A local in-app Chromium benchmark on 2026-09-17 measured
**2.5 ms p95** across 200 warmed draw calls at 100 nodes, 500 connections and
DPR 2, below the 8 ms target. This measures Canvas submission cost on the test
machine, not total browser compositing or a guarantee for every device.
