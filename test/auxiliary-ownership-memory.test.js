import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const fixture = new URL("../test-support/status-memory-child.js", import.meta.url);
const DOCUMENT_COUNT = 80;
const MAX_DAEMON_RSS_BYTES = 256 * 1_024 * 1_024;

function runFixture(args) {
  return spawnSync(process.execPath, ["--expose-gc", fixture.pathname, ...args], {
    encoding: "utf8",
    maxBuffer: 1 * 1_024 * 1_024,
    timeout: 120_000,
  });
}

test("metadata-heavy legacy ownership upgrade stays below the daemon RSS gate", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-ownership-memory-"));
  const storePath = join(directory, "archive.rocks");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const setup = runFixture(["setup-ownership", storePath, String(DOCUMENT_COUNT)]);
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const measured = runFixture(["measure-ownership", storePath, String(DOCUMENT_COUNT)]);
  assert.equal(measured.status, 0, measured.stderr || measured.stdout);
  const result = JSON.parse(measured.stdout);
  assert.equal(result.state.status, "complete");
  assert.equal(result.state.indexedOwners, DOCUMENT_COUNT);
  assert.equal(
    result.peakRss <= MAX_DAEMON_RSS_BYTES,
    true,
    `peak RSS ${result.peakRss} exceeded ${MAX_DAEMON_RSS_BYTES}: ${JSON.stringify(result)}`,
  );
});
