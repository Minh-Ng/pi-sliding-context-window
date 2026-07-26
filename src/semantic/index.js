import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { KEYSPACE } from "../rocksdb/keys.js";
import { manifestKeys } from "../rocksdb/manifests.js";
import { readDocumentRange } from "../rocksdb/document-range.js";
import {
  derivedViewKeys,
  documentOrdinalLiveness,
  isDerivedViewQueryCutover,
} from "../rocksdb/derived-view.js";
import { LocalEmbedder } from "./embedder-client.js";
import {
  decodeSemanticMetadata,
  encodeSemanticMetadata,
  LEGACY_SEMANTIC_METADATA_FILENAME,
  normalizeLegacySemanticMetadata,
  SEMANTIC_METADATA_FILENAME,
} from "./metadata.js";
import { semanticModelProfile } from "./model-catalog.js";
import { createSemanticSpans } from "./spans.js";

const require = createRequire(import.meta.url);
// usearch 2.26's ESM wrapper recurses while resolving its native build. Its
// documented CommonJS entry loads the same packaged native binding correctly.
const usearch = require("usearch");
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_CANDIDATES = 40;
const DEFAULT_MINIMUM_SCORE = 0.35;
const DEFAULT_COMPACTION_INTERVAL_MS = 60_000;
const DEFAULT_COMPACTION_IDLE_MS = 5_000;
const DEFAULT_COMPACTION_MINIMUM_ENTRIES = 1_000;
const DEFAULT_COMPACTION_DEAD_RATIO = 0.25;
export const DEFAULT_SEMANTIC_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_SEMANTIC_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
// Mirrors config.js's POOLING_MODES: the pooling strategies the pinned
// @huggingface/transformers feature-extraction pipeline accepts.
const POOLING_MODES = new Set(["mean", "cls", "first_token", "last_token", "eos", "none"]);

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    // Observability must never make a valid derived index unavailable.
    return 0;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function digest(value, length = 24) {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function documentIdentity(documentId, version) {
  return `${documentId}\0${version}`;
}

function vectorIdentity(project, documentId, version, startByte, endByte) {
  return `${project}\0${documentIdentity(documentId, version)}\0${startByte}\0${endByte}`;
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
    // F16 halves vector memory and on-disk snapshot size versus F32 at
    // no measured retrieval cost (100% top-10 overlap on MiniLM-scale
    // vectors). Quantization is intentionally NOT part of the index
    // fingerprint: load()/view() restore the scalar kind serialized in the
    // snapshot itself, so legacy F32 snapshots keep working unchanged and
    // only new or rebuilt snapshots pick up F16.
    quantization: usearch.ScalarKind.F16,
    connectivity: 16,
    expansion_add: 64,
    expansion_search: 48,
    multi: false,
  });
}

function eligible(manifest, request) {
  if (request.effectiveScope === "session" && !request.sessionIds.includes(manifest.sessionId)) {
    return false;
  }
  return !manifest.sourceMessageKeys.some((key) => request.excludeVisibleSourceKeys.includes(key));
}

export class LocalSemanticIndex {
  constructor(store, {
    enabled = false,
    model = DEFAULT_SEMANTIC_MODEL,
    revision = DEFAULT_SEMANTIC_MODEL_REVISION,
    cachePath = ".context-window/models",
    indexPath = ".context-window/semantic-index",
    // Dimensions and pooling are properties of the configured model, not
    // independent knobs: default to the catalog entry for `model` (see
    // model-catalog.js) and only fall back to the historical MiniLM/mean
    // literals for a model the catalog does not recognize. An explicit
    // caller-supplied value always wins, covering custom/self-hosted models.
    dimensions: dimensionsOption = semanticModelProfile(model)?.dimensions ?? 384,
    pooling: poolingOption = semanticModelProfile(model)?.pooling ?? "mean",
    batchSize = DEFAULT_BATCH_SIZE,
    candidates = DEFAULT_CANDIDATES,
    minimumScore = DEFAULT_MINIMUM_SCORE,
    compactionIntervalMs = DEFAULT_COMPACTION_INTERVAL_MS,
    compactionIdleMs = DEFAULT_COMPACTION_IDLE_MS,
    compactionMinimumEntries = DEFAULT_COMPACTION_MINIMUM_ENTRIES,
    compactionDeadRatio = DEFAULT_COMPACTION_DEAD_RATIO,
    compactionEnabled = true,
    backgroundGate,
    embedder,
    recordError = () => {},
  } = {}) {
    this.store = store;
    this.enabled = enabled;
    this.model = model;
    this.revision = revision;
    this.cachePath = cachePath;
    this.indexPath = indexPath;
    // A caller (e.g. the daemon CLI/env plumbing) may pass through an
    // unsanitized override; fail closed to the catalog/default rather than
    // letting NaN or an unrecognized pooling string reach the wire contract
    // or the usearch index constructor.
    const dimensions = Number.isSafeInteger(dimensionsOption) && dimensionsOption > 0
      ? dimensionsOption
      : semanticModelProfile(model)?.dimensions ?? 384;
    const pooling = typeof poolingOption === "string" && POOLING_MODES.has(poolingOption)
      ? poolingOption
      : semanticModelProfile(model)?.pooling ?? "mean";
    this.dimensions = dimensions;
    this.pooling = pooling;
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
    this.compactionIntervalMs = Number.isSafeInteger(compactionIntervalMs) && compactionIntervalMs > 0
      ? compactionIntervalMs
      : DEFAULT_COMPACTION_INTERVAL_MS;
    this.compactionIdleMs = Number.isSafeInteger(compactionIdleMs) && compactionIdleMs >= 0
      ? compactionIdleMs
      : DEFAULT_COMPACTION_IDLE_MS;
    this.compactionMinimumEntries = Number.isSafeInteger(compactionMinimumEntries)
      && compactionMinimumEntries > 0
      ? compactionMinimumEntries
      : DEFAULT_COMPACTION_MINIMUM_ENTRIES;
    this.compactionDeadRatio = typeof compactionDeadRatio === "number"
      && Number.isFinite(compactionDeadRatio)
      && compactionDeadRatio > 0
      && compactionDeadRatio < 1
      ? compactionDeadRatio
      : DEFAULT_COMPACTION_DEAD_RATIO;
    this.compactionEnabled = compactionEnabled !== false;
    this.backgroundGate = typeof backgroundGate === "function"
      ? backgroundGate
      : () => this.#waitForForegroundIdle();
    this.embedder = embedder;
    this.ownsEmbedder = embedder === undefined;
    this.recordError = recordError;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.entryCount = 0;
    this.documentCount = 0;
    this.queuedDocuments = 0;
    this.metadataBytes = 0;
    this.indexBytes = 0;
    this.closed = false;
    this.unavailable = false;
    this.lastForegroundAt = 0;
    this.compactionTimer = undefined;
    this.compactionPromise = undefined;
    this.rebuildingProjects = new Set();
    // Pooling changes the vectors a model produces for the same text, so it
    // versions the derived index exactly like model/revision/dimensions do.
    // "mean" was the implicit, undigested pooling for every index built
    // before pooling became an explicit knob, so it is omitted here too:
    // upgrading to this catalog-driven derivation must not invalidate (and
    // force a full re-embed of) every already-built mean-pooled index for a
    // deployment whose effective config hasn't changed.
    this.fingerprint = pooling === "mean"
      ? digest(`${model}\0${revision}\0${dimensions}`, 32)
      : digest(`${model}\0${revision}\0${dimensions}\0${pooling}`, 32);
  }

  initialize() {
    if (!this.enabled) return this;
    setImmediate(() => this.#warmExisting());
    if (this.compactionEnabled) {
      this.compactionTimer = setInterval(() => { void this.maintain(); }, this.compactionIntervalMs);
      this.compactionTimer.unref?.();
    }
    return this;
  }

  #embedder() {
    this.embedder ??= new LocalEmbedder({
      model: this.model,
      revision: this.revision,
      cachePath: this.cachePath,
      pooling: this.pooling,
    });
    return this.embedder;
  }

  /**
   * Where this project's vectors live on disk. Public because purging a
   * project is now a cross-layer concern: the caller that retires a project's
   * documents has to be able to find and remove the index that no keyspace
   * sweep reaches.
   */
  projectDirectory(project) {
    return join(this.indexPath, this.fingerprint, digest(project, 32));
  }

  async #loadProject(project) {
    let statePromise = this.states.get(project);
    if (statePromise) return statePromise;
    statePromise = (async () => {
      const directory = this.projectDirectory(project);
      const state = {
        project,
        directory,
        index: undefined,
        entries: new Map(),
        documents: new Set(),
        entryCountByDocumentIdentity: new Map(),
        retiredLabels: new Set(),
        metadataBytes: 0,
        indexBytes: 0,
        dirty: false,
        // True while `index` is an mmap view of the on-disk snapshot: pages
        // are file-backed and evictable instead of resident anonymous
        // memory, but the index is immutable until #writableIndex promotes
        // it to a loaded copy.
        viewed: false,
      };
      try {
        const metadataPath = join(directory, SEMANTIC_METADATA_FILENAME);
        const legacyMetadataPath = join(directory, LEGACY_SEMANTIC_METADATA_FILENAME);
        const indexPath = join(directory, "index.usearch");
        let metadata;
        let legacy = false;
        try {
          metadata = decodeSemanticMetadata(await readFile(metadataPath), {
            fingerprint: this.fingerprint,
            project,
            dimensions: this.dimensions,
          });
        } catch {
          metadata = normalizeLegacySemanticMetadata(
            JSON.parse(await readFile(legacyMetadataPath, "utf8")),
            {
              fingerprint: this.fingerprint,
              project,
              dimensions: this.dimensions,
            },
          );
          legacy = true;
        }
        state.index = newIndex(this.dimensions);
        // view() mmaps the snapshot instead of copying it into anonymous
        // memory. Most projects a daemon touches are read-mostly, so their
        // vectors stay evictable file-backed pages; the first mutation
        // promotes to a resident load() via #writableIndex. Renames in
        // #persist are safe while viewed: the mapping pins the old inode.
        state.index.view(indexPath);
        state.viewed = true;
        for (const entry of metadata.entries) {
          state.entries.set(entry.label, Object.freeze(entry));
          const identity = documentIdentity(entry.documentId, entry.version);
          state.documents.add(identity);
          state.entryCountByDocumentIdentity.set(
            identity,
            (state.entryCountByDocumentIdentity.get(identity) ?? 0) + 1,
          );
        }
        if (state.index.size() !== state.entries.size) {
          throw new Error("Semantic vector and metadata entry counts differ.");
        }
        if (legacy) {
          const temporaryMetadata = join(
            directory,
            `${SEMANTIC_METADATA_FILENAME}.${process.pid}-${Date.now()}.tmp`,
          );
          await writeFile(temporaryMetadata, encodeSemanticMetadata({
            fingerprint: this.fingerprint,
            project,
            dimensions: this.dimensions,
            entries: [...state.entries.values()],
          }), { mode: 0o600 });
          await rename(temporaryMetadata, metadataPath);
        }
        // A crash can occur after publishing metadata.bin but before removing
        // metadata.json. Once the binary snapshot and ANN index validate
        // together, the legacy duplicate is always obsolete.
        await rm(legacyMetadataPath, { force: true });
        [state.metadataBytes, state.indexBytes] = await Promise.all([
          fileSize(metadataPath),
          fileSize(indexPath),
        ]);
        this.entryCount += state.entries.size;
        this.documentCount += state.documents.size;
        this.metadataBytes += state.metadataBytes;
        this.indexBytes += state.indexBytes;
      } catch {
        // A missing, partial, or incompatible derived snapshot is rebuilt from
        // canonical RocksDB records. It never makes lexical retrieval fail.
        state.index = undefined;
        state.entries.clear();
        state.documents.clear();
        state.entryCountByDocumentIdentity.clear();
        state.retiredLabels.clear();
        state.metadataBytes = 0;
        state.indexBytes = 0;
        state.dirty = false;
        state.viewed = false;
      }
      return state;
    })();
    this.states.set(project, statePromise);
    return statePromise;
  }

  async #waitForForegroundIdle() {
    while (!this.closed) {
      const remaining = this.compactionIdleMs - (Date.now() - this.lastForegroundAt);
      if (remaining <= 0) return;
      // Poll in short slices so close() never waits on a long idle timer.
      await delay(Math.min(remaining, 250));
    }
  }

  async #liveManifest(view, project, documentId, version, derivedViewAuthoritative) {
    const manifest = await view.get(manifestKeys.document(documentId, version));
    if (!manifest || manifest.project !== project) return undefined;
    const ordinal = await documentOrdinalLiveness(view, {
      project,
      documentId,
      version,
      authoritative: derivedViewAuthoritative,
    });
    const retired = ordinal === undefined
      || (!ordinal.authoritative && ordinal.tombstone === undefined)
      ? view.scan([KEYSPACE.SUPERSESSION, documentId, version], { limit: 1 }).length > 0
      : !ordinal.live;
    return retired ? undefined : manifest;
  }

  async #deadEntries(state) {
    // One stable snapshot and one cutover read per project audit. The previous
    // per-document snapshot setup was observable CPU work at real index size.
    return this.store.snapshot(async (view) => {
      const derivedViewAuthoritative = isDerivedViewQueryCutover(
        await view.get(derivedViewKeys.queryCutover()),
      );
      let deadEntries = 0;
      for (const identity of state.documents) {
        const separator = identity.lastIndexOf("\0");
        const documentId = identity.slice(0, separator);
        const version = Number(identity.slice(separator + 1));
        const manifest = await this.#liveManifest(
          view,
          state.project,
          documentId,
          version,
          derivedViewAuthoritative,
        );
        if (manifest) continue;
        deadEntries += state.entryCountByDocumentIdentity.get(identity) ?? 0;
      }
      return deadEntries;
    });
  }

  /**
   * Replace a viewed (immutable, mmap) index with a resident, mutable copy
   * loaded from the same snapshot. Called immediately before the first
   * mutation of a project that was opened via view(). Safe because this
   * daemon is the store's single owner and only replaces snapshots via
   * rename-over, so the file cannot change between view() and load().
   */
  #writableIndex(state) {
    if (!state.viewed) return;
    const fresh = newIndex(this.dimensions);
    fresh.load(join(state.directory, "index.usearch"));
    state.index = fresh;
    state.viewed = false;
  }

  async #persist(state) {
    if (!state.dirty || !state.index) return;
    await mkdir(state.directory, { recursive: true, mode: 0o700 });
    const suffix = `${process.pid}-${Date.now()}`;
    const temporaryIndex = join(state.directory, `index.${suffix}.tmp`);
    const temporaryMetadata = join(
      state.directory,
      `${SEMANTIC_METADATA_FILENAME}.${suffix}.tmp`,
    );
    state.index.save(temporaryIndex);
    await writeFile(temporaryMetadata, encodeSemanticMetadata({
      fingerprint: this.fingerprint,
      project: state.project,
      dimensions: this.dimensions,
      entries: [...state.entries.values()],
    }), { mode: 0o600 });
    const indexPath = join(state.directory, "index.usearch");
    const metadataPath = join(state.directory, SEMANTIC_METADATA_FILENAME);
    await rename(temporaryIndex, indexPath);
    await rename(temporaryMetadata, metadataPath);
    await rm(join(state.directory, LEGACY_SEMANTIC_METADATA_FILENAME), { force: true });
    const [metadataBytes, indexBytes] = await Promise.all([
      fileSize(metadataPath),
      fileSize(indexPath),
    ]);
    this.metadataBytes += metadataBytes - state.metadataBytes;
    this.indexBytes += indexBytes - state.indexBytes;
    state.metadataBytes = metadataBytes;
    state.indexBytes = indexBytes;
    state.dirty = false;
  }

  async #documentSpans(documentId, version) {
    return this.store.snapshot(async (view) => {
      const originalManifest = await view.get(manifestKeys.document(documentId, version));
      if (!originalManifest) return undefined;
      const manifest = await this.#liveManifest(
        view,
        originalManifest.project,
        documentId,
        version,
        isDerivedViewQueryCutover(await view.get(derivedViewKeys.queryCutover())),
      );
      // Rebuild and audit must use the same liveness predicate. Otherwise an
      // ordinal-only tombstone is re-embedded and triggers another rebuild on
      // the very next audit.
      if (!manifest) return undefined;
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
    const identityForDocument = documentIdentity(documentId, version);
    if (state.documents.has(identityForDocument)) return;
    // This document will be added below; a viewed index cannot accept adds.
    this.#writableIndex(state);
    for (let offset = 0; offset < spans.length; offset += this.batchSize) {
      const batch = spans.slice(offset, offset + this.batchSize);
      await this.backgroundGate();
      if (this.closed) return;
      const embedded = await this.#embedder().embed(
        batch.map(({ text }) => text),
        { priority: "background" },
      );
      if (embedded.dimensions !== this.dimensions
        || embedded.vectors.length !== batch.length * this.dimensions) {
        throw new Error(`Local embedding model returned incompatible ${embedded.dimensions}-dimensional vectors.`);
      }
      state.index ??= newIndex(this.dimensions);
      const labels = new BigUint64Array(batch.length);
      for (let index = 0; index < batch.length; index += 1) {
        const span = batch[index];
        const identity = vectorIdentity(
          manifest.project,
          documentId,
          version,
          span.startByte,
          span.endByte,
        );
        let salt = 0;
        let label = vectorLabel(identity, salt);
        let existing = state.entries.get(label.toString());
        while (existing
          && vectorIdentity(
            manifest.project,
            existing.documentId,
            existing.version,
            existing.startByte,
            existing.endByte,
          ) !== identity) {
          label = vectorLabel(identity, ++salt);
          existing = state.entries.get(label.toString());
        }
        labels[index] = label;
        this.entryCount += 1;
        state.entryCountByDocumentIdentity.set(
          identityForDocument,
          (state.entryCountByDocumentIdentity.get(identityForDocument) ?? 0) + 1,
        );
        state.entries.set(label.toString(), Object.freeze({
          label: label.toString(),
          documentId,
          version,
          windowOrdinal: span.windowOrdinal,
          startByte: span.startByte,
          endByte: span.endByte,
        }));
      }
      state.index.add(labels, embedded.vectors, 1);
    }
    state.documents.add(identityForDocument);
    this.documentCount += 1;
    state.dirty = true;
    await this.#persist(state);
  }

  enqueueDocument(documentId, version) {
    if (!this.enabled || this.closed || this.unavailable) return;
    this.queuedDocuments += 1;
    this.queue = this.queue
      .then(() => this.#indexDocument(documentId, version))
      .catch((error) => {
        this.unavailable = true;
        this.recordError(error);
      })
      .finally(() => {
        this.queuedDocuments -= 1;
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

  #projectManifests(project) {
    return this.store.scan([KEYSPACE.DOCUMENT])
      .map(({ payload }) => payload)
      .filter((manifest) => manifest.project === project);
  }

  async #rebuildProject(project) {
    if (this.closed || this.rebuildingProjects.has(project)) return;
    this.rebuildingProjects.add(project);
    const temporaryRoot = join(
      this.indexPath,
      `.rebuild-${digest(project, 16)}-${process.pid}-${Date.now()}`,
    );
    const rebuilt = new LocalSemanticIndex(this.store, {
      enabled: true,
      model: this.model,
      revision: this.revision,
      cachePath: this.cachePath,
      indexPath: temporaryRoot,
      dimensions: this.dimensions,
      pooling: this.pooling,
      batchSize: this.batchSize,
      candidates: this.candidates,
      minimumScore: this.minimumScore,
      compactionEnabled: false,
      backgroundGate: () => this.#waitForForegroundIdle(),
      embedder: this.#embedder(),
      recordError: this.recordError,
    });
    const enqueueCurrent = async () => {
      for (const manifest of this.#projectManifests(project)) {
        if (this.closed) return;
        await this.#waitForForegroundIdle();
        rebuilt.enqueueDocument(manifest.documentId, manifest.version);
        // Keep only one background document in flight. Interactive embeddings
        // can jump ahead between every model batch.
        await rebuilt.flush();
      }
      if (!rebuilt.status().available) {
        throw new Error(`Background semantic rebuild failed for ${project}.`);
      }
    };
    try {
      // Build a complete replacement beside the live generation. Searches
      // continue using the old mmap throughout this phase.
      await enqueueCurrent();
      if (this.closed) return;

      // Serialize only the short catch-up and generation swap with ordinary
      // semantic admissions. Canonical admission/search remain independent.
      const priorQueue = this.queue;
      const finalize = priorQueue.then(async () => {
        await enqueueCurrent();
        if (this.closed) return;
        const builtDirectory = rebuilt.projectDirectory(project);
        const targetDirectory = this.projectDirectory(project);
        const backupDirectory = `${targetDirectory}.replaced-${process.pid}-${Date.now()}`;
        let movedOld = false;
        try {
          await rename(targetDirectory, backupDirectory);
          movedOld = true;
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        try {
          if (rebuilt.status().entries === 0) {
            await rm(targetDirectory, { recursive: true, force: true });
          } else {
            await rename(builtDirectory, targetDirectory);
          }
        } catch (error) {
          if (movedOld) await rename(backupDirectory, targetDirectory).catch(() => {});
          throw error;
        }
        const currentPromise = this.states.get(project);
        const oldState = await currentPromise?.catch(() => undefined);
        if (this.states.get(project) === currentPromise) this.states.delete(project);
        if (oldState) {
          this.entryCount = Math.max(0, this.entryCount - oldState.entries.size);
          this.documentCount = Math.max(0, this.documentCount - oldState.documents.size);
          this.metadataBytes = Math.max(0, this.metadataBytes - oldState.metadataBytes);
          this.indexBytes = Math.max(0, this.indexBytes - oldState.indexBytes);
        }
        if (movedOld) await rm(backupDirectory, { recursive: true, force: true });
      });
      // A maintenance failure is reported but must not poison the admission
      // queue or mark semantic retrieval unavailable.
      this.queue = finalize.catch((error) => { this.recordError(error); });
      await finalize;
    } finally {
      await rebuilt.close().catch(() => {});
      await rm(temporaryRoot, { recursive: true, force: true });
      this.rebuildingProjects.delete(project);
    }
  }

  /**
   * Audit at most one loaded project and rebuild it only after its dead-vector
   * ratio crosses the configured threshold. Timer callers do not await this;
   * tests and orderly shutdown may.
   */
  maintain() {
    if (!this.enabled || !this.compactionEnabled || this.closed) return Promise.resolve(undefined);
    if (this.compactionPromise) return this.compactionPromise;
    let work;
    work = (async () => {
      await this.#waitForForegroundIdle();
      // Never compete with initial warm-up or newly admitted documents.
      if (this.closed || this.queuedDocuments > 0) return;
      for (const statePromise of this.states.values()) {
        const state = await statePromise;
        if (!state.index || state.entries.size < this.compactionMinimumEntries) continue;
        const deadEntries = await this.#deadEntries(state);
        if (deadEntries / state.entries.size < this.compactionDeadRatio) continue;
        await this.#rebuildProject(state.project);
        return;
      }
    })().catch((error) => {
      if (!this.closed) this.recordError(error);
    }).finally(() => {
      if (this.compactionPromise === work) this.compactionPromise = undefined;
    });
    this.compactionPromise = work;
    return work;
  }

  async search(request) {
    if (!this.enabled || this.closed || this.unavailable || request.query.trim().length === 0) return [];
    this.lastForegroundAt = Date.now();
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
          Math.min(state.index.size(), this.candidates * (4 ** attempt)),
          1,
        );
        const target = request.limit * 3 - results.length;
        const resolvedMatches = await this.store.snapshot(async (view) => {
          const resolved = [];
          let accepted = 0;
          const derivedViewAuthoritative = isDerivedViewQueryCutover(
            await view.get(derivedViewKeys.queryCutover()),
          );
          for (let index = 0; index < matches.keys.length; index += 1) {
            const label = matches.keys[index];
            const entry = state.entries.get(label.toString());
            if (!entry) continue;
            if (state.retiredLabels.has(entry.label)) {
              resolved.push(Object.freeze({ entry, retired: true }));
              continue;
            }
            const manifest = await this.#liveManifest(
              view,
              request.project,
              entry.documentId,
              entry.version,
              derivedViewAuthoritative,
            );
            if (!manifest) {
              resolved.push(Object.freeze({ entry, retired: true }));
              continue;
            }
            if (!eligible(manifest, request)) continue;
            const score = Math.max(0, Math.min(1, 1 - matches.distances[index]));
            if (score < this.minimumScore) continue;
            if (returned.has(entry.label)) continue;
            const selected = await readDocumentRange(
              view,
              manifest,
              entry.startByte,
              entry.endByte,
              { adjustUtf8: true },
            );
            if (selected.startByte !== entry.startByte || selected.endByte !== entry.endByte) {
              throw new Error("Semantic metadata range does not match canonical UTF-8 boundaries.");
            }
            resolved.push(Object.freeze({
              entry,
              manifest,
              score,
              text: selected.text,
            }));
            accepted += 1;
            if (accepted >= target) break;
          }
          return resolved;
        });
        let retiredFound = 0;
        for (const resolved of resolvedMatches) {
          const { entry } = resolved;
          if (resolved.retired === true) {
            // usearch remove()+save() preserves graph tombstones and the
            // pinned native build can segfault while loading such a snapshot.
            // Filter in memory and let the background generation rebuild
            // reclaim it without ever mutating the live ANN file.
            state.retiredLabels.add(entry.label);
            retiredFound += 1;
            continue;
          }
          if (returned.has(entry.label)) continue;
          returned.add(entry.label);
          results.push({
            ...entry,
            kind: resolved.manifest.kind,
            createdAt: resolved.manifest.createdAt,
            sessionId: resolved.manifest.sessionId,
            sourceMessageKeys: resolved.manifest.sourceMessageKeys,
            text: resolved.text,
            project: request.project,
            score: resolved.score,
          });
          if (results.length >= request.limit * 3) break;
        }
        if (retiredFound === 0) break;
      }
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
      dimensions: this.dimensions,
      pooling: this.pooling,
      entries: this.entryCount,
      documents: this.documentCount,
      queuedDocuments: this.queuedDocuments,
      metadataBytes: this.metadataBytes,
      indexBytes: this.indexBytes,
    };
  }

  async flush() {
    await this.queue;
  }

  /**
   * Drop one project's vectors from memory and disk.
   *
   * Retiring a project's documents only reaches the canonical keyspaces; the
   * embeddings live in their own on-disk index that no keyspace sweep touches,
   * so a project purged everywhere else keeps its vectors indefinitely.
   * Tolerates a project that was never indexed, so a caller can invoke it for
   * every purge without first asking whether one exists.
   */
  async removeProject(project) {
    if (typeof project !== "string" || project.length === 0) {
      throw new TypeError("removeProject requires a non-empty project.");
    }
    // Settle queued indexing first: an in-flight persist for this project
    // would otherwise recreate the directory right after it is removed.
    await this.queue?.catch(() => {});
    const pending = this.states.get(project);
    this.states.delete(project);
    if (pending !== undefined) {
      const state = await pending.catch(() => undefined);
      if (state !== undefined) {
        this.documentCount = Math.max(0, this.documentCount - state.documents.size);
      }
    }
    await rm(this.projectDirectory(project), { recursive: true, force: true });
  }

  async close() {
    this.closed = true;
    if (this.compactionTimer) clearInterval(this.compactionTimer);
    await this.queue.catch(() => {});
    await this.compactionPromise?.catch(() => {});
    if (this.ownsEmbedder) await this.embedder?.close();
  }
}
