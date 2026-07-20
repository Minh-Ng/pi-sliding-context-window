import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDiskPressureMonitor,
  DISK_PRESSURE_CHECK_INTERVAL_MS,
  DISK_PRESSURE_WARN_BYTES,
  evaluateDiskPressure,
} from "../extensions/pi.ts";

const GIB = 1024 ** 3;

function collectingUi({ confirmAnswer } = {}) {
  const notifications = [];
  const confirms = [];
  return {
    notifications,
    confirms,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      confirm: confirmAnswer === undefined
        ? undefined
        : async (title, message) => {
            confirms.push({ title, message });
            return confirmAnswer;
          },
    },
  };
}

test("evaluateDiskPressure classifies daemon states", () => {
  assert.equal(evaluateDiskPressure(undefined), undefined);
  assert.equal(evaluateDiskPressure({}), undefined);
  assert.equal(
    evaluateDiskPressure({ emergencyMode: false, filesystem: { freeBytes: 100 * GIB } }),
    undefined,
  );
  assert.equal(
    evaluateDiskPressure({ emergencyMode: true }).severity,
    "emergency",
  );
  assert.equal(
    evaluateDiskPressure({ filesystem: { emergencyMode: true } }).severity,
    "emergency",
  );
  const approaching = evaluateDiskPressure({ filesystem: { freeBytes: 3 * GIB } });
  assert.equal(approaching.severity, "approaching");
  assert.match(approaching.message, /3\.0 GiB/u);
  // Free-bytes probe unavailable (statfs failed): no false positive.
  assert.equal(evaluateDiskPressure({ filesystem: { emergencyMode: false } }), undefined);
  assert.ok(DISK_PRESSURE_WARN_BYTES > 2 * GIB);
});

test("monitor notifies once and runs reclaim when confirmed", async () => {
  const reclaims = [];
  const monitor = createDiskPressureMonitor({
    archiveStats: () => ({ emergencyMode: true }),
    reclaim: () => {
      reclaims.push(true);
      return { status: "reclaimed", after: { reclaimableBytes: 0 } };
    },
    formatStorage: (stats) => `reclaimable=${stats.reclaimableBytes}`,
    now: () => 0,
  });
  const { ui, notifications, confirms } = collectingUi({ confirmAnswer: true });

  const pressure = await monitor.check(ui);
  assert.equal(pressure.severity, "emergency");
  assert.equal(confirms.length, 1);
  assert.equal(reclaims.length, 1);
  assert.equal(notifications.length, 2);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /NOT being archived/u);
  assert.equal(notifications[1].level, "info");
  assert.match(notifications[1].message, /reclaimed\nreclaimable=0/u);

  // Notify-once: further checks are silent even under continued pressure.
  assert.equal(await monitor.check(ui), undefined);
  assert.equal(notifications.length, 2);
});

test("monitor declining the dialog skips reclaim but keeps the warning", async () => {
  let reclaimed = false;
  const monitor = createDiskPressureMonitor({
    archiveStats: () => ({ filesystem: { freeBytes: 1 * GIB } }),
    reclaim: () => { reclaimed = true; return { status: "reclaimed" }; },
    now: () => 0,
  });
  const { ui, notifications } = collectingUi({ confirmAnswer: false });
  const pressure = await monitor.check(ui);
  assert.equal(pressure.severity, "approaching");
  assert.equal(reclaimed, false);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("monitor throttles archiveStats and never notifies in normal mode", async () => {
  let statCalls = 0;
  let clock = 0;
  const monitor = createDiskPressureMonitor({
    archiveStats: () => { statCalls += 1; return { filesystem: { freeBytes: 500 * GIB } }; },
    now: () => clock,
  });
  const { ui, notifications } = collectingUi({});
  assert.equal(await monitor.check(ui), undefined);
  assert.equal(await monitor.check(ui), undefined); // within interval → throttled
  assert.equal(statCalls, 1);
  clock += DISK_PRESSURE_CHECK_INTERVAL_MS;
  assert.equal(await monitor.check(ui), undefined);
  assert.equal(statCalls, 2);
  assert.equal(notifications.length, 0);
});

test("monitor survives archiveStats failures and dialog-incapable UIs", async () => {
  const failing = createDiskPressureMonitor({
    archiveStats: () => { throw new Error("daemon unavailable"); },
    now: () => 0,
  });
  const { ui, notifications } = collectingUi({});
  assert.equal(await failing.check(ui), undefined);
  assert.equal(notifications.length, 0);

  // No confirm hook (non-TUI): warning still fires, no crash, no reclaim.
  const monitor = createDiskPressureMonitor({
    archiveStats: () => ({ emergencyMode: true }),
    reclaim: () => { throw new Error("must not be called without confirm"); },
    now: () => 0,
  });
  const bare = collectingUi({});
  const pressure = await monitor.check(bare.ui);
  assert.equal(pressure.severity, "emergency");
  assert.equal(bare.notifications.length, 1);
});

test("reset re-arms the monitor for a new session", async () => {
  let clock = 0;
  const monitor = createDiskPressureMonitor({
    archiveStats: () => ({ emergencyMode: true }),
    now: () => clock,
  });
  const { ui, notifications } = collectingUi({});
  await monitor.check(ui);
  assert.equal(notifications.length, 1);
  monitor.reset();
  await monitor.check(ui);
  assert.equal(notifications.length, 2);
});
