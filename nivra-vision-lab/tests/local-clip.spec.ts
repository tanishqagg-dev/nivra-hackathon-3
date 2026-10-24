import { selectMotionRules } from './helpers/motionMode'
import { expect, test } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import type { PoseLandmarks } from '../src/types/vision'

const clipPath = process.env.NIVRA_TEST_VIDEO
const expectReview = process.env.NIVRA_EXPECT_REVIEW === '1'
// A frame-by-frame scan generates many DOM updates. Recording a second video
// and a full Playwright trace would compete with the model on this same CPU.
test.use({ trace: 'off', video: 'off' })

test.afterEach(async ({ page }, testInfo) => {
  if (!clipPath || page.isClosed()) return
  const trace = await page.evaluate(() => (window as typeof window & { __clipTrace: unknown }).__clipTrace)
  if (!trace) return
  const tracePath = testInfo.outputPath('local-clip-trace.json')
  await writeFile(tracePath, JSON.stringify(trace))
  await testInfo.attach('local-clip-trace', { path: tracePath, contentType: 'application/json' })
})

test('inspect a supplied local clip with the real pose model', async ({ page }, testInfo) => {
  test.skip(!clipPath, 'Set NIVRA_TEST_VIDEO to a local video path. Footage is never bundled or uploaded.')
  test.setTimeout(420_000)
  await page.addInitScript(() => {
    const trace = { frames: [] as Array<{
      timestampMs: number; mediaTime: number; inferenceMs: number; poses: PoseLandmarks[]
    }>, samples: [] as Array<{ mediaTime: number; status: string; usable: string; pairs: string; progress: number; signals: string }>, models: [] as string[],
    reviews: [] as Array<{ mediaTime: number; text: string }>, tones: 0 }
    Object.assign(window, { __clipTrace: trace })
    const submitted = new Map<number, number>()
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', ({ data }) => {
          if (data.type !== 'pose-result') return
          trace.frames.push({ timestampMs: data.timestampMs, mediaTime: submitted.get(data.timestampMs) ?? 0, inferenceMs: data.inferenceMs, poses: data.poses })
          submitted.delete(data.timestampMs)
        })
      }
      postMessage(message: unknown, transfer: Transferable[]) {
        const data = message as { type: string; task?: string; modelPath?: string; timestampMs?: number }
        if (data.type === 'init' && data.task === 'pose' && data.modelPath) trace.models.push(data.modelPath)
        if (data.type === 'frame' && data.timestampMs !== undefined) submitted.set(data.timestampMs, document.querySelector('video')?.currentTime ?? 0)
        super.postMessage(message, transfer)
      }
    }
    const nativeOscillator = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const oscillator = nativeOscillator.call(this)
      const start = oscillator.start.bind(oscillator)
      oscillator.start = (when?: number) => { trace.tones += 1; start(when) }
      return oscillator
    }
    window.setInterval(() => {
      const video = document.querySelector('video')
      if (!video || !video.getAttribute('src')) return
      const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''
      trace.samples.push({ mediaTime: video.currentTime, status: text('conflict-status'), usable: text('coverage-usable'), pairs: text('coverage-pairs'),
        progress: (document.querySelector('[data-testid="conflict-progress"]') as HTMLProgressElement)?.value ?? 0,
        signals: document.querySelector('.conflict-signals')?.textContent ?? '',
      })
      const review = text('review-alert')
      if (review && !trace.reviews.some(event => event.text === review)) trace.reviews.push({ mediaTime: video.currentTime, text: review })
    }, 100)
  })
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort('internetdisconnected'))
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', { timeout: 25_000 })
  await page.getByText('Detection settings', { exact: true }).click()
  await expect(page.getByLabel('Video analysis', { exact: true })).toHaveValue('review')
  await expect(page.getByLabel('Video review sensitivity', { exact: true })).toHaveValue('early')
  await page.getByText('Detection settings', { exact: true }).click()
  await page.getByLabel('Open local video').setInputFiles(clipPath!)
  await expect(page.getByTestId('camera-status')).toContainText('Review running', { timeout: 30_000 })
  await expect(page.getByTestId('camera-video')).toHaveCSS('object-fit', 'contain')
  await page.waitForFunction(() => (document.querySelector('video') as HTMLVideoElement).currentTime >= 8, undefined, { timeout: 180_000 })
  await page.screenshot({ path: testInfo.outputPath('mid-clip.png'), fullPage: true })
  await expect(page.getByTestId('camera-status')).toHaveText('Review complete', { timeout: 180_000 })
  await expect(page.getByTestId('runtime-delegate')).toHaveText('CPU')
  const trace = await page.evaluate(() => (window as typeof window & { __clipTrace: {
    frames: Array<{ mediaTime: number; timestampMs: number; poses: unknown[] }>; models: string[]; tones: number
  } }).__clipTrace)
  expect(trace.models).toContain('/models/pose_landmarker_full.task')
  expect(trace.frames.length).toBeGreaterThan(1)
  // Fixed source steps must not change when CPU/GPU processing gets slower.
  for (let index = 1; index < trace.frames.length; index += 1) {
    const delta = trace.frames[index].mediaTime - trace.frames[index - 1].mediaTime
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(.041)
    expect(trace.frames[index].timestampMs).toBeGreaterThan(trace.frames[index - 1].timestampMs)
  }
  if (expectReview) {
    expect(Math.max(...trace.frames.map(frame => frame.poses.length))).toBeGreaterThanOrEqual(2)
    await expect(page.getByTestId('review-alert')).toContainText('Possible physical conflict')
    expect(trace.tones).toBeGreaterThanOrEqual(3)
  }
  await page.screenshot({ path: testInfo.outputPath('finished-clip.png'), fullPage: true })
})
