/**
 * Explicit Result type. Domain functions never throw for expected business
 * outcomes (rejected posting, failed validation) — they return a Result so the
 * caller must handle the failure path. `throw` is reserved for programmer error.
 */
export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export interface DomainError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E = DomainError>(error: E): Err<E> {
  return { ok: false, error };
}

export function fail(code: string, message: string, details?: Record<string, unknown>): Err<DomainError> {
  return { ok: false, error: { code, message, details } };
}

export function isOk<T, E>(r: Result<T, E>): r is Ok<T> {
  return r.ok;
}
