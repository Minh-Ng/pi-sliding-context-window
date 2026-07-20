import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Canonical archive project identity for a working directory.
 *
 * Archive records are logically partitioned by project identity, so the same
 * repository reached through a symlink or an alternate path spelling must resolve
 * to one namespace rather than silently forking into a second. Symlinks and
 * `.`/`..` segments are resolved through the real filesystem path, so a distinct
 * real directory always keeps a distinct identity and two genuinely different
 * projects can never collapse. Any resolution failure (missing path, permission,
 * non-absolute input) falls back to the literal input so partitioning degrades to
 * the historical exact-string behavior instead of inventing a new namespace.
 */
export function canonicalProjectId(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return cwd;
  try {
    return realpathSync.native(isAbsolute(cwd) ? cwd : resolve(cwd));
  } catch {
    return cwd;
  }
}

/**
 * The literal spelling to carry as a read-compatibility alias when it differs
 * from the canonical identity. Archives written under a pre-canonical spelling
 * (symlink, alternate case, trailing slash) remain keyed by that spelling; the
 * alias lets the daemon widen reads back over them without moving canonical
 * records. Returns undefined when canonicalization is a no-op, so an
 * already-canonical project contributes no alias.
 */
export function projectIdentityAlias(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return undefined;
  return canonicalProjectId(cwd) === cwd ? undefined : cwd;
}
