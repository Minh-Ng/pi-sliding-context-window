// Facade over the BM25 index implementation, split along the write/search
// line (see bm25-keys.js, bm25-write.js, bm25-search.js). This file exists
// so no importer needs to change: it re-exports the same public surface the
// monolithic module used to expose directly.
export {
  BM25_INDEX_VERSION,
  bm25Keys,
  readBm25Statistics,
  readDocumentTermVocabulary,
} from "./bm25-keys.js";
export {
  BM25_FIELD_WEIGHTS,
  createBm25IndexHandler,
} from "./bm25-write.js";
export {
  bm25InverseDocumentFrequency,
  bm25TermScore,
  DEFAULT_BM25_PARAMETERS,
  DEFAULT_BM25_SEARCH_LIMITS,
  MAX_BM25_SNIPPET_CHARACTERS,
  recomputeBm25Evidence,
  recomputeBm25Score,
  searchBm25,
} from "./bm25-search.js";
