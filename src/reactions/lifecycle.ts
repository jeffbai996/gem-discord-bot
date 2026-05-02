/**
 * Lifecycle reactions on inbound user messages — match the squad's
 * react_hook lifecycle so Gemma feels like the rest of the bots.
 *
 * Each state cleans up its declared transient predecessors (so 🤔 replaces
 * 👀, 🔧 replaces 🤔, ✅ replaces all transients). Final states (replied,
 * errored) clean every transient. Mirrors react_hook.py's
 * TRANSIENT_PREDECESSORS table.
 */
import type { Message } from 'discord.js'

export const EMOJI = {
  received:    '👀',
  thinking:    '🤔',
  editing:     '🔧',
  researching: '🌐',
  delegating:  '🤖',
  replied:     '✅',
  errored:     '❌',
  denied:      '⚠️',
} as const

export type LifecycleState = keyof typeof EMOJI

const ALL_TRANSIENTS: LifecycleState[] = ['received', 'thinking', 'editing', 'researching', 'delegating']

const PREDECESSORS: Record<LifecycleState, LifecycleState[]> = {
  received:    [],
  thinking:    ['received'],
  editing:     ['received', 'thinking'],
  researching: ['received', 'thinking'],
  delegating:  ['received', 'thinking'],
  replied:     ALL_TRANSIENTS,
  errored:     ALL_TRANSIENTS,
  denied:      ALL_TRANSIENTS,
}

/**
 * Add the emoji for `state` on `message`. Best-effort — discord errors are
 * logged but never thrown (a missing reaction shouldn't crash the bot).
 *
 * Idempotent per-state: discord.js's `react()` is a PUT, so re-applying is
 * a no-op on Discord's side.
 */
export async function applyLifecycle(message: Message, state: LifecycleState): Promise<void> {
  const emoji = EMOJI[state]

  // Remove previous transients first so the row of reactions doesn't grow.
  // We only remove OUR OWN reactions (so user content reactions stay).
  const me = message.client.user
  if (me) {
    for (const prev of PREDECESSORS[state]) {
      const prevEmoji = EMOJI[prev]
      if (prevEmoji === emoji) continue
      const r = message.reactions.cache.get(prevEmoji)
      if (r) {
        await r.users.remove(me.id).catch(() => { /* fire-and-forget */ })
      }
    }
  }

  await message.react(emoji).catch(e => {
    console.error(`[lifecycle] react ${emoji} (${state}) failed:`, e)
  })
}
