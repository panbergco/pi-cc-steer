/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * Task-completion notifications.
 *
 * Every backgrounded job that reaches a terminal state sends its OWN
 * <task-notification> XML message, exactly once, the moment it exits. pi's
 * steer delivery queues the message while the agent is streaming and
 * delivers it at the next tool-call boundary, or starts a turn when the
 * agent is idle (triggerTurn: true).
 *
 * Exactly-once is enforced by the job's `notified` latch — a check-and-set
 * done BEFORE the send, so any path that already surfaced the outcome (a
 * bg_output/bg_stop read, a deliberate kill) suppresses the notification.
 * A terminal job that has been notified is evicted from the live registry;
 * its output log stays on disk and the notification carries the path.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    DELIVER_STEER,
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

    try {
        pi.sendMessage(
            {
                customType: EVENT.taskNotification,
                content: buildTaskNotification({ job, status, summary }),
                display: true,
                details: {
                    jobId: job.id,
                    status,
                    summary,
                    outputFile: job.logPath,
                },
            },
            DELIVER_STEER
        );
    } catch (err) {
        console.error("[bg-tasks] task notification failed:", err);
        return false;
    }
    forget(reg, job);
    return true;
}
