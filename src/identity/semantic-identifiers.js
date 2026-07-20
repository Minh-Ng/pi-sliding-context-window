// Store protocol identifiers are capped at 8,192 UTF-16 code units. Semantic
// hints extracted from free-form metadata must obey the same result boundary.
export const MAX_SEMANTIC_IDENTIFIER_LENGTH = 8_192;

export function semanticIdentifier(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_SEMANTIC_IDENTIFIER_LENGTH
    ? value
    : undefined;
}
