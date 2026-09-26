/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * The job registry — the single source of truth for every running or
 * recently-terminal background job. Purely in-memory: no persistence, no
 * revival across sessions.
 *
 * Also owns ID generation, the log-path convention, and the stale-log sweep.
 */

import { randomInt } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import {
    isTerminalStatus,
    LOG_DIR,
    MAX_CONCURRENT_JOBS,
    RECENT_TERMINAL_KEEP,
    STALE_LOG_MAX_AGE_MS,
    type BgJob,
    type ForegroundSlot,
} from "./types.ts";
import { readBoundedTail } from "./output.ts";
import type { Notice } from "./notify.ts";

/** One registry per session, threaded through every tool and helper. */
/** Something of the person's on its way into pi, from the editor's submit (or pi-cc-steer's own prompt) until it is
 *  queued (pi busy) or its run starts (pi idle). */
export interface Submission {
    text: string;
    /** From the editor (the input event's source is "interactive"), or pi-cc-steer's own prompt ("extension"). */
    source: "interactive" | "extension";
    /** Reached pi-cc-steer's input handler while pi was idle: released when the next run starts. */
    reached: boolean;
    timer?: ReturnType<typeof setTimeout>;
}

export class BgRegistry {
    jobs = new Map<string, BgJob>();
    foreground = new Map<string, ForegroundSlot>();

    /** Terminal jobs kept for bg_list/bg_output after eviction (ring buffer). */
    recentTerminal: BgJob[] = [];

    completedCount = 0;
    failedCount = 0;
    killedCount = 0;
    totalStarted = 0;

    nonInteractive = false;

    /** pi's own idle check, from the session context. Before a session starts nothing can be running. */
    isIdle: () => boolean = () => true;
    /** Whether a notice may start a turn by itself. Only in the interactive TUI, as in Claude Code: there a
     *  message typed during a run is queued. An RPC, print or SDK host drives the turns itself and would have its
     *  next prompt rejected by a turn it did not start; there notices ride in the host's next prompt. */
    startsTurns = true;
    /** A run has ended and its notices have not been handed on yet (agent_end → deliverHeld). */
    ending = false;
    /** Bumped by anything that should cancel a pending "start a turn for these notices": a prompt, a run
     *  starting, a session switch or shutdown. */
    generation = 0;
    /** A session switch or shutdown has begun: no notice turn starts (reset by the next input or run, in case
     *  the switch was cancelled). */
    closed = false;
    /** Submissions of the person's still on their way into pi (counted from the Enter key, before any extension
     *  processes them): while any is, no notice turn starts and none goes in at a tool boundary. */
    submissions: Submission[] = [];
    get submitting(): boolean {
        return this.submissions.length > 0;
    }
    /** The person's own messages are on their way into pi (pi-cc-steer): notices wait so they never go ahead. */
    personPending: () => boolean = () => false;
    /** Notices that arrived while pi was busy, not yet handed to pi. */
    held: Notice[] = [];
    /** Notices handed to pi, until pi shows they arrived. */
    inFlight = new Map<string, Notice>();
    /** Notices that have arrived in the conversation (a second arrival is a duplicate and is hidden). */
    arrived = new Set<string>();
    /** Notices waiting for the next prompt or turn. */
    waiting: Notice[] = [];
    noticeSeq = 0;
}

// --- ID generation -------------------------------------------------------

const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * Task IDs: `bash-` plus 8 random base36 chars from crypto.randomInt
 * (uniform — no modulo bias). Random (not sequential) so an id is
 * unguessable and collision-improbable across sessions; a collision against
 * the live registry simply regenerates.
 */
export function newJobId(reg?: BgRegistry): string {
    let id: string;
    do {
        let suffix = "";
        for (let i = 0; i < 8; i++) {
            suffix += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
        }
        id = `bash-${suffix}`;
    } while (reg?.jobs.has(id));
    return id;
}

export function logPathFor(jobId: string): string {
    return `${LOG_DIR}/${jobId}.log`;
}

/** Build a fresh running BgJob. Centralizes the job shape so construction
 *  sites don't drift. */
export function createRunningJob(args: {
    id: string;
    command: string;
    pid: number;
    logPath: string;
    toolCallId: string;
    name?: string;
    isBackgrounded?: boolean;
}): BgJob {
    return {
        id: args.id,
        name: args.name,
        command: args.command,
        pid: args.pid,
        startTime: Date.now(),
        status: "running",
        logPath: args.logPath,
        toolCallId: args.toolCallId,
        isBackgrounded: args.isBackgrounded ?? true,
    };
}

// --- Registry mutations --------------------------------------------------

/** Record that a job has started (lifetime counter). */
export function markStarted(reg: BgRegistry): void {
    reg.totalStarted++;
}

/** Add a brand-new running job and count it as started. */
export function add(reg: BgRegistry, job: BgJob): BgJob {
    reg.jobs.set(job.id, job);
    markStarted(reg);
    return job;
}

/** True once the running-job count has reached the concurrency cap. Counts
 *  with a short-circuit so it stops at the cap instead of scanning the map. */
export function atConcurrencyLimit(reg: BgRegistry): boolean {
    let n = 0;
    for (const job of reg.jobs.values()) {
        if (job.status === "running" && ++n >= MAX_CONCURRENT_JOBS) return true;
    }
    return false;
}

/**
 * Remove a terminal job from the live map, push it onto the recent-terminal
 * ring, and update lifetime counters. Returns the removed job (or undefined
 * if it wasn't in the map).
 */
export function forget(reg: BgRegistry, job: BgJob): BgJob | undefined {
    if (!reg.jobs.delete(job.id)) return undefined;
    if (job.status === "completed") reg.completedCount++;
    else if (job.status === "failed") reg.failedCount++;
    else if (job.status === "killed" || job.status === "timed_out") reg.killedCount++;
    reg.recentTerminal.push(job);
    if (reg.recentTerminal.length > RECENT_TERMINAL_KEEP) {
        reg.recentTerminal.shift();
    }
    return job;
}

/** Look up a job by ID — first the live registry, then the recent-terminal
 *  ring for jobs that already finished and were evicted. */
export function findJob(reg: BgRegistry, jobId: string): BgJob | undefined {
    return reg.jobs.get(jobId) ?? reg.recentTerminal.find((j) => j.id === jobId);
}

/** Evict terminal jobs whose outcome was already surfaced (notified latch
 *  set) from the live map — the lazy sweep run by bg_list so kill/read paths
 *  don't leave permanent entries behind. */
export function sweepNotifiedTerminal(reg: BgRegistry): void {
    for (const job of [...reg.jobs.values()]) {
        if (isTerminalStatus(job.status) && job.notified) forget(reg, job);
    }
}

/** Read only the tail of a job's log file — O(maxChars) even for large files. */
export function readLogTail(job: BgJob, maxChars: number): string {
    return readBoundedTail(job.logPath, maxChars);
}

// --- Stale-log sweep -----------------------------------------------------

/** Delete logs older than 24h. Best-effort; runs on session_start. */
export function sweepStaleLogs(now = Date.now()): number {
    let removed = 0;
    let names: string[];
    try {
        names = readdirSync(LOG_DIR);
    } catch {
        return 0; // no log dir yet
    }
    for (const name of names) {
        if (!name.endsWith(".log")) continue;
        const path = `${LOG_DIR}/${name}`;
        try {
            const { mtimeMs } = statSync(path);
            if (now - mtimeMs > STALE_LOG_MAX_AGE_MS) {
                unlinkSync(path);
                removed++;
            }
        } catch {
            /* raced with another process — skip */
        }
    }
    return removed;
}
