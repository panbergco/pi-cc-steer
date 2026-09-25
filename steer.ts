/**
 * Pure queue logic for pi-cc-steer: no pi imports, so it can be tested with plain `node --test`.
 *
 * The behaviour it serves, read from Claude Code's source (studied, not copied):
 *  - messages typed while the agent works are held, then ALL delivered together at the next
 *    tool boundary, inside the same request as the tool results;
 *  - the model sees them framed as "sent while you were working — address it once your current task
 *    is done" (Claude Code: utils/messages.ts, the 'human' origin of its queued-message wrapper);
 *  - the person sees their own words, unframed;
 *  - ↑ pulls every queued message back into the editor to edit;
 *  - Esc or Ctrl+Enter sends now: interrupt the current turn and deliver everything queued at once.
 */

export interface Queued {
	text: string;
	images: unknown[];
}

/**
 * How a batch reaches the model. The transcript keeps the plain text.
 * - "mid-turn": delivered at a tool boundary while the agent kept working.
 * - "interrupt": the person stopped the turn to send it. pi drops the aborted reply from the
 *   model's context, so without this the model would not know it was cut off.
 */
export type Framing = "mid-turn" | "interrupt";

export function frame(text: string, kind: Framing = "mid-turn"): string {
	if (kind === "interrupt") {
		return (
			"<system-reminder>\nThe user interrupted your previous step to send the following:\n" +
			text +
			"\n\nYour previous step was stopped before it finished. Address this now; resume the earlier work only if it still fits.\n</system-reminder>"
		);
	}
	return (
		"<system-reminder>\nThe user sent this new message while you were working:\n" +
		text +
		"\n\nOnce your current task is complete, you must respond to it. Do not ignore it.\n</system-reminder>"
	);
}

/** One content array for the whole batch: each queued message is its own text block, images after. */
export function batchContent(queue: Queued[]): Array<{ type: "text"; text: string } | Record<string, unknown>> {
	return [
		...queue.map((q) => ({ type: "text" as const, text: q.text })),
		...queue.flatMap((q) => q.images as Record<string, unknown>[]),
	];
}

/**
 * Text of a delivered batch. pi joins a message's text blocks with "\n" when it stores them
 * (measured 2026-09-24: three blocks came back as one), so this is how the batch reads back.
 */
export function batchKey(texts: string[]): string {
	return texts.join("\n");
}

type Block = { type: string; text?: string };
type Msg = { role: string; content: unknown; timestamp?: number };

export function textOf(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return (content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/**
 * Which delivered messages to frame. A message is identified by its timestamp AND its text, so an
 * identical message typed at another time (or in another branch) is not framed by accident, and
 * a framed message reads the same in every request.
 * `byText` only holds records written before timestamps were recorded (0.1.0–0.1.3).
 */
export interface Framings {
	byId: Map<string, Framing>;
	byText: Map<string, Framing>;
}

export function messageId(timestamp: number, text: string): string {
	return `${timestamp}\n${text}`;
}

export function framingOf(f: Framings, timestamp: number | undefined, text: string): Framing | undefined {
	const hit = timestamp === undefined ? undefined : f.byId.get(messageId(timestamp, text));
	return hit ?? f.byText.get(text);
}

/** Frame the user messages that were delivered as batches. Pure and deterministic. */
export function frameMidTurn<M extends Msg>(messages: M[], f: Framings): M[] {
	if (f.byId.size === 0 && f.byText.size === 0) return messages;
	return messages.map((m) => {
		if (m.role !== "user") return m;
		const text = textOf(m.content);
		const kind = text ? framingOf(f, m.timestamp, text) : undefined;
		if (text === null || kind === undefined) return m;
		if (typeof m.content === "string") return { ...m, content: frame(text, kind) };
		const others = (m.content as Block[]).filter((b) => b.type !== "text");
		return { ...m, content: [{ type: "text", text: frame(text, kind) }, ...others] };
	});
}

/**
 * Pull the editable (text-only) messages back for editing, ahead of what is already typed.
 * Messages carrying images stay queued: the editor API cannot re-attach them.
 */
export function popEditable(queue: Queued[], current: string): { text: string; kept: Queued[] } | null {
	const editable = queue.filter((q) => q.images.length === 0);
	if (editable.length === 0) return null;
	return {
		text: [...editable.map((q) => q.text), current].filter((t) => t.trim() !== "").join("\n"),
		kept: queue.filter((q) => q.images.length > 0),
	};
}

/** Whether typed input belongs in this queue. Commands and shell input keep pi's own handling. */
export function isQueueable(text: string): boolean {
	const t = text.trimStart();
	return t !== "" && !t.startsWith("/") && !t.startsWith("!");
}

const ABORT_TAIL = /\s*(Command aborted|Operation aborted|This operation was aborted|Request was aborted)\s*$/i;

/** Whether a tool error is the abort itself, as opposed to a real failure that happened to coincide. */
export function isAbortError(errorText: string): boolean {
	return ABORT_TAIL.test(errorText);
}

/** What a tool cut off by send-now reports instead of an error: whatever it printed, then the note. */
export const INTERRUPTED_NOTE = "[Interrupted: the user sent a new message]";
export function interruptedOutput(errorText: string): string {
	const kept = errorText.replace(ABORT_TAIL, "").trim();
	return kept ? `${kept}\n\n${INTERRUPTED_NOTE}` : INTERRUPTED_NOTE;
}
