// Zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0).
// Exposes the acceptance protocol to coding agents:
//   ui_scan -> agent fixes -> ui_verify -> repeat at most 3 rounds,
//   then escalate the full report to a human instead of burning tokens.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan } from './scan.js';
import { compare } from './compare.js';

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
      },
      required: ['url', 'baseline'],
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

async function callTool(name, args) {
  const results = await scan(toUrl(args.url), {
    viewports: args.viewports,
    actions: args.actions ?? [],
  });
  const reportPath = join(tmpdir(), `ui-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileSync(reportPath, JSON.stringify({ url: args.url, results }, null, 2));

  if (name === 'ui_scan') {
    const { text } = summarize(results);
    return `${text}\nbaseline saved: ${reportPath}`;
  }
  if (name === 'ui_verify') {
    const { readFileSync } = await import('node:fs');
    const baseline = JSON.parse(readFileSync(args.baseline, 'utf8'));
    const { added, fixed, persisting } = compare(baseline.results, results);
    const pass = added.length === 0 && persisting.length === 0;
    const lines = [`VERIFY ${pass ? 'PASS' : 'FAIL'} — ${added.length} new, ${persisting.length} persisting, ${fixed.length} fixed`];
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
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        send({ id, result: { protocolVersion: params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'ui-guard', version: '0.0.2' } } });
      } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        // no response required
      } else if (method === 'ping') {
        send({ id, result: {} });
      } else if (method === 'tools/list') {
        send({ id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        const text = await callTool(params.name, params.arguments ?? {});
        send({ id, result: { content: [{ type: 'text', text }] } });
      } else if (id !== undefined) {
        send({ id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      if (id !== undefined) {
        send({ id, result: { content: [{ type: 'text', text: `ui-guard error: ${err.message}` }], isError: true } });
      }
    }
  });
}
