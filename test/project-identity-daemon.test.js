import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DaemonArchive } from "../src/archive/daemon-archive.js";
import { defaultSocketPath } from "../src/daemon/paths.js";
import { canonicalProjectId } from "../src/identity/project-identity.js";
import { StoreClient } from "../src/store/store-client.js";

// Resolve the tmp base so a real repo directory created under it carries no
// symlink of its own; only the alias we add below should differ from realpath.
const BASE = realpathSync.native(mkdtempSync(join(tmpdir(), "project-identity-daemon-")));

function processExists(processId) {
  if (!Number.isSafeInteger(processId)) return false;
  try {
    const state = execFileSync(
      "/bin/ps",
      ["-o", "stat=", "-p", String(processId)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // A stopped daemon may remain briefly as a zombie until its detached
    // launcher reaps it. It no longer owns the socket or RocksDB store.
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

async function waitForExit(processId, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (processExists(processId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processExists(processId);
}

async function cleanupScene(env) {
  let lifecycleError;
  for (const archive of env.archives) {
    try { archive.close({ releaseProtection: false }); } catch (error) { lifecycleError ??= error; }
  }

  const client = new StoreClient({
    socketPath: env.socketPath,
    project: env.real,
    requestTimeoutMs: 5_000,
  });
  try {
    const status = await client.request("daemon.status", {});
    assert.equal(status.processId, env.daemonProcessId, "scene must retain ownership of its original daemon");
    assert.deepEqual(
      await client.request("daemon.shutdown", { reason: "project identity test complete" }),
      { accepted: true },
    );
  } catch (error) {
    lifecycleError ??= error;
  } finally {
    client.close();
  }

  if (env.daemonProcessId && !await waitForExit(env.daemonProcessId)) {
    lifecycleError ??= new Error(`context-windowd ${env.daemonProcessId} ignored graceful test shutdown`);
    try { process.kill(env.daemonProcessId, "SIGTERM"); } catch {}
    if (!await waitForExit(env.daemonProcessId, 1_000)) {
      try { process.kill(env.daemonProcessId, "SIGKILL"); } catch {}
      await waitForExit(env.daemonProcessId, 1_000);
    }
  }

  rmSync(env.directory, { recursive: true, force: true });
  assert.equal(
    processExists(env.daemonProcessId),
    false,
    `project identity test leaked context-windowd ${env.daemonProcessId}`,
  );
  if (lifecycleError) throw lifecycleError;
}

function scene(t, prefix) {
  const directory = mkdtempSync(join(BASE, `${prefix}-`));
  const storePath = join(directory, "archive.rocks");
  const real = mkdtempSync(join(directory, "repo-"));
  const link = join(directory, "repo-symlink");
  symlinkSync(real, link, "dir");
  const env = {
    directory,
    storePath,
    socketPath: defaultSocketPath(storePath),
    real,
    link,
    archives: new Set(),
    daemonProcessId: undefined,
  };
  t.after(() => cleanupScene(env));
  return env;
}

function openArchive(env, project, aliasProjects) {
  const archive = new DaemonArchive({
    storePath: env.storePath,
    socketPath: env.socketPath,
    project,
    ...(aliasProjects ? { aliasProjects } : {}),
  });
  const processId = archive.daemonStatus().processId;
  if (env.daemonProcessId === undefined) env.daemonProcessId = processId;
  else assert.equal(processId, env.daemonProcessId, "one scene must use exactly one daemon");
  env.archives.add(archive);
  return archive;
}

function writeMarker(archive, { sessionId, project, marker, createdAt = 1_000 }) {
  const key = `user:${createdAt}::${sessionId}`;
  return archive.put({
    sessionId,
    project,
    kind: "turn",
    text: `[user] Where did we land on ${marker}?\n\n[assistant] We decided ${marker} lives in the archive.`,
    createdAt,
    metadata: {
      sourceMessageKeys: [key],
      sourceFirstKey: key,
      sourceLastKey: key,
      sourceMessageCount: 1,
    },
  });
}

test.after(() => rmSync(BASE, { recursive: true, force: true }));

test("a canonical connection recovers archives written under the pre-canonical symlink spelling", (t) => {
  const env = scene(t, "recover");
  const canonical = canonicalProjectId(env.link);
  assert.equal(canonical, env.real, "the symlink must canonicalize to the real repository");

  // A pre-fix client opened the repository through the symlink, so its archive
  // is keyed by that literal spelling.
  const legacy = openArchive(env, env.link);
  const legacyId = writeMarker(legacy, {
    sessionId: "legacy-session",
    project: env.link,
    marker: "LEGACYSYMLINKMARKER",
  });
  legacy.close({ releaseProtection: false });

  // The fixed client canonicalizes and carries the literal spelling as a
  // read-only alias.
  const fixed = openArchive(env, canonical, [env.link]);

  const detailed = fixed.searchDetailed("LEGACYSYMLINKMARKER", {
    sessionId: "current-session",
    scope: "project",
    limit: 3,
  });
  assert.equal(detailed.status, "resolved", "the legacy document must be reachable after canonicalization");
  assert.equal(detailed.results[0].documentId, legacyId);

  const recalled = fixed.recall(detailed.results[0].id, { sessionIds: ["current-session"] });
  assert.match(recalled.recalledText, /LEGACYSYMLINKMARKER/u);

  assert.equal(
    fixed.count({ scope: "project" }),
    1,
    "the unioned project count includes the legacy alias document",
  );
});

test("writes always land on the canonical identity, never the alias", (t) => {
  const env = scene(t, "writes");
  const canonical = canonicalProjectId(env.link);

  const fixed = openArchive(env, canonical, [env.link]);
  const newId = writeMarker(fixed, {
    sessionId: "current-session",
    project: canonical,
    marker: "FRESHCANONICALMARKER",
  });
  fixed.close({ releaseProtection: false });

  // A connection bound to the canonical identity with no alias sees the write.
  const canonicalReader = openArchive(env, canonical);
  // A connection bound to the bare symlink spelling (its own realpath is the
  // canonical repo, so with no alias it reads only that spelling's namespace)
  // must not see the canonical write.
  const aliasReader = openArchive(env, env.link);

  assert.equal(
    canonicalReader.search("FRESHCANONICALMARKER", { scope: "project" })[0].documentId,
    newId,
  );
  assert.equal(
    aliasReader.search("FRESHCANONICALMARKER", { scope: "project" }).length,
    0,
    "the write must not appear under the pre-canonical spelling namespace",
  );
});

test("a forged alias for a different real project is rejected and cannot cross isolation", (t) => {
  const env = scene(t, "isolation");
  const canonical = canonicalProjectId(env.link);
  const other = mkdtempSync(join(env.directory, "other-repo-"));
  assert.notEqual(canonicalProjectId(other), canonical);

  const victim = openArchive(env, other);
  writeMarker(victim, { sessionId: "victim-session", project: other, marker: "OTHERPROJECTSECRET" });
  victim.close({ releaseProtection: false });

  // This connection authenticates as the canonical repo but forges an alias for
  // an unrelated real directory. The daemon re-verifies via realpath, so the
  // forged alias never widens reads.
  const attacker = openArchive(env, canonical, [other]);

  assert.equal(
    attacker.search("OTHERPROJECTSECRET", { scope: "project" }).length,
    0,
    "a realpath-mismatched alias must never leak another project's archive",
  );
  assert.equal(attacker.count({ scope: "project" }), 0);
});

test("gather and traverse widen over the pre-canonical alias, not just search", (t) => {
  const env = scene(t, "gather-traverse");
  const canonical = canonicalProjectId(env.link);

  // Two chronologically ordered legacy turns in one session, written through the
  // pre-canonical symlink spelling.
  const legacy = openArchive(env, env.link);
  const earlierId = writeMarker(legacy, {
    sessionId: "legacy-session",
    project: env.link,
    marker: "LEGACYTRAVERSEMARKER",
    createdAt: 1_000,
  });
  writeMarker(legacy, {
    sessionId: "legacy-session",
    project: env.link,
    marker: "LEGACYTRAVERSEMARKER",
    createdAt: 2_000,
  });
  legacy.close({ releaseProtection: false });

  const fixed = openArchive(env, canonical, [env.link]);

  // gather must reach legacy anchors under the alias instead of hiding them
  // behind the (empty) canonical namespace.
  const gathered = fixed.gatherDetailed("LEGACYTRAVERSEMARKER", {
    scope: "project",
    intent: "workflow",
    limit: 3,
  });
  assert.equal(gathered.status, "resolved", "gather must reach the legacy alias documents");
  assert.ok(
    gathered.evidence.some((item) => /LEGACYTRAVERSEMARKER/u.test(item.document.recalledText)),
    "the gathered evidence must include the legacy alias content",
  );

  // A locator minted for a legacy-alias document must authorize on traverse via
  // the same alias widening, reaching its chronological neighbor.
  const detailed = fixed.searchDetailed("LEGACYTRAVERSEMARKER", {
    sessionId: "legacy-session",
    scope: "project",
    limit: 3,
  });
  const later = detailed.results.find((entry) => entry.documentId !== earlierId)
    ?? detailed.results[0];
  const traversed = fixed.traverseDetailed(later.id, {
    direction: "before",
    scope: "session",
    sessionIds: ["legacy-session"],
    limit: 5,
  });
  assert.equal(traversed.status, "resolved", "traverse must authorize the legacy-alias locator");
  assert.ok(
    traversed.results.some((candidate) => candidate.documentId === earlierId),
    "traverse must reach the earlier legacy neighbor across the alias",
  );
});

test("gather across the alias union caps pooled evidence at the request's maxEvidence, not the pooling ceiling", (t) => {
  const env = scene(t, "gather-cap");
  const canonical = canonicalProjectId(env.link);

  const legacy = openArchive(env, env.link);
  writeMarker(legacy, {
    sessionId: "legacy-session",
    project: env.link,
    marker: "GATHERCAPMARKER",
    createdAt: 1_000,
  });
  legacy.close({ releaseProtection: false });

  const fixed = openArchive(env, canonical, [env.link]);
  writeMarker(fixed, {
    sessionId: "canonical-session",
    project: canonical,
    marker: "GATHERCAPMARKER",
    createdAt: 2_000,
  });

  const gathered = fixed.gatherDetailed("GATHERCAPMARKER", {
    scope: "project",
    intent: "state",
    maxEvidence: 1,
    limit: 3,
  });
  assert.equal(gathered.status, "resolved");
  assert.equal(
    gathered.evidence.length,
    1,
    "maxEvidence:1 must cap pooled cross-alias evidence at one item, not the MAX_GATHER_EVIDENCE pooling ceiling",
  );
  assert.equal(gathered.truncated, true, "the dropped alias-union anchor must be reported as truncation");
});

test("gather across the alias union returns evidence in chronological order, not pooling rank order", (t) => {
  const env = scene(t, "gather-chrono");
  const canonical = canonicalProjectId(env.link);

  const legacy = openArchive(env, env.link);
  writeMarker(legacy, {
    sessionId: "legacy-session",
    project: env.link,
    marker: "GATHERCHRONOMARKER",
    createdAt: 1_000,
  });
  legacy.close({ releaseProtection: false });

  const fixed = openArchive(env, canonical, [env.link]);
  writeMarker(fixed, {
    sessionId: "canonical-session",
    project: canonical,
    marker: "GATHERCHRONOMARKER",
    createdAt: 3_000,
  });

  const gathered = fixed.gatherDetailed("GATHERCHRONOMARKER", {
    scope: "project",
    intent: "state",
    maxEvidence: 24,
    limit: 3,
  });
  assert.equal(gathered.status, "resolved");
  assert.equal(
    gathered.evidence.length,
    2,
    "both the canonical and legacy-alias anchors must be pooled",
  );
  assert.deepEqual(
    gathered.evidence.map((item) => item.document.createdAt),
    [1_000, 3_000],
    "merged evidence must be chronological, matching single-project gather ordering",
  );
});
