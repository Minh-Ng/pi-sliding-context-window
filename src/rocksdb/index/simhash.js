import { createHash } from "node:crypto";
import { KEYSPACE } from "../keys.js";
import { MAX_SIMHASH_TOKENS_PER_DOCUMENT } from "../index-preparation.js";
import { BM25_TOKENIZER_VERSION, tokenizeBm25 } from "./tokenizer.js";

// A fingerprint-format or tokenizer bump gets a fresh derived namespace so the
// canonical sources can be replayed to rebuild it. Canonical records never move.
export const NEAR_DUPLICATE_INDEX_VERSION = 1;
export const DEFAULT_NEAR_DUPLICATE_HAMMING = 3;

const SIMHASH_BITS = 64;
const SIGNATURE_HEX_LENGTH = SIMHASH_BITS / 4;
const HANDLER_ID = "near-duplicate";

const ROOT = Object.freeze([
  KEYSPACE.POSTING,
  "simhash",
  NEAR_DUPLICATE_INDEX_VERSION,
  BM25_TOKENIZER_VERSION,
]);

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function requireView(view) {
  if (!view || typeof view.get !== "function" || typeof view.scan !== "function") {
    throw new TypeError("A RocksStore-compatible read view is required.");
  }
  return view;
}

export const simhashKeys = Object.freeze({
  signature(project, documentId, version) {
    return [
      ...ROOT,
      "signature",
      identifier(project, "project"),
      identifier(documentId, "documentId"),
      positiveInteger(version, "version"),
    ];
  },
});

function termFingerprint(term) {
  // SHA-1 gives a stable, well-distributed 64-bit fingerprint per term. It is a
  // content address, not a security boundary, so a fast digest is appropriate.
  return createHash("sha1").update(term, "utf8").digest().readBigUInt64BE(0);
}

/**
 * Fold a term -> weight map into a 64-bit SimHash rendered as 16 lowercase hex
 * characters. Order-independent (integer addition commutes), so the signature is
 * a pure function of the weighted term multiset.
 */
export function computeSimHash(termFrequencies) {
  const accumulator = new Array(SIMHASH_BITS).fill(0);
  for (const [term, weight] of termFrequencies) {
    if (!Number.isSafeInteger(weight) || weight <= 0) {
      throw new TypeError("SimHash term weights must be positive safe integers.");
    }
    const fingerprint = termFingerprint(identifier(term, "term"));
    for (let bit = 0; bit < SIMHASH_BITS; bit += 1) {
      const isSet = (fingerprint >> BigInt(SIMHASH_BITS - 1 - bit)) & 1n;
      accumulator[bit] += isSet === 1n ? weight : -weight;
    }
  }
  let signature = 0n;
  for (let bit = 0; bit < SIMHASH_BITS; bit += 1) {
    signature <<= 1n;
    // Ties (a bit with net-zero weight) resolve to 0 for a deterministic result.
    if (accumulator[bit] > 0) signature |= 1n;
  }
  return signature.toString(16).padStart(SIGNATURE_HEX_LENGTH, "0");
}

function requireSignature(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{16}$/u.test(value)) {
    throw new TypeError(`${label} must be a 16-character lowercase hex SimHash.`);
  }
  return value;
}

/** Popcount of the XOR of two 64-bit hex SimHashes. */
export function hammingDistance(left, right) {
  let difference = BigInt(`0x${requireSignature(left, "left")}`)
    ^ BigInt(`0x${requireSignature(right, "right")}`);
  let distance = 0;
  while (difference > 0n) {
    distance += Number(difference & 1n);
    difference >>= 1n;
  }
  return distance;
}

/**
 * Greedy MMR-style diversity over an already-ranked list: the first item of a
 * near-duplicate cluster is kept as the representative and later members are
 * suppressed into its `nearDuplicates` count. Items without a signature are
 * never clustered, so unverifiable evidence is always shown rather than hidden.
 */
export function selectNearDuplicateRepresentatives(items, options = {}) {
  const maxHammingDistance = options.maxHammingDistance ?? DEFAULT_NEAR_DUPLICATE_HAMMING;
  if (!Number.isSafeInteger(maxHammingDistance) || maxHammingDistance < 0) {
    throw new TypeError("maxHammingDistance must be a non-negative safe integer.");
  }
  const signatureOf = options.signatureOf ?? ((item) => item?.simhash);
  // A caller running a second dedup pass over items that already carry a
  // suppressed-count from an earlier pass (e.g. gather's selection stage over
  // search results that search.js already deduped) supplies priorCount so an
  // absorbed item's own already-suppressed duplicates are not silently
  // dropped when it is folded into a different representative here.
  const priorCount = options.priorCount ?? (() => 0);
  const representatives = [];
  for (const item of items) {
    const signature = signatureOf(item);
    let absorbed = false;
    if (typeof signature === "string") {
      for (const representative of representatives) {
        if (typeof representative.signature === "string"
          && hammingDistance(representative.signature, signature) <= maxHammingDistance) {
          representative.nearDuplicates += 1 + priorCount(item);
          absorbed = true;
          break;
        }
      }
    }
    if (!absorbed) representatives.push({ item, signature, nearDuplicates: priorCount(item) });
  }
  return representatives;
}

/**
 * Look up the stored signature for one document, for use as clustering input.
 * Only a "complete" signature is a faithful fingerprint of the whole document;
 * a "partial" signature covers just a bounded prefix, so two documents that
 * are identical up to the budget but diverge after it could otherwise be
 * clustered together on a false Hamming-distance match. Excluding both
 * "partial" and "empty" (and any candidate with no stored signature at all)
 * keeps clustering conservative: unverifiable or partially-fingerprinted
 * evidence is always shown rather than silently suppressed.
 */
export async function readNearDuplicateSignature(view, project, documentId, version) {
  const record = await view.get(simhashKeys.signature(project, documentId, version));
  return record?.status === "complete" && typeof record.simhash === "string"
    ? record.simhash
    : undefined;
}

// A word run split across two bounded reads must never be tokenized as two
// broken halves (it would, on its own, silently corrupt the term multiset and
// change the signature depending on context.sourceSegmentBytes rather than
// document content). Matches the tokenizer's own word-character class
// (tokenizer.js's WORD regex), used only to find a safe split point.
const TRAILING_WORD_RUN = /[\p{L}\p{M}\p{N}_]+$/u;
// Bounds how much of a single pathological word (no whitespace at all across
// many reads) is buffered across chunk boundaries. Beyond this, the excess is
// flushed as-is rather than held indefinitely; BM25's own streaming tokenizer
// has the same kind of overflow bound for the same reason (bounded memory).
const MAX_CARRIED_CODE_UNITS = 8_192;

/**
 * Stream one window through bounded reads, exactly like BM25's own bounded
 * source reader (context.sourceSegmentBytes per read, tolerating an adjusted
 * endByte). A window is never read in one shot regardless of its size, so no
 * separate byte-size limit is needed here: total work is already capped by
 * MAX_SIMHASH_TOKENS_PER_DOCUMENT below. Unlike BM25's positional streaming
 * tokenizer, simhash only needs term weights, so a simple held-back trailing
 * word run (carried into the next read) is enough to keep chunk boundaries
 * from corrupting the term multiset.
 */
async function* streamWindowTokens(context, startByte, endByte) {
  let cursor = startByte;
  let carry = "";
  if (cursor === endByte) return;
  while (cursor < endByte) {
    const requestedEnd = Math.min(endByte, cursor + context.sourceSegmentBytes);
    const selected = await context.readSourceRange(cursor, requestedEnd, { adjustUtf8: true });
    if (selected.startByte !== cursor || selected.endByte <= cursor) {
      throw new Error("Near-duplicate bounded source reader failed to make UTF-8 progress.");
    }
    cursor = selected.endByte;
    const final = cursor >= endByte;
    let combined = carry + selected.text;
    // The carried tail and this read's leading run are one word only if
    // nothing was held back for a reason other than "more of this word may
    // follow" -- always true here, since carry is only ever a trailing run.
    if (final) {
      carry = "";
    } else {
      const trailing = TRAILING_WORD_RUN.exec(combined);
      const splitAt = trailing?.index ?? combined.length;
      carry = combined.slice(splitAt);
      combined = combined.slice(0, splitAt);
      if (carry.length > MAX_CARRIED_CODE_UNITS) {
        // Never seen a word boundary across many reads: give up holding this
        // one back rather than growing the buffer without bound.
        combined += carry;
        carry = "";
      }
    }
    if (combined.length > 0) yield* tokenizeBm25(combined);
    if (typeof context.yieldControl === "function") await context.yieldControl();
  }
}

async function analyzeDocument(context) {
  const termFrequencies = new Map();
  let tokenCount = 0;
  let truncated = false;
  // Windows overlap and are gap-free; reading only the not-yet-covered tail of
  // each keeps every source byte counted once, so the signature is a faithful
  // document fingerprint that does not depend on the windowing configuration.
  let coveredByte = 0;
  outer: for (const window of context.windows) {
    const startByte = Math.max(coveredByte, window.startByte);
    coveredByte = Math.max(coveredByte, window.endByte);
    if (tokenCount >= MAX_SIMHASH_TOKENS_PER_DOCUMENT) {
      truncated = true;
      break;
    }
    for await (const token of streamWindowTokens(context, startByte, window.endByte)) {
      if (tokenCount >= MAX_SIMHASH_TOKENS_PER_DOCUMENT) {
        truncated = true;
        break outer;
      }
      termFrequencies.set(token.term, (termFrequencies.get(token.term) ?? 0) + 1);
      tokenCount += 1;
    }
  }
  return { termFrequencies, tokenCount, truncated };
}

function signatureRecord(context, project, analysis) {
  const manifest = context.manifest;
  const status = analysis.tokenCount === 0
    ? "empty"
    : analysis.truncated ? "partial" : "complete";
  return Object.freeze({
    nearDuplicateVersion: NEAR_DUPLICATE_INDEX_VERSION,
    tokenizerVersion: BM25_TOKENIZER_VERSION,
    project,
    documentId: manifest.documentId,
    documentVersion: manifest.version,
    generation: context.generation,
    contentHash: manifest.contentHash,
    status,
    tokenCount: analysis.tokenCount,
    termCount: analysis.termFrequencies.size,
    ...(analysis.tokenCount === 0
      ? {}
      : { simhash: computeSimHash(analysis.termFrequencies) }),
  });
}

async function prepareDelete(context, project) {
  const key = simhashKeys.signature(project, context.manifest.documentId, context.manifest.version);
  const existing = await context.view.get(key);
  if (existing === undefined) {
    return { mutations: [], metadata: { project, deleted: false, reason: "not-indexed" } };
  }
  return {
    mutations: [{ type: "remove", key }],
    metadata: { project, deleted: true },
  };
}

/** IndexWorker handler that stores one deterministic near-duplicate signature per document. */
export function createNearDuplicateIndexHandler(options = {}) {
  const id = options.id ?? HANDLER_ID;
  identifier(id, "handler id");
  const operations = options.operations ?? ["index", "delete"];
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new TypeError("Near-duplicate handler operations must be a non-empty array.");
  }
  return Object.freeze({
    id,
    operations: Object.freeze([...operations]),
    async prepare(context) {
      requireView(context?.view);
      positiveInteger(context.generation, "generation");
      const project = identifier(context.manifest?.project, "manifest.project");
      if (context.operation === "delete") return prepareDelete(context, project);
      const analysis = await analyzeDocument(context);
      const payload = signatureRecord(context, project, analysis);
      return {
        mutations: [{
          type: "put",
          immutable: false,
          key: simhashKeys.signature(project, context.manifest.documentId, context.manifest.version),
          kind: "near-duplicate-signature",
          payload,
        }],
        metadata: Object.freeze({
          project,
          status: payload.status,
          tokenCount: payload.tokenCount,
          termCount: payload.termCount,
        }),
      };
    },
  });
}
