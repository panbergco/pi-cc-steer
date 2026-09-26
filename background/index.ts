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
import { BgRegistry, sweepStaleLogs } from "./registry.ts";
import { detectNonInteractive, terminateJobSilently } from "./lifecycle.ts";
import { registerBashTool } from "./tools-bash.ts";
import { registerTaskTools } from "./tools-tasks.ts";
import { backgroundActiveForeground, registerUi } from "./ui.ts";
import { deliverHeld } from "./notify.ts";
import type { UiContext } from "./types.ts";

/** What pi-cc-steer needs from the engine. */
export interface Background {
    /** A bash command is running in the foreground and can be backgrounded. */
    hasForeground(): boolean;
    /** Move every foreground bash command to the background. */
    backgroundAll(ctx: UiContext): boolean;
    /** The run ended: deliver finish notices held during it (see notify.ts deliverHeld). */
    deliverHeld(withNextMessage: boolean): void;
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
    pi.on("agent_start", () => {
        reg.agentRunning = true;
        reg.runAborted = false;
    });
    pi.on("turn_end", (event, ctx) => {
        const stop = (event.message as { stopReason?: string }).stopReason;
        if (stop === "aborted" || ctx.signal?.aborted) reg.runAborted = true;
    });
    pi.on("agent_settled", () => {
        reg.agentRunning = false; // pi-cc-steer then calls deliverHeld for what arrived during the run
    });

    // No input hook: a message typed while a command runs waits for it (Claude Code's default for bash);
    // pi-cc-steer queues it, and Ctrl+B or send-now are how the person moves on sooner.

    // ── Session start ─────────────────────────────────────────────
    pi.on("session_start", async () => {
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
        deliverHeld: (withNextMessage) => deliverHeld(reg, pi, withNextMessage),
    };
}
