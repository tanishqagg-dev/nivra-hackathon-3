import { selectMotionRules } from './helpers/motionMode'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

test('Full model produces two real skeletons and survives a quality switch', async ({ page }, testInfo) => {
  test.setTimeout(100_000)
  await page.route('**/__pose_fixture.mp4', route => route.fulfill({
    path: fileURLToPath(new URL('./fixtures/pose-squats.mp4', import.meta.url)),
    contentType: 'video/mp4',
  }))
  await page.addInitScript(() => {
    const proof = { poseFrames: 0, twoPoseFrames: 0, models: [] as string[], lastPoses: [] as unknown[], crop: false }
    Object.assign(window, { __multiPoseProof: proof })
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        this.addEventListener('message', ({ data }) => {
          if (data.type !== 'pose-result') return
          proof.poseFrames += 1
          if (data.poses.length >= 2) proof.twoPoseFrames += 1
          proof.lastPoses = data.poses
        })
      }
      postMessage(message: unknown, transfer: Transferable[]) {
        const data = message as { type: string; task?: string; modelPath?: string }
        if (data.type === 'init' && data.task === 'pose' && data.modelPath) proof.models.push(data.modelPath)
        super.postMessage(message, transfer)
      }
    }
    // Compose two copies of real footage, not generated landmarks. Only the
    // camera source is substituted; the shipped workers and models run unchanged.
    navigator.mediaDevices.getUserMedia = async () => {
      const video = document.createElement('video')
      video.src = '/__pose_fixture.mp4'
      video.muted = true
      video.loop = true
      video.playsInline = true
      await video.play()
      const canvas = document.createElement('canvas')
      canvas.width = 1280
      canvas.height = 720
      const ctx = canvas.getContext('2d')!
      const draw = () => {
        ctx.fillStyle = '#ddd'
        ctx.fillRect(0, 0, 1280, 720)
        if (proof.crop) {
          ctx.drawImage(video, 80, 90, 560, 630, 0, 0, 640, 720)
          ctx.drawImage(video, 80, 90, 560, 630, 640, 0, 640, 720)
        } else {
          ctx.drawImage(video, 60, 0, 405, 720)
          ctx.drawImage(video, 815, 0, 405, 720)
        }
      }
      draw()
      const timer = window.setInterval(draw, 100)
      const stream = canvas.captureStream(10)
      const track = stream.getVideoTracks()[0]
      Object.defineProperty(track, 'label', { value: 'Real footage · two-person fixture' })
      const stop = track.stop.bind(track)
      track.stop = () => { clearInterval(timer); video.pause(); video.removeAttribute('src'); video.load(); stop() }
      return stream
    }
  })
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', { timeout: 30_000 })
  await page.getByTestId('start-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera live')
  const proof = () => page.evaluate(() => (window as typeof window & {
    __multiPoseProof: { poseFrames: number; twoPoseFrames: number; models: string[]; lastPoses: unknown[] }
  }).__multiPoseProof)
  await expect.poll(async () => (await proof()).twoPoseFrames, { timeout: 40_000 }).toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('coverage-detected')).toHaveText(/2/)
  await expect(page.getByTestId('review-alert')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/nivra-two-real-skeletons.png', fullPage: true })

  await page.evaluate(() => {
    const proof = (window as typeof window & { __multiPoseProof: { crop: boolean; twoPoseFrames: number } }).__multiPoseProof
    proof.crop = true
    proof.twoPoseFrames = 0
  })
  await expect.poll(async () => (await proof()).twoPoseFrames, { timeout: 20_000 }).toBeGreaterThanOrEqual(3)
  await expect(page.getByTestId('coverage-usable')).toHaveText('2')
  // The status rail stays hidden until an alert; open it to inspect live diagnostics.
  if (await page.getByRole('button', { name: /^Alerts/ }).getAttribute('aria-pressed') !== 'true') await page.getByRole('button', { name: /^Alerts/ }).click()
  await expect(page.getByText('Upper-body view supported. Hidden leg joints are not used as motion evidence.')).toBeVisible({ timeout: 10_000 })
  await expect(page.getByTestId('review-alert')).toHaveCount(0)
  await page.screenshot({ path: 'test-results/nivra-cropped-real-skeletons.png', fullPage: true })

  await page.getByText('Detection settings', { exact: true }).click()
  await expect(page.getByLabel('Pose model', { exact: true })).toHaveValue('full')
  await page.getByLabel('People limit').selectOption('6')
  await page.getByLabel('Pose model', { exact: true }).selectOption('lite')
  await expect(page.getByTestId('model-status')).toHaveText('Analysis running', { timeout: 30_000 })
  await expect.poll(async () => (await proof()).models).toEqual(expect.arrayContaining([
    '/models/pose_landmarker_full.task', '/models/pose_landmarker_lite.task',
  ]))
  await expect(page.getByLabel('People limit')).toHaveValue('6')
  await page.getByLabel('Pose model', { exact: true }).selectOption('full')
  await expect(page.getByTestId('model-status')).toHaveText('Analysis running', { timeout: 30_000 })
  await expect(page.getByLabel('People limit')).toHaveValue('6')
  await testInfo.attach('actual-multi-pose-output', { body: JSON.stringify(await proof()), contentType: 'application/json' })
  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('camera-status')).toHaveText('Camera ready')
})
