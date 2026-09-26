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
    details: { jobId?: string; status?: string; summary?: string; noticeId?: string; noticeIds?: string[]; [k: string]: unknown };
}

function makeNotice(reg: BgRegistry, content: string, details: Notice["details"]): Notice {
    const id = `n${++reg.noticeSeq}`;
    return { id, content, details: { ...details, noticeId: id } };
}

/**
 * Hand a notice on, the way Claude Code does:
 * - pi idle: it starts a turn now;
 * - pi busy (running, or a run just ending): it is held here, and goes in at the next tool boundary after the
 *   person's own queued messages (deliverMidRun), or once the run ends (deliverHeld).
 */
export function deliverNotice(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, notice: Notice): void {
    if (reg.ending || !reg.isIdle()) {
        reg.held.push(notice);
        watchHeld(reg, pi);
        return;
    }
    if (!reg.startsTurns || reg.submitting || reg.personPending()) {
        reg.waiting.push(notice); // the next prompt carries it
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
 * A tool boundary where the run goes on: the oldest notice goes in now, as a steering message. One per boundary,
 * because pi hands the model one steering message per request by default: a second one would still be queued at
 * the next boundary, ahead of anything the person sends then. Nothing goes while the person's own messages are on
 * their way into pi (pi-cc-steer does not even call this at a boundary where it queued them).
 */
export function deliverMidRun(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, queuedInPi = 0): void {
    // Something already queued in pi (another extension's steering message): a notice now would sit behind it and
    // ahead of anything the person sends next. It waits for a boundary with pi's queue empty.
    if (reg.personPending() || reg.submitting || queuedInPi > 0) return;
    const n = reg.waiting.shift() ?? reg.held.shift();
    if (n) send(reg, pi, n, { deliverAs: "steer" });
}

/** Hand a notice to pi and keep a copy until it arrives (an abort can clear pi's queue). */
function send(
    reg: BgRegistry,
    pi: Pick<ExtensionAPI, "sendMessage">,
    n: Notice,
    options: { deliverAs?: "steer" | "nextTurn"; triggerTurn?: boolean }
): void {
    reg.inFlight.set(n.id, n);
    sendNotice(pi, n, options);
}

/**
 * pi delivered a notice (or a combined one) into the conversation. Returns true when every notice in it had
 * already arrived: a duplicate.
 */
export function noticeArrived(reg: BgRegistry, noticeIds: string[]): boolean {
    if (noticeIds.length === 0) return false;
    const fresh = noticeIds.filter((id) => !reg.arrived.has(id));
    for (const id of noticeIds) {
        reg.inFlight.delete(id);
        reg.arrived.add(id);
    }
    return fresh.length === 0;
}

/** The notice ids a delivered message carries. */
export function idsOf(details: { noticeId?: string; noticeIds?: string[] } | undefined): string[] {
    return details?.noticeIds ?? (details?.noticeId ? [details.noticeId] : []);
}

/**
 * The run has ended. Everything not yet in the conversation — held during the run, waiting from before, or
 * handed to pi but never arrived (an abort may have cleared pi's queue; if it did not, the second copy is hidden
 * on arrival) — is delivered:
 * - a prompt is about to start (the person's queued message, or another run): it rides in it, after the prompt;
 * - otherwise it starts one turn just after pi has finished stopping, as Claude Code wakes the model when a
 *   background command finishes (including after an Esc), without holding up the stop itself. Any prompt, run,
 *   session switch or shutdown in between cancels that.
 */
export function deliverHeld(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, withNextMessage: boolean): void {
    reg.ending = false;
    reg.waiting.push(...reg.held.splice(0), ...reg.inFlight.values());
    reg.inFlight.clear();
    if (withNextMessage) return;
    scheduleTurn(reg, pi);
}

/**
 * Notices held while pi is busy outside a run (compacting, summarising a branch for /tree, …): no run ends to hand
 * them on, so check until pi is idle, then start their turn. A run that starts meanwhile takes over.
 */
export function watchHeld(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">): void {
    if (reg.heldWatch || reg.inRun || reg.ending) return;
    const stop = () => {
        if (reg.heldWatch) clearInterval(reg.heldWatch);
        reg.heldWatch = undefined;
    };
    reg.heldWatch = setInterval(() => {
        if (reg.closed || reg.inRun || reg.ending || reg.held.length === 0) return stop();
        if (!reg.isIdle()) return;
        stop();
        reg.waiting.push(...reg.held.splice(0));
        scheduleTurn(reg, pi);
    }, 250);
    reg.heldWatch.unref?.();
}

/** pi is (about to be) idle with notices waiting: start one turn for them once this event has finished. */
export function scheduleTurn(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">): void {
    if (reg.waiting.length === 0 || !reg.startsTurns) return;
    const generation = reg.generation;
    setTimeout(() => {
        try {
            if (reg.closed || reg.submitting || reg.personPending() || reg.generation !== generation || !reg.isIdle()) return;
            if (reg.waiting.length === 0) return;
            startTurnWith(reg, pi, []);
        } catch {
            // session replaced meanwhile: its notices went with it
        }
    }, 0).unref?.();
}

/** Start one turn carrying every waiting notice and these, as one message (see combine). */
export function startTurnWith(reg: BgRegistry, pi: Pick<ExtensionAPI, "sendMessage">, notices: Notice[]): void {
    if (reg.closed || reg.submitting || reg.personPending()) {
        reg.waiting.push(...notices);
        return;
    }
    const all = [...reg.waiting.splice(0), ...notices];
    if (all.length === 0) return;
    const one = all.length === 1 ? all[0] : combine(all);
    for (const n of all) reg.inFlight.set(n.id, n);
    sendNotice(pi, one, DELIVER_NOTICE);
}

/**
 * Several notices as one message. pi appends messages sent to an idle session straight to the conversation
 * without reporting them to extensions, so only a single message can be tracked to its arrival.
 */
function combine(notices: Notice[]): Notice {
    const details = notices.map((n) => n.details);
    const worst =
        details.find((d) => d.status === "failed")?.status ?? details.find((d) => d.status !== "completed")?.status ?? "completed";
    return {
        id: notices.map((n) => n.id).join("+"),
        content: notices.map((n) => n.content).join("\n\n"),
        details: { status: worst, summary: details.map((d) => d.summary).filter(Boolean).join("; "), noticeIds: notices.map((n) => n.id) },
    };
}

/**
 * A prompt is about to start (any source: typed, RPC, a template, another extension): the waiting notices ride
 * in it, after the prompt, as one message.
 */
export function takeWaiting(reg: BgRegistry, prompt?: string):
    | { customType: string; content: string; display: boolean; details: unknown }
    | undefined {
    // Something else of the person's still on its way (submitted earlier, held by another extension): notices
    // wait for it rather than ride ahead of it in this prompt. (The prompt starting now has been seen.)
    if (reg.submissions.some((s) => !s.reached) || reg.personPending(prompt)) return undefined;
    const waiting = reg.waiting.splice(0).filter((n) => !reg.arrived.has(n.id));
    if (waiting.length === 0) return undefined;
    for (const n of waiting) reg.inFlight.set(n.id, n); // arrival is recorded when pi reports it (message_end)
    const one = waiting.length === 1 ? waiting[0] : combine(waiting);
    return { customType: EVENT.taskNotification, content: one.content, display: true, details: one.details };
}
