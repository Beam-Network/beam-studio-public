import type { SqlDatabase } from "@beam-studio/db";
import {
  builtinActionCatalog,
  checksumManifest,
  createBuiltinActionRegistry,
  type ActionManifest,
} from "@beam-studio/core";
import { now } from "./utils.js";

export function registerBuiltinActionPackages(db: SqlDatabase) {
  const timestamp = now();
  for (const action of builtinActionCatalog()) {
    persistActionPackage(db, action.manifest, action.checksum, timestamp);
  }
}

function persistActionPackage(
  db: SqlDatabase,
  manifest: ActionManifest,
  checksum: string,
  timestamp: string,
) {
  db.prepare(
    `
    INSERT INTO action_packages (
      id, name, version, source, manifest_json, checksum, created_at, updated_at
    )
    VALUES (
      :id, :name, :version, 'builtin', :manifestJson, :checksum, :createdAt, :updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      manifest_json = excluded.manifest_json,
      checksum = excluded.checksum,
      updated_at = excluded.updated_at
  `,
  ).run({
    id: `builtin_${manifest.name}_${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    manifestJson: JSON.stringify(manifest),
    checksum: checksum || checksumManifest(manifest),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function builtinRegistry() {
  return createBuiltinActionRegistry();
}
