import assert from 'node:assert/strict'
import test from 'node:test'
import { maintenanceDue, maintenanceMarker } from '../scripts/lib/maintenance-state.ts'

const now = new Date('2026-10-13T07:42:00Z')

test('revisão diária tolera o atraso do agendador e depende da última conclusão', () => {
  assert.equal(maintenanceDue(JSON.stringify({ completed_at: '2026-10-12T06:17:00Z' }), now), true)
  assert.equal(maintenanceDue(JSON.stringify({ completed_at: '2026-10-13T00:00:00Z' }), now), false)
  for (const state of [null, '{}', 'bad json', JSON.stringify({ completed_at: '2099-01-01' })])
    assert.equal(maintenanceDue(state, now), true)
})

test('falha após publicar o catálogo continua pendente para concluir o banco Delphi', () => {
  const before = JSON.stringify({ completed_at: '2026-10-13T00:00:00Z' })
  const started = maintenanceMarker(before, 'start', false, now)
  assert.equal(maintenanceDue(started, now), true)
  const partial = maintenanceMarker(started, 'complete', false, now)
  assert.equal(JSON.parse(partial).completed_at, '2026-10-13T00:00:00Z')
  assert.equal(maintenanceDue(partial, now), false)
  const complete = maintenanceMarker(started, 'complete', true, now)
  assert.equal(JSON.parse(complete).completed_at, now.toISOString())
  assert.equal(maintenanceDue(complete, now), false)
})
