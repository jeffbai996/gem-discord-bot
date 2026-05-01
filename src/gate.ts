// Reply-gate decision: should Gemma engage with this message at all?
//
// Used when a channel has `optInReply: true`. Two-tier:
//   tier 0 (free, ~0ms): @mention or reply-to-Gemma → YES.
//   tier 2 (~$0.00001 + ~200ms): flash-lite classifier on the message text.
//
// We deliberately do NOT use a tier-1 embedding classifier — prototype lists
// drift fast and become a maintenance burden. flash-lite is smarter, basically
// the same cost, and self-corrects with prompt edits.
//
// When optInReply is false, the gate is bypassed entirely (gemma replies to
// everything as before).

import type { Message } from 'discord.js'

// Cheap router model. Using the same env var fallback pattern as the rest of
// the bot so a single GEMINI_API_KEY covers both the main model and the gate.
const GATE_MODEL = process.env.GEMMA_GATE_MODEL || 'gemini-2.0-flash-lite'
const GATE_TIMEOUT_MS = 4000

const GATE_SYSTEM = `You are a reply gate for a Discord bot named Gemma. The bot lives in a multi-bot squad — other bots present include Fraggy, Claudsson, Claudovich, 加班鸭 (jiabanya, "Overtime Duck"), and MacClaude.

Decide if the user's most recent message is something Gemma should respond to.

Reply YES when:
- The message addresses Gemma by name ("gemma", "gem", or asks her directly)
- The message is a question or request that no specific bot was named for, AND it's the kind of thing Gemma can help with (multimodal/video/image/document, or general chat)
- The message follows up on a thread Gemma was just in (continuation of her prior turn)

Reply NO when:
- The message clearly addresses a different bot (Fraggy, Claudsson, Claudovich, 加班鸭, MacClaude) by name
- It's casual chatter between humans not asking anything of any bot
- It's a one-word reaction or filler ("lol", "nice", "ok") with no continuation context
- It's a question specifically about portfolio/IBKR/account state (that's Fraggy or MacClaude's lane, not Gemma's)

Output exactly one token: YES or NO. Nothing else, no punctuation, no explanation.`

export interface GateInput {
  message: Message
  botUserId: string
  apiKey: string
}

export interface GateResult {
  decision: 'YES' | 'NO'
  tier: 0 | 2
  reason: string
  latencyMs: number
}

// Tier 0: cheap deterministic checks. Returns null if inconclusive.
function tier0(input: GateInput): GateResult | null {
  const t0 = Date.now()
  const { message, botUserId } = input

  if (message.mentions.users.has(botUserId)) {
    return { decision: 'YES', tier: 0, reason: 'mention', latencyMs: Date.now() - t0 }
  }

  // Reply-to-bot: discord.js exposes the referenced message id but not the
  // author without a fetch. The cheap check is: is reference's author already
  // resolved in cache? If so, compare. If not, skip — we'll let tier 2 decide
  // rather than block on a fetch.
  const refId = message.reference?.messageId
  if (refId) {
    const cached = message.channel.messages.cache.get(refId)
    if (cached?.author.id === botUserId) {
      return { decision: 'YES', tier: 0, reason: 'reply-to-gemma', latencyMs: Date.now() - t0 }
    }
  }

  return null
}

// Tier 2: flash-lite yes/no classifier. Direct REST call rather than going
// through the SDK — this path needs to be cheap and the SDK's overhead +
// retry logic + tool-config noise is unhelpful for a one-token decision.
async function tier2(input: GateInput): Promise<GateResult> {
  const t0 = Date.now()
  const { message, apiKey } = input

  // Compose the gate input. Author name + message body — keep it tight to
  // minimize input tokens, this gets called per-message in opt-in channels.
  const userText = `${message.author.username}: ${message.content || '(no text content)'}`

  const body = {
    systemInstruction: { role: 'system', parts: [{ text: GATE_SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: 8,
      temperature: 0.0
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GATE_MODEL}:generateContent?key=${apiKey}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), GATE_TIMEOUT_MS)

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!resp.ok) {
      // On any API error, fail-open (YES) — better to over-engage than to
      // silently drop messages because of a transient gate fault.
      const errText = await resp.text().catch(() => '')
      console.error(`[gate] flash-lite ${resp.status}: ${errText.slice(0, 200)} — fail-open YES`)
      return { decision: 'YES', tier: 2, reason: `api-error-${resp.status}-failopen`, latencyMs: Date.now() - t0 }
    }
    const payload: any = await resp.json()
    const parts = payload?.candidates?.[0]?.content?.parts ?? []
    const text = parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('').trim().toUpperCase()

    // Strict token check; anything other than literal NO is treated as YES
    // (fail-open). The model is instructed to emit exactly YES/NO, but if it
    // hedges ("YES, because..." or "PROBABLY") we want to engage rather than
    // drop. Only an unambiguous NO suppresses the reply.
    const decision: 'YES' | 'NO' = text.startsWith('NO') ? 'NO' : 'YES'
    return { decision, tier: 2, reason: `flash-lite:${text || '(empty)'}`, latencyMs: Date.now() - t0 }
  } catch (e: any) {
    console.error(`[gate] flash-lite failure: ${e?.message ?? e} — fail-open YES`)
    return { decision: 'YES', tier: 2, reason: `exception-failopen`, latencyMs: Date.now() - t0 }
  } finally {
    clearTimeout(timeoutId)
  }
}

// Public: decide whether Gemma should reply. Should only be called for
// channels with optInReply=true; the caller is responsible for that gate.
export async function shouldReply(input: GateInput): Promise<GateResult> {
  const t0 = tier0(input)
  if (t0) return t0
  return tier2(input)
}
