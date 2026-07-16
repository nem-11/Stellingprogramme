import { test, expect } from '@playwright/test';
import { loginAs, hasApiError } from './helpers/auth.js';

test.describe('Dashboard: Loads for all roles', () => {
  for (const role of ['admin', 'site', 'board']) {
    test(`${role} dashboard loads without API error`, async ({ page }) => {
      await loginAs(page, role);
      await page.waitForTimeout(1500);
      expect(await hasApiError(page)).toBe(false);
    });
  }
});

test.describe('Dashboard: Milestones', () => {
  test('Milestones section present', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.waitForTimeout(1500);
    const body = await page.textContent('body');
    expect(body).toContain('Milestone');
  });
});

test.describe('3-Week Look-ahead', () => {
  test('Look-ahead loads without error', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.click('button:has-text("▶Ahead")');
    await page.waitForTimeout(1500);
    expect(await hasApiError(page)).toBe(false);
  });
});

test.describe('Daily Update', () => {
  test('Update view loads for admin', async ({ page }) => {
    await loginAs(page, 'admin');
    await page.click('button:has-text("✓Update")');
    await page.waitForTimeout(1500);
    expect(await hasApiError(page)).toBe(false);
  });

  test('site team has no Update nav', async ({ page }) => {
    await loginAs(page, 'site');
    await page.waitForTimeout(1000);
    await expect(page.locator('button:has-text("✓Update")')).not.toBeVisible();
    await expect(page.locator('button:has-text("◎Programme")')).not.toBeVisible();
  });
});
