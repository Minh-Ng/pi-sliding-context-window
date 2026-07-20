import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { archiveDocumentProvenance } from "../identity/provenance.js";
import { relationScoreField } from "../structural-annotations.js";

// Pi is distributed as a Bun executable, while the MCP server and tests run
// under Node. Prefer Node's built-in API, then use Bun's compatible SQLite API
// when this module is loaded by Pi.
const { DatabaseSync } = await import("node:sqlite").catch(async (nodeError) => {
  try {
    const { Database } = await import("bun:sqlite");
    return { DatabaseSync: Database };
  } catch (bunError) {
    throw new Error("Context Window requires SQLite from Node (node:sqlite) or Bun (bun:sqlite).", {
      cause: bunError ?? nodeError,
    });
  }
});

const RETENTION_ROW_OVERHEAD_BYTES = 256;
const STRUCTURAL_ROW_OVERHEAD_BYTES = 160;
const PROTECTION_LEASE_MS = 24 * 60 * 60 * 1_000;
const POLICY_LEASE_MS = 24 * 60 * 60 * 1_000;
const POLICY_RENEW_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_RETENTION = Object.freeze({
  maxBytes: 1_073_741_824,
  targetBytes: 805_306_368,
  recentProtectionMs: 7 * 24 * 60 * 60 * 1_000,
  minimumTurnsPerSession: 20,
});

function prepare(db, sql) {
  // Bun calls this `query`; Node's DatabaseSync calls it `prepare`.
  return typeof db.prepare === "function" ? db.prepare(sql) : db.query(sql);
}

function stableId(parts) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20);
}

function matchExpression(query) {
  const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  return [...new Set(terms)]
    .slice(0, 20)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function parseMetadata(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        metadata: {},
        metadataParse: {
          status: "invalid-shape",
          error: "metadata_json must contain a JSON object.",
        },
      };
    }
    return { metadata: value, metadataParse: { status: "valid" } };
  } catch (error) {
    return {
      metadata: {},
      metadataParse: {
        status: "malformed-json",
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function documentFromRow(row) {
  const parsed = parseMetadata(row.metadata_json);
  return {
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    kind: row.kind,
    createdAt: row.created_at,
    text: row.text,
    ...parsed,
  };
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function normalizeRetention(options = {}) {
  const candidate = options.retention ?? options;
  const maxBytes = positiveInteger(candidate.maxBytes, DEFAULT_RETENTION.maxBytes);
  const requestedTarget = positiveInteger(candidate.targetBytes, DEFAULT_RETENTION.targetBytes);
  return {
    maxBytes,
    targetBytes: requestedTarget < maxBytes
      ? requestedTarget
      : Math.max(1, Math.floor(maxBytes * 0.75)),
    recentProtectionMs: nonNegativeInteger(
      candidate.recentProtectionMs,
      DEFAULT_RETENTION.recentProtectionMs,
    ),
    minimumTurnsPerSession: nonNegativeInteger(
      candidate.minimumTurnsPerSession,
      DEFAULT_RETENTION.minimumTurnsPerSession,
    ),
  };
}

function utf8Bytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function accountedDocumentBytes({ id, sessionId, project, kind, text, metadataJson }) {
  return RETENTION_ROW_OVERHEAD_BYTES
    + utf8Bytes(id)
    + utf8Bytes(sessionId)
    + utf8Bytes(project)
    + utf8Bytes(kind)
    + utf8Bytes(metadataJson)
    // FTS stores its own copy of the searchable text.
    + (utf8Bytes(text) * 2);
}

function accountedStructuralBytes(messages) {
  return messages.reduce((total, message) => total
    + STRUCTURAL_ROW_OVERHEAD_BYTES
    + utf8Bytes(message.messageId)
    + utf8Bytes(message.messageKey)
    + utf8Bytes(message.role)
    + (utf8Bytes(message.text) * 2), 0);
}

function normalizeStructuralMessages(documentId, messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages.map((message, index) => {
    const messageIndex = nonNegativeInteger(message.messageIndex, index);
    const messageKey = String(message.messageKey ?? "");
    const role = String(message.role ?? "unknown");
    const text = role === "user" || role === "assistant" ? String(message.text ?? "") : "";
    const score = (value) => Math.min(100, nonNegativeInteger(value, 0));
    return {
      messageId: stableId([documentId, messageKey, String(messageIndex)]),
      messageIndex,
      messageKey,
      role,
      createdAt: Number.isFinite(Number(message.createdAt)) ? Number(message.createdAt) : 0,
      text,
      questionScore: score(message.questionScore),
      requestScore: score(message.requestScore),
      correctionScore: score(message.correctionScore),
      answerScore: score(message.answerScore),
    };
  });
}

function statBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function pragmaNumber(db, name) {
  const row = prepare(db, `PRAGMA ${name}`).get();
  if (!row || typeof row !== "object") return 0;
  return Number(Object.values(row)[0]) || 0;
}

const EVICTION_KIND_PRIORITY = Object.freeze({
  "decision-candidate": 0,
  "tool-result": 1,
  preamble: 2,
  turn: 3,
});

function compareEvictionCandidates(left, right) {
  const leftPriority = EVICTION_KIND_PRIORITY[left.kind] ?? 4;
  const rightPriority = EVICTION_KIND_PRIORITY[right.kind] ?? 4;
  return leftPriority - rightPriority
    || Number(left.recall_count > 0) - Number(right.recall_count > 0)
    || Number(left.last_recalled_at ?? left.created_at) - Number(right.last_recalled_at ?? right.created_at)
    || Number(left.created_at) - Number(right.created_at)
    || String(left.id).localeCompare(String(right.id));
}

export class Archive {
  constructor(path, options = {}) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.retention = normalizeRetention(options);
    this.protectedSessionIds = new Set();
    this.protectedDocumentIds = new Set();
    this.ownerId = `${process.pid}-${randomUUID()}`;
    this.lastPrune = undefined;
    this.lastCleanup = undefined;
    this.nextPolicyRenewalAt = Date.now() + POLICY_RENEW_INTERVAL_MS;
    this.db = new DatabaseSync(path);
    try {
      const hasSchema = Boolean(prepare(
        this.db,
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
      ).get());
      if (!hasSchema) this.db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
      this.db.exec(`
      -- Multiple Pi sessions share this archive. Wait for a concurrent writer
      -- instead of failing immediately with SQLITE_BUSY.
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS documents_session_idx ON documents(session_id, created_at);
      CREATE INDEX IF NOT EXISTS documents_project_idx ON documents(project, created_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        id UNINDEXED,
        session_id UNINDEXED,
        project UNINDEXED,
        text,
        tokenize = 'porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS document_retention (
        document_id TEXT PRIMARY KEY,
        accounted_bytes INTEGER NOT NULL,
        last_recalled_at INTEGER,
        recall_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS archive_policy (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        max_archive_bytes INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_client_policies (
        owner_id TEXT PRIMARY KEY,
        max_archive_bytes INTEGER NOT NULL,
        target_archive_bytes INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS archive_client_policies_expiry_idx
        ON archive_client_policies(expires_at);
      INSERT INTO archive_policy(singleton, max_archive_bytes)
      VALUES (1, ${this.retention.maxBytes})
      ON CONFLICT(singleton) DO UPDATE SET
        max_archive_bytes=min(max_archive_bytes, excluded.max_archive_bytes);
      DELETE FROM archive_client_policies WHERE expires_at <= ${Date.now()};
      INSERT OR REPLACE INTO archive_client_policies(
        owner_id, max_archive_bytes, target_archive_bytes, expires_at
      ) VALUES (
        '${this.ownerId}', ${this.retention.maxBytes}, ${this.retention.targetBytes},
        ${Date.now() + POLICY_LEASE_MS}
      );
      CREATE TABLE IF NOT EXISTS archive_protection (
        owner_id TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY(owner_id, resource_type, resource_id)
      );
      CREATE INDEX IF NOT EXISTS archive_protection_expiry_idx
      ON archive_protection(expires_at);
      CREATE TABLE IF NOT EXISTS document_order (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS legacy_documents (
        document_id TEXT PRIMARY KEY,
        document_sequence INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS legacy_documents_sequence_idx
      ON legacy_documents(document_sequence DESC);
      CREATE TABLE IF NOT EXISTS archive_messages (
        message_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        project TEXT NOT NULL,
        document_sequence INTEGER NOT NULL,
        message_index INTEGER NOT NULL,
        message_key TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        question_score INTEGER NOT NULL,
        request_score INTEGER NOT NULL,
        correction_score INTEGER NOT NULL,
        answer_score INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS archive_messages_document_idx
      ON archive_messages(document_id, message_index);
      CREATE INDEX IF NOT EXISTS archive_messages_question_idx
      ON archive_messages(session_id, project, question_score DESC, document_sequence DESC, message_index DESC);
      CREATE INDEX IF NOT EXISTS archive_messages_request_idx
      ON archive_messages(session_id, project, request_score DESC, document_sequence DESC, message_index DESC);
      CREATE INDEX IF NOT EXISTS archive_messages_correction_idx
      ON archive_messages(session_id, project, correction_score DESC, document_sequence DESC, message_index DESC);
      CREATE INDEX IF NOT EXISTS archive_messages_answer_idx
      ON archive_messages(session_id, project, answer_score DESC, document_sequence DESC, message_index DESC);
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_messages_fts USING fts5(
        message_id UNINDEXED,
        document_id UNINDEXED,
        text,
        tokenize = 'porter unicode61'
      );
      DELETE FROM archive_messages
      WHERE document_id NOT IN (SELECT id FROM documents);
      DELETE FROM archive_messages_fts
      WHERE message_id NOT IN (SELECT message_id FROM archive_messages);
      DELETE FROM document_order
      WHERE document_id NOT IN (SELECT id FROM documents);
      INSERT OR IGNORE INTO document_order(document_id)
      SELECT id FROM documents ORDER BY rowid;
      UPDATE archive_messages
      SET document_sequence = (
        SELECT sequence FROM document_order WHERE document_id = archive_messages.document_id
      );
      DELETE FROM legacy_documents
      WHERE document_id NOT IN (SELECT id FROM documents)
         OR document_id IN (SELECT DISTINCT document_id FROM archive_messages);
      INSERT OR IGNORE INTO legacy_documents(document_id, document_sequence)
      SELECT o.document_id, o.sequence
      FROM document_order AS o
      WHERE NOT EXISTS (
        SELECT 1 FROM archive_messages AS m WHERE m.document_id = o.document_id
      );
      INSERT OR IGNORE INTO document_retention(document_id, accounted_bytes)
      SELECT id, 0 FROM documents;
      DELETE FROM document_retention
      WHERE document_id NOT IN (SELECT id FROM documents);
      UPDATE document_retention
      SET accounted_bytes = (
        SELECT
          ${RETENTION_ROW_OVERHEAD_BYTES}
          + length(CAST(id AS BLOB))
          + length(CAST(session_id AS BLOB))
          + length(CAST(project AS BLOB))
          + length(CAST(kind AS BLOB))
          + length(CAST(metadata_json AS BLOB))
          + (2 * length(CAST(text AS BLOB)))
          + coalesce((
            SELECT sum(
              ${STRUCTURAL_ROW_OVERHEAD_BYTES}
              + length(CAST(message_id AS BLOB))
              + length(CAST(message_key AS BLOB))
              + length(CAST(role AS BLOB))
              + (2 * length(CAST(archive_messages.text AS BLOB)))
            )
            FROM archive_messages
            WHERE archive_messages.document_id = documents.id
          ), 0)
        FROM documents
        WHERE documents.id = document_retention.document_id
      );
      DROP TRIGGER IF EXISTS context_window_documents_insert;
      DROP TRIGGER IF EXISTS context_window_documents_update;
      DROP TRIGGER IF EXISTS context_window_documents_delete;
      CREATE TRIGGER context_window_documents_insert
      AFTER INSERT ON documents BEGIN
        INSERT INTO document_order(document_id) VALUES (NEW.id);
        INSERT OR IGNORE INTO legacy_documents(document_id, document_sequence)
        SELECT NEW.id, sequence FROM document_order WHERE document_id = NEW.id;
        INSERT INTO document_retention(document_id, accounted_bytes)
        VALUES (
          NEW.id,
          ${RETENTION_ROW_OVERHEAD_BYTES}
          + length(CAST(NEW.id AS BLOB))
          + length(CAST(NEW.session_id AS BLOB))
          + length(CAST(NEW.project AS BLOB))
          + length(CAST(NEW.kind AS BLOB))
          + length(CAST(NEW.metadata_json AS BLOB))
          + (2 * length(CAST(NEW.text AS BLOB)))
        )
        ON CONFLICT(document_id) DO UPDATE SET accounted_bytes=excluded.accounted_bytes;
        SELECT CASE WHEN
          (SELECT coalesce(sum(accounted_bytes), 0) FROM document_retention)
          > coalesce(
            (
              SELECT min(max_archive_bytes)
              FROM archive_client_policies
              WHERE expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            ),
            (SELECT max_archive_bytes FROM archive_policy WHERE singleton = 1)
          )
          THEN RAISE(ABORT, 'context archive hard limit exceeded')
        END;
      END;
      CREATE TRIGGER context_window_documents_update
      AFTER UPDATE OF session_id, project, kind, created_at, text, metadata_json ON documents BEGIN
        DELETE FROM archive_messages_fts WHERE document_id = NEW.id;
        DELETE FROM archive_messages WHERE document_id = NEW.id;
        UPDATE legacy_documents
        SET document_sequence = (
          SELECT sequence FROM document_order WHERE document_id = NEW.id
        )
        WHERE document_id = NEW.id;
        INSERT INTO legacy_documents(document_id, document_sequence)
        SELECT NEW.id, sequence FROM document_order WHERE document_id = NEW.id
        AND NOT EXISTS (
          SELECT 1 FROM legacy_documents WHERE document_id = NEW.id
        );
        INSERT INTO document_retention(document_id, accounted_bytes)
        VALUES (
          NEW.id,
          ${RETENTION_ROW_OVERHEAD_BYTES}
          + length(CAST(NEW.id AS BLOB))
          + length(CAST(NEW.session_id AS BLOB))
          + length(CAST(NEW.project AS BLOB))
          + length(CAST(NEW.kind AS BLOB))
          + length(CAST(NEW.metadata_json AS BLOB))
          + (2 * length(CAST(NEW.text AS BLOB)))
        )
        ON CONFLICT(document_id) DO UPDATE SET accounted_bytes=excluded.accounted_bytes;
        SELECT CASE WHEN
          (SELECT coalesce(sum(accounted_bytes), 0) FROM document_retention)
          > coalesce(
            (
              SELECT min(max_archive_bytes)
              FROM archive_client_policies
              WHERE expires_at > CAST(unixepoch('subsec') * 1000 AS INTEGER)
            ),
            (SELECT max_archive_bytes FROM archive_policy WHERE singleton = 1)
          )
          THEN RAISE(ABORT, 'context archive hard limit exceeded')
        END;
      END;
      CREATE TRIGGER context_window_documents_delete
      AFTER DELETE ON documents BEGIN
        DELETE FROM documents_fts WHERE id = OLD.id;
        DELETE FROM archive_messages_fts WHERE document_id = OLD.id;
        DELETE FROM archive_messages WHERE document_id = OLD.id;
        DELETE FROM legacy_documents WHERE document_id = OLD.id;
        DELETE FROM document_order WHERE document_id = OLD.id;
        DELETE FROM document_retention WHERE document_id = OLD.id;
        DELETE FROM archive_protection
        WHERE resource_type = 'document' AND resource_id = OLD.id;
      END;
      COMMIT;
    `);
    } catch (error) {
      this.db.close();
      if (/fts5|no such module/i.test(error instanceof Error ? error.message : String(error))) {
        throw new Error("Context Window requires a SQLite build with FTS5 enabled.", { cause: error });
      }
      throw error;
    }
    this.insertDocument = prepare(this.db, `
      INSERT INTO documents(id, session_id, project, kind, created_at, text, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id=excluded.session_id,
        project=excluded.project,
        kind=excluded.kind,
        created_at=excluded.created_at,
        text=excluded.text,
        metadata_json=excluded.metadata_json
    `);
    this.deleteFts = prepare(this.db, "DELETE FROM documents_fts WHERE id = ?");
    this.insertFts = prepare(this.db, "INSERT INTO documents_fts(id, session_id, project, text) VALUES (?, ?, ?, ?)");
    this.upsertRetention = prepare(this.db, `
      INSERT INTO document_retention(document_id, accounted_bytes)
      VALUES (?, ?)
      ON CONFLICT(document_id) DO UPDATE SET accounted_bytes=excluded.accounted_bytes
    `);
    this.deleteRetention = prepare(this.db, "DELETE FROM document_retention WHERE document_id = ?");
    this.deleteDocument = prepare(this.db, "DELETE FROM documents WHERE id = ?");
    this.recordRecall = prepare(this.db, `
      UPDATE document_retention
      SET last_recalled_at = ?, recall_count = recall_count + 1
      WHERE document_id = ?
    `);
    this.insertProtection = prepare(this.db, `
      INSERT INTO archive_protection(owner_id, resource_type, resource_id, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, resource_type, resource_id)
      DO UPDATE SET expires_at=excluded.expires_at
    `);
    this.insertDocumentOrder = prepare(
      this.db,
      "INSERT OR IGNORE INTO document_order(document_id) VALUES (?)",
    );
    this.getDocumentOrder = prepare(
      this.db,
      "SELECT sequence FROM document_order WHERE document_id = ?",
    );
    this.deleteMessageFts = prepare(this.db, "DELETE FROM archive_messages_fts WHERE document_id = ?");
    this.deleteMessages = prepare(this.db, "DELETE FROM archive_messages WHERE document_id = ?");
    this.deleteDocumentOrder = prepare(this.db, "DELETE FROM document_order WHERE document_id = ?");
    this.insertLegacyDocument = prepare(this.db, `
      INSERT OR IGNORE INTO legacy_documents(document_id, document_sequence) VALUES (?, ?)
    `);
    this.deleteLegacyDocument = prepare(this.db, "DELETE FROM legacy_documents WHERE document_id = ?");
    this.insertMessage = prepare(this.db, `
      INSERT INTO archive_messages(
        message_id, document_id, session_id, project, document_sequence,
        message_index, message_key, role, created_at, text,
        question_score, request_score, correction_score, answer_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertMessageFts = prepare(
      this.db,
      "INSERT INTO archive_messages_fts(message_id, document_id, text) VALUES (?, ?, ?)",
    );
  }

  renewPolicyLeaseIfNeeded(force = false) {
    const now = Date.now();
    if (!force && now < this.nextPolicyRenewalAt) return;
    prepare(this.db, `
      INSERT INTO archive_client_policies(
        owner_id, max_archive_bytes, target_archive_bytes, expires_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id) DO UPDATE SET
        max_archive_bytes=excluded.max_archive_bytes,
        target_archive_bytes=excluded.target_archive_bytes,
        expires_at=excluded.expires_at
    `).run(
      this.ownerId,
      this.retention.maxBytes,
      this.retention.targetBytes,
      now + POLICY_LEASE_MS,
    );
    prepare(this.db, "DELETE FROM archive_client_policies WHERE expires_at <= ?").run(now);
    this.nextPolicyRenewalAt = now + POLICY_RENEW_INTERVAL_MS;
  }

  refreshPolicyLease() {
    this.renewPolicyLeaseIfNeeded(true);
  }

  effectiveRetention() {
    this.renewPolicyLeaseIfNeeded();
    const now = Date.now();
    const active = prepare(this.db, `
      SELECT min(max_archive_bytes) AS max_bytes,
             min(target_archive_bytes) AS target_bytes
      FROM archive_client_policies
      WHERE expires_at > ?
    `).get(now);
    const fallbackMax = Number(prepare(
      this.db,
      "SELECT max_archive_bytes FROM archive_policy WHERE singleton = 1",
    ).get().max_archive_bytes);
    const maxBytes = Number(active?.max_bytes ?? fallbackMax);
    return {
      maxBytes,
      targetBytes: Math.min(Number(active?.target_bytes ?? this.retention.targetBytes), maxBytes),
    };
  }

  setProtectedContext({ sessionIds = [], documentIds = [] } = {}) {
    this.protectedSessionIds = new Set(sessionIds.filter(Boolean).map(String));
    this.protectedDocumentIds = new Set(documentIds.filter(Boolean).map(String));
    const expiresAt = Date.now() + PROTECTION_LEASE_MS;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.renewPolicyLeaseIfNeeded(true);
      prepare(this.db, "DELETE FROM archive_protection WHERE owner_id = ?").run(this.ownerId);
      const insert = prepare(this.db, `
        INSERT INTO archive_protection(owner_id, resource_type, resource_id, expires_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const sessionId of this.protectedSessionIds) {
        insert.run(this.ownerId, "session", sessionId, expiresAt);
      }
      for (const documentId of this.protectedDocumentIds) {
        insert.run(this.ownerId, "document", documentId, expiresAt);
      }
      prepare(this.db, "DELETE FROM archive_protection WHERE expires_at <= ?").run(Date.now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  put(
    { id, sessionId, project, kind = "turn", text, metadata = {}, createdAt = Date.now() },
    { deferPrune = false, protect = false, structuralMessages } = {},
  ) {
    if (!text?.trim()) return undefined;
    const documentId = id ?? stableId([sessionId, project, kind, String(createdAt), text]);
    const metadataJson = JSON.stringify(metadata);
    const normalizedMessages = structuralMessages === undefined
      ? undefined
      : normalizeStructuralMessages(documentId, structuralMessages);
    const accountedBytes = accountedDocumentBytes({
      id: documentId,
      sessionId,
      project,
      kind,
      text,
      metadataJson,
    }) + (normalizedMessages === undefined
      ? 0
      : accountedStructuralBytes(normalizedMessages));
    let pressurePruneResult;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const retention = this.effectiveRetention();
      if (accountedBytes > retention.maxBytes) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      let transactionExistingBytes = Number(prepare(
        this.db,
        "SELECT accounted_bytes FROM document_retention WHERE document_id = ?",
      ).get(documentId)?.accounted_bytes ?? 0);
      if (this.logicalBytes() - transactionExistingBytes + accountedBytes > retention.maxBytes) {
        pressurePruneResult = this.prune({
          force: true,
          targetBytes: Math.max(
            0,
            retention.targetBytes - accountedBytes + transactionExistingBytes,
          ),
          withinTransaction: true,
        });
        transactionExistingBytes = Number(prepare(
          this.db,
          "SELECT accounted_bytes FROM document_retention WHERE document_id = ?",
        ).get(documentId)?.accounted_bytes ?? 0);
      }
      if (this.logicalBytes() - transactionExistingBytes + accountedBytes > retention.maxBytes) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      this.insertDocument.run(documentId, sessionId, project, kind, createdAt, text, metadataJson);
      this.deleteFts.run(documentId);
      this.insertFts.run(documentId, sessionId, project, text);
      const existingOrder = this.getDocumentOrder.get(documentId);
      this.insertDocumentOrder.run(documentId);
      const sequence = Number(this.getDocumentOrder.get(documentId).sequence);
      if (normalizedMessages !== undefined) {
        this.deleteLegacyDocument.run(documentId);
        this.deleteMessageFts.run(documentId);
        this.deleteMessages.run(documentId);
        for (const message of normalizedMessages) {
          this.insertMessage.run(
            message.messageId,
            documentId,
            sessionId,
            project,
            sequence,
            message.messageIndex,
            message.messageKey,
            message.role,
            message.createdAt || createdAt,
            message.text,
            message.questionScore,
            message.requestScore,
            message.correctionScore,
            message.answerScore,
          );
          if (message.text.trim()) {
            this.insertMessageFts.run(message.messageId, documentId, message.text);
          }
        }
      } else if (!existingOrder) {
        this.insertLegacyDocument.run(documentId, sequence);
      }
      this.upsertRetention.run(documentId, accountedBytes);
      if (protect) {
        this.insertProtection.run(
          this.ownerId,
          "document",
          documentId,
          Date.now() + PROTECTION_LEASE_MS,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (pressurePruneResult) this.rememberPrune(pressurePruneResult);
    if (protect) this.protectedDocumentIds.add(documentId);
    if (deferPrune) return documentId;
    this.prune();
    const retained = prepare(this.db, "SELECT 1 AS present FROM documents WHERE id = ?").get(documentId);
    return retained ? documentId : undefined;
  }

  search(query, options = {}) {
    return this.searchDetailed(query, options).results;
  }

  searchDetailed(query, options = {}) {
    if (options.relation) return this.searchStructural(query, options);
    const results = this.searchLexical(query, options);
    return {
      mode: "lexical",
      status: results.length > 0 ? "resolved" : "not-found",
      results,
      candidates: results.map(({ id }) => ({ id, granularity: "document" })),
      // The SQLite legacy backend has no retention-expiry index to count
      // against; report zero rather than leaving the field undefined so
      // presentation's expired-match notice behaves the same across backends.
      expiredMatches: { count: 0, retentionClasses: [] },
    };
  }

  gatherDetailed(query, options = {}) {
    const intent = options.intent ?? "auto";
    const limit = Math.min(10, Math.max(1, Number(options.limit) || 3));
    const search = this.searchDetailed(query, { ...options, limit });
    const candidates = new Map();
    const add = (result, relation, anchorRank, distance) => {
      const key = result.documentId ?? result.id;
      let priority;
      if (intent === "workflow") {
        if (anchorRank === 1 && relation === "anchor") priority = 0;
        else if (anchorRank === 1 && relation === "after") priority = distance;
        else if (anchorRank === 1 && relation === "before") priority = 50 + distance;
        else if (relation === "anchor") priority = 100 + anchorRank;
        else priority = 200 + anchorRank * 20 + distance;
      } else {
        priority = relation === "anchor"
          ? anchorRank
          : 100 + anchorRank * 20 + (relation === "after" ? distance : 10 + distance);
      }
      const current = candidates.get(key);
      if (!current || priority < current.priority) {
        candidates.set(key, { result, relation, anchorRank, distance, priority });
      }
    };
    search.results.forEach((result, index) => add(result, "anchor", index + 1, 0));
    const before = Number.isSafeInteger(options.before)
      ? Math.min(8, Math.max(0, options.before))
      : intent === "state" ? 0 : 1;
    const after = Number.isSafeInteger(options.after)
      ? Math.min(16, Math.max(0, options.after))
      : intent === "workflow" ? 8 : intent === "state" ? 0 : 3;
    const neighborhoodAnchors = search.results.slice(
      0,
      Math.min(5, Math.max(1, Number(options.neighborhoodAnchors) || 2)),
    );
    let hasMore = false;
    neighborhoodAnchors.forEach((anchor, anchorIndex) => {
      for (const [direction, neighborLimit] of [["before", before], ["after", after]]) {
        if (neighborLimit === 0) continue;
        const projectScoped = options.scope !== "session";
        const traversal = this.traverseDetailed(anchor.id, {
          direction,
          sessionId: projectScoped ? anchor.sessionId : options.sessionId,
          sessionIds: projectScoped ? [anchor.sessionId] : options.sessionIds,
          project: options.project,
          scope: "session",
          limit: neighborLimit,
        });
        hasMore ||= traversal.hasMore;
        traversal.results.forEach((result, index) => {
          add(result, direction, anchorIndex + 1, index + 1);
        });
      }
    });
    const maxEvidence = Math.min(24, Math.max(1, Number(options.maxEvidence) || 12));
    const selected = [...candidates.values()]
      .sort((left, right) => left.priority - right.priority)
      .slice(0, maxEvidence)
      .map((item) => ({
        relation: item.relation,
        anchorRank: item.anchorRank,
        distance: item.distance,
        id: item.result.id,
        locator: item.result.id,
        document: this.get(item.result.id),
      }))
      .filter((item) => item.document)
      .sort((left, right) => Number(left.document.createdAt) - Number(right.document.createdAt));
    const truncated = hasMore || candidates.size > selected.length || search.results.length === limit;
    return {
      status: selected.length > 0 ? "resolved" : "not-found",
      mode: search.mode,
      intent,
      anchorCount: search.results.length,
      candidateCount: candidates.size,
      returnedTokens: 0,
      truncated,
      hasMore: truncated,
      evidence: selected,
      // Always zero on this backend (see searchDetailed above); carried
      // through so presentation's expired-match notice behaves the same
      // across backends instead of silently omitting the field here.
      expiredMatches: search.expiredMatches,
    };
  }

  traverseDetailed(anchorId, {
    direction = "before",
    sessionId,
    sessionIds,
    project,
    scope = "session",
    limit = 128,
  } = {}) {
    const anchor = prepare(this.db, "SELECT * FROM documents WHERE id = ?").get(anchorId);
    if (!anchor || (project && anchor.project !== project)) {
      return { mode: "chronological", status: "not-found", direction, scanned: 0, truncated: false, hasMore: false, results: [], candidates: [] };
    }
    const scopedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean)
      : (sessionId ? [sessionId] : []);
    if (scope === "session" && !scopedSessionIds.includes(anchor.session_id)) {
      return { mode: "chronological", status: "not-found", direction, scanned: 0, truncated: false, hasMore: false, results: [], candidates: [] };
    }
    const boundedLimit = Math.min(128, Math.max(1, Number(limit) || 128));
    const comparison = direction === "after" ? ">" : "<";
    const order = direction === "after" ? "ASC" : "DESC";
    let where = `(created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?))`;
    const params = [anchor.created_at, anchor.created_at, anchor.id];
    if (scope === "session") {
      where += ` AND session_id IN (${scopedSessionIds.map(() => "?").join(", ")})`;
      params.push(...scopedSessionIds);
    }
    if (project) {
      where += " AND project = ?";
      params.push(project);
    }
    params.push(boundedLimit + 1);
    const rows = prepare(this.db, `
      SELECT * FROM documents
      WHERE ${where}
      ORDER BY created_at ${order}, id ${order}
      LIMIT ?
    `).all(...params);
    const truncated = rows.length > boundedLimit;
    const results = rows.slice(0, boundedLimit).map((row) => {
      const document = documentFromRow(row);
      return { ...document, snippet: document.text.slice(0, 512) };
    });
    return {
      mode: "chronological",
      status: results.length > 0 ? "resolved" : "not-found",
      direction,
      scanned: rows.length,
      truncated,
      hasMore: truncated,
      results,
      candidates: results.map(({ id }) => ({ id, granularity: "document" })),
    };
  }

  searchLexical(query, { sessionId, sessionIds, project, scope = "session", limit = 3 } = {}) {
    const expression = matchExpression(query);
    if (!expression) return [];

    let where = "documents_fts MATCH ?";
    const params = [expression];
    const scopedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean)
      : (sessionId ? [sessionId] : []);
    if (scope === "session" && scopedSessionIds.length > 0) {
      where += ` AND f.session_id IN (${scopedSessionIds.map(() => "?").join(", ")})`;
      params.push(...scopedSessionIds);
      if (project) {
        where += " AND f.project = ?";
        params.push(project);
      }
    } else if (scope !== "all" && project) {
      where += " AND f.project = ?";
      params.push(project);
    }
    params.push(limit);

    const rows = prepare(this.db, `
      SELECT d.id, d.session_id, d.project, d.kind, d.created_at, d.text, d.metadata_json,
             bm25(documents_fts, 0.0, 0.0, 0.0, 1.0) AS rank,
             snippet(documents_fts, 3, '[', ']', ' … ', 28) AS snippet
      FROM documents_fts AS f
      JOIN documents AS d ON d.id = f.id
      WHERE ${where}
      ORDER BY rank ASC, d.created_at DESC
      LIMIT ?
    `).all(...params);

    return rows.map((row) => {
      const document = documentFromRow(row);
      return {
        ...document,
        snippet: row.snippet,
        score: Math.max(0, -Number(row.rank)),
        provenance: archiveDocumentProvenance(document),
      };
    });
  }

  searchStructural(query, {
    relation,
    sessionId,
    sessionIds,
    project,
    scope = "session",
    limit = 3,
  } = {}) {
    const scoreField = relationScoreField(relation);
    if (!scoreField) {
      return { mode: "structural", relation, status: "not-found", results: [], candidates: [] };
    }
    const queryText = String(query ?? "").trim();
    const expression = matchExpression(queryText);
    if (queryText && !expression) {
      return { mode: "structural", relation, status: "not-found", results: [], candidates: [] };
    }

    const scopedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean).map(String)
      : (sessionId ? [String(sessionId)] : []);
    const hasLineage = scope === "session" && scopedSessionIds.length > 1;
    const lineageJoin = hasLineage
      ? `LEFT JOIN (${scopedSessionIds.map((_, index) =>
          `SELECT ? AS session_id, ${index} AS depth`,
        ).join(" UNION ALL ")}) AS lineage ON lineage.session_id = m.session_id`
      : "";
    const params = [];
    const where = [`m.${scoreField} > 0`];
    const matchCte = expression
      ? `WITH matched_messages AS MATERIALIZED (
           SELECT message_id, bm25(archive_messages_fts, 0.0, 0.0, 1.0) AS message_rank
           FROM archive_messages_fts
           WHERE archive_messages_fts MATCH ?
         )`
      : "";
    const messageSource = expression
      ? `FROM matched_messages AS mf
         JOIN archive_messages AS m ON m.message_id = mf.message_id`
      : "FROM archive_messages AS m";
    if (expression) params.push(expression);
    if (hasLineage) params.push(...scopedSessionIds);
    if (scope === "session" && scopedSessionIds.length > 0) {
      where.push(`m.session_id IN (${scopedSessionIds.map(() => "?").join(", ")})`);
      params.push(...scopedSessionIds);
      if (project) {
        where.push("m.project = ?");
        params.push(project);
      }
    } else if (scope !== "all" && project) {
      where.push("m.project = ?");
      params.push(project);
    }
    params.push(Math.min(100, Math.max(1, Number(limit) || 3) * 5));

    const rows = prepare(this.db, `
      ${matchCte}
      SELECT d.id, d.session_id, d.project, d.kind, d.created_at, d.text, d.metadata_json,
             m.message_id, m.message_index, m.message_key, m.role,
             m.created_at AS message_created_at, m.text AS message_text,
             m.document_sequence, m.${scoreField} AS relation_score,
             ${hasLineage ? "lineage.depth" : "0"} AS lineage_depth,
             ${expression ? "mf.message_rank" : "0"} AS message_rank
      ${messageSource}
      ${lineageJoin}
      JOIN documents AS d ON d.id = m.document_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.${scoreField} DESC,
               ${hasLineage ? "lineage_depth ASC," : ""}
               m.document_sequence DESC, m.message_index DESC
               ${expression ? ", message_rank ASC" : ""}
      LIMIT ?
    `).all(...params);

    const messageResults = rows.map((row) => {
      const document = documentFromRow(row);
      const lineageDepth = Number(row.lineage_depth);
      return {
        ...document,
        snippet: row.message_text,
        score: Number(row.relation_score),
        provenance: archiveDocumentProvenance(document),
        structural: {
          relation,
          granularity: "message",
          messageId: row.message_id,
          messageKey: row.message_key,
          messageIndex: Number(row.message_index),
          role: row.role,
          createdAt: Number(row.message_created_at),
          relationConfidence: Number(row.relation_score),
          bm25Rank: expression ? Number(row.message_rank) : undefined,
          lineageDepth,
          documentSequence: Number(row.document_sequence),
        },
      };
    });
    messageResults.sort((left, right) =>
      right.structural.relationConfidence - left.structural.relationConfidence
      || left.structural.lineageDepth - right.structural.lineageDepth
      || right.structural.documentSequence - left.structural.documentSequence
      || right.structural.messageIndex - left.structural.messageIndex
      || Number(left.structural.bm25Rank ?? 0) - Number(right.structural.bm25Rank ?? 0)
      || left.structural.messageKey.localeCompare(right.structural.messageKey));

    const legacyResults = this.legacyStructuralCandidates(queryText, {
      sessionId,
      sessionIds: scopedSessionIds,
      project,
      scope,
      limit,
      relation,
    });
    if (messageResults.length === 0) {
      const results = legacyResults.slice(0, limit);
      return {
        mode: "structural",
        relation,
        status: results.length > 0 ? "legacy-fallback" : "not-found",
        results,
        candidates: results.map((result) => result.structural),
      };
    }

    const top = messageResults[0];
    const newerLegacy = legacyResults.find((candidate) =>
      candidate.structural.documentSequence > top.structural.documentSequence);
    const ambiguous = top.structural.relationConfidence < 50
      || top.structural.lineageDepth > 0
      || scope === "project"
      || scope === "all"
      || Boolean(newerLegacy);
    const results = newerLegacy
      ? [top, newerLegacy, ...messageResults.slice(1)].slice(0, limit)
      : messageResults.slice(0, limit);
    return {
      mode: "structural",
      relation,
      status: ambiguous ? "ambiguous" : "resolved",
      results,
      candidates: results.map((result) => result.structural),
    };
  }

  legacyStructuralCandidates(query, {
    sessionId,
    sessionIds,
    project,
    scope,
    limit,
    relation,
  }) {
    const expression = matchExpression(query);
    const params = [];
    const where = ["d.kind = 'turn'"];
    const ftsJoin = expression
      ? "JOIN documents_fts AS f ON f.id = d.id"
      : "";
    if (expression) {
      where.unshift("documents_fts MATCH ?");
      params.push(expression);
    }
    const scopedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean).map(String)
      : (sessionId ? [String(sessionId)] : []);
    if (scope === "session" && scopedSessionIds.length > 0) {
      where.push(`d.session_id IN (${scopedSessionIds.map(() => "?").join(", ")})`);
      params.push(...scopedSessionIds);
      if (project) {
        where.push("d.project = ?");
        params.push(project);
      }
    } else if (scope !== "all" && project) {
      where.push("d.project = ?");
      params.push(project);
    }
    params.push(Math.max(1, Number(limit) || 3));

    const rows = prepare(this.db, `
      SELECT d.id, d.session_id, d.project, d.kind, d.created_at, d.text, d.metadata_json,
             legacy.document_sequence
      FROM legacy_documents AS legacy
      JOIN documents AS d ON d.id = legacy.document_id
      ${ftsJoin}
      WHERE ${where.join(" AND ")}
      ORDER BY legacy.document_sequence DESC, d.id ASC
      LIMIT ?
    `).all(...params);
    const lineageDepths = new Map(scopedSessionIds.map((id, index) => [id, index]));
    return rows.map((row) => {
      const document = documentFromRow(row);
      return {
        ...document,
        snippet: document.text,
        score: 0,
        provenance: archiveDocumentProvenance(document),
        structural: {
          relation,
          granularity: "document",
          relationConfidence: 0,
          lineageDepth: lineageDepths.get(String(row.session_id)) ?? 0,
          documentSequence: Number(row.document_sequence),
        },
      };
    });
  }

  get(id) {
    const row = prepare(this.db, "SELECT * FROM documents WHERE id = ?").get(id);
    if (!row) return undefined;
    try {
      this.recordRecall.run(Date.now(), id);
    } catch {
      // Recall evidence is more important than best-effort retention metadata.
    }
    const document = documentFromRow(row);
    return { ...document, provenance: archiveDocumentProvenance(document) };
  }

  logicalBytes() {
    return Number(prepare(
      this.db,
      "SELECT coalesce(sum(accounted_bytes), 0) AS bytes FROM document_retention",
    ).get().bytes);
  }

  rememberPrune(result) {
    this.lastPrune = result;
    if (result.deletedDocuments > 0) this.lastCleanup = result;
    return result;
  }

  prune({
    force = false,
    now = Date.now(),
    protectedSessionIds = [],
    protectedDocumentIds = [],
    targetBytes,
    withinTransaction = false,
  } = {}) {
    const retention = this.effectiveRetention();
    const cleanupTarget = nonNegativeInteger(targetBytes, retention.targetBytes);
    const finish = (result) => withinTransaction ? result : this.rememberPrune(result);
    if (!withinTransaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      const totalBefore = this.logicalBytes();
      if (totalBefore <= cleanupTarget
        || (!force && totalBefore <= retention.maxBytes)) {
        if (!withinTransaction) this.db.exec("COMMIT");
        return finish({
          status: "below-limit",
          totalBefore,
          totalAfter: totalBefore,
          deletedDocuments: 0,
          deletedBytes: 0,
          byKind: {},
        });
      }

      prepare(this.db, "DELETE FROM archive_protection WHERE expires_at <= ?").run(now);
      const sessions = new Set([
        ...this.protectedSessionIds,
        ...protectedSessionIds.filter(Boolean).map(String),
      ]);
      const documents = new Set([
        ...this.protectedDocumentIds,
        ...protectedDocumentIds.filter(Boolean).map(String),
      ]);
      for (const lease of prepare(this.db, `
        SELECT resource_type, resource_id
        FROM archive_protection
        WHERE expires_at > ?
      `).all(now)) {
        if (lease.resource_type === "session") sessions.add(String(lease.resource_id));
        if (lease.resource_type === "document") documents.add(String(lease.resource_id));
      }

      const candidates = prepare(this.db, `
        SELECT d.id, d.session_id, d.kind, d.created_at, d.metadata_json,
               r.accounted_bytes, r.last_recalled_at, r.recall_count
        FROM documents AS d
        JOIN document_retention AS r ON r.document_id = d.id
      `).all().map((row) => ({ ...row }));

      const turnsBySession = new Map();
      for (const candidate of candidates) {
        if (candidate.kind !== "turn") continue;
        const turns = turnsBySession.get(candidate.session_id) ?? [];
        turns.push(candidate);
        turnsBySession.set(candidate.session_id, turns);
      }
      const turnRanks = new Map();
      for (const turns of turnsBySession.values()) {
        turns.sort((left, right) => Number(right.created_at) - Number(left.created_at)
          || String(right.id).localeCompare(String(left.id)));
        turns.forEach((turn, index) => turnRanks.set(turn.id, index + 1));
      }

      candidates.sort(compareEvictionCandidates);
      const selected = new Map();
      let projectedBytes = totalBefore;
      const recentCutoff = now - this.retention.recentProtectionMs;
      const select = (candidate) => {
        if (selected.has(candidate.id) || documents.has(candidate.id)) return;
        selected.set(candidate.id, candidate);
        projectedBytes -= Number(candidate.accounted_bytes);
      };
      const softProtected = (candidate) => sessions.has(candidate.session_id)
        || Number(candidate.created_at) >= recentCutoff
        || (candidate.kind === "turn"
          && (turnRanks.get(candidate.id) ?? Number.POSITIVE_INFINITY) <= this.retention.minimumTurnsPerSession);
      const hardProtected = (candidate) => candidate.kind === "turn"
        && (turnRanks.get(candidate.id) ?? Number.POSITIVE_INFINITY) === 1;

      for (const candidate of candidates) {
        if (projectedBytes <= cleanupTarget) break;
        if (!softProtected(candidate)) select(candidate);
      }
      for (const candidate of candidates) {
        if (projectedBytes <= cleanupTarget) break;
        if (!hardProtected(candidate)) select(candidate);
      }

      const selectedTurnIds = new Set([...selected.values()]
        .filter((candidate) => candidate.kind === "turn")
        .map((candidate) => candidate.id));
      if (selectedTurnIds.size > 0) {
        for (const candidate of candidates) {
          if (candidate.kind !== "decision-candidate" || selected.has(candidate.id)) continue;
          const sourceTurnId = parseMetadata(candidate.metadata_json).metadata.sourceTurnId;
          if (selectedTurnIds.has(sourceTurnId)) select(candidate);
        }
      }

      if (selected.size === 0) {
        if (!withinTransaction) this.db.exec("COMMIT");
        return finish({
          status: "protected-over-limit",
          totalBefore,
          totalAfter: totalBefore,
          deletedDocuments: 0,
          deletedBytes: 0,
          byKind: {},
        });
      }

      const byKind = {};
      for (const candidate of selected.values()) {
        this.deleteFts.run(candidate.id);
        this.deleteMessageFts.run(candidate.id);
        this.deleteMessages.run(candidate.id);
        this.deleteLegacyDocument.run(candidate.id);
        this.deleteDocumentOrder.run(candidate.id);
        this.deleteRetention.run(candidate.id);
        this.deleteDocument.run(candidate.id);
        byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1;
      }
      const totalAfter = this.logicalBytes();
      if (!withinTransaction) this.db.exec("COMMIT");
      return finish({
        status: totalAfter <= cleanupTarget ? "pruned" : "protected-over-limit",
        totalBefore,
        totalAfter,
        deletedDocuments: selected.size,
        deletedBytes: totalBefore - totalAfter,
        byKind,
      });
    } catch (error) {
      if (!withinTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  stats() {
    const retention = this.effectiveRetention();
    const pageSize = pragmaNumber(this.db, "page_size");
    const pageCount = pragmaNumber(this.db, "page_count");
    const freePages = pragmaNumber(this.db, "freelist_count");
    const autoVacuum = pragmaNumber(this.db, "auto_vacuum");
    const logicalBytes = this.logicalBytes();
    return {
      logicalBytes,
      maxBytes: retention.maxBytes,
      targetBytes: retention.targetBytes,
      databaseBytes: statBytes(this.path),
      walBytes: statBytes(`${this.path}-wal`),
      allocatedBytes: pageCount * pageSize,
      reclaimableBytes: freePages * pageSize,
      autoVacuum: autoVacuum === 2 ? "incremental" : autoVacuum === 1 ? "full" : "none",
      overLimit: logicalBytes > retention.maxBytes,
      lastPrune: this.lastCleanup ?? this.lastPrune,
    };
  }

  reclaim({ pages = 256 } = {}) {
    const before = this.stats();
    if (before.autoVacuum === "full") {
      return { status: "automatic", before, after: before };
    }
    if (before.autoVacuum !== "incremental") {
      return { status: "offline-upgrade-required", before, after: before };
    }
    try {
      this.db.exec(`PRAGMA incremental_vacuum(${positiveInteger(pages, 256)});`);
      const checkpoint = prepare(this.db, "PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (Number(checkpoint?.busy) > 0) {
        return { status: "busy", before, after: this.stats() };
      }
    } catch (error) {
      return {
        status: /busy|locked/i.test(error instanceof Error ? error.message : String(error))
          ? "busy"
          : "error",
        error: error instanceof Error ? error.message : String(error),
        before,
        after: this.stats(),
      };
    }
    return { status: "reclaimed", before, after: this.stats() };
  }

  count({ sessionId, sessionIds, project, scope = "session" } = {}) {
    const scopedSessionIds = Array.isArray(sessionIds)
      ? sessionIds.filter(Boolean)
      : (sessionId ? [sessionId] : []);
    if (scope === "session" && scopedSessionIds.length > 0) {
      const placeholders = scopedSessionIds.map(() => "?").join(", ");
      const projectClause = project ? " AND project = ?" : "";
      const params = project ? [...scopedSessionIds, project] : scopedSessionIds;
      return Number(prepare(this.db,
        `SELECT count(*) AS n FROM documents WHERE session_id IN (${placeholders})${projectClause}`,
      ).get(...params).n);
    }
    if (scope !== "all" && project) {
      return Number(prepare(this.db, "SELECT count(*) AS n FROM documents WHERE project = ?").get(project).n);
    }
    return Number(prepare(this.db, "SELECT count(*) AS n FROM documents").get().n);
  }

  releaseProtectionOwner(ownerId) {
    if (!ownerId) return;
    prepare(this.db, "DELETE FROM archive_protection WHERE owner_id = ?").run(String(ownerId));
  }

  close({ releaseProtection = true } = {}) {
    try {
      prepare(this.db, "DELETE FROM archive_client_policies WHERE owner_id = ?").run(this.ownerId);
    } catch {
      // Expiring leases recover from a failed best-effort release.
    }
    if (releaseProtection) {
      try {
        this.releaseProtectionOwner(this.ownerId);
      } catch {
        // Expiring leases recover from a failed best-effort release.
      }
    }
    this.db.close();
    return releaseProtection ? undefined : this.ownerId;
  }
}

export { accountedDocumentBytes, matchExpression, normalizeRetention, stableId };
