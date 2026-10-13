export const MAINTENANCE_STATE_KEY = 'state/maintenance.json'
const DAY_MS = 24 * 60 * 60 * 1000

type MaintenanceState = { in_progress?: boolean; completed_at?: string }

export function readMaintenanceState(text: string | null): MaintenanceState {
  if (text === null) return {}
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function maintenanceDue(text: string | null, now: Date): boolean {
  const state = readMaintenanceState(text)
  const completed = Date.parse(state.completed_at ?? '')
  return (
    state.in_progress === true ||
    !Number.isFinite(completed) ||
    completed > now.getTime() ||
    now.getTime() - completed >= DAY_MS
  )
}

export function maintenanceMarker(
  text: string | null,
  phase: 'start' | 'complete',
  full: boolean,
  now: Date,
): string {
  const state = readMaintenanceState(text)
  return JSON.stringify({
    ...state,
    in_progress: phase === 'start',
    ...(phase === 'complete' && full ? { completed_at: now.toISOString() } : {}),
  })
}
