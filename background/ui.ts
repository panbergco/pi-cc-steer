/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * UI surface: the "(ctrl+shift+b to run in background)" hint widget, the
 * status-bar pill, the /bg and /bg-tasks commands, the Ctrl+Shift+B
 * shortcut, and the <task-notification> message renderer.
 *
 * Imports only types + registry so lifecycle can use renderStatusPill
 * without an import cycle.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { BgRegistry } from "./registry.ts";
import { isTerminalStatus, type BgJob, type UiContext } from "./types.ts";
import { readLastLine } from "./output.ts";

// --- Background hint widget ----------------------------------------------

const HINT_KEY = "bg-hint";

/**
 * Ref-count of foreground commands currently showing the hint. The widget is
 * a single shared key, but bash commands run in parallel — so we only render
 * it on the 0→1 transition and clear it on the last 1→0. Each caller must
 * pair exactly one showBackgroundHint() with one clearBackgroundHint().
 */
let activeHints = 0;

/** Show the background hint below the editor (idempotent across parallel commands). */
export function showBackgroundHint(ctx: UiContext): void {
    activeHints++;
    if (activeHints === 1) {
        ctx.ui.setWidget(HINT_KEY, [process.env.TMUX ? "(ctrl+b ctrl+b to run in background)" : "(ctrl+b to run in background)"], {
            placement: "belowEditor",
        });
    }
}

/** Release one hint; clears the widget only when the last command is done. */
export function clearBackgroundHint(ctx: UiContext): void {
    if (activeHints === 0) return;
    activeHints--;
    if (activeHints === 0) {
        ctx.ui.setWidget(HINT_KEY, undefined);
    }
}

// --- Status-bar pill ------------------------------------------------------

const STATUS_KEY = "bg-tasks";

/**
 * Render the aggregate status-bar text: running / completed / failed counts
 * shown as separate segments (`▶ 2 · ✓ 3 ✗ 1`), so finished tasks never
 * inflate the running count. Completed/failed come from the registry's
 * lifetime counters (bumped when a terminal job is evicted). Called after
 * any state change that affects the counts; no ticker — the pill is a
 * count, not a live duration.
 */
export function renderStatusPill(reg: BgRegistry, ctx: UiContext): void {
    let running = 0;
    for (const job of reg.jobs.values()) {
        if (!isTerminalStatus(job.status) && job.isBackgrounded) running++;
    }
    const done = reg.completedCount;
    const failed = reg.failedCount + reg.killedCount;
    if (running === 0 && done === 0 && failed === 0) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
    }
    const parts: string[] = [];
    if (running > 0) parts.push(ctx.ui.theme.fg("accent", `▶ ${running}`));
    if (done > 0) parts.push(ctx.ui.theme.fg("success", `✓ ${done}`));
    if (failed > 0) parts.push(ctx.ui.theme.fg("error", `✗ ${failed}`));
    ctx.ui.setStatus(STATUS_KEY, parts.join(ctx.ui.theme.fg("muted", " · ")));
}

// --- Foreground backgrounding ----------------------------------------------

/**
 * Flip every running foreground command into the background. Pure mechanic —
 * the bash tool result already tells the model what happened, so no
 * synthetic agent message is sent, only the UI toast. Returns false when
 * there is nothing in the foreground to pause.
 *
 * It deliberately does NOT call ctx.abort(): in pi, aborting restores any
 * queued message to the editor (unsent), renders "Operation aborted", AND
 * kills the running process — exactly the data-loss we must avoid. Instead,
 * backgrounding makes the bash tool return; the turn ends and any queued
 * message drains at the natural turn boundary.
 */
export function backgroundActiveForeground(reg: BgRegistry, ctx: UiContext): boolean {
    if (reg.foreground.size === 0) {
        ctx.ui.notify("No running foreground process to background.", "warning");
        return false;
    }
    let paused = 0;
    for (const slot of reg.foreground.values()) {
        if (slot.requestPause("manual")) paused++;
    }
    if (paused === 0) return false; // being cancelled: let the key do its normal job
    reg.foreground.clear();
    ctx.ui.notify("▶ Backgrounded — continuing.", "info");
    return true;
}

// --- Formatting -------------------------------------------------------------

function formatDuration(ms: number): string {
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

/** "bash-ab12cd34 [▶ 1m23s] cmd… (last line)" — one line per job. */
export function formatJobLine(job: BgJob): string {
    const head = job.name ? `${job.name} (${job.id})` : job.id;
    const cmd = job.command.replace(/\s+/g, " ").trim().slice(0, 60);
    if (job.status === "running") {
        const dur = formatDuration(Date.now() - job.startTime);
        const progress = readLastLine(job.logPath);
        const suffix = progress ? `: ${progress.slice(0, 60)}` : "";
        return `${head} ▶ ${job.isBackgrounded ? "bg" : "fg"} (${dur}) ${cmd}${suffix}`;
    }
    const glyph = job.status === "completed" ? "✓" : "✗";
    const exit = job.exitCode !== undefined ? ` exit=${job.exitCode}` : "";
    return `${head} ${glyph} ${job.status}${exit} ${cmd}`;
}

/** The bg_list / /bg-tasks text: running jobs first, then recent terminal. */
export function formatJobList(reg: BgRegistry): string {
    const running = [...reg.jobs.values()].filter((j) => !isTerminalStatus(j.status));
    const terminalInMap = [...reg.jobs.values()].filter((j) => isTerminalStatus(j.status));
    const recent = [...terminalInMap, ...reg.recentTerminal].slice(-10).reverse();

    const lines: string[] = [];
    if (running.length === 0 && recent.length === 0) return "No background jobs";
    if (running.length > 0) {
        lines.push(`Running (${running.length}):`);
        for (const job of running) lines.push(`  ${formatJobLine(job)}`);
    }
    if (recent.length > 0) {
        lines.push(`Recent:`);
        for (const job of recent) lines.push(`  ${formatJobLine(job)}`);
    }
    return lines.join("\n");
}

// --- Registration -----------------------------------------------------------

/** Register the /bg and /bg-tasks commands and the Ctrl+Shift+B shortcut. */
export function registerUi(pi: ExtensionAPI, reg: BgRegistry): void {
    // Ctrl+Shift+B — Ctrl+B itself is pi's built-in cursor-left binding and
    // must not be claimed (registering it triggers pi's startup "extension
    // shortcut conflict" diagnostic and breaks cursor-left in the editor).
    pi.registerShortcut("ctrl+shift+b", {
        description: "Background the current foreground process",
        handler: (ctx: ExtensionContext) => {
            backgroundActiveForeground(reg, ctx);
        },
    });

    pi.registerCommand("bg", {
        description: "Background the current foreground process",
        handler: async (_args, ctx) => {
            backgroundActiveForeground(reg, ctx);
        },
    });

    pi.registerCommand("bg-tasks", {
        description: "List background tasks",
        handler: async (_args, ctx) => {
            ctx.ui.notify(formatJobList(reg), "info");
        },
    });

    // <task-notification> messages render as one colored line: green for
    // completed, red for failed, yellow for killed.
    pi.registerMessageRenderer("bg-task-notification", (message, _options, theme) => {
        const details = message.details as
            | { status?: string; summary?: string }
            | undefined;
        const colour =
            details?.status === "completed"
                ? "success"
                : details?.status === "failed"
                  ? "error"
                  : "warning";
        const text = `● ${details?.summary ?? String(message.content)}`;
        return {
            render: (width: number) => [theme.fg(colour, truncateToWidth(text, width))],
            invalidate: () => {},
        };
    });
}
