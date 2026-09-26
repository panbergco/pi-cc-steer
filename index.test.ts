// Drives the real index.ts handlers with a stub pi (no TUI, no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import ext from "./index.ts";

function setup() {
	const handlers: Record<string, Function> = {};
	const sent: unknown[] = [];
	const notes: string[] = [];
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] = h),
		registerEntryRenderer() {},
		appendEntry() {},
		sendUserMessage: (c: unknown) => sent.push(c),
		registerTool() {},
		registerShortcut() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendMessage() {},
	};
	ext(pi);
	const state = { idle: false, editor: "" };
	const ctx: any = {
		mode: "tui",
		isIdle: () => state.idle,
		signal: { aborted: false },
		ui: {
			setWidget() {},
			notify: (m: string) => notes.push(m),
			getEditorText: () => state.editor,
			setEditorText: (t: string) => (state.editor = t),
			theme: { fg: (_c: string, t: string) => t },
			getEditorComponent() {},
			setEditorComponent() {},
		},
		sessionManager: { getEntries: () => [] },
	};
	handlers.session_start({}, ctx);
	return { handlers, sent, notes, state, ctx };
}

const img = { type: "image", data: "x", mimeType: "image/png" };

test("messages typed mid-turn go in together at the next tool boundary, as one steer", () => {
	const { handlers, sent, ctx } = setup();
	handlers.input({ source: "interactive", streamingBehavior: "steer", text: "use pnpm" }, ctx);
	handlers.input({ source: "interactive", streamingBehavior: "steer", text: "and add a test" }, ctx);
	assert.equal(sent.length, 0, "held while the tool runs");
	handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, ctx);
	assert.deepEqual(sent, [[{ type: "text", text: "use pnpm" }, { type: "text", text: "and add a test" }]]);
});

test("an interruption that is not a send-now returns the text to the editor, drops images with a warning, sends nothing", () => {
	const { handlers, sent, notes, state, ctx } = setup();
	handlers.input({ source: "interactive", streamingBehavior: "steer", text: "look at this", images: [img] }, ctx);
	handlers.input({ source: "interactive", streamingBehavior: "steer", text: "and fix it" }, ctx);
	state.editor = "draft";
	ctx.signal.aborted = true;
	handlers.turn_end({ message: { stopReason: "toolUse" }, toolResults: [{}] }, ctx);
	assert.equal(state.editor, "look at this\nand fix it\ndraft");
	assert.match(notes.at(-1)!, /1 attached image\(s\) dropped/);
	state.idle = true;
	handlers.agent_settled({}, ctx);
	assert.equal(sent.length, 0, "nothing sent after the person interrupted");
});
