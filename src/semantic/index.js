import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { KEYSPACE } from "../rocksdb/keys.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import { LocalEmbedder } from "./embedder-client.js";
import { createSemanticSpans } from "./spans.js";

const require = createRequire(import.meta.url);
// usearch 2.26's ESM wrapper recurses while resolving its native build. Its
// documented CommonJS entry loads the same packaged native binding correctly.
const usearch = require("usearch");
const FORMAT_VERSION = 1;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_CANDIDATES = 40;
const DEFAULT_MINIMUM_SCORE = 0.35;
export const DEFAULT_SEMANTIC_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_SEMANTIC_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";

function digest(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function vectorLabel(identity, salt = 0) {
  const bytes = createHash("sha256").update(`${identity}\0${salt}`).digest();
  const label = bytes.readBigUInt64BE(0);
  return label === 0n ? 1n : label;
}

function newIndex(dimensions) {
  return new usearch.Index({
    dimensions,
    metric: usearch.MetricKind.Cos,
    quantization: usearch.ScalarKind.F32,
    connectivity: 16,
    expansion_add: 64,
    expansion_search: 48,
    multi: false,
  });
}

function eligible(entry, request) {
  if (request.effectiveScope === "session" && !request.sessionIds.includes(entry.sessionId)) {
    return false;
  }
  return !entry.sourceMessageKeys.some((key) => request.excludeVisibleSourceKeys.includes(key));
}

export class LocalSemanticIndex {
  constructor(store, {
    enabled = false,
    model = DEFAULT_SEMANTIC_MODEL,
    revision = DEFAULT_SEMANTIC_MODEL_REVISION,
    cachePath = ".context-window/models",
    indexPath = ".context-window/semantic-index",
    dimensions = 384,
    batchSize = DEFAULT_BATCH_SIZE,
    candidates = DEFAULT_CANDIDATES,
    minimumScore = DEFAULT_MINIMUM_SCORE,
    embedder,
    recordError = () => {},
  } = {}) {
    this.store = store;
    this.enabled = enabled;
    this.model = model;
    this.revision = revision;
    this.cachePath = cachePath;
    this.indexPath = indexPath;
    this.dimensions = dimensions;
    this.batchSize = Number.isSafeInteger(batchSize) && batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
    this.candidates = Number.isSafeInteger(candidates) && candidates > 0
      ? candidates
      : DEFAULT_CANDIDATES;
    this.minimumScore = typeof minimumScore === "number"
      && Number.isFinite(minimumScore)
      && minimumScore >= 0
      && minimumScore <= 1
      ? minimumScore
      : DEFAULT_MINIMUM_SCORE;
    this.embedder = embedder;
    this.ownsEmbedder = embedder === undefined;
    this.recordError = recordError;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
    this.unavailable = false;
    this.fingerprint = digest(`${model}\0${revision}\0${dimensions}`, 32);
  }

  initialize() {
    if (!this.enabled) return this;
    setImmediate(() => this.#warmExisting());
    return this;
  }

  #embedder() {
    this.embedder ??= new LocalEmbedder({
      model: this.model,
      revision: this.revision,
      cachePath: this.cachePath,
    });
    return this.embedder;
  }

  #projectDirectory(project) {
    return join(this.indexPath, this.fingerprint, digest(project, 32));
  }

  async #loadProject(project) {
    let statePromise = this.states.get(project);
    if (statePromise) return statePromise;
    statePromise = (async () => {
      const directory = this.#projectDirectory(project);
      const state = {
        project,
        directory,
        index: undefined,
        entries: new Map(),
        documents: new Set(),
        dirty: false,
      };
      try {
        const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
        if (metadata.formatVersion !== FORMAT_VERSION
          || metadata.fingerprint !== this.fingerprint
          || metadata.project !== project
          || metadata.dimensions !== this.dimensions
          || !Array.isArray(metadata.entries)) return state;
        state.index = newIndex(this.dimensions);
        state.index.load(join(directory, "index.usearch"));
        for (const entry of metadata.entries) state.entries.set(entry.label, Object.freeze(entry));
        for (const identity of metadata.documents ?? []) state.documents.add(identity);
      } catch {
        // A missing, partial, or incompatible derived snapshot is rebuilt from
        // canonical RocksDB records. It never makes lexical retrieval fail.
      }
      return state;
    })();
    this.states.set(project, statePromise);
    return statePromise;
  }

  async #persist(state) {
    if (!state.dirty || !state.index) return;
    await mkdir(state.directory, { recursive: true, mode: 0o700 });
    const suffix = `${process.pid}-${Date.now()}`;
    const temporaryIndex = join(state.directory, `index.${suffix}.tmp`);
    const temporaryMetadata = join(state.directory, `metadata.${suffix}.tmp`);
    state.index.save(temporaryIndex);
    await writeFile(temporaryMetadata, JSON.stringify({
      formatVersion: FORMAT_VERSION,
      fingerprint: this.fingerprint,
      project: state.project,
      dimensions: this.dimensions,
      entries: [...state.entries.values()],
      documents: [...state.documents],
    }), { mode: 0o600 });
    await rename(temporaryIndex, join(state.directory, "index.usearch"));
    await rename(temporaryMetadata, join(state.directory, "metadata.json"));
    state.dirty = false;
  }

  async #documentSpans(documentId, version) {
    return this.store.snapshot(async (view) => {
      const manifest = await view.get(manifestKeys.document(documentId, version));
      if (!manifest) return undefined;
      if (view.scan([KEYSPACE.SUPERSESSION, documentId, version], { limit: 1 }).length > 0) {
        return undefined;
      }
      const spans = [];
      const seen = new Set();
      for (const { payload: window } of view.scan([KEYSPACE.WINDOW, documentId, version])) {
        const range = await readDocumentRange(view, manifest, window.startByte, window.endByte);
        for (const span of createSemanticSpans(range.text, {
          baseStartByte: range.startByte,
          windowOrdinal: window.ordinal,
        })) {
          const identity = `${span.startByte}:${span.endByte}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          spans.push(span);
        }
      }
      return { manifest, spans };
    });
  }

  async #indexDocument(documentId, version) {
    if (this.closed || this.unavailable) return;
    const source = await this.#documentSpans(documentId, version);
    if (!source || source.spans.length === 0) return;
    const { manifest, spans } = source;
    const state = await this.#loadProject(manifest.project);
    const documentIdentity = `${documentId}\0${version}`;
    if (state.documents.has(documentIdentity)) return;
    for (let offset = 0; offset < spans.length; offset += this.batchSize) {
      const batch = spans.slice(offset, offset + this.batchSize);
      const embedded = await this.#embedder().embed(batch.map(({ text }) => text));
      if (embedded.dimensions !== this.dimensions
        || embedded.vectors.length !== batch.length * this.dimensions) {
        throw new Error(`Local embedding model returned incompatible ${embedded.dimensions}-dimensional vectors.`);
      }
      state.index ??= newIndex(this.dimensions);
      const labels = new BigUint64Array(batch.length);
      for (let index = 0; index < batch.length; index += 1) {
        const span = batch[index];
        const identity = `${manifest.project}\0${documentIdentity}\0${span.startByte}\0${span.endByte}`;
        let salt = 0;
        let label = vectorLabel(identity, salt);
        while (state.entries.has(label.toString())
          && state.entries.get(label.toString()).identity !== identity) {
          label = vectorLabel(identity, ++salt);
        }
        labels[index] = label;
        state.entries.set(label.toString(), Object.freeze({
          label: label.toString(),
          identity,
          documentId,
          version,
          kind: manifest.kind,
          createdAt: manifest.createdAt,
          sessionId: manifest.sessionId,
          sourceMessageKeys: manifest.sourceMessageKeys,
          windowOrdinal: span.windowOrdinal,
          startByte: span.startByte,
          endByte: span.endByte,
          text: span.text,
        }));
      }
      state.index.add(labels, embedded.vectors, 1);
    }
    state.documents.add(documentIdentity);
    state.dirty = true;
    await this.#persist(state);
  }

  enqueueDocument(documentId, version) {
    if (!this.enabled || this.closed || this.unavailable) return;
    this.queue = this.queue.then(() => this.#indexDocument(documentId, version)).catch((error) => {
      this.unavailable = true;
      this.recordError(error);
    });
  }

  async #warmExisting() {
    try {
      for (const { payload: manifest } of this.store.scan([KEYSPACE.DOCUMENT])) {
        this.enqueueDocument(manifest.documentId, manifest.version);
      }
    } catch (error) {
      this.recordError(error);
    }
  }

  async search(request) {
    if (!this.enabled || this.closed || this.unavailable || request.query.trim().length === 0) return [];
    try {
      const state = await this.#loadProject(request.project);
      if (!state.index || state.index.size() === 0) return [];
      const embedded = await this.#embedder().embed([request.query]);
      if (embedded.dimensions !== this.dimensions) return [];
      const results = [];
      const returned = new Set();
      for (let attempt = 0; attempt < 3 && results.length < request.limit * 3; attempt += 1) {
        const matches = state.index.search(
          embedded.vectors,
          Math.min(state.index.size(), this.candidates),
          1,
        );
        let removed = 0;
        for (let index = 0; index < matches.keys.length; index += 1) {
          const label = matches.keys[index];
          const entry = state.entries.get(label.toString());
          if (!entry) continue;
          const manifest = await this.store.get(manifestKeys.document(entry.documentId, entry.version));
          const retired = this.store.scan(
            [KEYSPACE.SUPERSESSION, entry.documentId, entry.version],
            { limit: 1 },
          ).length > 0;
          if (!manifest || manifest.project !== request.project || retired) {
            state.index.remove(label);
            state.entries.delete(label.toString());
            state.dirty = true;
            removed += 1;
            continue;
          }
          if (!eligible(entry, request)) continue;
          if (returned.has(entry.label)) continue;
          const score = Math.max(0, Math.min(1, 1 - matches.distances[index]));
          if (score < this.minimumScore) continue;
          returned.add(entry.label);
          results.push({ ...entry, project: request.project, score });
          if (results.length >= request.limit * 3) break;
        }
        if (removed === 0) break;
      }
      await this.#persist(state);
      return results;
    } catch (error) {
      this.unavailable = true;
      this.recordError(error);
      return [];
    }
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.enabled && !this.unavailable,
      projects: this.states.size,
      model: this.model,
      revision: this.revision,
    };
  }

  async flush() {
    await this.queue;
  }

  async close() {
    this.closed = true;
    await this.queue.catch(() => {});
    if (this.ownsEmbedder) await this.embedder?.close();
  }
}
