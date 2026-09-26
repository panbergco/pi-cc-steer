/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * Process spawning with fd-direct log output, and process-group kills.
 *
 * The child writes stdout+stderr straight to a file descriptor — the kernel
 * moves the bytes, zero JS in the data path. Progress is read back by polling
 * the file tail separately (see output.ts).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SIGTERM_GRACE_MS, type SpawnExit } from "./types.ts";

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<SpawnExit>;
    /**
     * The spawned child handle. Returned REF'D on purpose: a foreground
     * caller awaiting `exit` must keep the Node event loop alive, otherwise
     * a headless (print/json-mode) pi process — which has no TUI handles —
     * exits 0 mid-tool the moment the loop drains, silently killing the run.
     * Callers that hand the job to the background MUST call `proc.unref()`
     * so a finished pi process can still exit while the job runs on.
     */
    proc: ChildProcess;
}

/**
 * Spawn `bash -c <command>` with output written directly to logPath. The
 * child is detached into its own process group so the whole tree can be
 * signalled with a negative PID. The parent closes its copy of the fd
 * immediately after spawn. The returned handle stays ref'd; background
 * callers must `proc.unref()` it (see SpawnResult.proc).
 */
export function spawnWithFileOutput(args: {
    command: string;
    cwd: string;
    logPath: string;
}): SpawnResult {
    ensureLogDir(args.logPath);
    const outFd = openSync(args.logPath, "w");

    let proc;
    try {
        proc = spawn("bash", ["-c", args.command], {
            stdio: ["ignore", outFd, outFd],
            cwd: args.cwd,
            detached: true,
            env: { ...process.env },
        });
    } finally {
        closeSync(outFd);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<SpawnExit>((resolve) => {
        // Use 'exit' not 'close': 'close' waits for stdio to close, which
        // includes daemonized grandchildren that inherit the fd (e.g.
        // `sleep 30 &`). 'exit' fires when the shell itself exits.
        proc.on("exit", (code, signal) => resolve({ code, signal }));
        proc.on("error", () => resolve({ code: 1, signal: null }));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    return { pid, logPath: args.logPath, exit, proc };
}

/** The log dir is a constant (types.LOG_DIR), so create it once per process
 *  instead of paying a recursive mkdir on every spawn. */
let logDirCreated = false;
function ensureLogDir(logPath: string): void {
    if (logDirCreated) return;
    mkdirSync(dirname(logPath), { recursive: true });
    logDirCreated = true;
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */
export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            /* already dead */
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Stop a process group gracefully: SIGTERM, wait up to graceMs for the exit
 * promise (or for the leader to die, when no promise is available), then
 * SIGKILL the group. Shared by bg_stop and session_shutdown so every stop
 * path gets the same escalation.
 */
export async function killWithGrace(args: {
    pid: number;
    exit?: Promise<SpawnExit>;
    graceMs?: number;
}): Promise<void> {
    const { pid, graceMs = SIGTERM_GRACE_MS } = args;
    if (!processExists(pid)) return;
    killProcessTree(pid, "SIGTERM");

    const exited = args.exit
        ? args.exit.then(() => true)
        : pollUntilDead(pid);
    const graceExpired = new Promise<false>((resolve) => {
        const t = setTimeout(() => resolve(false), graceMs);
        t.unref();
    });

    const ok = await Promise.race([exited, graceExpired]);
    if (!ok && processExists(pid)) {
        killProcessTree(pid, "SIGKILL");
        return;
    }
    // The shell exited, but a child that ignores SIGTERM may still hold the group: finish it off.
    if (groupExists(pid)) killProcessTree(pid, "SIGKILL");
}

/** Whether any process in the group led by pid is still alive. */
function groupExists(pid: number): boolean {
    try {
        process.kill(-pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** Fallback liveness wait when no exit promise is available. */
function pollUntilDead(pid: number): Promise<true> {
    return new Promise((resolve) => {
        const t = setInterval(() => {
            if (!processExists(pid)) {
                clearInterval(t);
                resolve(true);
            }
        }, 50);
        t.unref();
    });
}
