import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { archiveDocumentProvenance } from "../identity/provenance.js";
import { stableJson } from "../rocksdb/schema.js";

export const SQLITE_SOURCE_FORMAT_VERSION = 1;

const SQLITE_SOURCE_STREAM_PAGE_SIZE = 1;
const SQLITE_SOURCE_MAX_RESULT_ROWS = 4;

const REQUIRED_DOCUMENT_COLUMNS = Object.freeze([
  "id",
  "session_id",
  "project",
  "kind",
  "created_at",
  "text",
  "metadata_json",
]);

const MESSAGE_COLUMNS = Object.freeze([
  "message_id",
  "document_id",
  "session_id",
  "project",
  "document_sequence",
  "message_index",
  "message_key",
  "role",
  "created_at",
  "text",
  "question_score",
  "request_score",
  "correction_score",
  "answer_score",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function updateJsonString(hash, value) {
  hash.update('"');
  const chunkCodeUnits = 64 * 1_024;
  for (let start = 0; start < value.length;) {
    let end = Math.min(value.length, start + chunkCodeUnits);
    if (end < value.length) {
      const preceding = value.charCodeAt(end - 1);
      const following = value.charCodeAt(end);
      if (preceding >= 0xd800 && preceding <= 0xdbff
        && following >= 0xdc00 && following <= 0xdfff) end -= 1;
    }
    const encoded = JSON.stringify(value.slice(start, end));
    hash.update(encoded.slice(1, -1));
    start = end;
  }
  hash.update('"');
}

/** Hash the exact stableJson(rawSource) bytes without allocating a text-sized JSON string. */
function rawSourceFingerprint(source) {
  const hash = createHash("sha256");
  const scalar = (key, value, comma = true) => {
    hash.update(`${comma ? "," : ""}${JSON.stringify(key)}:`);
    if (typeof value === "string") updateJsonString(hash, value);
    else hash.update(stableJson(value));
  };
  hash.update("{");
  scalar("createdAt", source.createdAt, false);
  scalar("id", source.id);
  scalar("kind", source.kind);
  scalar("metadataJson", source.metadataJson);
  scalar("project", source.project);
  scalar("sessionId", source.sessionId);
  scalar("sourceFormatVersion", source.sourceFormatVersion);
  scalar("sourceOrderingKey", source.sourceOrderingKey);
  scalar("sourceRowId", source.sourceRowId);
  scalar("structuralMessages", source.structuralMessages);
  scalar("text", source.text);
  hash.update("}");
  return hash.digest("hex");
}

function snapshotBusy(path) {
  const error = new Error(
    `SQLite source ${path} changed continuously while a private migration snapshot was copied; retry when a coherent view can be captured.`,
  );
  error.code = "ERR_SQLITE_SNAPSHOT_BUSY";
  return error;
}

function digestFile(path) {
  if (!existsSync(path)) return Object.freeze({ exists: false });
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    while (true) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return Object.freeze({ exists: true, bytes, sha256: hash.digest("hex") });
}

function sourceFileFingerprint(path) {
  return Object.freeze({
    database: digestFile(path),
    wal: digestFile(`${path}-wal`),
    journal: digestFile(`${path}-journal`),
  });
}

function sameFingerprint(left, right) {
  return stableJson(left) === stableJson(right);
}

/**
 * Copy the main database and WAL without asking SQLite to open the source.
 * Matching before/after digests prove the copied pair came from one stable
 * interval. SQLite may create coordination files only beside the private copy.
 */
function createPrivateSnapshot(path, attempts = 8) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-sqlite-snapshot-"));
  const snapshotPath = join(directory, basename(path));
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      for (const suffix of ["", "-wal", "-shm"]) {
        rmSync(`${snapshotPath}${suffix}`, { force: true });
      }
      let before;
      let after;
      try {
        before = sourceFileFingerprint(path);
        // A non-empty rollback journal can represent uncommitted pages already
        // written into the main file. Unlike WAL, it is not a committed
        // read-only view, so wait for that writer/recovery boundary to finish.
        if (before.journal.exists && before.journal.bytes > 0) continue;
        copyFileSync(path, snapshotPath);
        if (before.wal.exists) copyFileSync(`${path}-wal`, `${snapshotPath}-wal`);
        after = sourceFileFingerprint(path);
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      if (sameFingerprint(before, after)) {
        return Object.freeze({
          directory,
          path: snapshotPath,
          fingerprint: before,
          hasWal: before.wal.exists && before.wal.bytes > 0,
        });
      }
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  rmSync(directory, { recursive: true, force: true });
  throw snapshotBusy(path);
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

function safeOrderingKey(value, label = "source ordering key") {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return number;
}

function safeLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) {
    throw new RangeError("SQLite migration batch size must be between 1 and 100000.");
  }
  // This public limit is a maximum, not a promise to fill one result. Legacy
  // rows can each approach the canonical admission ceiling, so every source
  // query retains only a small fixed page regardless of caller batch policy.
  return Math.min(value, SQLITE_SOURCE_MAX_RESULT_ROWS);
}

function tableColumns(db, name) {
  return db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all()
    .map((row) => String(row.name));
}

function assertColumns(db, table, expected) {
  const actual = new Set(tableColumns(db, table));
  const missing = expected.filter((column) => !actual.has(column));
  if (missing.length > 0) {
    throw new Error(`SQLite archive table ${table} is missing columns: ${missing.join(", ")}.`);
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 AS present FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ?",
  ).get(name));
}

function schemaFingerprint(db) {
  const schema = db.prepare(`
    SELECT type, name, tbl_name, sql
    FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name, tbl_name
  `).all().map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql,
  }));
  const pragmas = {
    applicationId: Number(db.prepare("PRAGMA application_id").get().application_id ?? 0),
    userVersion: Number(db.prepare("PRAGMA user_version").get().user_version ?? 0),
  };
  return sha256(stableJson({ pragmas, schema }));
}

function messageFromRow(row) {
  return {
    messageId: row.message_id,
    documentId: row.document_id,
    sessionId: row.session_id,
    project: row.project,
    documentSequence: Number(row.document_sequence),
    messageIndex: Number(row.message_index),
    messageKey: row.message_key,
    role: row.role,
    createdAt: Number(row.created_at),
    text: row.text,
    questionScore: Number(row.question_score),
    requestScore: Number(row.request_score),
    correctionScore: Number(row.correction_score),
    answerScore: Number(row.answer_score),
  };
}

function documentFromRow(row, structuralMessages) {
  if (typeof row.metadata_json !== "string") {
    throw new TypeError(`SQLite document ${String(row.id)} has non-text metadata_json.`);
  }
  const parsed = parseMetadata(row.metadata_json);
  const document = {
    id: row.id,
    sessionId: row.session_id,
    project: row.project,
    kind: row.kind,
    createdAt: Number(row.created_at),
    text: row.text,
    ...parsed,
  };
  const rawSource = {
    sourceFormatVersion: SQLITE_SOURCE_FORMAT_VERSION,
    sourceOrderingKey: safeOrderingKey(row.source_order),
    sourceRowId: safeOrderingKey(row.source_rowid, "SQLite rowid"),
    metadataJson: row.metadata_json,
    structuralMessages,
    id: document.id,
    sessionId: document.sessionId,
    project: document.project,
    kind: document.kind,
    createdAt: document.createdAt,
    text: document.text,
  };
  const source = {
    ...rawSource,
    metadata: document.metadata,
    metadataParse: document.metadataParse,
    provenance: archiveDocumentProvenance(document),
  };
  return Object.freeze({
    ...source,
    // Checkpoint identity is based only on SQLite values. Derived parser error
    // wording and provenance prose may legitimately change with the runtime.
    sourceRecordFingerprint: rawSourceFingerprint(rawSource),
  });
}

/**
 * A deliberately narrow, read-only view of a legacy SQLite archive. It never
 * constructs Archive because Archive startup and Archive.get both write
 * bookkeeping state.
 */
export class SqliteArchiveSource {
  static open(path, options = {}) {
    return new SqliteArchiveSource(path, options);
  }

  constructor(path, options = {}) {
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new TypeError("A non-empty SQLite source path is required.");
    }
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("SQLite source options must be an object.");
    }
    const requestedPath = resolve(path);
    this.path = realpathSync(requestedPath);
    const stat = statSync(this.path, { bigint: true });
    if (!stat.isFile()) throw new TypeError(`SQLite source ${this.path} is not a regular file.`);

    this.privateSnapshot = createPrivateSnapshot(this.path);
    const location = this.privateSnapshot.hasWal
      ? this.privateSnapshot.path
      : `${pathToFileURL(this.privateSnapshot.path).href}?mode=ro&immutable=1`;
    this.readMode = this.privateSnapshot.hasWal ? "private-wal-snapshot" : "private-immutable-snapshot";
    this.db = new DatabaseSync(location, { readOnly: true });
    try {
      // This is connection-local defense in depth. The operating-system file
      // descriptor is already read-only.
      this.db.exec("PRAGMA query_only = ON;");
      const integrity = this.db.prepare("PRAGMA quick_check").all();
      if (integrity.length !== 1 || String(Object.values(integrity[0])[0]) !== "ok") {
        throw new Error("Private SQLite migration snapshot failed PRAGMA quick_check.");
      }
      if (!hasTable(this.db, "documents")) {
        throw new Error("SQLite source is not a context-window archive: documents is missing.");
      }
      assertColumns(this.db, "documents", REQUIRED_DOCUMENT_COLUMNS);
      this.hasDocumentOrder = hasTable(this.db, "document_order");
      this.hasArchiveMessages = hasTable(this.db, "archive_messages");
      if (this.hasDocumentOrder) {
        assertColumns(this.db, "document_order", ["sequence", "document_id"]);
        const counts = this.db.prepare(`
          SELECT
            (SELECT count(*) FROM documents) AS documents,
            (SELECT count(*) FROM document_order AS o
              JOIN documents AS d ON d.id = o.document_id) AS ordered_documents,
            (SELECT count(*) FROM document_order AS o
              LEFT JOIN documents AS d ON d.id = o.document_id
              WHERE d.id IS NULL) AS orphaned_order_rows
        `).get();
        if (Number(counts.documents) !== Number(counts.ordered_documents)
          || Number(counts.orphaned_order_rows) !== 0) {
          throw new Error("SQLite document_order is incomplete or contains orphaned rows.");
        }
      }
      if (this.hasArchiveMessages) assertColumns(this.db, "archive_messages", MESSAGE_COLUMNS);
      this.orderingMode = this.hasDocumentOrder ? "document-order" : "rowid";
      this.documentIdByOrderingKey = this.db.prepare(this.hasDocumentOrder
        ? `
          SELECT d.id
          FROM documents AS d
          JOIN document_order AS o ON o.document_id = d.id
          WHERE o.sequence = ?
        `
        : "SELECT id FROM documents WHERE rowid = ?");
      this.documentIdExists = this.db.prepare("SELECT 1 AS present FROM documents WHERE id = ?");
      this.schemaFingerprint = schemaFingerprint(this.db);
      this.databaseIdentity = Object.freeze({
        path: this.path,
        device: String(stat.dev),
        inode: String(stat.ino),
        birthtimeNs: String(stat.birthtimeNs),
      });
      this.databaseId = sha256(stableJson(this.databaseIdentity));
      this.fileFingerprint = this.privateSnapshot.fingerprint;
      if (options.deferCorpusIdentity !== true) {
        const corpus = this.#corpusIdentity();
        this.corpusFingerprint = corpus.fingerprint;
        this.snapshotDocumentCount = corpus.documentCount;
        this.snapshotLastOrderingKey = corpus.lastSourceOrderingKey;
        this.fingerprint = sha256(stableJson({
          databaseIdentity: this.databaseIdentity,
          orderingMode: this.orderingMode,
          schemaFingerprint: this.schemaFingerprint,
          corpusFingerprint: this.corpusFingerprint,
        }));
      }
    } catch (error) {
      this.db.close();
      this.db = undefined;
      rmSync(this.privateSnapshot.directory, { recursive: true, force: true });
      this.privateSnapshot = undefined;
      throw error;
    }
  }

  assertOpen() {
    if (!this.db) throw new Error("SQLite migration source is closed.");
  }

  #corpusIdentity() {
    const hash = createHash("sha256");
    let cursor = 0;
    let documentCount = 0;
    while (true) {
      const rows = this.readBatch(cursor, SQLITE_SOURCE_STREAM_PAGE_SIZE);
      if (rows.length === 0) break;
      for (const row of rows) {
        hash.update(stableJson([
          row.sourceOrderingKey,
          row.sourceRecordFingerprint,
        ]));
        hash.update("\n");
        cursor = row.sourceOrderingKey;
        documentCount += 1;
      }
    }
    return {
      fingerprint: hash.digest("hex"),
      documentCount,
      lastSourceOrderingKey: cursor,
    };
  }

  info() {
    this.assertOpen();
    const stat = statSync(this.path);
    return Object.freeze({
      sourceFormatVersion: SQLITE_SOURCE_FORMAT_VERSION,
      path: this.path,
      databaseId: this.databaseId,
      databaseIdentity: this.databaseIdentity,
      fileFingerprint: this.fileFingerprint,
      sourceFingerprint: this.fingerprint,
      schemaFingerprint: this.schemaFingerprint,
      orderingMode: this.orderingMode,
      readMode: this.readMode,
      sizeBytes: stat.size,
      documentCount: this.snapshotDocumentCount,
      lastSourceOrderingKey: this.snapshotLastOrderingKey,
      corpusFingerprint: this.corpusFingerprint,
    });
  }

  /** Prove that the live source bytes still match the interval used for this private snapshot. */
  assertUnchanged() {
    this.assertOpen();
    const current = sourceFileFingerprint(this.path);
    if (!sameFingerprint(current, this.privateSnapshot.fingerprint)) {
      const error = new Error(`SQLite source ${this.path} changed after its migration snapshot.`);
      error.code = "ERR_SQLITE_SOURCE_CHANGED";
      throw error;
    }
    return true;
  }

  count() {
    this.assertOpen();
    return Number(this.db.prepare("SELECT count(*) AS count FROM documents").get().count);
  }

  lastOrderingKey() {
    this.assertOpen();
    const query = this.hasDocumentOrder
      ? "SELECT coalesce(max(sequence), 0) AS value FROM document_order"
      : "SELECT coalesce(max(rowid), 0) AS value FROM documents";
    return Number(this.db.prepare(query).get().value);
  }

  #messages(documentId) {
    if (!this.hasArchiveMessages) return [];
    return this.db.prepare(`
      SELECT ${MESSAGE_COLUMNS.join(", ")}
      FROM archive_messages
      WHERE document_id = ?
      ORDER BY message_index, message_id
    `).all(documentId).map(messageFromRow);
  }

  #select(where, parameters, limit) {
    this.assertOpen();
    const sourceOrder = this.hasDocumentOrder ? "o.sequence" : "d.rowid";
    const join = this.hasDocumentOrder
      ? "JOIN document_order AS o ON o.document_id = d.id"
      : "";
    let documents;
    this.db.exec("BEGIN;");
    try {
      const rows = this.db.prepare(`
        SELECT
          ${sourceOrder} AS source_order,
          d.rowid AS source_rowid,
          d.id,
          d.session_id,
          d.project,
          d.kind,
          d.created_at,
          d.text,
          d.metadata_json
        FROM documents AS d
        ${join}
        WHERE ${where.replaceAll("$order", sourceOrder)}
        ORDER BY ${sourceOrder}, d.id
        LIMIT ?
      `).all(...parameters, safeLimit(limit));
      documents = rows.map((row) => documentFromRow(row, this.#messages(row.id)));
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return documents;
  }

  readBatch(afterOrderingKey = 0, limit = 100) {
    if (!Number.isSafeInteger(afterOrderingKey) || afterOrderingKey < 0) {
      throw new TypeError("afterOrderingKey must be a non-negative safe integer.");
    }
    return this.#select("$order > ?", [afterOrderingKey], limit);
  }

  readRange(afterOrderingKey, throughOrderingKey, limit = 100_000) {
    if (!Number.isSafeInteger(afterOrderingKey) || afterOrderingKey < 0
      || !Number.isSafeInteger(throughOrderingKey) || throughOrderingKey < afterOrderingKey) {
      throw new TypeError("SQLite source range must contain valid ordered keys.");
    }
    return this.#select(
      "$order > ? AND $order <= ?",
      [afterOrderingKey, throughOrderingKey],
      limit,
    );
  }

  getByOrderingKey(orderingKey) {
    const rows = this.#select("$order = ?", [safeOrderingKey(orderingKey)], 1);
    return rows[0];
  }

  /** Point lookup used by streaming destination verification without materializing source rows. */
  getDocumentIdByOrderingKey(orderingKey) {
    this.assertOpen();
    return this.documentIdByOrderingKey.get(safeOrderingKey(orderingKey))?.id;
  }

  /** Check canonical membership through SQLite's primary-key index. */
  hasDocumentId(documentId) {
    this.assertOpen();
    if (typeof documentId !== "string") return false;
    return this.documentIdExists.get(documentId) !== undefined;
  }

  close() {
    if (this.db) this.db.close();
    this.db = undefined;
    this.documentIdByOrderingKey = undefined;
    this.documentIdExists = undefined;
    if (this.privateSnapshot) {
      rmSync(this.privateSnapshot.directory, { recursive: true, force: true });
      this.privateSnapshot = undefined;
    }
  }
}

export function inspectSqliteArchive(path) {
  const source = SqliteArchiveSource.open(path);
  try {
    return source.info();
  } finally {
    source.close();
  }
}

export function createSourceBatchFingerprint() {
  const hash = createHash("sha256");
  let count = 0;
  let finished = false;
  hash.update("[");
  return Object.freeze({
    add(document) {
      if (finished) throw new TypeError("Source batch fingerprint is already finalized.");
      if (!document || !Number.isSafeInteger(document.sourceOrderingKey)
        || typeof document.sourceRecordFingerprint !== "string") {
        throw new TypeError("Source batch fingerprint requires an ordered source document.");
      }
      if (count > 0) hash.update(",");
      hash.update(stableJson({
        sourceOrderingKey: document.sourceOrderingKey,
        sourceRecordFingerprint: document.sourceRecordFingerprint,
      }));
      count += 1;
    },
    finish() {
      if (finished) throw new TypeError("Source batch fingerprint is already finalized.");
      finished = true;
      hash.update("]");
      return hash.digest("hex");
    },
  });
}

export function sourceBatchFingerprint(documents) {
  if (!Array.isArray(documents)) throw new TypeError("documents must be an array.");
  const fingerprint = createSourceBatchFingerprint();
  for (const document of documents) fingerprint.add(document);
  return fingerprint.finish();
}
