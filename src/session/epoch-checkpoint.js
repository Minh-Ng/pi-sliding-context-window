import { createHash } from "node:crypto";
import {
  ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
  createCompactionCatalog,
  inspectCheckpointManifest,
  reconstructCheckpointSource,
} from "../archive/archive-checkpoint.js";
import { messageKey } from "./window.js";
import {
  MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
} from "../store/store-contract.js";

const MAX_ARCHIVE_DETAIL_ENTRIES = 1_000;
const MAX_ARCHIVE_DETAIL_PART_IDS = 1_000;
const MAX_ARCHIVE_DETAIL_TOTAL_PART_IDS = 4_096;
export const MAX_TOC_CHECKPOINT_IDS_PER_ENTRY = MAX_ARCHIVE_DETAIL_PART_IDS + 2;
export const CHECKPOINT_ROOT_KIND = "archive-checkpoint-root";
const CHECKPOINT_ROOT_ID = /^checkpoint-root:[a-f0-9]{64}$/u;
const CHECKPOINT_PUBLICATION_ID = /^checkpoint-publication:[a-f0-9]{64}$/u;
const CHECKPOINT_PART_ID = /^checkpoint-part:[a-f0-9]{64}$/u;

export const CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION = 1;

export function checkpointPlanningArchive(archive) {
  return Object.freeze({
    get(id) { return archive.get?.(id); },
    put(document) { return document?.id; },
  });
}

export function checkpointCreatedAt(messages) {
  for (const message of messages) {
    const value = Number(message?.timestamp);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return Date.now();
}

export function checkpointSourceKey(label, messages, text) {
  const hash = createHash("sha256");
  hash.update(label);
  for (const message of messages) {
    const key = messageKey(message);
    hash.update(`\0${Buffer.byteLength(key, "utf8")}:`);
    hash.update(key);
  }
  hash.update(`\0${Buffer.byteLength(text, "utf8")}:`);
  hash.update(text);
  return `${label}:${hash.digest("hex")}`;
}

export function checkpointSourceChunks(messages) {
  const chunks = [];
  let current = [];
  let currentKeyBytes = 0;
  for (const message of messages) {
    const keyBytes = Buffer.byteLength(messageKey(message), "utf8");
    if (current.length > 0 && (
      current.length >= MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT
      || currentKeyBytes + keyBytes > MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT
    )) {
      chunks.push(current);
      current = [];
      currentKeyBytes = 0;
    }
    current.push(message);
    currentKeyBytes += keyBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function checkpointIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    ids.add(entry.publicationId);
    ids.add(entry.rootId);
    for (const partId of entry.partIds) ids.add(partId);
  }
  return ids;
}

function exactObjectKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

const ARCHIVE_ENTRY_KEYS = Object.freeze([
  "rootId",
  "publicationId",
  "kind",
  "topic",
  "terms",
  "byteCount",
  "hash",
  "partCount",
  "partIds",
]);

function checkpointArchiveId(value) {
  return typeof value === "string"
    && (CHECKPOINT_ROOT_ID.test(value)
      || CHECKPOINT_PUBLICATION_ID.test(value)
      || CHECKPOINT_PART_ID.test(value));
}

function normalizedArchiveEntry(value) {
  if (!exactObjectKeys(value, ARCHIVE_ENTRY_KEYS)
    || typeof value.rootId !== "string"
    || !CHECKPOINT_ROOT_ID.test(value.rootId)
    || typeof value.publicationId !== "string"
    || !CHECKPOINT_PUBLICATION_ID.test(value.publicationId)
    || typeof value.kind !== "string" || value.kind.length === 0 || value.kind.length > 80
    || typeof value.topic !== "string" || value.topic.length > 80
    || !Array.isArray(value.terms) || value.terms.length > 8
    || value.terms.some((term) => typeof term !== "string" || term.length > 60)
    || !Number.isSafeInteger(value.byteCount) || value.byteCount < 0
    || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/u.test(value.hash)
    || !Number.isSafeInteger(value.partCount) || value.partCount <= 0
    || !Array.isArray(value.partIds)
    || value.partIds.length !== value.partCount
    || value.partIds.length > MAX_ARCHIVE_DETAIL_PART_IDS
    || value.partIds.some((partId) => typeof partId !== "string"
      || !CHECKPOINT_PART_ID.test(partId))) {
    return undefined;
  }
  return Object.freeze({
    rootId: value.rootId,
    publicationId: value.publicationId,
    kind: value.kind,
    topic: value.topic,
    terms: Object.freeze([...value.terms]),
    byteCount: value.byteCount,
    hash: value.hash,
    partCount: value.partCount,
    partIds: Object.freeze([...value.partIds]),
  });
}

export function normalizedArchiveEntries(value) {
  if (!Array.isArray(value) || value.length === 0
    || value.length > MAX_ARCHIVE_DETAIL_ENTRIES) return undefined;
  const entries = [];
  const roots = new Set();
  let totalPartIds = 0;
  for (const candidate of value) {
    const entry = normalizedArchiveEntry(candidate);
    totalPartIds += entry?.partIds.length ?? 0;
    if (entry === undefined || roots.has(entry.rootId)
      || totalPartIds > MAX_ARCHIVE_DETAIL_TOTAL_PART_IDS) return undefined;
    roots.add(entry.rootId);
    entries.push(entry);
  }
  return Object.freeze(entries);
}

function checkpointDescriptor(archive, rootId) {
  try {
    let root = inspectCheckpointManifest(archive, rootId);
    // New roots commit their complete part layout into their content address.
    // Legacy roots do not, so trust them only after exact byte reconstruction.
    if (root.layoutIdentity === undefined) {
      root = reconstructCheckpointSource(archive, rootId).root;
    }
    return Object.freeze({
      rootId,
      publicationId: root.publicationId,
      kind: root.sourceKind,
      byteCount: root.byteCount,
      hash: root.hash,
      partCount: root.parts.length,
      partIds: Object.freeze(root.parts.map((part) => part.id)),
    });
  } catch {
    return undefined;
  }
}

function checkpointEntryMatchesArchive(archive, entry, requireExactSource) {
  const verified = checkpointDescriptor(archive, entry.rootId);
  const matches = verified !== undefined
    && verified.publicationId === entry.publicationId
    && verified.kind === entry.kind
    && verified.byteCount === entry.byteCount
    && verified.hash === entry.hash
    && verified.partCount === entry.partCount
    && JSON.stringify(verified.partIds) === JSON.stringify(entry.partIds);
  if (!matches || !requireExactSource) return matches;
  try {
    reconstructCheckpointSource(archive, entry.rootId);
    return true;
  } catch {
    return false;
  }
}

export function latestTrustedArchiveEntries(
  branchEntries,
  expectedSummary,
  archive,
  { requireExactSource = false } = {},
) {
  if (!Array.isArray(branchEntries)) return undefined;
  let latest;
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    if (branchEntries[index]?.type === "compaction") {
      latest = branchEntries[index];
      break;
    }
  }
  if (!latest || latest.fromHook !== true || typeof latest.summary !== "string"
    || (expectedSummary !== undefined && latest.summary !== expectedSummary)) return undefined;
  if (!exactObjectKeys(latest.details, ["contextWindowArchive"])) return undefined;
  const namespace = latest.details?.contextWindowArchive;
  if (!exactObjectKeys(namespace, ["version", "entries"])
    || namespace.version !== CONTEXT_WINDOW_ARCHIVE_DETAILS_VERSION) return undefined;
  const entries = normalizedArchiveEntries(namespace.entries);
  if (entries === undefined) return undefined;
  try {
    if (createCompactionCatalog(entries, {
      maxTokens: ARCHIVE_CHECKPOINT_CATALOG_MAX_TOKENS,
    }) !== latest.summary) return undefined;
  } catch {
    return undefined;
  }
  if (entries.some((entry) =>
    !checkpointEntryMatchesArchive(archive, entry, requireExactSource))) {
    return undefined;
  }
  return entries;
}

function mergedArchiveEntries(previous, current) {
  const byRoot = new Map();
  for (const entry of [...previous, ...current]) {
    const existing = byRoot.get(entry.rootId);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
      return undefined;
    }
    byRoot.set(entry.rootId, entry);
  }
  return Object.freeze([...byRoot.values()]);
}

export function normalizedMergedArchiveEntries(previous, current) {
  const merged = mergedArchiveEntries(previous, current);
  return merged === undefined ? undefined : normalizedArchiveEntries(merged);
}

export function restoredTocEntry(value, archive) {
  if (!value || typeof value !== "object" || typeof value.id !== "string") return undefined;
  if (CHECKPOINT_ROOT_ID.test(value.id) && value.archiveIds === undefined) return undefined;
  let archiveIds;
  if (value.archiveIds !== undefined) {
    if (!Array.isArray(value.archiveIds)
      || value.archiveIds.length > MAX_TOC_CHECKPOINT_IDS_PER_ENTRY
      || value.archiveIds.some((id) => !checkpointArchiveId(id))) return undefined;
    archiveIds = [...new Set(value.archiveIds)];
    if (archiveIds.length !== value.archiveIds.length || !archiveIds.includes(value.id)) {
      return undefined;
    }
    const verified = CHECKPOINT_ROOT_ID.test(value.id)
      ? checkpointDescriptor(archive, value.id)
      : undefined;
    const completeIds = verified === undefined
      ? undefined
      : [...new Set([verified.publicationId, verified.rootId, ...verified.partIds])];
    if (completeIds === undefined
      || verified.partCount > MAX_ARCHIVE_DETAIL_PART_IDS
      || completeIds.length > MAX_TOC_CHECKPOINT_IDS_PER_ENTRY
      || completeIds.length !== archiveIds.length
      || completeIds.some((id) => !archiveIds.includes(id))) return undefined;
    archiveIds = completeIds;
  }
  return {
    id: value.id,
    topic: typeof value.topic === "string" ? value.topic : "",
    terms: Array.isArray(value.terms)
      ? value.terms.filter((term) => typeof term === "string")
      : [],
    ...(archiveIds === undefined ? {} : { archiveIds }),
  };
}

export function checkpointResultMatches(planned, stored) {
  return stored?.status === "stored"
    && stored.publicationId === planned.publicationId
    && JSON.stringify(stored.roots) === JSON.stringify(planned.roots)
    && stored.preview === planned.preview
    && stored.catalog === planned.catalog;
}
