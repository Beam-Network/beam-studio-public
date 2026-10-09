# Workflow layout persistence

Moving saved nodes automatically saves their coordinates after a 500 ms debounce.
Auto Layout and position undo/redo use the same coordinate-only writer. New nodes,
connections, action configuration and other definition edits still require **Save
changes**. Layout saving works even when a configuration draft is invalid.

For transfer workflows, Auto Layout keeps the execution path across the top,
with source resources below-left and destination resources below-right of the
transfer. This separates endpoint connections from trigger and cleanup edges.
These arrangements use the same shared coordinate-only storage; action versions,
bindings, schedules and existing run snapshots are unchanged.

The layout is shared by the workflow's organization, across browser sessions and
devices connected to the same Studio. Visible editors check the layout revision
every five seconds, backing off to thirty seconds after thirty seconds without
changes. Hidden editors stop polling. Focus and reconnection refresh immediately.
Unchanged checks return HTTP 304 and query only the template revision, using the
normal Studio authorization boundary. No graph, manifests, run history or file
contents are fetched by the poller.

`GET /studio/workflows/:id/layout` returns `{ revision, positions }`; positions
contain `nodeId`, `x` and `y`. Uninitialized coordinates are null and retain their
existing editor fallback. The ETag is `"layout-<workflow-id>-<revision>"`; clients
send `If-None-Match` for conditional reads.

`PATCH /studio/workflows/:id/layout` accepts `{ revision, positions }`, containing
only changed saved nodes with finite coordinates. Each nonempty effective change
increments the layout revision. No-op writes keep it unchanged. Writes validate
node ownership and batch coordinate updates in one transaction, without resolving
actions, compiling graphs, capturing execution history or changing schedules.
`workflow_layout_conflict` (409) requires a fresh layout and rebasing pending
moves. `workflow_layout_node_unavailable` (409) identifies deleted/unsaved nodes;
`workflow_layout_invalid` (400) rejects malformed or duplicate coordinates.

The editor preserves pending local moves and active drags when applying remote
positions, and never replaces unfinished configuration. Concurrent changes to
different nodes merge; changes to the same node resolve by successful server
commit order. Definition saves preserve existing nodes' current coordinates and
initialize new nodes' positions. Viewport zoom, pan and snap preferences are not
part of the shared layout.

Saving failures remain visible with **Retry**. Automatic retries back off up to
thirty seconds. Navigation flushes pending position changes and is blocked if
they cannot be saved; closing the browser warns while writes are pending. As with
other saves, abrupt browser termination before acknowledgement cannot guarantee
persistence.
