/** Only chapter outcomes count: infrastructure errors and preflights do not. */
export const BIBLE_ABUSE = {
  windowSeconds: 300,
  missingLimit: 50,
  missingRatio: 0.9,
  suspensionSeconds: 1800,
  repeatSuspensionSeconds: 7200,
  repeatWindowSeconds: 86400,
} as const

type Sample = { second: number; total: number; missing: number }

export type BibleAbuseState = {
  samples: Sample[]
  blockedUntil: number
  lastBlockedAt: number
  expiresAt: number
}

export function isBibleOutcome(status: number): boolean {
  return status === 200 || status === 206 || status === 304 || status === 404
}

export function bibleRetryAfter(state: BibleAbuseState | undefined, now: number): number {
  return Math.max(0, Math.ceil(((state?.blockedUntil ?? 0) - now) / 1000))
}

/** Rolling five-minute window, aggregated by second (at most 300 samples). */
export function recordBibleOutcome(
  previous: BibleAbuseState | undefined,
  status: number,
  now: number,
): BibleAbuseState | undefined {
  if (!isBibleOutcome(status) || bibleRetryAfter(previous, now) > 0) return previous
  const state: BibleAbuseState =
    previous && previous.expiresAt > now
      ? structuredClone(previous)
      : { samples: [], blockedUntil: 0, lastBlockedAt: 0, expiresAt: 0 }
  const second = Math.floor(now / 1000)
  state.samples = state.samples.filter(
    (sample) => sample.second > second - BIBLE_ABUSE.windowSeconds,
  )
  let sample = state.samples.at(-1)
  if (sample?.second !== second) {
    sample = { second, total: 0, missing: 0 }
    state.samples.push(sample)
  }
  sample.total += 1
  if (status === 404) sample.missing += 1
  const totals = state.samples.reduce(
    (sum, item) => ({ total: sum.total + item.total, missing: sum.missing + item.missing }),
    { total: 0, missing: 0 },
  )
  if (
    totals.missing >= BIBLE_ABUSE.missingLimit &&
    totals.missing / totals.total >= BIBLE_ABUSE.missingRatio
  ) {
    const repeated =
      state.lastBlockedAt > 0 && now - state.lastBlockedAt < BIBLE_ABUSE.repeatWindowSeconds * 1000
    state.blockedUntil =
      now + 1000 * (repeated ? BIBLE_ABUSE.repeatSuspensionSeconds : BIBLE_ABUSE.suspensionSeconds)
    state.lastBlockedAt = now
    state.samples = []
  }
  state.expiresAt = Math.max(
    now + BIBLE_ABUSE.windowSeconds * 1000,
    state.lastBlockedAt + BIBLE_ABUSE.repeatWindowSeconds * 1000,
  )
  return state
}
