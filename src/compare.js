// Regression comparison between two scan result sets (hard errors only).
// Fingerprints identify a finding across runs so the agent can prove a fix
// removed old defects without introducing new ones (possibly at other viewports).
function collect(results) {
  const map = new Map();
  for (const r of results) {
    for (const f of r.findings) {
      if (f.severity !== 'error') continue;
      const key = [r.viewport, r.state ?? 'baseline', f.rule, f.selector].join('|');
      map.set(key, { ...f, viewport: r.viewport, state: r.state ?? 'baseline' });
    }
  }
  return map;
}

function scopes(results) {
  const set = new Set();
  for (const r of results) set.add(`${r.viewport}|${r.state ?? 'baseline'}`);
  return set;
}

export function compare(baselineResults, currentResults) {
  const before = collect(baselineResults);
  const now = collect(currentResults);
  const beforeScopes = scopes(baselineResults);
  const nowScopes = scopes(currentResults);
  const erroredScopes = new Set(
    currentResults.filter((r) => r.error).map((r) => `${r.viewport}|${r.state ?? 'baseline'}`)
  );
  const added = [];
  const fixed = [];
  const persisting = [];
  for (const [key, f] of now) {
    if (before.has(key)) persisting.push(f);
    else added.push(f);
  }
  // A finding can only count as fixed when its viewport+state was actually
  // measured again. Otherwise "not tested" would silently become "fixed".
  for (const [key, f] of before) {
    const scope = `${f.viewport}|${f.state}`;
    if (erroredScopes.has(scope)) continue;
    if (nowScopes.has(scope) && !now.has(key)) fixed.push(f);
  }
  const skipped = [...beforeScopes].filter((scope) => !nowScopes.has(scope) || erroredScopes.has(scope));
  return { added, fixed, persisting, skipped };
}
