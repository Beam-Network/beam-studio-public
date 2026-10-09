/**
 * Rewrites `:name` placeholders into Postgres positional parameters.
 *
 * Lives in its own module, and is injected into the worker by source, so the
 * rewriting rules can be tested. They were previously inline in the worker's
 * template string, where nothing could reach them.
 *
 * The function must stay self-contained: it is serialised with `toString()`
 * into the worker, so it cannot close over anything in this module.
 */
export function compileNamedParameters(
  sql: string,
  parameters?: unknown[] | Record<string, unknown>,
): { text: string; values: unknown[] } {
  let text = sql
    .replace(/strftime\('%s',\s*([^)]+)\)/gi, "EXTRACT(EPOCH FROM $1)")
    .replace(/\s+COLLATE\s+NOCASE/gi, "");
  if (!parameters || Array.isArray(parameters)) {
    return { text, values: (parameters as unknown[]) || [] };
  }
  const names: string[] = [];
  // The negative lookbehind leaves Postgres casts alone. Without it the
  // pattern matched any colon-prefixed word, so `:scopes::jsonb` was read as
  // the parameter `scopes` followed by a parameter named `jsonb`, and the
  // statement reached Postgres as `syntax error at or near ":"` — an error
  // that names neither the cast nor the compiler that mangled it.
  text = text.replace(/(?<!:):([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name: string) => {
    let index = names.indexOf(name);
    if (index < 0) {
      names.push(name);
      index = names.length - 1;
    }
    return "$" + (index + 1);
  });
  return {
    text,
    values: names.map((name) => (parameters as Record<string, unknown>)[name]),
  };
}
