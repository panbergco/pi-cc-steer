// Real pi sessions (pi's SDK, a scripted fake model) with pi-cc-steer loaded: these check what the model is
// actually sent, through pi's own queues — the part a stub pi cannot show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	initTheme,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import steer from "./index.ts";

initTheme(); // pi's CLI does this at start-up; the SDK leaves it to the host

type Msg = { role: string; content: unknown };
const text = (m: Msg) =>
	typeof m.content === "string"
		? m.content
		: (m.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bash = (command: string, extra: Record<string, unknown> = {}) =>
	fauxAssistantMessage([fauxToolCall("bash", { command, ...extra })], { stopReason: "toolUse" });

/** A pi session with pi-cc-steer, answering with `steps` in order; records every context the model is sent. */
async function session(steps: Array<ReturnType<typeof bash>>, mode: "tui" | "rpc" = "tui") {
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
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, extensionFactories: [steer] } as never);
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
	const noticesIn = (ctx: Msg[] | undefined) => (ctx ?? []).filter((m) => text(m).includes("<task-notification>")).length;
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
	// Both notices are handed to pi at the boundary after "sleep 0.6"; pi takes one steering message per request,
	// so an abort right there leaves the second in pi's queue while the extension also sends it again.
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
