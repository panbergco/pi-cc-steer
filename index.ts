/**
 * pi-cc-steer — Claude Code's mid-turn steering, for pi.
 *
 * - Enter while the agent works: the message is held here, shown above the editor.
 * - At the next tool boundary every held message goes in at once, as one user message with one
 *   text block each, in the same request as the tool results. The model sees each block framed
 *   as "sent while you were working"; the transcript keeps your words.
 * - If the agent finishes first, the held messages start the next turn together, unframed.
 * - ↑ on the first line, or Esc, pulls every held message back into the editor. Esc with nothing
 *   held still interrupts, as before.
 *
 * Works without changing pi's `steeringMode`: the batch is one message, so one-at-a-time
 * delivers all of it. Commands (`/…`) and shell input (`!…`) keep pi's own handling.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { batchContent, batchKey, frameMidTurn, isQueueable, popEditable, type Queued } from "./steer.ts";

const ENTRY = "cc-steer.mid-turn";
const WIDGET = "cc-steer";
const INSTALLED = Symbol.for("pi-cc-steer.editor");

export default function (pi: ExtensionAPI) {
	let queue: Queued[] = [];
	const midTurn = new Set<string>();

	const render = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (queue.length === 0) return ctx.ui.setWidget(WIDGET, undefined);
		const lines = queue.map((q) => {
			const first = q.text.split("\n")[0] ?? "";
			const more = q.text.includes("\n") ? " …" : "";
			const img = q.images.length > 0 ? ` [+${q.images.length} image]` : "";
			return ctx.ui.theme.fg("accent", "↳ ") + first + more + img;
		});
		lines.push(ctx.ui.theme.fg("dim", "  sends at the next tool boundary · ↑ or esc to edit"));
		ctx.ui.setWidget(WIDGET, lines);
	};

	/** Hand the whole queue to pi as ONE message. `midTurn` marks it for framing. */
	const flush = (ctx: ExtensionContext, how: "steer" | "prompt", framed: boolean) => {
		if (queue.length === 0) return;
		const batch = queue;
		queue = [];
		if (framed) {
			const key = batchKey(batch.map((q) => q.text));
			midTurn.add(key);
			pi.appendEntry(ENTRY, { key });
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

	const installEditor = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		const previous = ctx.ui.getEditorComponent();
		if ((previous as { [INSTALLED]?: boolean } | undefined)?.[INSTALLED]) return;
		const factory: NonNullable<typeof previous> = (tui, theme, keybindings) => {
			const editor = previous?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data: string) => {
				const e = editor as typeof editor & { isShowingAutocomplete?: () => boolean; getCursor?: () => { line: number } };
				if (queue.length > 0 && !e.isShowingAutocomplete?.()) {
					const up = keybindings.matches(data, "tui.editor.cursorUp") && (e.getCursor?.().line ?? 0) === 0;
					const esc = keybindings.matches(data, "app.interrupt");
					if ((up || esc) && popIntoEditor(ctx)) return;
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
		midTurn.clear();
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: { key?: string } };
			if (e.type === "custom" && e.customType === ENTRY && e.data?.key) midTurn.add(e.data.key);
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
		const stop = (event.message as { stopReason?: string }).stopReason;
		if (stop === "aborted") {
			// The run was interrupted: give the person their text back rather than sending it.
			if (popIntoEditor(ctx)) ctx.ui.notify("Queued messages returned to the editor", "info");
			return;
		}
		if (stop !== "toolUse" && stop !== "stop") return; // error or length: pi decides retry first
		// Tool results in this turn → the agent is mid-task: frame it. Otherwise it is a fresh prompt.
		flush(ctx, "steer", event.toolResults.length > 0);
	});

	// Anything still held once pi has fully settled (after retries, compaction) starts the next turn.
	pi.on("agent_settled", (_event, ctx) => {
		if (queue.length > 0 && ctx.isIdle()) flush(ctx, "prompt", false);
	});

	pi.on("context", (event) => {
		if (midTurn.size === 0) return;
		return { messages: frameMidTurn(event.messages as never[], midTurn) };
	});
}
