# pi-cc-steer

**Talk to [pi](https://pi.dev) while it works, the way you talk to Claude Code — and send long commands to the
background with Ctrl+B.**

Messages you type while pi is working reach the model **framed the way Claude Code frames them**: "the user sent
this while you were working — respond to it once your current task is done". They go in together after the current
tool batch, or right away with **Ctrl+Enter** or **Esc**, which interrupt the current step the way Claude Code does:
one dim "Interrupted" line, not an error. Your transcript keeps your plain text, and ↑ pulls queued messages back into
the editor while they wait.

A command that runs too long no longer holds you up: press **Ctrl+B** and it moves to the background. The model carries
on, anything you queued goes in, and the model is told when the command finishes.

## See it

**1 · Typed while the agent works.** Three messages wait above the editor while `./check.sh lint` runs.

![Three messages waiting above the editor while a tool runs](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/1-queued.png)

**2 · ↑ to edit.** The waiting messages come back into the editor; the agent keeps working.

![The waiting messages pulled back into the editor](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/2-edit.png)

**3 · Delivered together.** When `lint` finishes they go in as one message. The model plans "test execution before
build", then ends with the three-line summary that was asked for, including the largest file.

![The messages delivered as one and every point answered](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/3-delivered.png)

**4 · Send now.** A message queued while `lint` runs, then Esc: the command stops and reads "interrupted", one dim
`Interrupted` line appears, and the new instruction runs straight away.

![Esc sends the queued message now: lint is interrupted and the tests run](https://raw.githubusercontent.com/panbergco/pi-cc-steer/main/assets/4-send-now.png)

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

Background bash replaces pi's built-in `bash` tool. To keep pi's own and use only the steering, start pi with
`PI_CC_STEER_BACKGROUND=0`.

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
| The run is interrupted some other way while messages wait (another extension, a command) | Seen at the end of the turn: their text comes back into the editor instead of being sent, as pi does with its own queue. Attached images are dropped with a warning (pi drops them too); paste them again. |
| `/command` or `!shell` while the agent works | Left to pi, exactly as without the extension. |

Under the hood it uses only public pi extension APIs:

- the `input` event takes mid-turn messages into the extension's own queue;
- `turn_end` sends the queue as one message with `sendUserMessage(…, { deliverAs: "steer" })`;
- the `context` event adds the framing to that message for the model only. A framed message is identified by its
  timestamp and text, so the same words sent at another time are not framed, and a framed message reads the same in
  every later request;
- send-now aborts the run; `tool_result` and `message_end` relabel an error as an "interrupted" hand-off only while a
  send-now is in progress, the run's abort signal is set, and the error is an abort message, and `agent_settled` (or the end of a cancelled
  `/compact`, noticed once pi has stayed idle) sends the queue as the next prompt. The dim `Interrupted` marker is a session entry, so no model ever
  sees it, compaction summaries included;
- a wrapped editor handles Ctrl+Enter, Esc and ↑, and still wraps any custom editor another extension installed first.

The logic lives in `steer.ts`, which has no pi imports and is covered by `npm test`. `index.ts` connects it to pi;
`index.test.ts` drives its handlers with a stub pi, and the rest is tested by driving real pi sessions.

## Background commands

Modelled on Claude Code's background bash:

| You do | What happens |
|---|---|
| A command is still running after 2 s | A hint appears under the editor: `(ctrl+b to run in background)` (`ctrl+b ctrl+b` inside tmux, where Ctrl+B is the prefix). |
| **Ctrl+B** (or Ctrl+Shift+B, or `/bg`) while it runs | The command keeps running with its output going to a log file. The model is told it was backgrounded and carries on; messages you queued go in at that point. With nothing running, Ctrl+B is still cursor-left. |
| The command reaches its timeout (120 s by default) | It moves to the background instead of being killed. |
| A background command finishes | The model gets one notice with its status, exit code, output tail and log path, as in Claude Code: at the next tool boundary if pi is busy (one notice per boundary, and never ahead of messages you queued — while yours are on their way in, notices wait), or as a new turn if pi is idle, including just after an Esc once pi has stopped (several notices then go in as one message, in one turn). If your message is about to start the next run, the notice goes in with it, after it. A notice an interruption wipes from pi's queue is sent again, and a copy that reaches the model twice is hidden the second time. In RPC, print or SDK use a notice never starts a turn by itself (the host drives the turns); it goes in with the host's next prompt. |
| A background command goes quiet at what looks like a prompt | After 45 s without new output, if the output stops on a line that looks like `(y/n)`, `[Y/n]`, `Press any key`, `Continue?`, `Overwrite?` or a "Do you…?" question, the model is told once, with the last output and how to re-run it non-interactively. This is Claude Code's rule, except that a line ending in a newline does not count (a prompt leaves the cursor on its line), so output that merely mentions "Press Enter" is not mistaken for one. It is still a guess: a quiet command whose last line happens to look like a prompt can be flagged. |
| Esc, or a send-now, while a command runs in the foreground | The command and everything it started are stopped at once, as pi's own bash does. |
| You type a message while a command runs | It waits for the command, as in Claude Code; press Ctrl+B to move on sooner. |

The model gets `run_in_background` on `bash` for commands it knows are long, plus `bg_list`, `bg_output` and `bg_stop`.
The status bar counts running, finished and failed background commands (`▶ 1 · ✓ 2`); `/bg-tasks` lists them.
Background commands, and anything they started, are stopped when the session ends; `bg_stop` and shutdown send
SIGTERM, give the command and its children 5 seconds, then SIGKILL. Logs go to `pi-bg-tasks/` in the system temp
directory (`TMPDIR`) and are deleted after 24 hours, at the start of a session. A command whose log passes 64 MiB is
stopped at once (the size is checked every 0.25 s, so a very fast writer can overshoot by a few hundred MB before it is
killed); a background log is then trimmed to 64 MiB, and a foreground one is deleted. A foreground result longer than
12,000 characters names the log that keeps the full output.

The engine is adapted from [pi-bg-tasks](https://github.com/cyzlmh/pi-extensions/tree/main/pi-bg-tasks) (MIT, © cyzlmh),
itself a fork of [pi-patty-bg-tasks](https://github.com/patty-io/pi-patty-bg-tasks) (MIT, © patty.io). Changes: Ctrl+B
through pi-cc-steer's editor, typing no longer backgrounds a command, logs follow `TMPDIR`, an interrupted, timed-out or externally
killed command reads as pi's own does, cancelling kills stubborn commands, finish notices are held by the extension until
pi can take them without jumping ahead of you, a stuck-prompt warning is added, commands get pi's `PI_*` variables, the log cap covers foreground commands, and the macOS sandbox
display helper is dropped.

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
| Move a running command to the background | Ctrl+B | — | — | **Ctrl+B** (or Ctrl+Shift+B, `/bg`) |
| A command that hits its timeout | moves to the background | killed | killed | **moves to the background** |
| Notice when a background command finishes | yes, at the next tool boundary | — | — | **yes, at the next tool boundary** |
| Warning when a background command is stuck at a prompt | yes | — | — | **yes** |

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
  the tool runs), or during an automatic retry wait (pi reports the retry as cancelled). A reply cut while the model
  was writing a tool call is deliberately left to pi's own abort handling, so its tool card closes properly.
- **A cut-off tool keeps only what its final error carries.** pi's bash tool keeps its final output (truncated if
  long) and a reference to the full-output file; a custom tool that streamed output and then reports only
  "Operation aborted" shows just the note.
- **Interruptions it cannot see.** An interruption from something other than send-now is only noticed at the end of
  a turn. One that lands during a retry wait, or while pi is settling, is not seen, and the queue is then sent.
- **Notice turns and other extensions.** In the TUI a finish notice starts a turn when pi is idle. pi has no
  "prompt being prepared" or "session ending" state an extension can see, so pi-cc-steer uses what it can: Enter in
  the editor (including commands such as `/new`) and its own send-now and queued prompts hold notice turns until that
  prompt starts (at most 60 s), and the notices ride in it. What remains needs *another* extension that is slow at
  the wrong moment:
  - a prompt that does not come from the editor or pi-cc-steer, while a third extension's input handler is slow, can
    be rejected by pi with "Agent is already processing";
  - a user message from another extension arriving while your queued batch is still being processed can be taken
    for your batch, letting a notice go in ahead of it;
  - an extension slow to handle a session switch or exit can see one notice turn start in the old session;
  - after a cancelled session switch, notices wait until your next message instead of starting a turn;
  - after Esc returns a batch of yours to the editor, notices wait for what you send next.

  In RPC, print or SDK use notices never start turns; they ride in the host's next prompt.
- **Notices behind other extensions' steering messages.** pi hands the model one steering message per request by
  default. If another extension has queued its own, a notice waits behind it, and a message you queue after that
  waits one request longer.
- **Nothing is persisted.** Queued messages, and finish notices not yet delivered, live in memory, as pi's own queue does: `/reload`, exit or
  switching sessions drops them. If pi refuses the queued prompt (no model, no API key), pi shows its error and the
  text is not put back.
- **Timing during compaction or retry.** A message typed while pi retries waits for the next tool batch to finish;
  native steering can sometimes reach the very next request. During a manual `/compact`, Enter uses pi's own
  compaction queue.
- **Races with other extensions.** A batch is recognised by its text when it arrives. Another extension sending the
  same text at the same moment (or, for a batch with images, text that starts the same way) can take its framing, and if pi refuses a send-now prompt, its unused record can
  later frame an identical message you type. If another extension rewrites a batch's text on its way in, that batch
  reaches the model unframed, as it would in native pi.
- **Older sessions.** Sessions from 0.1.0–0.1.3 keep their framing records, which match by text alone. Sessions from
  0.1.4 (GitHub only) stored the `Interrupted` marker as a message: it is kept out of requests, not out of compaction
  summaries.
- **Editors.** An extension that replaces the editor after pi-cc-steer loads removes its keys; a modal (vim-style)
  editor loses Esc while messages wait.

- **Background commands, not yet like Claude Code:** `sleep` is not treated specially, the log cap is 64 MiB
  (Claude Code: 5 GB), a command running in the foreground is not checked for a stuck prompt until it is moved to
  the background (as in Claude Code), and there is no interactive task manager — `/bg-tasks` prints a list.
- **Shell settings.** Commands run as `bash -c` with the environment pi's own bash gives them (pi's `bin` directory
  on `PATH`, the session's `PI_*` variables), but pi's `shellPath` and `shellCommandPrefix` settings are not applied.
  Start pi with `PI_CC_STEER_BACKGROUND=0` if you rely on them.
- **Other bash replacements.** Extensions that also replace pi's `bash` tool (for example pi-bg-tasks,
  pi-patty-bg-tasks, pi-background-bash) conflict with this one: use one, or start pi with
  `PI_CC_STEER_BACKGROUND=0`.

## Works with

Editor add-ons such as status bars and footers, because it wraps whatever editor is already installed.

It does **not** combine with other extensions that take over mid-turn input, such as
[pi-queue-steer](https://github.com/tmustier/pi-queue-steer) or pi-queue-picker. Use one or the other. pi-queue-steer is
the richer choice if you want a visible, reorderable queue with separate steering and follow-up lanes. pi-cc-steer is
the smaller one if you want Claude Code's behaviour and nothing else.

Only interactive input is queued. RPC mode, print mode and messages sent by other extensions are never queued, though
the framing of an earlier batch still applies to every request that carries it.

## Development

```bash
npm install && npm test    # unit tests, plus integration.test.ts: real pi sessions with a scripted model
pi -e ./index.ts           # try it in one session without installing
```

## License

MIT. `background/` is adapted from pi-bg-tasks and keeps its licence and copyright notices in `background/LICENSE`.
