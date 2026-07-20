function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function safeInteger(value, label) {
  if (!Number.isSafeInteger(value)) throw new TypeError(`${label} must be a safe integer.`);
  return value;
}

export function createWatchdogState(heartbeat, now) {
  return Object.freeze({
    heartbeat: safeInteger(heartbeat, "heartbeat"),
    heartbeatAt: nonNegativeInteger(now, "now"),
    inspectedAt: now,
    stallReported: false,
  });
}

export function inspectWatchdogState(state, {
  heartbeat,
  now,
  stallThresholdMs,
  maxInspectionGapMs,
}) {
  safeInteger(heartbeat, "heartbeat");
  nonNegativeInteger(now, "now");
  nonNegativeInteger(stallThresholdMs, "stallThresholdMs");
  nonNegativeInteger(maxInspectionGapMs, "maxInspectionGapMs");
  const inspectionGapMs = now - state.inspectedAt;
  if (inspectionGapMs < 0 || inspectionGapMs > maxInspectionGapMs) {
    return Object.freeze({
      state: createWatchdogState(heartbeat, now),
      event: Object.freeze({ type: "inspection-gap", inspectionGapMs }),
    });
  }
  if (heartbeat !== state.heartbeat) {
    return Object.freeze({
      state: Object.freeze({
        heartbeat,
        heartbeatAt: now,
        inspectedAt: now,
        stallReported: false,
      }),
    });
  }
  const stallMs = now - state.heartbeatAt;
  const report = stallMs >= stallThresholdMs && !state.stallReported;
  return Object.freeze({
    state: Object.freeze({
      ...state,
      inspectedAt: now,
      stallReported: state.stallReported || report,
    }),
    ...(report ? { event: Object.freeze({ type: "stall", stallMs }) } : {}),
  });
}
