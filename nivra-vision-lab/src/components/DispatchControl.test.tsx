import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DispatchControl } from './DispatchControl'
import type { GuardAlert, GuardsApi, GuardSnapshot } from '../hooks/useGuards'
import type { ReviewEvent } from '../lib/sceneEngine'

const event = { id: 'fight-1', type: 'fight', title: 'Possible fight', detail: 'Two windows agreed.', objectName: 'Live camera', occurredAtMs: 0 } as unknown as ReviewEvent
const guard = (id: string, name: string, shift: 'on_shift' | 'break' | 'off', online = true, paired = true) =>
  ({ id, name, shift, online, paired, lastSeen: online ? 1 : null })
const alert = (status: GuardAlert['status'], police: GuardAlert['police'] = null): GuardAlert => ({
  id: 'a1', guardId: 'g2', guardName: 'Asha', eventId: 'fight-1', title: 'Possible fight', detail: '', camera: 'Cam', note: null,
  sentAt: 0, ackAt: null, declinedAt: null, onSceneAt: null, clearedAt: null, police, status, revision: 1,
})

function api(snapshot: GuardSnapshot): GuardsApi {
  return {
    snapshot, error: null,
    addGuard: vi.fn(), removeGuard: vi.fn(), invite: vi.fn(), clearAlert: vi.fn(),
    send: vi.fn(async () => alert('sent')), recordPolice: vi.fn(async () => alert('sent')),
  } as unknown as GuardsApi
}

describe('sending a reviewed alert to a guard', () => {
  afterEach(cleanup)

  it('defaults to an online on-shift guard and sends only on click', async () => {
    const guards = api({ lan: { host: '192.168.1.2', port: 18766 }, alerts: [],
      guards: [guard('g1', 'Ravi', 'off'), guard('g2', 'Asha', 'on_shift'), guard('g3', 'New', 'on_shift', false, false)] })
    render(<DispatchControl event={event} camera="iPhone · USB cable" guards={guards} acknowledged={false} onAcknowledge={vi.fn()} onNeedGuard={vi.fn()} />)
    expect(guards.send).not.toHaveBeenCalled()
    // Unlinked guards cannot be chosen.
    expect(screen.queryByRole('option', { name: /New/ })).toBeNull()
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('g2')
    fireEvent.click(screen.getByRole('button', { name: 'Call guard' }))
    await waitFor(() => expect(guards.send).toHaveBeenCalledWith({ guardId: 'g2', eventId: expect.stringMatching(/:fight-1:0$/), title: 'Possible fight', detail: 'Two windows agreed.', camera: 'iPhone · USB cable' }))
  })

  it('shows guard progress and records a police call against the open alert', async () => {
    const first = api({ lan: { host: null, port: 18766 }, guards: [guard('g2', 'Asha', 'on_shift')], alerts: [] })
    const view = render(<DispatchControl event={event} camera="Cam" guards={first} acknowledged={false} onAcknowledge={vi.fn()} onNeedGuard={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Call guard' }))
    await waitFor(() => expect(first.send).toHaveBeenCalled())
    const key = vi.mocked(first.send).mock.calls[0][0].eventId
    view.unmount()
    const guards = api({ lan: { host: null, port: 18766 }, guards: [guard('g2', 'Asha', 'on_shift')],
      alerts: [{ ...alert('on_scene', { at: 0, by: 'Asha' }), eventId: key }, { ...alert('sent'), id: 'old', eventId: 'fight-1' }] })
    render(<DispatchControl event={event} camera="Cam" guards={guards} acknowledged={false} onAcknowledge={vi.fn()} onNeedGuard={vi.fn()} />)
    expect(screen.getByTestId('dispatch-status').textContent).toContain('Asha · On scene · Police called by Asha')
    const police = screen.getByRole('link', { name: 'Call police' })
    expect(police.getAttribute('href')).toBe('tel:112')
    police.addEventListener('click', click => click.preventDefault())
    fireEvent.click(police)
    expect(guards.recordPolice).toHaveBeenCalledWith('a1')
  })

  it('shows three actions and opens guard setup when nobody is linked', () => {
    const onNeedGuard = vi.fn(), onAcknowledge = vi.fn()
    const guards = api({ lan: { host: null, port: 18766 }, guards: [], alerts: [] })
    render(<DispatchControl event={event} camera="Cam" guards={guards} acknowledged={false} onAcknowledge={onAcknowledge} onNeedGuard={onNeedGuard} />)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['Acknowledge', 'Call guard'])
    fireEvent.click(screen.getByRole('button', { name: 'Call guard' }))
    expect(onNeedGuard).toHaveBeenCalled()
    expect(guards.send).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    expect(onAcknowledge).toHaveBeenCalled()
  })
})
