// Facade preserving the retention public surface after the concern split.
// The implementation lives in sibling modules under ./retention/:
//   protection.js  pins/leases/active-context protection
//   expiry.js      expiry index + expiry worker
//   tombstones.js  explicit tombstoning / redaction
//   emergency.js   disk-low emergency mode
//   cleanup.js     multi-phase canonical-cleanup cursor + wave orchestration
//   shared.js      retentionKeys, validation helpers, and shared constants
export {
  RETENTION_FORMAT_VERSION,
  DEFAULT_ACCESS_BUCKET_MS,
  DEFAULT_RETENTION_WORK_LIMIT,
  DEFAULT_TOMBSTONE_AUDIT_MS,
  retentionKeys,
} from "./retention/shared.js";
export {
  pinDocument,
  unpinDocument,
  protectEvidence,
  releaseProtection,
  cleanupExpiredProtections,
  isDocumentProtected,
} from "./retention/protection.js";
export {
  renewDocumentExpiry,
  recordDocumentAccess,
} from "./retention/expiry.js";
export { tombstoneDocument } from "./retention/tombstones.js";
export { setEmergencyMode } from "./retention/emergency.js";
export {
  cleanupExpiredTombstoneMetadata,
  runRetention,
  retentionStatus,
} from "./retention/cleanup.js";
