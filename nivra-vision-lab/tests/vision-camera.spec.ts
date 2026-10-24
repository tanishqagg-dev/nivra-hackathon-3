import { selectMotionRules } from './helpers/motionMode'
import { expect, test, type Page } from '@playwright/test'

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

test('opens a synthetic camera and releases it when stopped', async ({ page }) => {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname === '127.0.0.1') {
      await route.continue()
      return
    }

    await route.abort('internetdisconnected')
  })

  await page.goto('/')
  await selectMotionRules(page)

  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('sound-alerts')).toBeChecked()
  await page.getByTestId('start-camera').click()
  await expect(page.getByTestId('camera-status')).toContainText('Camera live')
  await expect(page.getByTestId('runtime-delegate')).toHaveText(/GPU|CPU/)
  await expect(page.getByTestId('processed-fps')).not.toHaveText('-', { timeout: 20_000 })
  await page.waitForTimeout(3_000)
  const processedFps = Number(await page.getByTestId('processed-fps').textContent())
  expect(processedFps).toBeGreaterThan(0)
  await page.locator('label:has(input[data-testid="sound-alerts"])').click()
  await expect(page.getByTestId('sound-alerts')).not.toBeChecked()
  await page.locator('label:has(input[data-testid="sound-alerts"])').click()
  await expect(page.getByTestId('sound-alerts')).toBeChecked()

  const videoDimensions = await page.getByTestId('camera-video').evaluate((video) => {
    const element = video as HTMLVideoElement
    return { width: element.videoWidth, height: element.videoHeight }
  })
  expect(videoDimensions.width).toBeGreaterThan(0)
  expect(videoDimensions.height).toBeGreaterThan(0)

  const videoBox = await page.getByTestId('camera-video').boundingBox()
  const canvasBox = await page.getByTestId('pose-canvas').boundingBox()
  expect(canvasBox?.width).toBeCloseTo(videoBox?.width ?? 0, 0)
  expect(canvasBox?.height).toBeCloseTo(videoBox?.height ?? 0, 0)
  // The status rail stays hidden until an alert; open it to inspect live diagnostics.
  if (await page.getByRole('button', { name: /^Alerts/ }).getAttribute('aria-pressed') !== 'true') await page.getByRole('button', { name: /^Alerts/ }).click()
  await expect(page.getByTestId('conflict-status')).toBeVisible()
  await expect(page.getByTestId('objects-visible')).toBeHidden()

  await page.getByTestId('camera-video').evaluate((video) => {
    const testWindow = window as typeof window & { __nivraTestStream?: MediaStream }
    testWindow.__nivraTestStream = (video as HTMLVideoElement).srcObject as MediaStream
  })
  await page.screenshot({ path: 'test-results/nivra-camera-live.png', fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileVideoBox = await page.getByTestId('camera-video').boundingBox()
  const mobileCanvasBox = await page.getByTestId('pose-canvas').boundingBox()
  expect(mobileCanvasBox?.width).toBeCloseTo(mobileVideoBox?.width ?? 0, 0)
  expect(mobileCanvasBox?.height).toBeCloseTo(mobileVideoBox?.height ?? 0, 0)
  await expectNoHorizontalOverflow(page)
  await page.screenshot({ path: 'test-results/nivra-camera-mobile.png', fullPage: true })

  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('camera-status')).toContainText('Camera ready')

  const shutdownState = await page.getByTestId('camera-video').evaluate((video) => {
    const testWindow = window as typeof window & { __nivraTestStream?: MediaStream }
    return {
      detached: (video as HTMLVideoElement).srcObject === null,
      tracksEnded:
        testWindow.__nivraTestStream?.getTracks().every((track) => track.readyState === 'ended') ??
        false,
    }
  })
  expect(shutdownState).toEqual({ detached: true, tracksEnded: true })

  // Reopening must create one fresh stream and release it on every stop.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.getByTestId('start-camera').click()
    await expect(page.getByTestId('camera-status')).toContainText('Camera live')
    await page.getByTestId('camera-video').evaluate((video) => {
      const testWindow = window as typeof window & { __nivraTestStream?: MediaStream }
      testWindow.__nivraTestStream = (video as HTMLVideoElement).srcObject as MediaStream
    })
    await page.getByTestId('stop-camera').click()
    await expect(page.getByTestId('camera-status')).toContainText('Camera ready')
    expect(await page.evaluate(() => {
      const testWindow = window as typeof window & { __nivraTestStream?: MediaStream }
      return testWindow.__nivraTestStream?.getTracks().every(track => track.readyState === 'ended')
    })).toBe(true)
  }
})
