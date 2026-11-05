// Язык страницы: подписи в скриптах и формат дат
const LANG = document.documentElement.lang === 'ru' ? 'ru' : 'uz';
const TEXT = {
  copied: { ru: 'Скопировано ✔', uz: 'Nusxa olindi ✔' },
  openOrder: { ru: ' Открыть заказ →', uz: ' Buyurtmani ochish →' },
  sendFailed: { ru: 'Не удалось отправить сообщение.', uz: 'Xabarni yuborib boʻlmadi.' },
};
const tr = (key) => TEXT[key][LANG];
// В браузерах нет узбекских сокращений месяцев — форматируем сами
const UZ_MONTHS = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];
const fmtDate = (d, short) => {
  d = new Date(d);
  if (LANG === 'ru') return short ? d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : d.toLocaleDateString('ru-RU');
  return short ? `${d.getDate()} ${UZ_MONTHS[d.getMonth()]}` : `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

// Поведение страниц без инлайн-скриптов (их запрещает Content-Security-Policy)
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-toggle-nav]')) document.body.classList.toggle('nav-open');
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a, button, input, select, textarea, form')) location.href = row.dataset.href;
});
document.addEventListener('submit', (e) => {
  const msg = e.target.dataset?.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
}, true);
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.matches('[data-autosubmit]')) el.form?.submit();
  if (el.matches('[data-check-all]')) document.querySelectorAll(el.dataset.checkAll).forEach((c) => { c.checked = el.checked; });
});
// Битый аватар — показываем букву под ним
document.addEventListener('error', (e) => {
  if (e.target.matches?.('.ava img')) e.target.remove();
}, true);

// Копирование в буфер
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-copy]');
  if (!el) return;
  navigator.clipboard?.writeText(el.dataset.copy).then(() => {
    const old = el.textContent;
    el.textContent = tr('copied');
    setTimeout(() => { el.textContent = old; }, 1200);
  });
});

// Графики без библиотек: линейный (data-points) и столбчатый (data-bars)
const ns = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (text != null) n.textContent = text; return n; };
const fmt = (n) => { const a = Math.abs(n); return (n < 0 ? '−' : '') + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? Math.round(a / 1e3) + 'K' : Math.round(a).toLocaleString('ru-RU')); };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name);

function setupChart(box, n, values, xOf, P) {
  const W = box.clientWidth || 600, H = box.clientHeight || 260;
  let min = Math.min(...values), max = Math.max(...values);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.1; min -= pad; max += pad;
  if (Math.min(...values) >= 0) min = Math.max(min, 0);
  const y = (v) => P.t + (1 - (v - min) / (max - min)) * (H - P.t - P.b);
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none' });
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4, yy = y(v);
    svg.append(mk('line', { x1: P.l, x2: W - P.r, y1: yy, y2: yy, stroke: cssVar('--line') }));
    svg.append(mk('text', { x: P.l - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': 11, fill: cssVar('--muted') }, fmt(v)));
  }
  const dot = mk('circle', { r: 4, fill: cssVar('--primary'), visibility: 'hidden' });
  const tip = mk('text', { class: 'tip', y: P.t + 12, visibility: 'hidden' });
  const hover = (render) => {
    svg.append(dot, tip);
    svg.addEventListener('mousemove', (e) => {
      const r = svg.getBoundingClientRect();
      const mx = ((e.clientX - r.left) / r.width) * W;
      let i = 0, best = Infinity;
      for (let k = 0; k < n; k++) { const d = Math.abs(xOf(k, W) - mx); if (d < best) { best = d; i = k; } }
      const { text, cy } = render(i);
      if (cy != null) { dot.setAttribute('cx', xOf(i, W)); dot.setAttribute('cy', cy); dot.setAttribute('visibility', 'visible'); }
      tip.textContent = text;
      tip.setAttribute('x', Math.max(P.l, Math.min(xOf(i, W) + 8, W - 220))); tip.setAttribute('visibility', 'visible');
    });
    svg.addEventListener('mouseleave', () => { dot.setAttribute('visibility', 'hidden'); tip.setAttribute('visibility', 'hidden'); });
  };
  return { W, H, y, svg, hover };
}

function lineChart(box) {
  const pts = JSON.parse(box.dataset.points || '[]');
  if (pts.length < 2) { box.style.height = '0'; return; }
  const P = { l: 52, r: 10, t: 10, b: 24 };
  const xOf = (i, W) => P.l + (i / (pts.length - 1)) * (W - P.l - P.r);
  const { W, H, y, svg, hover } = setupChart(box, pts.length, pts.map((p) => p.subscribers), xOf, P);
  const step = Math.max(1, Math.ceil(pts.length / 6));
  pts.forEach((p, i) => {
    if (i % step === 0 || i === pts.length - 1) {
      svg.append(mk('text', { x: xOf(i, W), y: H - 6, 'text-anchor': 'middle', 'font-size': 11, fill: cssVar('--muted') },
        fmtDate(p.date, true)));
    }
  });
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${xOf(i, W).toFixed(1)},${y(p.subscribers).toFixed(1)}`).join('');
  svg.append(mk('path', { d: `${path}L${xOf(pts.length - 1, W)},${H - P.b}L${P.l},${H - P.b}Z`, fill: cssVar('--primary'), 'fill-opacity': 0.1 }));
  svg.append(mk('path', { d: path, fill: 'none', stroke: cssVar('--primary'), 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
  hover((i) => ({ text: `${fmtDate(pts[i].date)}: ${pts[i].subscribers.toLocaleString('ru-RU')}`, cy: y(pts[i].subscribers) }));
  box.append(svg);
}

function barChart(box) {
  const bars = JSON.parse(box.dataset.bars || '[]');
  if (!bars.length) { box.style.height = '0'; return; }
  const P = { l: 52, r: 10, t: 18, b: 8 };
  const slot = (W) => (W - P.l - P.r) / bars.length;
  const xOf = (i, W) => P.l + slot(W) * (i + 0.5);
  const values = bars.map((b) => b.value).concat(0);
  const { W, y, svg, hover } = setupChart(box, bars.length, values, xOf, P);
  const zero = y(0), bw = Math.max(1, slot(W) * 0.7);
  bars.forEach((b, i) => {
    const top = Math.min(y(b.value), zero), h = Math.max(1, Math.abs(y(b.value) - zero));
    svg.append(mk('rect', { x: xOf(i, W) - bw / 2, y: top, width: bw, height: h, rx: Math.min(3, bw / 3),
      fill: b.value < 0 ? cssVar('--bad') : cssVar('--primary'), 'fill-opacity': 0.85 }));
  });
  hover((i) => ({ text: `${bars[i].label}: ${bars[i].value.toLocaleString('ru-RU')}` }));
  box.append(svg);
}

document.querySelectorAll('.chart-line').forEach(lineChart);
document.querySelectorAll('.chart-bars').forEach(barChart);

// Переписка: отправка без перезагрузки и подгрузка новых сообщений
(function chat() {
  const box = document.getElementById('chat');
  const form = document.getElementById('chat-form');
  if (!box || !form) return;
  const conv = box.dataset.conv;
  let last = Number(box.dataset.last) || 0;
  const scroll = () => { box.scrollTop = box.scrollHeight; };
  scroll();

  const render = (m) => {
    if (document.getElementById('m' + m.id)) return;
    document.getElementById('chat-empty')?.remove();
    const el = document.createElement('div');
    el.className = 'msg ' + (m.kind === 'system' ? 'system' : m.mine ? 'mine' : '');
    el.id = 'm' + m.id;
    el.append(document.createTextNode(m.text));
    if (m.order_id) {
      const a = document.createElement('a');
      a.href = '/orders/' + m.order_id; a.textContent = tr('openOrder');
      el.append(a);
    }
    const t = document.createElement('time'); t.textContent = m.at + ' UTC';
    el.append(t);
    box.append(el);
    last = Math.max(last, m.id);
  };
  const poll = async () => {
    try {
      const r = await fetch(`/messages/${conv}/poll?after=${last}`, { headers: { Accept: 'application/json' } });
      if (!r.ok) return;
      const items = await r.json();
      if (items.length) { items.forEach(render); scroll(); }
    } catch { /* сеть недоступна — попробуем позже */ }
  };
  setInterval(poll, 5000);

  const textarea = form.querySelector('textarea');
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = textarea.value.trim();
    if (!text) return;
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      const r = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: new URLSearchParams(new FormData(form)),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { alert(data.error || tr('sendFailed')); return; }
      textarea.value = '';
      await poll();
    } finally { btn.disabled = false; textarea.focus(); }
  });
})();

// Счётчики непрочитанных сообщений и заказов в шапке
(function unread() {
  const m = document.getElementById('unread-messages'), o = document.getElementById('unread-orders');
  if (!m || !o) return;
  const set = (el, n) => { el.textContent = n; el.hidden = !n; };
  setInterval(async () => {
    if (document.hidden) return;
    try {
      const r = await fetch('/messages/api/unread');
      if (r.ok) { const d = await r.json(); set(m, d.messages); set(o, d.orders); }
    } catch { /* ignore */ }
  }, 30000);
})();
