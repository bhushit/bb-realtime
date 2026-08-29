# Realtime 🎙️

**Talk to bb.** Realtime adds a voice agent to [bb](https://getbb.app): click
the little waveform button in the composer, start talking, and an assistant
with real control over bb does the work — finds threads, puts them on screen,
messages your coding agents, kicks off new work, and reads results back to
you.

## Quick start

1. Install and configure:

   ```sh
   cd bb-aide
   npm install
   bb plugin install . --yes
   bb plugin config realtime set openaiApiKey <your-openai-key>
   bb plugin reload aide
   ```

2. Open any thread (or the New thread screen) in bb. Next to the mic button
   in the composer you'll see a **circle with a waveform**.

3. Click it. Allow microphone access the first time. When the bars start
   dancing, you're live — just talk. Click again to hang up.

The button has three states:

| Button | Meaning |
|---|---|
| Still bars | Idle — click to start |
| Pulsing outline | Connecting |
| Animated bars | Live — it's listening; click to stop |

## Things you can say

- *"What's running right now?"* — lists your live threads
- *"Find the thread about the flaky login test and put it on screen"*
- *"Spotlight that pane"* / *"maximize it"* / *"restore it"*
- *"What did the agent say?"* — summarizes the latest output aloud
- *"Tell it to also add tests for the error path"* — messages the thread's agent
- *"Start a new thread in the replay project: fix the CI timeout"*
- *"Show me the diff for that thread"*
- *"Stop that thread"* / *"archive it"* / *"rename it to 'CI fix'"*
- *"Type a prompt for me: refactor the session store to…"* — writes into
  your composer so you can review and hit send yourself

The agent always knows which thread and project you're looking at — even as
you navigate mid-conversation — so "this thread" just works.

## Inspecting live threads from the terminal

The same "Live threads" view from the sidebar is available as a CLI, for you
and for your coding agents:

```sh
bb realtime live            # who's running right now
bb realtime live --json     # machine-readable
bb realtime read thr_xxxxx  # a thread's status + latest assistant output
bb realtime usage           # what your voice sessions cost, per day (estimated)
```

Agents discover these commands automatically through bb's plugin-commands
skill.

## Settings

| Setting | Default | |
|---|---|---|
| `openaiApiKey` | — | Secret; stored in bb's plugin secret store. Falls back to `OPENAI_API_KEY` in the bb server's environment. |
| `model` | `gpt-realtime-2` | OpenAI Realtime model |
| `voice` | `marin` | Assistant voice |

Change with `bb plugin config realtime set <key> <value>`, then
`bb plugin reload aide`.

## Troubleshooting

- **No button?** Composer actions hide in bb's compact layout — widen the
  window. Also check `bb plugin list` shows `aide … running`.
- **"needs-configuration"** — set the API key (Quick start step 1).
- **Connects then drops** — check `bb plugin logs aide -f` while clicking;
  the SDP exchange error (bad key, model name) is logged there.
- **No audio out** — the first click must come from you (browser autoplay
  rules); if you started it and hear nothing, check system output device.

Your audio goes directly from the bb app to OpenAI over WebRTC; the API key
never leaves the bb server, and no audio is stored by the plugin.

---

## For developers

Architecture: bb's plugin frontend runs in a real browser context, so mic
capture and playback live in `app.tsx` (getUserMedia + RTCPeerConnection +
data channel) with no native helper — unlike its VS Code sibling
[CodeAide](../CodeAide), which needs a Swift WebRTC binary.

```text
app.tsx    composer button + WebRTC session; composer-draft tools run locally
app.css    waveform animation
server.ts  API key + SDP exchange (api.openai.com/v1/realtime/calls),
           bb tools via bb.sdk, `bb realtime` CLI
```

Tool-call flow: model → data channel → `app.tsx` → plugin RPC `runTool` →
`bb.sdk` → output back over the data channel (function_call_output +
response.create).

Voice tools: `get_context`, `list_projects`, `list_live_threads`,
`list_threads`, `search_threads`, `read_thread`, `focus_thread`, `set_pane`,
`send_to_thread`, `start_thread`, `stop_thread`, `archive_thread`,
`rename_thread`, `show_diff`, plus frontend-local `set_composer_text` /
`append_composer_text`.

Dev loop:

```sh
bb plugin dev          # rebuild + reload on save
bb plugin logs aide -f # tool traffic and errors
```
