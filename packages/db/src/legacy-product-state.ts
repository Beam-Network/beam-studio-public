import type { SqlDatabase } from "./sql-database.js";

/**
 * Public tables of the pre-workflow transfer product, created only by
 * `postgres-migrations/0008_legacy_product_state.sql`.
 *
 * The target schema applied at startup deliberately does not recreate them
 * (see "Legacy Tables Not Recreated" in
 * docs/beam-studio-postgresql-target-schema.md, and `db:studio:verify`, which
 * rejects any base table in `public`). A Studio database created after the
 * cutover therefore has none of them, while older deployments still carry the
 * rows written before it.
 */
export const LEGACY_PRODUCT_TABLES = [
  "beam_api_keys",
  "organization_api_keys_cache",
  "transfer_templates",
  "transfer_sources",
  "transfer_destinations",
  "schedules",
  "runs",
  "run_transfers",
  "execution_logs",
  "dead_letter_runs",
  "worker_instances",
] as const;

const legacyProductStateSql = `
  SELECT COUNT(*) AS present
  FROM pg_catalog.pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (${LEGACY_PRODUCT_TABLES.map((table) => `'${table}'`).join(", ")})
`;

/**
 * Whether the legacy transfer-product tables exist in this database.
 *
 * Their readers join most of these tables together, so a partial set is
 * treated like none. Callers cache the answer per connection: the target
 * schema never creates the tables, and only the dev-only `db:pg:migrate`
 * chain does.
 */
export function legacyProductTablesPresent(database: SqlDatabase) {
  const row = database.prepare(legacyProductStateSql).get() as
    | { present?: unknown }
    | undefined;
  return Number(row?.present ?? 0) === LEGACY_PRODUCT_TABLES.length;
}

/**
 * Raised when a write targets a legacy transfer-product table on a database
 * that does not have it. Surfaces as 410 Gone instead of a missing-relation 500.
 */
export class LegacyProductRetiredError extends Error {
  readonly statusCode = 410;
  readonly code = "legacy_product_retired";

  constructor(message: string) {
    super(message);
    this.name = "LegacyProductRetiredError";
  }
}
