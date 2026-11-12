import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scan } from '../src/scan.js';
import { compare } from '../src/compare.js';

const fixtures = JSON.parse(readFileSync(new URL('./fixtures.expect.json', import.meta.url), 'utf8'));
let failed = 0;
let checks = 0;

function check(pass, label, details) {
  checks++;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${label}`);
  if (!pass) {
    failed++;
    if (details) console.log(details);
  }
}

for (const [file, exp] of Object.entries(fixtures)) {
  const url = pathToFileURL(resolve('fixtures', file)).href;
  const viewports = Object.keys(exp.errorsAt).map(Number);
  const results = await scan(url, { viewports, actions: exp.actions ?? [], perf: Boolean(exp.perf) });
  for (const r of results) {
    if (r.error) {
      check(false, `${file} @${r.viewport} ${r.state}: ${r.error}`);
      continue;
    }
    const spec = exp.errorsAt[String(r.viewport)];
    const expected = [...(Array.isArray(spec) ? spec : spec?.[r.state] ?? [])].sort();
    const actual = [...new Set(r.findings.filter((f) => f.severity === 'error').map((f) => f.rule))].sort();
    const warns = r.findings.filter((f) => f.severity === 'warn');
    check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${file} @${r.viewport}px ${r.state}  errors=[${actual}] expected=[${expected}]  warns=[${warns.map((w) => w.rule)}]`,
      r.findings.map((f) => `      ${f.severity} ${f.rule} ${f.selector}: ${f.message}`).join('\n')
    );
    if (exp.warns) {
      for (const w of exp.warns) {
        check(warns.some((x) => x.rule === w), `${file} @${r.viewport} ${r.state}: expected warning ${w}`);
      }
    }
  }
}

// ---- verify / regression comparison ----
const popoverUrl = pathToFileURL(resolve('fixtures', 'broken-popover.html')).href;
const okUrl = pathToFileURL(resolve('fixtures', 'ok.html')).href;
const base = await scan(popoverUrl, { viewports: [375] });
const same = await scan(popoverUrl, { viewports: [375] });
const clean = await scan(okUrl, { viewports: [375] });

const d1 = compare(base, same);
check(
  d1.added.length === 0 && d1.persisting.length === 1 && d1.fixed.length === 0,
  `verify same page: ${d1.added.length} new, ${d1.persisting.length} persisting, ${d1.fixed.length} fixed (expect 0/1/0)`
);

const d2 = compare(base, clean);
check(
  d2.added.length === 0 && d2.persisting.length === 0 && d2.fixed.length === 1,
  `verify fixed page: ${d2.added.length} new, ${d2.persisting.length} persisting, ${d2.fixed.length} fixed (expect 0/0/1)`
);

const d3 = compare(clean, base);
check(
  d3.added.length === 1 && d3.persisting.length === 0 && d3.fixed.length === 0,
  `verify regressed page: ${d3.added.length} new, ${d3.persisting.length} persisting, ${d3.fixed.length} fixed (expect 1/0/0)`
);

console.log(`\n${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
