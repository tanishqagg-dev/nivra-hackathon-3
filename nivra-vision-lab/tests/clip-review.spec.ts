import { selectMotionRules } from './helpers/motionMode'
import { fileURLToPath } from 'node:url'
import { expect, test, type Page } from '@playwright/test'

const CLIP_PATH = fileURLToPath(new URL('./fixtures/pose-squats.mp4', import.meta.url))

// Traces retain DOM snapshots and actions on failure; recording every decoded
// scan frame adds overhead without validating these mocked inference results.
test.use({ video: 'off', trace: 'retain-on-failure' })

interface FixtureFrame {
  task: 'pose' | 'objects'
  timestampMs: number
  mediaTime: number
  source: 'camera' | 'clip'
}

interface ReviewFixture {
  frames: FixtureFrame[]
  delivered: FixtureFrame[]
  inFlightPose: number
  maxInFlightPose: number
  pendingCount: number
  holdResponses: boolean
  release(): void
  cameraStream?: MediaStream
}

// Lifecycle tests only. The MP4 is decoded by the browser, but every worker
// result below is a controlled fixture, not model output or accuracy evidence.
async function installWorkerFixture(page: Page) {
  await page.addInitScript(() => {
    const pending: Array<() => void> = []
    const fixture: ReviewFixture = {
      frames: [], delivered: [], inFlightPose: 0, maxInFlightPose: 0,
      pendingCount: 0, holdResponses: false,
      release() {
        fixture.holdResponses = false
        const replies = pending.splice(0)
        fixture.pendingCount = 0
        for (const reply of replies) reply()
      },
    }
    Object.assign(window, { __reviewFixture: fixture })

    class FixtureWorker extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      private task: 'pose' | 'objects' = 'pose'
      private terminated = false

      postMessage(message: {
        type: string
        task?: 'pose' | 'objects'
        bitmap?: ImageBitmap
        timestampMs?: number
      }) {
        if (this.terminated) return
        if (message.type === 'init') {
          this.task = message.task ?? 'pose'
          window.setTimeout(() => this.emit({ type: 'ready', task: this.task, delegate: 'CPU' }), 0)
          return
        }
        if (message.type !== 'frame' || message.timestampMs === undefined) return
        message.bitmap?.close()
        const video = document.querySelector('video')
        const frame: FixtureFrame = {
          task: this.task,
          timestampMs: message.timestampMs,
          mediaTime: video?.currentTime ?? 0,
          source: video?.srcObject ? 'camera' : 'clip',
        }
        fixture.frames.push(frame)
        if (this.task === 'pose') {
          fixture.inFlightPose += 1
          fixture.maxInFlightPose = Math.max(fixture.maxInFlightPose, fixture.inFlightPose)
        }
        const finish = () => {
          if (this.task === 'pose') fixture.inFlightPose -= 1
          if (this.terminated) return
          fixture.delivered.push(frame)
          // Two visible joints make a stale response detectable in the canvas.
          // They deliberately provide no interaction or crime classification.
          const pose = Array.from({ length: 33 }, (_, index) => ({
            x: index === 11 ? .4 : .6, y: .4, z: 0,
            visibility: index === 11 || index === 12 ? .99 : 0,
            presence: index === 11 || index === 12 ? .99 : 0,
          }))
          this.emit(this.task === 'pose'
            ? { type: 'pose-result', timestampMs: frame.timestampMs, inferenceMs: 15, poses: [pose] }
            : { type: 'object-result', timestampMs: frame.timestampMs, inferenceMs: 15, objects: [] })
        }
        window.setTimeout(() => {
          if (fixture.holdResponses) {
            pending.push(finish)
            fixture.pendingCount = pending.length
          } else finish()
        }, 15)
      }

      terminate() { this.terminated = true }

      private emit(data: unknown) {
        if (this.terminated) return
        const event = new MessageEvent('message', { data })
        this.onmessage?.(event)
        this.dispatchEvent(event)
      }
    }

    window.Worker = FixtureWorker as unknown as typeof Worker
  })
}

async function poseFrames(page: Page, source: FixtureFrame['source'] = 'clip') {
  return page.evaluate((kind) =>
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.frames
      .filter(frame => frame.task === 'pose' && frame.source === kind),
  source)
}

async function mediaTime(page: Page) {
  return page.getByTestId('camera-video').evaluate(video => (video as HTMLVideoElement).currentTime)
}

async function openReviewClip(page: Page) {
  await installWorkerFixture(page)
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera')
  await page.getByText('Detection settings', { exact: true }).click()
  await expect(page.getByLabel(/^Video analysis/)).toHaveValue('review')
  await expect(page.getByLabel(/^Video analysis/)).toBeEnabled()
  await page.getByLabel('Open local video').setInputFiles(CLIP_PATH)
  await expect(page.getByTestId('camera-status')).toHaveText('Review running')
  await expect(page.getByLabel(/^Video analysis/)).toBeDisabled()
  await expect(page.getByTestId('clip-review-progress')).toBeVisible()
}

test('mocked review lifecycle freezes on pause and accepts source timestamps after resume and replay', async ({ page }) => {
  test.setTimeout(90_000)
  await openReviewClip(page)
  await expect.poll(async () => (await poseFrames(page)).length).toBeGreaterThan(6)
  expect(await page.getByTestId('camera-video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(true)

  const firstFrames = await poseFrames(page)
  for (let index = 1; index < firstFrames.length; index += 1) {
    expect(firstFrames[index].mediaTime - firstFrames[index - 1].mediaTime).toBeCloseTo(.04, 3)
    expect(firstFrames[index].timestampMs - firstFrames[index - 1].timestampMs).toBeCloseTo(40, 1)
  }
  expect(await page.evaluate(() => (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.maxInFlightPose)).toBe(1)

  await page.getByRole('button', { name: 'Pause', exact: true }).click()
  await expect(page.getByTestId('camera-status')).toHaveText('Review paused')
  // Let an already-started decoder seek settle, then check there is no drift.
  await page.waitForTimeout(120)
  const pausedTime = await mediaTime(page)
  const pausedFrames = await poseFrames(page)
  await page.waitForTimeout(350)
  expect(await mediaTime(page)).toBe(pausedTime)
  expect((await poseFrames(page)).length).toBe(pausedFrames.length)
  await expect(page.getByLabel(/^Video analysis/)).toBeDisabled()

  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(page.getByTestId('camera-status')).toHaveText('Review running')
  await expect.poll(async () => (await poseFrames(page)).length).toBeGreaterThan(pausedFrames.length + 3)
  expect(await mediaTime(page)).toBeGreaterThan(pausedTime)
  const resumed = await poseFrames(page)
  const lastPaused = pausedFrames.at(-1)!
  const firstResumed = resumed[pausedFrames.length]
  expect(firstResumed.timestampMs).toBeGreaterThan(lastPaused.timestampMs)
  expect(firstResumed.timestampMs - lastPaused.timestampMs)
    .toBeCloseTo((firstResumed.mediaTime - lastPaused.mediaTime) * 1000, 1)

  await expect(page.getByTestId('camera-status')).toHaveText('Review complete', { timeout: 60_000 })
  await expect(page.getByRole('button', { name: 'Replay', exact: true })).toBeVisible()
  const completedFrames = await poseFrames(page)
  const lastCompleted = completedFrames.at(-1)!
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(page.getByTestId('camera-status')).toHaveText('Review running')
  await expect.poll(async () => (await poseFrames(page)).length).toBeGreaterThan(completedFrames.length + 4)
  const replayFrames = (await poseFrames(page)).slice(completedFrames.length)
  expect(replayFrames[0].mediaTime).toBeLessThan(.081)
  expect(replayFrames[0].timestampMs).toBeGreaterThan(lastCompleted.timestampMs)
  await expect(page.getByTestId('clip-review-progress').locator('strong')).toContainText(/\b[1-9]\d* samples\b/)
  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera ready')
})

test('mocked delayed review results stay canceled after stop and camera remains real-time', async ({ page }) => {
  await openReviewClip(page)
  await expect.poll(async () => (await poseFrames(page)).length).toBeGreaterThan(3)
  await page.evaluate(() => {
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.holdResponses = true
  })
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.pendingCount,
  )).toBeGreaterThan(0)

  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera ready')
  const stoppedCount = (await poseFrames(page)).length
  const deliveredBefore = await page.evaluate(() =>
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.delivered.length,
  )
  await page.evaluate(() => (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.release())
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.delivered.length,
  )).toBeGreaterThan(deliveredBefore)
  await page.waitForTimeout(250)
  expect((await poseFrames(page)).length).toBe(stoppedCount)
  await expect(page.getByTestId('clip-review-progress')).toBeHidden()
  await expect(page.getByTestId('review-alert')).toBeHidden()
  expect(await page.getByTestId('camera-video').evaluate(video => ({
    source: (video as HTMLVideoElement).getAttribute('src'),
    stream: (video as HTMLVideoElement).srcObject,
  }))).toEqual({ source: null, stream: null })
  expect(await page.getByTestId('pose-canvas').evaluate(canvas => {
    const element = canvas as HTMLCanvasElement
    const pixels = element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data
    return pixels.some((value, index) => index % 4 === 3 && value !== 0)
  })).toBe(false)

  await expect(page.getByLabel(/^Video analysis/)).toBeEnabled()
  await page.getByTestId('start-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera live')
  await expect.poll(async () => (await poseFrames(page, 'camera')).length).toBeGreaterThan(3)
  await expect(page.getByTestId('clip-review-progress')).toBeHidden()
  expect(await page.getByTestId('camera-video').evaluate(video => {
    const element = video as HTMLVideoElement
    const fixture = (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture
    fixture.cameraStream = element.srcObject as MediaStream
    return { paused: element.paused, streamAttached: element.srcObject instanceof MediaStream }
  })).toEqual({ paused: false, streamAttached: true })
  const cameraTime = await mediaTime(page)
  await expect.poll(() => mediaTime(page)).toBeGreaterThan(cameraTime + .1)
  await page.getByTestId('stop-camera').click()
  expect(await page.evaluate(() =>
    (window as typeof window & { __reviewFixture: ReviewFixture }).__reviewFixture.cameraStream?.getTracks()
      .every(track => track.readyState === 'ended'),
  )).toBe(true)
})

test('mocked lifecycle can select real-time video only while no clip is active', async ({ page }) => {
  await installWorkerFixture(page)
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera')
  await page.getByText('Detection settings', { exact: true }).click()
  const mode = page.getByLabel(/^Video analysis/)
  await mode.selectOption('realtime')
  await page.getByLabel('Open local video').setInputFiles(CLIP_PATH)
  await expect(page.getByTestId('camera-status')).toHaveText('Video playing')
  await expect(mode).toBeDisabled()
  expect(await page.getByTestId('camera-video').evaluate(video => (video as HTMLVideoElement).paused)).toBe(false)
  await expect(page.getByTestId('clip-review-progress')).toBeHidden()
  await page.getByTestId('stop-camera').click()
  await expect(mode).toBeEnabled()
  await mode.selectOption('review')
  await expect(mode).toHaveValue('review')
})

test('clip settings stay locked while metadata loads and unlock after Stop', async ({ page }) => {
  await installWorkerFixture(page)
  await page.addInitScript(() => {
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')!
    let pending: { video: HTMLMediaElement; url: string } | null = null
    // Hold only the local file assignment. No decoded frame or worker result
    // is substituted, and release lets the browser load the actual fixture.
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      ...src,
      set(this: HTMLMediaElement, url: string) {
        if (this instanceof HTMLVideoElement && url.startsWith('blob:')) pending = { video: this, url }
        else src.set!.call(this, url)
      },
    })
    Object.assign(window, {
      __releaseClipMetadata() {
        if (!pending) throw new Error('No clip load is waiting.')
        src.set!.call(pending.video, pending.url)
        pending.video.load()
        pending = null
      },
    })
  })
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera')
  await page.getByText('Detection settings', { exact: true }).click()
  const mode = page.getByLabel('Video analysis', { exact: true })
  const sensitivity = page.getByLabel('Video review sensitivity', { exact: true })
  await expect(mode).toBeEnabled()
  await expect(sensitivity).toBeEnabled()
  await page.getByLabel('Open local video').setInputFiles(CLIP_PATH)
  await expect(page.getByTestId('camera-status')).toHaveText('Opening source')
  await expect(mode).toBeDisabled()
  await expect(sensitivity).toBeDisabled()
  expect((await poseFrames(page)).length).toBe(0)

  await page.evaluate(() => (window as typeof window & { __releaseClipMetadata(): void }).__releaseClipMetadata())
  await expect(page.getByTestId('camera-status')).toHaveText('Review running')
  await expect.poll(async () => (await poseFrames(page)).length).toBeGreaterThan(0)
  await expect(mode).toBeDisabled()
  await expect(sensitivity).toBeDisabled()
  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera ready')
  await expect(mode).toBeEnabled()
  await expect(sensitivity).toBeEnabled()
  await mode.selectOption('realtime')
  await sensitivity.selectOption('standard')
  await expect(mode).toHaveValue('realtime')
  await expect(sensitivity).toHaveValue('standard')
})
