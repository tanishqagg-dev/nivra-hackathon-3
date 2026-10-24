import { selectMotionRules } from './helpers/motionMode'
import { expect, test, type Page } from '@playwright/test'

async function countScheduledTones(page: Page) {
  await page.addInitScript(() => {
    const testWindow = window as typeof window & { __nivraOscillatorStarts: number }
    testWindow.__nivraOscillatorStarts = 0
    const originalCreate = AudioContext.prototype.createOscillator
    AudioContext.prototype.createOscillator = function () {
      const oscillator = originalCreate.call(this)
      const originalStart = oscillator.start.bind(oscillator)
      oscillator.start = (when?: number) => {
        testWindow.__nivraOscillatorStarts += 1
        originalStart(when)
      }
      return oscillator
    }
  })
}

const scheduledToneCount = (page: Page) => page.evaluate(() =>
  (window as typeof window & { __nivraOscillatorStarts: number }).__nivraOscillatorStarts,
)

test('a watched-item scenario sounds, acknowledges, and alerts again after replay', async ({ page }) => {
  await countScheduledTones(page)

  await page.goto('/')
  await selectMotionRules(page)
  await page.getByRole('button', { name: 'Test scenario', exact: true }).click()
  await page.getByLabel('Scenario', { exact: true }).selectOption('watched')
  await expect(page.getByTestId('review-alert')).toContainText('Watched item moved', { timeout: 15_000 })
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __nivraOscillatorStarts: number }).__nivraOscillatorStarts,
  )).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/nivra-watched-item-alert.png', fullPage: true })

  await page.getByTestId('review-alert').getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByTestId('review-alert')).toBeHidden()
  await expect(page.getByText('Acknowledged', { exact: true }).first()).toBeVisible()

  const oscillatorCount = await page.evaluate(() =>
    (window as typeof window & { __nivraOscillatorStarts: number }).__nivraOscillatorStarts,
  )
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(page.getByTestId('review-alert')).toContainText('Watched item moved', { timeout: 15_000 })
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { __nivraOscillatorStarts: number }).__nivraOscillatorStarts,
  )).toBeGreaterThan(oscillatorCount)

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/nivra-review-mobile.png', fullPage: true })
  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('review-alert')).toBeHidden()
  await expect(page.locator('.demo-canvas')).toBeHidden()
})

test('scripted waving stays quiet and repeated striking produces a review with optional sound', async ({ page }) => {
  await countScheduledTones(page)
  await page.goto('/')
  await selectMotionRules(page)
  await page.getByRole('button', { name: 'Test scenario', exact: true }).click()
  await page.getByTestId('demo-scenario').selectOption('calm')

  // Observe a full negative window, longer than the positive pattern needs.
  await page.waitForTimeout(10_000)
  await expect(page.getByTestId('review-alert')).toBeHidden()
  await expect(page.getByTestId('conflict-status')).toHaveText('No conflict pattern')
  expect(await scheduledToneCount(page)).toBe(0)

  await page.getByTestId('demo-scenario').selectOption('conflict')
  await expect(page.getByTestId('review-alert')).toContainText('Possible physical conflict', { timeout: 15_000 })
  await expect.poll(() => scheduledToneCount(page)).toBeGreaterThan(0)
  await page.screenshot({ path: 'test-results/nivra-conflict-alert.png', fullPage: true })
  await page.getByTestId('review-alert').getByRole('button', { name: 'Acknowledge' }).click()
  await expect(page.getByTestId('review-alert')).toBeHidden()

  await page.locator('label:has(input[data-testid="sound-alerts"])').click()
  await expect(page.getByTestId('sound-alerts')).not.toBeChecked()
  const soundsBeforeReplay = await scheduledToneCount(page)
  await page.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(page.getByTestId('review-alert')).toContainText('Possible physical conflict', { timeout: 15_000 })
  expect(await scheduledToneCount(page)).toBe(soundsBeforeReplay)
  await page.waitForTimeout(4_500)
  await expect(page.getByTestId('conflict-status')).toHaveText('Possible physical conflict')

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/nivra-conflict-mobile.png', fullPage: true })
  await page.getByTestId('conflict-toggle').focus()
  await page.getByTestId('conflict-toggle').press('Space')
  await expect(page.getByTestId('conflict-toggle')).not.toBeChecked()
  await expect(page.getByTestId('conflict-status')).toHaveText('Analysis off')
  await page.getByTestId('stop-camera').click()
  await expect(page.getByTestId('review-alert')).toBeHidden()
  await expect(page.locator('.demo-canvas')).toBeHidden()
})

test('camera permission denial gives an actionable recovery message', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: async () => { throw new DOMException('Permission denied', 'NotAllowedError') },
    })
  })
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', { timeout: 20_000 })
  await page.getByTestId('start-camera').click()
  await expect(page.getByText(/Camera access is blocked\. Allow camera permission/)).toBeVisible()
  await expect(page.getByTestId('start-camera')).toBeEnabled()
  expect(await page.getByTestId('camera-video').evaluate(video => (video as HTMLVideoElement).srcObject)).toBeNull()
})

test('a missing model shows an error and can be retried without reloading the page', async ({ page }) => {
  await page.route('**/models/pose_landmarker_full.task', route => route.fulfill({ status: 503, body: 'Fixture unavailable' }))
  await page.goto('/')
  await selectMotionRules(page)
  await expect(page.getByText(/Local model load failed \(503\)/)).toBeVisible({ timeout: 20_000 })
  await page.unroute('**/models/pose_landmarker_full.task')
  await page.getByRole('button', { name: /retry analysis/i }).click()
  await expect(page.getByTestId('model-status')).toHaveText('Waiting for camera', { timeout: 20_000 })
  await expect(page.getByTestId('start-camera')).toBeEnabled()
})
