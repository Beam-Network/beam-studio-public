import type { JsonObject } from "./workflow-graph-types";
import { BEAM_TRANSFER_ACTION } from "./workflow-graph-constants";

const legacyBeamTransferCredentialFields = [
  "apiKey",
  "natsUrl",
  "environment",
  "transferTemplateId",
] as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function configSchemaFields(
  manifest: JsonObject,
): Array<[string, JsonObject]> {
  const configSchema = manifest.configSchema;
  if (!isJsonObject(configSchema) || !isJsonObject(configSchema.properties)) {
    return [];
  }
  return Object.entries(configSchema.properties).filter(
    (entry): entry is [string, JsonObject] => isJsonObject(entry[1]),
  );
}

/**
 * Config keys that hold a credential id, mapped to the credential type slugs
 * the action accepts.
 *
 * An action names these in catalog.credentialRequirements[].configPaths, which
 * also covers `inputs.*` paths; only the `config.*` ones are rendered by the
 * configuration form, so the rest are ignored here. A requirement that declares
 * no accepted types yields an empty list, which the form treats as "any
 * credential" rather than "no credentials".
 */
export function credentialConfigFields(
  manifest: JsonObject,
): Map<string, string[]> {
  const catalog = manifest.catalog;
  if (!isJsonObject(catalog) || !Array.isArray(catalog.credentialRequirements)) {
    return new Map();
  }
  const fields = new Map<string, string[]>();
  for (const requirement of catalog.credentialRequirements) {
    if (!isJsonObject(requirement) || !Array.isArray(requirement.configPaths)) {
      continue;
    }
    const accepted = Array.isArray(requirement.acceptedCredentialTypes)
      ? requirement.acceptedCredentialTypes.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    for (const path of requirement.configPaths) {
      if (typeof path !== "string" || !path.startsWith("config.")) {
        continue;
      }
      const key = path.slice("config.".length);
      // A wildcard path addresses an array of endpoints, which the bespoke
      // endpoint editor owns rather than this form.
      if (!key || key.includes(".") || key.includes("[")) {
        continue;
      }
      fields.set(key, accepted);
    }
  }
  return fields;
}

export function defaultConfigFromManifest(manifest: JsonObject): JsonObject {
  return Object.fromEntries(
    configSchemaFields(manifest)
      .map(([name, schema]) => [name, defaultConfigValue(schema)] as const)
      .filter(([, value]) => value !== undefined),
  );
}

export function sanitizeActionConfig(
  actionPackageName: string,
  config: JsonObject,
): JsonObject {
  if (actionPackageName !== BEAM_TRANSFER_ACTION) {
    return config;
  }
  const sanitized = { ...config };
  for (const field of legacyBeamTransferCredentialFields) {
    delete sanitized[field];
  }
  return sanitized;
}

export function defaultConfigValue(schema: JsonObject) {
  if (Object.hasOwn(schema, "default")) {
    return schema.default;
  }
  const enumValues = schemaEnumValues(schema);
  if (enumValues.length) {
    return enumValues[0]?.value;
  }
  const type = schemaType(schema);
  if (type === "array") {
    return [];
  }
  if (type === "object") {
    return {};
  }
  if (type === "boolean") {
    return false;
  }
  if (type === "number" || type === "integer") {
    return 0;
  }
  if (type === "string") {
    return "";
  }
  return undefined;
}

export function schemaType(schema: JsonObject) {
  const type = schema.type;
  if (typeof type === "string") {
    return type;
  }
  if (schemaEnumValues(schema).length) {
    return "string";
  }
  return "string";
}

export function schemaEnumValues(schema: JsonObject) {
  const values = Array.isArray(schema.enum) ? schema.enum.map(String) : [];
  const options = Array.isArray(schema.options)
    ? schema.options.filter(isJsonObject)
    : [];
  return values.map((value) => {
    const option = options.find((item) => String(item.value ?? "") === value);
    return {
      value,
      label: stringValue(option?.label) || titleize(value),
    };
  });
}

export function schemaLabel(name: string, schema: JsonObject) {
  return stringValue(schema.title) || titleize(name);
}

export function arrayItemType(schema: JsonObject) {
  const items = schema.items;
  return isJsonObject(items) && typeof items.type === "string"
    ? items.type
    : "";
}

export function arrayStringValue(value: unknown) {
  return Array.isArray(value) ? value.map(String).join("\n") : "";
}

export function parseStringList(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function titleize(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}
