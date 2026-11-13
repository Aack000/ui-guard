import { chromium } from 'playwright';
import { measure } from './measure.js';

// actions: [{ type: 'click' | 'hover', selector: string }]
// Each action produces an additional measurement state, so defects that only
// exist while a drawer/popover is open are covered.
//
// waitForStartupOverlay: pages with a full-screen intro animation would otherwise
// be measured while the overlay is still up (an empty "pass"). When enabled, the
// scanner waits up to 8s for a viewport-sized [aria-modal] overlay to disappear
// before measuring. Set false when you explicitly want to inspect the animation.
//
// perf: sample rAF frame rate and long tasks once (first viewport, baseline) and
// emit P1 warnings. Adds ~1.2s per scan.
export async function scan(url, {
  viewports = [375, 768, 1280],
  height = 900,
  timeout = 30000,
  settleMs = 300,
  actions = [],
  screenshotDir = null,
  waitForStartupOverlay = true,
  perf = false,
  channel = process.env.UI_GUARD_CHANNEL,
  signal = null,
} = {}) {
  if (signal?.aborted) throw abortError();
  const browser = await chromium.launch({ channel: channel || undefined });
  // Cancellation (MCP notifications/cancelled) closes the browser so pending
  // navigation/measure work rejects instead of running to completion.
  const onAbort = () => { browser.close().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const results = [];
  try {
    for (const width of viewports) {
      if (signal?.aborted) throw abortError();
      const page = await browser.newPage({ viewport: { width, height } });
      const states = [{ name: 'baseline' }, ...actions.map((a) => ({ name: `${a.type}:${a.selector}`, action: a }))];
      try {
        await page.goto(url, { waitUntil: 'load', timeout });
        if (waitForStartupOverlay) await waitStartupOverlay(page);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(settleMs);
        for (const state of states) {
          if (signal?.aborted) throw abortError();
          try {
            if (state.action) {
              // Each interactive state starts from a clean page: earlier actions
              // (e.g. an open drawer) must not pollute later measurements.
              await page.reload({ waitUntil: 'load' });
              if (waitForStartupOverlay) await waitStartupOverlay(page);
              await page.waitForTimeout(settleMs);
              await page[state.action.type](state.action.selector, { timeout: 5000 });
              await page.waitForTimeout(settleMs);
            }
            const findings = await page.evaluate(measure);
            const result = { viewport: width, state: state.name, findings };
            if (perf && width === viewports[0] && state.name === 'baseline') {
              const stats = await samplePerf(page);
              result.perf = stats;
              findings.push(...perfFindings(stats));
            }
            if (screenshotDir) {
              const { mkdirSync } = await import('node:fs');
              const { join } = await import('node:path');
              mkdirSync(screenshotDir, { recursive: true });
              const safe = state.name.replace(/[^a-z0-9]+/gi, '_');
              result.screenshot = join(screenshotDir, `${width}-${safe}.png`);
              await page.screenshot({ path: result.screenshot, fullPage: true });
              // fullPage captures paint fixed layers (intro/backdrop) only once,
              // which misleads manual review; keep a viewport-accurate copy too.
              result.viewportScreenshot = join(screenshotDir, `${width}-${safe}-viewport.png`);
              await page.screenshot({ path: result.viewportScreenshot, fullPage: false });
            }
            results.push(result);
          } catch (err) {
            if (signal?.aborted) throw abortError();
            results.push({ viewport: width, state: state.name, findings: [], error: err.message.split('\n')[0] });
            break; // later states are unreliable after a failed action
          }
        }
      } catch (err) {
        results.push({ viewport: width, state: 'baseline', findings: [], error: `navigation failed: ${err.message.split('\n')[0]}` });
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await browser.close().catch(() => {});
  }
  if (signal?.aborted) throw abortError();
  return results;
}

function abortError() {
  const err = new Error('scan aborted');
  err.name = 'AbortError';
  return err;
}

/** 全屏启动遮罩（开场动画）消失后再测量；普通页立即返回。 */
async function waitStartupOverlay(page) {
  await page.waitForFunction(() => {
    const overlays = [...document.querySelectorAll('[aria-modal="true"]')];
    return !overlays.some((el) => {
      const r = el.getBoundingClientRect();
      return r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9;
    });
  }, { timeout: 8000 }).catch(() => { /* 遮罩不消失就按当前状态测，由使用者决定 */ });
}

function samplePerf(page) {
  return page.evaluate(() => new Promise((resolve) => {
    const longTasks = [];
    let observer;
    try {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) longTasks.push(Math.round(entry.duration));
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch { /* longtask unsupported */ }
    let frames = 0;
    const start = performance.now();
    const tick = (t) => {
      frames++;
      if (t - start < 1200) {
        requestAnimationFrame(tick);
      } else {
        const seconds = (t - start) / 1000;
        if (observer) observer.disconnect();
        resolve({
          fps: Math.round((frames / seconds) * 10) / 10,
          longTasks: longTasks.length,
          maxLongTaskMs: longTasks.length ? Math.max(...longTasks) : 0,
        });
      }
    };
    requestAnimationFrame(tick);
  }));
}

function perfFindings(stats) {
  const out = [];
  if (stats.fps < 45) {
    out.push({ rule: 'P1', severity: 'warn', selector: 'document', message: `low frame rate: ${stats.fps}fps`, rect: null });
  }
  if (stats.longTasks >= 3 || stats.maxLongTaskMs >= 150) {
    out.push({ rule: 'P1', severity: 'warn', selector: 'document', message: `main-thread stalls: ${stats.longTasks} long tasks, max ${stats.maxLongTaskMs}ms`, rect: null });
  }
  return out;
}
