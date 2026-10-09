import assert from "node:assert/strict";
import test from "node:test";
import { compileNamedParameters } from "./sql-named-parameters.js";

test("a cast beside a parameter survives", () => {
  // This is the case that failed: `:scopes::jsonb` was read as the parameter
  // `scopes` followed by a parameter named `jsonb`, and Postgres answered
  // "syntax error at or near \":\"".
  const { text, values } = compileNamedParameters(
    "UPDATE mcp.tokens SET scopes_json = :scopes::jsonb WHERE id = :id",
    { scopes: '["read:runs"]', id: "mcp" },
  );
  assert.equal(
    text,
    "UPDATE mcp.tokens SET scopes_json = $1::jsonb WHERE id = $2",
  );
  assert.deepEqual(values, ['["read:runs"]', "mcp"]);
});

test("a cast with no parameter beside it is untouched", () => {
  const { text, values } = compileNamedParameters(
    "SELECT now() - ('60 seconds')::interval AS cutoff",
    {},
  );
  assert.equal(text, "SELECT now() - ('60 seconds')::interval AS cutoff");
  assert.deepEqual(values, []);
});

test("several casts in one statement all survive", () => {
  const { text } = compileNamedParameters(
    "INSERT INTO t (a, b, c) VALUES (:a::jsonb, :b::text, :c::int)",
    { a: "{}", b: "x", c: 1 },
  );
  assert.equal(
    text,
    "INSERT INTO t (a, b, c) VALUES ($1::jsonb, $2::text, $3::int)",
  );
});

test("a repeated parameter binds once and reuses its position", () => {
  const { text, values } = compileNamedParameters(
    "SELECT * FROM t WHERE a = :id OR b = :id::text",
    { id: "x" },
  );
  assert.equal(text, "SELECT * FROM t WHERE a = $1 OR b = $1::text");
  assert.deepEqual(values, ["x"]);
});

test("positional parameters pass through untouched, casts included", () => {
  const sql = "SELECT $1::interval, $2";
  const { text, values } = compileNamedParameters(sql, ["1 day", 2]);
  assert.equal(text, sql);
  assert.deepEqual(values, ["1 day", 2]);
});

test("an absent parameter object is not treated as named", () => {
  const { text, values } = compileNamedParameters("SELECT 1::int");
  assert.equal(text, "SELECT 1::int");
  assert.deepEqual(values, []);
});

test("the SQLite compatibility rewrites still apply", () => {
  const { text } = compileNamedParameters(
    "SELECT strftime('%s', created_at) FROM t WHERE name = :name COLLATE NOCASE",
    { name: "a" },
  );
  assert.match(text, /EXTRACT\(EPOCH FROM created_at\)/);
  assert.doesNotMatch(text, /COLLATE/i);
  assert.match(text, /name = \$1/);
});

test("the function is self-contained, because the worker serialises it", () => {
  // sync-postgres.ts injects this by source into a worker template, so a
  // reference to anything in module scope would become a runtime ReferenceError
  // inside the worker rather than a compile error here.
  const source = compileNamedParameters.toString();
  const rebuilt = new Function(
    `return (${source});`,
  )() as typeof compileNamedParameters;
  const { text } = rebuilt("SELECT :a::jsonb", { a: "{}" });
  assert.equal(text, "SELECT $1::jsonb");
});
