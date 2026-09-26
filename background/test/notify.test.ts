import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildTaskNotification,
    completionSummary,
    deliverHeld,
    escapeXml,
    releaseWaiting,
    markNotified,
    sendTaskNotification,
} from "../notify.ts";
import { add, BgRegistry } from "../registry.ts";
import { EVENT, type BgJob } from "../types.ts";

interface Captured {
    customType: string;
    content: string;
    display?: boolean;
    details?: { jobId?: string; status?: string; summary?: string; outputFile?: string };
}

function harness(opts?: { deliverThrows?: boolean }) {
    const messages: Captured[] = [];
    const deliverOptions: unknown[] = [];
    const pi = {
        sendMessage: (m: Captured, o?: unknown) => {
            if (opts?.deliverThrows) throw new Error("sendMessage failed");
            messages.push(m);
            if (o) deliverOptions.push(o);
        },
    };
    return { reg: new BgRegistry(), pi, messages, deliverOptions };
}

function mkJob(over: Partial<BgJob> = {}): BgJob {
    return {
        id: "bash-abcd1234",
        command: "npm test",
        pid: 1234,
        startTime: Date.now(),
        status: "completed",
        exitCode: 0,
        logPath: "/tmp/pi-bg-tasks/bash-abcd1234.log",
        toolCallId: "tc-42",
        isBackgrounded: true,
        ...over,
    };
}

void describe("escapeXml", () => {
    void it("escapes &, < and > only", () => {
        assert.equal(escapeXml(`a & b <c> "q" 'apost'`), `a &amp; b &lt;c&gt; "q" 'apost'`);
    });
});

void describe("buildTaskNotification", () => {
    void it("carries task_id / status / command / exit_code / output_file / summary", () => {
        const job = mkJob({ logPath: "/nonexistent-tail.log" });
        const xml = buildTaskNotification({ job, status: "completed", summary: "done" });
        assert.equal(
            xml,
            [
                "<task-notification>",
                "<task_id>bash-abcd1234</task_id>",
                "<status>completed</status>",
                "<command>npm test</command>",
                "<exit_code>0</exit_code>",
                "<output_file>/nonexistent-tail.log</output_file>",
                "<summary>done</summary>",
                "</task-notification>",
            ].join("\n")
        );
    });

    void it("omits exit_code when undefined and escapes element text", () => {
        const job = mkJob({ exitCode: undefined, command: "a <b> & c", logPath: "/nope.log" });
        const xml = buildTaskNotification({ job, status: "failed", summary: "x & y" });
        assert.ok(!xml.includes("exit_code"));
        assert.ok(xml.includes("<command>a &lt;b&gt; &amp; c</command>"));
        assert.ok(xml.includes("<summary>x &amp; y</summary>"));
    });

    void it("includes a stripped tail preview when the log has content", () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-tasks-test-"));
        try {
            const logPath = join(dir, "t.log");
            writeFileSync(logPath, "line1\n\u001b[32mline2\u001b[0m\n");
            const job = mkJob({ logPath });
            const xml = buildTaskNotification({ job, status: "completed", summary: "s" });
            assert.ok(xml.includes("<tail_preview>"));
            assert.ok(xml.includes("line2"), "tail content present");
            assert.ok(!xml.includes("[32m"), "ANSI escapes stripped");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    void it("collapses multi-line commands to one line", () => {
        const job = mkJob({ command: "cd x &&\n  npm   run build", logPath: "/nope.log" });
        const xml = buildTaskNotification({ job, status: "completed", summary: "s" });
        assert.ok(xml.includes("<command>cd x &amp;&amp; npm run build</command>"));
    });
});

void describe("completionSummary", () => {
    void it("completed / failed / killed", () => {
        assert.equal(
            completionSummary(mkJob({ status: "completed", exitCode: 0 })),
            `Background command "npm test" completed (exit code 0)`
        );
        assert.equal(
            completionSummary(mkJob({ status: "failed", exitCode: 3 })),
            `Background command "npm test" failed with exit code 3`
        );
        assert.equal(
            completionSummary(mkJob({ status: "killed" })),
            `Background command "npm test" was stopped`
        );
    });

    void it("uses the job name when set, and truncates long commands", () => {
        assert.equal(
            completionSummary(mkJob({ name: "tests", status: "completed", exitCode: 0 })),
            `Background command "tests" completed (exit code 0)`
        );
        const long = mkJob({ command: "x".repeat(120), status: "completed", exitCode: 0 });
        assert.ok(completionSummary(long).includes("…"));
    });

    void it("explains the output-limit stop", () => {
        assert.equal(
            completionSummary(mkJob({ status: "killed", stopReason: "output_limit" })),
            `Background command "npm test" was stopped: output exceeded the size limit`
        );
    });
});

void describe("notices that finish mid-run", () => {
    void it("are held, not put in pi's queue, until the run ends", () => {
        const { reg, pi, messages } = harness();
        reg.agentRunning = true;
        const job = mkJob({ id: "bash-held0001", logPath: "/nope.log" });
        add(reg, job);
        assert.equal(sendTaskNotification({ reg, pi: pi as never, job }), true);
        assert.equal(messages.length, 0, "nothing handed to pi mid-run");
        assert.equal(reg.held.length, 1);
    });

    void it("ride after the person's next message when one is coming", () => {
        const { reg, pi, messages, deliverOptions } = harness();
        reg.held = [{ content: "a", details: {} }, { content: "b", details: {} }];
        deliverHeld(reg, pi as never, true);
        assert.equal(messages.length, 2);
        assert.deepEqual(deliverOptions, [{ deliverAs: "nextTurn" }, { deliverAs: "nextTurn" }]);
    });

    void it("after an interrupted or failed run, wait for the person's next message instead of restarting", () => {
        for (const setup of [(r: BgRegistry) => (r.endedCleanly = false), (r: BgRegistry) => ((r.endedCleanly = true), (r.compactionCancelled = true))]) {
            const { reg, pi, messages, deliverOptions } = harness();
            setup(reg);
            reg.held = [{ content: "a", details: {} }];
            deliverHeld(reg, pi as never, false);
            assert.equal(messages.length, 0, "nothing sent, no new run");
            releaseWaiting(reg, pi as never);
            assert.deepEqual(deliverOptions, [{ deliverAs: "nextTurn" }]);
        }
    });

    void it("otherwise start one turn, with every held notice in it", () => {
        const { reg, pi, messages, deliverOptions } = harness();
        reg.endedCleanly = true;
        reg.held = [{ content: "a", details: {} }, { content: "b", details: {} }, { content: "c", details: {} }];
        deliverHeld(reg, pi as never, false);
        assert.equal(messages.length, 3);
        assert.deepEqual(deliverOptions, [{}, {}, { triggerTurn: true }], "only the last one starts a turn");
        deliverHeld(reg, pi as never, false);
        assert.equal(messages.length, 3, "delivered once");
    });

    void it("a waiting notice goes ahead of a new one that starts a turn while idle", () => {
        const { reg, pi, messages, deliverOptions } = harness();
        reg.waiting = [{ content: "A", details: {} }];
        const job = mkJob({ id: "bash-idle0001", logPath: "/nope.log" });
        add(reg, job);
        sendTaskNotification({ reg, pi: pi as never, job });
        assert.deepEqual(messages.map((m) => m.content.slice(0, 1)), ["A", "<"]);
        assert.deepEqual(deliverOptions, [{}, { triggerTurn: true }]);
        assert.equal(reg.waiting.length, 0);
    });
});

void describe("sendTaskNotification — exactly-once", () => {
    void it("wakes an idle agent, and evicts the job", () => {
        const { reg, pi, messages, deliverOptions } = harness();
        const job = mkJob({ id: "bash-send0001", logPath: "/nope.log" });
        add(reg, job);

        const sent = sendTaskNotification({ reg, pi: pi as never, job });

        assert.equal(sent, true);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].customType, EVENT.taskNotification);
        assert.equal(messages[0].display, true);
        assert.deepEqual(deliverOptions[0], { triggerTurn: true });
        assert.equal(messages[0].details?.status, "completed");
        assert.equal(reg.jobs.has("bash-send0001"), false, "terminal+notified evicted");
        assert.equal(reg.recentTerminal.length, 1);
        assert.equal(reg.completedCount, 1);
    });

    void it("latches: a second send is a no-op", () => {
        const { reg, pi, messages } = harness();
        const job = mkJob({ logPath: "/nope.log" });
        add(reg, job);
        sendTaskNotification({ reg, pi: pi as never, job });
        const again = sendTaskNotification({ reg, pi: pi as never, job });
        assert.equal(again, false);
        assert.equal(messages.length, 1);
    });

    void it("a pre-latched job is skipped and not evicted", () => {
        const { reg, pi, messages } = harness();
        const job = mkJob({ status: "killed", logPath: "/nope.log" });
        add(reg, job);
        markNotified(job); // kill path latches BEFORE the exit handler runs
        assert.equal(sendTaskNotification({ reg, pi: pi as never, job }), false);
        assert.equal(messages.length, 0);
        assert.equal(reg.jobs.has(job.id), true, "lingers for the bg_list lazy sweep");
    });

    void it("a failed send does not retry and does not evict (exactly-once)", () => {
        const { reg, pi, messages } = harness({ deliverThrows: true });
        const job = mkJob({ logPath: "/nope.log" });
        add(reg, job);
        const origError = console.error;
        console.error = () => {};
        let sent = false;
        try {
            sent = sendTaskNotification({ reg, pi: pi as never, job });
        } finally {
            console.error = origError;
        }
        assert.equal(sent, false);
        assert.equal(messages.length, 0);
        assert.equal(job.notified, true, "latch already set — never retried");
        assert.equal(reg.jobs.has(job.id), true);
    });
});
