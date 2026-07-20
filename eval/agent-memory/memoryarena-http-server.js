#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Archive } from "../../src/archive/archive.js";
import { ArchiveAgentMemoryAdapter } from "./compatibility.js";

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;

function parseArguments(argv) {
  const options = { host: "127.0.0.1", port: 0 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--host") options.host = argv[++index];
    else if (argument === "--port") options.port = Number(argv[++index]);
    else if (argument === "--db") options.dbPath = resolve(argv[++index]);
    else if (argument === "--ready-file") options.readyFile = resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.dbPath) throw new Error("--db is required");
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return options;
}

function json(response, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "content-length": bytes.length,
  });
  response.end(bytes);
}

async function requestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw Object.assign(new Error("Request body is too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("body must be an object");
    return value;
  } catch (error) {
    throw Object.assign(new Error(`Invalid JSON body: ${error.message}`), { statusCode: 400 });
  }
}

function requiredString(body, field) {
  const value = typeof body[field] === "string" ? body[field].trim() : "";
  if (!value) throw Object.assign(new Error(`${field} must be a non-empty string`), { statusCode: 422 });
  return value;
}

export async function startMemoryArenaServer({
  archive,
  host = "127.0.0.1",
  port = 0,
} = {}) {
  if (!archive) throw new Error("archive is required");
  const users = new Map();
  let generation = 0;
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/openapi.json") {
        json(response, 200, {
          openapi: "3.1.0",
          info: { title: "Context Window MemoryArena Server", version: "1" },
          paths: {
            "/memory/initialize": { post: {} },
            "/memory/add": { post: {} },
            "/memory/wrap_user_prompt": { post: {} },
          },
        });
        return;
      }
      if (request.method !== "POST") {
        json(response, 404, { detail: "Not found" });
        return;
      }
      const body = await requestJson(request);
      const userId = requiredString(body, "user_id");
      const memorySystemName = requiredString(body, "memory_system_name");
      if (request.url === "/memory/initialize") {
        if (memorySystemName !== "context-window") {
          json(response, 400, { detail: `Unsupported memory_system: ${memorySystemName}` });
          return;
        }
        generation += 1;
        users.set(userId, {
          name: memorySystemName,
          adapter: new ArchiveAgentMemoryAdapter(archive, {
            project: "/benchmark/memoryarena",
            sessionId: `memoryarena:${userId}:${generation}`,
          }),
        });
        json(response, 200, { status: "ok", user_id: userId, memory_system_name: memorySystemName });
        return;
      }
      const entry = users.get(userId);
      if (!entry) {
        json(response, 404, { detail: "User not initialized" });
        return;
      }
      if (entry.name !== memorySystemName) {
        json(response, 400, { detail: "Mismatched memory_system for user" });
        return;
      }
      if (request.url === "/memory/add") {
        const chunk = requiredString(body, "chunk");
        const admitted = entry.adapter.addChunk(chunk);
        json(response, 200, { status: "ok", user_id: userId, response: admitted });
        return;
      }
      if (request.url === "/memory/wrap_user_prompt") {
        const question = requiredString(body, "question");
        const prompt = entry.adapter.wrapUserPrompt(question);
        json(response, 200, { status: "ok", user_id: userId, prompt });
        return;
      }
      json(response, 404, { detail: "Not found" });
    } catch (error) {
      json(response, error.statusCode ?? 500, { detail: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  return {
    server,
    address: server.address(),
    close: () => new Promise((resolveClose, rejectClose) =>
      server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  mkdirSync(dirname(options.dbPath), { recursive: true });
  const archive = new Archive(options.dbPath, {
    retention: {
      maxBytes: 256 * 1_024 * 1_024,
      targetBytes: 192 * 1_024 * 1_024,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  const running = await startMemoryArenaServer({ archive, host: options.host, port: options.port });
  const ready = {
    host: options.host,
    port: running.address.port,
    baseUrl: `http://${options.host}:${running.address.port}`,
    processId: process.pid,
  };
  if (options.readyFile) {
    mkdirSync(dirname(options.readyFile), { recursive: true });
    writeFileSync(options.readyFile, `${JSON.stringify(ready)}\n`);
  }
  console.log(JSON.stringify(ready));
  const stop = async () => {
    try { await running.close(); } finally { archive.close(); }
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => void stop().finally(() => process.exit(0)));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
