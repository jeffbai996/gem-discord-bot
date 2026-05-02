// Gemini context-cache manager for the stable system-prompt prefix.
//
// Caches `persona + RESPONSE_FORMAT_BASE + thinking-mode addendum + tools +
// toolConfig` server-side via `client.caches.create`. Per-call we pass
// `cachedContent: name` instead of re-sending the prefix; only the volatile
// contents (history + user message + summary) flow on the wire. Cached input
// bills at ~25% of normal rate, plus a per-hour storage fee.
//
// Design choices:
//   - Keyed by (model, hash(systemText)) — thinking mode is part of the
//     systemText, so different per-channel modes get separate caches. That's
//     fine: there are 3 modes max (auto/always/never), each cache is small.
//   - In-process map, no persistence. SDK reconstructs the cache on restart.
//     Storage fee runs while cache is alive; rare gemma restarts mean low
//     overhead. Could add explicit cleanup later if it becomes a cost issue.
//   - Fail-open: any error during create returns null; the caller falls back
//     to the uncached path. Better to pay full price than break a turn.
//   - Min token check: skip caching when systemText is below the model's
//     minimum (1024 for Flash, 4096 for Pro). Below the floor, the API
//     400s on cache create.

import type { GoogleGenAI } from '@google/genai'
import { createHash } from 'crypto'

const CACHE_MIN_TOKENS: Record<string, number> = {
  'gemini-2.0-flash': 1024,
  'gemini-2.0-flash-lite': 1024,
  'gemini-2.5-flash': 1024,
  'gemini-3-flash-preview': 1024,
  'gemini-2.5-pro': 4096,
  'gemini-3-pro-preview': 4096,
  'gemini-3.1-pro-preview': 4096,
}

const CACHE_DEFAULT_TTL_SEC = 3600

interface CacheKey {
  model: string
  systemHash: string
  toolsHash: string
}

interface CachedRef {
  name: string  // e.g. "cachedContents/abc123"
  systemText: string
  createdAt: number
}

export class GeminiCacheManager {
  private cacheByKey: Map<string, CachedRef> = new Map()

  private static keyString(k: CacheKey): string {
    return `${k.model}|${k.systemHash}|${k.toolsHash}`
  }

  private static hash(s: string): string {
    return createHash('sha1').update(s).digest('hex').slice(0, 12)
  }

  static estimateTokens(text: string): number {
    // Rough char/4 estimate. Avoids a synchronous countTokens() round-trip
    // on the hot path. Off by ~10-15% for English; close enough for the
    // floor check.
    return Math.ceil(text.length / 4)
  }

  // Returns the cached content `name` if a cache is available + reusable.
  // Creates one on first miss. Returns null if caching is unsupported for
  // the model, the prefix is below the minimum size, or the API call failed.
  async getOrCreate(
    client: GoogleGenAI,
    model: string,
    systemText: string,
    tools: any[],
    toolConfig: any,
    ttlSec: number = CACHE_DEFAULT_TTL_SEC,
  ): Promise<string | null> {
    const minTokens = CACHE_MIN_TOKENS[model]
    if (!minTokens) return null  // unknown model — don't try
    if (GeminiCacheManager.estimateTokens(systemText) < minTokens) return null

    const key: CacheKey = {
      model,
      systemHash: GeminiCacheManager.hash(systemText),
      toolsHash: GeminiCacheManager.hash(JSON.stringify(tools ?? []) + JSON.stringify(toolConfig ?? {})),
    }
    const keyStr = GeminiCacheManager.keyString(key)
    const cached = this.cacheByKey.get(keyStr)
    if (cached) return cached.name

    try {
      const created = await client.caches.create({
        model,
        config: {
          systemInstruction: { role: 'system', parts: [{ text: systemText }] },
          tools,
          toolConfig,
          ttl: `${ttlSec}s`,
          displayName: `gemma-${model}-${key.systemHash}-${key.toolsHash}`,
        } as any,
      })
      const name = (created as any)?.name
      if (typeof name !== 'string' || !name) return null
      this.cacheByKey.set(keyStr, { name, systemText, createdAt: Date.now() })
      console.error(`[gemini cache] created model=${model} system=${key.systemHash} tools=${key.toolsHash} name=${name}`)
      return name
    } catch (e: any) {
      console.error(`[gemini cache] create failed (fail-open):`, e?.message ?? e)
      return null
    }
  }

  // Drop all cached refs. Used when persona reloads or when /gemini clear
  // wants to nuke any in-flight cache for a channel — safer than tracking
  // per-channel cache lineage when the persona is global anyway.
  clear(): void {
    this.cacheByKey.clear()
  }
}
