import {
  RETENTION_FORMAT_VERSION,
  identifier,
  requireStore,
  retentionKeys,
  timestamp,
} from "./shared.js";

export function forceEligibleEphemeral(candidate, manifest) {
  // Emergency shortening is deliberately narrower than the retention class:
  // source turns are never candidates, including a session's newest turn.
  return candidate.retentionClass === "ephemeral-payload"
    && manifest?.retentionClass === "ephemeral-payload"
    && manifest.kind === "tool-result";
}

export async function setEmergencyMode(store, {
  emergencyMode,
  freeBytes,
  criticalFreeBytes,
  now = Date.now(),
  reason = "filesystem free-space threshold",
} = {}) {
  requireStore(store);
  if (typeof emergencyMode !== "boolean") throw new TypeError("emergencyMode must be boolean.");
  const status = Object.freeze({
    retentionFormatVersion: RETENTION_FORMAT_VERSION,
    emergencyMode,
    freeBytes: timestamp(freeBytes, "freeBytes"),
    criticalFreeBytes: timestamp(criticalFreeBytes, "criticalFreeBytes"),
    reason: identifier(reason, "reason"),
    recordedAt: timestamp(now, "now"),
  });
  await store.put(retentionKeys.emergency(), status, { kind: "retention-emergency" });
  return status;
}
