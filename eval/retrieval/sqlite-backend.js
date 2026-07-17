import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive } from "../../src/archive.js";
import { RETRIEVAL_BACKEND_API_VERSION } from "./schema.js";

export function createSqliteEvaluationBackend() {
  const directory = mkdtempSync(join(tmpdir(), "context-window-retrieval-eval-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 64 * 1024 * 1024,
      targetBytes: 48 * 1024 * 1024,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  let prepared = false;
  return {
    metadata: Object.freeze({
      id: "sqlite-fts5-baseline",
      version: "legacy-v1",
      apiVersion: RETRIEVAL_BACKEND_API_VERSION,
      capabilities: Object.freeze(["exact", "lexical", "structural"]),
    }),
    async prepare(fixture) {
      if (prepared) throw new Error("SQLite evaluation backend may only be prepared once");
      for (const document of fixture.documents) {
        archive.put({
          id: document.id,
          sessionId: document.sessionId,
          project: document.project,
          kind: document.kind,
          createdAt: document.createdAt,
          text: document.text,
          metadata: document.metadata,
        }, {
          structuralMessages: document.structuralMessages,
          deferPrune: true,
        });
      }
      prepared = true;
    },
    async search(request) {
      if (!prepared) throw new Error("SQLite evaluation backend has not been prepared");
      return archive.searchDetailed(request.query, {
        relation: request.mode === "structural" ? request.relation : undefined,
        sessionId: request.sessionId,
        sessionIds: request.sessionIds,
        project: request.project,
        scope: request.scope,
        limit: request.limit,
      });
    },
    async close() {
      archive.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
