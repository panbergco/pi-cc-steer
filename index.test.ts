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
async function editorOf(
	h: Awaited<ReturnType<typeof setup>>,
	opts: { autocomplete?: () => boolean; piQueue?: () => string; completion?: { prefix: string; result: string } } = {},
) {
	const completing = opts.autocomplete ?? (() => false);
	h.ctx.mode = "tui";
	let factory: any;
	h.ctx.ui.setEditorComponent = (f: unknown) => (factory = f);
	// Behaves like pi's editor: Enter submits through onSubmit (on a suggestion: a slash command is completed and
	// submitted, a file is only filled in); Esc while pi works puts pi's queued messages back, ahead of the draft.
	h.ctx.ui.getEditorComponent = () => () => ({
		onSubmit: undefined as undefined | ((t: string) => void),
		getText: () => h.state.editor,
		isShowingAutocomplete: completing,
		handleInput(data: string) {
			if (data === "\r" && completing() && opts.completion) {
				h.state.editor = opts.completion.result; // the suggestion is applied
				if (!opts.completion.prefix.startsWith("/")) return; // a file suggestion: filled in, not submitted
			}
			if (data === "\r") {
				const text = h.state.editor;
				h.state.editor = "";
				this.onSubmit?.(text);
			}
			if ((data === "\x1b" && !completing() && !h.state.idle) || data === "\x1b[1;3A") {
				const queued = opts.piQueue?.() ?? "";
				if (queued) h.state.editor = [queued, h.state.editor].filter((t) => t.trim()).join("\n\n");
			}
		},
	});
	await h.handlers.session_start({}, h.ctx);
	await sleep(10);
	const keys: Record<string, string> = { "tui.input.submit": "\r", "app.interrupt": "\x1b", "app.message.dequeue": "\x1b[1;3A" };
	const editor = factory({}, {}, { matches: (data: string, id: string) => keys[id] === data });
	editor.onSubmit = () => {}; // what pi does after creating the editor
	return editor;
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

test("a batch that pi's Esc put back in the editor stops holding notices back; a draft that only resembles it does not", async () => {
	for (const piHadIt of [true, false]) {
		const h = await setup();
		const editor = await editorOf(h, { piQueue: () => (piHadIt ? "PERSON" : "") });
		await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
		await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // flushed
		// either pi has it queued, or it is still inside another extension's slow input handler
		h.state.editor = piHadIt ? "" : "PERSON and more"; // a draft that starts with the same text
		editor.handleInput("\x1b");
		h.ctx.signal.aborted = true;
		await h.handlers.turn_end({ message: { stopReason: "aborted" }, toolResults: [] }, h.ctx);
		h.state.idle = true;
		await h.handlers.agent_settled({}, h.ctx);
		await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
		await sleep(300);
		assert.equal(h.notices.length, piHadIt ? 1 : 0, piHadIt ? "the notice wakes the model" : "the batch is still on its way");
	}
});

test("what a submission holds: !shell nothing; a file suggestion is not a submission; a template (even completed from /a) until it starts; a command 5 s", async () => {
	type Case = { text: string; completion?: { prefix: string; result: string }; wait: number; held: boolean };
	const cases: Case[] = [
		{ text: "!ls", wait: 300, held: false },
		{ text: "see @fi", completion: { prefix: "@fi", result: "see @file.txt" }, wait: 300, held: false },
		{ text: "/ask @fi", completion: { prefix: "@fi", result: "/ask @file.txt" }, wait: 300, held: false },
		{ text: "/ask about it", wait: 5300, held: true },
		{ text: "/a", completion: { prefix: "/a", result: "/ask" }, wait: 5300, held: true },
		{ text: "/model", wait: 5300, held: false },
	];
	for (const c of cases) {
		const h = await setup();
		const editor = await editorOf(h, { autocomplete: () => Boolean(c.completion), completion: c.completion });
		h.state.idle = true;
		h.state.editor = c.text;
		editor.handleInput("\r");
		await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
		await sleep(c.wait);
		assert.equal(h.notices.length, c.held ? 0 : 1, `${c.text}: ${c.held ? "held" : "a turn starts"}`);
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

test("Esc that only closes a suggestion list is no interruption", async () => {
	const h = await setup();
	const editor = await editorOf(h, { autocomplete: () => true, piQueue: () => "PERSON" });
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // flushed, on its way
	editor.handleInput("\x1b"); // closes the suggestion list only
	await h.handlers.turn_end({ message: { stopReason: "stop" }, toolResults: [] }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 0, "the batch is still taken to be on its way");
});

test("two messages submitted close together: the first reaching pi does not release the second", async () => {
	const h = await setup();
	const editor = await editorOf(h);
	await h.handlers.agent_start({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	for (const t of ["FIRST", "SECOND"]) {
		h.state.editor = t;
		editor.handleInput("\r");
	}
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "FIRST" }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // FIRST flushed
	await h.handlers.message_end({ message: { role: "user", content: [{ type: "text", text: "FIRST" }], timestamp: 1 } }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	assert.equal(h.notices.length, 0, "SECOND is still inside another extension");
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "SECOND" }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // SECOND flushed
	await h.handlers.message_end({ message: { role: "user", content: [{ type: "text", text: "SECOND" }], timestamp: 2 } }, h.ctx);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	assert.equal(h.notices.length, 1, "then the notice");
});

test("a template typed during a run, then Esc: nothing is left holding notices", async () => {
	const h = await setup();
	const editor = await editorOf(h, { piQueue: () => "EXPANDED details" });
	await h.handlers.agent_start({}, h.ctx);
	h.state.editor = "/ask details";
	editor.handleInput("\r");
	await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "/ask details" }, h.ctx); // pi queues it
	editor.handleInput("\x1b"); // pi puts the expanded text back in the editor
	h.ctx.signal.aborted = true;
	await h.handlers.turn_end({ message: { stopReason: "aborted" }, toolResults: [] }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 1, "the notice wakes the model");
});

test("one Esc that returns two batches to the editor releases both", async () => {
	const h = await setup();
	const editor = await editorOf(h, { piQueue: () => "PERSON1\n\nPERSON2" });
	for (const t of ["PERSON1", "PERSON2"]) {
		await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: t }, h.ctx);
		await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx);
	}
	editor.handleInput("\x1b");
	h.ctx.signal.aborted = true;
	await h.handlers.turn_end({ message: { stopReason: "aborted" }, toolResults: [] }, h.ctx);
	h.state.idle = true;
	await h.handlers.agent_settled({}, h.ctx);
	await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
	await sleep(300);
	assert.equal(h.notices.length, 1, "the notice wakes the model");
});

test("a notice waits at a tool boundary where pi already has something queued", async () => {
	const h = await setup();
	await finishJobMidRun(h);
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}], context: { pendingMessages: [{}] } }, h.ctx);
	assert.equal(h.notices.length, 0, "behind another extension's queued message, and ahead of what the person sends next");
	await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}], context: { pendingMessages: [] } }, h.ctx);
	assert.equal(h.notices.length, 1);
});

test("pi's dequeue key puts its queue back too; a restore that merely contains a batch's text does not release it", async () => {
	for (const [restore, released] of [["PERSON", true], ["OTHER PERSON MORE", false]] as const) {
		const h = await setup();
		const editor = await editorOf(h, { piQueue: () => restore });
		await h.handlers.input({ source: "interactive", streamingBehavior: "steer", text: "PERSON" }, h.ctx);
		await h.handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, h.ctx); // flushed
		editor.handleInput("\x1b[1;3A"); // Alt+↑
		await h.handlers.turn_end({ message: { stopReason: "stop" }, toolResults: [] }, h.ctx);
		h.state.idle = true;
		await h.handlers.agent_settled({}, h.ctx);
		await h.tools.bash.execute("tc", { command: "true", run_in_background: true }, undefined, undefined, h.ctx);
		await sleep(300);
		assert.equal(h.notices.length, released ? 1 : 0, `${restore}: ${released ? "released" : "still on its way"}`);
	}
});
