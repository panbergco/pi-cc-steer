import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    add,
    atConcurrencyLimit,
    BgRegistry,
    createRunningJob,
    findJob,
    forget,
    logPathFor,
    newJobId,
    sweepNotifiedTerminal,
} from "../registry.ts";
import { MAX_CONCURRENT_JOBS, RECENT_TERMINAL_KEEP, type BgJob } from "../types.ts";

function mkJob(over: Partial<BgJob> = {}): BgJob {
    return {
        id: over.id ?? newJobId(),
        command: "echo hi",
        pid: 1234,
        startTime: Date.now(),
        status: "running",
        logPath: "/tmp/pi-bg-tasks/x.log",
        toolCallId: "tc-1",
        isBackgrounded: true,
        ...over,
    };
}

void describe("newJobId", () => {
    void it("is `bash-` plus 8 base36 chars", () => {
        for (let i = 0; i < 50; i++) {
            assert.match(newJobId(), /^bash-[0-9a-z]{8}$/);
        }
    });

    void it("regenerates on collision with the live registry", () => {
        const reg = new BgRegistry();
        const job = mkJob();
        add(reg, job);
        // Statistical: 100 fresh ids must never equal the live one.
        for (let i = 0; i < 100; i++) {
            assert.notEqual(newJobId(reg), job.id);
        }
    });
});

void describe("logPathFor", () => {
    void it("puts logs in the dedicated dir", () => {
        assert.equal(logPathFor("bash-abcd1234"), "/tmp/pi-bg-tasks/bash-abcd1234.log");
    });
});

void describe("atConcurrencyLimit", () => {
    void it("trips at 16 running jobs, ignoring terminal ones", () => {
        const reg = new BgRegistry();
        for (let i = 0; i < MAX_CONCURRENT_JOBS - 1; i++) add(reg, mkJob());
        assert.equal(atConcurrencyLimit(reg), false);
        add(reg, mkJob({ status: "completed" })); // terminal — must not count
        assert.equal(atConcurrencyLimit(reg), false);
        add(reg, mkJob());
        assert.equal(atConcurrencyLimit(reg), true);
    });
});

void describe("forget + recentTerminal ring", () => {
    void it("evicts to the ring, capped at RECENT_TERMINAL_KEEP, findJob falls back", () => {
        const reg = new BgRegistry();
        const jobs: BgJob[] = [];
        for (let i = 0; i < RECENT_TERMINAL_KEEP + 5; i++) {
            const job = mkJob({ status: "completed", exitCode: 0 });
            add(reg, job);
            jobs.push(job);
        }
        for (const job of jobs) forget(reg, job);

        assert.equal(reg.jobs.size, 0);
        assert.equal(reg.recentTerminal.length, RECENT_TERMINAL_KEEP);
        assert.equal(reg.completedCount, RECENT_TERMINAL_KEEP + 5);
        // The oldest 5 fell off the ring; the rest are still findable.
        assert.equal(findJob(reg, jobs[0].id), undefined);
        assert.equal(findJob(reg, jobs[RECENT_TERMINAL_KEEP + 4].id)?.id, jobs[RECENT_TERMINAL_KEEP + 4].id);
    });

    void it("counts killed jobs separately", () => {
        const reg = new BgRegistry();
        const job = mkJob({ status: "killed" });
        add(reg, job);
        forget(reg, job);
        assert.equal(reg.killedCount, 1);
        assert.equal(reg.completedCount, 0);
    });
});

void describe("sweepNotifiedTerminal", () => {
    void it("evicts only terminal+notified jobs", () => {
        const reg = new BgRegistry();
        const running = mkJob();
        const terminalUnread = mkJob({ status: "completed", exitCode: 0 });
        const terminalRead = mkJob({ status: "killed", notified: true });
        add(reg, running);
        add(reg, terminalUnread);
        add(reg, terminalRead);

        sweepNotifiedTerminal(reg);

        assert.equal(reg.jobs.has(running.id), true);
        assert.equal(reg.jobs.has(terminalUnread.id), true);
        assert.equal(reg.jobs.has(terminalRead.id), false);
        assert.ok(reg.recentTerminal.includes(terminalRead));
    });
});

void describe("createRunningJob", () => {
    void it("defaults to running + backgrounded", () => {
        const job = createRunningJob({
            id: "bash-abcdefgh",
            command: "ls",
            pid: 42,
            logPath: "/tmp/pi-bg-tasks/bash-abcdefgh.log",
            toolCallId: "tc-9",
        });
        assert.equal(job.status, "running");
        assert.equal(job.isBackgrounded, true);
        assert.ok(job.startTime > 0);
    });
});
