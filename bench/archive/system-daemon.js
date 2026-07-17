import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const daemonEntrypoint = resolve(repositoryRoot, "bin/context-windowd.js");

function processExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function readyLine(child, output, timeoutMs) {
  return new Promise((resolveReady, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolveReady(value);
    };
    const parseLines = () => {
      for (;;) {
        const newline = stdoutBuffer.indexOf("\n");
        if (newline < 0) return;
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          finish(new Error(`context-windowd emitted invalid readiness JSON: ${error.message}`));
          return;
        }
        if (message.status !== "ready") {
          finish(new Error(`context-windowd did not report ready: ${line}`));
          return;
        }
        finish(undefined, message);
        return;
      }
    };
    const onStdout = (chunk) => {
      const text = String(chunk);
      output.stdout += text;
      stdoutBuffer += text;
      parseLines();
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(
      `context-windowd exited before readiness (code=${String(code)}, signal=${String(signal)}): ${output.stderr}`,
    ));
    const timer = setTimeout(() => finish(new Error(
      `context-windowd readiness timed out after ${timeoutMs} ms: ${output.stderr}`,
    )), timeoutMs);
    timer.unref?.();
    child.stdout.on("data", onStdout);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

/** Start the shipped daemon entrypoint, not an in-process benchmark substitute. */
export async function startArchiveSystemDaemon({
  storePath,
  socketPath,
  timeoutMs = 120_000,
} = {}) {
  const output = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [
    daemonEntrypoint,
    "--store",
    storePath,
    "--socket",
    socketPath,
  ], {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { output.stderr += String(chunk); });
  try {
    const ready = await readyLine(child, output, timeoutMs);
    return Object.freeze({ child, ready, output });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await processExit(child).catch(() => {});
    throw error;
  }
}

export async function stopArchiveSystemDaemon(handle, { timeoutMs = 15_000 } = {}) {
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = processExit(child);
  child.kill("SIGTERM");
  const timeout = Symbol("timeout");
  let timeoutId;
  const result = await Promise.race([
    exited,
    new Promise((resolveTimeout) => {
      timeoutId = setTimeout(() => resolveTimeout(timeout), timeoutMs);
    }),
  ]);
  clearTimeout(timeoutId);
  if (result !== timeout) return result;
  child.kill("SIGKILL");
  return exited;
}

export async function killArchiveSystemDaemon(handle) {
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  const exited = processExit(child);
  if (!child.kill("SIGKILL")) {
    throw new Error(`failed to send SIGKILL to context-windowd process ${child.pid}`);
  }
  return exited;
}

function execFilePromise(file, args) {
  return new Promise((resolveExec, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`RSS probe failed: ${stderr || error.message}`, { cause: error }));
        return;
      }
      resolveExec(stdout);
    });
  });
}

/** Read resident bytes for the daemon process through the host process table. */
export async function archiveSystemDaemonRssBytes(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new TypeError("processId must be a positive integer");
  }
  const stdout = await execFilePromise("ps", ["-o", "rss=", "-p", String(processId)]);
  const kibibytes = Number(stdout.trim());
  if (!Number.isSafeInteger(kibibytes) || kibibytes <= 0) {
    throw new Error(`RSS probe returned an invalid KiB value: ${JSON.stringify(stdout.trim())}`);
  }
  return kibibytes * 1_024;
}

export { repositoryRoot as ARCHIVE_SYSTEM_REPOSITORY_ROOT };
