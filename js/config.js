export const APP_VERSION = 'v2.6.8';
export const DAY_MS = 86400000;
const UI_PREFS_KEY = 'duofin2-ui-prefs-v1';

export const $ = id => document.getElementById(id);

export const iso = (d = new Date()) =>
  d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

export const currentMonth = () => iso(new Date()).slice(0, 7);

export const eur = n =>
  new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(+n || 0);

export const esc = s =>
  String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const sum = arr => arr.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);

export const isPaid = t => t && t.status !== 'pending' && t.status !== 'skipped';

export const dateMs = s => Date.parse(s + 'T00:00:00Z');

export const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && Number.isFinite(dateMs(s));

export const addDays = (s, n) => new Date(dateMs(s) + n * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (a, b) => Math.round((dateMs(b) - dateMs(a)) / DAY_MS);

export const monthLast = m => {
  const [y, mo] = m.split('-').map(Number);
  return `${m}-${String(new Date(y, mo, 0).getDate()).padStart(2, '0')}`;
};

export const fmtDate = d =>
  validDate(d) ? new Date(d + 'T12:00:00').toLocaleDateString('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' }) : String(d || '');

export const mName = m =>
  new Date(m + '-02T12:00:00').toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });

export const capFirst = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

export function addMonthsClamp(dateStr, monthsToAdd) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const totalM = y * 12 + (m - 1) + monthsToAdd;
  const ny = Math.floor(totalM / 12);
  const nm = (totalM % 12) + 1;
  const lastDay = new Date(ny, nm, 0).getDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, lastDay)).padStart(2, '0')}`;
}

export function uid(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function haptic(pattern = 12) {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {}
}

export function loadUiPrefs() {
  try {
    return { theme: 'auto', density: 'balanced', summaryLevel: 'detailed', ...JSON.parse(localStorage.getItem(UI_PREFS_KEY) || '{}') };
  } catch {
    return { theme: 'auto', density: 'balanced', summaryLevel: 'detailed' };
  }
}

export function saveUiPrefs(patch) {
  const next = { ...loadUiPrefs(), ...patch };
  localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
  return next;
}

export function applyThemeAndDensity(onThemeChanged = null) {
  const prefs = loadUiPrefs();
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const resolved = prefs.theme === 'dark' || (prefs.theme === 'auto' && prefersDark) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-density', prefs.density || 'balanced');

  const meta = $('metaThemeColor');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#09121d' : '#142b45');

  const quickBtn = $('themeQuickToggleBtn');
  if (quickBtn) {
    quickBtn.textContent = prefs.theme === 'dark' ? '🌙' : prefs.theme === 'light' ? '☀️' : '🌓';
    quickBtn.title = `Tema: ${prefs.theme === 'dark' ? 'Escuro' : prefs.theme === 'light' ? 'Claro' : 'Automático'}`;
  }
  if ($('themeMode')) $('themeMode').value = prefs.theme;
  if ($('densityMode')) $('densityMode').value = prefs.density;

  if (typeof onThemeChanged === 'function') onThemeChanged(resolved);
  return resolved;
}

export function showToast(msg, opts = {}) {
  const container = $('toastContainer');
  if (!container) return;
  const { type = 'info', duration = 3600, undoLabel = null, onUndo = null } = opts;
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  el.appendChild(span);
  let timer = null;
  const close = () => {
    if (timer) clearTimeout(timer);
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    el.style.transition = 'opacity .18s, transform .18s';
    setTimeout(() => el.remove(), 190);
  };
  if (undoLabel && typeof onUndo === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-undo';
    btn.textContent = undoLabel;
    btn.onclick = () => {
      onUndo();
      close();
    };
    el.appendChild(btn);
  }
  container.appendChild(el);
  timer = setTimeout(close, duration);
}

export function evaluateAmountExpression(raw) {
  const cleaned = String(raw ?? '')
    .replace(/[€$£\s\u00A0]/g, '')
    .replace(/,/g, '.')
    .replace(/[−–—]/g, '-')
    .replace(/[×xX]/g, '*')
    .replace(/[÷]/g, '/');
  if (!cleaned) return NaN;
  if (/^[+-]?\d+(?:\.\d+)?$/.test(cleaned)) {
    const v = parseFloat(cleaned);
    return Number.isFinite(v) ? v : NaN;
  }
  if (!/^[0-9.+\-*/()]+$/.test(cleaned)) return NaN;
  const tokens = cleaned.match(/\d+(?:\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join('') !== cleaned) return NaN;

  const out = [], ops = [];
  const prec = { '+': 1, '-': 1, '*': 2, '/': 2 };
  let prevType = 'start';
  for (const tok of tokens) {
    if (/^\d/.test(tok)) {
      out.push(parseFloat(tok));
      prevType = 'num';
    } else if (tok === '(') {
      ops.push(tok);
      prevType = 'op';
    } else if (tok === ')') {
      while (ops.length && ops[ops.length - 1] !== '(') out.push(ops.pop());
      if (!ops.length) return NaN;
      ops.pop();
      prevType = 'num';
    } else {
      if ((tok === '+' || tok === '-') && (prevType === 'start' || prevType === 'op')) out.push(0);
      else if (prevType !== 'num') return NaN;
      while (ops.length && ops[ops.length - 1] !== '(' && prec[ops[ops.length - 1]] >= prec[tok]) out.push(ops.pop());
      ops.push(tok);
      prevType = 'op';
    }
  }
  while (ops.length) {
    const op = ops.pop();
    if (op === '(') return NaN;
    out.push(op);
  }
  const stack = [];
  for (const item of out) {
    if (typeof item === 'number') stack.push(item);
    else {
      if (stack.length < 2) return NaN;
      const b = stack.pop(), a = stack.pop();
      if (item === '+') stack.push(a + b);
      else if (item === '-') stack.push(a - b);
      else if (item === '*') stack.push(a * b);
      else if (item === '/') {
        if (b === 0) return NaN;
        stack.push(a / b);
      }
    }
  }
  if (stack.length !== 1 || !Number.isFinite(stack[0])) return NaN;
  return Math.round(stack[0] * 100) / 100;
}
