import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startMemoryArenaServer } from "../eval/agent-memory/memoryarena-http-server.js";
import { Archive } from "../src/archive/archive.js";

async function post(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("MemoryArena HTTP lifecycle returns bounded isolated archive context", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "context-window-memoryarena-http-"));
  const archive = new Archive(join(directory, "archive.db"), {
    retention: {
      maxBytes: 64 * 1_024 * 1_024,
      targetBytes: 48 * 1_024 * 1_024,
      recentProtectionMs: 0,
      minimumTurnsPerSession: 0,
    },
  });
  const running = await startMemoryArenaServer({ archive });
  t.after(async () => {
    await running.close();
    archive.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const baseUrl = `http://127.0.0.1:${running.address.port}`;
  const openapi = await fetch(`${baseUrl}/openapi.json`);
  assert.equal(openapi.status, 200);

  for (const userId of ["left", "right"]) {
    const initialized = await post(baseUrl, "/memory/initialize", {
      user_id: userId,
      memory_system_name: "context-window",
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.status, "ok");
  }
  await post(baseUrl, "/memory/add", {
    user_id: "left",
    memory_system_name: "context-window",
    chunk: "Bob lives in Boston and his favorite color is teal.",
  });
  await post(baseUrl, "/memory/add", {
    user_id: "right",
    memory_system_name: "context-window",
    chunk: "Alice lives in Santa Clara and her favorite color is black.",
  });
  const left = await post(baseUrl, "/memory/wrap_user_prompt", {
    user_id: "left",
    memory_system_name: "context-window",
    question: "Where does Bob live?",
  });
  assert.equal(left.status, 200);
  assert.match(left.body.prompt, /^<memory_context>/u);
  assert.match(left.body.prompt, /Boston/u);
  assert.doesNotMatch(left.body.prompt, /Santa Clara/u);
  assert.ok(left.body.prompt.length < 2_048 * 4);

  const wrongSystem = await post(baseUrl, "/memory/add", {
    user_id: "left",
    memory_system_name: "mirix",
    chunk: "must not be admitted",
  });
  assert.equal(wrongSystem.status, 400);
});
