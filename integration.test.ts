// Real pi sessions (pi's SDK, a scripted fake model) with pi-cc-steer loaded: these check what the model is
// actually sent, through pi's own queues — the part a stub pi cannot show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	initTheme,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import steer from "./index.ts";

initTheme(); // pi's interactive mode does this at start-up (the tests run pi-cc-steer as in the TUI)

type Msg = { role: string; content: unknown };
const text = (m: Msg) =>
	typeof m.content === "string"
		? m.content
		: (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bash = (command: string, extra: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, ...extra })], { stopReason: "toolUse" });

/** A pi session with pi-cc-steer, answering with `steps` in order; records every context the model is sent. */
async function session(
	steps: Array<ReturnType<typeof bash>>,
	mode: "tui" | "rpc" = "tui",
	before: Array<(pi: any) => void> = [],
) {
	const dir = mkdtempSync(join(tmpdir(), "ccs-it-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	} as never);
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: [...before, steer] } as never);
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model,
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
	});
	// What pi's modes do at start-up (emits session_start). `mode` decides whether notices may start turns.
	await session.bindExtensions({ mode } as never);
	const contexts: Msg[][] = [];
	faux.setResponses(
		steps.map((step) => (context: { messages: Msg[] }) => {
			contexts.push([...context.messages]);
			return step;
		}) as never,
	);
	const noticesIn = (ctx: Msg[] | undefined) =>
		(ctx ?? []).reduce((n, m) => n + (text(m).match(/<task-notification>/g)?.length ?? 0), 0);
	const done = () => {
		session.dispose();
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	};
	return { session, contexts, noticesIn, done };
}

test("a background job's notice reaches the model at a tool boundary — after the message the person queued", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("sleep 1; echo one"),
		bash("sleep 0.5; echo two"),
		bash("echo three"),
		fauxAssistantMessage("done"),
	]);
	const run = s.session.prompt("go");
	await sleep(700); // the job has finished; "sleep 1" is running
	await s.session.prompt("PERSON", { streamingBehavior: "steer" });
	await run;
	await sleep(50);
	const last = s.contexts.at(-1)!;
	const person = last.findIndex((m) => text(m).includes("PERSON"));
	const notice = last.findIndex((m) => text(m).includes("<task-notification>"));
	assert.ok(person >= 0 && notice >= 0, "both reached the model");
	assert.ok(person < notice, "the person's message first, then the notice");
	assert.equal(s.noticesIn(last), 1, "once");
	s.done();
});

test("after an Esc, a finished job's notice wakes the model once pi has stopped, without holding up the stop", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("sleep 5"),
		fauxAssistantMessage("noted"),
	]);
	const run = s.session.prompt("go");
	await sleep(700);
	const t0 = Date.now();
	await s.session.abort();
	const stopMs = Date.now() - t0;
	await run.catch(() => {});
	await sleep(300);
	assert.ok(stopMs < 1000, `the stop took ${stopMs} ms`);
	assert.equal(s.contexts.length, 3, "one new turn after the stop");
	assert.equal(s.noticesIn(s.contexts[2]), 1);
	s.done();
});

test("an abort never loses a notice already handed to pi, and never repeats it", async () => {
	for (const clearsQueue of [true, false]) {
		const s = await session([
			bash("true", { run_in_background: true }),
			bash("sleep 0.6; echo a"),
			bash("sleep 5"),
			fauxAssistantMessage("after"),
			fauxAssistantMessage("next"),
		], clearsQueue ? "tui" : "rpc");
		// The notice is handed to pi at the boundary after "sleep 0.6"; cut the run right there.
		let turns = 0;
		s.session.subscribe((e: { type: string }) => {
			if (e.type !== "turn_end" || ++turns !== 2) return;
			if (clearsQueue) s.session.clearQueue(); // what the interactive Esc does
			void s.session.abort();
		});
		await s.session.prompt("go").catch(() => {});
		await sleep(400);
		if (!clearsQueue) await s.session.prompt("next"); // pi kept it: it is in the conversation for the next request
		const later = s.contexts.slice(2);
		assert.ok(later.length > 0, "the model was asked again");
		assert.equal(s.noticesIn(later.at(-1)), 1, clearsQueue ? "re-sent after the queue was cleared" : "the copy pi kept, once");
		const shown = s.session.messages.filter(
			(m: any) => m.role === "custom" && m.customType === "bg-task-notification" && m.display !== false,
		).length;
		assert.equal(shown, 1, "shown once in the transcript");
		s.done();
	}
});

test("two notices cut off by an abort: the one pi still holds is re-sent, and the repeat is hidden from the model", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("true", { run_in_background: true }),
		bash("sleep 0.6; echo a"),
		bash("sleep 5"),
		fauxAssistantMessage("after"),
		fauxAssistantMessage("next"),
	], "rpc");
	// The notices go to pi one per boundary; the abort cuts the run while one of them is still in pi's queue, and
	// the extension sends it again after the abort. The model must see each once.
	let turns = 0;
	s.session.subscribe((e: { type: string }) => {
		if (e.type === "turn_end" && ++turns === 3) void s.session.abort();
	});
	await s.session.prompt("go").catch(() => {});
	await sleep(400);
	await s.session.prompt("next");
	await sleep(100);
	const ids = (ctx: Msg[]) =>
		ctx.filter((m) => text(m).includes("<task-notification>")).map((m) => /<task_id>([^<]+)</.exec(text(m))?.[1]);
	const last = ids(s.contexts.at(-1)!);
	assert.equal(new Set(last).size, 2, "both jobs reached the model");
	assert.equal(last.length, 2, "neither twice");
	s.done();
});

test("in RPC or SDK mode a notice never starts a turn by itself: the host's next prompt carries it", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("sleep 5"),
		fauxAssistantMessage("host prompt answered"),
	], "rpc");
	const run = s.session.prompt("go");
	await sleep(700);
	await s.session.abort();
	await run.catch(() => {});
	await sleep(300);
	assert.equal(s.contexts.length, 2, "no turn the host did not ask for");
	await s.session.prompt("host prompt"); // would be rejected if a notice turn were running
	assert.equal(s.noticesIn(s.contexts[2]), 1, "the notice rode in the host's prompt");
	s.done();
});

test("two finished jobs pending at an Esc wake the model with one turn, each notice once", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("true", { run_in_background: true }),
		bash("sleep 5"),
		fauxAssistantMessage("both noted"),
	]);
	const run = s.session.prompt("go");
	await sleep(700);
	await s.session.abort();
	await run.catch(() => {});
	await sleep(300);
	assert.equal(s.contexts.length, 4, "exactly one new turn");
	assert.equal(s.noticesIn(s.contexts[3]), 2, "both notices, once each");
	const shown = s.session.messages.filter((m: any) => m.role === "custom" && m.display !== false).length;
	assert.equal(shown, 1, "one message on screen carrying both");
	s.done();
});

test("with two notices waiting and the person's message queued, the person's message still goes first", async () => {
	const s = await session([
		bash("true", { run_in_background: true }),
		bash("true", { run_in_background: true }),
		bash("sleep 1; echo one"),
		bash("sleep 0.3; echo two"),
		bash("sleep 0.3; echo three"),
		bash("echo four"),
		fauxAssistantMessage("done"),
	]);
	const run = s.session.prompt("go");
	await sleep(600);
	await s.session.prompt("PERSON", { streamingBehavior: "steer" });
	await run;
	const last = s.contexts.at(-1)!;
	const person = last.findIndex((m) => text(m).includes("PERSON"));
	const notices = last.flatMap((m, i) => (text(m).includes("<task-notification>") ? [i] : []));
	assert.equal(s.noticesIn(last), 2, "both notices reached the model, once each");
	assert.ok(person >= 0 && notices.every((i) => i > person), "the person's message ahead of both");
	s.done();
});

test("a background command stuck at a prompt: the model is told (watcher running inside the engine)", async () => {
	const { STALL_TIMING } = await import("./background/types.ts");
	assert.deepEqual(STALL_TIMING, { checkMs: 5_000, afterMs: 45_000 }, "Claude Code's timings");
	const saved = { ...STALL_TIMING };
	Object.assign(STALL_TIMING, { checkMs: 50, afterMs: 300 });
	try {
		const s = await session([
			bash("printf 'Overwrite existing file? (y/n) '; sleep 30", { run_in_background: true }),
			fauxAssistantMessage("started"),
			fauxAssistantMessage("it needs an answer"),
		]);
		await s.session.prompt("go");
		await sleep(900);
		const warned = s.contexts.some((c) => c.some((m) => text(m).includes("appears to be waiting for interactive input")));
		assert.ok(warned, "the warning reached the model");
		s.done();
	} finally {
		Object.assign(STALL_TIMING, saved);
	}
});

/** Another extension, loaded first, whose input handler takes a while over messages pi-cc-steer sends on. */
const slowInput = (ms: number) => (pi: any) =>
	pi.on("input", async (e: { source: string }) => {
		if (e.source === "extension") await sleep(ms);
		return undefined;
	});

test("a slow extension holding the person's message on its way in: notices still wait for it, mid-run and at the end", async () => {
	const s = await session(
		[
			bash("true", { run_in_background: true }),
			bash("sleep 1; echo one"),
			bash("sleep 0.2; echo two"),
			bash("echo three"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("after"),
		],
		"tui",
		[slowInput(700)],
	);
	const run = s.session.prompt("go");
	await sleep(600);
	await s.session.prompt("PERSON", { streamingBehavior: "steer" });
	await run.catch(() => {});
	await sleep(1500);
	const all = s.contexts.at(-1)!;
	const person = all.findIndex((m) => text(m).includes("PERSON"));
	const notice = all.findIndex((m) => text(m).includes("<task-notification>"));
	assert.ok(person >= 0 && notice >= 0, "both reached the model");
	assert.ok(person < notice, "the person's message ahead of the notice");
	assert.equal(s.noticesIn(all), 1);
	s.done();
});

test("a batch another extension rewrote on its way in: the notice never goes ahead of it, and rides in the next prompt", async () => {
	const rewrite = (pi: any) =>
		pi.on("input", (e: { source: string; text: string }) =>
			e.source === "extension" ? { action: "transform", text: `${e.text} (rewritten)` } : undefined,
		);
	const s = await session(
		[
			bash("true", { run_in_background: true }),
			bash("sleep 1; echo one"),
			bash("sleep 0.2; echo two"),
			bash("sleep 0.2; echo three"),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("next answered"),
		],
		"tui",
		[rewrite],
	);
	const run = s.session.prompt("go");
	await sleep(600);
	await s.session.prompt("PERSON", { streamingBehavior: "steer" });
	await run;
	await sleep(100);
	assert.equal(s.contexts.length, 5, "no notice-only turn after the run");
	assert.equal(s.noticesIn(s.contexts.at(-1)), 0, "held back rather than risk going ahead of the rewritten batch");
	await s.session.prompt("next");
	const last = s.contexts.at(-1)!;
	assert.equal(s.noticesIn(last), 1, "rides in the next prompt");
	assert.ok(last.findIndex((m) => text(m).includes("PERSON")) < last.findIndex((m) => text(m).includes("<task-notification>")));
	s.done();
});

test("a message typed during the run but held by a slow extension until the run ended still reaches the model", async () => {
	const slowTyped = (pi: any) =>
		pi.on("input", async (e: { source: string; streamingBehavior?: string }) => {
			if (e.source === "interactive" && e.streamingBehavior) await sleep(700);
			return undefined;
		});
	const s = await session([bash("sleep 0.4; echo one"), fauxAssistantMessage("done"), fauxAssistantMessage("got PERSON")], "tui", [
		slowTyped,
	]);
	const run = s.session.prompt("go");
	await sleep(150);
	const typed = s.session.prompt("PERSON", { streamingBehavior: "steer" }); // typed while the command runs
	await run;
	await typed;
	await sleep(200);
	assert.ok(
		s.contexts.some((c) => c.some((m) => text(m).includes("PERSON"))),
		"not stranded in pi-cc-steer's queue after the run ended",
	);
	s.done();
});

test("a notice queued behind another extension's steering message, then an abort: the model sees it once", async () => {
	let n = 0;
	const other = (pi: any) =>
		pi.on("turn_end", () => {
			if (++n === 2) pi.sendMessage({ customType: "other", content: "OTHER", display: true }, { deliverAs: "steer" });
		});
	const s = await session(
		[
			bash("true", { run_in_background: true }),
			bash("sleep 0.6; echo a"),
			bash("sleep 5"),
			fauxAssistantMessage("after"),
			fauxAssistantMessage("next"),
		],
		"rpc",
		[other],
	);
	let turns = 0;
	s.session.subscribe((e: { type: string }) => {
		if (e.type === "turn_end" && ++turns === 2) void s.session.abort(); // pi keeps the notice queued behind OTHER
	});
	await s.session.prompt("go").catch(() => {});
	await sleep(300);
	await s.session.prompt("next");
	await sleep(100);
	assert.equal(s.noticesIn(s.contexts.at(-1)), 1, "the copy pi kept and the re-sent one: the model sees one");
	s.done();
});

test("runaway output: a command past the 64 MiB cap is killed; a background log is trimmed to the cap, a foreground one removed", async () => {
	const { statSync, existsSync, readFileSync } = await import("node:fs");
	const flood = "head -c 80000000 /dev/zero | tr '\\\\0' x; sleep 30";
	const s = await session([
		bash(flood, { run_in_background: true }),
		bash(flood),
		fauxAssistantMessage("done"),
		fauxAssistantMessage("noted"),
	]);
	const started = Date.now();
	await s.session.prompt("go");
	await sleep(1500);
	assert.ok(Date.now() - started < 20_000, "killed, not left to sleep 30 s");
	const all = s.contexts.at(-1)!.map(text).join("\n");
	assert.match(all, /Command stopped: output exceeded the size limit/, "the foreground call says why it stopped");
	const logs = [...all.matchAll(/(\/[^\s"<>]*\.log)/g)].map((m) => m[1]);
	const bgLog = logs.find((p) => existsSync(p));
	assert.ok(bgLog, "the background job's log is kept");
	assert.ok(statSync(bgLog).size <= 64 * 1024 * 1024 + 200, "trimmed to the cap");
	assert.match(readFileSync(bgLog, "utf8").slice(-200), /exceeded the 64 MiB limit/);
	s.done();
});

test("a command sees pi's environment: the agent's bin dir first on PATH, and this session's id", async () => {
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	const { delimiter } = await import("node:path");
	const saved = process.env.PATH;
	// start from a PATH without the agent's bin dir (this machine's may already have it)
	process.env.PATH = (saved ?? "").split(delimiter).filter((d) => d !== join(getAgentDir(), "bin")).join(delimiter);
	const s = await session([bash('echo "PATH0=${PATH%%:*}"; echo "SID=$PI_SESSION_ID"'), fauxAssistantMessage("ok")]);
	await s.session.prompt("go").finally(() => (process.env.PATH = saved));
	const out = s.contexts.at(-1)!.map(text).join("\n");
	assert.match(out, new RegExp(`PATH0=${join(getAgentDir(), "bin").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
	assert.match(out, new RegExp(`SID=${s.session.sessionManager.getSessionId()}`));
	s.done();
});
