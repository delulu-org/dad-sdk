/**
 * DAD Error Model contract.
 *
 * Every error a DAD HTTP addon can emit when something goes wrong is one of a
 * fixed set of machine-readable codes, shipped in a single shape:
 *
 *   { "error": <DadErrorCode>, "error_message": "<human readable>" }
 *
 * Both the SDK and addon authors use the SAME vocabulary, so Delulu Core and
 * `dad test` can always tell WHY a request failed (invalid key, upstream
 * server unreachable, title not found, ...) without parsing free-form text.
 *
 * - The SDK handler converts every internal failure into this shape.
 * - Addon authors `throw new DadError('server_unreachable', 'scraper timed out')`
 *   (or return the plain object) to speak the same contract.
 * - `validateErrorResponse` rejects anything not in the vocabulary.
 */

/** Machine-readable error codes. Delulu Core treats these as a closed set. */
export type DadErrorCode =
  | 'bad_request'
  | 'method_not_allowed'
  | 'unauthorized'
  | 'not_found'
  | 'content_unavailable'
  | 'invalid_response'
  | 'upstream_unreachable'
  | 'rate_limited'
  | 'internal_error';

/**
 * The error response shape. `error` is the machine code; `error_message` is
 * the human-readable text (shown to the end user when appropriate).
 */
export interface DadErrorResponse {
  error: DadErrorCode;
  error_message: string;
}

/** HTTP status paired with each error code by the DAD error model. */
export const DAD_ERROR_STATUS: Record<DadErrorCode, number> = {
  bad_request: 400,
  method_not_allowed: 405,
  unauthorized: 401,
  not_found: 404,
  content_unavailable: 404,
  invalid_response: 422,
  upstream_unreachable: 502,
  rate_limited: 429,
  internal_error: 500,
};

/**
 * Thrown by addons (or the SDK) to produce a contract-conformant error
 * response. Carries the machine code and the HTTP status the handler emits.
 */
export class DadError extends Error {
  readonly code: DadErrorCode;
  readonly status: number;

  constructor(code: DadErrorCode, error_message: string) {
    super(error_message);
    this.name = 'DadError';
    this.code = code;
    this.status = DAD_ERROR_STATUS[code];
  }
}

/** Map any error code to its HTTP status. */
export function dadErrorStatus(code: DadErrorCode): number {
  return DAD_ERROR_STATUS[code];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validates that a value is a well-formed DAD error response: a known
 * `error` code and a non-empty string `error_message`.
 */
export function validateErrorResponse(raw: unknown): { valid: boolean; errors: string[] } {
  if (!isPlainObject(raw)) {
    return { valid: false, errors: ['Error response must be a plain object'] };
  }
  const errors: string[] = [];
  const e = raw as Record<string, unknown>;
  const code = e.error;
  if (typeof code !== 'string' || !(code in DAD_ERROR_STATUS)) {
    errors.push(
      `'error' must be a known DadErrorCode. Got ${JSON.stringify(code)} - expected one of: ${Object.keys(
        DAD_ERROR_STATUS
      ).join(', ')}`
    );
  }
  if (typeof e.error_message !== 'string' || e.error_message.trim() === '') {
    errors.push(`'error_message' must be a non-empty string`);
  }
  return { valid: errors.length === 0, errors };
}

/** True when the value looks like a DAD error response (any known code). */
export function isErrorResponse(raw: unknown): raw is DadErrorResponse {
  return isPlainObject(raw) && typeof raw.error === 'string' && raw.error in DAD_ERROR_STATUS;
}