// Drives the real index.ts handlers with a stub pi (no TUI, no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import ext from "./index.ts";

async function setup() {
	// pi calls every handler for an event, in registration order, and stops at an input "handled".
	const registered: Record<string, Function[]> = {};
	const handlers: Record<string, Function> = new Proxy({} as Record<string, Function>, {
		get: (_t, e: string) => async (event: any, c: any) => {
			let last: any;
			for (const h of registered[e] ?? []) {
				const r = await h(event, c);
				if (r !== undefined) last = r;
				if (e === "input" && r?.action === "handled") return r;
			}
			return last;
		},
	});
	const sent: unknown[] = [];
	const notes: string[] = [];
	const notices: { content: string; opts: unknown }[] = [];
	const order: string[] = [];
	const tools: Record<string, any> = {};
	const pi: any = {
		on: (e: string, h: Function) => (registered[e] ??= []).push(h),
		registerEntryRenderer() {},
		appendEntry() {},
		sendUserMessage: (c: unknown) => (sent.push(c), order.push("message")),
		registerTool: (t: any) => (tools[t.name] = t),
		registerShortcut() {},
		registerCommand() {},
		registerMessageRenderer() {},
		getCommands: () => [{ name: "ask", source: "prompt" }, { name: "model", source: "extension" }],
		sendMessage: (m: { content: string }, opts: unknown) => (notices.push({ content: m.content, opts }), order.push("notice")),
	};
	ext(pi);
	const state = { idle: false, editor: "", piQueue: 0 };
	const ctx: any = {
		mode: "tui",
		cwd: process.cwd(),
		isIdle: () => state.idle,
		hasPendingMessages: () => state.piQueue > 0,
		signal: { aborted: false },
		ui: {
			setWidget() {},
			notify: (m: string) => notes.push(m),
			getEditorText: () => state.editor,
			setEditorText: (t: string) => (state.editor = t),
			theme: { fg: (_c: string, t: string) => t },
			getEditorComponent() {},
			setEditorComponent() {},
			setStatus() {},
		},
		sessionManager: { getEntries: () => [] },
	};
	await handlers.session_start({}, ctx);
	return { handlers, sent, notes, notices, order, tools, state, ctx };
}

const img = { type: "image", data: "x", mimeType: "image/png" };

test("messages typed mid-turn go in together at the next tool boundary, as one steer", async () => {
	const { handlers, sent, ctx } = await setup();
	await handlers.input({ source: "interactive", streamingBehavior: "steer", text: "use pnpm" }, ctx);
	await handlers.input({ source: "interactive", streamingBehavior: "steer", text: "and add a test" }, ctx);
	assert.equal(sent.length, 0, "held while the tool runs");
	await handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, ctx);
	assert.deepEqual(sent, [[{ type: "text", text: "use pnpm" }, { type: "text", text: "and add a test" }]]);
});

test("an interruption that is not a send-now returns the text to the editor, drops images with a warning, sends nothing", async () => {
	const { handlers, sent, notes, state, ctx } = await setup();
	await handlers.input({ source: "interactive", streamingBehavior: "steer", text: "look at this", images: [img] }, ctx);
	await handlers.input({ source: "interactive", streamingBehavior: "steer", text: "and fix it" }, ctx);
	state.editor = "draft";
	ctx.signal.aborted = true;
	await handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, ctx);
	assert.equal(state.editor, "look at this\nand fix it\ndraft");
	assert.match(notes.at(-1)!, /1 attached image\(s\) dropped/);
	state.idle = true;
	await handlers.agent_settled({}, ctx);
	assert.equal(sent.length, 0, "nothing sent after the person interrupted");
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => sleep(5);

/** A background job that finishes while pi runs a turn; returns once its notice is held. */
async function finishJobMidRun(h: Awaited<ReturnType<typeof setup>>) {
	await h.handlers.agent_start({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 0, "held while pi runs");
}

test("a finish notice pending when the run ends starts a turn once pi has stopped (Claude Code wakes the model)", async () => {
	for (const stop of ["stop", "error", "aborted"]) {
		const h = await setup();
		await finishJobMidRun(h);
		await h.handlers.turn_end({ message: { stopReason: stop }, toolResults: [] }, h.ctx);
		h.state.idle = true;
		await h.handlers.agent_settled({}, h.ctx);
		assert.equal(h.notices.length, 0, `${stop}: not inside the stop`);
		await tick();
		assert.deepEqual(h.notices.map((n) => n.opts), [{ triggerTurn: true }], `${stop}: one turn`);
	}
});

test("a notice that arrived is never sent again", async () => {
	const h = await setup();
	await finishJobMidRun(h);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	await h.handlers.message_end({ message: { role: "custom", customType: "bg-task-notification", details: { noticeId: "n1" } } }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "stop" }, toolResults: [] }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx);
	await tick();
	assert.equal(h.notices.length, 1);
});

test("after a send-now, the notice rides after the person's message in the same run", async () => {
	const h = await setup();
	await finishJobMidRun(h);
	await h.handlers.turn_end({ message: { stopReason: "stop" }, toolResults: [] }, h.ctx);
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "now do X" }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx);
	await tick();
	assert.equal(h.notices.length, 0, "not a run of its own");
	const r = await h.handlers.before_agent_start({ prompt: "now do X" }, h.ctx);
	assert.match(r.message.content, /<task-notification>/);
});


/** Install pi-cc-steer's editor over a fake one; returns something to type into. */
async function editorOf(h: Awaited<ReturnType<typeof setup>>, autocomplete = () => false) {
	h.ctx.mode = "tui";
	let factory: any;
	h.ctx.ui.setEditorComponent = (f: unknown) => (factory = f);
	h.ctx.ui.getEditorComponent = () => () => ({ handleInput() {}, isShowingAutocomplete: autocomplete });
	await h.handlers.session_start({}, h.ctx);
	await sleep(10);
	const keys: Record<string, string> = { "tui.input.submit": "\r", "app.interrupt": "\x1b" };
	return factory({}, {}, { matches: (data: string, id: string) => keys[id] === data });
}

test("Enter in the editor while pi is idle holds a finish notice for that prompt instead of starting a turn", async () => {
	const h = await setup();
	const editor = await editorOf(h);
	h.state.idle = true;
	h.state.editor = "hello";
	editor.handleInput("\r"); // the person submits; another extension may still be processing it
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 0, "no turn that would reject the person's prompt");
	const r = await h.handlers.before_agent_start({ prompt: "hello" }, h.ctx);
	assert.match(r.message.content, /<task-notification>/, "the notice rides in that prompt");
});

test("while pi-cc-steer's own prompt (send-now, or messages typed after the last turn) is on its way, a finished job does not start a turn", async () => {
	const h = await setup();
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx); // the queue goes out as a prompt; another extension may still hold it
	assert.deepEqual(h.sent, [[{ type: "text", text: "PERSON" }]]);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 0, "no turn that would reject the person's prompt");
	const r = await h.handlers.before_agent_start({ prompt: "PERSON" }, h.ctx);
	assert.match(r.message.content, /<task-notification>/, "the notice rides in it");
});

test("a job finishing while the person's batch is still on its way does not start a turn ahead of it", async () => {
	const h = await setup();
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // flushed, not yet arrived
	h.state.idle = true; // e.g. pi went idle while another extension holds the batch
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 0, "waits for the person's batch");
});

test("a batch that Esc put back in the editor stops holding notices back — only after an Esc", async () => {
	for (const pressedEsc of [true, false]) {
		const h = await setup();
		const editor = await editorOf(h);
		await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
		await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // flushed to pi
		if (pressedEsc) editor.handleInput("\x1b");
		h.state.editor = pressedEsc ? "PERSON" : "PERSON and more"; // Esc returned it; otherwise a draft mentioning it
		h.ctx.signal.aborted = true;
		await h.handlers.turn_end({ message: { stopReason: "aborted" }, toolResults: [] }, h.ctx);
		h.state.idle = true;
		await h.handlers.agent_settled({}, h.ctx);
		await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
		await sleep(300);
		assert.equal(h.notices.length, pressedEsc ? 1 : 0, pressedEsc ? "the notice wakes the model" : "the batch may still be on its way");
	}
});

test("Enter on !shell or on an autocomplete suggestion does not hold notices; Enter on a template holds them past 5 s, a command does not", async () => {
	const cases: Array<[string, boolean, number, boolean]> = [
		// text, autocomplete open, wait ms, held afterwards
		["!ls", false, 300, false],
		["see @fi", true, 300, false],
		["/ask about it", false, 5300, true],
		["/model", false, 5300, false],
	];
	for (const [text, autocomplete, wait, held] of cases) {
		const h = await setup();
		const editor = await editorOf(h, () => autocomplete);
		h.state.idle = true;
		h.state.editor = text;
		editor.handleInput("\r");
		await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
		await sleep(wait);
		assert.equal(h.notices.length, held ? 0 : 1, `${text}: ${held ? "held" : "a turn starts"}`);
	}
});

test("Enter while pi is busy: no notice goes in ahead of that message at a tool boundary; once queued, the hold ends", async () => {
	const h = await setup();
	const editor = await editorOf(h);
	await h.handlers.agent_start({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300); // held: pi is busy
	h.state.editor = "PERSON";
	editor.handleInput("\r"); // submitted; another extension may still be processing it
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	assert.equal(h.notices.length, 0, "not ahead of PERSON");
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx); // reaches pi-cc-steer
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // PERSON flushed here
	await h.handlers.message_end({ message: { role: "user", content: [{ type: "text", text: "PERSON" }], timestamp: 1 } }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	assert.deepEqual(h.order.slice(-2), ["message", "notice"], "the person's message, then the notice");
});
