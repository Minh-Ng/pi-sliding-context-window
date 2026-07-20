import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { StoreClient } from "../src/store-client.js";
import { ensureSecureSocketDirectory, defaultSocketPath } from "../src/daemon/paths.js";
import { STORE_PROTOCOL_VERSION, STORE_SCHEMA_VERSION } from "../src/store-protocol.js";

// Simulates a still-running daemon that predates alias-widened reads: its
// handshake schema has no aliasProjects field, so it rejects any handshake
// that declares one with INVALID_REQUEST at $.aliasProjects, exactly like the
// real schema's `additionalProperties: false` would during a rolling upgrade.
function startPreAliasDaemonFixture(socketPath) {
  const handshakes = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = buffer.slice(0, newlineIndex);
      const handshake = JSON.parse(line);
      handshakes.push(handshake);
      if (Object.hasOwn(handshake, "aliasProjects")) {
        socket.write(`${JSON.stringify({
          protocolVersion: STORE_PROTOCOL_VERSION,
          type: "handshake-ack",
          accepted: false,
          error: {
            code: "INVALID_REQUEST",
            message: "$.aliasProjects: is not an allowed field",
            retryable: false,
            details: { path: "$.aliasProjects" },
          },
        })}\n`);
        socket.end();
        return;
      }
      socket.write(`${JSON.stringify({
        protocolVersion: STORE_PROTOCOL_VERSION,
        type: "handshake-ack",
        accepted: true,
        serverVersion: "pre-alias-fixture",
        schemaVersion: STORE_SCHEMA_VERSION,
        processId: process.pid,
        storePath: "/tmp/pre-alias-fixture-store",
        capabilities: [],
      })}\n`);
    });
  });
  return { server, handshakes };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "store-client-alias-fallback-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = defaultSocketPath(storePath);
  ensureSecureSocketDirectory(socketPath);
  return { directory, socketPath };
}

test("falls back to a canonical-only handshake when a still-live daemon rejects aliasProjects", async (t) => {
  const { directory, socketPath } = fixture();
  const { server, handshakes } = startPreAliasDaemonFixture(socketPath);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new StoreClient({
    socketPath,
    project: "/repo/canonical",
    aliasProjects: ["/repo/symlink"],
  });
  t.after(() => client.close());

  const server1 = await client.connect();
  assert.equal(server1.accepted, true, "the retried handshake must still be accepted");
  assert.equal(client.aliasHandshakeRejected, true);
  assert.equal(handshakes.length, 2, "the client must retry once, without aliasProjects");
  assert.ok(Object.hasOwn(handshakes[0], "aliasProjects"), "the first attempt declares the alias");
  assert.ok(!Object.hasOwn(handshakes[1], "aliasProjects"), "the retry omits aliasProjects entirely");
  assert.equal(handshakes[1].project, "/repo/canonical", "the canonical project is never dropped");
});

test("remembers the rejection so a later reconnect skips straight to the canonical-only handshake", async (t) => {
  const { directory, socketPath } = fixture();
  const { server, handshakes } = startPreAliasDaemonFixture(socketPath);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const client = new StoreClient({
    socketPath,
    project: "/repo/canonical",
    aliasProjects: ["/repo/symlink"],
  });
  t.after(() => client.close());

  await client.connect();
  assert.equal(handshakes.length, 2);

  // Force a fresh connection (the fixture ends the socket after a successful
  // handshake-ack is not the case here, so simulate a drop explicitly).
  client.socket.destroy();
  await new Promise((resolve) => client.socket.once("close", resolve));
  await client.connect();

  assert.equal(handshakes.length, 3, "the reconnect must not repeat the doomed aliasProjects attempt");
  assert.ok(!Object.hasOwn(handshakes[2], "aliasProjects"));
});
