import assert from "node:assert/strict";
import test from "node:test";
import {
  automaticRecallScope,
  explicitRecallScope,
  parseRecallScope,
  RECALL_SCOPE_VALUES,
} from "../src/retrieval/recall-scope.js";

test("recall scope accepts only the four configured modes", () => {
  assert.deepEqual(RECALL_SCOPE_VALUES, ["auto", "session", "project", "all"]);
  for (const scope of RECALL_SCOPE_VALUES) assert.equal(parseRecallScope(scope), scope);
  for (const value of [undefined, null, "", "global", "PROJECT"]) {
    assert.equal(parseRecallScope(value), undefined);
  }
});

test("automatic recall defaults to project and honors forced boundaries", () => {
  assert.equal(automaticRecallScope(undefined), "project");
  assert.equal(automaticRecallScope("auto"), "project");
  assert.equal(automaticRecallScope("session"), "session");
  assert.equal(automaticRecallScope("project"), "project");
  assert.equal(automaticRecallScope("all"), "all");
});

test("auto explicit recall follows a continuity marker but is otherwise session-local", () => {
  assert.equal(explicitRecallScope(), "session");
  assert.equal(explicitRecallScope({ configuredScope: "auto" }), "session");
  assert.equal(explicitRecallScope({
    configuredScope: "auto",
    automaticRetrieval: { outcome: "continuity-marker", scope: "project" },
  }), "project");
  assert.equal(explicitRecallScope({
    requestedScope: "auto",
    automaticRetrieval: { outcome: "continuity-marker", scope: "all" },
  }), "all");
  assert.equal(explicitRecallScope({
    automaticRetrieval: { outcome: "historical-snippet", scope: "project" },
  }), "session");
  assert.equal(explicitRecallScope({
    automaticRetrieval: { outcome: "continuity-marker", scope: "invalid" },
  }), "session");
});

test("configured and per-call scope overrides remain deterministic", () => {
  for (const scope of ["session", "project", "all"]) {
    assert.equal(explicitRecallScope({ configuredScope: scope }), scope);
  }
  assert.equal(explicitRecallScope({ configuredScope: "project", requestedScope: "session" }), "session");
  assert.equal(explicitRecallScope({ configuredScope: "session", requestedScope: "project" }), "project");
  assert.equal(explicitRecallScope({ configuredScope: "all", requestedScope: "auto" }), "all");
});
