// Drives the real index.ts handlers with a stub pi (no TUI, no model).
import { test } from "node:test";
import assert from "node:assert/strict";
import ext from "./index.ts";

test("after an interruption, held images ride in the next message the person sends; commands and follow-ups do not take them", () => {
	const handlers: Record<string, Function> = {};
	const sent: unknown[] = [];
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] = h),
		registerEntryRenderer() {},
		appendEntry() {},
		sendUserMessage: (c: unknown) => sent.push(c),
	};
	ext(pi);
	let idle = false, editor = "";
	const ctx: any = {
		mode: "tui", isIdle: () => idle, signal: { aborted: true },
		ui: { setWidget() {}, notify() {}, getEditorText: () => editor, setEditorText: (t: string) => (editor = t), theme: { fg: (_c: string, t: string) => t }, getEditorComponent() {}, setEditorComponent() {} },
		sessionManager: { getEntries: () => [] },
	};
	const img = { type: "image", data: "x", mimeType: "image/png" };
	handlers.session_start({}, ctx);
	// mid-run: an image message and a text message are queued
	assert.deepEqual(handlers.input({ source: "interactive", streamingBehavior: "steer", text: "look at this", images: [img] }, ctx), { action: "handled" });
	handlers.input({ source: "interactive", streamingBehavior: "steer", text: "and fix it" }, ctx);
	// another extension aborts: text returns to the editor, the image message is held, nothing is sent
	handlers.turn_end({ message: { stopReason: "aborted" }, toolResults: [] }, ctx);
	assert.equal(editor, "and fix it");
	idle = true;
	handlers.agent_settled({}, ctx);
	assert.equal(sent.length, 0, "held, not sent on settle");
	// a /command or an Alt+Enter follow-up does not take the held messages
	assert.deepEqual(handlers.input({ source: "interactive", text: "/model" }, ctx), { action: "continue" });
	assert.deepEqual(handlers.input({ source: "interactive", streamingBehavior: "followUp", text: "after that, summarise" }, ctx), { action: "continue" });
	// the person sends a new message while idle: the held image rides in it
	const r = handlers.input({ source: "interactive", text: "compare it with the old one" }, ctx);
	assert.deepEqual(r, { action: "transform", text: "look at this\ncompare it with the old one", images: [img] });
	assert.deepEqual(handlers.input({ source: "interactive", text: "next" }, ctx), { action: "continue" }, "nothing held any more");
});
