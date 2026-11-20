import { fmtDate } from './config.js';

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
let pdfPromise = null;

function ensurePdfJs() {
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
    return Promise.resolve(window.pdfjsLib);
  }
  if (pdfPromise) return pdfPromise;
  pdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${PDFJS_CDN}/pdf.min.js`;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.onload = () => {
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      } else {
        pdfPromise = null;
        reject(new Error('Falha ao inicializar leitor PDF.'));
      }
    };
    s.onerror = () => {
      pdfPromise = null;
      reject(new Error('Sem ligação para carregar leitor PDF.'));
    };
    document.head.appendChild(s);
  });
  return pdfPromise;
}

export async function extractLinesFromPdf(file) {
  const pdfjs = await ensurePdfJs();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it && typeof it.str === 'string' && it.str.trim())
      .map(it => ({ str: it.str.trim(), x: Math.round(it.transform[4]), y: Math.round(it.transform[5]) }));
    items.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));
    const rows = [];
    items.forEach(it => {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 4) last.items.push(it);
      else rows.push({ y: it.y, items: [it] });
    });
    rows.forEach(r => {
      r.items.sort((a, b) => a.x - b.x);
      lines.push(r.items.map(x => x.str).join(' '));
    });
  }
  return lines;
}

export function guessCategory(state, desc) {
  const d = String(desc || '').toLocaleLowerCase('pt-PT');
  const avail = new Set((state.categories || []).map(c => c.name));

  for (const rule of state.meta?.category_rules || []) {
    if (avail.has(rule.category) && d.includes(rule.keyword.toLocaleLowerCase('pt-PT'))) {
      return rule.category;
    }
  }

  const rules = [
    ['Supermercado', ['continente', 'pingo doce', 'lidl', 'aldi', 'auchan', 'intermarche', 'mercadona', 'minipreco', 'talho', 'padaria']],
    ['Transportes', ['galp', 'repsol', 'bp ', 'cepsa', 'prio', 'via verde', 'uber', 'bolt', 'cp ', 'carris', 'metro', 'estacionamento']],
    ['Água, luz e gás', ['edp', 'endesa', 'goldenergy', 'iberdrola', 'epal', 'aguas']],
    ['Telecomunicações', ['meo', 'nos ', 'vodafone', 'digi', 'nowo']],
    ['Saúde e farmácia', ['farmacia', 'hospital', 'clinica', 'cuf', 'lusiadas', 'medico', 'dentista', 'wells']],
    ['Restaurantes e lazer', ['restaurante', 'cafe', 'pastelaria', 'mcdonald', 'burger', 'pizza', 'uber eats', 'glovo', 'cinema', 'spotify', 'netflix']],
    ['Habitação', ['renda', 'condominio', 'ikea', 'leroy', 'habitacao']],
    ['Vestuário e pessoal', ['zara', 'primark', 'decathlon', 'sport zone', 'cabeleireiro']]
  ];

  for (const [catName, keywords] of rules) {
    if (avail.has(catName) && keywords.some(k => d.includes(k))) return catName;
  }
  return avail.has('Outros / imprevistos') ? 'Outros / imprevistos' : state.categories[0]?.name || 'Outros / imprevistos';
}

export function parseStatementLines(state, lines) {
  const fallbackYear = String(new Date().getFullYear());
  const dateRe = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{4})?)\s*(.*)$/;
  const amtRe = /([+-]?\s*(?:\d{1,3}(?:[.\s]\d{3})+|\d+),\d{2}|[+-]?\s*\d+\.\d{2})\s*[€$£]?/g;
  const rows = [];

  for (const raw of lines) {
    const m = raw.trim().match(dateRe);
    if (!m) continue;
    let dt = m[1];
    if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$/.test(dt)) {
      const [d, mo, y] = dt.split(/[\/.-]/);
      dt = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else if (/^\d{1,2}[\/.-]\d{1,2}$/.test(dt)) {
      const [d, mo] = dt.split(/[\/.-]/);
      dt = `${fallbackYear}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }

    const rest = m[2];
    const amts = [...rest.matchAll(amtRe)];
    if (!amts.length) continue;

    const chosen = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
    const rawNum = chosen[1].replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
    let val = parseFloat(rawNum);
    if (!Number.isFinite(val) || val === 0) continue;

    const desc = rest.slice(0, amts[0].index).trim() || 'Movimento bancário';
    if (!/[+-]/.test(chosen[1]) && val > 0) {
      const isInc = /(transf\.?\s*receb|ordenado|vencimento|salário|reembolso|crédito|depósito)/i.test(desc);
      if (!isInc) val = -val;
    }

    const type = val > 0 ? 'income' : 'expense';
    const category = type === 'income' ? 'Rendimento' : guessCategory(state, desc);
    rows.push({
      selected: true,
      date: dt,
      description: desc,
      type,
      category,
      amount: Math.abs(val)
    });
  }
  return rows;
}
