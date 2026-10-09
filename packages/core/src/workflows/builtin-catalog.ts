import type {
  ActionCatalogMetadata,
  ActionExecute,
  ActionManifest,
  RegisteredActionPackage,
} from "./actions.js";
import { builtinDataActions } from "./builtin-data.js";
import { LocalActionRegistry, checksumManifest } from "./registry.js";

export type BuiltinActionCatalogEntry = {
  source: "builtin";
  manifest: ActionManifest;
  execute: ActionExecute;
  checksum: string;
  catalog: ActionCatalogMetadata;
};

export function builtinActionCatalog(): BuiltinActionCatalogEntry[] {
  return builtinDataActions.map((entry) => {
    const catalog = entry.manifest.catalog;
    if (!catalog) {
      throw new Error(
        `Builtin action "${entry.manifest.name}" is missing catalog metadata.`,
      );
    }
    return {
      source: "builtin",
      manifest: entry.manifest,
      execute: entry.execute,
      checksum: checksumManifest(entry.manifest),
      catalog,
    };
  });
}

export function createBuiltinActionRegistry() {
  const registry = new LocalActionRegistry({
    allowedBuiltinPackages: builtinActionCatalog().map(
      (entry) => entry.manifest.name,
    ),
  });
  for (const entry of builtinActionCatalog()) {
    registry.registerPackage({
      source: "builtin",
      manifest: entry.manifest,
      execute: entry.execute,
    });
  }
  return registry;
}

export function builtinActionPackageRecords(): RegisteredActionPackage[] {
  return builtinActionCatalog().map((entry) => ({
    source: "builtin",
    manifest: entry.manifest,
    execute: entry.execute,
    checksum: entry.checksum,
  }));
}
