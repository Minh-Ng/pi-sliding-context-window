import { createHash } from "node:crypto";
import { serializeMessage } from "../src/session/window.js";

export const config = {
  rotationTokens: 100_000,
  rotationTurns: 3,
  hardLimitTokens: 120_000,
  retainTurns: 1,
  maxInlineUserTokens: 16_000,
  maxToolResultTokens: 4_000,
  maxToolArgumentTokens: 4_000,
  searchResults: 3,
  searchResultTokens: 1_500,
  preventAutoCompaction: true,
  dbPath: "/tmp/archive.db",
};

export function user(text, timestamp) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function assistant(text, timestamp) {
  return { role: "assistant", content: [{ type: "text", text }], timestamp };
}

export function persistedLegacyBoundaryKey(message) {
  const digest = createHash("sha256")
    .update(serializeMessage(message).slice(0, 8_000))
    .digest("hex")
    .slice(0, 12);
  return `${message.role}:${message.timestamp}::${digest}`;
}

export function memoryArchive() {
  const documents = new Map();
  return {
    documents,
    closed: false,
    put(document) {
      const id = document.id ?? `doc-${documents.size + 1}`;
      documents.set(id, { ...document, id });
      return id;
    },
    search() { return []; },
    get(id) { return documents.get(id); },
    count() { return documents.size; },
    close() { this.closed = true; },
  };
}

export function trackingMemoryArchive() {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  archive.putCalls = 0;
  archive.pruneCalls = 0;
  archive.protectionRequests = [];
  archive.put = (document, options) => {
    archive.putCalls += 1;
    return put(document, options);
  };
  archive.prune = () => {
    archive.pruneCalls += 1;
  };
  archive.setProtectedContext = (request) => {
    archive.protectionRequests.push(structuredClone(request));
  };
  return archive;
}

export function archiveEntryIds(entries) {
  return new Set(entries.flatMap((entry) => [
    entry.publicationId,
    entry.rootId,
    ...entry.partIds,
  ]));
}

export function checkpointHashParts(parts) {
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

export function seedLegacyCheckpoint(archive, {
  text,
  project,
  sessionId,
  sourceKey,
  kind,
}) {
  const hash = createHash("sha256").update(text).digest("hex");
  const sourceIdentity = checkpointHashParts([
    "archive-checkpoint-source-v1",
    project,
    sessionId,
    sourceKey,
    kind,
    hash,
  ]);
  const publicationId = `checkpoint-publication:${checkpointHashParts([
    "archive-checkpoint-publication-v1",
    sourceIdentity,
  ])}`;
  const rootId = `checkpoint-root:${checkpointHashParts([
    "archive-checkpoint-root-v1",
    sourceIdentity,
    publicationId,
  ])}`;
  const partId = `checkpoint-part:${checkpointHashParts([
    "archive-checkpoint-part-v1",
    project,
    sessionId,
    rootId,
    hash,
  ])}`;
  const byteCount = Buffer.byteLength(text, "utf8");
  archive.documents.set(partId, {
    id: partId,
    text: `[context-window exact checkpoint part v1]\n${text}`,
  });
  archive.documents.set(rootId, {
    id: rootId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "root",
      rootId,
      publicationId,
      sourceIdentity,
      sessionId,
      project,
      sourceKey,
      sourceKind: kind,
      encoding: "utf8",
      byteCount,
      hash,
      parts: [{
        id: partId,
        ordinal: 0,
        startByte: 0,
        endByte: byteCount,
        byteCount,
        hash,
      }],
    }),
  });
  archive.documents.set(publicationId, {
    id: publicationId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "publication",
      publicationId,
      sourceIdentities: [sourceIdentity],
      rootIds: [rootId],
    }),
  });
  return { publicationId, rootId, partId };
}

export function seedVerifiedCheckpointEntries(archive, partCounts, {
  project = "/project",
  sessionId = "seeded-checkpoint-session",
} = {}) {
  const emptyHash = createHash("sha256").update("").digest("hex");
  const sources = partCounts.map((_, index) => {
    const sourceKey = `seeded-source-${index}`;
    const sourceIdentity = checkpointHashParts([
      "archive-checkpoint-source-v1",
      project,
      sessionId,
      sourceKey,
      "compaction-span",
      emptyHash,
    ]);
    return { sourceKey, sourceIdentity };
  });
  const publicationId = `checkpoint-publication:${checkpointHashParts([
    "archive-checkpoint-publication-v1",
    ...sources.map(({ sourceIdentity }) => sourceIdentity),
  ])}`;
  const rootIds = sources.map(({ sourceIdentity }) =>
    `checkpoint-root:${checkpointHashParts([
      "archive-checkpoint-root-v1",
      sourceIdentity,
      publicationId,
    ])}`);
  archive.documents.set(publicationId, {
    id: publicationId,
    text: JSON.stringify({
      checkpointFormatVersion: 1,
      recordType: "publication",
      publicationId,
      sourceIdentities: sources.map(({ sourceIdentity }) => sourceIdentity),
      rootIds,
    }),
  });

  return sources.map(({ sourceKey, sourceIdentity }, index) => {
    const rootId = rootIds[index];
    const partId = `checkpoint-part:${checkpointHashParts([
      "archive-checkpoint-part-v1",
      project,
      sessionId,
      rootId,
      emptyHash,
    ])}`;
    archive.documents.set(partId, {
      id: partId,
      text: "[context-window exact checkpoint part v1]\n",
    });
    const parts = Array.from({ length: partCounts[index] }, (_, ordinal) => ({
      id: partId,
      ordinal,
      startByte: 0,
      endByte: 0,
      byteCount: 0,
      hash: emptyHash,
    }));
    archive.documents.set(rootId, {
      id: rootId,
      text: JSON.stringify({
        checkpointFormatVersion: 1,
        recordType: "root",
        rootId,
        publicationId,
        sourceIdentity,
        sessionId,
        project,
        sourceKey,
        sourceKind: "compaction-span",
        encoding: "utf8",
        byteCount: 0,
        hash: emptyHash,
        parts,
      }),
    });
    return {
      rootId,
      publicationId,
      kind: "compaction-span",
      topic: "",
      terms: [],
      byteCount: 0,
      hash: emptyHash,
      partCount: parts.length,
      partIds: parts.map(({ id }) => id),
    };
  });
}

export function pressureArchive(limit) {
  const archive = memoryArchive();
  const put = archive.put.bind(archive);
  let protectedIds = new Set();
  archive.setProtectedContext = ({ documentIds = [] } = {}) => {
    protectedIds = new Set(documentIds);
  };
  archive.prune = () => {
    for (const id of archive.documents.keys()) {
      if (archive.documents.size <= limit) break;
      if (!protectedIds.has(id)) archive.documents.delete(id);
    }
  };
  archive.put = (document, { deferPrune = false } = {}) => {
    const id = put(document);
    if (!deferPrune) archive.prune();
    return archive.documents.has(id) ? id : undefined;
  };
  return archive;
}
