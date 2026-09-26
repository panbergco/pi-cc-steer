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
 *   nothing held still interrupts, as before; an interruption other than send-now, seen at the end of a
 *   turn, returns the held messages' text to the editor instead of sending them, as pi does with its own queue.
 *
 * - Ctrl+B while a bash command runs moves it to the background (Claude Code's key; press it twice inside
 *   tmux). The model is told, carries on, and is notified when the command finishes. See background/.
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
	messageId,
	popAll,
	popEditable,
	type Queued,
	textOf,
} from "./steer.ts";
import { registerBackground } from "./background/index.ts";

const ENTRY = "cc-steer.mid-turn";
const MARK = "cc-steer.interrupted";
const WIDGET = "cc-steer";
const INSTALLED = Symbol.for("pi-cc-steer.editor");
/** Claude Code's send-now key, plus a single-key fallback for terminals that can't tell Ctrl+Enter from Enter. */
const SEND_NOW_KEYS = ["ctrl+enter", "alt+s"] as const;
/** Marks a reply cut off by send-now, so its empty remains stay out of the model's context. */
const CUT = "ccSteerInterrupted";

type Pending = { text: string; kind?: Framing; how: "steer" | "prompt"; images: boolean; settles: number };

export default function (pi: ExtensionAPI) {
	// Claude Code's background bash (Ctrl+B). It replaces pi's bash tool, so it can be switched off.
	const background = process.env.PI_CC_STEER_BACKGROUND === "0" ? undefined : registerBackground(pi);
	// Notices wait while a batch of the person's messages is on its way into pi (handed over, not yet arrived).
	background?.setPersonPending(() => pending.some((p) => p.how === "steer"));
	let queue: Queued[] = [];
	/** Batches handed to pi and not yet seen arriving as a user message. */
	let pending: Pending[] = [];
	const framings: Framings = { byId: new Map(), byText: new Map() };
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
		const hint = sendNow ? "  sending now…" : "  sends at the next tool boundary · ctrl+enter or esc to send now · ↑ to edit";
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
		pending.push({ text: batchKey(batch.map((q) => q.text)), kind, how, images: batch.some((q) => q.images.length > 0), settles: 0 });
		const content = batchContent(batch) as Parameters<ExtensionAPI["sendUserMessage"]>[0];
		// A prompt of the person's (send-now, or messages typed after the last turn): no notice turn may start before
		// it, or pi would reject it; its notices ride in it.
		if (how === "prompt") background?.promptSubmitted();
		// pi reports nothing back; if it refuses the prompt (no model, no key) it shows its own error.
		pi.sendUserMessage(content, how === "steer" ? { deliverAs: "steer" } : undefined);
		render(ctx);
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
		render(ctx);
		ctx.abort();
		watch(ctx);
		return true;
	};

	/**
	 * Normally agent_settled ends a send-now. Some stops never emit it (a /compact cancelled late, another
	 * extension still busy in a compaction hook), so once pi has stayed idle for two checks in a row, settle anyway.
	 * ponytail: polling; an "operation ended" event from pi would replace it if one is added.
	 */
	const watch = (ctx: ExtensionContext) => {
		let idleChecks = 0;
		const timer = setInterval(() => {
			try {
				if (!sendNow) return clearInterval(timer);
				idleChecks = ctx.isIdle() ? idleChecks + 1 : 0;
				if (idleChecks < 2) return;
				clearInterval(timer);
				settle(ctx);
			} catch {
				clearInterval(timer); // session replaced: its session_start resets everything
			}
		}, 500);
	};

	/** The run has stopped: send what send-now was waiting for, or anything typed after the last turn ended. */
	const settle = (ctx: ExtensionContext) => {
		const interrupted = sendNow;
		sendNow = false;
		// An undelivered steer went back to pi's own queue when the run ended: drop its record so it cannot claim a
		// later identical message. A prompt may still be waiting its turn behind other queued prompts: keep it.
		// pi's Esc puts queued messages that never reached the model back in the editor: a batch whose text is now
		// there is not on its way any more.
		const editorText = escThisRun && ctx.mode === "tui" ? ctx.ui.getEditorText() : "";
		escThisRun = false;
		pending = pending.filter((p) => p.how !== "steer" || !editorText || !editorText.startsWith(p.text));
		// A batch flushed during the run may still be on its way in (another extension's slow input handler): when
		// it lands it starts the next run, so notices ride after it rather than starting a turn ahead of it.
		const batchOnItsWay = pending.some((p) => p.how === "steer");
		// A steer batch not yet arrived may still be on its way (another extension's slow input handler) and land as
		// the next prompt: keep its record through this settle, and drop it at the next one (pi discarded it).
		pending = pending.filter((p) => p.how === "prompt" || p.settles++ === 0);
		const sending = queue.length > 0 && ctx.isIdle();
		// Background finish notices not yet delivered: they ride in the next prompt when one is coming (after it,
		// as in Claude Code); otherwise they start a turn once pi has fully stopped.
		background?.deliverHeld(sending || interrupted || batchOnItsWay || !ctx.isIdle());
		if (!sending) return render(ctx);
		// A session entry, not a message: shown in the transcript, never sent to a model (compaction included).
		if (interrupted) pi.appendEntry(MARK, {});
		flush(ctx, "prompt", interrupted ? "interrupt" : undefined);
	};

	/** What a submission will do, for the notice hold: a message or a prompt template/skill starts a run; a command
	 *  might not (held briefly); `!shell` never does (not held). */
	const holdForSubmission = (text: string) => {
		if (!background || text === "" || text.startsWith("!")) return;
		if (!text.startsWith("/")) return background.promptSubmitted();
		const name = text.slice(1).split(/\s/)[0];
		const cmd = pi.getCommands().find((c) => c.name === name);
		background.promptSubmitted(cmd && cmd.source !== "extension" ? undefined : "command");
	};

	/** Esc pressed during this run (pi then returns queued messages to the editor). */
	let escThisRun = false;

	const installEditor = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if ((previous as { [INSTALLED]?: boolean } | undefined)?.[INSTALLED]) return;
		const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const e = editor as typeof editor & { isShowingAutocomplete?: () => boolean; getCursor?: () => { line: number } };
				// Ctrl+B while a command runs moves it to the background, as in Claude Code; otherwise it is pi's
				// cursor-left. Queued messages then go in at the tool boundary that this creates.
				if (background?.hasForeground() && matchesKey(data, "ctrl+b") && background.backgroundAll(ctx)) return;
				if (keybindings.matches(data, "app.interrupt") && !ctx.isIdle()) escThisRun = true;
				if (e.isShowingAutocomplete?.()) return handleInput(data); // Enter here accepts a completion
				// Enter on something: it is about to become a prompt, a queued message (which becomes a prompt if the run
				// ends first) or a command such as /new. Tell the engine now, before any extension processes it, so no
				// notice turn starts — or goes in — ahead of it.
				if (keybindings.matches(data, "tui.input.submit")) holdForSubmission(ctx.ui.getEditorText().trim());
				if (SEND_NOW_KEYS.some((k) => matchesKey(data, k)) && sendNowFromEditor(ctx)) return;
				if (queue.length > 0 && !sendNow) {
					// Esc with messages waiting sends them now, as in Claude Code (a bare Esc still just interrupts).
					if (keybindings.matches(data, "app.interrupt") && sendNowFromEditor(ctx)) return;
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

	pi.registerEntryRenderer(MARK, (_entry, _options, theme) => new Text(theme.fg("dim", "Interrupted"), 1, 0));

	pi.on("session_start", (_event, ctx) => {
		queue = [];
		pending = [];
		sendNow = false;

		framings.byId.clear();
		framings.byText.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { key?: string; kind?: Framing; ts?: number } };
			if (e.type !== "custom" || e.customType !== ENTRY || !e.data?.key) continue;
			const kind = e.data.kind ?? "mid-turn";
			if (typeof e.data.ts === "number") framings.byId.set(messageId(e.data.ts, e.data.key), kind);
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
		// Typed while pi was busy, but another extension held it until the run ended: queuing it now would strand
		// it. Let pi take it — as a new prompt, or as its own queued message if a run has started meanwhile.
		if (ctx.isIdle()) return { action: "continue" };
		queue.push({ text: event.text, images: event.images ?? [] });
		background?.submissionQueued();
		render(ctx);
		return { action: "handled" };
	});

	pi.on("turn_end", (event, ctx) => {
		// Send-now in progress: the run is being cancelled, so anything sent into it now would be cancelled too.
		if (sendNow) return; // settle() sends the queue once the run has stopped
		const stop = (event.message as { stopReason?: string }).stopReason;
		// An aborted TOOL ends the turn as "toolUse", not "aborted" (measured 2026-09-25): check the signal too.
		const aborted = stop === "aborted" || Boolean(ctx.signal?.aborted);
		const flushed = !aborted && queue.length > 0 && (stop === "toolUse" || stop === "stop");
		deliverMessages(event, ctx, stop, aborted);
		// Background finish notices go in at a tool boundary (Claude Code's 'next') — but not at one where the
		// person's own messages were just queued: pi finishes queuing those asynchronously, so a notice sent now
		// would overtake them. They go at the next boundary, or when the run ends.
		if (!aborted && stop === "toolUse" && !flushed) background?.deliverMidRun();
	});

	const deliverMessages = (
		event: { toolResults: unknown[] },
		ctx: ExtensionContext,
		stop: string | undefined,
		aborted: boolean,
	) => {
		if (queue.length === 0) return;
		if (aborted) {
			// Interrupted some other way: give the person their text back rather than sending it, as pi does.
			const { text, droppedImages } = popAll(queue, ctx.ui.getEditorText());
			queue = [];
			ctx.ui.setEditorText(text);
			render(ctx);
			ctx.ui.notify(
				droppedImages > 0
					? `Queued messages returned to the editor; ${droppedImages} attached image(s) dropped, paste them again`
					: "Queued messages returned to the editor",
				droppedImages > 0 ? "warning" : "info",
			);
			return;
		}
		if (stop !== "toolUse" && stop !== "stop") return; // error or length: pi decides retry first
		// Tool results in this turn → the agent is mid-task: frame it. Otherwise it is a fresh prompt.
		flush(ctx, "steer", event.toolResults.length > 0 ? "mid-turn" : undefined);
	};

	// Anything still queued once pi has fully settled (after an interrupt, retries, compaction) starts the next turn.
	pi.on("agent_settled", (_event, ctx) => settle(ctx));

	// Send-now is a hand-off, not a failure. A tool cut off by it reports "interrupted", keeping any output
	// it had produced, instead of a red "Command aborted". A real failure that coincides is left alone.
	pi.on("tool_result", (event, ctx) => {
		if (!sendNow || !event.isError || !ctx.signal?.aborted) return;
		const text = event.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("\n");
		if (!isAbortError(text)) return;
		const others = event.content.filter((c) => c.type !== "text");
		return { content: [{ type: "text", text: interruptedOutput(text) }, ...others], isError: false };
	});

	pi.on("message_end", (event, ctx) => {
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
			if (text === null) return;
			// pi may append notes to a prompt that carries images, so for those the batch is the start of the text.
			const i = pending.findIndex((p) => text === p.text || (p.images && text.startsWith(`${p.text}\n`)));
			// Not recognised: it may be a batch another extension rewrote, or another extension's own message. It is
			// not taken as the batch's arrival (that could let a notice go ahead of the person's message); a rewritten
			// batch keeps notices back until the run ends, and they then ride in the next prompt.
			if (i === -1) return;
			const [p] = pending.splice(i, 1);
			if (p.kind && typeof m.timestamp === "number") {
				framings.byId.set(messageId(m.timestamp, text), p.kind);
				pi.appendEntry(ENTRY, { key: text, kind: p.kind, ts: m.timestamp });
			}
			return;
		}

		// The reply send-now cut off would render as a red "Operation aborted" / "Error: … aborted". Keep the
		// text it had streamed and let the run end quietly; settle() sends the queue. Left alone: a reply that
		// failed for another reason, and one cut mid tool call (its tool cards need pi's own abort handling).
		if (!sendNow || m.role !== "assistant" || !ctx.signal?.aborted) return;
		const cut = m.stopReason === "aborted" || (m.stopReason === "error" && isAbortError(m.errorMessage ?? ""));
		if (!cut || (m.content ?? []).some((c) => c.type === "toolCall")) return;
		const text = (m.content ?? []).filter((c) => c.type === "text" && (c.text ?? "").trim() !== "");
		const { errorMessage: _drop, ...rest } = event.message as unknown as Record<string, unknown>;
		return { message: { ...rest, content: text, stopReason: "stop", [CUT]: true } as unknown as typeof event.message };
	});

	pi.on("context", (event) => {
		// Left out of the model's view: a cut-off reply with nothing left, which no provider accepts (pi leaves
		// aborted replies out natively too), "Interrupted" markers that 0.1.4 stored as custom messages, and a
		// background notice that arrived a second time.
		const msgs = (event.messages as Array<Record<string, unknown>>).filter(
			(m) =>
				!(m[CUT] && Array.isArray(m.content) && m.content.length === 0) &&
				!(m.role === "custom" && m.customType === MARK) &&
				!(m.role === "custom" && (m.details as { duplicate?: boolean } | undefined)?.duplicate),
		);
		const out = frameMidTurn(msgs as never[], framings);
		if (out === (msgs as never[]) && msgs.length === event.messages.length) return;
		return { messages: out };
	});
}
