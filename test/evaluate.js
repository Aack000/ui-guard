// Evaluate labeled findings against the latest raw scans.
// Synthetic labels are a construction check; real labels are a regression set.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const readJsonl = (file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const real = readJsonl('datasets/labels.jsonl');
const synthetic = readJsonl('datasets/labels-synthetic.jsonl');
const labels = [...real, ...synthetic];
const evidence = JSON.parse(readFileSync('datasets/evidence.json', 'utf8'));

const raw = [];
const scopes = new Set();
for (const name of readdirSync('datasets/raw')) {
  if (!name.endsWith('.json')) continue;
  const data = JSON.parse(readFileSync(`datasets/raw/${name}`, 'utf8'));
  for (const r of data.results || []) {
    const viewport = Number(r.viewport ?? r.width);
    const state = r.state ?? r.name ?? 'baseline';
    scopes.add(`${data.source}|${viewport}|${state}`);
    for (const f of r.findings || []) raw.push({ file: name, source: data.source, viewport, state, rule: f.rule, selector: f.selector });
  }
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const match = (label) => raw.find((r) =>
  r.source === label.source
  && r.viewport === Number(label.viewport)
  && r.rule === label.rule
  && (norm(r.selector) === norm(label.selector) || norm(r.selector).endsWith(norm(label.selector)) || norm(r.selector).includes(norm(label.selector)))
);

const empty = () => ({ tp: 0, fn: 0, fp: 0, tn: 0 });
const byRule = {};
const totals = { real: empty(), synthetic: empty() };
const uncovered = [];
for (const label of labels) {
  const group = label.synthetic ? 'synthetic' : 'real';
  const scope = `${label.source}|${Number(label.viewport)}|${label.state}`;
  if (!scopes.has(scope)) {
    uncovered.push(label);
    continue;
  }
  const found = Boolean(match(label));
  const bucket = (byRule[label.rule] ??= { real: empty(), synthetic: empty() })[group];
  const target = totals[group];
  if (label.label) {
    if (found) { bucket.tp++; target.tp++; } else { bucket.fn++; target.fn++; }
  } else if (found) { bucket.fp++; target.fp++; } else { bucket.tn++; target.tn++; }
}

const rate = (m) => ({
  precision: m.tp + m.fp ? Number((m.tp / (m.tp + m.fp)).toFixed(3)) : null,
  recall: m.tp + m.fn ? Number((m.tp / (m.tp + m.fn)).toFixed(3)) : null,
  ...m,
});
const evidenceStats = Object.values(evidence).reduce((m, e) => { m[e.type] = (m[e.type] || 0) + 1; return m; }, {});
const report = {
  labels: { real: real.length, synthetic: synthetic.length, total: labels.length },
  coverage: {
    rawScopes: scopes.size,
    evaluated: labels.length - uncovered.length,
    uncovered: uncovered.length,
    realEvidence: { total: real.length, raw: evidenceStats.raw || 0, note: evidenceStats.note || 0 },
  },
  metrics: { real: rate(totals.real), synthetic: rate(totals.synthetic) },
  byRule: Object.fromEntries(Object.entries(byRule).map(([rule, v]) => [rule, { real: rate(v.real), synthetic: rate(v.synthetic) }])),
  uncoveredIds: uncovered.map((l) => l.id),
};
writeFileSync('datasets/EVAL.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
