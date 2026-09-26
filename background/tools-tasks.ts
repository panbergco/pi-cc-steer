/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * The three task-management tools: bg_list, bg_output, bg_stop.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BgRegistry } from "./registry.ts";
import { findJob, readLogTail, sweepNotifiedTerminal } from "./registry.ts";
import {
    isTerminalStatus,
    TASK_OUTPUT_TAIL_CHARS,
    SIGTERM_GRACE_MS,
    type BgJob,
} from "./types.ts";
import { terminateJobSilently } from "./lifecycle.ts";
import { markNotified } from "./notify.ts";
import { formatJobList, renderStatusPill } from "./ui.ts";
import { stripAnsi } from "./output.ts";

function textBlock(s: string): { type: "text"; text: string } {
    return { type: "text" as const, text: s };
}

function textResult(text: string): { content: { type: "text"; text: string }[]; details: undefined } {
    return { content: [textBlock(text)], details: undefined };
}

/** Latch a terminal job's outcome as known (suppresses the
 *  <task-notification>) and evict it to the recent-terminal ring. */
function latchTerminalOutcome(reg: BgRegistry, job: BgJob): void {
    if (!isTerminalStatus(job.status)) return;
    markNotified(job);
    sweepNotifiedTerminal(reg);
}

function jobMetaLines(job: BgJob): string[] {
    const lines = [
        `Task: ${job.id}`,
        `Status: ${job.status}${job.exitCode !== undefined ? ` (exit code ${job.exitCode})` : ""}`,
        `Command: ${job.command}`,
        `Log: ${job.logPath}`,
    ];
    if (job.stopReason) lines.push(`Stop reason: ${job.stopReason}`);
    return lines;
}

/** Register bg_list / bg_output / bg_stop. */
export function registerTaskTools(pi: ExtensionAPI, reg: BgRegistry): void {
    pi.registerTool({
        name: "bg_list",
        label: "Background Task List",
        description:
            "List background tasks: running tasks first, then recently finished ones. " +
            "Returns task IDs for use with bg_output and bg_stop.",
        promptSnippet: "List background tasks and their status",
        parameters: Type.Object({}),

        async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
            sweepNotifiedTerminal(reg);
            // The sweep may bump the lifetime counters — refresh the pill.
            if (ctx) renderStatusPill(reg, ctx);
            return textResult(formatJobList(reg));
        },
    });

    pi.registerTool({
        name: "bg_output",
        label: "Background Task Output",
        description:
            "Read a background task's output. Non-blocking: returns the task's meta info, " +
            "a tail preview of its log, and the log path. Use the Read tool to page " +
            "through the full log file for more.",
        promptSnippet: "Read a background task's output tail",
        parameters: Type.Object({
            task_id: Type.String({ description: "Task ID (from bash run_in_background or bg_list)" }),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const { task_id: taskId } = params as { task_id: string };
            const job = findJob(reg, taskId);
            if (!job) {
                throw new Error(
                    `Unknown task: ${taskId}. Use bg_list to see running and recent tasks.`
                );
            }
            latchTerminalOutcome(reg, job);
            if (ctx) renderStatusPill(reg, ctx);

            const tail = stripAnsi(readLogTail(job, TASK_OUTPUT_TAIL_CHARS));
            return textResult(
                [
                    ...jobMetaLines(job),
                    "",
                    "--- output tail (last 32 KiB) ---",
                    tail,
                    "",
                    `Full log: ${job.logPath} (use the Read tool with offset/limit to page through it)`,
                ].join("\n")
            );
        },
    });

    pi.registerTool({
        name: "bg_stop",
        label: "Background Task Stop",
        description:
            "Stop a running background task: SIGTERM, then SIGKILL after a 5s grace " +
            "window if it refuses to exit. Returns the final status.",
        promptSnippet: "Stop a running background task",
        parameters: Type.Object({
            task_id: Type.String({ description: "Task ID (from bash run_in_background or bg_list)" }),
            reason: Type.Optional(
                Type.String({ description: "Why the task is being stopped" })
            ),
        }),

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const { task_id: taskId, reason } = params as { task_id: string; reason?: string };
            const job = findJob(reg, taskId);
            if (!job) {
                throw new Error(
                    `Unknown task: ${taskId}. Use bg_list to see running and recent tasks.`
                );
            }

            if (isTerminalStatus(job.status)) {
                latchTerminalOutcome(reg, job);
                if (ctx) renderStatusPill(reg, ctx);
                return textResult(
                    [...jobMetaLines(job), "", `Task ${job.id} already ${job.status}.`].join("\n")
                );
            }

            // Latch BEFORE the kill so the exit handler's notification is
            // suppressed — a deliberate stop is intentional cleanup the agent
            // already knows about. markTerminal flips the status
            // synchronously; the kill promise tracks the actual death.
            const kill = terminateJobSilently(reg, job, reason);
            // Wait for the process to actually die, bounded by the grace
            // window, so the tool returns the real outcome.
            const deadline = new Promise<void>((r) => {
                const t = setTimeout(r, SIGTERM_GRACE_MS + 1_000);
                t.unref();
            });
            await Promise.race([kill, deadline]);

            // markTerminal flipped the status synchronously and the awaited
            // kill ran forget() (its .then was registered first), so the
            // lifetime counters are current — refresh the pill so a stopped
            // task leaves the running count immediately.
            if (ctx) renderStatusPill(reg, ctx);

            return textResult(
                [...jobMetaLines(job), "", `Task ${job.id} stopped (SIGTERM → 5s grace → SIGKILL).`].join("\n")
            );
        },
    });
}
