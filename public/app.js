// Копирование в буфер
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  navigator.clipboard?.writeText(el.dataset.copy).then(() => {
    const old = el.textContent;
    el.textContent = 'Скопировано ✔';
    setTimeout(() => { el.textContent = old; }, 1200);
  });
});

// График подписчиков (SVG без библиотек)
(function chart() {
  const box = document.getElementById('chart');
  if (!box) return;
  const pts = JSON.parse(box.dataset.points || '[]');
  if (pts.length < 2) { box.style.height = '0'; return; }

  const W = box.clientWidth || 600, H = box.clientHeight || 260, P = { l: 52, r: 10, t: 10, b: 24 };
  const vals = pts.map((p) => p.subscribers);
  let min = Math.min(...vals), max = Math.max(...vals);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  const x = (i) => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : Math.round(n).toLocaleString('ru-RU');
  const ns = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };

  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  const css = getComputedStyle(document.documentElement);
  const line = css.getPropertyValue('--line'), muted = css.getPropertyValue('--muted'), primary = css.getPropertyValue('--primary');

  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4, yy = y(v);
    svg.append(mk('line', { x1: P.l, x2: W - P.r, y1: yy, y2: yy, stroke: line }));
    svg.append(mk('text', { x: P.l - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: muted }, fmt(v)));
  }
  const step = Math.max(1, Math.ceil(pts.length / 6));
  pts.forEach((p, i) => {
    if (i % step === 0 || i === pts.length - 1) {
      const d = new Date(p.date);
      svg.append(mk('text', { x: x(i), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: muted }, d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })));
    }
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.subscribers).toFixed(1)}`).join('');
  svg.append(mk('path', { d: `${path}L${x(pts.length - 1)},${H - P.b}L${P.l},${H - P.b}Z`, fill: primary, 'fill-opacity': 0.1 }));
  svg.append(mk('path', { d: path, fill: 'none', stroke: primary, 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));

  const dot = mk('circle', { r: 4, fill: primary, visibility: 'hidden' });
  const tip = mk('text', { class: 'tip', y: P.t + 12, visibility: 'hidden' });
  svg.append(dot, tip);
  svg.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const mx = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((mx - P.l) / (W - P.l - P.r)) * (pts.length - 1))));
    const p = pts[i];
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(p.subscribers)); dot.setAttribute('visibility', 'visible');
    tip.textContent = `${new Date(p.date).toLocaleDateString('ru-RU')}: ${p.subscribers.toLocaleString('ru-RU')}`;
    tip.setAttribute('x', Math.min(x(i) + 8, W - 170)); tip.setAttribute('visibility', 'visible');
  });
  svg.addEventListener('mouseleave', () => { dot.setAttribute('visibility', 'hidden'); tip.setAttribute('visibility', 'hidden'); });
  box.append(svg);
})();
