# pi-cc-steer

**Talk to [pi](https://pi.dev) while it works, the way you talk to Claude Code.**

Messages you type while pi is working reach the model **framed the way Claude Code frames them**: "the user sent
this while you were working — finish the step you are on, then address it". They go in together at the next tool
boundary, your transcript keeps your plain text, and ↑ pulls them back into the editor while they wait.

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
  progress. pi-cc-steer tells it the messages arrived mid-task and to finish its current step first, which is what
  Claude Code does. The framing is added only to what the model sees; your transcript keeps what you typed.
- **Only your typing changes.** Setting `steeringMode: "all"` also batches messages that other extensions queue.
  pi-cc-steer leaves pi's default alone and batches only what you type.
- **Plain ↑ and Esc** to edit, as in Claude Code, alongside pi's Alt+↑. This is convenience, not a new capability.

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
| The agent finishes its current tool call | The whole list goes in as **one** message in the same request as the tool results, framed for the model as mid-task input. |
| The agent finishes a reply without calling a tool | The list starts the next turn as an ordinary prompt, without the framing. |
| ↑ (cursor on the first line) or Esc, while messages wait | They come back into the editor, ahead of whatever you'd typed. Edit them and press Enter to queue them again. |
| Esc with nothing waiting | Interrupts the run, as usual. |
| The run is interrupted while messages wait | They come back into the editor instead of being sent. |
| `/command` or `!shell` while the agent works | Left to pi, exactly as without the extension. |

Under the hood it uses only public pi extension APIs:

- the `input` event takes mid-turn messages into the extension's own queue;
- `turn_end` sends the queue as one message with `sendUserMessage(…, { deliverAs: "steer" })`;
- the `context` event adds the framing to that message for the model only, and does so deterministically, so prompt
  caching is unaffected;
- a wrapped editor handles ↑ and Esc, and still wraps any custom editor another extension installed first.

The logic lives in `steer.ts`, which has no pi imports and is covered by `npm test`. `index.ts` connects it to pi.

## Compared with Claude Code

The behaviour is modelled on Claude Code's handling of messages typed while it works. No Claude Code code is included,
and the text the model sees is original.

| | Claude Code | pi default | pi, `steeringMode: "all"` | **pi-cc-steer** |
|---|---|---|---|---|
| When mid-turn messages are delivered | after the current tool batch | after the current tool batch | after the current tool batch | **after the current tool batch** |
| How many at once | all | one | all | **all** |
| **Model is told they arrived mid-task** | **yes** | no | no | **yes** |
| Your transcript shows your plain text | yes | yes | yes | **yes** |
| Pull them back to edit without stopping the run | ↑ or Esc | Alt+↑ | Alt+↑ | **↑, Esc, or Alt+↑** |
| Messages queued by other extensions | not applicable | one at a time | batched too | **left at pi's default** |
| Slash commands typed mid-turn | held, run one by one afterwards | run by pi | run by pi | run by pi |
| Queued images restored when editing | yes | no | no | no, they stay queued |

The small differences that remain:

- **One message, not several.** Claude Code adds each queued message to the conversation separately. pi-cc-steer sends
  one message containing all of them, joined by line breaks. The model sees the same text in the same order.
- **Images.** pi's editor API cannot re-attach images, so ↑ and Esc leave messages that carry images in the queue. They
  are still delivered with the batch.
- **Framing words.** Claude Code and pi-cc-steer both tell the model to finish the step it is on and then address the
  message. The wording here is pi-cc-steer's own.

## Works with

Editor add-ons such as status bars and footers, because it wraps whatever editor is already installed.

It does **not** combine with other extensions that take over mid-turn input, such as
[pi-queue-steer](https://github.com/tmustier/pi-queue-steer) or pi-queue-picker. Use one or the other. pi-queue-steer is
the richer choice if you want a visible, reorderable queue with separate steering and follow-up lanes. pi-cc-steer is
the smaller one (about 200 lines) if you want Claude Code's behaviour and nothing else.

Only interactive input is affected. RPC mode, print mode and messages sent by other extensions pass through unchanged.

## Development

```bash
npm test                   # node --test steer.test.ts — the queue logic, no pi needed
pi -e ./index.ts           # try it in one session without installing
```

## License

MIT
