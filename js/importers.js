import { fmtDate } from './config.js';

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
let pdfPromise = null;
let workerBlobUrl = null;

async function configurePdfWorker(pdfjs) {
  if (workerBlobUrl) {
    pdfjs.GlobalWorkerOptions.workerSrc = workerBlobUrl;
    return;
  }
  try {
    const res = await fetch(`${PDFJS_CDN}/pdf.worker.min.js`, { mode: 'cors' });
    if (res.ok) {
      const code = await res.text();
      const blob = new Blob([code], { type: 'application/javascript' });
      workerBlobUrl = URL.createObjectURL(blob);
      pdfjs.GlobalWorkerOptions.workerSrc = workerBlobUrl;
      return;
    }
  } catch (_) {
    // Fallback para URL direto caso o fetch do blob falhe
  }
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.js`;
}

function ensurePdfJs() {
  if (window.pdfjsLib) {
    return configurePdfWorker(window.pdfjsLib).then(() => window.pdfjsLib);
  }
  if (pdfPromise) return pdfPromise;

  pdfPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `${PDFJS_CDN}/pdf.min.js`;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.onload = async () => {
      if (window.pdfjsLib) {
        await configurePdfWorker(window.pdfjsLib);
        resolve(window.pdfjsLib);
      } else {
        pdfPromise = null;
        reject(new Error('Falha ao inicializar leitor PDF.'));
      }
    };
    s.onerror = () => {
      pdfPromise = null;
      reject(new Error('Sem ligação à internet para carregar o leitor PDF. Podes usar a opção "Colar texto".'));
    };
    document.head.appendChild(s);
  });
  return pdfPromise;
}

export async function extractLinesFromPdf(file) {
  const pdfjs = await ensurePdfJs();
  const buf = await file.arrayBuffer();

  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: buf }).promise;
  } catch (_) {
    // Fallback sem Web Worker caso a CSP ou o browser bloqueie workers
    pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), disableWorker: true }).promise;
  }

  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter(it => it && typeof it.str === 'string' && it.str.trim())
      .map(it => ({
        str: it.str.trim(),
        x: Math.round(it.transform[4]),
        y: Math.round(it.transform[5]),
        w: Math.round(it.width || 0)
      }));

    // Ordenar de cima para baixo (Y descendente) e da esquerda para a direita (X ascendente)
    items.sort((a, b) => (Math.abs(b.y - a.y) > 4 ? b.y - a.y : a.x - b.x));

    const rows = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 4) {
        last.items.push(it);
      } else {
        rows.push({ y: it.y, items: [it] });
      }
    }

    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      // Preservar separação clara entre colunas distantes (ex: Débito vs Crédito)
      let rowStr = '';
      for (let i = 0; i < r.items.length; i++) {
        const cur = r.items[i];
        if (i > 0) {
          const prev = r.items[i - 1];
          const gap = cur.x - (prev.x + prev.w);
          rowStr += gap > 25 ? '   ' : ' ';
        }
        rowStr += cur.str;
      }
      if (rowStr.trim()) lines.push(rowStr.trim());
    }
  }
  return lines;
}

export function guessCategory(state, desc) {
  const d = String(desc || '').toLocaleLowerCase('pt-PT');
  const avail = new Set((state.categories || []).filter(c => !c.deleted_at).map(c => c.name));

  // 1. Regras aprendidas pelo utilizador têm prioridade máxima
  for (const rule of state.meta?.category_rules || []) {
    if (avail.has(rule.category) && d.includes(rule.keyword.toLocaleLowerCase('pt-PT'))) {
      return rule.category;
    }
  }

  // 2. Dicionário de comerciantes portugueses
  const rules = [
    ['Supermercado', ['continente', 'pingo doce', 'lidl', 'aldi', 'auchan', 'intermarche', 'intermarché', 'mercadona', 'minipreco', 'minipreço', 'meu super', 'amanhecer', 'talho', 'peixaria', 'padaria', 'froiz', 'el corte ingles']],
    ['Transportes', ['galp', 'repsol', 'bp ', 'cepsa', 'prio', 'via verde', 'uber', 'bolt', 'cp ', 'comboios', 'carris', 'metro', 'metropolitano', 'stcp', 'fertagus', 'transtejo', 'estacionamento', 'emel', 'parque', 'portagem', 'brisa']],
    ['Água, luz e gás', ['edp', 'endesa', 'goldenergy', 'iberdrola', 'galp energia', 'epal', 'aguas', 'águas', 'indaqua', 'simas', 'smas', 'luz', 'eletricidade', 'gás', 'gas ']],
    ['Telecomunicações', ['meo', 'nos ', 'vodafone', 'digi', 'nowo', 'uzo', 'moche', 'yorn', 'woo ']],
    ['Saúde e farmácia', ['farmacia', 'farmácia', 'hospital', 'clinica', 'clínica', 'cuf', 'lusiadas', 'lusíadas', 'luz saude', 'medico', 'médico', 'dentista', 'wells', 'optica', 'óptica', 'analises', 'análises']],
    ['Restaurantes e lazer', ['restaurante', 'cafe', 'café', 'pastelaria', 'mcdonald', 'burger', 'pizza', 'kfc', 'telepizza', 'uber eats', 'glovo', 'bolt food', 'cinema', 'nos cinemas', 'spotify', 'netflix', 'hbo', 'disney', 'playstation', 'steam', 'fnac', 'ticketline', 'bol ']],
    ['Habitação', ['renda', 'condominio', 'condomínio', 'ikea', 'leroy', 'leroy merlin', 'aki', 'maxmat', 'conforama', 'jysk', 'homa', 'habitacao', 'habitação', 'imt', 'imi']],
    ['Vestuário e pessoal', ['zara', 'primark', 'decathlon', 'sport zone', 'bershka', 'pull&bear', 'stradivarius', 'massimo dutti', 'lefties', 'c&a', 'h&m', 'mango', 'parfois', 'cabeleireiro', 'barbeiro', 'sephora', 'boticario', 'boticário']]
  ];

  for (const [catName, keywords] of rules) {
    if (avail.has(catName) && keywords.some(k => d.includes(k))) return catName;
  }
  return avail.has('Outros / imprevistos') ? 'Outros / imprevistos' : state.categories[0]?.name || 'Outros / imprevistos';
}

export function learnCategoryRule(state, description, category) {
  if (!description || !category) return;
  const clean = String(description)
    .toLocaleLowerCase('pt-PT')
    .replace(/\b(compra|pagamento|pag\.?|tpa|mb\s*way|mbway|multibanco|cartao|cartão|debito|débito|transf\.?|transferencia|transferência|dd|sepa|ref\.?|ent\.?|num\.?)\b/gi, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (clean.length < 3) return;
  const keyword = clean.split(' ').slice(0, 3).join(' ');
  if (keyword.length < 3) return;

  if (!state.meta) state.meta = {};
  if (!Array.isArray(state.meta.category_rules)) state.meta.category_rules = [];

  const idx = state.meta.category_rules.findIndex(r => r.keyword === keyword);
  if (idx >= 0) {
    state.meta.category_rules[idx].category = category;
  } else {
    state.meta.category_rules.unshift({ keyword, category });
    if (state.meta.category_rules.length > 150) state.meta.category_rules.pop();
  }
}

function parseLocalizedNumber(rawToken) {
  let s = String(rawToken || '')
    .replace(/[€$£\s\u00A0]/g, '')
    .replace(/\u2212/g, '-');

  const isParenNeg = /^\(.*\)$/.test(s);
  if (isParenNeg) s = '-' + s.slice(1, -1);

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    s = s.replace(',', '.');
  }

  const val = parseFloat(s);
  return Number.isFinite(val) ? val : NaN;
}

function normalizeDateToken(token, fallbackYear) {
  const clean = token.trim();
  if (/^\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}$/.test(clean)) {
    const [y, m, d] = clean.split(/[\/.-]/);
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{4}$/.test(clean)) {
    const [d, m, y] = clean.split(/[\/.-]/);
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2}$/.test(clean)) {
    const [d, m, yy] = clean.split(/[\/.-]/);
    const fullY = Number(yy) > 70 ? `19${yy}` : `20${yy}`;
    return `${fullY}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  if (/^\d{1,2}[\/.-]\d{1,2}$/.test(clean)) {
    const [d, m] = clean.split(/[\/.-]/);
    return `${fallbackYear}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

export function parseStatementLines(state, lines) {
  let detectedYear = String(new Date().getFullYear());
  for (const line of lines.slice(0, 35)) {
    const ym = line.match(/\b(202[0-9])\b/);
    if (ym) {
      detectedYear = ym[1];
      break;
    }
  }

  const leadingDateRe = /^(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)\s+(.*)$/;
  const secondDateRe = /^(\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?)\s+(.*)$/;
  const amtRe = /(?:\(\s*)?[+-]?\s*(?:\d{1,3}(?:[.\s\u00A0]\d{3})+|\d+)[,.]\d{2}(?:\s*\))?(?:\s*[€$£])?/g;
  const skipLineRe = /^(saldo\s+(inicial|final|contabilístico|disponível|anterior|atual)|total\s+(de\s+)?(débitos|créditos|movimentos)|página\s+\d+|data\s+mov)/i;

  const rows = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line || skipLineRe.test(line)) continue;

    if (line.includes(';') && !line.includes('   ')) {
      const cols = line.split(';').map(c => c.replace(/^"|"$/g, '').trim());
      const dt = normalizeDateToken(cols[0], detectedYear);
      if (dt && cols.length >= 3) {
        const nums = cols.slice(1).map(c => ({ raw: c, val: parseLocalizedNumber(c) })).filter(x => Number.isFinite(x.val) && x.val !== 0);
        if (nums.length) {
          const descCol = cols.slice(1).find(c => isNaN(parseLocalizedNumber(c)) && c.length > 1) || 'Movimento CSV';
          let val = nums[0].val;
          if (!/[+-]/.test(nums[0].raw) && val > 0 && !/(transf\.?\s*receb|ordenado|vencimento|salário|reembolso|crédito|depósito)/i.test(descCol)) {
            val = -val;
          }
          const type = val > 0 ? 'income' : 'expense';
          rows.push({
            selected: true,
            date: dt,
            description: descCol,
            type,
            category: type === 'income' ? 'Rendimento' : guessCategory(state, descCol),
            amount: Math.abs(val)
          });
          continue;
        }
      }
    }

    const m = line.match(leadingDateRe);
    if (!m) continue;

    const dt = normalizeDateToken(m[1], detectedYear);
    if (!dt) continue;

    let rest = m[2].trim();
    const m2 = rest.match(secondDateRe);
    if (m2) {
      rest = m2[2].trim();
    }

    const amts = [...rest.matchAll(amtRe)];
    if (!amts.length) continue;

    const chosen = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
    let val = parseLocalizedNumber(chosen[0]);
    if (!Number.isFinite(val) || val === 0) continue;

    let desc = rest.slice(0, amts[0].index).trim();
    desc = desc.replace(/\s+(EUR|USD|GBP|D|C)$/i, '').trim() || 'Movimento bancário';

    const hasExplicitSign = /[+-]|\(.*\)/.test(chosen[0]);
    if (!hasExplicitSign && val > 0) {
      const trailingDC = rest.slice(chosen.index + chosen[0].length).trim();
      if (/^C\b/i.test(trailingDC)) {
        val = Math.abs(val);
      } else if (/^D\b/i.test(trailingDC)) {
        val = -Math.abs(val);
      } else {
        const isInc = /(transf\.?\s*receb|ordenado|vencimento|salário|salario|reembolso|crédito|credito|depósito|deposito|abono|dividendo|juros\s*cred)/i.test(desc);
        if (!isInc) val = -val;
      }
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
