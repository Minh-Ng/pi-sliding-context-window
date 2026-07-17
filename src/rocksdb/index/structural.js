import { KEYSPACE } from "../keys.js";
import { MAX_SESSION_LINEAGE_IDS } from "../../store-contract.js";
import {
  createDecisionEvidence,
  decisionMutation,
  lookupDecisionEvidence,
} from "./decisions.js";
import {
  IndexPreparationLimitError,
  MAX_STRUCTURAL_INDEX_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_INDEX_MESSAGES,
  MAX_STRUCTURAL_PREPARED_MUTATIONS,
  MAX_STRUCTURAL_SOURCE_SCAN_BYTES_PER_DOCUMENT,
  preparationLimit,
} from "../index-preparation.js";

export const STRUCTURAL_INDEX_VERSION = 1;
export const STRUCTURAL_RELATIONS = Object.freeze([
  "latest-question",
  "latest-request",
  "latest-correction",
  "latest-answer",
  "latest-decision",
]);

const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const MAX_INLINE_STRUCTURAL_TEXT_BYTES = 64 * 1_024;
const MAX_STRUCTURAL_TEXT_SHARD_BYTES = 352 * 1_024;
const STRUCTURAL_TEXT_KEYSPACE = "structural-text";
const RELATION_SCORE = Object.freeze({
  "latest-question": "questionScore",
  "latest-request": "requestScore",
  "latest-correction": "correctionScore",
  "latest-answer": "answerScore",
});

function reverseSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > MAX_SEQUENCE) {
    throw new TypeError("outboxSequence must be a non-negative safe integer.");
  }
  return MAX_SEQUENCE - sequence;
}

function queryTerms(query) {
  return [...new Set(String(query ?? "").toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])];
}

function matchesQuery(text, terms) {
  if (terms.length === 0) return true;
  const tokens = new Set(String(text ?? "").toLocaleLowerCase()
    .match(/[\p{L}\p{N}_-]{2,}/gu) ?? []);
  return terms.some((term) => tokens.has(term));
}

function resolvePublishedGeneration(store, requested) {
  const publication = store.scan([
    KEYSPACE.META,
    "published-index-generation",
  ], { limit: 1 })[0]?.payload;
  const published = publication?.generation ?? 0;
  if (!Number.isSafeInteger(published) || published < 0) {
    throw new TypeError("published generation must be a non-negative safe integer.");
  }
  if (requested === undefined) return published;
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new TypeError("generation must be a non-negative safe integer.");
  }
  if (requested > published) {
    throw new RangeError(`generation ${requested} is newer than published generation ${published}.`);
  }
  return requested;
}

function splitPostingText(text, maxBytes) {
  const bytes = Buffer.from(String(text ?? ""), "utf8");
  if (bytes.length === 0) return [{ text: "", startByte: 0, endByte: 0 }];
  const segments = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + maxBytes);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === start) throw new Error("Structural text segment cannot make UTF-8 progress.");
    segments.push({
      text: bytes.subarray(start, end).toString("utf8"),
      startByte: start,
      endByte: end,
    });
    start = end;
  }
  return segments;
}

function postingMutation(relation, posting, reversed) {
  const suffix = [posting.documentId, posting.documentVersion, posting.messageIndex];
  const payload = Object.freeze(posting);
  return Object.freeze([
    ["session", posting.project, posting.sessionId, reversed, ...suffix],
  ].map((parts) => Object.freeze({
      type: "put",
      key: [KEYSPACE.RELATION, relation, ...parts],
      kind: "structural-posting",
      payload,
      immutable: true,
    })));
}

function postingStorage(posting) {
  if (Buffer.byteLength(posting.text, "utf8") <= MAX_INLINE_STRUCTURAL_TEXT_BYTES) {
    return Object.freeze({ posting, mutations: Object.freeze([]) });
  }
  const segments = splitPostingText(posting.text, MAX_STRUCTURAL_TEXT_SHARD_BYTES);
  const storedPosting = Object.freeze({
    ...posting,
    text: "",
    textSharded: true,
    textSegmentCount: segments.length,
  });
  const mutations = segments.map(({ text, startByte, endByte }, ordinal) => Object.freeze({
    type: "put",
    key: [
      STRUCTURAL_TEXT_KEYSPACE,
      posting.documentId,
      posting.documentVersion,
      posting.messageIndex,
      ordinal,
    ],
    kind: "structural-text-shard",
    immutable: false,
    payload: {
      documentId: posting.documentId,
      documentVersion: posting.documentVersion,
      generation: posting.generation,
      messageIndex: posting.messageIndex,
      ordinal,
      startByte,
      endByte,
      text,
    },
  }));
  return Object.freeze({ posting: storedPosting, mutations: Object.freeze(mutations) });
}

function messagePosting(context, message, relation, score, location) {
  if (!location
    || !Number.isSafeInteger(location.startByte)
    || !Number.isSafeInteger(location.endByte)
    || location.startByte < 0
    || location.endByte <= location.startByte
    || location.endByte > context.manifest.byteLength) {
    throw new IndexPreparationLimitError(
      "structural-v1",
      "unresolved structural messages",
      0,
      1,
    );
  }
  return {
    structuralIndexVersion: STRUCTURAL_INDEX_VERSION,
    relation,
    relationConfidence: score,
    granularity: "message",
    legacy: false,
    project: context.manifest.project,
    sessionId: context.manifest.sessionId,
    documentId: context.manifest.documentId,
    documentVersion: context.manifest.version,
    documentKind: context.manifest.kind,
    documentCreatedAt: context.manifest.createdAt,
    messageKey: message.messageKey,
    messageIndex: message.messageIndex,
    role: message.role,
    createdAt: message.createdAt || context.manifest.createdAt,
    text: message.text,
    ...location,
    generation: context.generation,
    outboxSequence: context.outboxSequence,
  };
}

function legacyPosting(context, relation, text) {
  return {
    structuralIndexVersion: STRUCTURAL_INDEX_VERSION,
    relation,
    relationConfidence: 0,
    granularity: "document",
    legacy: true,
    project: context.manifest.project,
    sessionId: context.manifest.sessionId,
    documentId: context.manifest.documentId,
    documentVersion: context.manifest.version,
    documentKind: context.manifest.kind,
    documentCreatedAt: context.manifest.createdAt,
    messageIndex: 0,
    createdAt: context.manifest.createdAt,
    text,
    startByte: 0,
    endByte: context.manifest.byteLength,
    generation: context.generation,
    outboxSequence: context.outboxSequence,
  };
}

function prefixTable(needle) {
  const table = new Uint32Array(needle.length);
  for (let index = 1, matched = 0; index < needle.length; index += 1) {
    while (matched > 0 && needle[index] !== needle[matched]) matched = table[matched - 1];
    if (needle[index] === needle[matched]) matched += 1;
    table[index] = matched;
  }
  return table;
}

async function structuralMessageLocations(context, messages) {
  if (messages.length === 0) return new Map();
  const needles = messages.map((message) => Buffer.from(message.text ?? "", "utf8"));
  if (needles.some((needle) => needle.length === 0)) {
    throw new IndexPreparationLimitError(
      "structural-v1",
      "unresolved structural messages",
      0,
      needles.filter((needle) => needle.length === 0).length,
    );
  }

  const locations = new Map();
  let messageIndex = 0;
  let needle = needles[messageIndex];
  let table = prefixTable(needle);
  let matched = 0;
  let cursor = 0;
  const scanEndByte = Math.min(
    context.manifest.byteLength,
    MAX_STRUCTURAL_SOURCE_SCAN_BYTES_PER_DOCUMENT,
  );
  while (cursor < scanEndByte && messageIndex < messages.length) {
    const selected = await context.readSourceRange(
      cursor,
      Math.min(scanEndByte, cursor + context.sourceSegmentBytes),
      { adjustUtf8: true },
    );
    if (selected.startByte !== cursor || selected.endByte <= cursor) {
      throw new Error("Structural bounded source reader failed to make UTF-8 progress.");
    }
    const bytes = Buffer.from(selected.text, "utf8");
    for (let offset = 0; offset < bytes.length && messageIndex < messages.length; offset += 1) {
      while (matched > 0 && bytes[offset] !== needle[matched]) matched = table[matched - 1];
      if (bytes[offset] !== needle[matched]) continue;
      matched += 1;
      if (matched !== needle.length) continue;

      const endByte = selected.startByte + offset + 1;
      locations.set(messages[messageIndex], Object.freeze({
        startByte: endByte - needle.length,
        endByte,
      }));
      messageIndex += 1;
      if (messageIndex < messages.length) {
        needle = needles[messageIndex];
        table = prefixTable(needle);
        matched = 0;
      }
    }
    cursor = selected.endByte;
    if (messageIndex < messages.length) await context.yieldControl();
  }
  if (messageIndex < messages.length) {
    if (context.manifest.byteLength > MAX_STRUCTURAL_SOURCE_SCAN_BYTES_PER_DOCUMENT) {
      throw new IndexPreparationLimitError(
        "structural-v1",
        "structural source scan bytes",
        MAX_STRUCTURAL_SOURCE_SCAN_BYTES_PER_DOCUMENT,
        context.manifest.byteLength,
      );
    }
    throw new IndexPreparationLimitError(
      "structural-v1",
      "unresolved structural messages",
      0,
      messages.length - messageIndex,
    );
  }
  return locations;
}

/** IndexWorker handler for deterministic reverse structural relations. */
export function createStructuralIndexHandler() {
  return Object.freeze({
    id: "structural-v1",
    operations: ["index"],
    async prepare(context) {
      const mutations = [];
      const textStorage = new Map();
      const storePostingText = (posting) => {
        const identity = `${posting.documentId}\0${posting.documentVersion}\0${posting.messageIndex}`;
        let storage = textStorage.get(identity);
        if (storage === undefined) {
          const prepared = postingStorage(posting);
          storage = {
            sharded: prepared.posting.textSharded === true,
            textSegmentCount: prepared.posting.textSegmentCount,
          };
          textStorage.set(identity, storage);
          mutations.push(...prepared.mutations);
        }
        return storage.sharded
          ? Object.freeze({
              ...posting,
              text: "",
              textSharded: true,
              textSegmentCount: storage.textSegmentCount,
            })
          : posting;
      };
      const reversed = reverseSequence(context.outboxSequence);
      const messages = Array.isArray(context.manifest.structuralMessages)
        ? context.manifest.structuralMessages
        : [];
      const indexedMessages = [];
      let indexedMessageBytes = 0;
      // A decision emits at most three scope mutations; a legacy turn emits
      // four relation mutations. Reserving those fixed outputs keeps this
      // preflight conservative without constructing the mutation array.
      let preparedMutationEstimate = context.manifest.kind === "decision-candidate"
        ? 3
        : (messages.length === 0 && context.manifest.kind === "turn" ? 4 : 0);
      let relevantMessages = 0;
      for (const message of messages) {
        const bytes = Buffer.byteLength(message.text ?? "", "utf8");
        const relationCount = Object.keys(RELATION_SCORE)
          .filter((relation) => {
            const score = Number(message[RELATION_SCORE[relation]] ?? 0);
            return Number.isFinite(score) && score > 0;
          }).length;
        if (relationCount === 0) continue;
        relevantMessages += 1;
        preparationLimit(
          "structural-v1",
          "structural messages",
          MAX_STRUCTURAL_INDEX_MESSAGES,
          relevantMessages,
        );
        preparationLimit(
          "structural-v1",
          "indexed structural bytes",
          MAX_STRUCTURAL_INDEX_BYTES_PER_DOCUMENT,
          indexedMessageBytes + bytes,
        );
        // Posting text is sharded once per message and then shared by all of
        // that message's relation postings.
        const textShardCount = bytes > MAX_INLINE_STRUCTURAL_TEXT_BYTES
          ? Math.ceil(bytes / MAX_STRUCTURAL_TEXT_SHARD_BYTES)
          : 0;
        preparedMutationEstimate += relationCount + textShardCount;
        preparationLimit(
          "structural-v1",
          "prepared structural mutations",
          MAX_STRUCTURAL_PREPARED_MUTATIONS,
          preparedMutationEstimate,
        );
        indexedMessages.push(message);
        indexedMessageBytes += bytes;
      }
      const messageLocations = await structuralMessageLocations(context, indexedMessages);
      let boundedDocumentText;
      if ((messages.length === 0 && context.manifest.kind === "turn")
        || context.manifest.kind === "decision-candidate") {
        if (context.manifest.byteLength <= MAX_INLINE_STRUCTURAL_TEXT_BYTES) {
          boundedDocumentText = (await context.readSourceRange(
            0,
            context.manifest.byteLength,
          )).text;
        }
      }
      for (const [relation, field] of Object.entries(RELATION_SCORE)) {
        let emitted = 0;
        for (const message of indexedMessages) {
          const score = Number(message[field] ?? 0);
          if (!Number.isFinite(score) || score <= 0) continue;
          mutations.push(...postingMutation(
            relation,
            storePostingText(messagePosting(
              context,
              message,
              relation,
              Math.min(100, Math.max(0, score)),
              messageLocations.get(message),
            )),
            reversed,
          ));
          emitted += 1;
        }
        if (messages.length === 0 && context.manifest.kind === "turn"
          && boundedDocumentText !== undefined) {
          mutations.push(...postingMutation(
            relation,
            storePostingText(legacyPosting(context, relation, boundedDocumentText)),
            reversed,
          ));
        }
      }
      const decision = boundedDocumentText === undefined
        ? undefined
        : createDecisionEvidence({
            manifest: context.manifest,
            text: boundedDocumentText,
            generation: context.generation,
            outboxSequence: context.outboxSequence,
          });
      mutations.push(...decisionMutation(decision, reversed));
      return {
        mutations,
        metadata: {
          postings: mutations.length,
          structuralMessages: messages.length,
          indexedStructuralMessages: indexedMessages.length,
          decision: Boolean(decision),
        },
      };
    },
  });
}

function scoped(posting, { project, lineage, scope, generation, store }) {
  if (posting.generation > generation) return false;
  if (store.scan([
    KEYSPACE.SUPERSESSION,
    posting.documentId,
    posting.documentVersion,
  ], { limit: 1 }).length > 0) return false;
  if (scope === "all") return true;
  if (project && posting.project !== project) return false;
  if (scope === "session" && !lineage.includes(posting.sessionId)) return false;
  return true;
}

function structuralRecords(store, { relation, project, lineage, scope, scanLimit }) {
  if (scope === "session") {
    return lineage.flatMap((lineageSessionId) => store.scan([
      KEYSPACE.RELATION,
      relation,
      "session",
      project,
      lineageSessionId,
    ], { limit: scanLimit }));
  }
  if (scope === "project") {
    return store.scan([KEYSPACE.RELATION, relation, "session", project], { limit: scanLimit });
  }
  return store.scan([KEYSPACE.RELATION, relation, "session"], { limit: scanLimit });
}

function postingTextSegments(store, posting) {
  if (posting.textSharded !== true) {
    return [{
      text: posting.text,
      startByte: 0,
      endByte: Buffer.byteLength(posting.text, "utf8"),
    }];
  }
  const prefix = [
    STRUCTURAL_TEXT_KEYSPACE,
    posting.documentId,
    posting.documentVersion,
    posting.messageIndex,
  ];
  const segments = [];
  let after;
  for (;;) {
    const page = store.scan(prefix, {
      limit: 1_000,
      ...(after === undefined ? {} : { after }),
    });
    segments.push(...page.map(({ payload }) => ({
      text: payload.text,
      startByte: payload.startByte,
      endByte: payload.endByte,
    })));
    if (page.length < 1_000) break;
    after = page.at(-1).keyBytes;
  }
  if (segments.length !== posting.textSegmentCount) {
    throw new Error(`Structural text shards for ${posting.documentId} are incomplete.`);
  }
  return segments;
}

function result(posting, lineage) {
  const depth = lineage.indexOf(posting.sessionId);
  return Object.freeze({
    id: posting.documentId,
    documentId: posting.documentId,
    version: posting.documentVersion,
    sessionId: posting.sessionId,
    project: posting.project,
    kind: posting.documentKind,
    createdAt: posting.documentCreatedAt,
    snippet: posting.text,
    score: posting.relationConfidence,
    structural: Object.freeze({
      relation: posting.relation,
      granularity: posting.granularity,
      messageKey: posting.messageKey,
      messageIndex: posting.messageIndex,
      role: posting.role,
      createdAt: posting.createdAt,
      relationConfidence: posting.relationConfidence,
      lineageDepth: depth < 0 ? 0 : depth,
      documentSequence: posting.outboxSequence,
      generation: posting.generation,
      legacy: posting.legacy,
      ...(Number.isSafeInteger(posting.snippetStartByte)
        && Number.isSafeInteger(posting.snippetEndByte)
        ? {
            startByte: posting.snippetStartByte,
            endByte: posting.snippetEndByte,
          }
        : {}),
    }),
  });
}

/** Resolve one supported relation with legacy and lineage ambiguity labels. */
export function lookupStructural(store, {
  relation,
  query = "",
  sessionId,
  sessionIds = sessionId ? [sessionId] : [],
  project,
  scope = "session",
  generation,
  limit = 3,
  scanLimit = 10_000,
} = {}) {
  if (!store || typeof store.scan !== "function") {
    throw new TypeError("lookupStructural requires a RocksStore-compatible store.");
  }
  if (!["session", "project", "all"].includes(scope)) {
    throw new TypeError("scope must be session, project, or all.");
  }
  if (!STRUCTURAL_RELATIONS.includes(relation)) {
    return Object.freeze({ mode: "structural", relation, status: "not-found", results: [], candidates: [] });
  }
  const boundedLimit = Math.min(100, Math.max(1, Number(limit) || 3));
  const lineage = [...new Set(sessionIds.filter(Boolean).map(String))];
  if (lineage.length > MAX_SESSION_LINEAGE_IDS) {
    throw new RangeError(`sessionIds must contain at most ${MAX_SESSION_LINEAGE_IDS} unique IDs.`);
  }
  if (scope === "session" && lineage.length === 0) {
    throw new TypeError("Session-scoped structural lookup requires sessionId or sessionIds.");
  }
  if (scope !== "all" && (typeof project !== "string" || project.length === 0)) {
    throw new TypeError("Scoped structural lookup requires project.");
  }
  const resolvedGeneration = resolvePublishedGeneration(store, generation);
  if (relation === "latest-decision") {
    const decisions = lookupDecisionEvidence(store, {
      query,
      project,
      sessionIds: lineage,
      scope,
      generation: resolvedGeneration,
      limit: boundedLimit,
      scanLimit,
    });
    const results = decisions.map((decision) => Object.freeze({
      id: decision.documentId,
      documentId: decision.documentId,
      version: decision.documentVersion,
      sessionId: decision.sessionId,
      project: decision.project,
      kind: "decision-candidate",
      createdAt: decision.createdAt,
      snippet: decision.excerpt,
      score: 100,
      structural: decision,
    }));
    return Object.freeze({
      mode: "structural",
      relation,
      status: results.length === 0
        ? "not-found"
        : (scope === "session" && results[0].structural.lineageDepth === 0 ? "resolved" : "ambiguous"),
      results: Object.freeze(results),
      candidates: Object.freeze(results.map(({ structural }) => structural)),
    });
  }

  const terms = queryTerms(query);
  const boundedScan = Math.min(100_000, Math.max(boundedLimit, Number(scanLimit) || 10_000));
  const postings = structuralRecords(store, {
    relation,
    project,
    lineage,
    scope,
    scanLimit: boundedScan,
  });
  const eligible = [];
  for (const { payload } of postings) {
    if (!payload || !scoped(payload, {
      project,
      lineage,
      scope,
      generation: resolvedGeneration,
      store,
    })) continue;
    const matching = postingTextSegments(store, payload)
      .find(({ text }) => matchesQuery(text, terms));
    if (matching === undefined) continue;
    const located = Number.isSafeInteger(payload.startByte)
      && Number.isSafeInteger(payload.endByte);
    eligible.push(Object.freeze({
      ...payload,
      text: matching.text,
      ...(located
        ? {
            snippetStartByte: payload.startByte + matching.startByte,
            snippetEndByte: payload.startByte + matching.endByte,
          }
        : {}),
    }));
  }
  eligible.sort((left, right) =>
    right.relationConfidence - left.relationConfidence
    || Math.max(0, lineage.indexOf(left.sessionId)) - Math.max(0, lineage.indexOf(right.sessionId))
    || right.outboxSequence - left.outboxSequence
    || right.messageIndex - left.messageIndex
    || String(left.messageKey ?? "").localeCompare(String(right.messageKey ?? "")));

  const distinct = [];
  const seen = new Set();
  for (const posting of eligible) {
    const identity = `${posting.documentId}\0${posting.documentVersion}\0${posting.messageIndex}\0${posting.relation}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    distinct.push(posting);
  }

  const modern = distinct.filter((posting) => !posting.legacy);
  const legacy = distinct.filter((posting) => posting.legacy);
  if (modern.length === 0) {
    const results = legacy.slice(0, boundedLimit).map((posting) => result(posting, lineage));
    return Object.freeze({
      mode: "structural",
      relation,
      status: results.length > 0 ? "legacy-fallback" : "not-found",
      results: Object.freeze(results),
      candidates: Object.freeze(results.map(({ structural }) => structural)),
    });
  }

  const top = modern[0];
  const newerLegacy = legacy.find((posting) => posting.outboxSequence > top.outboxSequence);
  const combined = newerLegacy
    ? [top, newerLegacy, ...modern.slice(1)]
    : modern;
  const results = combined.slice(0, boundedLimit).map((posting) => result(posting, lineage));
  const topDepth = lineage.indexOf(top.sessionId);
  const ambiguous = top.relationConfidence < 50
    || topDepth > 0
    || scope === "project"
    || scope === "all"
    || Boolean(newerLegacy);
  return Object.freeze({
    mode: "structural",
    relation,
    status: ambiguous ? "ambiguous" : "resolved",
    results: Object.freeze(results),
    candidates: Object.freeze(results.map(({ structural }) => structural)),
  });
}
