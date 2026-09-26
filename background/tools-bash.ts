/*
 * Background bash for pi-cc-steer. Adapted from pi-bg-tasks 0.1.4 (MIT, © patty.io, © cyzlmh;
 * https://github.com/cyzlmh/pi-extensions), itself a fork of pi-patty-bg-tasks. See ./LICENSE.
 */
/**
 * `bash` tool override.
 *
 * Single file-descriptor backend (no tmux):
 *   - run_in_background=true spawns immediately and returns a job handle
 *   - foreground commands race completion against backgrounding
 *   - a 2s quick-completion window skips the backgrounding machinery
 *   - Ctrl+Shift+B (manual) or the timeout timer move a command to background
 */

import type {
    AgentToolResult,
    AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { unlinkSync } from "node:fs";
import type { BgRegistry } from "./registry.ts";
import {
    add,
    createRunningJob,
    logPathFor,
    newJobId,
    readLogTail,
} from "./registry.ts";
import {
    LOG_DIR,
    DEFAULT_TIMEOUT_MS,
    OUTPUT_PREVIEW_CHARS,
    QUICK_COMPLETION_MS,
    type BackgroundReason,
    type ForegroundSlot,
    type SpawnExit,
    type UiContext,
} from "./types.ts";
import { spawnWithFileOutput, killProcessTree } from "./spawn.ts";
import { streamLog } from "./output.ts";
import { showBackgroundHint, clearBackgroundHint } from "./ui.ts";
import {
    assertJobSlot,
    isBlankCommand,
    promoteToBackground,
    requireExistingCwd,
    startBackgroundJob,
} from "./lifecycle.ts";

/** UI context + cwd is all this tool needs from the host context. */
type BashCtx = UiContext & { cwd: string };

const bashParamSchema = Type.Object({
    command: Type.String({ description: "Shell command to run" }),
    timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 120)" })
    ),
    run_in_background: Type.Optional(
        Type.Boolean({
            description:
                "Set to true to run this command in the background immediately. " +
                `Output is saved to ${LOG_DIR}/<taskId>.log.`,
        })
    ),
    description: Type.Optional(
        Type.String({ description: "Short description of what this command does" })
    ),
});

type BashParams = {
    command: string;
    timeout?: number;
    run_in_background?: boolean;
    description?: string;
};

function textBlock(s: string): { type: "text"; text: string } {
    return { type: "text" as const, text: s };
}

/** Appended to every backgrounded result so the model doesn't immediately
 *  start polling the task it just handed off (kimi-style next_step hint). */
const NO_WAIT_HINT =
    "next_step: You will be automatically notified when it completes — " +
    "do NOT wait, poll, or call bg_output to wait on it; continue with your current work.";

/** Register the overridden `bash` tool. The original definition is spread so
 *  the override inherits pi's native renderCall/renderResult. */
export function registerBashTool(
    pi: ExtensionAPI,
    reg: BgRegistry,
    originalBash: ReturnType<typeof createBashToolDefinition>
): void {
    pi.registerTool({
        ...originalBash,
        name: "bash",
        description:
            "Run a bash command. Long-running commands auto-background after the timeout. " +
            "Set run_in_background=true to start in the background immediately. " +
            "The user can press Ctrl+B to move a running command to the background.",
        promptSnippet:
            "Run shell commands; long-running commands auto-background, or use run_in_background=true",
        promptGuidelines: [
            "Use bash with run_in_background=true when a command is expected to run for a long time (dev servers, watchers, long builds).",
            "After starting a background command, do NOT wait on it or poll its output — you will be automatically notified when it completes; continue with other work or return control to the user.",
            "Never block the turn with a bare `sleep N` or a long foreground polling loop. If a readiness gate is truly unavoidable (e.g. wait for a server to print READY before running tests), use a bounded foreground poll with a short timeout (e.g. `timeout 30 bash -c 'until grep -q READY log; do sleep 0.5; done'`) — it auto-backgrounds at the timeout and you will be notified.",
            "Check background task status with bg_list; read a task's output with bg_output (a non-blocking snapshot); stop one with bg_stop.",
        ],
        parameters: bashParamSchema,

        async execute(toolCallId, params, signal, onUpdate, ctx) {
            const p = params as BashParams;
            const bashCtx = ctx as BashCtx;

            if (isBlankCommand(p.command)) throw new Error("Command is empty.");
            requireExistingCwd(bashCtx.cwd);
            assertJobSlot(reg);

            const displayCommand = p.command;

            // Explicit background mode — spawn and return immediately.
            if (p.run_in_background) {
                return spawnBackground({
                    toolCallId,
                    command: p.command,
                    displayCommand,
                    name: p.description,
                    cwd: bashCtx.cwd,
                    reg,
                    pi,
                    ctx: bashCtx,
                });
            }

            // Foreground mode — race completion against backgrounding.
            return runForeground({
                toolCallId,
                command: p.command,
                displayCommand,
                timeoutMs: p.timeout ? p.timeout * 1000 : DEFAULT_TIMEOUT_MS,
                signal,
                onUpdate,
                ctx: bashCtx,
                reg,
                pi,
            });
        },
    });
}

// --- Foreground backend --------------------------------------------------

async function runForeground(args: {
    toolCallId: string;
    command: string;
    displayCommand?: string;
    timeoutMs: number;
    signal: AbortSignal | undefined;
    onUpdate: AgentToolUpdateCallback<undefined> | undefined;
    ctx: BashCtx;
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
}): Promise<AgentToolResult<undefined>> {
    const { toolCallId, command, displayCommand, timeoutMs, signal, onUpdate, ctx, reg, pi } = args;
    const id = newJobId(reg);
    const logPath = logPathFor(id);

    // Spawn WITHOUT wiring the turn signal to a process kill. Backgrounding
    // (Ctrl+Shift+B / timeout) asks the turn to end while the process keeps
    // running; if the turn signal killed the process group, that abort would
    // kill the very command we just backgrounded. We manage the signal
    // manually and only kill on a genuine cancel (abort with no pause
    // requested — e.g. Esc).
    const spawned = spawnWithFileOutput({ command, cwd: ctx.cwd, logPath });

    // Register the foreground slot so Ctrl+Shift+B can find this command.
    let pauseRequested = false;
    let handedToBackground = false;
    let pauseResolve: ((reason: BackgroundReason) => void) | null = null;
    const pausePromise = new Promise<BackgroundReason>((r) => {
        pauseResolve = r;
    });
    const requestPause = (reason: BackgroundReason) => {
        pauseRequested = true;
        pauseResolve?.(reason);
    };

    const onTurnAbort = () => {
        if (!pauseRequested) killProcessTree(spawned.pid, "SIGTERM");
    };
    if (signal) {
        if (signal.aborted) onTurnAbort();
        else signal.addEventListener("abort", onTurnAbort);
    }

    const slot: ForegroundSlot = { requestPause };
    reg.foreground.set(toolCallId, slot);

    const job = createRunningJob({
        id,
        command: displayCommand ?? command,
        pid: spawned.pid,
        logPath,
        toolCallId,
        isBackgrounded: false,
    });
    // Foreground jobs are tracked for Ctrl+Shift+B but not counted as
    // "started" until they actually move to the background (promoteToBackground).
    reg.jobs.set(id, job);

    // Timeout timer — promote to background; in print/non-TTY mode there is
    // no one to background FOR, so the command simply runs to completion.
    const timeoutTimer = setTimeout(() => {
        if (reg.nonInteractive) return;
        if (!reg.foreground.has(toolCallId)) return;
        requestPause("timeout");
    }, timeoutMs);
    timeoutTimer.unref();

    let progressPoller: { stop: () => void } | undefined;
    let hintShown = false;

    const cleanup = () => {
        progressPoller?.stop();
        clearTimeout(timeoutTimer);
        if (signal) signal.removeEventListener("abort", onTurnAbort);
    };

    // Foreground completion (quick or normal): read output, surface errors.
    // Registry teardown happens in `finally` so no exit path can strand the job.
    const finishForeground = (exit: SpawnExit): AgentToolResult<undefined> => {
        const output = readLogTail(job, OUTPUT_PREVIEW_CHARS);
        // Cancelled (Esc, or a send-now): report it the way pi's own bash does, so the
        // interruption reads the same as without this extension.
        if (signal?.aborted) throw new Error(`${output === "(no output yet)" ? "" : output}\n\nCommand aborted`.trimStart());
        // Any other signal death is a deliberate kill, not a command failure — never an error result.
        if (exit.signal === null && exit.code !== 0) {
            throw new Error(output || `Command exited with code ${exit.code ?? 1}`);
        }
        return { content: [textBlock(output || "(no output)")], details: undefined };
    };

    try {
        // Quick completion window (2s).
        const quickResult = await Promise.race<SpawnExit | null>([
            spawned.exit,
            new Promise<null>((r) => {
                const t = setTimeout(() => r(null), QUICK_COMPLETION_MS);
                t.unref();
            }),
        ]);

        if (quickResult !== null) {
            return finishForeground(quickResult);
        }

        // Still running past the quick window — start progress polling and
        // show the "(ctrl+shift+b to run in background)" hint.
        progressPoller = streamLog(logPath, onUpdate);
        showBackgroundHint(ctx);
        hintShown = true;

        // Race: completion vs backgrounding.
        const race = await Promise.race<
            | { kind: "completed"; exit: SpawnExit }
            | { kind: "backgrounded"; reason: BackgroundReason }
        >([
            spawned.exit.then((exit) => ({ kind: "completed" as const, exit })),
            pausePromise.then((reason) => ({ kind: "backgrounded" as const, reason })),
        ]);

        if (race.kind === "backgrounded") {
            if (!handedToBackground) {
                handedToBackground = true;
                // Hand-off point: the job now outlives the turn, so it must no
                // longer keep the process alive (foreground waits rely on the
                // ref'd handle to survive headless event-loop drains).
                spawned.proc.unref();
                promoteToBackground({ reg, pi, ctx, job, exit: spawned.exit, toolCallId });
            }
            const head =
                race.reason === "manual"
                    ? `Command was manually backgrounded by user with ID: ${id}.`
                    : `Command auto-backgrounded after ${Math.round(timeoutMs / 1000)}s with ID: ${id}.`;
            return {
                content: [textBlock(`${head} Output is being written to: ${logPath}\n${NO_WAIT_HINT}`)],
                details: undefined,
            };
        }

        // Normal completion.
        return finishForeground(race.exit);
    } finally {
        // Single teardown for every exit path (return, throw, background hand-off).
        cleanup();
        if (hintShown) clearBackgroundHint(ctx);
        reg.foreground.delete(toolCallId);
        if (!handedToBackground) {
            reg.jobs.delete(id);
            try { unlinkSync(logPath); } catch { /* best-effort */ }
        }
    }
}

// --- Background backend --------------------------------------------------

function spawnBackground(args: {
    toolCallId: string;
    command: string;
    displayCommand?: string;
    name?: string;
    cwd: string;
    reg: BgRegistry;
    pi: Pick<ExtensionAPI, "sendMessage">;
    ctx: UiContext;
}): AgentToolResult<undefined> {
    const id = newJobId(args.reg);
    const logPath = logPathFor(id);

    const spawned = spawnWithFileOutput({
        command: args.command,
        cwd: args.cwd,
        logPath,
    });
    // Background from birth: the job must not keep pi's event loop alive.
    spawned.proc.unref();

    const job = createRunningJob({
        id,
        name: args.name,
        command: args.displayCommand ?? args.command,
        pid: spawned.pid,
        logPath,
        toolCallId: args.toolCallId,
    });
    add(args.reg, job);
    startBackgroundJob({ reg: args.reg, pi: args.pi, ctx: args.ctx, job, exit: spawned.exit });

    return {
        content: [
            textBlock(
                `Command running in background with ID: ${id}. Output is being written to: ${logPath}\n${NO_WAIT_HINT}`
            ),
        ],
        details: undefined,
    };
}
