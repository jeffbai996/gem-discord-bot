# gem-discord-bot

A standalone Discord bot backed by Google's Gemini 3. Runs as a Node.js/`tsx` process, responds to allowlisted users in allowlisted channels, supports multimodal input (images, video, audio, documents, YouTube), uses native Gemini tools (Google Search, Code Execution) plus a registry of user-defined function tools (`fetch_url`, `search_memory`, IBKR live data, etc.), and reacts with emoji.

The bot's in-Discord persona is **"Gemma"** — the repo name was simplified from `gemini-discord-mcp` to `gem-discord-bot` once the MCP approach was abandoned.

## Why not MCP?

An earlier version tried to be a Gemini-CLI MCP plugin. It didn't work: Gemini CLI has no push-event ingestion pathway, so there was no way for Discord messages to reach the model unprompted. Rebuilt as a standalone daemon instead.

## Stack

- TypeScript + Node.js 22 (via `tsx`)
- `discord.js` v14
- `@google/generative-ai` (Gemini 3 Flash by default; override with `GEMINI_MODEL`)

---

## Features

### Intelligence & Tools

- **Built-in tools:** `googleSearch` and `codeExecution` are server-side, fired automatically when the model decides to. The bot drops `codeExecution` from the tool list when the request payload contains audio or video — Gemini's codeExecution mime allowlist is stricter than the model's video-understanding allowlist, and `.mov` / `.mp4` files with embedded timed-text tracks 400 the entire request otherwise.
- **Function-call registry:** Models can call `fetch_url` (with SSRF guard), `search_memory` (semantic recall, see below), and any registered IBKR / utility tools. Each call is wrapped with timing + result-preview capture for the verbose surface.
- **Tool-call loop** capped at 3 iterations to bound runaway cost.
- **Streaming with edit-flushing:** long responses stream into Discord via `message.edit()` as tokens arrive, then the streaming messages are edited in place to become the final output (zero-duplicate guarantee on chunk-count changes).

### "Show your work" surface (per-channel `verbose` / `showCode` flags)

When enabled per channel via slash commands:

- **🔍 Web search** — bulleted list of the queries Gemma actually typed into Google
- **🛠️ Tool calls** — `tool(args) [142ms] ↳ result preview` per registry dispatch
- **🛠️ Code (python)** — code-execution artifacts with output, deduped against prose-side fenced blocks the model paraphrases
- **🧠 Reasoning** — gemini-3 native thought-summary parts (`thought: true`), distinct from the JSON-wrapper `thinking` field
- **💭 Thinking** — Chain-of-thought scratchpad from the JSON wrapper (per-channel always/auto/never)
- **Token + time footer** — `` ` ↑ 14,200 · ↓ 310 · » 4.2s ` `` on every reply when verbose is on

### Reliability fences

- Migrated to `@google/genai` (the maintained SDK) — fixes the legacy SDK's "Failed to parse stream" bug and silent stripping of `thoughtSignature` on response parse (which broke gemini-3 thinking models on tool-loop iteration 2).
- Catches Gemini 400s as a typed `GeminiRequestRejected` exception with the rejection reason extracted, so unhandled rejections never kill the message handler.
- Sanitizes `fileData` mime types against an allowlist when resurrecting attachments from history cache (rejects bogus sub-track mimes).
- `maxOutputTokens=4096` cap to bound any future degenerate-generation loop blast radius (we hit one in April with `gemini-3-flash-preview` emitting `5v57_5v57_…` to max output).
- React-emoji fallback (`👀`) when the model omits the field or returns an unsupported emoji.

### Context caching (per channel, opt-in)

When `cache: true` for a channel, the stable system-prompt prefix (persona + response-format addendum + thinking-mode addendum + **rolling channel summary** + pinned facts + tools + toolConfig) is cached server-side via `client.caches.create`. Per-call, only the volatile parts (recent history tail + the new user message) flow on the wire; the API references the cached prefix by name. Cached input tokens bill at **10% of the normal rate** (90% discount; Google's published rate for Gemini 2.5/3.x context caching). Typical hit: ~6,000-token prompt with ~4,000 cached → ~60% input-cost reduction.

The in-process manager keys on `(model, hash(systemText), hash(toolsAndConfig))`. Because the channel summary is part of `systemText`, every summarizer rollup naturally rotates into a fresh cache (old one ages out via TTL — no explicit invalidation needed). Different thinking modes also get separate caches; identical persona+summary across two channels collapses into one shared cache.

TTL defaults to 2 hours, configurable per channel via `/gemini cache ttl <seconds>` (60–86400). Long evening sessions stay warm; the first message after expiry pays full price.

Fail-open: any error during cache create falls back to the uncached path so a transient cache fault never breaks a turn.

#### Inspecting cache state

`/gemini cache info` (ephemeral) shows live in-process caches with size (billed tokens after first hit, or estimated tokens before), age, TTL remaining, hit count, last-used time, and the systemText hash. The per-message verbose footer is intentionally cache-agnostic — bookkeeping that's only checked occasionally lives behind the slash command, not stamped on every reply.

Cache invalidation: `/gemini cache flush` drops all in-process refs; `/gemini clear` also flushes them as part of resetting a channel; persona reload via SIGHUP implicitly rotates caches (the prefix hash differs).

### Multimodal Ingestion (parallel + cached)

- **Images** (PNG, JPEG, WebP, GIF, HEIC) & **Documents** (PDF, TXT, HTML, JS/TS): inlined as base64.
- **Video + Audio** (mp4, mov→quicktime, mpeg, webm, wav, mp3, flac, etc.): uploaded via the Gemini File API. Mime types validated against the allowlist before upload.
- **YouTube URLs** in the message body: fetched via `yt-dlp` for auto-subs, ingested as text.
- **Parallel processing:** `Promise.allSettled` on attachment + YouTube workers.
- **URI cache:** Discord media URLs cached to Gemini `fileUri`s, so the model can "remember" media from earlier in the conversation without re-uploading.

### Semantic Memory (RAG)

- **Background ingestion:** messages from allowed users in allowed channels are embedded with `gemini-embedding-001` (768-dim) and stored in SQLite + [`sqlite-vss`](https://github.com/asg017/sqlite-vss).
- **Retrieval tool:** the model can call `search_memory` mid-generation to pull semantically-relevant past messages for the current channel.
- **Conversation summarization:** background `SummarizationScheduler` rolls up older history into per-channel summaries that get injected into the system prompt — keeps long-running channels from blowing the context window without losing all prior context.
- **Backfill:** `/gemini backfill #channel [limit]` embeds recent history on demand after deploying to an existing channel.

### Reactions interface

Configured emoji reactions on bot messages trigger ops via `PinnedFactsStore`. Inbound 🛑 reactions (when wired) also short-circuit the next tool call as a stop signal — see the cc-context discord plugin patch.

### Admin slash commands

Manage the bot directly from Discord without touching terminal files. Requires `DISCORD_ADMIN_ID` in `.env` (or Server Admin permissions).

- `/gemini allow @user` / `/gemini revoke @user`
- `/gemini channel #channel enabled require_mention` — set/unset bot access in a channel. Other flags live on `/gemini set` and `/gemini cache`; reconfiguring a channel preserves their existing values.
- `/gemini set <flag> <value> [#channel]` — set per-channel render flags. `flag` is one of `thinking` (`always|auto|never`), `show_code` (`true|false`), `verbose` (`true|false`).
- `/gemini cache on|off [#channel]` — enable/disable server-side caching of the stable system-prompt prefix (~50–70% input-cost reduction on a hit; see Context caching above)
- `/gemini cache info` — live cache details: size, hits, age, TTL remaining, hash
- `/gemini cache ttl <seconds> [#channel]` — override TTL per channel (60–86400; pass `0` to reset to default)
- `/gemini cache flush` — drop all in-process cache refs (server-side caches age out via TTL)
- `/gemini clear [#channel]` — reset Gemma's context for the channel; bumps the history watermark, blanks the rolling summary, and flushes the in-process cache so the next turn starts fresh
- `/gemini compact [#channel]` — force a context-summary rollup right now, regardless of the 50-message default threshold; useful before a long quiet window so the rolling summary is already up-to-date when chat resumes
- `/gemini persona <filename.md>` — hot-swap the active persona
- `/gemini backfill #channel [limit]` — embed recent history into semantic memory

### Persona & Shared Context

The system prompt is composed at runtime from:

1. The active persona file (`persona.md` by default) in the state dir.
2. Pinned facts from `pinned-facts.md`.
3. Per-channel conversation summary from `SummaryStore` (refreshed by the background scheduler).
4. A response-format JSON contract (instructs the model to emit `{react, thinking, reply}` since responseSchema is incompatible with built-in tools).

---

## State directory

All runtime state lives in `~/.gemini/channels/discord/` (override via `DISCORD_STATE_DIR`):

| File / dir | Purpose |
|---|---|
| `.env` | `DISCORD_BOT_TOKEN`, `GEMINI_API_KEY`, `DISCORD_ADMIN_ID`, optional `GEMINI_MODEL`, `MAX_HISTORY_TOKENS`, `MAX_UNSUMMARIZED_MESSAGES`, `SUMMARIZATION_BATCH_LIMIT` |
| `access.json` | User + channel allowlists with per-channel render flags |
| `memory.db` | SQLite + sqlite-vss database of embedded messages for semantic recall |
| `persona.md` | Default system prompt |
| `pinned-facts.md` | Persistent facts injected into the prompt every turn |
| `gemma.log` | Service log (info + errors) |
| `summaries.json` | Per-channel rolled-up summaries from `SummarizationScheduler` |
| `inbox/` | Per-message attachment scratch dir (auto-cleaned after each turn) |

### access.json format

```json
{
  "users": {
    "<discord_user_id>": { "allowed": true }
  },
  "channels": {
    "<channel_id>": {
      "enabled": true,
      "requireMention": true,
      "thinking": "auto",
      "showCode": true,
      "verbose": true,
      "cache": true,
      "cacheTtlSec": null
    }
  }
}
```

- Unknown users or channels are silently ignored — explicit allowlist only.
- `thinking`: `"always"` | `"auto"` | `"never"` (default `"auto"`)
- `showCode`: render code-execution artifacts + tool calls + web-search queries (default `true`)
- `verbose`: render the token/time footer + native reasoning block (default `true`)
- `cache`: enable server-side context caching for the stable system-prompt prefix; cached portion bills at 10% of normal input rate (90% discount), so an active channel sees ~60% input-cost reduction on the typical prompt mix (default `true` — see Context caching above).
- `cacheTtlSec`: optional per-channel override of the cache TTL in seconds. `null` (default) means use the manager default (`7200s` / 2h). Set with `/gemini cache ttl`.
- All flags are modifiable via `/gemini` slash commands.

---

## Deploy

Runs as a systemd user service (`gemma.service`) on Node 22+ via nvm.

```bash
# On the host: pull + redeploy
cd ~/repos/gem-discord-bot && git pull && npm install
systemctl --user restart gemma

# Hot reload (access.json + persona.md only, no code reload):
systemctl --user kill -s HUP gemma
```

Logs: `~/.gemini/channels/discord/gemma.log`. Service tail: `systemctl --user status gemma`.

---

## Setup

### Prerequisites

- Node.js v22+
- A Discord bot application with:
  - **Message Content Intent** enabled (Bot → Privileged Gateway Intents)
  - Permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files
- A Google AI Studio API key (aistudio.google.com → Get API key)

### Local dev

```bash
npm install
mkdir -p ~/.gemini/channels/discord
chmod 700 ~/.gemini/channels/discord

cat > ~/.gemini/channels/discord/.env <<EOF
DISCORD_BOT_TOKEN=your_token_here
GEMINI_API_KEY=your_key_here
DISCORD_ADMIN_ID=your_personal_discord_user_id
GEMINI_MODEL=gemini-3-flash-preview
EOF
chmod 600 ~/.gemini/channels/discord/.env

# Optional: bootstrap access.json (or use /gemini commands later)
cat > ~/.gemini/channels/discord/access.json <<EOF
{
  "users": { "YOUR_DISCORD_USER_ID": { "allowed": true } },
  "channels": {
    "YOUR_CHANNEL_ID": {
      "enabled": true,
      "requireMention": true,
      "thinking": "auto",
      "showCode": false,
      "verbose": false
    }
  }
}
EOF

npm run start
```

Expected output:

```
◇ injected env (3) from ../../.gemini/channels/discord/.env
Gemma online as <bot-username>#XXXX (<bot-id>)
Slash commands registered.
```

---

## Tests

```bash
npm run test
```

Coverage: access manager (allowlist + flags + invariants), gemini client (response parsing, tool extraction, mime sanitization), attachments processing, history formatting + token budgeting, persona loading, chunk splitting, pinned-facts store, summarization scheduler, reactions handler.

---

## Future Roadmap

- **Proactive cron jobs:** scheduled Gemma broadcasts (daily portfolio briefings, risk alerts, earnings summaries) into a dedicated channel.
- **Multi-agent debates:** delegate sub-tasks (`jules-review` on a GitHub link) or spawn secondary instances to argue both sides of a thesis.
- **Voice channel intake:** join Discord voice and transcribe/process audio streams natively via Gemini's multimodal stack.
- **Migration to `@google/genai`:** the legacy `@google/generative-ai` SDK is unmaintained and has known stream-parse bugs we're working around. New SDK is the long-term fix.
