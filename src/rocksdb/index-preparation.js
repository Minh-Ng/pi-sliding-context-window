import {
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
} from "../store-contract.js";

export const MAX_INDEX_WINDOWS_PER_DOCUMENT = 4_096;
export const MAX_HANDLER_PREPARED_MUTATIONS = 2_500;
export const MAX_HANDLER_PREPARED_BYTES = 4 * 1_024 * 1_024;
export const MAX_HANDLER_STAGED_MUTATIONS = 4_500;
export const MAX_HANDLER_STAGED_BYTES = 8 * 1_024 * 1_024;
export const MAX_DOCUMENT_STAGED_MUTATIONS = 4_500;
export const MAX_DOCUMENT_STAGED_BYTES = 8 * 1_024 * 1_024;
// Structural puts all receive a derived-reference put before staging.
export const MAX_STRUCTURAL_PREPARED_MUTATIONS = Math.min(
  MAX_HANDLER_PREPARED_MUTATIONS,
  Math.floor(MAX_HANDLER_STAGED_MUTATIONS / 2),
);
// Subtoken splitting emits a compound term plus its camelCase/snake_case
// pieces for every identifier, so code-dense windows now produce roughly
// 4x as many raw token occurrences as the pre-subtoken tokenizer (measured:
// 100 three-piece identifiers -> 400 tokens). These three raw-token limits
// are raised 4x from their pre-subtoken values so that documents which
// indexed cleanly before this change keep indexing cleanly now, instead of
// being silently skipped by the indexer on IndexPreparationLimitError.
export const MAX_BM25_TOKENS_PER_WINDOW = 16_000;
export const MAX_BM25_ANALYZED_TOKENS_PER_DOCUMENT = 64_000;
export const MAX_BM25_TERM_WINDOWS_PER_DOCUMENT = 4_096;
export const MAX_EXACT_INDEX_ANCHORS = 8_000;
export const MAX_EXACT_POSTING_MUTATIONS = 1_000;
export const MAX_STRUCTURAL_INDEX_MESSAGES = MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT;
export const MAX_STRUCTURAL_INDEX_BYTES_PER_DOCUMENT = MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT;
export const MAX_STRUCTURAL_SOURCE_SCAN_BYTES_PER_DOCUMENT = 16 * 1_024 * 1_024;

export class IndexPreparationLimitError extends RangeError {
  constructor(handlerId, limitKind, limit, observed) {
    super(`Index handler ${handlerId} exceeded ${limitKind}: ${observed} > ${limit}.`);
    this.name = "IndexPreparationLimitError";
    this.code = "ERR_INDEX_PREPARATION_LIMIT";
    this.details = Object.freeze({ handlerId, limitKind, limit, observed });
  }
}

export function preparationLimit(handlerId, limitKind, limit, observed) {
  if (observed > limit) {
    throw new IndexPreparationLimitError(handlerId, limitKind, limit, observed);
  }
  return observed;
}

export function isPreparationLimit(error) {
  return error?.code === "ERR_INDEX_PREPARATION_LIMIT"
    && error?.details
    && typeof error.details.handlerId === "string";
}
