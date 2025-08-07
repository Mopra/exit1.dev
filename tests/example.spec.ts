import { test, expect } from '@playwright/test';

test('homepage loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/exit1\.dev/);
});

test('navigation works', async ({ page }) => {
  await page.goto('/');
  // Add navigation tests based on your app structure
});
