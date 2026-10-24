import type { ObjectObservation, PoseLandmarks } from '../types/vision'

export type DemoScenario = 'unattended' | 'watched' | 'conflict' | 'calm'
export const DEMO_SIZE = { width: 1280, height: 720 }

function interactionPose(centerX: number, direction: number, extension: number, waving: boolean, timeMs: number): PoseLandmarks {
  const pose: PoseLandmarks = Array.from({ length: 33 }, () => ({ x: centerX, y: .5, z: 0, visibility: 0 }))
  const points: Record<number, [number, number]> = {
    0: [0, .27], 7: [-.015, .27], 8: [.015, .27],
    11: [-.04, .38], 12: [.04, .38], 13: [-.07, .49], 14: [.075, .46],
    15: [-.09, .59], 16: [.08, .43], 23: [-.03, .61], 24: [.03, .61],
    25: [-.045, .75], 26: [.055, .75], 27: [-.06, .90], 28: [.07, .90],
    29: [-.063, .91], 30: [.073, .91], 31: [-.08, .92], 32: [.09, .92],
  }
  for (const [index, [x, y]] of Object.entries(points)) {
    pose[Number(index)] = { x: centerX + direction * x, y, z: 0, visibility: .98 }
  }
  // Smooth joint motion goes through the same temporal engine as camera poses.
  pose[14] = { x: centerX + direction * (.09 + extension * .065), y: .48 - extension * .085, z: 0, visibility: .98 }
  pose[16] = { x: centerX + direction * (.075 + extension * .165), y: .43 - extension * .045, z: 0, visibility: .98 }
  if (waving) {
    pose[13] = { x: centerX - direction * .075, y: .28, z: 0, visibility: .98 }
    pose[15] = { x: centerX - direction * (.075 + .03 * Math.sin(timeMs / 170)), y: .16, z: 0, visibility: .98 }
  }
  return pose
}

function interactionFrame(elapsedMs: number, scenario: 'conflict' | 'calm') {
  const time = Math.max(0, elapsedMs - 1_500)
  const phase = (time % 950) / 950
  const extension = elapsedMs < 1_500 || scenario === 'calm' ? 0
    : phase < .38 ? phase / .38 : phase < .73 ? 1 - (phase - .38) / .35 : 0
  const poses = [
    interactionPose(.34, 1, extension, scenario === 'calm', elapsedMs),
    interactionPose(.65, -1, 0, false, elapsedMs),
  ]
  const objects: ObjectObservation[] = [.34, .65].map(x => ({
    label: 'person', displayName: 'Person', role: 'person', score: .98,
    box: { x: x - .1, y: .2, width: .2, height: .72 },
  }))
  return { objects, poses }
}

/** Scripted observations for testing the event engine, never model output. */
export function demoFrame(elapsedMs: number, scenario: DemoScenario) {
  if (scenario === 'conflict' || scenario === 'calm') return interactionFrame(elapsedMs, scenario)
  const moving = scenario === 'watched' ? Math.min(1, Math.max(0, (elapsedMs - 7_000) / 2_000)) : 0
  const bag: ObjectObservation = {
    label: 'backpack', displayName: 'Backpack', role: 'bag', score: 0.92,
    box: { x: 0.49 + moving * 0.24, y: 0.54 - moving * 0.1, width: 0.075, height: 0.19 },
  }
  const personX = scenario === 'unattended'
    ? 0.36 - Math.min(1, elapsedMs / 3_000) * 0.66
    : 0.34 + moving * 0.24
  const person: ObjectObservation = {
    label: 'person', displayName: 'Person', role: 'person', score: 0.95,
    box: { x: personX, y: 0.2, width: 0.17, height: 0.66 },
  }
  const poses: PoseLandmarks[] = []
  if (personX > -0.12) {
    const pose: PoseLandmarks = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0 }))
    const points: Record<number, [number, number]> = {
      0: [.085,.075], 7: [.065,.075], 8: [.105,.075],
      11: [.045,.19], 12: [.125,.19], 13: [.025,.32], 14: [.15,.30],
      15: [.01,.45], 16: [.18,.40], 23: [.06,.38], 24: [.115,.38],
      25: [.05,.51], 26: [.13,.51], 27: [.04,.66], 28: [.14,.66],
      29: [.035,.67], 30: [.135,.67], 31: [.06,.67], 32: [.16,.67],
    }
    for (const [index, [x, y]] of Object.entries(points)) {
      pose[Number(index)] = { x: personX + x, y: 0.15 + y, z: 0, visibility: .98 }
    }
    poses.push(pose)
  }
  return { objects: personX > -0.12 ? [person, bag] : [bag], poses }
}

export function drawDemoScene(canvas: HTMLCanvasElement, observations: ObjectObservation[], poses: PoseLandmarks[] = []): void {
  canvas.width = DEMO_SIZE.width
  canvas.height = DEMO_SIZE.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#141c25'
  ctx.fillRect(0, 0, 1280, 720)
  ctx.fillStyle = '#1b2633'
  ctx.fillRect(0, 515, 1280, 205)
  ctx.strokeStyle = '#334251'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, 515); ctx.lineTo(1280, 515); ctx.stroke()
  if (poses.length > 1) {
    for (const pose of poses) {
      const point = (index: number) => [pose[index].x * DEMO_SIZE.width, pose[index].y * DEMO_SIZE.height] as const
      ctx.fillStyle = '#34485c'
      ctx.beginPath()
      for (const [position, index] of [11, 12, 24, 23].entries()) {
        const [x, y] = point(index)
        if (!position) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath(); ctx.fill()
      ctx.beginPath(); ctx.ellipse(...point(0), 24, 30, 0, 0, Math.PI * 2); ctx.fill()
      ctx.strokeStyle = '#34485c'; ctx.lineWidth = 19; ctx.lineCap = 'round'
      for (const [a, b] of [[11,13],[13,15],[12,14],[14,16],[23,25],[25,27],[24,26],[26,28]]) {
        ctx.beginPath(); ctx.moveTo(...point(a)); ctx.lineTo(...point(b)); ctx.stroke()
      }
    }
    return
  }
  // A fixed bench gives the operator a visible reference for item movement.
  ctx.fillStyle = '#344454'
  ctx.beginPath(); ctx.roundRect(575, 495, 380, 20, 5); ctx.fill()
  ctx.fillRect(605, 515, 12, 75); ctx.fillRect(915, 515, 12, 75)
  for (const item of observations) {
    const { x, y, width, height } = item.box
    if (item.role === 'person') {
      ctx.fillStyle = '#526579'
      ctx.beginPath(); ctx.ellipse((x + width / 2) * 1280, 165, 29, 34, 0, 0, Math.PI * 2); ctx.fill()
      ctx.beginPath(); ctx.roundRect((x + .04) * 1280, 208, 115, 176, 35); ctx.fill()
      ctx.strokeStyle = '#526579'; ctx.lineWidth = 29; ctx.lineCap = 'round'
      for (const [from, to] of [[.057,.035], [.112,.14]]) {
        ctx.beginPath(); ctx.moveTo((x + from) * 1280, 373); ctx.lineTo((x + to) * 1280, 590); ctx.stroke()
      }
    } else {
      ctx.fillStyle = '#879cbc'
      ctx.beginPath(); ctx.roundRect(x * 1280, y * 720, width * 1280, height * 720, 20); ctx.fill()
      ctx.strokeStyle = '#b0bfce'; ctx.lineWidth = 5
      ctx.beginPath(); ctx.roundRect((x + .019) * 1280, y * 720 - 15, width * 640, 32, 10); ctx.stroke()
      ctx.fillStyle = '#637896'
      ctx.beginPath(); ctx.roundRect((x + .01) * 1280, (y + .105) * 720, (width - .02) * 1280, 43, 8); ctx.fill()
    }
  }
}
