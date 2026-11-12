import { chromium } from 'playwright';
import { measure } from './measure.js';

// actions: [{ type: 'click' | 'hover', selector: string }]
// Each action produces an additional measurement state, so defects that only
// exist while a drawer/popover is open are covered.
export async function scan(url, {
  viewports = [375, 768, 1280],
  height = 900,
  timeout = 30000,
  settleMs = 300,
  actions = [],
  screenshotDir = null,
  channel = process.env.UI_GUARD_CHANNEL,
} = {}) {
  const browser = await chromium.launch({ channel: channel || undefined });
  const results = [];
  try {
    for (const width of viewports) {
      const page = await browser.newPage({ viewport: { width, height } });
      const states = [{ name: 'baseline' }, ...actions.map((a) => ({ name: `${a.type}:${a.selector}`, action: a }))];
      try {
        await page.goto(url, { waitUntil: 'load', timeout });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(settleMs);
        for (const state of states) {
          try {
            if (state.action) {
              // Each interactive state starts from a clean page: earlier actions
              // (e.g. an open drawer) must not pollute later measurements.
              await page.reload({ waitUntil: 'load' });
              await page.waitForTimeout(settleMs);
              await page[state.action.type](state.action.selector, { timeout: 5000 });
              await page.waitForTimeout(settleMs);
            }
            const findings = await page.evaluate(measure);
            const result = { viewport: width, state: state.name, findings };
            if (screenshotDir) {
              const { mkdirSync } = await import('node:fs');
              const { join } = await import('node:path');
              mkdirSync(screenshotDir, { recursive: true });
              const safe = state.name.replace(/[^a-z0-9]+/gi, '_');
              result.screenshot = join(screenshotDir, `${width}-${safe}.png`);
              await page.screenshot({ path: result.screenshot, fullPage: true });
            }
            results.push(result);
          } catch (err) {
            results.push({ viewport: width, state: state.name, findings: [], error: err.message.split('\n')[0] });
            break; // later states are unreliable after a failed action
          }
        }
      } catch (err) {
        results.push({ viewport: width, state: 'baseline', findings: [], error: `navigation failed: ${err.message.split('\n')[0]}` });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}
