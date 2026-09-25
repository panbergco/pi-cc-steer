# pi-cc-steer

**Talk to [pi](https://pi.dev) while it works, the way you talk to Claude Code.**

Messages you type while pi is working reach the model **framed the way Claude Code frames them**: "the user sent
this while you were working — respond to it once your current task is done". They go in together after the current
tool batch, or right away with **Ctrl+Enter** or **Esc**, which interrupt the current step the way Claude Code does:
one dim "Interrupted" line, not an error. Your transcript keeps your plain text, and ↑ pulls queued messages back into
the editor while they wait.

## See it

**1 · Typed while the agent works.** Three messages wait above the editor while `./check.sh lint` runs.

![Three messages waiting above the editor while a tool runs](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/1-queued.png)

**2 · ↑ to edit.** The waiting messages come back into the editor; the agent keeps working.

![The waiting messages pulled back into the editor](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/2-edit.png)

**3 · Delivered together.** When `lint` finishes they go in as one message. The model plans the tests "with build skip",
and ends with the three-line summary that was asked for, including the largest file.

![The messages delivered as one and every point answered](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/3-delivered.png)

## Do you need it?

Much of this is already in pi, so check the native settings first:

- **Batching:** set Steering mode to `all` in `/settings`. Everything you queued then arrives at the next tool
  boundary instead of one message per model call.
- **Editing:** Alt+↑ (Alt+Q on Windows) pulls every queued message back into the editor without stopping the run.

If that is all you want, you don't need this extension. What pi-cc-steer adds on top:

- **The framing.** Natively the model gets your raw text, with nothing telling it that it interrupted work in
  progress. pi-cc-steer tells it the messages arrived mid-task and to respond once its current task is done, which is
  what Claude Code tells it. The framing is added only to what the model sees; your transcript keeps what you typed.
- **Only your typing changes.** Setting `steeringMode: "all"` also batches messages that other extensions queue.
  pi-cc-steer leaves pi's default alone and batches only what you type.
- **Send now.** Ctrl+Enter, or Esc while messages wait, interrupts the current step and delivers everything queued,
  plus whatever you've typed, at once. As in Claude Code the interruption shows as one dim "Interrupted" line rather
  than an error: a cut-off command shows its output and "interrupted", a cut-off reply keeps what it had written, and
  the model is told it was interrupted. Natively pi can only abort (Esc), show the abort as an error, and hand your
  queued text back to resend. See [Known limits](#known-limits) for the cases that still show pi's red error.
- **Plain ↑** to edit, as in Claude Code, alongside pi's Alt+↑. This is convenience, not a new capability.

## Install

```bash
pi install npm:pi-cc-steer          # every session
pi install -l npm:pi-cc-steer       # this project only
```

Or straight from GitHub: `pi install git:github.com/panbergco/pi-cc-steer`.

Then `/reload`, or start a new session. It needs no settings change and works with pi's default `steeringMode`.

## How it works

| You do | What happens |
|---|---|
| Press Enter while the agent works | The message waits above the editor as `↳ your text`. Nothing is sent yet. |
| Keep typing, pressing Enter each time | Each message joins the wait list. |
| The agent finishes its current tool batch | The whole list goes in as **one** message in the same request as the tool results, framed for the model as mid-task input. |
| The agent finishes a reply without calling a tool | The list starts the next turn as an ordinary prompt, without the framing. |
| **Ctrl+Enter** while the agent works, or **Esc** while messages wait | Whatever you've typed joins the queue, the current step is interrupted, a dim `Interrupted` line appears, and everything queued starts the next turn at once. A cut-off command shows its output and `[Interrupted: the user sent a new message]`; a cut-off reply keeps what it had written. The model is told it was interrupted. Where the terminal can't send Ctrl+Enter, use **Alt+S**. Also works during a manual `/compact`. |
| ↑ (cursor on the first line) or Alt+↑, while messages wait | Text messages come back into the editor, ahead of whatever you'd typed. Edit them and press Enter to queue them again. Messages carrying images stay queued. |
| Esc with nothing waiting | Interrupts the run, as usual. |
| The run is interrupted some other way while messages wait (another extension, a command) | Text messages come back into the editor instead of being sent; messages carrying images are held and go with your next message. |
| pi refuses to start the queued prompt (no model, no API key) | The messages come back into the editor with a warning, rather than being lost. |
| `/command` or `!shell` while the agent works | Left to pi, exactly as without the extension. |

Under the hood it uses only public pi extension APIs:

- the `input` event takes mid-turn messages into the extension's own queue;
- `turn_end` sends the queue as one message with `sendUserMessage(…, { deliverAs: "steer" })`;
- the `context` event adds the framing to that message for the model only. A framed message is identified by its
  timestamp and text, so the same words sent at another time are never framed, and a framed message reads the same
  in every later request (prompt caching stays intact);
- send-now aborts the run; `tool_result` and `message_end` turn that abort, and only that abort, into an
  "interrupted" hand-off, and `agent_settled` (or the end of a cancelled `/compact`) sends the queue as the next
  prompt with a dim `Interrupted` marker that the model does not see;
- a wrapped editor handles Ctrl+Enter, Esc and ↑, and still wraps any custom editor another extension installed first.

The logic lives in `steer.ts`, which has no pi imports and is covered by `npm test`. `index.ts` connects it to pi;
it is tested by driving real pi sessions, not by `npm test`.

## Compared with Claude Code

The behaviour is modelled on Claude Code's handling of messages typed while it works. No Claude Code code is included,
and the text the model sees is original.

| | Claude Code | pi default | pi, `steeringMode: "all"` | **pi-cc-steer** |
|---|---|---|---|---|
| When mid-turn messages are delivered | after the current tool batch | after the current tool batch | after the current tool batch | **after the current tool batch** |
| How many at once | all | one | all | **all** |
| Send now, interrupting the current step | Ctrl+Enter (2.1.x) or Esc | Esc, then resend | Esc, then resend | **Ctrl+Enter or Esc** (or Alt+S) |
| How the interruption shows | one dim "Interrupted" line | red error lines | red error lines | **one dim "Interrupted" line** |
| **Model is told they arrived mid-task** | **yes** | no | no | **yes** |
| Your transcript shows your plain text | yes | yes | yes | **yes** |
| Pull them back to edit without stopping the run | ↑ | Alt+↑ | Alt+↑ | **↑ or Alt+↑** |
| Messages queued by other extensions | not applicable | one at a time | batched too | **left at pi's default** |
| Slash commands typed mid-turn | held, run one by one afterwards | run by pi | run by pi | run by pi |
| Queued images restored when editing | yes | no | no | no, they stay queued |

The small differences that remain:

- **One message, not several.** Claude Code adds each queued message to the conversation separately. pi-cc-steer sends
  one message containing all of them, joined by line breaks. The model sees the same text in the same order.
- **Images.** pi's editor API cannot re-attach images, so ↑ leaves messages that carry images in the queue. They
  are still delivered with the batch.
- **Framing words.** Claude Code tells the model to address the message after completing its current task;
  pi-cc-steer gives the same instruction in its own words. For a send-now it instead says the previous step was
  stopped and to address the message now.
- **Esc with nothing queued.** In both, Esc interrupts. In Claude Code anything you queue afterwards still runs next;
  here the interruption is pi's own, with pi's red error line.

## Known limits

- **Cases that still show pi's red error on send-now:** the interruption lands while pi is starting a tool (before
  the tool runs), or while the model is streaming a tool call, or during an automatic retry wait (pi reports the retry
  as cancelled). pi-cc-steer only relabels the abort it caused, and these reach the screen without passing through
  the hooks it can use.
- **A cut-off tool keeps only the output in its final error.** pi's bash tool includes everything it printed; a
  custom tool that streamed output and then reports only "Operation aborted" shows just the note.
- **Timing during compaction or retry.** A message typed while pi compacts or retries waits for the next tool batch
  to finish; native steering can sometimes reach the very next request.
- **Editors.** An extension that replaces the editor after pi-cc-steer loads removes its keys; a modal (vim-style)
  editor loses Esc while messages wait.
- **Older sessions.** Sessions from 0.1.0–0.1.3 keep their earlier framing records, which match by text alone.

## Works with

Editor add-ons such as status bars and footers, because it wraps whatever editor is already installed.

It does **not** combine with other extensions that take over mid-turn input, such as
[pi-queue-steer](https://github.com/tmustier/pi-queue-steer) or pi-queue-picker. Use one or the other. pi-queue-steer is
the richer choice if you want a visible, reorderable queue with separate steering and follow-up lanes. pi-cc-steer is
the smaller one (about 400 lines) if you want Claude Code's behaviour and nothing else.

Only interactive input is affected. RPC mode, print mode and messages sent by other extensions are never queued or
framed.

## Development

```bash
npm test                   # node --test steer.test.ts — the pure logic in steer.ts, no pi needed
pi -e ./index.ts           # try it in one session without installing
```

## License

MIT
