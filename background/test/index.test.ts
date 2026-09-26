/**
 * Extension smoke test with a mock ExtensionAPI: registration surface,
 * run_in_background → completion notification, foreground quick path,
 * Ctrl+Shift+B manual background, typing leaves the command running, and
 * silent session-shutdown kills.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { statSync, unlinkSync } from "node:fs";
import { registerBackground } from "../index.ts";
import { EVENT } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process marker unique to this test run, so pgrep can't hit strangers. */
const MARKER = `bg-tasks-shutdown-test-${process.pid}`;
const WATCH_CMD = `while true; do sleep 1; done # ${MARKER}`;

function liveMarkedProcesses(): number {
    try {
        const out = execSync(
            `pgrep -f "[w]hile true; do sleep 1; done # ${MARKER}" | wc -l`,
            { encoding: "utf-8" }
        );
        return Number.parseInt(out.trim(), 10);
    } catch {
        return 0;
    }
}

interface CapturedTool {
    name: string;
    execute: (
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: unknown,
        ctx: unknown
    ) => Promise<{ content: { type: "text"; text: string }[] }>;
}

type SessionHandler = (event: { reason?: string }, ctx: unknown) => Promise<void>;
type ShortcutHandler = (ctx: unknown) => Promise<void> | void;

function makePi() {
    const tools = new Map<string, CapturedTool>();
    const handlers = new Map<string, SessionHandler>();
    const shortcuts = new Map<string, ShortcutHandler>();
    const commands = new Map<string, unknown>();
    const renderers = new Map<string, unknown>();
    const messages: { customType: string; content: string; details?: { status?: string } }[] = [];
    const pi = {
        registerTool(def: CapturedTool) {
            tools.set(def.name, def);
        },
        registerShortcut(key: string, opts: { handler: ShortcutHandler }) {
            shortcuts.set(key, opts.handler);
        },
        registerCommand(name: string, opts: unknown) {
            commands.set(name, opts);
        },
        registerMessageRenderer(customType: string, renderer: unknown) {
            renderers.set(customType, renderer);
        },
        on(event: string, handler: SessionHandler) {
            // pi calls every handler for an event, in order
            const prev = handlers.get(event);
            handlers.set(event, prev ? (async (e: never, c: never) => (await prev(e, c), handler(e, c))) as SessionHandler : handler);
        },
        sendMessage(msg: { customType: string; content: string }) {
            messages.push(msg);
        },
    };
    return { pi, tools, handlers, shortcuts, commands, renderers, messages };
}

const uiCtx = {
    cwd: process.cwd(),
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
    },
};

function startExtension() {
    const h = makePi();
    const bg = registerBackground(h.pi as never);
    return { ...h, bg };
}

void describe("registration surface", () => {
    void it("registers the bash override, three task tools, shortcut, commands, renderer", () => {
        const h = startExtension();
        assert.deepEqual([...h.tools.keys()].sort(), ["bash", "bg_list", "bg_output", "bg_stop"]);
        assert.ok(h.shortcuts.has("ctrl+shift+b"), "Ctrl+Shift+B (Ctrl+B is pi's cursor-left)");
        assert.ok(h.commands.has("bg"));
        assert.ok(h.commands.has("bg-tasks"));
        assert.ok(h.renderers.has(EVENT.taskNotification));
        assert.ok(h.handlers.has("session_start"));
        assert.ok(h.handlers.has("session_shutdown"));
    });
});

void describe("bash run_in_background → completion notification", () => {
    void it("starts a job, and its exit delivers a <task-notification>", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});

        const bash = h.tools.get("bash")!;
        const started = await bash.execute(
            "tc-1",
            { command: "echo hello-bg", run_in_background: true },
            undefined,
            undefined,
            uiCtx
        );
        const id = /with ID: (bash-[0-9a-z]{8})\./.exec(started.content[0].text)?.[1];
        assert.ok(id, `task id in result, got: ${started.content[0].text}`);

        await sleep(500); // let the exit handler fire

        const notifications = h.messages.filter((m) => m.customType === EVENT.taskNotification);
        assert.equal(notifications.length, 1, "exactly one completion notification");
        assert.ok(notifications[0].content.includes(`<task_id>${id}</task_id>`));
        assert.ok(notifications[0].content.includes("<status>completed</status>"));
        assert.ok(notifications[0].content.includes("hello-bg"), "tail preview carries output");

        // The outcome is visible via the tools.
        const list = await h.tools.get("bg_list")!.execute("tc-2", {}, undefined, undefined, uiCtx);
        assert.ok(list.content[0].text.includes(id));
        const out = await h.tools.get("bg_output")!.execute(
            "tc-3",
            { task_id: id },
            undefined,
            undefined,
            uiCtx
        );
        assert.ok(out.content[0].text.includes("hello-bg"));
    });
});

void describe("foreground bash", () => {
    void it("quick commands return output inline within the 2s window", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const res = await h.tools.get("bash")!.execute(
            "tc-10",
            { command: "echo quick-out" },
            undefined,
            undefined,
            uiCtx
        );
        assert.equal(res.content[0].text.trim(), "quick-out");
        assert.equal(h.messages.length, 0, "no notification for foreground completion");
    });

    void it("a failing quick command throws its output", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        await assert.rejects(
            h.tools.get("bash")!.execute(
                "tc-11",
                { command: "echo boom >&2; exit 3" },
                undefined,
                undefined,
                uiCtx
            ),
            /boom/
        );
    });

    void it("Ctrl+Shift+B backgrounds a running foreground command", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const bash = h.tools.get("bash")!;
        const pending = bash.execute(
            "tc-12",
            { command: `sleep 30 # ${MARKER}-fg` },
            undefined,
            undefined,
            uiCtx
        );
        await sleep(2_500); // past the quick-completion window
        await h.shortcuts.get("ctrl+shift+b")!(uiCtx);
        const res = await pending;
        const id = /with ID: (bash-[0-9a-z]{8})\./.exec(res.content[0].text)?.[1];
        assert.ok(id, `manually backgrounded, got: ${res.content[0].text}`);
        assert.ok(res.content[0].text.includes("manually backgrounded"));

        // It's a tracked background job now; clean up via bg_stop.
        const stopped = await h.tools.get("bg_stop")!.execute(
            "tc-13",
            { task_id: id },
            undefined,
            undefined,
            uiCtx
        );
        assert.ok(stopped.content[0].text.includes("stopped"));
        assert.equal(
            h.messages.filter((m) => m.customType === EVENT.taskNotification).length,
            0,
            "a deliberate stop sends no notification"
        );
    });
});

void describe("typing while a command runs", () => {
    void it("a message typed mid-command does not background it: the command runs to the end (Claude Code's default)", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        await h.handlers.get("input")!({ source: "interactive", streamingBehavior: "steer", text: "hurry" } as never, uiCtx);
        const pending = h.tools.get("bash")!.execute("tc-30", { command: "sleep 3; echo still-foreground" }, undefined, undefined, uiCtx);
        const res = await pending;
        assert.ok(res.content[0].text.includes("still-foreground"), `ran in the foreground, got: ${res.content[0].text}`);
    });
});

void describe("cancelling and failures (regressions)", () => {
    void it("Esc stops a command that ignores SIGTERM, and it cannot then be backgrounded", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const ac = new AbortController();
        const pending = h.tools.get("bash")!.execute(
            "tc-40",
            { command: `trap '' TERM; while :; do sleep 1; done # ${MARKER}-trap` },
            ac.signal,
            undefined,
            uiCtx
        );
        await sleep(2_500);
        ac.abort();
        const toasts: string[] = [];
        const ctxNotes = { ...uiCtx, ui: { ...uiCtx.ui, notify: (m: string) => toasts.push(m) } };
        await h.shortcuts.get("ctrl+shift+b")!(ctxNotes); // too late: the command is being stopped
        assert.equal(toasts.some((t) => t.includes("Backgrounded")), false, "no false 'Backgrounded' message");
        await assert.rejects(pending, /Command aborted/);
        await sleep(300);
        assert.equal(liveMarkedProcesses(), 0);
        assert.equal(
            execSync(`pgrep -f "[t]rap '' TERM; while :; do sleep 1; done # ${MARKER}-trap" | wc -l`, { encoding: "utf-8" }).trim(),
            "0"
        );
    });

    void it("a command killed from outside is a failure, not a success", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        await assert.rejects(
            h.tools.get("bash")!.execute("tc-41", { command: "kill -KILL $$" }, undefined, undefined, uiCtx),
            /terminated by SIGKILL/
        );
    });

    void it("long output keeps the full log and names it", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const res = await h.tools.get("bash")!.execute(
            "tc-42",
            { command: "head -c 20000 /dev/zero | tr '\\0' x" },
            undefined,
            undefined,
            uiCtx
        );
        const path = /\[Full output: (\S+)\]/.exec(res.content[0].text)?.[1];
        assert.ok(path, `full-output path in result, got tail: ${res.content[0].text.slice(-120)}`);
        assert.equal(statSync(path).size, 20000);
        unlinkSync(path);
    });

    void it("in print mode an explicit timeout stops the command, as pi's bash does", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {}); // tests run without a TTY: non-interactive
        await assert.rejects(
            h.tools.get("bash")!.execute("tc-44", { command: "sleep 10", timeout: 1 }, undefined, undefined, uiCtx),
            /timed out after 1 seconds/
        );
    });

    void it("ending the session also stops a child that ignores SIGTERM", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const cmd = `bash -c "trap '' TERM; while :; do sleep 1; done # ${MARKER}-child" & wait`;
        await h.tools.get("bash")!.execute("tc-45", { command: cmd, run_in_background: true }, undefined, undefined, uiCtx);
        await sleep(500);
        const count = () =>
            execSync(`pgrep -f "[t]rap '' TERM; while :; do sleep 1; done # ${MARKER}-child" | wc -l`, { encoding: "utf-8" }).trim();
        assert.notEqual(count(), "0", "child is running");
        await h.handlers.get("session_shutdown")!({ reason: "reload" }, {});
        await sleep(300);
        assert.equal(count(), "0", "no survivor after shutdown");
    });

    void it("stopping a job still gives its children the grace window to clean up", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const done = `${process.env.TMPDIR ?? "/tmp"}/bg-grace-${process.pid}`;
        const cmd = `bash -c "trap 'sleep 1; echo cleaned > ${done}; exit' TERM; while :; do sleep 0.2; done # ${MARKER}-grace" & wait`;
        const started = await h.tools.get("bash")!.execute("tc-46", { command: cmd, run_in_background: true }, undefined, undefined, uiCtx);
        const id = /with ID: (bash-[0-9a-z]{8})\./.exec(started.content[0].text)?.[1];
        await sleep(500);
        await h.tools.get("bg_stop")!.execute("tc-47", { task_id: id }, undefined, undefined, uiCtx);
        await sleep(200);
        assert.equal(statSync(done, { throwIfNoEntry: false })?.isFile(), true, "the child finished its cleanup");
        unlinkSync(done);
    });

    void it("a pending notice turn is cancelled by a prompt, and never started once a session switch begins", async () => {
        for (const cancel of ["input", "session_before_switch", "session_shutdown"]) {
            const h = startExtension();
            await h.handlers.get("session_start")!({}, { isIdle: () => false });
            await h.tools.get("bash")!.execute("tc-48", { command: "true", run_in_background: true }, undefined, undefined, uiCtx);
            await sleep(300);
            await h.handlers.get("session_start")!({}, { isIdle: () => true });
            h.bg.deliverHeld(false); // schedules the turn
            await h.handlers.get(cancel)!({ source: "interactive", text: "hi" } as never, uiCtx);
            await sleep(20);
            assert.equal(h.messages.filter((m) => m.customType === EVENT.taskNotification).length, 0, `${cancel}: no turn`);
            if (cancel !== "input") {
                h.bg.deliverHeld(false); // a run settling during the switch schedules again
                await sleep(20);
                assert.equal(h.messages.filter((m) => m.customType === EVENT.taskNotification).length, 0, `${cancel}: still none`);
            }
        }
    });

    void it("Enter on a prompt holds notice turns until that prompt's run starts; its notices ride in it", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, { isIdle: () => true });
        h.bg.promptSubmitted();
        await h.tools.get("bash")!.execute("tc-49", { command: "true", run_in_background: true }, undefined, undefined, uiCtx);
        await sleep(300);
        const notices = () => h.messages.filter((m) => m.customType === EVENT.taskNotification).length;
        assert.equal(notices(), 0, "no turn while the person's prompt is being prepared");
        const r = (await h.handlers.get("before_agent_start")!({} as never, uiCtx)) as unknown as { message?: { content: string } };
        assert.match(r.message!.content, /<task-notification>/, "it rides in that prompt");
        await h.handlers.get("agent_start")!({} as never, uiCtx);
    });

    void it("a cancelled session switch does not stop notice turns for good: the next input or run re-enables them", async () => {
        for (const resume of ["input", "agent_start"]) {
            const h = startExtension();
            await h.handlers.get("session_start")!({}, { isIdle: () => true });
            await h.handlers.get("session_before_switch")!({} as never, uiCtx); // then cancelled by another extension
            await h.handlers.get(resume)!({ source: "interactive", text: "carry on" } as never, uiCtx);
            await h.tools.get("bash")!.execute("tc-50", { command: "true", run_in_background: true }, undefined, undefined, uiCtx);
            await sleep(300);
            assert.equal(h.messages.filter((m) => m.customType === EVENT.taskNotification).length, 1, `${resume}: idle notice starts a turn again`);
        }
    });

    void it("a message of the person's arriving ends its submission's hold (a template typed during a run)", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, { isIdle: () => true });
        h.bg.promptSubmitted();
        await h.handlers.get("message_end")!({ message: { role: "user", content: "expanded template" } } as never, uiCtx);
        await h.tools.get("bash")!.execute("tc-51", { command: "true", run_in_background: true }, undefined, undefined, uiCtx);
        await sleep(300);
        assert.equal(h.messages.filter((m) => m.customType === EVENT.taskNotification).length, 1, "no longer held");
    });

    void it("a job that finishes mid-run is held, then delivered once when the run ends", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        await h.handlers.get("session_start")!({}, { isIdle: () => false });
        await h.tools.get("bash")!.execute("tc-43", { command: "true", run_in_background: true }, undefined, undefined, uiCtx);
        await sleep(400);
        const notices = () => h.messages.filter((m) => m.customType === EVENT.taskNotification).length;
        assert.equal(notices(), 0, "held while the run is going");
        await h.handlers.get("session_start")!({}, { isIdle: () => true });
        h.bg.deliverHeld(false);
        await sleep(20);
        const sent = h.messages.find((m) => m.customType === EVENT.taskNotification) as { details?: unknown } | undefined;
        await h.handlers.get("message_end")!({ message: { role: "custom", customType: EVENT.taskNotification, details: sent?.details } } as never, uiCtx);
        h.bg.deliverHeld(false);
        await sleep(20);
        assert.equal(notices(), 1, "delivered once when the run ends");
    });
});

void describe("session_shutdown", () => {
    void it("kills running tasks silently on any reason", async () => {
        const h = startExtension();
        await h.handlers.get("session_start")!({}, {});
        const bash = h.tools.get("bash")!;
        const started = await bash.execute(
            "tc-20",
            { command: WATCH_CMD, run_in_background: true },
            undefined,
            undefined,
            uiCtx
        );
        const id = /with ID: (bash-[0-9a-z]{8})\./.exec(started.content[0].text)?.[1];
        assert.ok(id);
        assert.ok(liveMarkedProcesses() > 0, "task process is running");

        await h.handlers.get("session_shutdown")!({ reason: "reload" }, {});
        await sleep(200);

        assert.equal(liveMarkedProcesses(), 0, "no orphaned process survives");
        assert.equal(
            h.messages.filter((m) => m.customType === EVENT.taskNotification).length,
            0,
            "silent kill — no <task-notification> on the way out"
        );
        const list = await h.tools.get("bg_list")!.execute("tc-21", {}, undefined, undefined, uiCtx);
        assert.ok(list.content[0].text.includes("killed"), `task ended up killed, got: ${list.content[0].text}`);
    });
});

after(() => {
    // Best-effort cleanup if a test failed mid-flight.
    try {
        execSync(`pkill -f "${MARKER}" || true`);
    } catch {
        /* already gone */
    }
});
