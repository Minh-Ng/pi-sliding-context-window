import { ARCHIVED_EVIDENCE_LABEL } from "./evidence-routing.js";
import { archiveDocumentProvenance } from "./provenance.js";

const TRUNCATION_MARKER = "[… retrieval truncated …]";

function characterLimit(tokens) {
  const numeric = Number(tokens);
  return Math.max(1, Number.isFinite(numeric) ? numeric : 1) * 4;
}

function capCharacters(text, max, marker = TRUNCATION_MARKER) {
  if (text.length <= max) return text;
  const available = Math.max(0, Math.floor(max));
  if (available === 0) return "";

  const suffix = `\n${marker}`;
  if (suffix.length < available) {
    return `${text.slice(0, available - suffix.length)}${suffix}`;
  }

  // A clipped prose marker is less useful than the retrieved prefix. Fall back to
  // one unambiguous character so tiny limits still preserve as much evidence as possible.
  if (available === 1) return "…";
  return `${text.slice(0, available - 1)}…`;
}

export function capText(text, tokens, marker = TRUNCATION_MARKER) {
  return capCharacters(text, characterLimit(tokens), marker);
}

export function formatSearchResults(results, tokenLimit) {
  const heading = `[${ARCHIVED_EVIDENCE_LABEL}]`;
  const body = results.length
    ? results.map((result, index) =>
      `## ${index + 1}. ${result.id} (${result.kind})\n${result.snippet || result.text}`,
    ).join("\n\n")
    : "No matching archived context.";
  return capText(`${heading}\n\n${body}`, tokenLimit);
}

function conciseProvenance(provenance, includeSourceBounds = true) {
  const { archive, sourceMessages, toolResult } = provenance;
  const lines = [
    "## Provenance summary",
    `- Archive: ${archive.id} (${archive.kind})`,
  ];

  if (sourceMessages.status === "available") {
    if (sourceMessages.archivedTurn === false) {
      lines.push(`- Source message: ${sourceMessages.firstKey} (one original message; this tool-result document is not an archived turn)`);
    } else {
      lines.push(`- Source messages: ${sourceMessages.count} ordered key(s)`);
      if (includeSourceBounds) {
        lines.push(
          `- First source key: ${sourceMessages.firstKey}`,
          `- Last source key: ${sourceMessages.lastKey}`,
        );
      }
    }
  } else {
    lines.push(`- Source messages: ${sourceMessages.status} — ${sourceMessages.reason}`);
  }

  if (toolResult?.toolCallId || toolResult?.toolName) {
    const identity = [toolResult.toolCallId, toolResult.toolName].filter(Boolean).join(" / ");
    lines.push(`- Tool call: ${identity}`);
  }
  return lines.join("\n");
}

function additionalProvenance(provenance) {
  const { archive, sourceMessages, toolResult } = provenance;
  const lines = ["## Additional provenance"];
  if (archive.sessionId) lines.push(`- Session: ${archive.sessionId}`);
  if (archive.project) lines.push(`- Project: ${archive.project}`);
  if (archive.createdAt !== undefined) {
    const iso = new Date(archive.createdAt).toISOString();
    lines.push(`- Created: ${iso} (${archive.createdAt})`);
  }
  if (sourceMessages.status === "available" && sourceMessages.archivedTurn !== false) {
    lines.push(`- Ordered source message keys: ${sourceMessages.keys.join(", ")}`);
  }
  if (provenance.metadata) {
    lines.push(`- Metadata: ${provenance.metadata.status} — ${provenance.metadata.error}`);
  }
  if (toolResult?.toolCallId) lines.push(`- Tool call ID: ${toolResult.toolCallId}`);
  if (toolResult?.toolName) lines.push(`- Tool name: ${toolResult.toolName}`);
  return lines.length === 1 ? "" : lines.join("\n");
}

export function formatRecalledDocument(document, tokenLimit, requestedId) {
  const heading = `[${ARCHIVED_EVIDENCE_LABEL}]`;
  if (!document) {
    const suffix = requestedId ? ` with id ${requestedId}` : "";
    return capText(`${heading}\n\nNo archived document${suffix}.`, tokenLimit);
  }

  const provenance = document.provenance ?? archiveDocumentProvenance(document);
  const max = characterLimit(tokenLimit);
  const evidencePrefix = `${heading}\n\n# ${document.id} (${document.kind})\n\n## Deterministic archived serialization\n`;
  if (evidencePrefix.length >= max) return capCharacters(evidencePrefix, max);

  const evidenceBudget = max - evidencePrefix.length;
  if (document.text.length > evidenceBudget) {
    // With exactly one character left, preserve actual evidence rather than
    // spending that final character on a truncation marker.
    const evidence = evidenceBudget === 1
      ? document.text.slice(0, 1)
      : capCharacters(document.text, evidenceBudget);
    return `${evidencePrefix}${evidence}`;
  }

  let output = `${evidencePrefix}${document.text}`;
  const separator = "\n\n";
  for (const section of [conciseProvenance(provenance), additionalProvenance(provenance)]) {
    if (!section) continue;
    const remaining = max - output.length;
    if (remaining <= separator.length) break;
    const sectionBudget = remaining - separator.length;
    output += `${separator}${capCharacters(section, sectionBudget)}`;
    if (section.length > sectionBudget) break;
  }
  return output;
}

export function compactTokenCount(tokens) {
  if (tokens == null) return "-";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : String(tokens);
}

function identity(text) {
  return text;
}

export function statusUrgency(status) {
  if (status.rotationPending) return "queued";
  if (status.activeTurns == null || status.activeTokens == null) return "unknown";
  const progress = Math.max(
    status.activeTurns / status.rotationTurns,
    status.activeTokens / status.rotationTokens,
  );
  if (progress >= 1) return "limit";
  if (progress >= 0.8) return "near";
  return "normal";
}

export function formatStatusLine(status, style = {}) {
  const accent = style.accent ?? identity;
  const muted = style.muted ?? identity;
  const warning = style.warning ?? identity;
  const separator = muted(" · ");
  const title = accent("Epoch");
  const urgency = statusUrgency(status);

  if (status.activeTurns == null || status.activeTokens == null) {
    const sections = [
      title,
      muted("waiting to measure"),
      muted(`limits ${status.rotationTurns} turns / ${compactTokenCount(status.rotationTokens)} tokens`),
    ];
    if (status.rotationPending) sections.push(warning("rotation queued"));
    return sections.join(separator);
  }

  const sections = [
    title,
    `${status.activeTurns}/${status.rotationTurns} turns`,
    `~${compactTokenCount(status.activeTokens)}/${compactTokenCount(status.rotationTokens)} tokens`,
  ];
  if (urgency === "queued") sections.push(warning("rotation queued"));
  else if (urgency === "limit") sections.push(warning("at limit"));
  else if (urgency === "near") sections.push(warning("near limit"));
  if (status.lastRotationMode === "emergency-retention" && status.effectiveRetainTurns != null) {
    sections.push(warning(`emergency retention ${status.effectiveRetainTurns}/${status.retainTurns}`));
  }
  if (status.compactionFallbackReason) sections.push(warning("native compaction needed"));
  return sections.join(separator);
}

export function formatStatusDetails(status) {
  const sections = [
    status.activeTurns == null || status.activeTokens == null
      ? "Active epoch: not measured since session start/reload"
      : `Active epoch: ${status.activeTurns} user-role message(s), ~${status.activeTokens.toLocaleString()} tokens`,
    `Rotate at: ${status.rotationTokens.toLocaleString()} tokens or ${status.rotationTurns} user-role messages; retain: ${status.retainTurns} user-role messages`,
  ];
  if (status.modelPattern) sections.push(`Model profile: ${status.modelPattern}`);
  if (status.lastRotationMode === "emergency-retention") {
    sections.push(`Last rotation: emergency ${status.lastRotationReason}; retained ${status.effectiveRetainTurns}/${status.retainTurns} user-role messages`);
  }
  if (status.compactionFallbackReason) {
    sections.push(`Native compaction fallback: ${status.compactionFallbackReason}`);
  }
  sections.push(
    `Rotations: ${status.rotations}; archived documents: ${status.archivedDocuments}`,
    `Database: ${status.dbPath}`,
  );
  return sections.join("\n");
}
