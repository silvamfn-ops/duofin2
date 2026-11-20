import { $, eur, fmtDate, sum, isPaid } from './config.js';
import { buildCycles, cycleTransactions, isSavingTx, savingSigned, computeCycleReferenceMonth } from './finance-engine.js';

export function drawSavingsChart(state) {
  const canvas = $('chart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, Math.round(rect.width || 640));
  const h = Math.max(180, Math.round(rect.height || 200));
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

  const padL = 48, padR = 20, padT = 20, padB = 26;
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

export function drawCategoryBarChart(state, cycle) {
  const canvas = $('analyticsCanvas');
  if (!canvas || !cycle) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(300, Math.round(rect.width || 640));
  const h = Math.max(220, Math.round(rect.height || 260));
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const tx = cycleTransactions(state, cycle).filter(t => isPaid(t) && t.type === 'expense');
  const items = (state.categories || [])
    .map(c => ({ label: c.name, value: sum(tx.filter(t => t.category === c.name)), budget: Number(c.budget) || 0 }))
    .filter(x => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  const styles = getComputedStyle(document.documentElement);
  const mutedCol = styles.getPropertyValue('--muted').trim() || '#68798a';
  const inkCol = styles.getPropertyValue('--ink').trim() || '#192838';
  const gCol = styles.getPropertyValue('--g').trim() || '#173653';

  if (!items.length) {
    ctx.fillStyle = mutedCol;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem despesas registadas neste ciclo.', w / 2, h / 2);
    return;
  }

  const padL = 120, padR = 60, padT = 16, padB = 16;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const maxVal = Math.max(10, ...items.map(x => Math.max(x.value, x.budget))) * 1.1;
  const rowH = plotH / items.length;
  const barH = Math.min(22, rowH * 0.6);

  items.forEach((it, idx) => {
    const y = padT + idx * rowH + (rowH - barH) / 2;
    ctx.fillStyle = inkCol;
    ctx.font = '11.5px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(it.label.slice(0, 16), padL - 8, y + barH * 0.72);

    const vw = (it.value / maxVal) * plotW;
    ctx.fillStyle = it.budget > 0 && it.value > it.budget ? '#b54747' : gCol;
    ctx.beginPath();
    ctx.roundRect(padL, y, Math.max(4, vw), barH, 4);
    ctx.fill();

    ctx.fillStyle = mutedCol;
    ctx.textAlign = 'left';
    ctx.fillText(eur(it.value), padL + Math.max(4, vw) + 6, y + barH * 0.72);
  });
}
