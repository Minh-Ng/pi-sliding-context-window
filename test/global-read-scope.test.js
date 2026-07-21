import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDaemonOperations } from "../src/daemon/operations.js";
import { startStoreDaemon } from "../src/daemon/server.js";
import { RocksStore } from "../src/rocksdb/store.js";
import { StoreClient } from "../src/store/store-client.js";
import {
  STORE_PROTOCOL_VERSION,
  assertHandshakeRequest,
} from "../src/store/store-protocol.js";
import {
  READ_SCOPE_ALL,
  READ_SCOPE_PROJECT,
  defaultUserSettingsPath,
  readGrantedReadScope,
} from "../src/daemon/read-scope.js";

const PROJECT_A = "/workspace/global-read-alpha";
const PROJECT_B = "/workspace/global-read-beta";

function document(project, id, sessionId, text) {
  const sourceKey = `user:${id}`;
  return {
    documentId: id,
    version: 1,
    sourceKey,
    sessionId,
    project,
    kind: "turn",
    createdAt: Date.now(),
    text,
    metadata: { turnId: `turn-${id}` },
    sourceMessageKeys: [sourceKey],
  };
}

function searchRequest(project, query, scope) {
  return {
    query,
    relation: null,
    scope,
    sessionIds: [],
    project,
    limit: 5,
    excludeVisibleSourceKeys: [],
    hintBudgetTokens: 160,
  };
}

async function runningDaemon(t, { grantAll = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "context-window-global-read-"));
  const storePath = join(directory, "archive.rocks");
  const socketPath = join(directory, "context-window.sock");
  const userSettingsPath = join(directory, "user-settings.json");
  if (grantAll) {
    writeFileSync(userSettingsPath, `${JSON.stringify({
      "context-window": { maxReadScope: "all" },
    })}\n`);
  }
  let runtime;
  const names = ["store.put", "store.get", "store.search", "store.recall"];
  const operationHandlers = Object.fromEntries(names.map((name) => [
    name,
    (payload, context) => runtime.handlers()[name](payload, context),
  ]));
  const daemon = await startStoreDaemon({
    storePath,
    socketPath,
    userSettingsPath,
    operationHandlers,
    createStore: async (path) => {
      const store = await RocksStore.open(path);
      runtime = await createDaemonOperations(store, {});
      return store;
    },
    beforeStoreClose: () => runtime?.close(),
  });
  t.after(async () => {
    await daemon.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    socketPath,
    userSettingsPath,
    runtime: () => runtime,
  };
}

async function seedBothProjects(t, socketPath, runtime) {
  const clientA = new StoreClient({ socketPath, project: PROJECT_A });
  const clientB = new StoreClient({ socketPath, project: PROJECT_B });
  t.after(() => {
    clientA.close();
    clientB.close();
  });
  const storedA = await clientA.request("store.put", {
    idempotencyKey: "global-read-put-alpha",
    document: document(PROJECT_A, "alpha-1", "session-alpha", "alpha ledger records marker ALPHAQUARTZMARK inside its own namespace"),
    retentionClass: "conversation-source",
  }, { retry: false });
  assert.equal(storedA.status, "stored");
  const storedB = await clientB.request("store.put", {
    idempotencyKey: "global-read-put-beta",
    document: document(PROJECT_B, "beta-1", "session-beta", "beta ledger records marker BETAONYXMARK inside its own namespace"),
    retentionClass: "conversation-source",
  }, { retry: false });
  assert.equal(storedB.status, "stored");
  await runtime().drainIndexUntilIdle();
  return { clientA, clientB };
}

test("without a grant, scope=all stays collapsed to the authenticated project", async (t) => {
  const { socketPath, runtime } = await runningDaemon(t);
  const { clientA } = await seedBothProjects(t, socketPath, runtime);

  const own = await clientA.request(
    "store.search",
    searchRequest(PROJECT_A, "ALPHAQUARTZMARK", "all"),
  );
  assert.equal(own.status, "resolved");
  assert.equal(own.results[0]?.documentId, "alpha-1");

  const foreign = await clientA.request(
    "store.search",
    searchRequest(PROJECT_A, "BETAONYXMARK", "all"),
  );
  assert.equal(foreign.results.length, 0);
});

test("a user-global grant widens scope=all reads but never project scope or writes", async (t) => {
  const { socketPath, runtime } = await runningDaemon(t, { grantAll: true });
  const { clientA, clientB } = await seedBothProjects(t, socketPath, runtime);

  // scope=all now reads the other project's namespace.
  const foreign = await clientA.request(
    "store.search",
    searchRequest(PROJECT_A, "BETAONYXMARK", "all"),
  );
  assert.equal(foreign.status, "resolved");
  assert.equal(foreign.results[0]?.documentId, "beta-1");

  // A cross-project result stays recallable: recall takes the granted
  // ceiling, and the signed locator still authorizes exactly one project.
  const recalled = await clientA.request("store.recall", {
    locator: foreign.results[0].locator,
    neighbors: 0,
    maxTokens: 200,
    sessionIds: [],
  });
  assert.equal(recalled.status, "resolved");
  assert.match(recalled.text, /BETAONYXMARK/);

  // The requested scope still binds: min(requested, granted) means a
  // project-scoped request never widens even under a global grant.
  const projectScoped = await clientA.request(
    "store.search",
    searchRequest(PROJECT_A, "BETAONYXMARK", "project"),
  );
  assert.equal(projectScoped.results.length, 0);

  // Writes ignore the grant: the alpha write landed only in the alpha
  // namespace, so beta's project-scoped view cannot contain it.
  const betaProjectView = await clientB.request(
    "store.search",
    searchRequest(PROJECT_B, "ALPHAQUARTZMARK", "project"),
  );
  assert.equal(betaProjectView.results.length, 0);
});

test("the grant is re-read at each handshake, so flipping the setting needs no daemon restart", async (t) => {
  const { socketPath, runtime, userSettingsPath } = await runningDaemon(t);
  const { clientA } = await seedBothProjects(t, socketPath, runtime);

  const before = await clientA.request(
    "store.search",
    searchRequest(PROJECT_A, "BETAONYXMARK", "all"),
  );
  assert.equal(before.results.length, 0);

  writeFileSync(userSettingsPath, `${JSON.stringify({
    "context-window": { maxReadScope: "all" },
  })}\n`);
  const granted = new StoreClient({ socketPath, project: PROJECT_A });
  t.after(() => granted.close());
  const after = await granted.request(
    "store.search",
    searchRequest(PROJECT_A, "BETAONYXMARK", "all"),
  );
  assert.equal(after.results[0]?.documentId, "beta-1");
});

test("a client cannot smuggle the grant through the handshake", () => {
  assert.throws(() => assertHandshakeRequest({
    protocolVersion: STORE_PROTOCOL_VERSION,
    type: "handshake",
    client: "test-client",
    clientVersion: "0.0.0",
    project: PROJECT_A,
    maxReadScope: "all",
  }));
});

test("the granted read scope is read fail-closed from the user-global settings file only", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-read-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "settings.json");

  assert.equal(await readGrantedReadScope(path), READ_SCOPE_PROJECT);

  writeFileSync(path, `${JSON.stringify({ "context-window": { maxReadScope: "all" } })}\n`);
  assert.equal(await readGrantedReadScope(path), READ_SCOPE_ALL);

  writeFileSync(path, `${JSON.stringify({ "context-window": { maxReadScope: "everything" } })}\n`);
  assert.equal(await readGrantedReadScope(path), READ_SCOPE_PROJECT);

  writeFileSync(path, "{not json");
  assert.equal(await readGrantedReadScope(path), READ_SCOPE_PROJECT);

  // The default grant location is the user-global Pi settings file — the one
  // place repository content cannot write.
  assert.match(defaultUserSettingsPath(), /\.pi\/agent\/settings\.json$/u);
});
