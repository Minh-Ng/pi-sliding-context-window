export const RECALL_SCOPE_VALUES = Object.freeze(["auto", "session", "project", "all"]);
const ARCHIVE_SCOPE_VALUES = new Set(RECALL_SCOPE_VALUES.filter((scope) => scope !== "auto"));

export function parseRecallScope(value) {
  return RECALL_SCOPE_VALUES.includes(value) ? value : undefined;
}

/** Scope used by automatic continuity preflight. */
export function automaticRecallScope(configuredScope) {
  const configured = parseRecallScope(configuredScope) ?? "auto";
  return configured === "auto" ? "project" : configured;
}

/**
 * Resolve an omitted or `auto` explicit-tool scope.
 *
 * Auto remains session-local unless the current turn carries a continuity
 * marker. That marker was produced by automatic preflight, so following its
 * recorded scope searches the same authorized evidence boundary.
 */
export function explicitRecallScope({
  configuredScope,
  requestedScope,
  automaticRetrieval,
} = {}) {
  const requested = parseRecallScope(requestedScope);
  if (requested !== undefined && requested !== "auto") return requested;

  const configured = parseRecallScope(configuredScope) ?? "auto";
  if (configured !== "auto") return configured;

  const markerScope = automaticRetrieval?.outcome === "continuity-marker"
    && ARCHIVE_SCOPE_VALUES.has(automaticRetrieval.scope)
    ? automaticRetrieval.scope
    : undefined;
  return markerScope ?? "session";
}
