/**
 * Pure queue logic for pi-cc-steer: no pi imports, so it can be tested with plain `node --test`.
 *
 * The behaviour it serves, observed in Claude Code (studied, not copied):
 *  - messages typed while the agent works are held, then ALL delivered together at the next
 *    tool boundary, inside the same request as the tool results;
 *  - the model sees each one framed as "sent while you were working — finish, then address it";
 *  - the person sees their own words, unframed;
 *  - ↑ (on the first line) or Esc pulls every queued message back into the editor to edit;
 *  - Ctrl+Enter sends now: interrupt the current turn and deliver everything queued at once.
 */

export interface Queued {
	text: string;
	images: unknown[];
}

/**
 * How a batch reaches the model. The transcript keeps the plain text.
 * - "mid-turn": delivered at a tool boundary while the agent kept working.
 * - "interrupt": the person stopped the turn to send it (Ctrl+Enter). pi drops the aborted reply from
 *   the model's context, so without this the model would not know it was cut off.
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
		"<system-reminder>\nThe user sent the following while you were working:\n" +
		text +
		"\n\nFinish the step you are on, then address every point above before you finish. Do not ignore it.\n</system-reminder>"
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
 * Stable identity of a delivered batch. pi joins a message's text blocks with "\n" when it stores
 * them (measured 2026-09-24: three blocks came back as one), so the key is the joined text.
 */
export function batchKey(texts: string[]): string {
	return texts.join("\n");
}

type Block = { type: string; text?: string };
type Msg = { role: string; content: unknown };

function textOf(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	return (content as Block[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

/**
 * Frame the user messages that were delivered mid-turn. Pure and deterministic, so the same
 * transcript always produces the same request (prompt caching stays intact).
 */
export function frameMidTurn<M extends Msg>(messages: M[], framed: Map<string, Framing>): M[] {
	if (framed.size === 0) return messages;
	return messages.map((m) => {
		if (m.role !== "user") return m;
		const text = textOf(m.content);
		const kind = text === null || text === "" ? undefined : framed.get(text);
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
