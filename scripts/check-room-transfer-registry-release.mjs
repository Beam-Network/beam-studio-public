function warn(title, detail) {
  // GitHub renders this as a warning annotation on the run.
  console.log(`::warning title=${title}::${detail}`);
  console.warn(`WARNING: ${title} ${detail}`);
}

const registryUrl = process.env.BEAM_ACTION_REGISTRY_URL;
if (!registryUrl) throw new Error("BEAM_ACTION_REGISTRY_URL is required.");

const url = new URL(
  "v1/resolve/%40beam/room-transfer?range=2.1.2",
  registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`,
);
// A release that is missing is a publication-ordering problem, not a fact about
// the code being deployed, and the API now starts without it and reports the
// gap in the UI. Report it and carry on rather than blocking every service.
const response = await fetch(url, { headers: { accept: "application/json" } });
if (!response.ok) {
  warn(
    `@beam/room-transfer@2.1.2 is not published to ${registryUrl} (${response.status}).`,
    "Studio will start and report room transfers as unavailable until it is published.",
  );
  process.exit(0);
}
const payload = await response.json();
const version = payload?.version;
const manifest = version?.manifest;
const schema = manifest?.configSchema;
const properties = schema?.properties;
if (
  payload?.resolvedVersion !== "2.1.2" ||
  version?.version !== "2.1.2" ||
  manifest?.version !== "2.1.2"
) {
  warn(
    "Registry resolved a different room-transfer action version.",
    "Studio will start and report room transfers as unavailable.",
  );
  process.exit(0);
}
if (
  !Array.isArray(schema?.required) ||
  !schema.required.includes("environmentTemplateKey") ||
  !properties?.environmentTemplateKey ||
  Object.hasOwn(properties ?? {}, "environment") ||
  Object.hasOwn(properties ?? {}, "coordinatorUrl") ||
  Object.hasOwn(properties?.targetMemberIds ?? {}, "maxItems") ||
  schema.additionalProperties !== false
) {
  warn(
    "Registry room-transfer manifest has an incompatible config schema.",
    "Studio will start and report room transfers as unavailable.",
  );
  process.exit(0);
}
if (
  typeof version?.manifestChecksum !== "string" ||
  typeof version?.artifactChecksum !== "string" ||
  (!version?.hippiusKey && !version?.artifactReference)
) {
  warn(
    "Registry room-transfer release lacks immutable artifact metadata.",
    "Studio will start and report room transfers as unavailable.",
  );
  process.exit(0);
}
console.log(
  "Registry exposes the immutable @beam/room-transfer@2.1.2 contract.",
);
