import { KEYSPACE } from "../keys.js";
import { BM25_TOKENIZER_VERSION } from "./tokenizer.js";

// Field-weighted postings (weighted term frequency and window length instead
// of raw counts) change the posting format, so this forks the derived
// namespace exactly like a tokenizer bump: 2 was the pre-field-weighting
// format, 3 is field-aware.
export const BM25_INDEX_VERSION = 3;

// A tokenizer or posting-format bump gets a fresh derived namespace. Canonical
// sources remain unchanged and can be replayed to rebuild the new namespace.
const ROOT = Object.freeze([
  KEYSPACE.POSTING,
  "bm25",
  BM25_INDEX_VERSION,
  BM25_TOKENIZER_VERSION,
]);
export const MAX_SCAN_LIMIT = 100_000;

export function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

export function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

export function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

export function finite(value, label, { minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be a finite number from ${minimum} through ${maximum}.`);
  }
  return value;
}

export function requireView(view) {
  if (!view || typeof view.get !== "function" || typeof view.scan !== "function") {
    throw new TypeError("A RocksStore-compatible read view is required.");
  }
  return view;
}

export function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export const bm25Keys = Object.freeze({
  corpus(project, generation) {
    return [...ROOT, "corpus", identifier(project, "project"), positiveInteger(generation, "generation")];
  },
  corpusPrefix(project) {
    return [...ROOT, "corpus", identifier(project, "project")];
  },
  corpusCurrent(project) {
    return [...ROOT, "corpus-current", identifier(project, "project")];
  },
  // Prefix over every project's corpus-current pointer. Exactly one such key
  // exists per project with indexed content, so scanning this prefix is the
  // cheap canonical enumeration of project namespaces in the store.
  corpusCurrentPrefix() {
    return [...ROOT, "corpus-current"];
  },
  current(project, documentId) {
    return [...ROOT, "current", identifier(project, "project"), identifier(documentId, "documentId")];
  },
  identity(documentId) {
    return [...ROOT, "identity", identifier(documentId, "documentId")];
  },
  document(project, documentId, version) {
    return [
      ...ROOT,
      "document",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  documentWindow(project, documentId, version, ordinal) {
    return [
      ...ROOT,
      "document-window",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      nonNegativeInteger(ordinal, "ordinal"),
    ];
  },
  documentWindowPrefix(project, documentId, version) {
    return [
      ...ROOT,
      "document-window",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  documentTerm(project, documentId, version, term, segment) {
    return [
      ...ROOT,
      "document-term",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      identifier(term, "term"),
      nonNegativeInteger(segment, "segment"),
    ];
  },
  documentTermPrefix(project, documentId, version) {
    return [
      ...ROOT,
      "document-term",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
  generation(generation, project) {
    return [...ROOT, "generation", positiveInteger(generation, "generation"), identifier(project, "project")];
  },
  posting(project, term, bucket, createdAt, documentId, version, generation, windowOrdinal) {
    return [
      ...ROOT,
      "term",
      identifier(project, "project"),
      identifier(term, "term"),
      nonNegativeInteger(bucket, "bucket"),
      nonNegativeInteger(createdAt, "createdAt"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      positiveInteger(generation, "generation"),
      nonNegativeInteger(windowOrdinal, "windowOrdinal"),
    ];
  },
  postingPrefix(project, term) {
    return [...ROOT, "term", identifier(project, "project"), identifier(term, "term")];
  },
  sessionPosting(
    project,
    sessionId,
    term,
    bucket,
    createdAt,
    documentId,
    version,
    generation,
    windowOrdinal,
  ) {
    return [
      ...ROOT,
      "session-term",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(term, "term"),
      nonNegativeInteger(bucket, "bucket"),
      nonNegativeInteger(createdAt, "createdAt"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
      positiveInteger(generation, "generation"),
      nonNegativeInteger(windowOrdinal, "windowOrdinal"),
    ];
  },
  sessionPostingPrefix(project, sessionId, term) {
    return [
      ...ROOT,
      "session-term",
      identifier(project, "project"),
      identifier(sessionId, "sessionId"),
      identifier(term, "term"),
    ];
  },
  termStatistics(project, term, generation) {
    return [
      ...ROOT,
      "df",
      identifier(project, "project"),
      identifier(term, "term"),
      positiveInteger(generation, "generation"),
    ];
  },
  termStatisticsPrefix(project, term) {
    return [...ROOT, "df", identifier(project, "project"), identifier(term, "term")];
  },
  termStatisticsCurrent(project, term) {
    return [
      ...ROOT,
      "df-current",
      identifier(project, "project"),
      identifier(term, "term"),
    ];
  },
});

function generationFromRecord(record) {
  const generation = record?.key?.at(-1);
  return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined;
}

function latestVersionedRecord(view, prefix, generation) {
  const records = view.scan(prefix, { reverse: true, limit: MAX_SCAN_LIMIT });
  const result = records.find((record) => {
    const candidate = generationFromRecord(record);
    return candidate !== undefined && candidate <= generation;
  });
  if (result === undefined && records.length === MAX_SCAN_LIMIT) {
    throw new RangeError("Requested BM25 statistics are older than the bounded history scan.");
  }
  return result;
}

export async function resolveGeneration(view, requested) {
  const published = await view.get([KEYSPACE.META, "published-index-generation"]);
  if (published === undefined) return 0;
  const current = positiveInteger(published.generation, "published generation");
  if (requested === undefined) return current;
  const generation = positiveInteger(requested, "generation");
  if (generation > current) throw new RangeError("generation is newer than the published index.");
  return generation;
}

/** Read the exact corpus and DF records used to score a query generation. */
export async function readBm25Statistics(view, { project, terms = [], generation } = {}) {
  if (view && typeof view.snapshot === "function") {
    return view.snapshot((snapshot) => readBm25Statistics(snapshot, { project, terms, generation }));
  }
  requireView(view);
  const normalizedProject = identifier(project, "project");
  if (!Array.isArray(terms) || terms.some((term) => typeof term !== "string" || term.length === 0)) {
    throw new TypeError("terms must be an array of normalized non-empty strings.");
  }
  const resolvedGeneration = await resolveGeneration(view, generation);
  if (resolvedGeneration === 0) {
    return Object.freeze({ generation: 0, corpus: undefined, terms: Object.freeze({}) });
  }
  const currentCorpus = await view.get(bm25Keys.corpusCurrent(normalizedProject));
  const corpusRecord = currentCorpus?.generation <= resolvedGeneration
    ? { payload: currentCorpus }
    : latestVersionedRecord(
      view,
      bm25Keys.corpusPrefix(normalizedProject),
      resolvedGeneration,
    );
  const termStatistics = {};
  for (const term of [...new Set(terms)].sort()) {
    const current = await view.get(bm25Keys.termStatisticsCurrent(normalizedProject, term));
    const record = current?.generation <= resolvedGeneration
      ? { payload: current }
      : latestVersionedRecord(
        view,
        bm25Keys.termStatisticsPrefix(normalizedProject, term),
        resolvedGeneration,
      );
    if (record !== undefined) termStatistics[term] = record.payload;
  }
  return Object.freeze({
    generation: resolvedGeneration,
    corpus: corpusRecord?.payload,
    terms: Object.freeze(termStatistics),
  });
}

export function scanAll(view, prefix) {
  const records = [];
  let after;
  for (;;) {
    const page = view.scan(prefix, {
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
    });
    records.push(...page);
    if (page.length < 1_000) return records;
    after = page.at(-1).keyBytes;
  }
}

export function hydrateDocumentMetadata(view, metadata) {
  if (metadata === undefined || Array.isArray(metadata.terms)) return metadata;
  if (!new Set(["sharded-v1", "sharded-v2"]).has(metadata.metadataLayout)) {
    throw new Error(`BM25 document ${metadata.documentId} has an unknown metadata layout.`);
  }
  const windowRecords = scanAll(
    view,
    bm25Keys.documentWindowPrefix(metadata.project, metadata.documentId, metadata.documentVersion),
  );
  const termRecords = scanAll(
    view,
    bm25Keys.documentTermPrefix(metadata.project, metadata.documentId, metadata.documentVersion),
  );
  const terms = new Map();
  for (const { payload } of termRecords) {
    let term = terms.get(payload.term);
    if (term === undefined) {
      term = {
        term: payload.term,
        documentFrequency: payload.documentFrequency,
        windowOrdinals: [],
      };
      terms.set(payload.term, term);
    } else if (term.documentFrequency !== payload.documentFrequency) {
      throw new Error(`BM25 term metadata for ${payload.term} is inconsistent.`);
    }
    term.windowOrdinals.push(...payload.windowOrdinals);
  }
  const windows = windowRecords.flatMap(({ payload }) => (
    Array.isArray(payload.windows) ? payload.windows : [payload.window]
  )).sort((left, right) => left.ordinal - right.ordinal);
  if (windows.length !== metadata.windowCount || terms.size !== metadata.termCount) {
    throw new Error(`BM25 document ${metadata.documentId} metadata shards are incomplete.`);
  }
  return Object.freeze({
    ...metadata,
    windows: Object.freeze(windows),
    terms: Object.freeze([...terms.values()].map((term) => Object.freeze({
      ...term,
      windowOrdinals: Object.freeze(term.windowOrdinals),
    }))),
    shardKeys: Object.freeze([
      ...windowRecords.map(({ key }) => key),
      ...termRecords.map(({ key }) => key),
    ]),
  });
}

/**
 * Read the full indexed term vocabulary of one live document, for query
 * expansion (RM3/Bo1-style pseudo-relevance feedback). Reuses the same
 * sharded document-term metadata already written at index time; it never
 * rescans or retokenizes source text.
 */
export async function readDocumentTermVocabulary(view, { project, documentId, version } = {}) {
  if (view && typeof view.snapshot === "function") {
    return view.snapshot((snapshot) => readDocumentTermVocabulary(snapshot, { project, documentId, version }));
  }
  requireView(view);
  const stored = await view.get(bm25Keys.document(
    identifier(project, "project"),
    identifier(documentId, "documentId"),
    positiveInteger(version, "version"),
  ));
  if (stored === undefined) return Object.freeze([]);
  const hydrated = hydrateDocumentMetadata(view, stored);
  return Object.freeze(hydrated.terms.map(({ term }) => term).sort());
}
