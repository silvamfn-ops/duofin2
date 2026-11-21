import { $, eur, fmtDate, sum, isPaid, esc } from './config.js';
import { buildCycles, cycleTransactions, isSavingTx, savingSigned, getPeopleList } from './finance-engine.js';

const PALETTE = ['#173653', '#c5a56b', '#245d49', '#b54747', '#5b9bd5', '#c97a1e', '#6f5ca8', '#3c8d99', '#8c6d46', '#4a6572'];

export function drawSavingsChart(state) {
  const canvas = $('chart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, Math.round(rect.width || 640));
  const h = Math.max(190, Math.round(rect.height || 220));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const cycles = buildCycles(state);
  let total = 0;
  const series = cycles
    .map(cy => {
      const delta = cycleTransactions(state, cy)
        .filter(t => isSavingTx(t) && isPaid(t))
        .reduce((acc, t) => acc + savingSigned(t), 0);
      total = Math.max(0, total + delta);
      return { cycle: cy, value: total };
    })
    .slice(-12);

  if (!series.length) return;

  const styles = getComputedStyle(document.documentElement);
  const lineCol = styles.getPropertyValue('--line').trim() || '#dce4ec';
  const goldCol = styles.getPropertyValue('--gold').trim() || '#c5a56b';
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#68798a';
  const surfaceCol = styles.getPropertyValue('--surface').trim() || '#ffffff';

  const padL = 50, padR = 20, padT = 20, padB = 28;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const max = Math.max(100, ...series.map(x => x.value)) * 1.15;

  ctx.strokeStyle = lineCol;
  ctx.fillStyle = mutedCol;
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round(max * (1 - i / 4)) + '€', padL - 6, y + 3.5);
  }

  const pts = series.map((item, i) => ({
    x: padL + plotW * (series.length === 1 ? 0.5 : i / (series.length - 1)),
    y: padT + plotH * (1 - item.value / max),
    item
  }));

  // Área suave sob a linha
  ctx.fillStyle = 'rgba(197, 165, 107, 0.14)';
  ctx.beginPath();
  ctx.moveTo(pts[0].x, padT + plotH);
  pts.forEach(p => ctx.lineTo(p.x, p.y));
  ctx.lineTo(pts[pts.length - 1].x, padT + plotH);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = goldCol;
  ctx.lineWidth = 3;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();

  ctx.textAlign = 'center';
  pts.forEach(p => {
    ctx.fillStyle = surfaceCol;
    ctx.strokeStyle = goldCol;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const lbl = p.item.cycle.open ? 'Atual' : fmtDate(p.item.cycle.end).replace(/ \d{4}$/, '');
    ctx.fillStyle = mutedCol;
    ctx.fillText(lbl, p.x, h - 8);
  });
}

export function drawAnalyticsChart(state, cycle, metric = 'categories', chartType = 'hbar') {
  const canvas = $('analyticsCanvas');
  const legendEl = $('analyticsLegend');
  if (!canvas || !cycle) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, Math.round(rect.width || 640));
  const h = Math.max(230, Math.round(rect.height || 260));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tx = cycleTransactions(state, cycle).filter(t => isPaid(t));
  let items = [];

  if (metric === 'categories' || metric === 'budget_vs_actual') {
    items = (state.categories || [])
      .filter(c => !c.deleted_at)
      .map((c, i) => ({
        label: c.name,
        value: sum(tx.filter(t => t.type === 'expense' && t.category === c.name)),
        budget: Number(c.budget) || 0,
        color: PALETTE[i % PALETTE.length]
      }))
      .filter(x => x.value > 0)
      .sort((a, b) => b.value - a.value);
  } else if (metric === 'person') {
    items = getPeopleList(state)
      .map((p, i) => ({
        label: p,
        value: sum(tx.filter(t => t.type === 'expense' && t.person === p)),
        budget: 0,
        color: PALETTE[i % PALETTE.length]
      }))
      .filter(x => x.value > 0);
  } else if (metric === 'balance_summary') {
    items = [
      { label: 'Rendimentos', value: sum(tx.filter(t => t.type === 'income')), budget: 0, color: '#245d49' },
      { label: 'Despesas', value: sum(tx.filter(t => t.type === 'expense')), budget: 0, color: '#b54747' },
      { label: 'Poupança líq.', value: Math.max(0, sum(tx.filter(t => t.type === 'saving')) - sum(tx.filter(t => t.type === 'saving_withdraw'))), budget: 0, color: '#c5a56b' }
    ].filter(x => x.value > 0);
  } else if (metric === 'cycles_compare') {
    const recentCycles = buildCycles(state).slice(-6);
    items = recentCycles.map((cy, i) => ({
      label: cy.monthLabel,
      value: sum(cycleTransactions(state, cy).filter(t => isPaid(t) && t.type === 'expense')),
      budget: sum(cycleTransactions(state, cy).filter(t => isPaid(t) && t.type === 'income')),
      color: PALETTE[i % PALETTE.length]
    }));
  }

  const styles = getComputedStyle(document.documentElement);
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#68798a';
  const inkCol = styles.getPropertyValue('--ink').trim() || '#192838';
  const surfaceCol = styles.getPropertyValue('--surface').trim() || '#ffffff';

  if (!items.length) {
    ctx.fillStyle = mutedCol;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem dados suficientes para este gráfico.', w / 2, h / 2);
    if (legendEl) legendEl.innerHTML = '';
    return;
  }

  if (chartType === 'donut') {
    const total = items.reduce((a, b) => a + b.value, 0);
    const cx = w / 2, cy = h / 2;
    const rOuter = Math.min(w, h) * 0.4;
    const rInner = rOuter * 0.56;
    let start = -Math.PI / 2;
    items.forEach(it => {
      const slice = (it.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rOuter, start, start + slice);
      ctx.arc(cx, cy, rInner, start + slice, start, true);
      ctx.closePath();
      ctx.fillStyle = it.color;
      ctx.fill();
      start += slice;
    });
    ctx.fillStyle = surfaceCol;
    ctx.beginPath();
    ctx.arc(cx, cy, rInner - 1, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = inkCol;
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(eur(total), cx, cy + 4);
  } else if (chartType === 'bar') {
    const padL = 46, padR = 16, padT = 18, padB = 34;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxVal = Math.max(10, ...items.map(x => Math.max(x.value, x.budget))) * 1.15;
    const colW = plotW / items.length;
    const barW = Math.min(34, colW * 0.55);

    items.slice(0, 8).forEach((it, idx) => {
      const x = padL + idx * colW + (colW - barW) / 2;
      const bh = (it.value / maxVal) * plotH;
      const y = padT + plotH - bh;
      ctx.fillStyle = it.color;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, Math.max(4, bh), 5);
      ctx.fill();

      ctx.fillStyle = mutedCol;
      ctx.font = '10.5px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(it.label.slice(0, 10), x + barW / 2, h - 10);
    });
  } else {
    // Barras horizontais
    const shown = items.slice(0, 8);
    const padL = 122, padR = 66, padT = 12, padB = 12;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxVal = Math.max(10, ...shown.map(x => Math.max(x.value, x.budget))) * 1.12;
    const rowH = plotH / shown.length;
    const barH = Math.min(20, rowH * 0.62);

    shown.forEach((it, idx) => {
      const y = padT + idx * rowH + (rowH - barH) / 2;
      ctx.fillStyle = inkCol;
      ctx.font = '11.5px system-ui, sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(it.label.slice(0, 16), padL - 8, y + barH * 0.72);

      const vw = (it.value / maxVal) * plotW;
      ctx.fillStyle = it.budget > 0 && it.value > it.budget && metric !== 'cycles_compare' ? '#b54747' : it.color;
      ctx.beginPath();
      ctx.roundRect(padL, y, Math.max(4, vw), barH, 4);
      ctx.fill();

      ctx.fillStyle = mutedCol;
      ctx.textAlign = 'left';
      ctx.fillText(eur(it.value), padL + Math.max(4, vw) + 6, y + barH * 0.72);
    });
  }

  if (legendEl) {
    legendEl.innerHTML = items
      .map(it => `<span class="legend-item"><i class="legend-swatch" style="background:${it.color}"></i>${esc(it.label)}: <b>${eur(it.value)}</b></span>`)
      .join('');
  }
}
