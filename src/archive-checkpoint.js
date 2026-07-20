import { createHash } from "node:crypto";
import {
  estimateModelVisibleTokens,
  modelVisiblePrefix,
} from "./model-token-budget.js";
import {
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STORE_IDENTIFIER_LENGTH,
} from "./store-contract.js";
import { contentHash } from "./rocksdb/chunks.js";
import { extractSalientTerms } from "./window.js";

export const ARCHIVE_CHECKPOINT_FORMAT_VERSION = 1;
export const ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS = 1_000;
export const ARCHIVE_CHECKPOINT_PREVIEW_TOKENS = 800;

const PART_PREFIX = "[context-window exact checkpoint part v1]\n";
const PART_PREFIX_BYTES = Buffer.byteLength(PART_PREFIX, "utf8");

// Parts stay below both admission and bounded direct-read limits. That makes
// exact reconstruction possible through the existing archive facade after a
// process restart without introducing an unbounded store response.
export const ARCHIVE_CHECKPOINT_PART_MAX_BYTES = Math.min(
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
);
export const ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES =
  ARCHIVE_CHECKPOINT_PART_MAX_BYTES - PART_PREFIX_BYTES;

const ROOT_KIND = "archive-checkpoint-root";
const PART_KIND = "archive-checkpoint-part";
const PUBLICATION_KIND = "archive-checkpoint-publication";
const PREVIOUS_SUMMARY_KIND = "archive-previous-summary";
const ROOT_ID_PREFIX = "checkpoint-root:";
const PART_ID_PREFIX = "checkpoint-part:";
const PUBLICATION_ID_PREFIX = "checkpoint-publication:";

function wellFormedText(value, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  if (typeof value.isWellFormed === "function" && !value.isWellFormed()) {
    throw new TypeError(`${label} must not contain unpaired UTF-16 surrogates.`);
  }
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function timestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function hashParts(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function utf8BoundaryAtOrBefore(bytes, candidate, floor) {
  let boundary = candidate;
  while (boundary > floor && boundary < bytes.length && (bytes[boundary] & 0xc0) === 0x80) {
    boundary -= 1;
  }
  return boundary;
}

function splitExactParts(text) {
  const source = wellFormedText(text, "source.text");
  const bytes = Buffer.from(source, "utf8");
  const parts = [];
  let startByte = 0;
  let ordinal = 0;
  do {
    const hardEnd = Math.min(bytes.length, startByte + ARCHIVE_CHECKPOINT_PART_PAYLOAD_MAX_BYTES);
    const endByte = hardEnd === bytes.length
      ? hardEnd
      : utf8BoundaryAtOrBefore(bytes, hardEnd, startByte);
    if (endByte <= startByte && bytes.length > 0) {
      throw new Error("Unable to split checkpoint source at a UTF-8 boundary.");
    }
    const payload = bytes.subarray(startByte, endByte);
    const textPart = payload.toString("utf8");
    const hash = contentHash(payload);
    parts.push({
      ordinal,
      startByte,
      endByte,
      byteCount: payload.length,
      hash,
      text: textPart,
    });
    ordinal += 1;
    startByte = endByte;
  } while (startByte < bytes.length);
  return { bytes, parts };
}

function compactTopic(value) {
  const compact = String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(compact).slice(0, 80).join("");
}

function sourceTopic(previewExcerpt, suppliedTopic) {
  const firstLine = compactTopic(previewExcerpt.split("\n", 1)[0]);
  const supplied = compactTopic(suppliedTopic);
  if (supplied && previewExcerpt.includes(supplied)) return supplied;
  return firstLine;
}

function modelVisibleSuffix(text, maxTokens) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) {
    throw new TypeError("maxTokens must be a non-negative safe integer.");
  }
  const codePoints = Array.from(text);
  let low = 0;
  let high = codePoints.length;
  let best = "";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const candidate = codePoints.slice(codePoints.length - count).join("");
    if (estimateModelVisibleTokens(candidate) <= maxTokens) {
      best = candidate;
      low = count + 1;
    } else {
      high = count - 1;
    }
  }
  return best;
}

function previewBody(text, maxTokens, fixedText) {
  const fixedTokens = estimateModelVisibleTokens(fixedText);
  if (fixedTokens > maxTokens) {
    throw new RangeError("Preview token budget is too small for its archive reference.");
  }
  if (estimateModelVisibleTokens(`${fixedText}${text}`) <= maxTokens) {
    return { renderedText: text, visibleSourceText: text };
  }
  const remaining = maxTokens - fixedTokens;
  const headTokens = Math.floor(remaining * 0.7);
  const tailTokens = remaining - headTokens;
  const head = modelVisiblePrefix(text, headTokens);
  const tail = modelVisibleSuffix(text, tailTokens);
  return {
    renderedText: `${head}${fixedText}${tail}`,
    // Keep disjoint ranges separated so extraction cannot manufacture a term
    // across a head/tail boundary that the preview never contained.
    visibleSourceText: [head, tail].filter(Boolean).join("\n"),
  };
}

function sourceAddress({ project, sessionId, sourceKey, sourceMessageKeys, kind, hash }) {
  const identity = [
    "archive-checkpoint-source-v1",
    project,
    sessionId,
    sourceKey,
    kind,
    hash,
  ];
  if (Array.isArray(sourceMessageKeys)
    && (sourceMessageKeys.length !== 1 || sourceMessageKeys[0] !== sourceKey)) {
    identity.push("source-message-keys-v1", ...sourceMessageKeys);
  }
  return hashParts(identity);
}

function normalizeSourceMessageKeys(value, sourceKey) {
  const normalizedSourceKey = identifier(sourceKey, "source.sourceKey");
  if (normalizedSourceKey.length > MAX_STORE_IDENTIFIER_LENGTH) {
    throw new RangeError(
      `source.sourceKey must contain at most ${MAX_STORE_IDENTIFIER_LENGTH} characters.`,
    );
  }
  if (value === undefined) return Object.freeze([normalizedSourceKey]);
  if (!Array.isArray(value) || value.length === 0
    || value.length > MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT) {
    throw new TypeError(
      `source.sourceMessageKeys must contain 1-${MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT} entries.`,
    );
  }
  let bytes = 0;
  const result = value.map((entry, index) => {
    const key = identifier(entry, `source.sourceMessageKeys[${index}]`);
    if (key.length > MAX_STORE_IDENTIFIER_LENGTH) {
      throw new RangeError(
        `source.sourceMessageKeys[${index}] must contain at most ${MAX_STORE_IDENTIFIER_LENGTH} characters.`,
      );
    }
    bytes += Buffer.byteLength(key, "utf8");
    if (bytes > MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT) {
      throw new RangeError(
        `source.sourceMessageKeys must contain at most ${MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT} UTF-8 bytes.`,
      );
    }
    return key;
  });
  return Object.freeze(result);
}

function publicationAddress(sourceAddresses, layoutIdentities) {
  return hashParts([
    "archive-checkpoint-publication-v1",
    ...sourceAddresses,
    ...(layoutIdentities === undefined
      ? []
      : ["layout-committed-v1", ...layoutIdentities]),
  ]);
}

function rootAddress(sourceIdentity, publicationId, layoutIdentity) {
  return hashParts([
    "archive-checkpoint-root-v1",
    sourceIdentity,
    publicationId,
    ...(layoutIdentity === undefined ? [] : ["layout-committed-v1", layoutIdentity]),
  ]);
}

function layoutAddress(byteCount, sourceHash, parts) {
  const values = [
    "archive-checkpoint-layout-v1",
    byteCount,
    sourceHash,
    parts.length,
  ];
  for (const part of parts) {
    values.push(
      part.ordinal,
      part.startByte,
      part.endByte,
      part.byteCount,
      part.hash,
    );
  }
  return hashParts(values);
}

function sourceLayout(source) {
  const { bytes, parts } = splitExactParts(source.text);
  return {
    byteCount: bytes.length,
    parts,
    layoutIdentity: layoutAddress(bytes.length, source.fullHash, parts),
  };
}

function partAddress(project, sessionId, rootId, hash) {
  return hashParts(["archive-checkpoint-part-v1", project, sessionId, rootId, hash]);
}

function putResultId(result) {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") return result.documentId ?? result.id;
  return undefined;
}

function existingDocument(archive, id) {
  if (typeof archive.get !== "function") return undefined;
  return archive.get(id);
}

function documentMatches(existing, expectedText) {
  if (!existing || typeof existing !== "object") return false;
  if (typeof existing.text === "string" && existing.text === expectedText) return true;
  const expectedBytes = Buffer.byteLength(expectedText, "utf8");
  return existing.contentHash === contentHash(expectedText)
    && existing.byteLength === expectedBytes;
}

function putIdempotent(archive, document, options) {
  const existing = existingDocument(archive, document.id);
  if (existing !== undefined) {
    if (!documentMatches(existing, document.text)) {
      throw new Error(`Checkpoint content address ${document.id} resolves to different bytes.`);
    }
    return document.id;
  }
  const result = archive.put(document, options);
  const storedId = putResultId(result);
  if (!result || storedId !== document.id) {
    throw new Error("Archive did not confirm the expected checkpoint document ID.");
  }
  return document.id;
}

function normalizeTerms(previewExcerpt, suppliedTerms) {
  const supplied = Array.isArray(suppliedTerms)
    ? suppliedTerms
      .filter((term) => typeof term === "string")
      .map((term) => term.trim())
      .filter((term) => term.length >= 3 && term.length <= 60 && previewExcerpt.includes(term))
    : [];
  return [...new Set([...supplied, ...extractSalientTerms(previewExcerpt)])].slice(0, 8);
}

function normalizePlannedSource({
  text,
  sessionId,
  project,
  sourceKey,
  sourceMessageKeys,
  kind,
  createdAt,
  topic,
  terms,
}) {
  const normalizedText = wellFormedText(text, "source.text");
  const normalizedSessionId = identifier(sessionId, "sessionId");
  const normalizedProject = identifier(project, "project");
  const normalizedKind = identifier(kind ?? "compaction-source", "source.kind");
  const normalizedCreatedAt = timestamp(createdAt, "source.createdAt");
  const fullHash = contentHash(normalizedText);
  const normalizedSourceKey = sourceKey === undefined
    ? `checkpoint-source:${fullHash}`
    : identifier(sourceKey, "source.sourceKey");
  const normalizedSourceMessageKeys = normalizeSourceMessageKeys(
    sourceMessageKeys,
    normalizedSourceKey,
  );
  const sourceIdentity = sourceAddress({
    project: normalizedProject,
    sessionId: normalizedSessionId,
    sourceKey: normalizedSourceKey,
    sourceMessageKeys: normalizedSourceMessageKeys,
    kind: normalizedKind,
    hash: fullHash,
  });
  return {
    text: normalizedText,
    sessionId: normalizedSessionId,
    project: normalizedProject,
    sourceKey: normalizedSourceKey,
    sourceMessageKeys: normalizedSourceMessageKeys,
    kind: normalizedKind,
    createdAt: normalizedCreatedAt,
    fullHash,
    sourceIdentity,
    topic,
    terms,
  };
}

function planSource(source, publicationId, previewTokens, {
  layoutCommitted = true,
  layout = sourceLayout(source),
} = {}) {
  const normalizedText = source.text;
  const { byteCount, parts, layoutIdentity } = layout;
  const rootId = `${ROOT_ID_PREFIX}${rootAddress(
    source.sourceIdentity,
    publicationId,
    layoutCommitted ? layoutIdentity : undefined,
  )}`;
  for (const part of parts) {
    if (Buffer.byteLength(`${PART_PREFIX}${part.text}`, "utf8") > MAX_DOCUMENT_TEXT_BYTES) {
      throw new Error("Checkpoint part exceeds the store document limit.");
    }
  }
  const references = parts.map((part) => ({
    id: `${PART_ID_PREFIX}${partAddress(
      source.project,
      source.sessionId,
      rootId,
      part.hash,
    )}`,
    ordinal: part.ordinal,
    startByte: part.startByte,
    endByte: part.endByte,
    byteCount: part.byteCount,
    hash: part.hash,
  }));
  const root = {
    checkpointFormatVersion: ARCHIVE_CHECKPOINT_FORMAT_VERSION,
    recordType: "root",
    rootId,
    publicationId,
    sourceIdentity: source.sourceIdentity,
    ...(layoutCommitted ? { layoutIdentity } : {}),
    sessionId: source.sessionId,
    project: source.project,
    sourceKey: source.sourceKey,
    ...(source.sourceMessageKeys.length === 1
      && source.sourceMessageKeys[0] === source.sourceKey
      ? {}
      : { sourceMessageKeys: [...source.sourceMessageKeys] }),
    sourceKind: source.kind,
    encoding: "utf8",
    byteCount,
    hash: source.fullHash,
    parts: references,
  };
  const rootText = JSON.stringify(root);
  if (Buffer.byteLength(rootText, "utf8") > MAX_DIRECT_DOCUMENT_SOURCE_BYTES) {
    throw new RangeError("Checkpoint root manifest exceeds the bounded direct-read limit.");
  }
  const preview = checkpointPreviewDetails(normalizedText, root, { maxTokens: previewTokens });
  return {
    text: normalizedText,
    createdAt: source.createdAt,
    parts,
    references,
    root,
    rootText,
    preview: preview.renderedText,
    catalogMetadata: {
      topic: sourceTopic(preview.visibleSourceText, source.topic),
      terms: normalizeTerms(preview.visibleSourceText, source.terms),
    },
  };
}

function writePlannedParts(archive, plan) {
  const sourceMessageKeys = plan.root.sourceMessageKeys ?? [plan.root.sourceKey];
  const unique = new Set();
  for (const [index, part] of plan.parts.entries()) {
    const reference = plan.references[index];
    if (unique.has(reference.id)) continue;
    unique.add(reference.id);
    const storedText = `${PART_PREFIX}${part.text}`;
    putIdempotent(archive, {
      id: reference.id,
      sessionId: plan.root.sessionId,
      project: plan.root.project,
      kind: PART_KIND,
      text: storedText,
      createdAt: plan.createdAt,
      metadata: {
        checkpointFormatVersion: ARCHIVE_CHECKPOINT_FORMAT_VERSION,
        checkpointRecordType: "part",
        encoding: "utf8",
        contentHash: part.hash,
        byteCount: part.byteCount,
        sourceMessageKeys,
      },
    }, { deferPrune: true, protect: true });
  }
}

function writePlannedRoot(archive, plan) {
  const sourceMessageKeys = plan.root.sourceMessageKeys ?? [plan.root.sourceKey];
  putIdempotent(archive, {
    id: plan.root.rootId,
    sessionId: plan.root.sessionId,
    project: plan.root.project,
    kind: ROOT_KIND,
    text: plan.rootText,
    createdAt: plan.createdAt,
    metadata: {
      checkpointFormatVersion: ARCHIVE_CHECKPOINT_FORMAT_VERSION,
      checkpointRecordType: "root",
      contentHash: plan.root.hash,
      byteCount: plan.root.byteCount,
      partCount: plan.root.parts.length,
      sourceKind: plan.root.sourceKind,
      publicationId: plan.root.publicationId,
      sourceMessageKeys,
    },
  }, { deferPrune: true, protect: true });
}

function summarizePlannedSource(plan) {
  return Object.freeze({
    rootId: plan.root.rootId,
    publicationId: plan.root.publicationId,
    kind: plan.root.sourceKind,
    topic: plan.catalogMetadata.topic,
    terms: Object.freeze([...plan.catalogMetadata.terms]),
    byteCount: plan.root.byteCount,
    hash: plan.root.hash,
    partCount: plan.root.parts.length,
    partIds: Object.freeze(plan.root.parts.map((part) => part.id)),
  });
}

function planPublication(plans, { publicationId, sessionId, project, createdAt }) {
  const layoutCommitted = plans.every((plan) => plan.root.layoutIdentity !== undefined);
  const publication = {
    checkpointFormatVersion: ARCHIVE_CHECKPOINT_FORMAT_VERSION,
    recordType: "publication",
    publicationId,
    sourceIdentities: plans.map((plan) => plan.root.sourceIdentity),
    ...(layoutCommitted
      ? { layoutIdentities: plans.map((plan) => plan.root.layoutIdentity) }
      : {}),
    rootIds: plans.map((plan) => plan.root.rootId),
  };
  const text = JSON.stringify(publication);
  if (Buffer.byteLength(text, "utf8") > MAX_DIRECT_DOCUMENT_SOURCE_BYTES) {
    throw new RangeError("Checkpoint publication manifest exceeds the bounded direct-read limit.");
  }
  // Preserve direct original-message provenance when its aggregate remains
  // within one document's contract. For larger checkpoints, each root already
  // carries those exact keys, so the publication marker references one bounded
  // source key per root instead of duplicating an unbounded aggregate.
  const aggregateSourceMessageKeys = [...new Set(plans.flatMap(
    (plan) => plan.root.sourceMessageKeys ?? [plan.root.sourceKey],
  ))];
  const publicationMetadata = (sourceMessageKeys) => ({
    checkpointFormatVersion: ARCHIVE_CHECKPOINT_FORMAT_VERSION,
    checkpointRecordType: "publication",
    contentHash: contentHash(text),
    rootCount: publication.rootIds.length,
    sourceMessageKeys,
  });
  let sourceMessageKeys = aggregateSourceMessageKeys;
  let metadata;
  try {
    normalizeSourceMessageKeys(sourceMessageKeys, sourceMessageKeys[0]);
    metadata = publicationMetadata(sourceMessageKeys);
    if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_DOCUMENT_METADATA_BYTES) {
      throw new RangeError("Aggregate publication provenance exceeds its metadata bound.");
    }
  } catch {
    sourceMessageKeys = [...new Set(plans.map((plan) => plan.root.sourceKey))];
    normalizeSourceMessageKeys(sourceMessageKeys, sourceMessageKeys[0]);
    metadata = publicationMetadata(sourceMessageKeys);
  }
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_DOCUMENT_METADATA_BYTES) {
    throw new RangeError("Checkpoint publication metadata exceeds the store document limit.");
  }
  return {
    publication,
    text,
    sessionId,
    project,
    createdAt,
    sourceMessageKeys,
    metadata,
  };
}

function completeExistingCheckpoint(archive, plans, publication) {
  if (!documentMatches(existingDocument(archive, publication.publication.publicationId), publication.text)) {
    return false;
  }
  for (const plan of plans) {
    if (!documentMatches(existingDocument(archive, plan.root.rootId), plan.rootText)) return false;
    try {
      if (reconstructCheckpointSource(archive, plan.root.rootId).text !== plan.text) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function writePublication(archive, plan) {
  putIdempotent(archive, {
    id: plan.publication.publicationId,
    sessionId: plan.sessionId,
    project: plan.project,
    kind: PUBLICATION_KIND,
    text: plan.text,
    createdAt: plan.createdAt,
    metadata: plan.metadata,
  }, { deferPrune: true, protect: true });
}

function catalogLine(root) {
  return `- root=${root.rootId} topic=${JSON.stringify(root.topic ?? "")}`
    + ` terms=${JSON.stringify(root.terms ?? [])} bytes=${root.byteCount} sha256=${root.hash}`;
}

/** Build a deterministic catalog that can replace raw compaction input. */
export function createCompactionCatalog(roots, {
  maxTokens = ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
} = {}) {
  if (!Array.isArray(roots) || roots.length === 0) {
    throw new TypeError("roots must be a non-empty array.");
  }
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError("maxTokens must be a positive safe integer.");
  }
  const budget = Math.min(maxTokens, ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS);
  const header = "[Archive checkpoint catalog v1 — exact source is outside the prompt.]";
  const compacted = [
    roots,
    roots.map((root) => ({
      ...root,
      topic: Array.from(root.topic ?? "").slice(0, 40).join(""),
      terms: (root.terms ?? []).slice(0, 4),
    })),
    roots.map((root) => ({
      ...root,
      topic: Array.from(root.topic ?? "").slice(0, 40).join(""),
      terms: [],
    })),
    roots.map((root) => ({ ...root, topic: "", terms: [] })),
  ];
  for (const entries of compacted) {
    const text = `${header}\n${entries.map((root) => catalogLine(root)).join("\n")}`;
    if (estimateModelVisibleTokens(text) <= budget) return text;
  }
  throw new RangeError("Catalog token budget cannot represent every archive root.");
}

function checkpointPreviewDetails(text, root, {
  maxTokens = ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
} = {}) {
  const source = wellFormedText(text, "text");
  if (!root || typeof root !== "object") throw new TypeError("root must be an object.");
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError("maxTokens must be a positive safe integer.");
  }
  const budget = Math.min(maxTokens, ARCHIVE_CHECKPOINT_PREVIEW_TOKENS);
  const header = `[Oversized source archived exactly: root=${identifier(root.rootId, "root.rootId")} bytes=${root.byteCount} sha256=${root.hash}]\n`;
  const divider = "\n[… exact middle omitted; retrieve the archive root for full source …]\n";
  const bodyBudget = budget - estimateModelVisibleTokens(header);
  if (bodyBudget <= 0) {
    throw new RangeError("Preview token budget is too small for its archive reference.");
  }
  if (estimateModelVisibleTokens(source) <= bodyBudget) {
    return { renderedText: `${header}${source}`, visibleSourceText: source };
  }
  const body = previewBody(source, bodyBudget, divider);
  return {
    renderedText: `${header}${body.renderedText}`,
    visibleSourceText: body.visibleSourceText,
  };
}

/** Build a deterministic provider-facing head/tail preview for one published root. */
export function createCheckpointPreview(text, root, options = {}) {
  return checkpointPreviewDetails(text, root, options).renderedText;
}

function normalizedSource(source, defaults) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("Each checkpoint source must be an object.");
  }
  return {
    text: source.text,
    sessionId: source.sessionId ?? defaults.sessionId,
    project: source.project ?? defaults.project,
    sourceKey: source.sourceKey,
    sourceMessageKeys: source.sourceMessageKeys,
    kind: source.kind,
    createdAt: source.createdAt ?? defaults.createdAt,
    topic: source.topic,
    terms: source.terms,
  };
}

/**
 * Publish exact source roots and return only bounded model-visible material.
 * A failure result intentionally has no roots, preview, or catalog fields.
 */
export function createArchiveCheckpoint({
  archive,
  sessionId,
  project,
  sources = [],
  previousSummary,
  previousSummaryCoveredByTrustedCatalog = false,
  createdAt = Date.now(),
  previewSourceIndex = 0,
  previewTokens = ARCHIVE_CHECKPOINT_PREVIEW_TOKENS,
  catalogTokens = ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
} = {}) {
  try {
    if (!archive || typeof archive.put !== "function") {
      throw new TypeError("archive must provide put().");
    }
    const defaults = {
      sessionId: identifier(sessionId, "sessionId"),
      project: identifier(project, "project"),
      createdAt: timestamp(createdAt, "createdAt"),
    };
    if (!Array.isArray(sources)) throw new TypeError("sources must be an array.");
    const normalized = sources.map((source) => normalizedSource(source, defaults));
    if (previousSummary !== undefined && previousSummaryCoveredByTrustedCatalog !== true) {
      const summary = typeof previousSummary === "string"
        ? { text: previousSummary }
        : previousSummary;
      if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
        throw new TypeError("previousSummary must be a string or source object.");
      }
      normalized.push(normalizedSource({
        ...summary,
        kind: PREVIOUS_SUMMARY_KIND,
        topic: summary.topic ?? "Previous compaction summary",
      }, defaults));
    }
    if (normalized.length === 0) throw new TypeError("At least one exact source is required.");
    if (!Number.isSafeInteger(previewSourceIndex)
      || previewSourceIndex < 0
      || previewSourceIndex >= normalized.length) {
      throw new RangeError("previewSourceIndex must identify a checkpoint source.");
    }

    // Plan every bounded value before the first write. Oversized manifests,
    // impossible catalogs, previews, and malformed input therefore cannot
    // leave partial archive state.
    const plannedSources = normalized.map(normalizePlannedSource);
    const sourceIdentities = plannedSources.map((source) => source.sourceIdentity);
    const sourceLayouts = plannedSources.map(sourceLayout);
    const legacyPublicationId = `${PUBLICATION_ID_PREFIX}${publicationAddress(sourceIdentities)}`;
    if (existingDocument(archive, legacyPublicationId) !== undefined) {
      const legacyPlans = plannedSources.map((source, index) => planSource(
        source,
        legacyPublicationId,
        previewTokens,
        { layoutCommitted: false, layout: sourceLayouts[index] },
      ));
      const legacyRoots = legacyPlans.map(summarizePlannedSource);
      const legacyPublication = planPublication(legacyPlans, {
        publicationId: legacyPublicationId,
        ...defaults,
      });
      const legacyCatalog = createCompactionCatalog(legacyRoots, { maxTokens: catalogTokens });
      const legacyPreview = legacyPlans[previewSourceIndex].preview;
      // Preserve the content addresses of a complete checkpoint written by the
      // original v1 layout. Reuse is allowed only after exact reconstruction;
      // incomplete or tampered legacy state falls through to the committed
      // layout format and receives distinct addresses.
      if (completeExistingCheckpoint(archive, legacyPlans, legacyPublication)) {
        return Object.freeze({
          status: "stored",
          publicationId: legacyPublicationId,
          roots: Object.freeze(legacyRoots),
          catalog: legacyCatalog,
          preview: legacyPreview,
        });
      }
    }
    const publicationId = `${PUBLICATION_ID_PREFIX}${publicationAddress(
      sourceIdentities,
      sourceLayouts.map((layout) => layout.layoutIdentity),
    )}`;
    const plans = plannedSources.map((source, index) => planSource(
      source,
      publicationId,
      previewTokens,
      { layout: sourceLayouts[index] },
    ));
    const roots = plans.map(summarizePlannedSource);
    const publication = planPublication(plans, { publicationId, ...defaults });
    const catalog = createCompactionCatalog(roots, { maxTokens: catalogTokens });
    const preview = plans[previewSourceIndex].preview;

    // Every content part for every source precedes every root. Individual roots
    // remain staged and unusable until the all-root publication marker commits.
    for (const plan of plans) writePlannedParts(archive, plan);
    for (const plan of plans) writePlannedRoot(archive, plan);
    writePublication(archive, publication);
    return Object.freeze({
      status: "stored",
      publicationId,
      roots: Object.freeze(roots),
      catalog,
      preview,
    });
  } catch {
    return Object.freeze({
      status: "failed",
      code: "archive-checkpoint-failed",
      message: "Exact archive checkpoint could not be confirmed.",
    });
  }
}

function parseRoot(document, rootId) {
  if (!document || typeof document.text !== "string") {
    throw new Error("Checkpoint root is missing or not directly readable.");
  }
  let root;
  try {
    root = JSON.parse(document.text);
  } catch {
    throw new Error("Checkpoint root is not valid JSON.");
  }
  if (!root || root.checkpointFormatVersion !== ARCHIVE_CHECKPOINT_FORMAT_VERSION
    || root.recordType !== "root" || root.rootId !== rootId
    || typeof root.publicationId !== "string"
    || !root.publicationId.startsWith(PUBLICATION_ID_PREFIX)
    || typeof root.sourceIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(root.sourceIdentity)
    || (root.layoutIdentity !== undefined
      && (typeof root.layoutIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(root.layoutIdentity)))
    || root.encoding !== "utf8" || !Array.isArray(root.parts) || root.parts.length === 0
    || typeof root.hash !== "string" || !/^[a-f0-9]{64}$/u.test(root.hash)
    || !Number.isSafeInteger(root.byteCount) || root.byteCount < 0) {
    throw new Error("Checkpoint root manifest is malformed.");
  }
  let sourceMessageKeys;
  let normalizedProject;
  let normalizedSessionId;
  let normalizedSourceKey;
  let normalizedSourceKind;
  try {
    normalizedProject = identifier(root.project, "root.project");
    normalizedSessionId = identifier(root.sessionId, "root.sessionId");
    normalizedSourceKey = identifier(root.sourceKey, "root.sourceKey");
    normalizedSourceKind = identifier(root.sourceKind, "root.sourceKind");
    sourceMessageKeys = normalizeSourceMessageKeys(
      root.sourceMessageKeys,
      normalizedSourceKey,
    );
  } catch {
    throw new Error("Checkpoint root source identity is malformed.");
  }
  const expectedSourceIdentity = sourceAddress({
    project: normalizedProject,
    sessionId: normalizedSessionId,
    sourceKey: normalizedSourceKey,
    sourceMessageKeys,
    kind: normalizedSourceKind,
    hash: root.hash,
  });
  if (root.sourceIdentity !== expectedSourceIdentity) {
    throw new Error("Checkpoint root source identity is invalid.");
  }
  const expectedId = `${ROOT_ID_PREFIX}${rootAddress(
    root.sourceIdentity,
    root.publicationId,
    root.layoutIdentity,
  )}`;
  if (expectedId !== rootId) throw new Error("Checkpoint root content address is invalid.");
  return root.sourceMessageKeys === undefined
    ? root
    : { ...root, sourceMessageKeys: [...sourceMessageKeys] };
}

function parsePublication(document, publicationId) {
  if (!document || typeof document.text !== "string") {
    throw new Error("Checkpoint publication is missing or not directly readable.");
  }
  let publication;
  try {
    publication = JSON.parse(document.text);
  } catch {
    throw new Error("Checkpoint publication is not valid JSON.");
  }
  if (!publication
    || publication.checkpointFormatVersion !== ARCHIVE_CHECKPOINT_FORMAT_VERSION
    || publication.recordType !== "publication"
    || publication.publicationId !== publicationId
    || !Array.isArray(publication.sourceIdentities)
    || (publication.layoutIdentities !== undefined
      && !Array.isArray(publication.layoutIdentities))
    || !Array.isArray(publication.rootIds)
    || publication.sourceIdentities.length === 0
    || publication.sourceIdentities.length !== publication.rootIds.length
    || (publication.layoutIdentities !== undefined
      && (publication.layoutIdentities.length !== publication.rootIds.length
        || publication.layoutIdentities.some((identity) =>
          typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity))))
    || publication.sourceIdentities.some((identity) =>
      typeof identity !== "string" || !/^[a-f0-9]{64}$/u.test(identity))) {
    throw new Error("Checkpoint publication manifest is malformed.");
  }
  const expectedPublicationId = `${PUBLICATION_ID_PREFIX}${publicationAddress(
    publication.sourceIdentities,
    publication.layoutIdentities,
  )}`;
  if (expectedPublicationId !== publicationId) {
    throw new Error("Checkpoint publication content address is invalid.");
  }
  for (let index = 0; index < publication.rootIds.length; index += 1) {
    const expectedRootId = `${ROOT_ID_PREFIX}${rootAddress(
      publication.sourceIdentities[index],
      publicationId,
      publication.layoutIdentities?.[index],
    )}`;
    if (publication.rootIds[index] !== expectedRootId) {
      throw new Error("Checkpoint publication contains an invalid root address.");
    }
  }
  return publication;
}

/** Verify the bounded root/publication manifests and their complete part layout. */
export function inspectCheckpointManifest(archive, rootId) {
  if (!archive || typeof archive.get !== "function") {
    throw new TypeError("archive must provide get().");
  }
  const normalizedRootId = identifier(rootId, "rootId");
  const root = parseRoot(archive.get(normalizedRootId), normalizedRootId);
  const publication = parsePublication(
    archive.get(root.publicationId),
    root.publicationId,
  );
  const publicationIndex = publication.rootIds.indexOf(normalizedRootId);
  if (publicationIndex < 0
    || publication.sourceIdentities[publicationIndex] !== root.sourceIdentity
    || publication.layoutIdentities?.[publicationIndex] !== root.layoutIdentity) {
    throw new Error("Checkpoint root is not covered by its complete publication.");
  }
  let cursor = 0;
  for (let ordinal = 0; ordinal < root.parts.length; ordinal += 1) {
    const reference = root.parts[ordinal];
    if (!reference || typeof reference.id !== "string"
      || reference.ordinal !== ordinal || reference.startByte !== cursor
      || !Number.isSafeInteger(reference.endByte) || reference.endByte < cursor
      || reference.byteCount !== reference.endByte - reference.startByte
      || typeof reference.hash !== "string" || !/^[a-f0-9]{64}$/u.test(reference.hash)) {
      throw new Error("Checkpoint root contains an invalid part layout.");
    }
    const expectedPartId = `${PART_ID_PREFIX}${partAddress(
      root.project,
      root.sessionId,
      root.rootId,
      reference.hash,
    )}`;
    if (reference.id !== expectedPartId) {
      throw new Error(`Checkpoint part ${reference.id} has an invalid content address.`);
    }
    cursor = reference.endByte;
  }
  if (cursor !== root.byteCount) {
    throw new Error("Checkpoint root part layout does not cover its declared byte count.");
  }
  if (root.layoutIdentity !== undefined) {
    const expectedLayoutIdentity = layoutAddress(root.byteCount, root.hash, root.parts);
    if (root.layoutIdentity !== expectedLayoutIdentity) {
      throw new Error("Checkpoint root part layout identity is invalid.");
    }
  }
  return Object.freeze(structuredClone(root));
}

/** Reassemble and verify one exact source through the bounded archive facade. */
export function reconstructCheckpointSource(archive, rootId) {
  const root = inspectCheckpointManifest(archive, rootId);
  const payloads = new Map();
  const buffers = [];
  for (let ordinal = 0; ordinal < root.parts.length; ordinal += 1) {
    const reference = root.parts[ordinal];
    let payload = payloads.get(reference.id);
    if (payload === undefined) {
      const document = archive.get(reference.id);
      if (!document || typeof document.text !== "string" || !document.text.startsWith(PART_PREFIX)) {
        throw new Error(`Checkpoint part ${reference.id} is missing or malformed.`);
      }
      payload = Buffer.from(document.text.slice(PART_PREFIX.length), "utf8");
      payloads.set(reference.id, payload);
    }
    if (payload.length !== reference.byteCount || contentHash(payload) !== reference.hash) {
      throw new Error(`Checkpoint part ${reference.id} failed integrity verification.`);
    }
    buffers.push(payload);
  }
  const bytes = Buffer.concat(buffers);
  if (bytes.length !== root.byteCount || contentHash(bytes) !== root.hash) {
    throw new Error("Checkpoint source failed root integrity verification.");
  }
  return Object.freeze({
    root: Object.freeze(structuredClone(root)),
    text: bytes.toString("utf8"),
  });
}
