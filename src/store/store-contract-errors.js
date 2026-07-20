/**
 * Store error taxonomy: the contract validation error class and the helper
 * that bounds arbitrary error messages to the wire contract's message-length
 * limit before they enter a response.
 */
import { MAX_STORE_ERROR_MESSAGE_LENGTH } from "./store-contract-schema.js";

/**
 * @typedef {object} StoreError
 * @property {string} code
 * @property {string} message
 * @property {boolean} retryable
 * @property {JsonValue=} details
 */

/** A stable validation failure suitable for conversion to an RPC error. */
export class ContractError extends TypeError {
  constructor(code, path, message) {
    super(`${path}: ${message}`);
    this.name = "ContractError";
    this.code = code;
    this.path = path;
  }
}

/** Return a non-empty error message that always satisfies the wire contract. */
export function boundedStoreErrorMessage(error, fallback = "Internal store error.") {
  let message;
  if (error instanceof Error && error.message) message = error.message;
  else if (typeof error?.message === "string" && error.message) message = error.message;
  else if (typeof error === "string" && error) message = error;
  else message = fallback;
  if (message.length <= MAX_STORE_ERROR_MESSAGE_LENGTH) return message;
  let prefix = message.slice(0, MAX_STORE_ERROR_MESSAGE_LENGTH - 1);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) prefix = prefix.slice(0, -1);
  return `${prefix}…`;
}
