#!/usr/bin/env node
import { appendDaemonLog } from "../src/daemon/log-file.js";

const [path, prefix = "writer", countText = "100", maxBytesText = "4096"] = process.argv.slice(2);
const count = Number(countText);
const maxBytes = Number(maxBytesText);
for (let index = 0; index < count; index += 1) {
  appendDaemonLog(path, {
    timestamp: new Date().toISOString(),
    processId: process.pid,
    event: `${prefix}-${index}`,
    payload: "bounded concurrent detail",
  }, { maxBytes });
}
