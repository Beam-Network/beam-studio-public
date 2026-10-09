import catalog from "./provider-profiles.json" with { type: "json" };

export type ProviderDriver = "s3-compatible" | "salesforce";
export type ProviderProfileStatus = "ready" | "endpoint-required";

export type ProviderEndpointProfile = {
  required?: boolean;
  template?: string;
  template_variables?: string[];
  force_path_style?: boolean;
  object_metadata_readback?: boolean;
};

export type ProviderProfile = {
  id: string;
  aliases?: string[];
  name: string;
  driver: ProviderDriver;
  status: ProviderProfileStatus;
  logo: string;
  website_url?: string;
  docs_url?: string;
  region?: {
    default?: string;
  };
  endpoint?: ProviderEndpointProfile;
  credential_fields: {
    required: string[];
    optional?: string[];
  };
  notes?: string[];
};

export type ProviderProfilesCatalog = {
  schema_version: number;
  updated_at: string;
  profiles: ProviderProfile[];
};

export const providerProfilesCatalog = catalog as ProviderProfilesCatalog;
export const providerProfiles = providerProfilesCatalog.profiles;

const providerProfileIndex = new Map<string, ProviderProfile>();

for (const profile of providerProfiles) {
  providerProfileIndex.set(normalizeProviderId(profile.id), profile);
  for (const alias of profile.aliases ?? []) {
    providerProfileIndex.set(normalizeProviderId(alias), profile);
  }
}

export function normalizeProviderId(provider: string) {
  return provider.trim().toLowerCase();
}

export function getProviderProfile(provider: string) {
  return providerProfileIndex.get(normalizeProviderId(provider));
}

export function isS3CompatibleProvider(provider: string) {
  return getProviderProfile(provider)?.driver === "s3-compatible";
}

export function resolveProviderProfileRegion(
  profileOrProvider: ProviderProfile | string,
  values: Record<string, unknown> = {},
) {
  const profile = toProfile(profileOrProvider);
  return fieldText(values, "region") || profile?.region?.default;
}

export function resolveProviderProfileEndpointUrl(
  profileOrProvider: ProviderProfile | string,
  values: Record<string, unknown> = {},
) {
  const profile = toProfile(profileOrProvider);
  const explicitEndpoint = fieldText(values, "endpoint_url");
  if (explicitEndpoint) {
    return explicitEndpoint;
  }

  const template = profile?.endpoint?.template;
  if (!template) {
    return undefined;
  }

  let missingValue = false;
  const endpoint = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, key) => {
    const value =
      key === "region"
        ? resolveProviderProfileRegion(profile, values)
        : fieldText(values, key);
    if (!value) {
      missingValue = true;
      return "";
    }
    return value;
  });

  return missingValue ? undefined : endpoint;
}

export function resolveProviderProfileForcePathStyle(
  profileOrProvider: ProviderProfile | string,
  values: Record<string, unknown> = {},
) {
  const explicitValue = fieldBoolean(values, "force_path_style");
  if (typeof explicitValue === "boolean") {
    return explicitValue;
  }

  return toProfile(profileOrProvider)?.endpoint?.force_path_style;
}

// Endpoint limitations apply only to the catalog's canonical provider host.
// A custom endpoint must prove object ownership through metadata as usual.
export function providerReturnsObjectMetadata(
  provider: string,
  endpointUrl?: string,
) {
  const profile = getProviderProfile(provider);
  if (profile?.endpoint?.object_metadata_readback !== false) return true;
  try {
    const canonical = new URL(profile.endpoint.template!);
    const endpoint = new URL(endpointUrl ?? "");
    return (
      endpoint.protocol !== "https:" || endpoint.hostname !== canonical.hostname
    );
  } catch {
    return true;
  }
}

function toProfile(profileOrProvider: ProviderProfile | string) {
  return typeof profileOrProvider === "string"
    ? getProviderProfile(profileOrProvider)
    : profileOrProvider;
}

function fieldText(values: Record<string, unknown>, key: string) {
  return text(values[key] ?? values[toCamelCase(key)]);
}

function fieldBoolean(values: Record<string, unknown>, key: string) {
  const value = values[key] ?? values[toCamelCase(key)];
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function toCamelCase(key: string) {
  return key.replace(/_([a-z])/g, (_match, letter: string) =>
    letter.toUpperCase(),
  );
}
