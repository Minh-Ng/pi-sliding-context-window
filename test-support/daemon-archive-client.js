#!/usr/bin/env node
import { DaemonArchive } from "../src/daemon-archive.js";

const [storePath, socketPath, project] = process.argv.slice(2);
if (!storePath || !socketPath || !project) throw new Error("storePath, socketPath, and project are required.");

let archive;
try {
  archive = new DaemonArchive({
    storePath,
    socketPath,
    project,
    requestTimeoutMs: 10_000,
    daemonStartTimeoutMs: 10_000,
  });
  process.stdout.write(`${JSON.stringify(archive.stats())}\n`);
} finally {
  archive?.close({ releaseProtection: false });
}
