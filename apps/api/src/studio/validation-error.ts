/**
 * A request the caller got wrong: a required field is missing or a value is
 * malformed. The API error handler answers it as a 400 with `code` (stable,
 * snake_case, for clients to branch on), the message and `details`, and logs
 * it once as a warning rather than as a server failure.
 *
 * Throw it only for user input. An inconsistency in stored data or a failing
 * dependency must stay a plain Error, which is a 500.
 */
export class StudioValidationError extends Error {
  readonly statusCode = 400;
  readonly expose = true;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StudioValidationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The resource the caller named does not exist, or is not visible to their
 * organization. Answered as a 404 with a stable `code`; like a validation
 * error it is an expected refusal, logged once as a warning.
 *
 * Throw it only when the id came from the request. A row the code itself
 * expected to find (a broken reference in stored data) stays a plain Error.
 */
export class StudioNotFoundError extends Error {
  readonly statusCode = 404;
  readonly expose = true;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StudioNotFoundError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The request is well formed but the resource is not in a state that allows
 * it (for example retrying a run that has not failed). Answered as a 409.
 */
export class StudioConflictError extends Error {
  readonly statusCode = 409;
  readonly expose = true;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StudioConflictError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The caller named a resource that exists but belongs to another
 * organization, where saying so leaks nothing the caller did not supply
 * (for example a project id outside the selected organization). Answered as
 * a 403.
 */
export class StudioForbiddenError extends Error {
  readonly statusCode = 403;
  readonly expose = true;
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StudioForbiddenError";
    this.code = code;
    this.details = details;
  }
}
