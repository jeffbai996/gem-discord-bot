# gem-discord-bot Context & Guidelines

This document provides context for agents working on `gem-discord-bot`.

## Project Overview
A standalone Discord bot using Discord.js and Gemini 2.0. It acts as an intelligent assistant with access to Gemini tools (Google Search, Code Execution) and supports full multimodal input (Images, Video, Audio, Documents).

## Core Architecture
- **Language/Runtime:** TypeScript + Node.js (via `tsx`).
- **State Management:** All state (`.env`, `access.json`, `persona.md`) lives in `~/.gemini/channels/discord/`.
- **Bot Persona:** "Gemma" — helpful, concise, responds to allowlisted users/channels.
- **Admin Control:** Discord Slash Commands (`/gemini`) control permissions to avoid manual JSON edits.

## Development Rules
- Use `tsx` for running the bot locally (`npm run start`).
- Use `node:test` for testing (`npm run test`).
- Keep features modular (`src/gemini.ts`, `src/attachments.ts`, `src/chunk.ts`).
- Avoid adding heavy database dependencies unless strictly necessary (SQLite is preferred if needed later).
- When processing media, use `Promise.allSettled` to maintain high throughput and non-blocking I/O.

## Deployment

Runs as a systemd user service (`gemma.service`) on Node 22+ via nvm. The service invokes `node --import tsx/esm src/gemma.ts`. Host-specific deploy commands (SSH targets, paths) live in `README_PRIVATE.md` (gitignored).

The service supports hot reload of `access.json` and `persona.md` via `SIGHUP` — no full restart needed for permission/persona edits:

```bash
systemctl --user kill -s HUP gemma
```

Logs: `~/.gemini/channels/discord/gemma.log`.

## Runtime note — native modules

`better-sqlite3` and `sqlite-vss` are native Node modules. They do not work on Bun (`ERR_DLOPEN_FAILED`). Stay on Node+tsx until someone ports sqlite-vss to a Bun-friendly backend.

## Future Roadmap (Architectural Debt & New Features)
- **Proactive Cron Jobs (Autonomy):** Enable Gemma to run scheduled tasks (e.g., pulling data from `ibkr-terminal`) to drop unprompted daily portfolio briefings, risk alerts, or earnings summaries into a dedicated channel.
- **Agent Handoff & Multi-Agent Debates:** Give Gemma the ability to delegate sub-tasks (triggering `jules-review` on a GitHub link) or spawn secondary model instances to debate complex topics (e.g., generating a bull case, then calling a bear-case agent to argue against it).
- **Token-Aware Context Windowing:** Replace the hardcoded 20-message limit in `history.ts` with a dynamic token counter to maximize context efficiency without hitting API limits.
- **Voice Channel Intake:** Enable the bot to join Discord Voice Channels and transcribe/process audio streams using Gemini's native multimodal capabilities.
