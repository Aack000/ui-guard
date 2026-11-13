// Injected into the page. Must be fully self-contained (serialized by page.evaluate).
// Returns findings: [{ rule, severity, selector, message, rect }]
// Rules:
//   H1  error  page-level horizontal overflow (offenders outside scroll containers)
//   H1c error  container clips content horizontally (no ellipsis, not scrollable)
//   H2  error  text clipped vertically (no line-clamp / ellipsis intent)
//   H3  error  fixed-position overlay outside viewport
//   H4  error  interactive element not clickable (covered at all sample points)
//   H5  error  two interactive elements overlap each other
//   S1  warn   font face failed to load
//   S2  warn   sibling buttons on the same row with misaligned centers
//   S3  warn   non-interactive text elements overlapping
export function measure() {
  const findings = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const EPS = 2;
  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

  const hiddenByAttr = (el) => el.closest('[aria-hidden="true"], [inert]') !== null;

  function opacityZero(el) {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (parseFloat(getComputedStyle(n).opacity) === 0) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (hiddenByAttr(el) || opacityZero(el)) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // sr-only / visually-hidden 工具类：1px 裁剪，不是内容溢出。
  function visuallyHidden(el) {
    const r = el.getBoundingClientRect();
    return r.width <= 1 && r.height <= 1;
  }

  // disabled 沿祖先传播：fieldset[disabled] 与只读容器（aria-disabled）内
  // 的控件同样不应参与点击/触控检查。
  function disabledChain(el) {
    for (let n = el; n; n = n.parentElement) {
      if (n.matches && n.matches(':disabled')) return true;
      if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
    }
    return false;
  }

  function selector(el) {
    if (el.id) return '#' + el.id;
    const parts = [];
    let n = el;
    while (n && n !== document.body && parts.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.classList.length) s += '.' + [...n.classList].slice(0, 2).join('.');
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ') || el.tagName.toLowerCase();
  }

  const rectOf = (r) => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  });

  // Identical rule + selector on repeated cards (product grids, lists) must not
  // emit 20 near-identical findings: aggregate and surface the count instead.
  const buckets = new Map();
  function report(rule, severity, el, message) {
    const selectorText = selector(el);
    const key = `${rule}|${severity}|${selectorText}`;
    const hit = buckets.get(key);
    if (hit) {
      hit.count += 1;
      return;
    }
    buckets.set(key, {
      rule,
      severity,
      selector: selectorText,
      message,
      rect: rectOf(el.getBoundingClientRect()),
      count: 1,
    });
  }

  // Ancestor that intentionally scrolls horizontally: content inside is reachable.
  function inHorizontalScroller(el) {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth) return true;
    }
    return false;
  }

  const all = [...document.querySelectorAll('body *')].filter(isVisible);
  const interactive = all.filter((el) => el.matches(INTERACTIVE));

  // ---- color helpers (S5) ----
  function parseRgb(str) {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((v) => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function relLum(c) {
    const f = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrastRatio(a, b) {
    const l1 = relLum(a);
    const l2 = relLum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }
  function blend(fg, bg) {
    const a = fg.a === undefined ? 1 : fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  /**
   * 向上找可见背景：纯色返回单色；渐变返回所有不透明 stop 颜色（取最差对比度）；
   * 图片或含半透明 stop 的渐变无法可靠合成，返回 null（跳过，避免误报）。
   */
  function backgroundsOf(el) {
    for (let n = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      // Gradients are often masked by cards/images, so computed stop colors are
      // not the visible background. Keep contrast checks on solid colors only.
      if (cs.backgroundImage !== 'none') return null;
      const c = parseRgb(cs.backgroundColor);
      // A translucent color layer cannot be composited reliably: skip instead
      // of reaching a far ancestor and guessing the visible color.
      if (c && c.a > 0 && c.a < 0.95) return null;
      if (c && c.a >= 0.95) return [c];
    }
    return [{ r: 255, g: 255, b: 255, a: 1 }];
  }

  // ---- H1: page-level horizontal overflow ----
  const doc = document.documentElement;
  const docOverflow = doc.scrollWidth > vw + EPS;
  if (docOverflow) {
    const offenders = all
      .filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed') return false; // fixed overlays are H3's job
        const r = el.getBoundingClientRect();
        return r.right > vw + EPS && !inHorizontalScroller(el);
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
      .slice(0, 5);
    for (const el of offenders) {
      report('H1', 'error', el, `page overflows horizontally (doc ${doc.scrollWidth}px > viewport ${vw}px)`);
    }
    if (offenders.length === 0) {
      report('H1', 'error', doc, `page overflows horizontally (doc ${doc.scrollWidth}px > viewport ${vw}px)`);
    }
  } else {
    // overflow-x: hidden/clip can pull scrollWidth back to the viewport and
    // silently hide content wider than the screen. Inspect elements whose
    // nearest clipping ancestor cuts them off; ignore off-right slides and
    // anything moved by a transform/filter.
    const underTransform = (el) => {
      for (let n = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.transform !== 'none' || cs.filter !== 'none') return true;
      }
      return false;
    };
    const clippingAncestor = (el) => {
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (/(hidden|clip)/.test(getComputedStyle(n).overflowX)) return n;
      }
      return null;
    };
    const masked = all
      .filter((el) => {
        if (el === doc || el === document.body) return false;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.position === 'absolute') return false;
        if (cs.display === 'inline' || cs.display === 'inline-block') return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.left >= vw) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        if (underTransform(el)) return false;
        if (inHorizontalScroller(el)) return false;
        // Table headers are clipped to the horizontal scroll position of the
        // body on purpose (Element Plus / native table wrappers).
        if (el.closest('table') || el.matches('table, thead, tbody, tr, th, td') || el.querySelector('table')) return false;
        if (el.textContent.trim().length === 0 && !el.querySelector(INTERACTIVE)) return false;
        const clip = clippingAncestor(el);
        if (!clip) return false;
        const cr = clip.getBoundingClientRect();
        return r.right > cr.right + EPS;
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    // Keep only the outermost offender per clipped region (nav + its items).
    const uniqueMasked = masked
      .filter((el) => !masked.some((other) => other !== el && other.contains(el)))
      .slice(0, 5);
    for (const el of uniqueMasked) {
      report('H1c', 'error', el, `content clipped horizontally by overflow-x: hidden (${Math.round(el.getBoundingClientRect().right)}px > viewport ${vw}px)`);
    }
  }

  for (const el of all) {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();

    // Text-clipping rules only apply to elements with direct text nodes:
    // clipping decorative children (e.g. hero glow) is intentional design.
    const hasDirectText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0
    );

    // ---- H1c: text clipped horizontally ----
    if (
      hasDirectText &&
      !visuallyHidden(el) &&
      el.scrollWidth > el.clientWidth + EPS &&
      /(hidden|clip)/.test(cs.overflowX) &&
      cs.textOverflow !== 'ellipsis'
    ) {
      report('H1c', 'error', el, `text clipped horizontally (${el.scrollWidth}px > ${el.clientWidth}px, overflow-x: ${cs.overflowX})`);
    }

    // ---- H2: text clipped vertically ----
    if (
      hasDirectText &&
      !visuallyHidden(el) &&
      el.scrollHeight > el.clientHeight + EPS &&
      /(hidden|clip)/.test(cs.overflowY) &&
      cs.webkitLineClamp === 'none' &&
      cs.textOverflow !== 'ellipsis'
    ) {
      report('H2', 'error', el, `text clipped vertically (${el.scrollHeight}px > ${el.clientHeight}px, overflow-y: ${cs.overflowY})`);
    }

    // ---- S6: ellipsis truncation without an accessible full text ----
    if (
      hasDirectText &&
      cs.textOverflow === 'ellipsis' &&
      el.scrollWidth > el.clientWidth + EPS &&
      !el.getAttribute('title') &&
      !el.getAttribute('aria-label')
    ) {
      report('S6', 'warn', el, `text truncated with ellipsis but no title/aria-label (${el.scrollWidth}px > ${el.clientWidth}px)`);
    }

    // ---- H3: fixed overlay outside viewport ----
    // Purely decorative fixed elements (ambient glows, background shapes) are
    // intentionally placed partly off-screen: no visible text, no interactive
    // descendants => not a defect.
    if (cs.position === 'fixed') {
      const decorative =
        (el.textContent.trim().length === 0 && !el.querySelector(INTERACTIVE)) ||
        el.getAttribute('data-state') === 'closed' ||
        el.getAttribute('aria-hidden') === 'true' ||
        el.hasAttribute('inert') ||
        cs.pointerEvents === 'none';
      if (!decorative) {
      const out = [];
      if (r.left < -EPS) out.push('left');
      if (r.right > vw + EPS) out.push('right');
      if (r.top < -EPS) out.push('top');
      if (r.bottom > vh + EPS) out.push('bottom');
      if (out.length > 0) {
        // H4 skips elements whose sample points all fall outside the viewport,
        // so a dialog pushed off-screen would hide its buttons from every rule.
        // Surface that consequence here where the container is already failing.
        const unreachable = [...el.querySelectorAll(INTERACTIVE)].filter((child) => {
          const cr = child.getBoundingClientRect();
          return cr.right <= 0 || cr.left >= vw || cr.bottom <= 0 || cr.top >= vh;
        }).length;
        const suffix = unreachable > 0
          ? ` — ${unreachable} interactive element(s) entirely outside the viewport`
          : '';
        report('H3', 'error', el, `fixed element escapes viewport on: ${out.join(', ')}${suffix}`);
      }
      }
    }
  }

  // ---- H4: interactive element not clickable ----
  // If a modal dialog is open, background inertness is intentional: only check inside it.
  const modalCandidates = all.filter((el) => {
    if (el.getAttribute('aria-modal') !== 'true') return false;
    // A persistent drawer hidden by transform is not an active modal: if it
    // were, H4/H5/S3 would only inspect that off-screen subtree.
    const r = el.getBoundingClientRect();
    return r.right > 0 && r.left < vw && r.bottom > 0 && r.top < vh;
  });
  // Later DOM order usually means the topmost dialog; do not lock onto a
  // background drawer when a confirm dialog is open.
  const modal = modalCandidates.length ? modalCandidates[modalCandidates.length - 1] : null;
  // Disabled controls are not expected to be clickable: coverage checks only
  // apply to enabled controls (a disabled "sold out" button may sit under a
  // badge or be clipped without being a defect).
  const clickTargets = (modal ? interactive.filter((el) => modal.contains(el)) : interactive)
    .filter((el) => !disabledChain(el));

  // An element scrolled entirely outside a scrollable ancestor is reachable by
  // scrolling, not covered: horizontal nav rails are the common case.
  function clippedByScroller(el) {
    const r = el.getBoundingClientRect();
    for (let n = el.parentElement; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      const scrollX = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
      const scrollY = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
      if (!scrollX && !scrollY) continue;
      const cr = n.getBoundingClientRect();
      // 部分被裁也算“滚动可达”，避免横向导航在中间宽度报 partial 噪声。
      const inside = r.left >= cr.left - 1 && r.right <= cr.right + 1 && r.top >= cr.top - 1 && r.bottom <= cr.bottom + 1;
      if (!inside) return true;
    }
    return false;
  }

  for (const el of clickTargets) {
    if (clippedByScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const points = [
      [r.x + r.width / 2, r.y + r.height / 2],
      [r.x + Math.min(8, r.width / 4), r.y + r.height / 2],
      [r.right - Math.min(8, r.width / 4), r.y + r.height / 2],
      [r.x + r.width / 2, r.y + Math.min(8, r.height / 4)],
      [r.x + r.width / 2, r.bottom - Math.min(8, r.height / 4)],
    ].filter(([x, y]) => x >= 0 && x < vw && y >= 0 && y < vh);
    if (points.length === 0) continue; // off-screen: covered by H1/H3
    // A sticky header covers content only until the page is scrolled; unlike a
    // fixed overlay this is reachable, so those sample points are not "covered".
    const underStickyHeader = (node) => {
      for (let n = node; n; n = n.parentElement) {
        if (getComputedStyle(n).position === 'sticky' && n.getBoundingClientRect().top <= 1) return true;
      }
      return false;
    };
    let covered = 0;
    for (const [x, y] of points) {
      const top = document.elementsFromPoint(x, y)[0];
      if (top && underStickyHeader(top)) continue;
      const hit = top && (top === el || el.contains(top));
      if (!hit) covered++;
    }
    if (covered === points.length) {
      report('H4', 'error', el, 'interactive element is covered at every sample point (not clickable)');
    } else if (covered > 0) {
      report('H4-partial', 'warn', el, `interactive element covered at ${covered}/${points.length} sample points`);
    }
  }

  // ---- H5: interactive elements overlapping ----
  // Same modal exemption as H4: controls behind an open modal are inert, so
  // their geometric overlap with the dialog is not a real collision.
  const h5Targets = (modal ? interactive.filter((el) => modal.contains(el)) : interactive)
    .filter((el) => !disabledChain(el));
  const rects = h5Targets.map((el) => ({ el, r: el.getBoundingClientRect() }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const { el: a, r: ra } = rects[i];
      const { el: b, r: rb } = rects[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 0 || h <= 0) continue;
      const overlap = w * h;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (smaller > 0 && overlap / smaller > 0.3) {
        report('H5', 'error', a, `overlaps interactive element ${selector(b)} (${Math.round((overlap / smaller) * 100)}% of smaller area)`);
      }
    }
  }

  // ---- S5: text contrast below WCAG AA (solid backgrounds only) ----
  for (const el of all) {
    const hasDirectText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0
    );
    if (!hasDirectText) continue;
    if (visuallyHidden(el)) continue;
    const cs = getComputedStyle(el);
    if (parseFloat(cs.opacity) < 0.5) continue;
    const fg = parseRgb(cs.color);
    // Transparent / gradient-clipped text has no single foreground color.
    if (!fg || fg.a === 0) continue;
    const bg = backgroundsOf(el)?.[0];
    if (!bg) continue;
    const fg2 = fg.a < 1 ? blend(fg, bg) : fg;
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const large = size >= 24 || (size >= 18.66 && bold);
    const threshold = large ? 3 : 4.5;
    const ratio = contrastRatio(fg2, bg);
    if (ratio < threshold) {
      report('S5', 'warn', el, `contrast ${ratio.toFixed(2)}:1 below ${threshold}:1 (${cs.color} on rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)}))`);
    }
  }

  // ---- S7: touch target smaller than 24x24 (WCAG 2.5.8) ----
  for (const el of all) {
    if (!el.matches('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]')) continue;
    // Disabled controls cannot be tapped, so 24px target rules do not apply.
    if (disabledChain(el)) continue;
    // Inline links in prose are explicitly exempt from the 24px rule.
    if (el.matches('a[href]') && getComputedStyle(el).display === 'inline') continue;
    // Controls fully outside the viewport (closed drawer, below the fold) are
    // not currently tappable; measure them once they are on screen.
    const vr = el.getBoundingClientRect();
    if (vr.right <= 0 || vr.left >= vw || vr.bottom <= 0 || vr.top >= vh) continue;
    let target = el;
    if (el.matches('input[type="checkbox"], input[type="radio"]')) {
      target = el.closest('label')
        || (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null)
        || el;
    }
    const r = target.getBoundingClientRect();
    if (r.width < 24 || r.height < 24) {
      report('S7', 'warn', target, `touch target ${Math.round(r.width)}×${Math.round(r.height)} below 24×24`);
    }
  }

  // ---- S8: hash target hidden under a sticky/fixed header ----
  if (location.hash && location.hash.length > 1) {
    let target = null;
    try {
      target = document.querySelector(location.hash);
    } catch {
      target = null;
    }
    if (target && isVisible(target)) {
      let headerBottom = 0;
      for (const el of all) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.height <= 0 || r.top > 0 || r.bottom > vh * 0.4) continue;
        if (el.contains(target)) continue;
        headerBottom = Math.max(headerBottom, r.bottom);
      }
      if (headerBottom > 0) {
        const tr = target.getBoundingClientRect();
        if (tr.top < headerBottom - EPS && tr.bottom > 0) {
          report('S8', 'warn', target, `hash target starts at y=${Math.round(tr.top)} under a sticky header ending at ${Math.round(headerBottom)}; add scroll-margin-top`);
        }
      }
    }
  }

  // ---- S1: font faces that failed to load ----
  for (const face of document.fonts) {
    if (face.status === 'error') {
      findings.push({
        rule: 'S1',
        severity: 'warn',
        selector: '@font-face',
        message: `font "${face.family}" failed to load`,
        rect: null,
      });
    }
  }

  // ---- S2: sibling buttons with misaligned vertical centers ----
  const byParent = new Map();
  for (const el of interactive) {
    if (!el.matches('button, [role="button"]')) continue;
    const list = byParent.get(el.parentElement) || [];
    list.push(el);
    byParent.set(el.parentElement, list);
  }
  for (const group of byParent.values()) {
    if (group.length < 2) continue;
    // Split wrapped rows: a button on the next line is not a misaligned sibling.
    const rows = [];
    for (const el of group) {
      const r = el.getBoundingClientRect();
      const row = rows.find((x) => {
        const overlap = Math.min(r.bottom, x.bottom) - Math.max(r.top, x.top);
        return overlap > Math.min(r.height, x.height) * 0.5;
      });
      if (row) {
        row.items.push(el);
        row.top = Math.min(row.top, r.top);
        row.bottom = Math.max(row.bottom, r.bottom);
      } else {
        rows.push({ top: r.top, bottom: r.bottom, items: [el] });
      }
    }
    for (const row of rows) {
      if (row.items.length < 2) continue;
      const centers = row.items.map((el) => {
        const r = el.getBoundingClientRect();
        return r.top + r.height / 2;
      });
      const spread = Math.max(...centers) - Math.min(...centers);
      if (spread > 6 && spread < 100) {
        report('S2', 'warn', row.items[0], `${row.items.length} sibling buttons on one row, center spread ${Math.round(spread)}px`);
      }
    }
  }

  // ---- S3: non-interactive text blocks overlapping ----
  // While a modal is open, text behind it is intentionally obscured: only
  // inspect text inside the modal, same exemption as H4.
  const textScope = modal ? all.filter((el) => modal.contains(el)) : all;
  const textBlocks = textScope.filter(
    (el) =>
      !el.matches(INTERACTIVE) &&
      el.children.length === 0 &&
      el.textContent.trim().length > 0
  );
  // Fixed/sticky text layers (toast, tooltip, sticky header) intentionally sit
  // over page text; that is a design overlay, not a document-flow collision.
  const overlayChain = (el) => {
    // The modal itself is fixed (dialog top layer); do not exempt its own
    // contents, otherwise S3 never runs inside an open modal.
    for (let n = el; n && n !== modal; n = n.parentElement) {
      const pos = getComputedStyle(n).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  };
  for (let i = 0; i < textBlocks.length; i++) {
    for (let j = i + 1; j < textBlocks.length; j++) {
      const a = textBlocks[i];
      const b = textBlocks[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (overlayChain(a) || overlayChain(b)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 2 || h <= 2) continue;
      const overlap = w * h;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      if (smaller > 0 && overlap / smaller > 0.3) {
        report('S3', 'warn', a, `text overlaps ${selector(b)} (${Math.round((overlap / smaller) * 100)}%)`);
      }
    }
  }

  // ---- S4: text squeezed into one-character-per-line columns ----
  // Typical responsive defect: flex items shrink until CJK text wraps into a
  // vertical single-character strip. Intentional vertical writing is excluded.
  for (const el of all) {
    const hasDirectText = [...el.childNodes].some(
      (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0
    );
    if (!hasDirectText) continue;
    const text = el.textContent.trim();
    if (text.length < 3) continue;
    const cs = getComputedStyle(el);
    if (!cs.writingMode.startsWith('horizontal')) continue;
    const r = el.getBoundingClientRect();
    const fontSize = parseFloat(cs.fontSize);
    if (fontSize > 0 && r.width < fontSize * 2.2 && r.height > fontSize * 2.5) {
      report('S4', 'warn', el, `text squeezed to ${Math.round(r.width)}px wide (${text.length} chars, font ${fontSize}px): wraps into single-character column`);
    }
  }

  for (const item of buckets.values()) {
    const message = item.count > 1 ? `${item.message} (×${item.count})` : item.message;
    findings.push({
      rule: item.rule,
      severity: item.severity,
      selector: item.selector,
      message,
      rect: item.rect,
      count: item.count,
    });
  }

  return findings;
}
