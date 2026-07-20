function availableTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

const SOURCE_METADATA_FIELDS = [
  "sourceMessageKeys",
  "sourceFirstKey",
  "sourceLastKey",
  "sourceMessageCount",
  "sourceMessageKey",
];

function unavailableSourceMessages(document, metadata) {
  const metadataParse = document.metadataParse;
  if (metadataParse?.status && metadataParse.status !== "valid") {
    return {
      status: "metadata-invalid",
      reason: `Source-message provenance is unavailable because archive metadata is ${metadataParse.status}.`,
    };
  }

  if (SOURCE_METADATA_FIELDS.some((field) => Object.hasOwn(metadata, field))) {
    return {
      status: "incomplete",
      reason: "Source-message provenance fields are partial or inconsistent.",
    };
  }

  if (document.kind === "turn" || document.kind === "preamble" || document.kind === "decision-candidate") {
    return {
      status: "legacy-unavailable",
      reason: "Ordered source message keys were not recorded for this legacy archived turn.",
    };
  }
  if (document.kind === "tool-result" || document.kind === "tool-argument") {
    return {
      status: "legacy-unavailable",
      reason: `A source message key was not recorded for this legacy ${document.kind} archive; it is not an archived turn.`,
    };
  }
  return {
    status: "unavailable",
    reason: "No stable source message keys were recorded for this archive document.",
  };
}

/**
 * Return a stable, host-facing provenance shape for an archive document.
 * Legacy rows remain readable even when their metadata predates source keys.
 */
export function archiveDocumentProvenance(document) {
  if (!document) return undefined;

  const metadata = document.metadata && typeof document.metadata === "object" && !Array.isArray(document.metadata)
    ? document.metadata
    : {};
  const provenance = {
    archive: {
      id: document.id,
      kind: document.kind,
      ...(document.sessionId ? { sessionId: document.sessionId } : {}),
      ...(document.project ? { project: document.project } : {}),
      ...(availableTimestamp(document.createdAt) !== undefined
        ? { createdAt: availableTimestamp(document.createdAt) }
        : {}),
    },
  };

  if (document.metadataParse?.status && document.metadataParse.status !== "valid") {
    provenance.metadata = { ...document.metadataParse };
  }

  const keys = metadata.sourceMessageKeys;
  const sourceCount = metadata.sourceMessageCount;
  const archivedTurnKind = document.kind === "turn" || document.kind === "preamble" || document.kind === "decision-candidate";
  const completeSourceMetadata = archivedTurnKind
    && Array.isArray(keys)
    && keys.every((key) => typeof key === "string" && key.length > 0)
    && keys.length > 0
    && typeof sourceCount === "number"
    && Number.isInteger(sourceCount)
    && sourceCount === keys.length
    && typeof metadata.sourceFirstKey === "string"
    && metadata.sourceFirstKey === keys[0]
    && typeof metadata.sourceLastKey === "string"
    && metadata.sourceLastKey === keys.at(-1)
    && !Object.hasOwn(metadata, "sourceMessageKey");
  const toolSourceKey = metadata.sourceMessageKey;
  const completeToolSourceMetadata = (document.kind === "tool-result" || document.kind === "tool-argument")
    && typeof toolSourceKey === "string"
    && toolSourceKey.length > 0
    && !SOURCE_METADATA_FIELDS.some((field) => field !== "sourceMessageKey" && Object.hasOwn(metadata, field));

  if (completeSourceMetadata) {
    provenance.sourceMessages = {
      status: "available",
      keys: [...keys],
      firstKey: metadata.sourceFirstKey,
      lastKey: metadata.sourceLastKey,
      count: sourceCount,
    };
  } else if (completeToolSourceMetadata) {
    provenance.sourceMessages = {
      status: "available",
      keys: [toolSourceKey],
      firstKey: toolSourceKey,
      lastKey: toolSourceKey,
      count: 1,
      archivedTurn: false,
    };
  } else {
    provenance.sourceMessages = unavailableSourceMessages(document, metadata);
  }

  if (document.kind === "decision-candidate") {
    provenance.decisionCandidate = {
      // Verbatim quote of a decision-shaped sentence; heuristic extraction,
      // not a verified decision record.
      verbatim: true,
      ...(typeof metadata.sourceTurnId === "string" && metadata.sourceTurnId
        ? { sourceTurnId: metadata.sourceTurnId }
        : {}),
    };
  }

  if (document.kind === "tool-result") {
    provenance.toolResult = {
      ...(metadata.toolCallId ? { toolCallId: String(metadata.toolCallId) } : {}),
      ...(metadata.toolName ? { toolName: String(metadata.toolName) } : {}),
      ...(completeToolSourceMetadata ? { sourceMessageKey: toolSourceKey, archivedTurn: false } : {}),
    };
  }

  if (document.kind === "tool-argument") {
    provenance.toolArgument = {
      ...(metadata.toolCallId ? { toolCallId: String(metadata.toolCallId) } : {}),
      ...(metadata.toolName ? { toolName: String(metadata.toolName) } : {}),
      ...(completeToolSourceMetadata ? { sourceMessageKey: toolSourceKey, archivedTurn: false } : {}),
    };
  }

  return provenance;
}
