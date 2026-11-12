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

export function compare(baselineResults, currentResults) {
  const before = collect(baselineResults);
  const now = collect(currentResults);
  const added = [];
  const fixed = [];
  const persisting = [];
  for (const [key, f] of now) {
    if (before.has(key)) persisting.push(f);
    else added.push(f);
  }
  for (const [key, f] of before) {
    if (!now.has(key)) fixed.push(f);
  }
  return { added, fixed, persisting };
}
