#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const fileIndex = process.argv.indexOf("-file");
if (fileIndex < 0 || !process.argv[fileIndex + 1]) process.exit(2);
writeFileSync(
  process.argv[fileIndex + 1],
  `sampled process ${process.argv[fileIndex - 3]}\n`,
  { encoding: "utf8", mode: 0o600 },
);
