/**
 * pi-cc-steer — Claude Code's mid-turn steering, for pi.
 *
 * - Enter while the agent works: the message is held here, shown above the editor.
 * - At the next tool boundary every held message goes in at once, as one user message with one
 *   text block each, in the same request as the tool results. The model sees each block framed
 *   as "sent while you were working"; the transcript keeps your words.
 * - Ctrl+Enter (or Alt+S where a terminal can't send Ctrl+Enter) sends now: whatever is typed joins
 *   the held messages, the current turn is interrupted, and they all start the next turn at once,
 *   framed so the model knows its previous step was cut off. Claude Code's "send now" key.
 * - If the agent finishes first, the held messages start the next turn together, unframed.
 * - ↑ on the first line, Esc, or pi's own Alt+↑ pulls every held message back into the editor. Esc with
 *   nothing held still interrupts, as before.
 *
 * Works without changing pi's `steeringMode`: the batch is one message, so one-at-a-time
 * delivers all of it. Commands (`/…`) and shell input (`!…`) keep pi's own handling.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { batchContent, batchKey, type Framing, frameMidTurn, isQueueable, popEditable, type Queued } from "./steer.ts";

const ENTRY = "cc-steer.mid-turn";
const WIDGET = "cc-steer";
const INSTALLED = Symbol.for("pi-cc-steer.editor");
/** Claude Code's send-now key, plus a single-key fallback for terminals that can't tell Ctrl+Enter from Enter. */
const SEND_NOW_KEYS = ["ctrl+enter", "alt+s"] as const;

export default function (pi: ExtensionAPI) {
	let queue: Queued[] = [];
	const framed = new Map<string, Framing>();
	/** Set by send-now: the run is being interrupted on purpose, so the queue goes out instead of back. */
	let sendNow = false;

	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (queue.length === 0) return ctx.ui.setWidget(WIDGET, undefined);
		const lines = queue.map((q) => {
			const first = q.text.split("\n")[0] ?? "";
			const more = q.text.includes("\n") ? " …" : "";
			const img = q.images.length > 0 ? ` [+${q.images.length} image]` : "";
			return ctx.ui.theme.fg("accent", "↳ ") + first + more + img;
		});
		lines.push(
			ctx.ui.theme.fg(
				"dim",
				sendNow ? "  interrupting to send now…" : "  sends at the next tool boundary · ctrl+enter to send now · ↑ or esc to edit",
			),
		);
		ctx.ui.setWidget(WIDGET, lines);
	};

	/** Hand the whole queue to pi as ONE message, framed for the model when `kind` is given. */
	const flush = (ctx: ExtensionContext, how: "steer" | "prompt", kind?: Framing) => {
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		if (kind) {
			const key = batchKey(batch.map((q) => q.text));
			framed.set(key, kind);
			pi.appendEntry(ENTRY, { key, kind });
		}
		const content = batchContent(batch) as Parameters<ExtensionAPI["sendUserMessage"]>[0];
		pi.sendUserMessage(content, how === "steer" ? { deliverAs: "steer" } : undefined);
		render(ctx);
	};

	const popIntoEditor = (ctx: ExtensionContext): boolean => {
		const popped = popEditable(queue, ctx.ui.getEditorText());
		if (!popped) return false;
		queue = popped.kept;
		ctx.ui.setEditorText(popped.text);
		render(ctx);
		return true;
	};

	/** Ctrl+Enter while the agent works: queue what is typed, then interrupt so everything goes now. */
	const sendNowFromEditor = (ctx: ExtensionContext): boolean => {
		if (ctx.isIdle()) return false; // idle: nothing to interrupt, let Enter's normal path run
		const typed = ctx.ui.getEditorText();
		if (typed.trim() !== "") {
			if (!isQueueable(typed)) return false; // a command: leave it to pi
			queue.push({ text: typed, images: [] });
			ctx.ui.setEditorText("");
		}
		if (queue.length === 0) return false;
		sendNow = true;
		render(ctx);
		ctx.abort();
		return true;
	};

	const installEditor = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if ((previous as { [INSTALLED]?: boolean } | undefined)?.[INSTALLED]) return;
		const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const e = editor as typeof editor & { isShowingAutocomplete?: () => boolean; getCursor?: () => { line: number } };
				if (e.isShowingAutocomplete?.()) return handleInput(data);
				if (SEND_NOW_KEYS.some((k) => matchesKey(data, k)) && sendNowFromEditor(ctx)) return;
				if (queue.length > 0 && !sendNow) {
					const up = keybindings.matches(data, "tui.editor.cursorUp") && (e.getCursor?.().line ?? 0) === 0;
					const esc = keybindings.matches(data, "app.interrupt");
					// pi's own "restore queued messages" key (Alt+↑, Alt+Q on Windows): the messages live here, not in pi's queue.
					const dequeue = keybindings.matches(data, "app.message.dequeue");
					if ((up || esc || dequeue) && popIntoEditor(ctx)) return;
				}
				handleInput(data);
			};
			return editor;
		};
		(factory as { [INSTALLED]?: boolean })[INSTALLED] = true;
		ctx.ui.setEditorComponent(factory);
	};

	pi.on("session_start", (_event, ctx) => {
		queue = [];
		sendNow = false;
		framed.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { key?: string; kind?: Framing } };
			if (e.type === "custom" && e.customType === ENTRY && e.data?.key) framed.set(e.data.key, e.data.kind ?? "mid-turn");
		}
		// After other extensions' session_start, so a custom editor installed there is wrapped too.
		setTimeout(() => installEditor(ctx), 0);
		render(ctx);
	});

	pi.on("input", (event, ctx) => {
		if (event.source !== "interactive" || event.streamingBehavior !== "steer" || !isQueueable(event.text)) {
			return { action: "continue" };
		}
		queue.push({ text: event.text, images: event.images ?? [] });
		render(ctx);
		return { action: "handled" };
	});

	pi.on("turn_end", (event, ctx) => {
		if (queue.length === 0) return;
		// Send-now in progress: the run is being cancelled, so anything sent into it now would be cancelled too.
		// An aborted TOOL ends the turn as "toolUse", not "aborted" (measured 2026-09-25), so check the flag first.
		if (sendNow) return; // agent_settled sends the queue once the run has stopped
		const stop = (event.message as { stopReason?: string }).stopReason;
		if (stop === "aborted") {
			// Interrupted some other way: give the person their text back rather than sending it.
			if (popIntoEditor(ctx)) ctx.ui.notify("Queued messages returned to the editor", "info");
			return;
		}
		if (stop !== "toolUse" && stop !== "stop") return; // error or length: pi decides retry first
		// Tool results in this turn → the agent is mid-task: frame it. Otherwise it is a fresh prompt.
		flush(ctx, "steer", event.toolResults.length > 0 ? "mid-turn" : undefined);
	});

	// Anything still held once pi has fully settled (after an interrupt, retries, compaction) starts the next turn.
	pi.on("agent_settled", (_event, ctx) => {
		const interrupted = sendNow;
		sendNow = false; // cleared on every settle, so a send-now that raced a normal delivery never sticks
		if (queue.length === 0 || !ctx.isIdle()) return render(ctx);
		flush(ctx, "prompt", interrupted ? "interrupt" : undefined);
	});

	pi.on("context", (event) => {
		if (framed.size === 0) return;
		return { messages: frameMidTurn(event.messages as never[], framed) };
	});
}
