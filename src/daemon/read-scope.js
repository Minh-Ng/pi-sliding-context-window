import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Read scope is one lattice (session ⊂ project ⊂ all) with two roles: the
// per-request `scope` is chosen by the model and is untrusted; the granted
// ceiling below is operator configuration. The effective scope of any request
// is min(requested, granted).
export const READ_SCOPE_PROJECT = "project";
export const READ_SCOPE_ALL = "all";

export function defaultUserSettingsPath() {
  return join(homedir(), ".pi", "agent", "settings.json");
}

/**
 * Read the operator-granted read ceiling for this daemon.
 *
 * The grant is honored only from the user-global settings file
 * (~/.pi/agent/settings.json, `context-window.maxReadScope`). It is never
 * accepted from the client handshake and never read from a project-local
 * `.pi/settings.json`, so repository content cannot widen its own
 * authorization. Any read, parse, or shape failure fails closed to project
 * scope. Writes are unaffected by the grant: the write target is always the
 * authenticated project.
 */
export async function readGrantedReadScope(settingsPath = defaultUserSettingsPath()) {
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw);
    const namespace = parsed?.["context-window"];
    const value = typeof namespace === "object" && namespace !== null
      ? namespace.maxReadScope
      : undefined;
    return value === READ_SCOPE_ALL ? READ_SCOPE_ALL : READ_SCOPE_PROJECT;
  } catch {
    return READ_SCOPE_PROJECT;
  }
}
