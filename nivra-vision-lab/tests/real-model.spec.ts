import { selectMotionRules } from './helpers/motionMode'
import { fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

test.afterEach(async ({ page }, testInfo) => {
  const proof = await page.evaluate(() => (window as typeof window & { __nivraModelProof: unknown }).__nivraModelProof)
  const resultPath = testInfo.outputPath('actual-model-results.json')
  await writeFile(resultPath, JSON.stringify(proof, null, 2))
  await testInfo.attach('actual-model-results', { path: resultPath, contentType: 'application/json' })
})

test('actual local models detect a person in a local video clip', async ({ page }) => {
  test.setTimeout(90_000)
  await page.addInitScript(() => {
    const testWindow = window as typeof window & {
      __nivraModelProof: {
        poseFrames: number
        maxPoses: number
        objectFrames: number
        labels: string[]
        bestPersonScore: number
        messages: unknown[]
        delegates: Array<{ task: string; delegate: string }>
      }
    }
    testWindow.__nivraModelProof = { poseFrames: 0, maxPoses: 0, objectFrames: 0, labels: [], bestPersonScore: 0, messages: [], delegates: [] }
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options)
        // Observe the actual worker output; no inference result is replaced.
        this.addEventListener('message', (event) => {
          const result = event.data
          const proof = testWindow.__nivraModelProof
          if (proof.messages.length < 20) proof.messages.push({ direction: 'received', type: result.type, timestamp: result.timestampMs, task: result.task })
          if (result.type === 'ready') proof.delegates.push({ task: result.task, delegate: result.delegate })
          if (result.type === 'pose-result') {
            proof.poseFrames += 1
            proof.maxPoses = Math.max(proof.maxPoses, result.poses.length)
          }
          if (result.type === 'object-result') {
            proof.objectFrames += 1
            for (const object of result.objects) {
              if (!proof.labels.includes(object.label)) proof.labels.push(object.label)
              if (object.label === 'person') proof.bestPersonScore = Math.max(proof.bestPersonScore, object.score)
            }
          }
        })
      }
      postMessage(message: unknown, transfer: Transferable[]) {
        const data = message as { type: string; task?: string; timestampMs?: number }
        const proof = testWindow.__nivraModelProof
        if (proof.messages.length < 20) proof.messages.push({ direction: 'sent', type: data.type, task: data.task, timestamp: data.timestampMs })
        super.postMessage(message, transfer)
      }
    }
  })
  await page.route('**/*', route => {
    const url = new URL(route.request().url())
    return url.hostname === '127.0.0.1' ? route.continue() : route.abort('internetdisconnected')
  })
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', { timeout: 20_000 })
  await page.getByLabel('Open local video').setInputFiles(fileURLToPath(new URL('./fixtures/pose-squats.mp4', import.meta.url)))

  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __nivraModelProof: { maxPoses: number } }).__nivraModelProof.maxPoses,
  ), { timeout: 45_000 }).toBeGreaterThan(0)
  // Object analysis was removed from the UI; the pose model alone proves a person was found.
  await expect.poll(() => page.getByTestId('pose-canvas').evaluate(canvas => {
    const overlay = canvas as HTMLCanvasElement
    const pixels = overlay.getContext('2d')!.getImageData(0, 0, overlay.width, overlay.height).data
    let painted = 0
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) painted += 1
    }
    return painted
  })).toBeGreaterThan(50)
  await page.screenshot({ path: 'test-results/nivra-real-model-person.png', fullPage: true })

  await page.getByTestId('stop-camera').click()
  expect(await page.getByTestId('camera-video').evaluate(video => (video as HTMLVideoElement).getAttribute('src'))).toBeNull()
})
