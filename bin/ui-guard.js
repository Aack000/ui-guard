#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan } from '../src/scan.js';
import { compare } from '../src/compare.js';
import { serveMcp } from '../src/mcp.js';

const USAGE = `ui-guard — deterministic layout acceptance checks

usage:
  ui-guard scan   --url <url-or-file> [--viewports 375,768,1280]
                  [--actions "click:#btn;hover:.tip"] [--out report.json] [--json]
  ui-guard verify --url <url-or-file> --baseline report.json
                  [--viewports ...] [--actions ...] [--out report.json]
  ui-guard mcp    (stdio MCP server exposing ui_scan / ui_verify)

scan:   exit 0 = no hard errors, 1 = hard errors found
verify: exit 0 = no new or persisting hard errors, 1 = otherwise
        prints only the delta (new / persisting / fixed) to keep agent context small
bad usage: exit 2`;

function parseArgs(argv) {
  const opts = { command: 'scan', viewports: [375, 768, 1280], actions: [] };
  const rest = [...argv];
  if (rest[0] === 'scan' || rest[0] === 'verify' || rest[0] === 'mcp') opts.command = rest.shift();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--url') {
      const value = rest[++i];
      if (!value) { console.error('--url requires a value'); process.exit(2); }
      opts.url = value;
    }
    else if (arg === '--viewports') {
      const value = rest[++i];
      if (!value || !/^\d+(,\d+)*$/.test(value)) {
        console.error('--viewports must be comma-separated numbers (e.g. 375,768,1280)');
        process.exit(2);
      }
      opts.viewports = value.split(',').map(Number);
    }
    else if (arg === '--out') {
      const value = rest[++i];
      if (!value) { console.error('--out requires a value'); process.exit(2); }
      opts.out = value;
    }
    else if (arg === '--baseline') {
      const value = rest[++i];
      if (!value) { console.error('--baseline requires a value'); process.exit(2); }
      opts.baseline = value;
    }
    else if (arg === '--json') opts.json = true;
    else if (arg === '--perf') opts.perf = true;
    else if (arg === '--no-wait-overlay') opts.waitForStartupOverlay = false;
    else if (arg === '--actions') {
      const value = rest[++i];
      if (!value) { console.error('--actions requires a value'); process.exit(2); }
      opts.actions = value.split(';').filter(Boolean).map((s) => {
        const idx = s.indexOf(':');
        return { type: s.slice(0, idx), selector: s.slice(idx + 1) };
      });
      for (const a of opts.actions) {
        if (a.type !== 'click' && a.type !== 'hover') {
          console.error(`unsupported action type: ${a.type} (use click|hover)`);
          process.exit(2);
        }
      }
    } else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

function toUrl(raw) {
  return /^[a-z]+:\/\//i.test(raw) ? raw : pathToFileURL(resolve(raw)).href;
}

function printFindings(results) {
  for (const r of results) {
    const errs = r.findings.filter((f) => f.severity === 'error');
    const wrns = r.findings.filter((f) => f.severity === 'warn');
    const tag = r.error || errs.length > 0 ? 'FAIL' : 'PASS';
    console.log(`[${tag}] viewport ${r.viewport}px state ${r.state ?? 'baseline'} — ${errs.length} errors, ${wrns.length} warnings${r.error ? ` (${r.error})` : ''}`);
    for (const f of r.findings) {
      console.log(`  ${f.severity === 'error' ? 'x' : '!'} ${f.rule} ${f.selector}: ${f.message}`);
    }
  }
}

async function run(opts) {
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!opts.url || (opts.command === 'verify' && !opts.baseline)) {
    console.log(USAGE);
    process.exit(2);
  }

  const url = toUrl(opts.url);
  const results = await scan(url, {
    viewports: opts.viewports,
    actions: opts.actions,
    perf: Boolean(opts.perf),
    waitForStartupOverlay: opts.waitForStartupOverlay !== false,
  });
  if (opts.out) {
    try {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, JSON.stringify({ url, results }, null, 2));
    } catch (err) {
      console.error(`cannot write report ${opts.out}: ${err.message}`);
      process.exit(2);
    }
  }

  if (opts.command === 'verify') {
    let baseline;
    try {
      baseline = JSON.parse(readFileSync(opts.baseline, 'utf8'));
    } catch (err) {
      console.error(`cannot read baseline ${opts.baseline}: ${err.message}`);
      process.exit(2);
    }
    const { added, fixed, persisting, skipped } = compare(baseline.results, results);
    const scanError = results.find((r) => r.error);
    const pass = !scanError && added.length === 0 && persisting.length === 0 && skipped.length === 0;
    console.log(`VERIFY ${pass ? 'PASS' : 'FAIL'} — ${added.length} new, ${persisting.length} persisting, ${fixed.length} fixed, ${skipped.length} skipped`);
    if (scanError) {
      console.log(`  x scan failed @${scanError.viewport}px ${scanError.state}: ${scanError.error}`);
    }
    for (const scope of skipped) console.log(`  ! unmeasured: ${scope} (baseline had results)`);
    for (const f of [...added, ...persisting]) {
      console.log(`  x ${f.rule} @${f.viewport}px ${f.state} ${f.selector}: ${f.message}`);
    }
    process.exit(pass ? 0 : 1);
  }

  if (opts.json) {
    console.log(JSON.stringify({ url, results }, null, 2));
  } else {
    printFindings(results);
    const errors = results.flatMap((r) => r.findings.filter((f) => f.severity === 'error'));
    const warns = results.flatMap((r) => r.findings.filter((f) => f.severity === 'warn'));
    console.log(`\n${errors.length} hard errors, ${warns.length} warnings${opts.out ? ` — full report: ${opts.out}` : ''}`);
  }
  process.exit(results.some((r) => r.error || r.findings.some((f) => f.severity === 'error')) ? 1 : 0);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.command === 'mcp') {
  serveMcp();
} else {
  try {
    await run(opts);
  } catch (err) {
    console.error(`ui-guard: ${err.message}`);
    process.exit(2);
  }
}
