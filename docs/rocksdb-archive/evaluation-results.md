**Local aggregate verification evidence**

```json
{
  "versions": {
    "localEvidenceSchema": 1,
    "node": "24.18.0",
    "pi": "0.80.7",
    "rocksdb": "2.4.0",
    "storeSchema": 1,
    "protocol": 1
  },
  "hashes": {
    "localEvidenceSchema": "sha256:f0f9dc220b318850b29505a507a4cbed98ba31cbb694a96cdc152d279ac62053",
    "dependencyLock": "sha256:c03eb877f8f7a2c1f71696b7775906530b08d4c46cf36744ba9ca435af1dc8ea"
  },
  "counts": {
    "fullTestsPassed": 600,
    "fullTestsFailed": 0,
    "retrievalObservations": 15,
    "hintObservations": 17,
    "oversizedTestsPassed": 2,
    "piLaunchTestsPassed": 1,
    "aggregateEvidenceTestsPassed": 8,
    "modelRequests": 0,
    "sessionFiles": 0,
    "canonicalDocuments": 0,
    "outboxDepth": 0,
    "sqliteFiles": 0,
    "rawArtifacts": 0,
    "lingeringDaemons": 0,
    "requiredPathCommandsFound": 2
  },
  "durationsMilliseconds": {
    "fullCheck": 25641,
    "retrievalEvaluation": 545,
    "oversizedCompaction": 7311,
    "piLaunch": 796
  },
  "byteTotals": {
    "liveLogical": 0,
    "physicalSst": 12988,
    "estimatedLiveData": 7594,
    "pendingCompaction": 0
  },
  "exitStatuses": {
    "fullCheck": 0,
    "retrievalEvaluation": 0,
    "hintEvaluation": 0,
    "oversizedCompaction": 0,
    "piLaunch": 0,
    "typescript": 0,
    "diffCheck": 0
  },
  "gates": {
    "fullCheck": "passed",
    "retrievalEvaluation": "passed",
    "hintEvaluation": "passed",
    "oversizedCompaction": "passed",
    "offlinePiLaunch": "passed",
    "aggregateEvidenceRedaction": "passed",
    "sqliteHistoryReset": "passed",
    "rawArtifactsRemoved": "passed",
    "daemonCleanup": "passed",
    "pathTools": "passed",
    "independentReview": "passed",
    "packetFocusedTests": "passed",
    "typescript": "passed",
    "diffCheck": "passed"
  }
}
```
