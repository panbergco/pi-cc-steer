/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Type definitions and shared constants for the bg-tasks extension.
 *
 * This module is the dependency-free base layer: everything else imports
 * from here, and it imports nothing from its siblings.
 */

// --- Configuration constants ---
export const DEFAULT_TIMEOUT_MS = 120_000;
export const QUICK_COMPLETION_MS = 2_000;
export const FOREGROUND_TAIL_BYTES = 4_096;
export const OUTPUT_PREVIEW_CHARS = 12_000;
/** Tail preview returned by bg_output (the full log stays on disk). */
export const TASK_OUTPUT_TAIL_CHARS = 32 * 1024;
/** Tail preview embedded in the terminal <task-notification>. */
export const NOTIFY_TAIL_CHARS = 1_000;
/** Hard output ceiling: a job whose log grows past this is killed. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
/** How often the output-cap watcher stats the log file. */
export const OUTPUT_WATCH_INTERVAL_MS = 2_000;
/** A foreground command is watched more often: nothing else bounds how fast it fills the temp dir. */
export const FOREGROUND_WATCH_INTERVAL_MS = 250;
/** Stuck-prompt check on background commands (Claude Code's timings): look every 5 s; after 45 s with no new
 *  output, read the last 1 KiB and warn the model once if its last line looks like an interactive prompt. */
export const STALL_TIMING = { checkMs: 5_000, afterMs: 45_000 };
export const STALL_TAIL_BYTES = 1_024;

/** Grace window between SIGTERM and SIGKILL on every stop path. */
export const SIGTERM_GRACE_MS = 5_000;
export const RECENT_TERMINAL_KEEP = 20;
export const MAX_CONCURRENT_JOBS = 16;
/** session_start deletes logs older than this. */
export const STALE_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

/** Dedicated log directory under the system temp dir (honours TMPDIR). Keeping logs in their own dir
 *  keeps the stale-log sweep bounded — it lists only our files. */
export const LOG_DIR = join(tmpdir(), "pi-bg-tasks");

// --- Domain types ---
/** "timed_out" is reserved (no producer in v1 — foreground timeouts
 *  auto-background instead of dying). */
export type JobStatus = "running" | "completed" | "failed" | "killed" | "timed_out";

/** True once the job has reached a terminal state. */
export function isTerminalStatus(status: JobStatus): boolean {
    return status !== "running";
}

/** How the child ended: an exit code, or the signal that killed it. Node
 *  reports `code === null` when the child died by signal, so the signal half
 *  is what tells a kill apart from a clean exit. */
export interface SpawnExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface BgJob {
    id: string;
    name?: string;
    command: string;
    pid: number;
    startTime: number;
    status: JobStatus;
    exitCode?: number;
    logPath: string;
    toolCallId: string;
    /** The spawn's exit promise — awaited by the SIGTERM grace window. */
    exit?: Promise<SpawnExit>;
    donePromise?: Promise<void>;
    resolveDone?: () => void;
    /** Exactly-once latch for the terminal <task-notification>. Set BEFORE
     *  the notification send, before a deliberate kill, and when the agent
     *  reads the outcome via bg_output/bg_stop — any path that already
     *  surfaced the result suppresses the notification. */
    notified?: boolean;
    isBackgrounded: boolean;
    /** Why the job was stopped ("output_limit", bg_stop reason, ...). */
    stopReason?: string;
}

export type BackgroundReason = "manual" | "timeout";

/** Transient handle for an in-flight foreground bash command, keyed by
 *  toolCallId in the registry. Ctrl+B / Ctrl+Shift+B and the timeout timer call
 *  requestPause to flip the command into the background. */
export interface ForegroundSlot {
    /** Returns false when the command can no longer be backgrounded (it is being cancelled). */
    requestPause: (reason: BackgroundReason) => boolean;
}

// --- Event types ---
export const EVENT = {
    taskNotification: "bg-task-notification",
} as const;

// --- Deliver options ---
/** An idle agent is woken by a completion notice. A notice that finishes mid-run is held by the extension
 *  (never in pi's own queue, which an abort clears) and delivered when the run ends — see deliverHeld. */
export const DELIVER_NOTICE = { triggerTurn: true } as const;

// --- UI context ---
/** The slice of pi's ExtensionContext the UI helpers need. */
export interface UiContext {
    ui: {
        notify(message: string, level?: "info" | "warning" | "error"): void;
        setWidget(
            name: string,
            content: string[] | undefined,
            options?: { placement?: "aboveEditor" | "belowEditor" }
        ): void;
        setStatus(name: string, content: unknown): void;
        theme: { fg(colour: string, text: string): string };
    };
}
