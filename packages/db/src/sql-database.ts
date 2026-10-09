export type SqlInputValue = string | number | boolean | null | Uint8Array;

export type SqlRunResult = {
  changes: number | bigint;
};

export type SqlStatement = {
  all(...params: unknown[]): Record<string, unknown>[];
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): SqlRunResult;
};

export type SqlDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close?(): void;
};
