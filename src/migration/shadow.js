import { createHash } from "node:crypto";
import { ARCHIVED_EVIDENCE_LABEL } from "../evidence-routing.js";
import { stableJson } from "../rocksdb/schema.js";

export const SHADOW_DIFFERENCE_FORMAT_VERSION = 1;

const NEVER_ALLOW = new Set(["missing-canonical", "extra-canonical"]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function documentId(value) {
  return value?.documentId ?? value?.id;
}

function renderedRecallEvidence(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Recall evidence must be a string or document object.");
  }
  const id = documentId(value);
  if (typeof id !== "string" || id.length === 0
    || typeof value.kind !== "string" || value.kind.length === 0
    || typeof value.text !== "string") {
    throw new TypeError("Recall documents require documentId, kind, and text.");
  }
  return `[${ARCHIVED_EVIDENCE_LABEL}]\n\n# ${id} (${value.kind})\n\n`
    + `## Deterministic archived serialization\n${value.text}`;
}

/** Canonical recall bytes exclude locators, scores, hints, and presentation metadata. */
export function canonicalRecallEvidence(value) {
  return renderedRecallEvidence(value);
}

export function hashRecallEvidence(value) {
  return hash(canonicalRecallEvidence(value));
}

function locator(result) {
  const candidate = result.snippetLocation ?? result.matchRange ?? result.byteRange;
  if (candidate && typeof candidate === "object") {
    const startByte = Number(candidate.startByte);
    const endByte = Number(candidate.endByte);
    if (Number.isSafeInteger(startByte) && Number.isSafeInteger(endByte)) {
      return { startByte, endByte };
    }
  }
  if (Number.isSafeInteger(result.startByte) && Number.isSafeInteger(result.endByte)) {
    return { startByte: result.startByte, endByte: result.endByte };
  }
  return null;
}

function searchShape(response) {
  const results = Array.isArray(response) ? response : response?.results;
  if (!Array.isArray(results)) throw new TypeError("Search comparison requires result arrays.");
  const responseMode = Array.isArray(response) ? undefined : response.mode;
  const responseScoreMode = Array.isArray(response) ? undefined : response.scoreMode;
  return results.map((result, rank) => ({
    documentId: documentId(result),
    rank,
    snippetLocation: locator(result),
    scoreMode: result.scoreMode ?? responseScoreMode ?? responseMode ?? "unspecified",
  }));
}

function difference(type, fields = {}) {
  const core = {
    differenceFormatVersion: SHADOW_DIFFERENCE_FORMAT_VERSION,
    type,
    ...fields,
  };
  return {
    ...core,
    differenceId: hash(stableJson(core)),
    allowed: false,
  };
}

function matchingAllowance(candidate, allowlist, now) {
  if (NEVER_ALLOW.has(candidate.type)) return undefined;
  return allowlist.find((entry) => entry
    && entry.type === candidate.type
    && (entry.documentId === undefined || entry.documentId === candidate.documentId)
    && typeof entry.rationale === "string"
    && entry.rationale.trim().length > 0
    && Number.isSafeInteger(entry.expiresAt)
    && entry.expiresAt > now);
}

/** Apply only explicit, unexpired allowances; canonical source absence is never allowlisted. */
export function applyDifferenceAllowlist(differences, allowlist = [], now = Date.now()) {
  if (!Array.isArray(differences) || !Array.isArray(allowlist)) {
    throw new TypeError("Differences and allowlist must be arrays.");
  }
  return differences.map((candidate) => {
    const allowance = matchingAllowance(candidate, allowlist, now);
    if (!allowance) return { ...candidate, allowed: false };
    return {
      ...candidate,
      allowed: true,
      allowance: {
        rationale: allowance.rationale,
        expiresAt: allowance.expiresAt,
      },
    };
  });
}

export function compareRecallEvidence(expected, actual, options = {}) {
  const expectedHash = hashRecallEvidence(expected);
  const actualHash = hashRecallEvidence(actual);
  if (expectedHash === actualHash) return [];
  return applyDifferenceAllowlist([difference("recall-evidence", {
    documentId: documentId(expected) ?? documentId(actual),
    expected: { hash: expectedHash },
    actual: { hash: actualHash },
  })], options.allowlist, options.now);
}

/** Compare IDs, rank, byte location, and scoring mode without conflating their causes. */
export function compareSearchResults(expectedResponse, actualResponse, options = {}) {
  const expected = searchShape(expectedResponse);
  const actual = searchShape(actualResponse);
  const expectedById = new Map(expected.map((candidate) => [candidate.documentId, candidate]));
  const actualById = new Map(actual.map((candidate) => [candidate.documentId, candidate]));
  const differences = [];

  for (const candidate of expected) {
    const other = actualById.get(candidate.documentId);
    if (!other) {
      differences.push(difference("search-candidate-missing", {
        documentId: candidate.documentId,
        expected: candidate,
        actual: null,
      }));
      continue;
    }
    for (const [field, type] of [
      ["rank", "search-rank"],
      ["snippetLocation", "search-snippet-location"],
      ["scoreMode", "search-score-mode"],
    ]) {
      if (stableJson(candidate[field]) !== stableJson(other[field])) {
        differences.push(difference(type, {
          documentId: candidate.documentId,
          expected: { [field]: candidate[field] },
          actual: { [field]: other[field] },
        }));
      }
    }
  }
  for (const candidate of actual) {
    if (!expectedById.has(candidate.documentId)) {
      differences.push(difference("search-candidate-extra", {
        documentId: candidate.documentId,
        expected: null,
        actual: candidate,
      }));
    }
  }
  return applyDifferenceAllowlist(differences, options.allowlist, options.now);
}

export function createShadowDifference(type, fields = {}, options = {}) {
  return applyDifferenceAllowlist(
    [difference(type, fields)],
    options.allowlist,
    options.now,
  )[0];
}
