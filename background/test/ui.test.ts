import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerUi, renderStatusPill } from "../ui.ts";
import { add, BgRegistry, createRunningJob, forget } from "../registry.ts";
import { markTerminal } from "../lifecycle.ts";
import type { BgJob, UiContext } from "../types.ts";

/** Mock UiContext that records the last status text; theme.fg passes through. */
function statusHarness() {
    const calls: unknown[] = [];
    const ctx = {
        ui: {
            notify() {},
            setWidget() {},
            setStatus(_name: string, content: unknown) {
                calls.push(content);
            },
            theme: { fg: (_c: string, t: string) => t },
        },
    } as unknown as UiContext;
    return { ctx, calls, last: () => calls[calls.length - 1] };
}

function mkRunningJob(reg: BgRegistry, over: Partial<BgJob> = {}): BgJob {
    const job = createRunningJob({
        id: `bash-${Math.random().toString(36).slice(2, 10)}`,
        command: "sleep 60",
        pid: 999999,
        logPath: "/tmp/pi-bg-tasks/test.log",
        toolCallId: "tc-1",
        ...over,
    });
    return add(reg, job);
}

void describe("task notification renderer", () => {
    void it("truncates messages to the current terminal width", () => {
        let renderer:
            | ((message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] })
            | undefined;
        const pi = {
            registerShortcut() {},
            registerCommand() {},
            registerMessageRenderer(_type: string, value: unknown) {
                renderer = value as typeof renderer;
            },
        };
        registerUi(pi as never, new BgRegistry());

        const component = renderer!(
            {
                content: "",
                details: {
                    status: "completed",
                    summary: 'Background command "Launch full translation in background" completed (exit code 0)',
                },
            },
            {},
            { fg: (_colour: string, text: string) => text }
        );

        for (const width of [1, 54]) {
            const [line] = component.render(width);
            assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
        }
    });
});

void describe("renderStatusPill", () => {
    void it("shows only the running count for backgrounded jobs", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        mkRunningJob(reg);
        mkRunningJob(reg);
        renderStatusPill(reg, ctx);
        assert.equal(last(), "▶ 2");
    });

    void it("does not count foreground jobs", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        mkRunningJob(reg, { isBackgrounded: false });
        renderStatusPill(reg, ctx);
        assert.equal(last(), undefined);
    });

    void it("distinguishes running / completed / failed segments", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        mkRunningJob(reg);
        // Two finished-and-evicted jobs: one completed, one failed.
        for (const status of ["completed", "failed"] as const) {
            const job = mkRunningJob(reg);
            markTerminal(job, status, status === "completed" ? 0 : 1);
            forget(reg, job);
        }
        renderStatusPill(reg, ctx);
        assert.equal(last(), "▶ 1 · ✓ 1 · ✗ 1");
    });

    void it("groups killed with failed under ✗", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        const job = mkRunningJob(reg);
        markTerminal(job, "killed");
        forget(reg, job);
        renderStatusPill(reg, ctx);
        assert.equal(last(), "✗ 1");
    });

    void it("clears the pill when there is nothing to report", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        renderStatusPill(reg, ctx);
        assert.equal(last(), undefined);
    });

    void it("a terminal job still in the live map is not counted as running", () => {
        const reg = new BgRegistry();
        const { ctx, last } = statusHarness();
        const job = mkRunningJob(reg);
        markTerminal(job, "completed", 0); // not yet evicted — no counter bump yet
        renderStatusPill(reg, ctx);
        assert.equal(last(), undefined);
    });
});
