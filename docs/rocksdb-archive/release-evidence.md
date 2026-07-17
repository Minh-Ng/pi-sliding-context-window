**Purpose**

This procedure produces the evidence required for a release decision. The final report is an aggregate, not a benchmark runner: every component is generated and natively validated first, then the report requires one clean revision, dependency lock, Node runtime, storage schema, and protocol across the complete set.

**Evidence boundary**

Generate evidence from a committed, clean revision and write it outside the repository. The environment recorder treats any tracked or untracked repository file as dirty, so writing the first artifact under `artifacts/` would invalidate later artifacts.

```bash
npm ci
git status --porcelain=v1 --untracked-files=normal
release_evidence_dir="$(mktemp -d)"
mkdir -p \
  "$release_evidence_dir/retrieval" \
  "$release_evidence_dir/bench" \
  "$release_evidence_dir/migration" \
  "$release_evidence_dir/verification"
```

The `git status` command must print nothing. Preserve the evidence directory until the report and every referenced artifact have been reviewed.

**Required artifacts**

| Relative path | Native validator | Release claim |
|---|---|---|
| `verification/verifiers.json` | `eval/release/verifiers.js` | Required test commands exited successfully |
| `retrieval/sqlite-baseline.json` | `eval/retrieval/cli.js` | Frozen SQLite lexical baseline |
| `retrieval/rocksdb-evaluation.json` | `eval/retrieval/cli.js` | Exact, lexical, structural, and chunk gates |
| `retrieval/rocksdb-hints.json` | `eval/retrieval/cli.js` | Automatic-hint gates |
| `bench/archive-10000.json` | `bench/archive/cli.js` | Relative gates at 10 thousand windows |
| `bench/archive-100000.json` | `bench/archive/cli.js` | Relative gates at 100 thousand windows |
| `bench/archive-1000000.json` | `bench/archive/cli.js` | Relative gates at 1 million windows |
| `bench/archive-system-1000000.json` | `bench/archive/system-cli.js` | Absolute, backlog, RSS, and crash gates at 1 million windows |
| `bench/archive-retention.json` | `bench/archive/cli.js` | Physical reclamation and retained-key gate |
| `bench/archive-release.json` | `bench/archive/release-cli.js` | Strict AND of all performance artifacts |
| `migration/migration-verification.json` | Bound by rehearsal content hash | Complete SQLite-to-RocksDB parity |
| `migration/migration-rehearsal.json` | `eval/release/migration-rehearsal.js` | Pre-authority rollback and first-write authority seal |
| `release-report.json` | `eval/release/cli.js` | Strict final release decision |

Every primary JSON artifact is self-hashed. The final report records the exact byte hash and size of every source file plus the internal hash of each self-hashed artifact; the migration rehearsal likewise byte-binds its parity artifact. Copying or reformatting a component after aggregation invalidates the final report.

**1. Required test evidence**

```bash
npm run eval:release-verifiers -- \
  --output "$release_evidence_dir/verification/verifiers.json"
```

This runs `npm run test:rocksdb`, `npm run test:daemon`, `npm run test:migration`, and `npm run check` exactly once each. A failing command is recorded as failed and makes the final report fail.

**2. Retrieval and hint evidence**

```bash
npm run eval:retrieval -- \
  --artifact-directory "$release_evidence_dir/retrieval"

node eval/retrieval/cli.js \
  --backend eval/retrieval/rocksdb-backend.js \
  --suite hints \
  --output "$release_evidence_dir/retrieval/rocksdb-hints.json" \
  --require-all
```

The release gate defaults to exactly `exact,lexical,structural,chunks`, writes the canonical `sqlite-baseline.json` and `rocksdb-evaluation.json` paths, and binds the RocksDB lexical score to that exact baseline hash. `npm run eval:retrieval` uses the same defaults but writes under the repository, so release capture must provide the external artifact directory shown above. Hints remain a separate artifact and gate.

**3. Performance evidence**

```bash
npm run bench:archive -- \
  --scale 10000 --allow-partial \
  --output "$release_evidence_dir/bench/archive-10000.json"

npm run bench:archive -- \
  --scale 100000 --allow-partial \
  --output "$release_evidence_dir/bench/archive-100000.json"

npm run bench:archive -- \
  --scale 1000000 --allow-partial \
  --output "$release_evidence_dir/bench/archive-1000000.json"

npm run bench:archive:system -- \
  --scale 1000000 \
  --output "$release_evidence_dir/bench/archive-system-1000000.json"

npm run bench:archive -- \
  --retention --allow-partial \
  --output "$release_evidence_dir/bench/archive-retention.json"

npm run bench:archive:release -- \
  --comparison "$release_evidence_dir/bench/archive-10000.json" \
  --comparison "$release_evidence_dir/bench/archive-100000.json" \
  --comparison "$release_evidence_dir/bench/archive-1000000.json" \
  --system "$release_evidence_dir/bench/archive-system-1000000.json" \
  --retention "$release_evidence_dir/bench/archive-retention.json" \
  --output "$release_evidence_dir/bench/archive-release.json"
```

`--allow-partial` is valid only when producing a component whose mode intentionally cannot measure every performance gate. It does not turn a failed measured gate into success. The performance aggregate and final report have no partial-success option.

**4. Migration and rollback evidence**

```bash
npm run eval:migration-rehearsal -- \
  --output "$release_evidence_dir/migration/migration-rehearsal.json" \
  --verification-output "$release_evidence_dir/migration/migration-verification.json"
```

The rehearsal uses a disposable deterministic SQLite archive. It proves complete offline copy and verification, reads from SQLite while rollback remains eligible, performs the first RocksDB-only canonical write, confirms that the write atomically seals authority, restarts, and verifies an idempotent duplicate retry. It never points at a user archive.

**5. Final report**

```bash
npm run eval:release -- \
  --evidence-dir "$release_evidence_dir" \
  --output "$release_evidence_dir/release-report.json"
```

The command writes a report even when evidence is missing, invalid, dirty, identity-mismatched, or failed. Its exit code is zero only when every required artifact validates, every gate passes, every source file hash matches, and the report is generated from the same clean revision and dependency lock.

**Independent validation**

```bash
node eval/release/verifiers.js \
  --validate-artifact "$release_evidence_dir/verification/verifiers.json"

node eval/release/migration-rehearsal.js \
  --validate-artifact "$release_evidence_dir/migration/migration-rehearsal.json" \
  --verification-artifact "$release_evidence_dir/migration/migration-verification.json"

npm run bench:archive:release -- \
  --validate-artifact "$release_evidence_dir/bench/archive-release.json" \
  --comparison "$release_evidence_dir/bench/archive-10000.json" \
  --comparison "$release_evidence_dir/bench/archive-100000.json" \
  --comparison "$release_evidence_dir/bench/archive-1000000.json" \
  --system "$release_evidence_dir/bench/archive-system-1000000.json" \
  --retention "$release_evidence_dir/bench/archive-retention.json"

node eval/release/cli.js \
  --validate-artifact "$release_evidence_dir/release-report.json" \
  --evidence-dir "$release_evidence_dir"
```

Run `git status --porcelain=v1 --untracked-files=normal` again after capture. Any output means the evidence set is not a clean-revision release attestation.

**Decision rule**

Only `release-report.json` with `outcome: "passed"` authorizes cutover. A valid but failed report is still useful: its blocker list names missing, invalid, dirty, mismatched, unmeasured, or failed evidence without promoting partial work to a release pass.
