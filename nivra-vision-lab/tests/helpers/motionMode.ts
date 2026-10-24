import type { Page } from '@playwright/test'

/** MediaPipe motion rules are the only detector now. Kept so older specs read the same. */
export async function selectMotionRules(page: Page) {
  await page.getByText('Detection settings', { exact: true }).click()
  await page.getByLabel('Detection sensitivity').waitFor()
  await page.getByText('Detection settings', { exact: true }).click()
}
