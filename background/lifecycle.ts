/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * Lifecycle helpers for background jobs: the startBackgroundJob orchestration
 * entry point, terminal-state marking, the SIGTERM→grace→SIGKILL stop path,
 * and the output-cap watcher.
 */

import { appendFileSync, statSync, truncateSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    isTerminalStatus,
    MAX_CONCURRENT_JOBS,
    FOREGROUND_WATCH_INTERVAL_MS,
    MAX_LOG_BYTES,
    OUTPUT_WATCH_INTERVAL_MS,
    type BgJob,
    type JobStatus,
    type SpawnExit,
    type UiContext,
} from "./types.ts";
import type { BgRegistry } from "./registry.ts";
import { atConcurrencyLimit, forget, markStarted } from "./registry.ts";
import { killProcessTree, killWithGrace } from "./spawn.ts";
import { markNotified, sendTaskNotification } from "./notify.ts";
import { renderStatusPill } from "./ui.ts";

// --- Background-job orchestration ----------------------------------------

/** Throw a standard error when no concurrency slot is free. */
export function assertJobSlot(reg: BgRegistry): void {
    if (atConcurrencyLimit(reg)) {
        throw new Error(
            `Max concurrent background jobs (${MAX_CONCURRENT_JOBS}) reached. ` +
                `Stop or wait for existing jobs before starting new ones.`
        );
    }
}

/**
 * Wire a background job's lifecycle: done promise, output-cap watcher, and
 * the exit→completeJob hand-off. The job must already be in the registry.
 * This is the single orchestration entry point — run_in_background spawns
 * and promoteToBackground both funnel through here.
 */
export function startBackgroundJob(args: {
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    ctx: UiContext;
    job: BgJob;
    exit: Promise<SpawnExit>;
    shouldNotify?: boolean;
    onExit?: (result: SpawnExit) => void;
}): void {
    const { reg, pi, ctx, job, exit } = args;
    ensureCompletionPromise(job);
    job.exit = exit;
    // Runaway output: stop the group at once (no grace — it is filling the disk), and trim the log to the cap.
    const stopWatcher = watchOutputCap(
        job,
        () => {
            job.stopReason = "output_limit";
            killProcessTree(job.pid, "SIGKILL");
        },
        FOREGROUND_WATCH_INTERVAL_MS
    );
    void exit.then((result) => {
        stopWatcher();
        if (job.stopReason === "output_limit") {
            try {
                truncateSync(job.logPath, MAX_LOG_BYTES);
            } catch { /* best-effort */ }
        }
        args.onExit?.(result);
        completeJob({
            job,
            code: result.code,
            signal: result.signal,
            reg,
            pi,
            ctx,
            shouldNotify: args.shouldNotify,
        });
    });
    renderStatusPill(reg, ctx);
}

/**
 * Flip a running foreground command into a tracked background job
 * (Ctrl+Shift+B / auto-bg timeout). Callers guard idempotency.
 */
export function promoteToBackground(args: {
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    ctx: UiContext;
    job: BgJob;
    exit: Promise<SpawnExit>;
    toolCallId: string;
}): void {
    const { reg, job, toolCallId } = args;
    // Clear the foreground slot now (not only when the tool call unwinds) so
    // a backgrounded command can't strand a stale slot.
    reg.foreground.delete(toolCallId);
    job.isBackgrounded = true;
    markStarted(reg);
    startBackgroundJob({
        reg,
        pi: args.pi,
        ctx: args.ctx,
        job,
        exit: args.exit,
    });
}

// --- Terminal-state marking ----------------------------------------------

/**
 * Standard completion flow after a job exits: markTerminal → notify →
 * status pill. The notification is sent the moment the job exits; a
 * successful send evicts the job from the live registry. Jobs whose outcome
 * is already known (killed silently, or read via bg_output/bg_stop) skip
 * the notification and linger until the lazy sweep in bg_list.
 * Idempotent — an already-terminal job is ignored.
 */
export function completeJob(args: {
    job: BgJob;
    code: number | null | undefined;
    /** The signal that killed the job, when it died by signal. */
    signal?: NodeJS.Signals | null;
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    ctx: UiContext;
    shouldNotify?: boolean;
}): void {
    if (isTerminalStatus(args.job.status)) return;
    const finished = args.job;
    markTerminal(finished, statusFromExit(args.code, args.signal), args.code ?? undefined);
    if (args.shouldNotify !== false) {
        sendTaskNotification({ reg: args.reg, pi: args.pi, job: finished });
    } else {
        markNotified(finished);
        forget(args.reg, finished);
    }
    renderStatusPill(args.reg, args.ctx);
}

/**
 * Mark a job terminal and resolve its donePromise. Idempotent.
 */
export function markTerminal(
    job: BgJob,
    status: JobStatus,
    exitCode?: number
): void {
    if (isTerminalStatus(job.status)) return;
    job.status = status;
    job.exitCode = exitCode;
    if (job.resolveDone) {
        job.resolveDone();
        delete job.resolveDone;
    }
    delete job.donePromise;
}

/** Map an exit result to a JobStatus: a signal death (external kill, OOM,
 *  output-cap stop) is "killed", exit code 0 is "completed", anything else
 *  is "failed". */
export function statusFromExit(
    code: number | null | undefined,
    signal?: NodeJS.Signals | null
): JobStatus {
    if (signal) return "killed";
    return code === 0 ? "completed" : "failed";
}

/** Create a job's donePromise (bg_stop awaits it). Idempotent. */
export function ensureCompletionPromise(job: BgJob): void {
    if (job.donePromise) return;
    let resolveDone: (() => void) | undefined;
    job.donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
    });
    job.resolveDone = resolveDone;
}

// --- Stop path -------------------------------------------------------------

/**
 * Stop a running job: SIGTERM the process group, then SIGKILL after the
 * grace window. Returns the kill promise so session_shutdown can await a
 * bounded cleanup; tool paths fire-and-forget.
 */
export function terminateJob(job: BgJob, reason?: string): Promise<void> {
    if (reason && !job.stopReason) job.stopReason = reason;
    return killWithGrace({ pid: job.pid, exit: job.exit });
}

/**
 * Kill a job quietly. The notified latch is set BEFORE the kill so the exit
 * handler's notification is suppressed (bg_stop, session shutdown).
 * markTerminal flips the status immediately; the actual process death
 * catches up asynchronously within the grace window.
 */
export function terminateJobSilently(reg: BgRegistry, job: BgJob, reason?: string): Promise<void> {
    markNotified(job);
    const kill = terminateJob(job, reason);
    markTerminal(job, "killed");
    void kill.then(() => forget(reg, job));
    return kill;
}

// --- Output-cap watcher ------------------------------------------------------

/**
 * Poll the log size; past MAX_LOG_BYTES, append a marker and trip once.
 * A command that out-produces the cap is killed (through the shared
 * SIGTERM→grace→SIGKILL path) so it can't fill the disk.
 */
export function watchOutputCap(job: BgJob, onTrip: () => void, intervalMs = OUTPUT_WATCH_INTERVAL_MS): () => void {
    let tripped = false;
    const timer = setInterval(() => {
        if (tripped) return;
        let size: number;
        try {
            size = statSync(job.logPath).size;
        } catch {
            return; // log not created yet — retry next tick
        }
        if (size <= MAX_LOG_BYTES) return;
        tripped = true;
        clearInterval(timer);
        try {
            appendFileSync(
                job.logPath,
                `\n[bg-tasks] output exceeded the ${Math.round(MAX_LOG_BYTES / 1024 / 1024)} MiB limit — task killed\n`
            );
        } catch { /* best-effort — the kill below still happens */ }
        onTrip();
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
}

// --- Misc helpers ------------------------------------------------------------

/** Verify the cwd actually exists. Throws a clear error if not. */
export function requireExistingCwd(cwd: string): void {
    try {
        statSync(cwd);
    } catch {
        throw new Error(`Working directory does not exist: ${cwd}`);
    }
}

/** True for whitespace-only commands — bash silently passes them, so reject explicitly. */
export function isBlankCommand(command: string): boolean {
    return command.trim().length === 0;
}

/** Detect whether pi is running non-interactively (print / non-TTY). */
export function detectNonInteractive(
    argv: readonly string[],
    stdinIsTTY: boolean
): boolean {
    if (!stdinIsTTY) return true;
    return argv.includes("-p") || argv.includes("--print");
}
