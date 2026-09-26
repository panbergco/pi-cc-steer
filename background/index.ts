/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * Background bash — Claude Code's Ctrl+B for pi.
 *
 * Registers four tools:
 *   - bash (override — adds run_in_background, auto-backgrounds at timeout)
 *   - bg_list / bg_output / bg_stop
 *
 * Plus the Ctrl+Shift+B shortcut, /bg and /bg-tasks commands, the
 * <task-notification> message renderer and session lifecycle hooks.
 * Ctrl+B itself is handled by pi-cc-steer's editor (it is pi's cursor-left when nothing runs).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { BgRegistry, type Submission, sweepStaleLogs } from "./registry.ts";
import { detectNonInteractive, terminateJobSilently } from "./lifecycle.ts";
import { registerBashTool } from "./tools-bash.ts";
import { registerTaskTools } from "./tools-tasks.ts";
import { backgroundActiveForeground, registerUi } from "./ui.ts";
import { deliverHeld, deliverMidRun, idsOf, noticeArrived, scheduleTurn, takeWaiting } from "./notify.ts";
import { EVENT } from "./types.ts";
import type { UiContext } from "./types.ts";

/** What pi-cc-steer needs from the engine. */
export interface Background {
    /** A bash command is running in the foreground and can be backgrounded. */
    hasForeground(): boolean;
    /** Move every foreground bash command to the background. */
    backgroundAll(ctx: UiContext): boolean;
    /** A tool boundary where the run goes on: notices go in now, unless something is already queued in pi. */
    deliverMidRun(queuedInPi: number): void;
    /** The run ended (see notify.ts deliverHeld). */
    deliverHeld(withNextMessage: boolean): void;
    /** Tell the engine how to see that the person's own messages are still on their way into pi. */
    setPersonPending(check: () => boolean): void;
    /** The person submitted `text` (pi-cc-steer's editor sees it before any extension processes it), or pi-cc-steer
     *  sent a prompt of the person's: no notice turn starts, and none goes in at a tool boundary, until it is queued
     *  or its run starts. A slash command, which may never reach pi's input handlers, is held for 5 s only. */
    promptSubmitted(text: string, source: "interactive" | "extension", kind?: "command"): void;
    /** A prompt reached pi-cc-steer's input handler (see Submission). */
    submissionReached(text: string, source: string, idle: boolean): void;
}

export function registerBackground(pi: ExtensionAPI): Background {
    const reg = new BgRegistry();

    // ── Tool registration ─────────────────────────────────────────
    // Use the unwrapped tool *definition* so the override inherits pi's
    // native bash renderCall/renderResult (createBashTool returns a wrapped
    // AgentTool that drops them). pi's registry is a Map.set where later
    // registration with the same name overrides the built-in.
    const originalBash = createBashToolDefinition(process.cwd());
    registerBashTool(pi, reg, originalBash);
    registerTaskTools(pi, reg);

    // ── Commands / shortcut / message renderer ────────────────────
    registerUi(pi, reg);

    // ── Notice delivery ───────────────────────────────────────────
    const cancelPendingStart = () => {
        reg.generation++;
    };
    const release = (keep: (s: Submission) => boolean) => {
        const before = reg.submissions.length;
        reg.submissions = reg.submissions.filter((s) => keep(s) || (s.timer && clearTimeout(s.timer), false));
        // The last hold ended with pi idle (a command, a swallowed message): notices that waited for it start a turn.
        if (before > 0 && reg.submissions.length === 0 && reg.isIdle() && !reg.ending) scheduleTurn(reg, pi);
    };
    pi.on("agent_start", () => {
        cancelPendingStart();
        // The prompt that reached pi idle is running (its notices rode in it, before_agent_start). Any other that
        // reached pi idle was refused, or swallowed by an extension after pi-cc-steer: nothing left to protect.
        release((s) => !s.reached);
        reg.closed = false; // a run in this session: any switch that began was cancelled
    });
    pi.on("agent_end", () => {
        reg.ending = true; // until pi-cc-steer's settle hands the run's notices on (deliverHeld)
    });
    // Once a session switch or shutdown begins, this session never starts a notice turn again (the switch may
    // still settle a run and would otherwise schedule a new one).
    const close = () => {
        reg.closed = true;
        cancelPendingStart();
        for (const s of reg.submissions) if (s.timer) clearTimeout(s.timer);
        reg.submissions = [];
    };
    for (const e of ["session_before_switch", "session_before_fork", "session_shutdown"] as const) {
        pi.on(e as "session_shutdown", close);
    }
    pi.on("session_before_tree", cancelPendingStart);
    // Any prompt (typed, RPC, a template, another extension) cancels a pending notice turn; its notices ride in
    // that prompt instead (before_agent_start below).
    pi.on("input", () => {
        cancelPendingStart();
        reg.closed = false;
    });
    // A notice arriving a second time (re-sent after an abort that had not in fact cleared pi's queue) is hidden
    // from the transcript here and from the model in pi-cc-steer's context handler.
    pi.on("message_end", (event) => {
        const m = event.message as { role: string; customType?: string; details?: { noticeId?: string; noticeIds?: string[] } };
        if (m.role !== "custom" || m.customType !== EVENT.taskNotification) return;
        if (!noticeArrived(reg, idsOf(m.details))) return;
        return { message: { ...event.message, display: false, details: { ...m.details, duplicate: true } } as typeof event.message };
    });
    // Any prompt that actually starts a run carries the waiting notices, after the prompt.
    pi.on("before_agent_start", () => {
        const message = takeWaiting(reg);
        return message ? { message } : undefined;
    });
    // Typing while a command runs does not background it; the message waits (Claude Code's default for bash).
    // pi-cc-steer queues it, and Ctrl+B or send-now are how the person moves on sooner.

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async (_event, ctx) => {
        // A timer can outlive its session (replaced by /new, a fork, a resume or a reload); pi then throws on any
        // use of the old ctx. Such a session is closed: never idle, never starts a turn.
        if (typeof ctx?.isIdle === "function") {
            reg.isIdle = () => {
                try {
                    return ctx.isIdle();
                } catch {
                    reg.closed = true;
                    return false;
                }
            };
        }
        reg.startsTurns = ctx?.mode === undefined || ctx.mode === "tui";
        reg.nonInteractive = detectNonInteractive(
            process.argv,
            Boolean(process.stdin.isTTY)
        );
        // Housekeeping: drop logs from previous sessions older than 24h.
        sweepStaleLogs();
    });

    // ── Session shutdown ──────────────────────────────────────────
    pi.on("session_shutdown", async () => {
        // Kill ALL running tasks on ANY shutdown reason, so no orphans
        // outlive the session. The silent-kill path latches `notified`, so
        // no <task-notification> fires on the way out. Log files are left
        // for the next session's stale sweep.
        const kills: Promise<void>[] = [];
        for (const job of reg.jobs.values()) {
            if (job.status === "running") {
                kills.push(terminateJobSilently(reg, job, "session_shutdown"));
            }
        }
        // Bounded by the SIGTERM grace window (kills run in parallel).
        await Promise.all(kills);
    });

    return {
        hasForeground: () => reg.foreground.size > 0,
        backgroundAll: (ctx) => backgroundActiveForeground(reg, ctx),
        deliverMidRun: (queuedInPi) => deliverMidRun(reg, pi, queuedInPi),
        deliverHeld: (withNextMessage) => deliverHeld(reg, pi, withNextMessage),
        setPersonPending: (check) => {
            reg.personPending = check;
        },
        promptSubmitted: (text, source, kind) => {
            const s: Submission = { text, source, reached: false };
            cancelPendingStart();
            reg.submissions.push(s);
            // A message is held however long other extensions take over it: a notice turn started meanwhile would
            // get it rejected. A command may never reach pi's input handlers, so it is held briefly.
            if (kind !== "command") return;
            s.timer = setTimeout(() => release((x) => x !== s), 5_000);
            s.timer.unref?.();
        },
        submissionReached: (text, source, idle) => {
            const unreached = reg.submissions.filter((s) => !s.reached);
            // By text; else (another extension rewrote it on its way) the oldest from the same origin.
            const s =
                unreached.find((x) => text === x.text || text.startsWith(`${x.text}\n`)) ??
                unreached.find((x) => x.source === source);
            if (!s) return;
            // Older ones from the editor that have still not arrived were swallowed by another extension.
            const dropped = s.source === "interactive" ? unreached.slice(0, unreached.indexOf(s)).filter((x) => x.source === "interactive" && !x.timer) : [];
            if (idle) s.reached = true;
            // pi busy: it is queued now (by pi-cc-steer, or by pi for a template): a notice sent later goes behind it.
            release((x) => !dropped.includes(x) && (idle || x !== s));
        },
    };
}
