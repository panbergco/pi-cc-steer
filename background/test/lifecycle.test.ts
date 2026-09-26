import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    completeJob,
    markTerminal,
    statusFromExit,
    startBackgroundJob,
    terminateJobSilently,
} from "../lifecycle.ts";
import { add, BgRegistry, createRunningJob, newJobId } from "../registry.ts";
import { killWithGrace, processExists, spawnWithFileOutput } from "../spawn.ts";
import { markNotified } from "../notify.ts";
import type { BgJob, UiContext } from "../types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const uiCtx = {
    ui: {
        notify() {},
        setWidget() {},
        setStatus() {},
        theme: { fg: (_c: string, t: string) => t },
    },
} as unknown as UiContext;

function harness() {
    const messages: unknown[] = [];
    const pi = { sendMessage: (m: unknown) => messages.push(m) };
    return { reg: new BgRegistry(), pi, messages };
}

function mkJob(over: Partial<BgJob> = {}): BgJob {
    return {
        id: "bash-test0001",
        command: "true",
        pid: 999999, // not a live process — no kill path touches it
        startTime: Date.now(),
        status: "running",
        logPath: "/tmp/pi-bg-tasks/bash-test0001.log",
        toolCallId: "tc-1",
        isBackgrounded: true,
        ...over,
    };
}

void describe("statusFromExit", () => {
    void it("maps exit results to statuses", () => {
        assert.equal(statusFromExit(0, null), "completed");
        assert.equal(statusFromExit(1, null), "failed");
        assert.equal(statusFromExit(127, null), "failed");
        assert.equal(statusFromExit(null, "SIGTERM"), "killed");
        assert.equal(statusFromExit(null, "SIGKILL"), "killed");
        // A code of null without a signal (shouldn't happen) counts as failed.
        assert.equal(statusFromExit(null, null), "failed");
    });
});

void describe("markTerminal", () => {
    void it("is idempotent and resolves the done promise once", async () => {
        const job = mkJob();
        let resolves = 0;
        job.donePromise = new Promise<void>((r) => {
            job.resolveDone = () => {
                resolves++;
                r();
            };
        });
        markTerminal(job, "completed", 0);
        markTerminal(job, "failed", 1); // ignored
        assert.equal(job.status, "completed");
        assert.equal(job.exitCode, 0);
        assert.equal(resolves, 1);
        await job.donePromise;
        assert.equal(job.donePromise, undefined);
    });
});

void describe("completeJob", () => {
    void it("sends exactly one notification even when called twice", () => {
        const { reg, pi, messages } = harness();
        const job = mkJob();
        add(reg, job);
        completeJob({ job, code: 0, reg, pi: pi as never, ctx: uiCtx });
        completeJob({ job, code: 0, reg, pi: pi as never, ctx: uiCtx });
        assert.equal(messages.length, 1);
        assert.equal(reg.jobs.has(job.id), false, "evicted after notify");
    });

    void it("a pre-latched (killed/read) job exits silently", () => {
        const { reg, pi, messages } = harness();
        const job = mkJob();
        add(reg, job);
        markNotified(job);
        completeJob({ job, code: null, signal: "SIGTERM", reg, pi: pi as never, ctx: uiCtx });
        assert.equal(messages.length, 0);
        assert.equal(job.status, "killed");
    });
});

void describe("killWithGrace — SIGTERM → grace → SIGKILL", () => {
    void it("a cooperative process dies on SIGTERM without needing SIGKILL", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-tasks-test-"));
        try {
            const spawned = spawnWithFileOutput({
                command: "while true; do sleep 0.2; done",
                cwd: dir,
                logPath: join(dir, "coop.log"),
            });
            assert.ok(processExists(spawned.pid));
            const start = Date.now();
            await killWithGrace({ pid: spawned.pid, exit: spawned.exit, graceMs: 2_000 });
            assert.ok(Date.now() - start < 1_500, "dies well inside the grace window");
            await spawned.exit;
            assert.ok(!processExists(spawned.pid));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("escalates to SIGKILL when SIGTERM is ignored", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-tasks-test-"));
        try {
            const spawned = spawnWithFileOutput({
                // Trap and ignore SIGTERM; only SIGKILL can end it.
                command: "trap '' TERM; while true; do sleep 0.2; done",
                cwd: dir,
                logPath: join(dir, "stubborn.log"),
            });
            assert.ok(processExists(spawned.pid));
            // Let the shell install its trap before the SIGTERM lands —
            // killing first would race the trap setup and die by SIGTERM.
            await sleep(300);
            const start = Date.now();
            await killWithGrace({ pid: spawned.pid, exit: spawned.exit, graceMs: 400 });
            const elapsed = Date.now() - start;
            assert.ok(elapsed >= 350, `waits the grace window first (${elapsed}ms)`);
            // SIGKILL lands; the process is gone shortly after.
            await sleep(150);
            assert.ok(!processExists(spawned.pid), "SIGKILL finished it");
            const exit = await spawned.exit;
            assert.equal(exit.signal, "SIGKILL");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

void describe("terminateJobSilently — kill suppresses the notification", () => {
    void it("latches notified, marks killed, sends nothing", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-tasks-test-"));
        try {
            const { reg, pi, messages } = harness();
            const id = newJobId(reg);
            const spawned = spawnWithFileOutput({
                command: "while true; do sleep 0.2; done",
                cwd: dir,
                logPath: join(dir, `${id}.log`),
            });
            const job = createRunningJob({
                id,
                command: "while true; do sleep 0.2; done",
                pid: spawned.pid,
                logPath: join(dir, `${id}.log`),
                toolCallId: "tc-kill",
            });
            add(reg, job);
            startBackgroundJob({ reg, pi: pi as never, ctx: uiCtx, job, exit: spawned.exit });

            const kill = terminateJobSilently(reg, job, "test");
            assert.equal(job.notified, true, "latched before the kill");
            assert.equal(job.status, "killed", "status flips immediately");
            await kill;
            await sleep(100); // let the exit handler run
            assert.equal(messages.length, 0, "no notification on a deliberate kill");
            assert.ok(!processExists(spawned.pid));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

void describe("startBackgroundJob — exit → completeJob", () => {
    void it("a finishing job completes and notifies", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-tasks-test-"));
        try {
            const { reg, pi, messages } = harness();
            const id = newJobId(reg);
            const spawned = spawnWithFileOutput({
                command: "exit 0",
                cwd: dir,
                logPath: join(dir, `${id}.log`),
            });
            const job = createRunningJob({
                id,
                command: "exit 0",
                pid: spawned.pid,
                logPath: join(dir, `${id}.log`),
                toolCallId: "tc-done",
            });
            add(reg, job);
            startBackgroundJob({ reg, pi: pi as never, ctx: uiCtx, job, exit: spawned.exit });

            await sleep(300);
            assert.equal(job.status, "completed");
            assert.equal(messages.length, 1, "exit notification sent");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
