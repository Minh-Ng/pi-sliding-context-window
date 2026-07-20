#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const fileIndex = process.argv.indexOf("-file");
if (fileIndex < 0 || !process.argv[fileIndex + 1]) process.exit(2);
const bytesIndex = process.argv.indexOf("--bytes");
const requestedBytes = bytesIndex < 0 ? 0 : Number(process.argv[bytesIndex + 1]);
const padding = Number.isSafeInteger(requestedBytes) && requestedBytes > 0
  ? "x".repeat(requestedBytes)
  : "";
writeFileSync(
  process.argv[fileIndex + 1],
  `${padding}\nsampled process ${process.argv[fileIndex - 3]}\n`,
  { encoding: "utf8", mode: 0o600 },
);
