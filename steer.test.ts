import { test } from "node:test";
import assert from "node:assert/strict";
import { batchContent, batchKey, frame, type Framings, frameMidTurn, INTERRUPTED_NOTE, interruptedOutput, isAbortError, isQueueable, messageId, popEditable } from "./steer.ts";

const byText = (entries: [string, "mid-turn" | "interrupt"][]): Framings => ({ byId: new Map(), byText: new Map(entries) });

test("a batch is one message: one text block per queued message, images last", () => {
  const c = batchContent([{ text: "a", images: [] }, { text: "b", images: [{ type: "image", data: "x" }] }]);
  assert.deepEqual(c, [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "image", data: "x" }]);
});

test("only the delivered mid-turn batch is framed, whether pi kept its blocks or joined them", () => {
  const mid = byText([[batchKey(["fix the test", "also rename it"]), "mid-turn"]]);
  const msgs = [
    { role: "user", content: "hello" },
    { role: "user", content: [{ type: "text", text: "fix the test" }, { type: "text", text: "also rename it" }] },
    { role: "user", content: [{ type: "text", text: "fix the test\nalso rename it" }, { type: "image", data: "x" }] },
    { role: "user", content: [{ type: "text", text: "fix the test" }] },
  ];
  const out = frameMidTurn(msgs, mid);
  assert.equal(out[0], msgs[0]);
  assert.equal(out[3], msgs[3]);
  assert.deepEqual(out[1].content, [{ type: "text", text: frame("fix the test\nalso rename it") }]);
  assert.deepEqual(out[2].content, [{ type: "text", text: frame("fix the test\nalso rename it") }, { type: "image", data: "x" }]);
  assert.equal((msgs[1].content as { text: string }[])[0].text, "fix the test", "transcript untouched");
  assert.deepEqual(frameMidTurn(msgs, mid), out);
});

test("up pulls text-only messages ahead of the draft; image messages stay queued", () => {
  const img = { text: "see this", images: [{}] };
  const r = popEditable([{ text: "one", images: [] }, img, { text: "two", images: [] }], "draft");
  assert.deepEqual(r, { text: "one\ntwo\ndraft", kept: [img] });
  assert.equal(popEditable([img], ""), null);
  assert.equal(popEditable([{ text: "x", images: [] }], "  ")!.text, "x");
});

test("commands and shell input are left to pi", () => {
  assert.equal(isQueueable("do it"), true);
  for (const t of ["/model", "  /skill:x", "!ls", "", "   "]) assert.equal(isQueueable(t), false, t);
});

test("an interrupted batch is framed as an interruption, a mid-turn one as mid-turn", () => {
  const framed = byText([["stop, use pnpm", "interrupt"], ["also add a test", "mid-turn"]]);
  const out = frameMidTurn([
    { role: "user", content: "stop, use pnpm" },
    { role: "user", content: "also add a test" },
  ], framed);
  assert.equal(out[0].content, frame("stop, use pnpm", "interrupt"));
  assert.equal(out[1].content, frame("also add a test", "mid-turn"));
  assert.match(out[0].content as string, /interrupted your previous step/);
  assert.notEqual(frame("x", "interrupt"), frame("x", "mid-turn"));
});

test("a tool cut off by send-now keeps its output and reads as interrupted, not aborted", () => {
  assert.equal(interruptedOutput("tick 1\ntick 2\n\nCommand aborted"), "tick 1\ntick 2\n\n" + INTERRUPTED_NOTE);
  assert.equal(interruptedOutput("Operation aborted"), INTERRUPTED_NOTE);
  assert.equal(interruptedOutput("partial\nabortedness is a word"), "partial\nabortedness is a word\n\n" + INTERRUPTED_NOTE);
});

test("a batch is framed by identity: the same words sent at another time stay unframed", () => {
  const f: Framings = { byId: new Map([[messageId(2000, "continue"), "mid-turn"]]), byText: new Map() };
  const msgs = [
    { role: "user", content: "continue", timestamp: 1000 },
    { role: "user", content: "continue", timestamp: 2000 },
    { role: "user", content: "continue", timestamp: 3000 },
    { role: "user", content: "something else", timestamp: 2000 },
  ];
  const out = frameMidTurn(msgs, f);
  assert.deepEqual(out.map((m) => m.content), ["continue", frame("continue"), "continue", "something else"]);
});

test("only the abort itself counts as an interruption; a real failure is left as an error", () => {
  assert.equal(isAbortError("tick 1\n\nCommand aborted"), true);
  assert.equal(isAbortError("This operation was aborted"), true);
  assert.equal(isAbortError("EACCES: permission denied, open 'x'"), false);
  assert.equal(isAbortError("Command aborted by policy: rm -rf is blocked\nexit 1"), false);
});
