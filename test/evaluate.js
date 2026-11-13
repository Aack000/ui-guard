// Evaluate labeled findings against the latest raw scans.
// Real labels are a regression set; synthetic labels are a construction check.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const readJsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const real = readJsonl('datasets/labels.jsonl');
const synthetic = readJsonl('datasets/labels-synthetic.jsonl');
const labels = [...real, ...synthetic];
const evidence = JSON.parse(readFileSync('datasets/evidence.json', 'utf8'));

const raw = [];
const scopes = new Set();
const erroredScopes = new Set();
const scopeFindingCount = new Map();
for (const name of readdirSync('datasets/raw')) {
  if (!name.endsWith('.json')) continue;
  const data = JSON.parse(readFileSync(`datasets/raw/${name}`, 'utf8'));
  for (const r of data.results || []) {
    const viewport = Number(r.viewport ?? r.width);
    const state = r.state ?? r.name ?? 'baseline';
    const scope = `${data.source}|${viewport}|${state}`;
    scopes.add(scope);
    if (r.error) erroredScopes.add(scope);
    scopeFindingCount.set(scope, (scopeFindingCount.get(scope) || 0) + (r.findings?.length || 0));
    for (const f of r.findings || []) raw.push({ file: name, source: data.source, viewport, state, rule: f.rule, selector: f.selector, used: false });
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const segmentParts = (segment) => {
  const s = segment.trim();
  const tag = (s.match(/^([a-zA-Z][\w-]*|\*)/) || [])[1]?.toLowerCase() || '';
  const id = (s.match(/#([\w-]+)/) || [])[1] || '';
  const classes = new Set([...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
  return { tag, id, classes };
};
// Label selectors are allowed to be a shortened suffix of the raw selector,
// but every segment must match on tag/id/classes exactly. Never substring.
function selectorMatches(rawSel, labelSel) {
  const r = norm(rawSel).split(/\s*>\s*/);
  const l = norm(labelSel).split(/\s*>\s*/);
  if (l.length > r.length) return false;
  const rs = r.slice(-l.length);
  for (let i = 0; i < l.length; i++) {
    const a = segmentParts(rs[i]);
    const b = segmentParts(l[i]);
    if (b.tag && a.tag !== b.tag) return false;
    if (b.id && a.id !== b.id) return false;
    for (const cls of b.classes) if (!a.classes.has(cls)) return false;
  }
  return true;
}

const match = (label) => {
  const hit = raw.find((r) =>
    !r.used
    && r.source === label.source
    && r.viewport === Number(label.viewport)
    && r.state === label.state
    && r.rule === label.rule
    && selectorMatches(r.selector, label.selector)
  );
  if (hit) hit.used = true;
  return hit;
};

const empty = () => ({ tp: 0, fn: 0, fp: 0, tn: 0 });
const byRule = {};
const totals = { real: empty(), synthetic: empty() };
const uncovered = [];
const unmeasured = [];
const stale = [];
const unverifiedNegatives = [];
const falseNegatives = [];
const falsePositives = [];
for (const label of labels) {
  const group = label.synthetic ? 'synthetic' : 'real';
  if (label.stale) {
    stale.push(label);
    continue;
  }
  const scope = `${label.source}|${Number(label.viewport)}|${label.state}`;
  if (!scopes.has(scope)) {
    uncovered.push(label);
    continue;
  }
  if (erroredScopes.has(scope)) {
    unmeasured.push(label);
    continue;
  }
  const found = Boolean(match(label));
  const bucket = (byRule[label.rule] ??= { real: empty(), synthetic: empty() })[group];
  const target = totals[group];
  if (label.label) {
    if (found) { bucket.tp++; target.tp++; } else { bucket.fn++; target.fn++; falseNegatives.push(label); }
  } else if (found) {
    bucket.fp++; target.fp++; falsePositives.push(label);
  } else if (label.expectsAbsent === true) {
    bucket.tn++; target.tn++;
  } else {
    unverifiedNegatives.push(label);
  }
}

const rate = (m) => ({
  precision: m.tp + m.fp ? Number((m.tp / (m.tp + m.fp)).toFixed(3)) : null,
  recall: m.tp + m.fn ? Number((m.tp / (m.tp + m.fn)).toFixed(3)) : null,
  ...m,
});
const evidenceStats = Object.values(evidence).reduce((m, e) => { m[e.type] = (m[e.type] || 0) + 1; return m; }, {});
const unlabeledFindings = raw.filter((r) => !r.used);
const report = {
  labels: { real: real.length, synthetic: synthetic.length, total: labels.length },
  coverage: {
    rawScopes: scopes.size,
    evaluated: labels.length - stale.length - uncovered.length - unmeasured.length - unverifiedNegatives.length,
    uncovered: uncovered.length,
    unmeasured: unmeasured.length,
    stale: stale.length,
    unverifiedNegatives: unverifiedNegatives.length,
    realEvidence: { total: real.length, ...evidenceStats },
  },
  metrics: { real: rate(totals.real), synthetic: rate(totals.synthetic) },
  byRule: Object.fromEntries(Object.entries(byRule).map(([rule, v]) => [rule, { real: rate(v.real), synthetic: rate(v.synthetic) }])),
  unlabeledFindings: unlabeledFindings.length,
  uncoveredIds: uncovered.map((l) => l.id),
  unmeasuredIds: unmeasured.map((l) => l.id),
  staleIds: stale.map((l) => l.id),
  unverifiedNegativeIds: unverifiedNegatives.map((l) => l.id),
  falseNegatives: falseNegatives.map((l) => `${l.id} ${l.source}@${l.viewport} ${l.state} ${l.rule} ${l.selector}`),
  falsePositives: falsePositives.map((l) => `${l.id} ${l.source}@${l.viewport} ${l.state} ${l.rule} ${l.selector}`),
};
writeFileSync('datasets/EVAL.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (totals.synthetic.fp || totals.synthetic.fn) {
  console.error('FAIL: synthetic regression detected');
  process.exitCode = 1;
}
