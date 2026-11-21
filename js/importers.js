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
    items.sort((a, b) => (Math.abs(b.y - a.y) > 3 ? b.y - a.y : a.x - b.x));

    const rows = [];
    for (const it of items) {
      const last = rows[rows.length - 1];
      if (last && Math.abs(last.y - it.y) <= 3) {
        last.items.push(it);
      } else {
        rows.push({ y: it.y, items: [it] });
      }
    }

    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
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
    ['Supermercado', ['continente', 'pingo doce', 'lidl', 'aldi', 'auchan', 'my auchan', 'intermarche', 'intermarché', 'mercadona', 'minipreco', 'minipreço', 'meu super', 'amanhecer', 'talho', 'peixaria', 'padaria', 'froiz', 'el corte ingles', 'supercor']],
    ['Transportes', ['galp', 'repsol', 'bp ', 'cepsa', 'prio', 'via verde', 'uber', 'bolt', 'cp ', 'comboios', 'carris', 'metro', 'metropolitano', 'stcp', 'fertagus', 'transtejo', 'estacionamento', 'emel', 'parque', 'pq.', 'portagem', 'brisa']],
    ['Água, luz e gás', ['edp', 'endesa', 'goldenergy', 'iberdrola', 'galp energia', 'epal', 'aguas', 'águas', 'indaqua', 'simas', 'smas', 's.m.a.s', 'luz', 'eletricidade', 'gás', 'gas ']],
    ['Telecomunicações', ['meo', 'nos ', 'vodafone', 'altice', 'digi', 'nowo', 'uzo', 'moche', 'yorn', 'woo ']],
    ['Saúde e farmácia', ['farmacia', 'farmácia', 'hospital', 'clinica', 'clínica', 'cuf', 'lusiadas', 'lusíadas', 'luz saude', 'medico', 'médico', 'dentista', 'wells', 'optica', 'óptica', 'analises', 'análises']],
    ['Restaurantes e lazer', ['restaurante', 'cafe', 'café', 'cafes', 'pastelaria', 'mcdonald', 'burger', 'pizza', 'kfc', 'telepizza', 'uber eats', 'glovo', 'bolt food', 'cinema', 'castelo lopes', 'nos cinemas', 'spotify', 'netflix', 'hbo', 'disney', 'playstation', 'steam', 'fnac', 'ticketline', 'bol ', 'ninho verde', 'kiwoko']],
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
    .replace(/(compra|pagamento|pag\.?|tpa|mb\s*way|mbway|multibanco|cartao|cartão|debito|débito|transf\.?|transferencia|transferência|para|de|dd|sepa|ref\.?|ent\.?|num\.?)/gi, ' ')
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

const PT_MONTHS = {
  jan: '01', janeiro: '01',
  fev: '02', fevereiro: '02',
  mar: '03', marco: '03', 'março': '03',
  abr: '04', abril: '04',
  mai: '05', maio: '05',
  jun: '06', junho: '06',
  jul: '07', julho: '07',
  ago: '08', agosto: '08',
  set: '09', setembro: '09',
  out: '10', outubro: '10',
  nov: '11', novembro: '11',
  dez: '12', dezembro: '12'
};

function parseLocalizedNumber(rawToken) {
  let s = String(rawToken || '')
    .replace(/[€$£\s ]/g, '')
    .replace(/−/g, '-');

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

  // Formato por extenso PT (ex: "20 nov. 2026" ou "20 nov 2026")
  const ptMatch = clean.match(/^(\d{1,2})\s+([a-zç]{3,9})\.?\s+(\d{4})$/i);
  if (ptMatch) {
    const d = ptMatch[1].padStart(2, '0');
    const mKey = ptMatch[2].toLocaleLowerCase('pt-PT');
    const m = PT_MONTHS[mKey];
    const y = ptMatch[3];
    if (m) return `${y}-${m}-${d}`;
  }

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

function parseSingleLine(state, rawLine, detectedYear) {
  const line = String(rawLine || '').trim();
  const skipLineRe = /^(saldo\s+(inicial|final|contabilístico|disponível|anterior|atual)|total\s+(de\s+)?(débitos|créditos|movimentos)|página\s+\d+|data\s+da\s+operação|data\s+mov|movimentos\s+da\s+sua\s+conta|documento\s+com\s+data|para\s+pesquisas)/i;
  if (!line || skipLineRe.test(line)) return null;

  // CSV separado por ponto e vírgula
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
        return {
          selected: true,
          date: dt,
          description: descCol,
          type,
          category: type === 'income' ? 'Rendimento' : guessCategory(state, descCol),
          amount: Math.abs(val)
        };
      }
    }
  }

  // Suporta data inicial numérica OU por extenso ("20 nov. 2026")
  const dateTokenPattern = '(?:\d{4}[\/.-]\d{1,2}[\/.-]\d{1,2}|\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?|\d{1,2}\s+[a-zç]{3,9}\.?\s+\d{4})';
  const leadingDateRe = new RegExp(`^(${dateTokenPattern})\s+(.*)$`, 'i');
  const secondDateRe = new RegExp(`^(?:d\.\s*valor:\s*)?(${dateTokenPattern})\s+(.*)$`, 'i');
  const amtRe = /(?:\(\s*)?[+-]?\s*(?:\d{1,3}(?:[.\s ]\d{3})+|\d+)[,.]\d{2}(?:\s*\))?(?:\s*[€$£])?/g;

  const m = line.match(leadingDateRe);
  if (!m) return null;

  const dt = normalizeDateToken(m[1], detectedYear);
  if (!dt) return null;

  let rest = m[2].trim();
  const m2 = rest.match(secondDateRe);
  if (m2) {
    rest = m2[2].trim();
  }

  const amts = [...rest.matchAll(amtRe)];
  if (!amts.length) return null;

  // Quando há Valor + Saldo no final da linha, escolhe o penúltimo valor (Valor do movimento)
  const chosen = amts.length >= 2 ? amts[amts.length - 2] : amts[0];
  let val = parseLocalizedNumber(chosen[0]);
  if (!Number.isFinite(val) || val === 0) return null;

  let desc = rest.slice(0, amts[0].index).trim();
  desc = desc.replace(/\|/g, ' ').replace(/\s+/g, ' ').replace(/\s+(EUR|USD|GBP|D|C)$/i, '').trim() || 'Movimento bancário';

  const hasExplicitSign = /[+-]|\(.*\)/.test(chosen[0]);
  if (!hasExplicitSign && val > 0) {
    const trailingDC = rest.slice(chosen.index + chosen[0].length).trim();
    if (/^C/i.test(trailingDC)) {
      val = Math.abs(val);
    } else if (/^D/i.test(trailingDC)) {
      val = -Math.abs(val);
    } else {
      const isInc = /(transf\.?\s*receb|trf\.?\s*mb\s*way\s*de|ordenado|vencimento|salário|salario|reembolso|segurança\s*social|crédito|credito|depósito|deposito|abono|dividendo|juros\s*cred)/i.test(desc);
      if (!isInc) val = -val;
    }
  }

  const type = val > 0 ? 'income' : 'expense';
  const category = type === 'income' ? 'Rendimento' : guessCategory(state, desc);

  return {
    selected: true,
    date: dt,
    description: desc,
    type,
    category,
    amount: Math.abs(val)
  };
}

export function parseStatementLines(state, lines) {
  let detectedYear = String(new Date().getFullYear());
  for (const line of lines.slice(0, 35)) {
    const ym = line.match(/(202[0-9])/);
    if (ym) {
      detectedYear = ym[1];
      break;
    }
  }

  const rows = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    // Caso especial: PDFs onde duas transações na mesma linha Y ficaram coladas horizontalmente
    // Ex: "09 nov. 2026 D. valor: 09 nov. 2026 09 nov. 2026 D. valor: 09 nov. 2026 Desc1 Desc2 -4,00€ 4,25€ 276,21€ 280,21€"
    const gluedSantander = line.match(
      /^(\d{1,2}\s+[a-zç]{3,9}\.?\s+\d{4})\s+D\.\s*valor:\s*(\d{1,2}\s+[a-zç]{3,9}\.?\s+\d{4})\s+(\d{1,2}\s+[a-zç]{3,9}\.?\s+\d{4})\s+D\.\s*valor:\s*(\d{1,2}\s+[a-zç]{3,9}\.?\s+\d{4})\s+(.+?)\s+([+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}€)\s+([+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}€)\s+([+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}€)\s+([+-]?(?:\d{1,3}(?:\.\d{3})+|\d+),\d{2}€)$/i
    );
    if (gluedSantander) {
      const [, d1, dv1, d2, dv2, bothDescs, v1, v2, s1, s2] = gluedSantander;
      // Tentar separar descrições coladas pelos prefixos típicos bancários
      const splitDesc = bothDescs.match(/^(.+?)\s+((?:Trf\.|Transferência|Pagamento|Compra|Levantamento|Ordenado|Comissão|Imposto|Via Verde|Pingo Doce|Mercadona|Continente|Lidl|Repsol|Galp).*)$/i);
      const desc1 = splitDesc ? splitDesc[1] : bothDescs;
      const desc2 = splitDesc ? splitDesc[2] : 'Movimento bancário';

      const r1 = parseSingleLine(state, `${d1} D. valor: ${dv1} ${desc1} ${v1} ${s1}`, detectedYear);
      const r2 = parseSingleLine(state, `${d2} D. valor: ${dv2} ${desc2} ${v2} ${s2}`, detectedYear);
      if (r1) rows.push(r1);
      if (r2) rows.push(r2);
      continue;
    }

    const parsed = parseSingleLine(state, line, detectedYear);
    if (parsed) rows.push(parsed);
  }

  return rows;
}
