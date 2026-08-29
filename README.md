# bb-plugin-aide — BB Aide

A realtime voice operator for [bb](https://getbb.app). A circular waveform
button sits in the composer next to the native mic; clicking it opens a live
voice session (OpenAI Realtime over WebRTC) with an agent that can drive bb
for you.

Inspired by [CodeAide](../CodeAide) (the VS Code equivalent) — but bb's
plugin frontend runs in a real browser context, so mic capture and audio
playback happen directly in `app.tsx` with no native helper.

## Architecture

```text
app.tsx    composer button + WebRTC session (getUserMedia, RTCPeerConnection,
           data channel); local tools for the composer draft
app.css    waveform animation
server.ts  holds the OpenAI API key, performs the SDP exchange with
           https://api.openai.com/v1/realtime/calls, executes bb tools via
           bb.sdk, and registers the `bb aide` CLI
```

Tool calls flow: model → data channel → `app.tsx` → plugin RPC `runTool` →
`bb.sdk` → result back over the data channel. Every call carries the user's
current thread/project so context follows navigation.

## Voice agent tools

`get_context`, `list_projects`, `list_live_threads`, `list_threads`,
`search_threads`, `read_thread`, `focus_thread`, `set_pane`
(spotlight/maximize/restore/toggle), `send_to_thread`, `start_thread`,
`stop_thread`, `archive_thread`, `rename_thread`, `show_diff`, plus
`set_composer_text` / `append_composer_text` handled locally in the frontend.

## CLI

```sh
bb aide live [--json]     # threads that are live right now (like the sidebar section)
bb aide read <thread-id>  # thread status + latest assistant output
```

Agents discover these through bb's generated plugin-commands skill.

## Install

```sh
cd bb-aide
npm install
bb plugin install . --yes
bb plugin config aide set openaiApiKey <key>   # or set OPENAI_API_KEY in the bb server env
bb plugin reload aide
```

Settings: `openaiApiKey` (secret), `model` (default `gpt-realtime-2`),
`voice` (default `marin`).

## Develop

```sh
bb plugin dev        # rebuild + reload on save
bb plugin logs aide -f
```
