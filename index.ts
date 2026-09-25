/**
 * pi-cc-steer — Claude Code's mid-turn steering, for pi.
 *
 * - Enter while the agent works: the message is held here, shown above the editor.
 * - At the next tool boundary every held message goes in at once, as one user message, in the same
 *   request as the tool results. The model sees it framed as "sent while you were working"; the
 *   transcript keeps your words.
 * - Ctrl+Enter (or Alt+S where a terminal can't send Ctrl+Enter), or Esc while messages are held, sends
 *   now: whatever is typed joins the held messages, the current step is interrupted, and they all start
 *   the next turn at once, framed so the model knows its previous step was cut off. As in Claude Code the
 *   interruption shows as one dim "Interrupted" line, not as an error.
 * - If the agent finishes first, the held messages start the next turn together, unframed.
 * - ↑ on the first line, or pi's own Alt+↑, pulls every held message back into the editor. Esc with
 *   nothing held still interrupts, as before; any interruption other than send-now returns the held
 *   messages to the editor instead of sending them.
 *
 * Works without changing pi's `steeringMode`: the batch is one message, so one-at-a-time
 * delivers all of it. Commands (`/…`) and shell input (`!…`) keep pi's own handling.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import {
	batchContent,
	batchKey,
	type Framing,
	type Framings,
	frameMidTurn,
	interruptedOutput,
	isAbortError,
	isQueueable,
	popEditable,
	type Queued,
	textOf,
} from "./steer.ts";

const ENTRY = "cc-steer.mid-turn";
const MARK = "cc-steer.interrupted";
const WIDGET = "cc-steer";
const INSTALLED = Symbol.for("pi-cc-steer.editor");
/** Claude Code's send-now key, plus a single-key fallback for terminals that can't tell Ctrl+Enter from Enter. */
const SEND_NOW_KEYS = ["ctrl+enter", "alt+s"] as const;
/** Marks a reply cut off by send-now, so its empty remains stay out of the model's context. */
const CUT = "ccSteerInterrupted";
/** How long a batch handed to pi as a new prompt may take to appear before it counts as not sent. */
const DELIVERY_CHECK_MS = 3000;

type Pending = { text: string; kind?: Framing; batch: Queued[]; how: "steer" | "prompt" };

export default function (pi: ExtensionAPI) {
	let queue: Queued[] = [];
	/** Batches handed to pi and not yet seen arriving as a user message. */
	let pending: Pending[] = [];
	const framings: Framings = { byTs: new Map(), byText: new Map() };
	/** Set by send-now: the run is being interrupted on purpose, so the queue goes out instead of back. */
	let sendNow = false;
	/** Set when the run was interrupted some other way: anything left queued waits for the person. */
	let hold = false;

	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (queue.length === 0) return ctx.ui.setWidget(WIDGET, undefined);
		const lines = queue.map((q) => {
			const first = q.text.split("\n")[0] ?? "";
			const more = q.text.includes("\n") ? " …" : "";
			const img = q.images.length > 0 ? ` [+${q.images.length} image]` : "";
			return ctx.ui.theme.fg("accent", "↳ ") + first + more + img;
		});
		const hint = sendNow
			? "  sending now…"
			: hold
				? "  held · sends with your next message · ↑ to edit"
				: "  sends at the next tool boundary · ctrl+enter or esc to send now · ↑ to edit";
		lines.push(ctx.ui.theme.fg("dim", hint));
		ctx.ui.setWidget(WIDGET, lines);
	};

	const popIntoEditor = (ctx: ExtensionContext): boolean => {
		const popped = popEditable(queue, ctx.ui.getEditorText());
		if (!popped) return false;
		queue = popped.kept;
		ctx.ui.setEditorText(popped.text);
		render(ctx);
		return true;
	};

	/** Hand the whole queue to pi as ONE message, framed for the model when `kind` is given. */
	const flush = (ctx: ExtensionContext, how: "steer" | "prompt", kind?: Framing) => {
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		const entry: Pending = { text: batchKey(batch.map((q) => q.text)), kind, batch, how };
		pending.push(entry);
		const content = batchContent(batch) as Parameters<ExtensionAPI["sendUserMessage"]>[0];
		pi.sendUserMessage(content, how === "steer" ? { deliverAs: "steer" } : undefined);
		render(ctx);
		if (how !== "prompt") return;
		// sendUserMessage reports nothing back. If pi refused the prompt (no model, no key), the batch never
		// appears as a message: give it back rather than lose it.
		// ponytail: fixed delay; a delivery acknowledgement from pi would replace it if one is added.
		setTimeout(() => {
			try {
				if (!pending.includes(entry) || !ctx.isIdle()) return;
				pending = pending.filter((p) => p !== entry);
				queue = [...entry.batch, ...queue];
				if (popIntoEditor(ctx)) ctx.ui.notify("Queued messages could not be sent and are back in the editor", "warning");
			} catch {
				// session replaced meanwhile: nothing to restore into
			}
		}, DELIVERY_CHECK_MS);
	};

	/** Ctrl+Enter / Esc while the agent works: queue what is typed, then interrupt so everything goes now. */
	const sendNowFromEditor = (ctx: ExtensionContext): boolean => {
		if (ctx.isIdle()) return false; // idle: nothing to interrupt, let the key's normal path run
		const typed = ctx.ui.getEditorText();
		if (typed.trim() !== "") {
			if (!isQueueable(typed)) return false; // a command: leave it to pi
			queue.push({ text: typed, images: [] });
			ctx.ui.setEditorText("");
		}
		if (queue.length === 0) return false;
		sendNow = true;
		hold = false;
		render(ctx);
		ctx.abort();
		return true;
	};

	/** The run has stopped: send what send-now was waiting for, or keep holding after another interruption. */
	const settle = (ctx: ExtensionContext) => {
		const interrupted = sendNow;
		sendNow = false;
		pending = pending.filter((p) => p.how === "prompt"); // an undelivered steer went back to pi's own queue
		if (hold || queue.length === 0 || !ctx.isIdle()) return render(ctx);
		if (interrupted) pi.sendMessage({ customType: MARK, content: "Interrupted", display: true });
		flush(ctx, "prompt", interrupted ? "interrupt" : undefined);
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
					// Esc with messages waiting sends them now, as in Claude Code (a bare Esc still just interrupts).
					if (!hold && keybindings.matches(data, "app.interrupt") && sendNowFromEditor(ctx)) return;
					const up = keybindings.matches(data, "tui.editor.cursorUp") && (e.getCursor?.().line ?? 0) === 0;
					// pi's own "restore queued messages" key (Alt+↑, Alt+Q on Windows): the messages live here, not in pi's queue.
					const dequeue = keybindings.matches(data, "app.message.dequeue");
					if ((up || dequeue) && popIntoEditor(ctx)) return;
				}
				handleInput(data);
			};
			return editor;
		};
		(factory as { [INSTALLED]?: boolean })[INSTALLED] = true;
		ctx.ui.setEditorComponent(factory);
	};

	pi.registerMessageRenderer(MARK, (_message, _options, theme) => new Text(theme.fg("dim", "Interrupted"), 1, 0));

	pi.on("session_start", (_event, ctx) => {
		queue = [];
		pending = [];
		sendNow = false;
		hold = false;
		framings.byTs.clear();
		framings.byText.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { key?: string; kind?: Framing; ts?: number } };
			if (e.type !== "custom" || e.customType !== ENTRY || !e.data?.key) continue;
			const kind = e.data.kind ?? "mid-turn";
			if (typeof e.data.ts === "number") framings.byTs.set(e.data.ts, { text: e.data.key, kind });
			else framings.byText.set(e.data.key, kind); // written by 0.1.0–0.1.3, before timestamps were kept
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
		if (queue.length === 0 || hold) return;
		// Send-now in progress: the run is being cancelled, so anything sent into it now would be cancelled too.
		if (sendNow) return; // settle() sends the queue once the run has stopped
		const stop = (event.message as { stopReason?: string }).stopReason;
		// An aborted TOOL ends the turn as "toolUse", not "aborted" (measured 2026-09-25): check the signal too.
		if (stop === "aborted" || ctx.signal?.aborted) {
			// Interrupted some other way: give the person their text back rather than sending it.
			hold = true;
			if (popIntoEditor(ctx)) ctx.ui.notify("Queued messages returned to the editor", "info");
			render(ctx);
			return;
		}
		if (stop !== "toolUse" && stop !== "stop") return; // error or length: pi decides retry first
		// Tool results in this turn → the agent is mid-task: frame it. Otherwise it is a fresh prompt.
		flush(ctx, "steer", event.toolResults.length > 0 ? "mid-turn" : undefined);
	});

	pi.on("agent_start", () => {
		hold = false; // the person started a new run: anything still held goes with it
	});

	// Anything still queued once pi has fully settled (after an interrupt, retries, compaction) starts the next turn.
	pi.on("agent_settled", (_event, ctx) => settle(ctx));
	// A send-now pressed during a manual /compact cancels the compaction, which ends without agent_settled.
	pi.on("session_compact", (_event, ctx) => {
		if (sendNow && ctx.isIdle()) settle(ctx);
	});
	pi.on("session_compact_failed", (_event, ctx) => {
		if (sendNow && ctx.isIdle()) settle(ctx);
	});

	// Send-now is a hand-off, not a failure. A tool cut off by it reports "interrupted", keeping any output
	// it had produced, instead of a red "Command aborted". A real failure that coincides is left alone.
	pi.on("tool_result", (event, ctx) => {
		if (!sendNow || !event.isError || !ctx.signal?.aborted) return;
		const text = event.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n");
		if (!isAbortError(text)) return;
		return { content: [{ type: "text", text: interruptedOutput(text) }], isError: false };
	});

	pi.on("message_end", (event) => {
		const m = event.message as {
			role: string;
			timestamp?: number;
			stopReason?: string;
			errorMessage?: string;
			content?: Array<{ type: string; text?: string }>;
		};

		// A batch arriving: from now on it is framed by its identity (timestamp + text), not by its text alone.
		if (m.role === "user") {
			const text = textOf(m.content);
			const i = pending.findIndex((p) => p.text === text);
			if (i === -1 || text === null) return;
			const [p] = pending.splice(i, 1);
			if (p.kind && typeof m.timestamp === "number") {
				framings.byTs.set(m.timestamp, { text, kind: p.kind });
				pi.appendEntry(ENTRY, { key: text, kind: p.kind, ts: m.timestamp });
			}
			return;
		}

		// The reply send-now cut off would render as a red "Operation aborted" / "Error: … aborted". Keep the
		// text it had streamed and let the run end quietly; settle() sends the queue. Left alone: a reply that
		// failed for another reason, and one cut mid tool call (its tool cards need pi's own abort handling).
		if (!sendNow || m.role !== "assistant") return;
		const cut = m.stopReason === "aborted" || (m.stopReason === "error" && /\babort/i.test(m.errorMessage ?? ""));
		if (!cut || (m.content ?? []).some((c) => c.type === "toolCall")) return;
		const text = (m.content ?? []).filter((c) => c.type === "text" && (c.text ?? "").trim() !== "");
		const { errorMessage: _drop, ...rest } = event.message as unknown as Record<string, unknown>;
		return { message: { ...rest, content: text, stopReason: "stop", [CUT]: true } as unknown as typeof event.message };
	});

	pi.on("context", (event) => {
		// Left out of the model's view: the on-screen "Interrupted" marker (the framing already says it), and a
		// cut-off reply with nothing left, which no provider accepts; pi leaves aborted replies out natively too.
		const msgs = (event.messages as Array<Record<string, unknown>>).filter(
			(m) =>
				!(m.role === "custom" && m.customType === MARK) && !(m[CUT] && Array.isArray(m.content) && m.content.length === 0),
		);
		const out = frameMidTurn(msgs as never[], framings);
		if (out === (msgs as never[]) && msgs.length === event.messages.length) return;
		return { messages: out };
	});
}
