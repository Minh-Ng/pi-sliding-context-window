/**
 * Versioned, backend-independent contracts for the archive store.
 *
 * This module is a facade: the schema descriptors live in
 * store-contract-schema.js, the error taxonomy lives in
 * store-contract-errors.js, and the object()/field validation machinery that
 * executes those descriptors lives in store-contract-validate.js. Every
 * public export from those three modules is re-exported here unchanged so
 * existing importers of "./store-contract.js" (or "../store/store-contract.js")
 * do not need to change.
 */

export {
  STORE_SCHEMA_VERSION,
  STORE_PROTOCOL_VERSION,
  STORE_LOCATOR_VERSION,
  MAX_STORE_ERROR_MESSAGE_LENGTH,
  MAX_STORE_IDENTIFIER_LENGTH,
  MAX_JSON_VALUE_DEPTH,
  MAX_SESSION_LINEAGE_IDS,
  MAX_PROTECTED_DOCUMENT_VERSIONS,
  MAX_SOURCE_MESSAGE_KEYS_PER_DOCUMENT,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_VISIBLE_SOURCE_KEYS,
  MAX_VISIBLE_SOURCE_KEY_BYTES,
  MAX_ACTIVE_HINT_MESSAGE_KEYS,
  MAX_ACTIVE_HINT_MESSAGE_KEY_BYTES,
  MAX_STRUCTURAL_MESSAGES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DIRECT_DOCUMENT_SOURCE_BYTES,
  MAX_DIRECT_DOCUMENT_RESPONSE_BYTES,
  MAX_DIRECT_CHUNK_TABLE_ENTRIES,
  MAX_DIRECT_SOURCE_MESSAGE_KEYS,
  MAX_RECALL_TOKENS,
  STORE_SCOPES,
  RETRIEVAL_MODES,
  STRUCTURAL_RELATIONS,
  RECALL_STATUSES,
  RETENTION_CLASSES,
  STORE_ERROR_CODES,
  SOURCE_REFERENCE_SCHEMA,
  STRUCTURAL_MESSAGE_SCHEMA,
  SUPERSEDES_TARGET_SCHEMA,
  EVENT_SCHEMA,
  DOCUMENT_SCHEMA,
  PHYSICAL_CHUNK_SCHEMA,
  SEARCH_WINDOW_SCHEMA,
  TURN_MANIFEST_SCHEMA,
  TOOL_RESULT_MANIFEST_SCHEMA,
  SUPERSESSION_SCHEMA,
  LEASE_SCHEMA,
  OUTBOX_ENTRY_SCHEMA,
  STORE_SCHEMA_METADATA_SCHEMA,
  LOCATOR_PAYLOAD_SCHEMA,
  STORE_ERROR_SCHEMA,
  STORE_OPERATION_CONTRACTS,
  STORE_OPERATIONS,
} from "./store-contract-schema.js";

export { ContractError, boundedStoreErrorMessage } from "./store-contract-errors.js";

export {
  assertContract,
  assertVisibleSourceKeys,
  assertActiveHintMessageKeys,
  assertStoreRequest,
  assertStoreResult,
  assertStoreSchemaMetadata,
  assertLocatorPayload,
} from "./store-contract-validate.js";
