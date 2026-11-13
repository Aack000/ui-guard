// Zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0).
// Exposes the acceptance protocol to coding agents:
//   ui_scan -> agent fixes -> ui_verify -> repeat at most 3 rounds,
//   then escalate the full report to a human instead of burning tokens.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan } from './scan.js';
import { compare } from './compare.js';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const PROTOCOL = [
  'Acceptance protocol: (1) ui_scan the page after UI work; (2) fix reported hard errors;',
  '(3) ui_verify against the saved baseline to prove fixes without regressions;',
  '(4) repeat at most 3 rounds — if hard errors persist, stop and hand the full report to a human.',
].join(' ');

const ACTIONS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['click', 'hover'] },
      selector: { type: 'string', description: 'Playwright selector, e.g. "#btn" or "text=登录"' },
    },
    required: ['type', 'selector'],
  },
  description: 'Interactions to open drawers/popovers; each is measured as an independent state from a fresh page load.',
};

const TOOLS = [
  {
    name: 'ui_scan',
    description: `Deterministic layout acceptance scan (overflow, clipped text, off-viewport overlays, covered/overlapping buttons). ${PROTOCOL}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL or absolute file path of the page' },
        viewports: { type: 'array', items: { type: 'number' }, description: 'Viewport widths, default [375,768,1280]' },
        actions: ACTIONS_SCHEMA,
        perf: { type: 'boolean', description: 'Sample FPS and long tasks once (adds ~1.2s); emits P1 warnings' },
        waitForStartupOverlay: { type: 'boolean', description: 'Wait up to 8s for a full-screen boot overlay to disappear (default true)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ui_verify',
    description: `Regression check against a previous ui_scan baseline. Returns only the delta (new/persisting/fixed) to keep context small. ${PROTOCOL}`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        baseline: { type: 'string', description: 'Baseline report path returned by ui_scan' },
        viewports: { type: 'array', items: { type: 'number' } },
        actions: ACTIONS_SCHEMA,
        perf: { type: 'boolean', description: 'Sample FPS and long tasks once (adds ~1.2s); emits P1 warnings' },
        waitForStartupOverlay: { type: 'boolean' },
      },
      required: ['url', 'baseline'],
    },
  },
  {
    name: 'ui_probe',
    description: 'Evidence-only layout probe for agents. Returns candidate regions, DOM evidence, confidence and suggested checks. It never returns pass/fail: the agent must verify and decide.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL or absolute file path of the page' },
        viewports: { type: 'array', items: { type: 'number' } },
        actions: ACTIONS_SCHEMA,
        waitForStartupOverlay: { type: 'boolean' },
      },
      required: ['url'],
    },
  },
];

function toUrl(raw) {
  return /^[a-z]+:\/\//i.test(raw) ? raw : pathToFileURL(raw).href;
}

function summarize(results) {
  const lines = [];
  let errors = 0;
  let warns = 0;
  for (const r of results) {
    const errs = r.findings.filter((f) => f.severity === 'error');
    const wrns = r.findings.filter((f) => f.severity === 'warn');
    errors += errs.length;
    warns += wrns.length;
    const tag = r.error || errs.length > 0 ? 'FAIL' : 'PASS';
    lines.push(`[${tag}] ${r.viewport}px ${r.state ?? 'baseline'} — ${errs.length} errors, ${wrns.length} warnings${r.error ? ` (${r.error})` : ''}`);
    for (const f of r.findings) {
      lines.push(`  ${f.severity === 'error' ? 'x' : '!'} ${f.rule} ${f.selector}: ${f.message}`);
    }
  }
  lines.unshift(`${errors} hard errors, ${warns} warnings`);
  return { text: lines.join('\n'), errors, warns };
}

async function callTool(name, args, signal = null) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    const err = new Error(`unknown tool: ${name}`);
    err.code = 'METHOD_NOT_FOUND';
    throw err;
  }
  for (const key of tool.inputSchema.required || []) {
    if (!args || typeof args[key] !== 'string' || !args[key].trim()) {
      const err = new Error(`missing or invalid required argument: ${key}`);
      err.code = 'INVALID_PARAMS';
      throw err;
    }
  }
  if (signal?.aborted) {
    const err = new Error('scan aborted');
    err.name = 'AbortError';
    throw err;
  }
  if (args.actions !== undefined) {
    if (!Array.isArray(args.actions)) {
      const err = new Error('actions must be an array');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
    for (const a of args.actions) {
      if (!a || (a.type !== 'click' && a.type !== 'hover') || typeof a.selector !== 'string' || !a.selector.trim()) {
        const err = new Error('actions entries require type click|hover and a selector');
        err.code = 'INVALID_PARAMS';
        throw err;
      }
    }
  }
  if (args.viewports !== undefined) {
    if (!Array.isArray(args.viewports) || args.viewports.some((v) => !Number.isInteger(v) || v <= 0)) {
      const err = new Error('viewports must be positive integers');
      err.code = 'INVALID_PARAMS';
      throw err;
    }
  }

  const results = await scan(toUrl(args.url), {
    viewports: Array.isArray(args.viewports) && args.viewports.length ? args.viewports : undefined,
    actions: args.actions ?? [],
    perf: args.perf === true,
    waitForStartupOverlay: args.waitForStartupOverlay !== false,
    signal,
  });
  if (signal?.aborted) {
    const err = new Error('scan aborted');
    err.name = 'AbortError';
    throw err;
  }
  const reportPath = join(tmpdir(), `ui-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(reportPath, JSON.stringify({ url: args.url, results }, null, 2));

  if (name === 'ui_probe') {
    const suggest = {
      H1: 'inspect html/body overflow and the widest in-flow element',
      H1c: 'compare scrollWidth/clientWidth with the nearest overflow-x ancestor',
      H2: 'compare scrollHeight/clientHeight and line-clamp',
      H3: 'check the fixed overlay bounds against the viewport',
      H4: 'use elementsFromPoint at the reported control points',
      'H4-partial': 'use elementsFromPoint; check fixed/sticky overlays',
      H5: 'compare interactive rect intersections',
      S1: 'check whether the font face actually loaded',
      S2: 'compare button centers only within the same visual row',
      S3: 'check text rect overlaps, ignoring fixed/sticky overlays',
      S4: 'check writing-mode and available width vs font size',
      S5: 'recompute contrast on the solid background',
      S6: 'check title/aria-label on the ellipsized element',
      S7: 'measure the target size and label association',
      S8: 'compare scroll-margin-top with the sticky header height',
      P1: 're-run the perf sample',
    };
    const evidenceByRule = {
      H1: ['documentElement.scrollWidth', 'clientWidth'],
      H1c: ['scrollWidth', 'clientWidth', 'computed overflow-x'],
      H2: ['scrollHeight', 'clientHeight', 'line-clamp'],
      H3: ['fixed rect', 'viewport rect'],
      H4: ['elementsFromPoint'],
      'H4-partial': ['elementsFromPoint'],
      H5: ['interactive rects'],
      S1: ['document.fonts'],
      S2: ['button rects', 'visual row grouping'],
      S3: ['text rects'],
      S4: ['writing-mode', 'clientWidth', 'font-size'],
      S5: ['computed color', 'background color'],
      S6: ['scrollWidth', 'clientWidth', 'title/aria-label'],
      S7: ['target rect', 'label rect'],
      S8: ['target rect', 'sticky header rect'],
      P1: ['requestAnimationFrame', 'longtask entries'],
    };
    const safeSelector = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
    const candidates = results.flatMap((r) => r.findings.map((f) => ({
      viewport: r.viewport,
      state: r.state ?? 'baseline',
      kind: f.rule,
      engineSeverity: f.severity,
      selector: safeSelector(f.selector),
      bbox: f.rect,
      count: f.count ?? null,
      message: f.message,
      evidence: evidenceByRule[f.rule] || [],
      requiresVerification: true,
      suggestedCheck: suggest[f.rule] || 'verify in the DOM and screenshot',
    })));
    return JSON.stringify({
      tool: 'ui_probe',
      schemaVersion: 1,
      note: 'Evidence only. Verify each candidate in the DOM/screenshot; engineSeverity is not a verdict and confidence is intentionally omitted.',
      url: args.url,
      viewports: results.map((r) => r.viewport),
      measured: results.map((r) => ({ viewport: r.viewport, state: r.state ?? 'baseline', error: r.error || null })),
      candidates,
      abstain: results.some((r) => r.error),
      limitations: results.filter((r) => r.error).map((r) => `@${r.viewport} ${r.state}: ${r.error}`),
      reportPath,
    });
  }
  if (name === 'ui_scan') {
    const { text } = summarize(results);
    return `${text}\nbaseline saved: ${reportPath}`;
  }
  if (name === 'ui_verify') {
    const { readFileSync, realpathSync, statSync } = await import('node:fs');
    const real = realpathSync(args.baseline);
    if (!real.toLowerCase().startsWith(tmpdir().toLowerCase()) || !/ui-guard-.*\.json$/i.test(real)) {
      throw new Error('baseline must be a ui-guard report inside the system temp directory');
    }
    if (statSync(real).size > 20 * 1024 * 1024) throw new Error('baseline is too large');
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(real, 'utf8'));
    } catch {
      throw new Error('baseline is not a valid ui-guard report');
    }
    if (!baseline.url) throw new Error('baseline has no url');
    if (toUrl(baseline.url) !== toUrl(args.url)) {
      throw new Error(`baseline url mismatch: ${baseline.url} vs ${args.url}`);
    }
    const { added, fixed, persisting, skipped } = compare(baseline.results, results);
    const scanError = results.find((r) => r.error);
    const pass = !scanError && added.length === 0 && persisting.length === 0 && skipped.length === 0;
    const lines = [`VERIFY ${pass ? 'PASS' : 'FAIL'} — ${added.length} new, ${persisting.length} persisting, ${fixed.length} fixed, ${skipped.length} skipped`];
    if (scanError) lines.push(`  x scan failed @${scanError.viewport}px ${scanError.state}: ${scanError.error}`);
    for (const scope of skipped) lines.push(`  ! unmeasured: ${scope}`);
    for (const f of [...added, ...persisting]) {
      lines.push(`  x ${f.rule} @${f.viewport}px ${f.state} ${f.selector}: ${f.message}`);
    }
    if (!pass) lines.push('If this is round 3 or later, stop fixing and hand the full report to a human.');
    lines.push(`current report: ${reportPath}`);
    return lines.join('\n');
  }
  throw new Error(`unknown tool: ${name}`);
}

export function serveMcp() {
  const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');
  const rl = createInterface({ input: process.stdin });
  // Serial queue: concurrent tools/call must not spawn unbounded Chromium runs.
  const activeCalls = new Map();
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        send({ id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ui-guard', version: PKG.version } } });
      } else if (method === 'notifications/initialized') {
        // no response required
      } else if (method === 'notifications/cancelled') {
        const target = activeCalls.get(params?.requestId);
        if (target) target.abort();
      } else if (method === 'ping') {
        send({ id, result: {} });
      } else if (method === 'tools/list') {
        send({ id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const controller = new AbortController();
        activeCalls.set(id, controller);
        try {
          const text = await enqueue(() => callTool(params.name, params.arguments ?? {}, controller.signal));
          send({ id, result: { content: [{ type: 'text', text }] } });
        } finally {
          activeCalls.delete(id);
        }
      } else if (id !== undefined) {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (id !== undefined) {
        if (err.code === 'INVALID_PARAMS') {
          send({ id, error: { code: -32602, message: err.message } });
        } else if (err.code === 'METHOD_NOT_FOUND') {
          send({ id, error: { code: -32601, message: err.message } });
        } else if (msg.params?.name === 'ui_probe') {
          // Keep the probe contract JSON even when measurement itself fails.
          send({
            id,
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  tool: 'ui_probe',
                  schemaVersion: 1,
                  abstain: true,
                  candidates: [],
                  measured: [],
                  limitations: [err.message],
                }),
              }],
              isError: true,
            },
          });
        } else {
          send({ id, result: { content: [{ type: 'text', text: `ui-guard error: ${err.message}` }], isError: true } });
        }
      }
    }
  });
}
