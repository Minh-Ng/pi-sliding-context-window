import { DEFAULT_MAX_FRAME_BYTES, LineFramer } from "../src/daemon/framing.js";
import {
  MAX_DOCUMENT_METADATA_BYTES,
  MAX_DOCUMENT_TEXT_BYTES,
  MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT,
  MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT,
} from "../src/store-contract.js";
import { assertRequestFrame } from "../src/store-protocol.js";

if (typeof global.gc !== "function") {
  throw new Error("framing memory verifier requires --expose-gc");
}

const framer = new LineFramer();
const fragmentBytes = 64 * 1_024;
const rssSamples = [];

function sample(stage) {
  rssSamples.push({ stage, rssBytes: process.memoryUsage().rss });
}

function pushBuffer(buffer) {
  for (let offset = 0; offset < buffer.length; offset += fragmentBytes) {
    const lines = framer.push(buffer.subarray(offset, offset + fragmentBytes));
    if (lines.length !== 0) throw new Error("unexpected newline in generated request");
  }
}

function pushLiteral(value) {
  pushBuffer(Buffer.from(value, "utf8"));
}

function pushRepeated(byte, count) {
  let remaining = count;
  while (remaining > 0) {
    const length = Math.min(fragmentBytes, remaining);
    pushBuffer(Buffer.alloc(length, byte));
    remaining -= length;
  }
}

global.gc();
sample("baseline");

pushLiteral([
  '{"protocolVersion":1,"type":"request","requestId":"rss-near-cap",',
  '"operation":"store.put","payload":{"idempotencyKey":"rss-near-cap",',
  '"document":{"documentId":"rss-near-cap","version":1,"sourceKey":"rss-near-cap",',
  '"sessionId":"rss-near-cap","project":"/rss-near-cap","kind":"turn",',
  '"createdAt":1,"text":"',
].join(""));
pushRepeated(0x78, MAX_DOCUMENT_TEXT_BYTES);
pushLiteral('","metadata":{"padding":"');
pushRepeated(0x6d, MAX_DOCUMENT_METADATA_BYTES - 14);
pushLiteral('"},"sourceMessageKeys":[');
const aggregateEntries = 128;
const aggregateEntryBytes = MAX_SOURCE_MESSAGE_KEY_BYTES_PER_DOCUMENT / aggregateEntries;
for (let index = 0; index < aggregateEntries; index += 1) {
  if (index > 0) pushLiteral(",");
  pushLiteral('"');
  pushRepeated(0x73, aggregateEntryBytes);
  pushLiteral('"');
}
pushLiteral(']},"structuralMessages":[');
const structuralKeyBytes = MAX_STRUCTURAL_MESSAGE_KEY_BYTES_PER_DOCUMENT / aggregateEntries;
const structuralTextBytes = MAX_STRUCTURAL_MESSAGE_BYTES_PER_DOCUMENT / aggregateEntries;
for (let index = 0; index < aggregateEntries; index += 1) {
  if (index > 0) pushLiteral(",");
  pushLiteral(`{"messageKey":"`);
  pushRepeated(0x6b, structuralKeyBytes);
  pushLiteral(`","messageIndex":${index},"role":"user","createdAt":1,"text":"`);
  pushRepeated(0x74, structuralTextBytes);
  pushLiteral('"}');
}
pushLiteral('],"retentionClass":"conversation-source"}}');
sample("fragmented");

const [line] = framer.push(Buffer.from("\n"));
sample("materialized");
const source = line.toString("utf8");
sample("decoded");
const request = JSON.parse(source);
assertRequestFrame(request);
sample("parsed-and-validated");

// Keep every live stage reachable until after the final RSS sample.
globalThis.__framingMemoryVerifier = { line, source, request };
const baselineRssBytes = rssSamples[0].rssBytes;
const sampledPeakRssBytes = Math.max(...rssSamples.map(({ rssBytes }) => rssBytes));
const peakRssBytes = process.resourceUsage().maxRSS * 1_024;
process.stdout.write(`${JSON.stringify({
  frameBytes: line.byteLength,
  frameLimitBytes: DEFAULT_MAX_FRAME_BYTES,
  baselineRssBytes,
  peakRssBytes,
  rssDeltaBytes: peakRssBytes - baselineRssBytes,
  sampledPeakRssBytes,
  rssSamples,
})}\n`);
