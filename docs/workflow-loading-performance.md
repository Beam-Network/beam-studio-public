# Workflow and run navigation performance

`GET /studio/workflows` returns workflow summaries only: identity, description,
enablement, counts, latest status and scheduling metadata. It contains no action
catalogs, graph definitions or runs. `GET /studio/workflow-actions` provides the
installed action catalog separately.

`GET /studio/workflows/:id` returns the definition and `runCount`, without embedded
run history. `GET /studio/workflow-runs` returns `{ runs, totalCount, nextCursor }`:
50 summaries by default, at most 100. Pass `cursor` to continue in descending
creation time and ID order. `workflowTemplateId`, `status`, `search`, `view`
(`queue` or `dead-letter`), `actionPackage`, `from` and `to` filter on the server;
the total reflects all matching records, including records outside the page.
Newer arrivals do not shift subsequent pages. Restart pagination to see them.

Run summaries contain identity, state, timestamps, trigger identity and historical
validation markers. They exclude business outputs, trigger payloads, resolved
dependencies and snapshots. Retrieve a run by ID for its immutable history and
public result. All historical executions remain accessible through pagination.

`WorkflowReadRepository` requires an organization scope and projects only summary
columns in PostgreSQL. Large JSON fields are never fetched just to discard them
in JavaScript. Lists apply the selected project. Definition assembly fetches independent graph collections
concurrently after validating ownership.

The API initializes its bundled action catalog before becoming ready. Listing
actions or Registry packages is read-only and never reseeds the catalog. Explicit
authoring/install operations retain their transaction boundaries.

## Browser behavior

Sidebar, breadcrumbs and editor share workflow query keys. Definitions remain
fresh for 30 seconds; list polling runs every 30 seconds while the page is visible.
Run pages use server filters and cursor navigation; active executions refresh
every two seconds while visible. Background refreshes keep pagination available;
only the initial fetch for a newly selected page blocks its controls.
Search is debounced and obsolete fetches are
abortable. Organization changes reload the application; project changes also clear
the query cache and reload, preventing reuse across selected contexts. This is
data caching only: server authorization is evaluated for each request.

The editor hydrates from saved manifests without waiting for the installed catalog.
Registry and credential dialogs load their additional data when opened. JSON
exports are serialized only when requested, and non-editor tabs skip
credit-estimate requests. Unsaved graph state is not rehydrated by
background query updates. [Workflow positions](workflow-layout.md) synchronize
separately through revision checks and coordinate-only updates; these never
replace unfinished definition edits or load full graph definitions.

Durable run detail loads independently from coordinator evidence. The browser
requests `/studio/workflow-runs/:id/evidence`, which uses the same authorized
inspection as MCP. Only diagnostics are overlaid, matched by step-run ID, attempt
and publication ID. Missing, denied or failed inspection hides stale diagnostics;
it never replaces saved business output or execution status.

## Verification

The PostgreSQL workflow read acceptance case uses a read-only database connection
for all list/definition reads, inserts a large historical snapshot, checks that
navigation stays small and scoped, and verifies full history remains retrievable.
It covers counts, equal-timestamp pagination, newer arrivals between pages,
filters, page limits and invalid cursors. Browser evidence tests fence changed
attempt/publication identities and preserve immutable output.

Measured on a deployed instance, the definition response of a large workflow
with 160 embedded historical runs shrank from about 2.9 MB to 13 KB (99.6%
smaller), the workflow list to 20 KB and the first 50-run page to 29 KB, with
API timings between 1.3 and 2 seconds during an active scheduled transfer. These
are API timings, not browser first-render timings, so no cold-render
improvement factor is claimed.
