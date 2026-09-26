/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * Task-completion notifications.
 *
 * Every backgrounded job that reaches a terminal state sends its OWN
 * <task-notification> XML message, exactly once, the moment it exits. See
 * deliverNotice for when it reaches the model.
 *
 * Exactly-once is enforced by the job's `notified` latch — a check-and-set
 * done BEFORE the send, so any path that already surfaced the outcome (a
 * bg_output/bg_stop read, a deliberate kill) suppresses the notification.
 * A terminal job that has been notified is evicted from the live registry;
 * its output log stays on disk and the notification carries the path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DELIVER_NOTICE,
    EVENT,
    NOTIFY_TAIL_CHARS,
    type BgJob,
} from "./types.ts";
import type { BgRegistry } from "./registry.ts";
import { forget } from "./registry.ts";
import { readBoundedTail, stripAnsi } from "./output.ts";

/** Terminal statuses a <task-notification> can carry. */
export type TerminalStatus = "completed" | "failed" | "killed" | "timed_out";

/** Escape the XML special characters inside element text. */
export function escapeXml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Collapse all whitespace runs to single spaces — one-line rendering. */
export function oneLine(s: string): string {
    return s.replace(/\s+/g, " ").trim();
}

/** Human/agent prose label: the name when set, else the command collapsed to
 *  one line and truncated. */
export function describeJob(job: BgJob): string {
    if (job.name) return job.name;
    const line = oneLine(job.command);
    return line.length > 80 ? `${line.slice(0, 80)}…` : line;
}

/**
 * Build the <task-notification> XML block: task_id / status / command /
 * exit_code / output_file / summary, plus a small tail preview so the agent
 * often doesn't need a bg_output call to react.
 */
export function buildTaskNotification(args: {
    job: BgJob;
    status: TerminalStatus;
    summary: string;
}): string {
    const { job, status } = args;
    const tail = stripAnsi(readBoundedTail(job.logPath, NOTIFY_TAIL_CHARS)).trim();
    const lines = [
        "<task-notification>",
        `<task_id>${escapeXml(job.id)}</task_id>`,
        `<status>${status}</status>`,
        `<command>${escapeXml(oneLine(job.command))}</command>`,
        ...(job.exitCode !== undefined ? [`<exit_code>${job.exitCode}</exit_code>`] : []),
        `<output_file>${escapeXml(job.logPath)}</output_file>`,
        `<summary>${escapeXml(args.summary)}</summary>`,
        ...(tail && tail !== "(no output yet)"
            ? [`<tail_preview>${escapeXml(tail)}</tail_preview>`]
            : []),
        "</task-notification>",
    ];
    return lines.join("\n");
}

/** The completion summary sentence for a terminal job. */
export function completionSummary(job: BgJob, status?: TerminalStatus): string {
    const s = status ?? (job.status as TerminalStatus);
    const desc = describeJob(job);
    if (job.stopReason === "output_limit") {
        return `Background command "${desc}" was stopped: output exceeded the size limit`;
    }
    if (s === "killed" || s === "timed_out") return `Background command "${desc}" was stopped`;
    if (s === "failed") return `Background command "${desc}" failed with exit code ${job.exitCode ?? "unknown"}`;
    return `Background command "${desc}" completed${job.exitCode != null ? ` (exit code ${job.exitCode})` : ""}`;
}

/**
 * Set the notified latch. Idempotent. Called by every path that surfaces a
 * job's outcome WITHOUT the notification: kill paths (before the kill, so
 * the exit handler skips notifying) and terminal reads (bg_output/bg_stop).
 */
export function markNotified(job: BgJob): void {
    job.notified = true;
}

/**
 * Send a terminal job's <task-notification>, exactly once. The latch is set
 * BEFORE the send, so a concurrent consumer can never produce a duplicate;
 * if the send itself throws, the notification is lost rather than retried
 * (exactly-once), and the terminal+notified job lingers until the lazy
 * sweep in bg_list.
 *
 * On success the job is evicted from the live registry (terminal +
 * notified) into the recent-terminal ring.
 *
 * Returns true when the notification was sent.
 */
/** A notice for the model: a completion, or a warning that a command looks stuck. */
export interface Notice {
    id: string;
    content: string;
    details: { jobId?: string; status?: string; summary?: string; noticeId?: string; [k: string]: unknown };
}

function makeNotice(reg: BgRegistry, content: string, details: Notice["details"]): Notice {
    const id = `n${++reg.noticeSeq}`;
    return { id, content, details: { ...details, noticeId: id } };
}

/**
 * Hand a notice on, the way Claude Code does:
 * - pi idle: it starts a turn now;
 * - pi busy: it is held here, and goes in at the next tool boundary after the person's own queued messages
 *   (deliverMidRun), or once the run ends (deliverHeld).
 */
export function deliverNotice(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, notice: Notice): void {
    if (reg.agentRunning) {
        reg.held.push(notice);
        return;
    }
    startTurnWith(reg, pi, [notice]);
}

export function sendTaskNotification(args: {
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    job: BgJob;
}): boolean {
    const { reg, pi, job } = args;
    if (job.notified) return false;
    job.notified = true;
    const status = job.status as TerminalStatus;
    const summary = completionSummary(job, status);
    const notice = makeNotice(reg, buildTaskNotification({ job, status, summary }), {
        jobId: job.id,
        status,
        summary,
        outputFile: job.logPath,
    });
    try {
        deliverNotice(reg, pi, notice);
    } catch (err) {
        console.error("[bg-tasks] task notification failed:", err);
        return false;
    }
    forget(reg, job);
    return true;
}

/** A background command has gone quiet on what looks like an interactive prompt: tell the model, once. */
export function sendStallNotice(args: {
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    job: BgJob;
    tail: string;
}): void {
    const { reg, pi, job, tail } = args;
    const summary = `Background command "${describeJob(job)}" appears to be waiting for interactive input`;
    const content = [
        "<task-notification>",
        `<task_id>${escapeXml(job.id)}</task_id>`,
        `<output_file>${escapeXml(job.logPath)}</output_file>`,
        `<summary>${escapeXml(summary)}</summary>`,
        "</task-notification>",
        "Last output:",
        stripAnsi(tail).trimEnd(),
        "",
        "It is probably blocked on a prompt that nobody will answer. Stop it with bg_stop and run it again with the " +
            "answer piped in (for example `yes | command`) or with a non-interactive flag, if the command has one.",
    ].join("\n");
    deliverNotice(reg, pi, makeNotice(reg, content, { jobId: job.id, status: "stalled", summary }));
}

/** Hand a notice to pi. By default it wakes an idle agent. */
export function sendNotice(
    pi: Pick<ExtensionAPI, "sendMessage">,
    notice: Notice,
    options: { deliverAs?: "steer" | "nextTurn"; triggerTurn?: boolean } = DELIVER_NOTICE
): void {
    pi.sendMessage(
        { customType: EVENT.taskNotification, content: notice.content, display: true, details: notice.details },
        options
    );
}

/**
 * A tool boundary where the run goes on: notices go in now, as steering messages queued after the person's own
 * (pi keeps them in order). A copy stays "in flight" until pi shows it arrived, because an abort can clear pi's
 * queue (see deliverHeld).
 */
export function deliverMidRun(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">): void {
    for (const n of [...reg.waiting.splice(0), ...reg.held.splice(0)]) {
        reg.inFlight.set(n.id, n);
        sendNotice(pi, n, { deliverAs: "steer" });
    }
}

/** pi delivered a notice into the conversation. */
export function noticeArrived(reg: BgRegistry, noticeId: string | undefined): void {
    if (noticeId) reg.inFlight.delete(noticeId);
}

/**
 * The run has ended. Notices held during it, waiting from before, or sent but wiped from pi's queue by an abort
 * (pi's queue is empty yet they never arrived) are delivered:
 * - a prompt is about to start (the person's queued message, or another run): they ride in it, after the prompt;
 * - otherwise they start one turn, just after pi has finished stopping — as Claude Code wakes the model when a
 *   background command finishes, including after an Esc — without holding up the stop itself.
 */
export function deliverHeld(
    reg: BgRegistry,
    pi: Pick<ExtensionAPI, "sendMessage">,
    withNextMessage: boolean,
    piQueueEmpty: boolean
): void {
    reg.waiting.push(...reg.held.splice(0));
    if (piQueueEmpty) {
        reg.waiting.push(...reg.inFlight.values());
        reg.inFlight.clear();
    }
    if (reg.waiting.length === 0 || withNextMessage) return;
    setTimeout(() => {
        try {
            if (!reg.agentRunning && reg.waiting.length > 0) startTurnWith(reg, pi, []);
        } catch {
            // session replaced meanwhile: its notices went with it
        }
    }, 0).unref?.();
}

/** Start one turn carrying every waiting notice and these; only the last one triggers the turn. */
export function startTurnWith(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, notices: Notice[]): void {
    const all = [...reg.waiting.splice(0), ...notices];
    all.forEach((n, i) => sendNotice(pi, n, i === all.length - 1 ? DELIVER_NOTICE : {}));
}

/**
 * A prompt is about to start (any source: typed, RPC, a template, another extension): the waiting notices ride
 * in it, after the prompt, as one message.
 */
export function takeWaiting(reg: BgRegistry):
    | { customType: string; content: string; display: boolean; details: unknown }
    | undefined {
    const waiting = reg.waiting.splice(0);
    if (waiting.length === 0) return undefined;
    const details = waiting.map((n) => n.details);
    const worst =
        details.find((d) => d.status === "failed")?.status ?? details.find((d) => d.status !== "completed")?.status ?? "completed";
    return {
        customType: EVENT.taskNotification,
        content: waiting.map((n) => n.content).join("\n\n"),
        display: true,
        details: { status: worst, summary: details.map((d) => d.summary).filter(Boolean).join("; ") },
    };
}
