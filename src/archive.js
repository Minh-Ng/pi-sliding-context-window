import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { archiveDocumentProvenance } from "./provenance.js";

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

export class Archive {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`
      -- Multiple Pi sessions share this archive. Wait for a concurrent writer
      -- instead of failing immediately with SQLITE_BUSY.
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
  }

  put({ id, sessionId, project, kind = "turn", text, metadata = {}, createdAt = Date.now() }) {
    if (!text?.trim()) return undefined;
    const documentId = id ?? stableId([sessionId, project, kind, String(createdAt), text]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.insertDocument.run(documentId, sessionId, project, kind, createdAt, text, JSON.stringify(metadata));
      this.deleteFts.run(documentId);
      this.insertFts.run(documentId, sessionId, project, text);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return documentId;
  }

  search(query, { sessionId, sessionIds, project, scope = "session", limit = 3 } = {}) {
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

  get(id) {
    const row = prepare(this.db, "SELECT * FROM documents WHERE id = ?").get(id);
    if (!row) return undefined;
    const document = documentFromRow(row);
    return { ...document, provenance: archiveDocumentProvenance(document) };
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

  close() {
    this.db.close();
  }
}

export { matchExpression, stableId };
