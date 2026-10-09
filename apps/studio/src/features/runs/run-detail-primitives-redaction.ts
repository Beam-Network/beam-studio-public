/**
 * Keys whose values must never be rendered into a JSON panel.
 *
 * A webhook trigger's config carries its live token, and the panel dumps
 * whatever it is given straight into the DOM — where it reaches screenshots,
 * screen shares, support sessions and browser extensions. Redacting by key in
 * one place covers every caller, including ones added later, rather than
 * relying on each of them to strip its own secrets.
 */
const SECRET_KEY =
  /token|secret|password|credential|apikey|authorization|signature|privatekey/i;

export function redactSecretsForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecretsForDisplay);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      // An empty or absent value is left as it is: replacing it would imply a
      // secret is set when none is.
      const hasValue = entry !== null && entry !== undefined && entry !== "";
      return [
        key,
        SECRET_KEY.test(key) && hasValue
          ? "[redacted]"
          : redactSecretsForDisplay(entry),
      ];
    }),
  );
}
