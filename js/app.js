import {
  APP_VERSION, $, iso, currentMonth, eur, esc, sum, isPaid, fmtDate,
  addMonthsClamp, uid, haptic, showToast, evaluateAmountExpression,
  loadUiPrefs, saveUiPrefs, applyThemeAndDensity
} from './config.js';
import {
  loadLocalState, saveLocalState, enqueueOutbox,
  convertLegacyV1Backup, getOutbox, createInitialState
} from './db.js';
import { DuoFinSync } from './supabase-sync.js';
import {
  buildCycles, currentCycle, cycleTransactions, computeCycleBalance,
  computeCycleProjection, computeDailyBurnRate, getAllCreditCardsStats, computeCreditCardDebt,
  goalTotal, getPeopleList, computeCycleReferenceMonth, getProjectedCalendarEvents
} from './finance-engine.js';
import { SecurityManager } from './security.js';
import { extractLinesFromPdf, parseStatementLines, guessCategory, learnCategoryRule } from './importers.js';
import { evaluateStatementDuplicates } from './duplicate-detector.js';
import { generateCyclePdfReport } from './pdf-report.js';
import { drawSavingsChart, drawAnalyticsChart } from './charts.js';

let state = loadLocalState();
let selectedCycleKey = null;
let movementCycleKey = null;
let encargosCycleKey = null;
let quickStatusFilter = 'all';
let calendarMonthStr = currentMonth();
let calScopeMode = 'day';
let selectedGoalId = null;
const CAL_LAYOUT_KEY = 'duofin2_cal_split_v1';
function loadCalLayoutPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAL_LAYOUT_KEY) || '{}');
    return {
      leftPct: Number.isFinite(raw.leftPct) ? Math.min(72, Math.max(28, raw.leftPct)) : 50,
      swapped: !!raw.swapped
    };
  } catch (_) {
    return { leftPct: 50, swapped: false };
  }
}
function saveCalLayoutPrefs(prefs) {
  try {
    localStorage.setItem(CAL_LAYOUT_KEY, JSON.stringify(prefs));
  } catch (_) {}
}
let calLayoutPrefs = loadCalLayoutPrefs();

let selectedCalendarDay = iso();
let parsedImportRows = [];

const security = new SecurityManager();
security.applyPrivacy();
security.startIdleWatcher();
if (security.hasPin()) security.lock();

const sync = new DuoFinSync(
  () => state,
  () => {
    render();
  },
  (status, msg) => {
    const el = $('cloudStatus');
    if (el) {
      el.textContent = msg;
      el.className = 'alert' + (status === 'synced' ? ' good' : status === 'offline' ? ' red' : '');
    }
    const badge = $('syncHeaderBadge');
    if (badge) {
      badge.textContent = status === 'synced' ? '● Em tempo real' : status === 'syncing' ? '↻ Sincronizar' : '○ Local';
    }
    updateHouseholdPanels();
    initStorageProtectionAndBackupReminder();
  }
);


const ADMIN_ONLY_TABLES = new Set(['households', 'household_meta', 'categories', 'credit_cards', 'recurring_expenses']);

function isCurrentUserAdmin() {
  return !sync || typeof sync.isAdmin !== 'function' ? true : sync.isAdmin();
}

function applyRolePermissions() {
  const isAdmin = isCurrentUserAdmin();
  const isLinked = Boolean(sync && sync.user && sync.householdId);

  if ($('userRoleBadge')) {
    $('userRoleBadge').hidden = !isLinked;
    $('userRoleBadge').textContent = isAdmin ? '👑 Administrador' : '👤 Utilizador';
  }
  if ($('createHouseholdBox')) {
    $('createHouseholdBox').hidden = isLinked;
  }
  if ($('adminInviteBox')) {
    $('adminInviteBox').hidden = !(isLinked && isAdmin);
  }
  if ($('joinHouseholdBox')) {
    $('joinHouseholdBox').hidden = isLinked && !isAdmin;
  }
  if ($('pushAllLocalBtn')) {
    $('pushAllLocalBtn').hidden = !isAdmin;
  }
  if ($('memberOrcamentoNotice')) {
    $('memberOrcamentoNotice').hidden = isAdmin;
  }
  if ($('memberEncargosNotice')) {
    $('memberEncargosNotice').hidden = isAdmin;
  }

  // Bloquear formulários estruturais na interface para o perfil Utilizador
  const adminForms = ['newCategoryForm', 'addCategoryRuleForm', 'creditCardForm'];
  adminForms.forEach(fid => {
    const el = $(fid);
    if (el) el.hidden = !isAdmin;
  });

  if ($('budgetForm')) {
    const submitBtn = $('budgetForm').querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.hidden = !isAdmin;
    $('budgetForm').querySelectorAll('input, button[data-move-cat], button[data-del-cat]').forEach(ctrl => {
      ctrl.disabled = !isAdmin;
      if (!isAdmin && ctrl.tagName === 'BUTTON') ctrl.hidden = true;
    });
  }

  if ($('savePeople')) {
    $('savePeople').hidden = !isAdmin;
    ['adult1', 'adult2', 'cycleGroupingDays'].forEach(id => {
      if ($(id)) $(id).disabled = !isAdmin;
    });
  }

  if ($('openNewEncargoBtn')) $('openNewEncargoBtn').hidden = !isAdmin;
  if ($('encargoSwitchEditBtn')) $('encargoSwitchEditBtn').hidden = !isAdmin;
  if ($('encargoDeleteBtn')) $('encargoDeleteBtn').hidden = !isAdmin;

  // Proteger importação de backup JSON completo e reinicialização da BD contra alterações por Utilizadores
  const resetBtn = $('resetDatabaseBtn');
  if (resetBtn && resetBtn.closest('.card')) {
    resetBtn.closest('.card').hidden = !isAdmin;
  }
  const importInput = $('importLegacyBackup');
  if (importInput && importInput.closest('label')) {
    importInput.closest('label').hidden = !isAdmin;
  }
}

function mutate(table, record) {
  if (ADMIN_ONLY_TABLES.has(table) && !isCurrentUserAdmin()) {
    showToast('Apenas o Administrador pode alterar esta configuração.', { type: 'info' });
    return;
  }
  record.updated_at = sync ? sync.nextMonotonicTimestamp() : Date.now();
  saveLocalState(state);
  enqueueOutbox(table, record);
  if (sync) sync.notifyLocalMutation(table, record);
  render();
  sync.flushOutbox();
}


let lastDevicesFetchAt = 0;
async function renderLinkedDevicesPanel(force = false) {
  const sec = $('linkedDevicesSection');
  const membersEl = $('householdMembersList');
  const devicesEl = $('householdDevicesList');
  if (!sec || !membersEl || !devicesEl) return;

  if (!sync || !sync.user || !sync.householdId) {
    sec.hidden = true;
    return;
  }
  sec.hidden = false;

  if (!force && Date.now() - lastDevicesFetchAt < 8000 && devicesEl.dataset.loaded === '1') {
    return;
  }
  lastDevicesFetchAt = Date.now();

  const { members, devices, tableMissing } = await sync.fetchMembersAndDevices();
  devicesEl.dataset.loaded = '1';

  const roleLabel = r => (r === 'owner' || r === 'admin' ? '👑 Administrador' : '👤 Utilizador');
  const amIAdmin = isCurrentUserAdmin();
  if (members.length) {
    membersEl.innerHTML =
      `<div class="small" style="font-weight:700;margin-bottom:4px">Contas com acesso (${members.length})</div>` +
      members.map(m => {
        const isMe = String(m.user_id) === String(sync.user?.id);
        const normR = m.role === 'owner' || m.role === 'admin' ? 'admin' : 'member';
        const nextR = normR === 'admin' ? 'member' : 'admin';
        const nextRLabel = nextR === 'admin' ? 'Promover a Admin' : 'Passar a Utilizador';
        const adminControls = amIAdmin && !isMe
          ? `<button type="button" class="ghost" style="padding:3px 7px;font-size:11.5px" data-toggle-member-role="${esc(m.user_id)}" data-next-role="${nextR}" title="Alterar perfil deste utilizador">${nextRLabel}</button>` +
            `<button type="button" class="danger" style="padding:3px 7px;font-size:11.5px" data-remove-member="${esc(m.user_id)}" title="Remover acesso deste utilizador">×</button>`
          : '';
        return `<div class="item row" style="padding:8px 10px;gap:8px;flex-wrap:wrap">
          <div><b>${esc(m.email)}</b>${isMe ? ' <span class="pill">Esta conta</span>' : ''}</div>
          <div class="row" style="gap:6px;flex-wrap:wrap">
            <span class="small">${esc(roleLabel(m.role))}</span>
            ${adminControls}
          </div>
        </div>`;
      }).join('');
  } else {
    membersEl.innerHTML = `<div class="item row" style="padding:8px 10px"><div><b>${esc(sync.user?.email || 'Utilizador')}</b> <span class="pill">Esta conta</span></div><span class="small">Ativo</span></div>`;
  }

  if (tableMissing) {
    devicesEl.innerHTML = `<div class="alert" style="font-size:12.5px;margin:0">
      Para listar todos os PCs e telemóveis associados, executa uma vez o script <code>supabase_v288_devices.sql</code> no <b>SQL Editor</b> do Supabase.<br>
      <span class="small">Aparelho atual: <b>${esc(sync.getDeviceName())}</b></span>
    </div>`;
    return;
  }

  const currentDevId = sync.getDeviceId();
  const fmtAgo = ts => {
    const diffSec = Math.max(0, Math.floor((Date.now() - (Number(ts) || 0)) / 1000));
    if (diffSec < 60) return 'Agora mesmo';
    if (diffSec < 3600) return `Há ${Math.floor(diffSec / 60)} min`;
    if (diffSec < 86400) return `Há ${Math.floor(diffSec / 3600)} h`;
    return `Há ${Math.floor(diffSec / 86400)} dia(s)`;
  };

  if (!devices.length) {
    devicesEl.innerHTML = '<div class="empty">Ainda sem dispositivos registados. Toca em «Atualizar lista».</div>';
    return;
  }

  devicesEl.innerHTML =
    `<div class="small" style="font-weight:700;margin-bottom:4px">Dispositivos ligados (${devices.length})</div>` +
    devices.map(d => {
      const isThis = String(d.device_id) === String(currentDevId);
      const devIcon = /iPhone|iPad|Android/i.test(d.platform || d.device_name || '') ? '📱' : '💻';
      return `<div class="item row" style="padding:8px 10px;gap:8px;align-items:center">
        <div style="min-width:0;flex:1 1 auto">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span>${devIcon}</span>
            <b>${esc(d.device_name || 'Dispositivo')}</b>
            ${isThis ? '<span class="pill">Este aparelho</span>' : ''}
            ${d.app_version ? `<span class="small" style="opacity:.8">(${esc(d.app_version)})</span>` : ''}
          </div>
          <div class="small" style="margin-top:2px">${esc(d.user_email || '')} · Visto: ${fmtAgo(d.last_seen_at)}</div>
        </div>
        <div class="row" style="gap:4px;flex:0 0 auto">
          ${isThis ? `<button type="button" class="ghost" style="padding:4px 8px;font-size:12px" data-rename-this-device="1" title="Dar um nome personalizado a este aparelho">✎ Nome</button>` : `<button type="button" class="danger" style="padding:4px 8px;font-size:12px" data-remove-device="${esc(d.device_id)}" title="Remover registo deste dispositivo">×</button>`}
        </div>
      </div>`;
    }).join('');
}

function updateHouseholdPanels() {
  if ($('cloudLogout')) $('cloudLogout').hidden = !sync.user;
  if ($('householdPanel')) $('householdPanel').hidden = !sync.user;
  const outboxLen = getOutbox().length;
  if ($('householdInfo')) {
    $('householdInfo').textContent = sync.householdId
      ? `Orçamento ligado (${sync.householdId.slice(0, 8)}…) · ${outboxLen} alteração(ões) na fila`
      : 'Cria um orçamento do casal ou insere o código de convite recebido.';
  }
  if ($('clearOutboxBtn')) {
    $('clearOutboxBtn').hidden = outboxLen === 0;
  }
  applyRolePermissions();
  renderLinkedDevicesPanel(false);
  if ($('outboxDiagnosticBox')) {
    if (outboxLen > 0 && sync.lastOutboxErrors && sync.lastOutboxErrors.length) {
      const sample = sync.lastOutboxErrors
        .slice(0, 3)
        .map(e => `• [${esc(e.table)}] ${esc(e.message)}`)
        .join('<br>');
      $('outboxDiagnosticBox').hidden = false;
      $('outboxDiagnosticBox').innerHTML = `<strong>Motivo dos itens retidos na fila:</strong><br>${sample}`;
    } else {
      $('outboxDiagnosticBox').hidden = true;
      $('outboxDiagnosticBox').innerHTML = '';
    }
  }
}

function openMobileDrawer() {
  $('mobileMoreBackdrop').hidden = false;
  $('mobileMoreDrawer').hidden = false;
  $('mobileMoreBtn').setAttribute('aria-expanded', 'true');
}

function closeMobileDrawer() {
  $('mobileMoreBackdrop').hidden = true;
  $('mobileMoreDrawer').hidden = true;
  $('mobileMoreBtn').setAttribute('aria-expanded', 'false');
}

function updateAnalyticsView() {
  const cycles = buildCycles(state);
  const c = cycles.find(x => x.key === $('analyticsCycleSelect').value) || currentCycle(cycles);
  if ($('analyticsCycleSubtitle') && c) {
    $('analyticsCycleSubtitle').textContent = `${c.monthLabel} · ${fmtDate(c.start)} a ${fmtDate(c.end)}`;
  }
  requestAnimationFrame(() => drawAnalyticsChart(state, c, $('analyticsMetric').value, $('analyticsChartType').value));
}

function switchTab(tabId) {
  closeMobileDrawer();
  document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === tabId));

  const isDrawerTab = ['recorrentes', 'calendario', 'orcamento', 'dados'].includes(tabId);
  if ($('mobileMoreBtn')) $('mobileMoreBtn').classList.toggle('active', isDrawerTab);

  if (tabId === 'resumo') requestAnimationFrame(() => drawSavingsChart(state));
  if (tabId === 'graficos') updateAnalyticsView();
  if (tabId === 'calendario') renderCalendar();
}

const DISMISSED_ALERTS_KEY = 'duofin2-dismissed-alerts-v1';

function getDismissedAlertsMap() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_ALERTS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function isAlertDismissedForCycle(cycleKey, alertId) {
  const map = getDismissedAlertsMap();
  return Array.isArray(map[cycleKey]) && map[cycleKey].includes(alertId);
}

function dismissAlertForCycle(cycleKey, alertId) {
  const map = getDismissedAlertsMap();
  const list = Array.isArray(map[cycleKey]) ? map[cycleKey] : [];
  if (!list.includes(alertId)) list.push(alertId);
  map[cycleKey] = list;
  const keys = Object.keys(map);
  if (keys.length > 12) {
    keys.slice(0, keys.length - 12).forEach(k => delete map[k]);
  }
  try {
    localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(map));
  } catch {}
}

let rolloverPromptOpen = false;

function checkAutomaticCycleRollover() {
  if (rolloverPromptOpen) return;
  if ($('closeCycleModal') && !$('closeCycleModal').hidden) return;
  if ($('appLockOverlay') && !$('appLockOverlay').hidden) return;

  const cycles = buildCycles(state);
  const closedCycles = cycles.filter(c => !c.open && !c.fallback && !c.preCycle);
  if (!closedCycles.length) return;

  const handled = new Set(state.meta?.handled_rollovers || []);
  const latestClosed = closedCycles[closedCycles.length - 1];

  // Check if there is already a closure transaction for this cycle; if its amount is stale (e.g. pre-v2.6.6 credit card rollover bug), update it automatically
  const closureTag = `cycle-close:${latestClosed.key}`;
  const existingClosureTxs = state.transactions.filter(t => !t.deleted_at && t.occurrence_key === closureTag);
  if (existingClosureTxs.length) {
    const realCloseBal = Number(computeCycleBalance(state, latestClosed, latestClosed.end).toFixed(2));
    const currentClosureTx = existingClosureTxs[0];
    const currentSigned = currentClosureTx.type === 'income' ? Number(currentClosureTx.amount) : -Number(currentClosureTx.amount);
    if (Math.abs(realCloseBal - currentSigned) >= 0.01 && currentClosureTx.category === 'Saldo transitado') {
      const [ey, em, ed] = latestClosed.end.split('-').map(Number);
      const nextDayObj = new Date(ey, em - 1, ed + 1);
      const nextCycleStartDate = `${nextDayObj.getFullYear()}-${String(nextDayObj.getMonth() + 1).padStart(2, '0')}-${String(nextDayObj.getDate()).padStart(2, '0')}`;
      if (Math.abs(realCloseBal) < 0.01) {
        currentClosureTx.deleted_at = Date.now();
        currentClosureTx.updated_at = Date.now();
        enqueueOutbox('transactions', currentClosureTx);
      } else {
        currentClosureTx.date = nextCycleStartDate;
        currentClosureTx.type = realCloseBal >= 0 ? 'income' : 'expense';
        currentClosureTx.description = realCloseBal >= 0
          ? `Saldo positivo transitado (${fmtDate(latestClosed.start)} – ${fmtDate(latestClosed.end)})`
          : `Saldo negativo transitado (${fmtDate(latestClosed.start)} – ${fmtDate(latestClosed.end)})`;
        currentClosureTx.amount = Math.abs(realCloseBal);
        currentClosureTx.updated_at = Date.now();
        enqueueOutbox('transactions', currentClosureTx);
      }
      saveLocalState(state);
      sync.flushOutbox();
    }
    if (!handled.has(latestClosed.key)) {
      state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
      state.meta.handled_rollovers = [...handled, latestClosed.key];
      saveLocalState(state);
    }
    return;
  }

  if (handled.has(latestClosed.key)) return;

  const bal = Number(computeCycleBalance(state, latestClosed, latestClosed.end).toFixed(2));
  if (Math.abs(bal) < 0.01) {
    state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
    state.meta.handled_rollovers = [...handled, latestClosed.key];
    saveLocalState(state);
    return;
  }

  // Trigger the cycle closure modal automatically for the closed cycle (ended on the day before the new salary)
  selectedCycleKey = latestClosed.key;
  rolloverPromptOpen = true;
  if (typeof window._openCloseCycleModalFor === 'function') {
    window._openCloseCycleModalFor(latestClosed);
  }
}


function drawResumoDonutChart(catSlices, totalAmount) {
  const panel = $('catsDonutPanel');
  const canvas = $('resumoDonutCanvas');
  const totalEl = $('resumoDonutTotal');
  if (!panel || !canvas || !totalEl) return;

  panel.hidden = false;
  totalEl.textContent = eur(totalAmount || 0);

  const valid = (catSlices || []).filter(s => s.value > 0);
  if (!valid.length || totalAmount <= 0) {
    const dpr0 = Math.min(window.devicePixelRatio || 1, 2);
    const sz0 = 190;
    canvas.width = sz0 * dpr0;
    canvas.height = sz0 * dpr0;
    canvas.style.width = `${sz0}px`;
    canvas.style.height = `${sz0}px`;
    const ctx0 = canvas.getContext('2d');
    ctx0.scale(dpr0, dpr0);
    ctx0.clearRect(0, 0, sz0, sz0);
    ctx0.beginPath();
    ctx0.arc(sz0 / 2, sz0 / 2, 74, 0, Math.PI * 2);
    ctx0.strokeStyle = 'rgba(130, 150, 170, 0.22)';
    ctx0.lineWidth = 22;
    ctx0.stroke();
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 190;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const palette = ['#2B8A64', '#D49B3E', '#1F567D', '#48B888', '#8E6BBF', '#D96B52', '#3A9AB8', '#A68A56'];
  const cx = size / 2;
  const cy = size / 2;
  const radius = 74;
  const lineWidth = 22;
  let startAngle = -Math.PI / 2;

  valid.forEach((slice, idx) => {
    const angle = (slice.value / totalAmount) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, startAngle + angle);
    ctx.strokeStyle = palette[idx % palette.length];
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'butt';
    ctx.stroke();
    startAngle += angle;
  });
}

function render() {
  document.title = `DuoFin 2 ${APP_VERSION} — Gestão financeira a dois`;
  const footerEl = document.querySelector('footer');
  if (footerEl) footerEl.textContent = `DuoFin 2 · ${APP_VERSION} · Gestão financeira a dois`;

  const prefs = loadUiPrefs();
  if ($('resumo')) $('resumo').setAttribute('data-summary-level', prefs.summaryLevel || 'detailed');
  document.querySelectorAll('[data-summary-level-btn]').forEach(btn => {
    const active = btn.dataset.summaryLevelBtn === (prefs.summaryLevel || 'detailed');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  if ($('lockAppHeaderBtn')) $('lockAppHeaderBtn').hidden = !security.hasPin();
  if ($('disablePinBtn')) $('disablePinBtn').hidden = !security.hasPin();
  if ($('lockNowBtn')) $('lockNowBtn').hidden = !security.hasPin();
  if ($('enableBioBtn')) {
    $('enableBioBtn').hidden = !(security.hasPin() && window.PublicKeyCredential);
    $('enableBioBtn').textContent = security.cfg.bioCredId ? '👆 Biometria ativa (Reconfigurar)' : '👆 Ativar Biometria';
  }
  if ($('securityLockStatus')) {
    $('securityLockStatus').textContent = security.hasPin()
      ? `🔒 Bloqueio por PIN ativo${security.cfg.bioCredId ? ' (com Biometria)' : ''} neste dispositivo.`
      : 'Bloqueio por PIN desativado neste dispositivo.';
    $('securityLockStatus').className = 'alert' + (security.hasPin() ? ' good' : '');
  }

  const cycles = buildCycles(state);
  const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
  selectedCycleKey = cycle.key;
  if (!movementCycleKey) movementCycleKey = cycle.key;

  const cycleIdx = cycles.findIndex(c => c.key === cycle.key);
  if ($('prevCycleBtn')) $('prevCycleBtn').disabled = cycleIdx <= 0;
  if ($('nextCycleBtn')) $('nextCycleBtn').disabled = cycleIdx >= cycles.length - 1;

  const mLabel = cycle.monthLabel || computeCycleReferenceMonth(cycle);
  $('monthTitle').textContent = cycle.fallback ? `${mLabel} · provisório` : `Ciclo de ${mLabel}${cycle.open ? ' (em curso)' : ''}`;
  $('cycleRange').textContent = `${fmtDate(cycle.start)} a ${fmtDate(cycle.end)}`;

  const cycleOptionsHtml = cycles
    .slice()
    .reverse()
    .map(c => `<option value="${esc(c.key)}">${esc(c.monthLabel)} (${fmtDate(c.start)} – ${fmtDate(c.end)})</option>`)
    .join('');

  $('cycleSelect').innerHTML = cycleOptionsHtml;
  $('cycleSelect').value = cycle.key;

  $('movementCycle').innerHTML = '<option value="all">Todos os movimentos</option>' + cycleOptionsHtml;
  $('movementCycle').value = movementCycleKey;

  if ($('analyticsCycleSelect')) {
    const prevAna = $('analyticsCycleSelect').value;
    $('analyticsCycleSelect').innerHTML = cycleOptionsHtml;
    $('analyticsCycleSelect').value = cycles.some(c => c.key === prevAna) ? prevAna : cycle.key;
  }

  const today = iso();
  const tx = cycleTransactions(state, cycle).filter(t => t.date <= today);
  const ex = tx.filter(t => t.type === 'expense' && isPaid(t));
  const inc = tx.filter(t => t.type === 'income' && isPaid(t));
  const svIn = tx.filter(t => t.type === 'saving' && isPaid(t));
  const svOut = tx.filter(t => t.type === 'saving_withdraw' && isPaid(t));
  const ccPayItems = tx.filter(t => t.type === 'cc_payment' && isPaid(t));
  const ccPayTotal = sum(ccPayItems);
  const bankExItems = ex.filter(t => !t.credit_card_id);
  const ccExpItems = ex.filter(t => t.credit_card_id);
  const ccExpTotal = sum(ccExpItems);
  const bal = computeCycleBalance(state, cycle, today);

  $('inc').textContent = eur(sum(inc));
  $('exp').textContent = eur(sum(bankExItems) + ccPayTotal);
  $('bal').textContent = eur(bal);
  $('bal').className = bal < 0 ? 'minus' : '';
  $('savm').textContent = eur(sum(svIn) - sum(svOut));

  if ($('ccSpentLine')) {
    const parts = [];
    if (ccExpTotal > 0) parts.push(`💳 Compras a crédito: <strong>${eur(ccExpTotal)}</strong>`);
    if (ccPayTotal > 0) parts.push(`💳 Cartão pago no ciclo: <strong>${eur(ccPayTotal)}</strong>`);
    if (parts.length) {
      $('ccSpentLine').hidden = false;
      $('ccSpentLine').innerHTML = parts.join(' · ');
    } else {
      $('ccSpentLine').hidden = true;
      $('ccSpentLine').innerHTML = '';
    }
  }

  const totalBudget = (state.categories || []).filter(c => !c.deleted_at).reduce((a, c) => a + (Number(c.budget) || 0), 0);
  if ($('basicCycleProgressWrap')) {
    if (prefs.summaryLevel === 'basic' && totalBudget > 0) {
      $('basicCycleProgressWrap').hidden = false;
      const pct = Math.min(100, ((sum(bankExItems) + ccPayTotal) / totalBudget) * 100);
      $('basicCycleProgressBar').style.width = `${pct}%`;
      $('basicCycleProgressLabel').textContent = `${Math.round(pct)}% do orçamento planeado (${eur(totalBudget)})`;
    } else {
      $('basicCycleProgressWrap').hidden = true;
    }
  }

  const burn = computeDailyBurnRate(state, cycle, bal);
  if ($('dailyBurnRateLine')) {
    if (burn) {
      $('dailyBurnRateLine').hidden = false;
      $('dailyBurnRateLine').innerHTML =
        burn.dailyAllowance <= 0
          ? `⚠️ Orçamento diário esgotado (${burn.daysLeft}d até fecho)`
          : `📅 Disponível/dia: <strong>${eur(burn.dailyAllowance)}</strong> (${burn.daysLeft}d)`;
    } else {
      $('dailyBurnRateLine').hidden = true;
    }
  }

  const proj = computeCycleProjection(state, cycle, bal);
  if ($('projectedBalLine')) {
    if (proj && proj.itemCount > 0) {
      $('projectedBalLine').hidden = false;
      $('projectedBalLine').innerHTML = `Previsto no fecho: <strong>${eur(proj.projectedBalance)}</strong>`;
    } else {
      $('projectedBalLine').hidden = true;
    }
  }

  const activeCats = (state.categories || [])
    .filter(c => !c.deleted_at)
    .sort((a, b) => (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999) || String(a.name).localeCompare(String(b.name)));
  const ccStats = getAllCreditCardsStats(state);
  if ($('alerts')) {
    const alertHtml = [];
    for (const c of activeCats) {
      if (c.budget > 0) {
        const paidSpent = sum(bankExItems.filter(t => t.category === c.name));
        const virtSpent = sum(ccExpItems.filter(t => t.category === c.name));
        const spent = paidSpent + virtSpent;
        if (spent > c.budget) {
          const aid = `cat-over:${c.id || c.name}`;
          if (!isAlertDismissedForCycle(cycle.key, aid)) {
            const detailTxt = virtSpent > 0 ? `${eur(paidSpent)} pago + ${eur(virtSpent)} a crédito` : `${eur(spent)}`;
            alertHtml.push(`<div class="alert red alert-dismissible"><span>⚠️ <b>${esc(c.name)}</b> ultrapassou o limite em ${eur(spent - c.budget)} (${detailTxt} / ${eur(c.budget)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
          }
        } else if (spent >= c.budget * 0.85) {
          const aid = `cat-warn:${c.id || c.name}`;
          if (!isAlertDismissedForCycle(cycle.key, aid)) {
            alertHtml.push(`<div class="alert alert-dismissible"><span>⚡ <b>${esc(c.name)}</b> já atingiu ${Math.round((spent / c.budget) * 100)}% do orçamento (${eur(spent)} / ${eur(c.budget)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
          }
        }
      }
    }
    for (const card of ccStats) {
      if (card.limit > 0 && card.debt >= card.limit * 0.8) {
        const aid = `cc-limit:${card.id || card.name}:${card.debt >= card.limit ? 'full' : '80'}`;
        if (!isAlertDismissedForCycle(cycle.key, aid)) {
          alertHtml.push(`<div class="alert ${card.debt >= card.limit ? 'red' : ''} alert-dismissible"><span>💳 Cartão <b>${esc(card.name)}</b> com ${Math.round(card.pct)}% do plafond utilizado (${eur(card.debt)} / ${eur(card.limit)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
        }
      }
    }

    // Alerta proativo de encargos fixos próximos (<= 5 dias) ou vencidos neste ciclo
    const todayIso = iso();
    if (todayIso >= cycle.start && todayIso <= cycle.end) {
      const todayMs = new Date(`${todayIso}T00:00:00`).getTime();
      const dueSoon = [];
      for (const r of (state.recurring_expenses || [])) {
        if (r.deleted_at || r.active === false) continue;
        const cpMap = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
        const entry = cpMap[cycle.key] || {};
        if (entry.paid) continue;
        const dueDate = getSuggestedEncargoDate(cycle, r.day_of_month);
        const dueMs = new Date(`${dueDate}T00:00:00`).getTime();
        const diffDays = Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));
        if (diffDays <= 5) {
          const amt = entry.amount !== undefined && entry.amount !== null && entry.amount !== '' ? Number(entry.amount) : (Number(r.amount) || 0);
          dueSoon.push({ r, dueDate, diffDays, amt });
        }
      }
      if (dueSoon.length > 0) {
        const aid = `encargos-due:${cycle.key}:${dueSoon.map(x => x.r.id).join(',')}`;
        if (!isAlertDismissedForCycle(cycle.key, aid)) {
          const summaryNames = dueSoon
            .slice(0, 3)
            .map(x => `${esc(x.r.description)} (${x.diffDays < 0 ? `dia ${fmtDate(x.dueDate).slice(0, 5)}` : x.diffDays === 0 ? 'hoje' : `em ${x.diffDays}d`}${x.amt > 0 ? ` · ${eur(x.amt)}` : ''})`)
            .join(', ');
          const extraCnt = dueSoon.length > 3 ? ` e +${dueSoon.length - 3}` : '';
          alertHtml.push(`<div class="alert alert-dismissible"><span>🔁 <b>Encargos por pagar:</b> ${summaryNames}${extraCnt}. <button type="button" class="ghost" data-jump-encargos="1" style="padding:2px 8px;font-size:11.5px;margin-left:4px">Abrir Caderno</button></span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta" aria-label="Fechar alerta">✕</button></div>`);
        }
      }
    }

    $('alerts').innerHTML = alertHtml.join('');
  }

  const catRowsHtml = activeCats.map(c => {
    const paidV = sum(bankExItems.filter(t => t.category === c.name));
    const virtV = sum(ccExpItems.filter(t => t.category === c.name));
    const totalV = paidV + virtV;
    const paidPct = c.budget ? Math.min(100, (paidV / c.budget) * 100) : 0;
    const virtPct = c.budget ? Math.min(Math.max(0, 100 - paidPct), (virtV / c.budget) * 100) : 0;
    const cls = c.budget ? (paidV > c.budget ? 'over' : totalV > c.budget ? 'warn' : paidV >= c.budget * 0.85 ? 'warn' : '') : '';
    const virtualNote = virtV > 0 ? `<span class="barline-virtual-note">+ ${eur(virtV)} virtual (créd.)</span>` : '';
    return `<div class="barline">
      <span class="barline-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <div class="bar-dual" title="Pago em conta: ${eur(paidV)}${virtV > 0 ? ` · Virtual a crédito: ${eur(virtV)}` : ''}">
        <i class="bar-paid ${cls}" style="width:${paidPct}%"></i>
        ${virtPct > 0 ? `<i class="bar-virtual" style="width:${virtPct}%"></i>` : ''}
      </div>
      <span class="barline-val barline-val-stack"><b>${eur(paidV)}</b> / ${Math.round(c.budget)}€${virtualNote}</span>
    </div>`;
  });

  if (ccPayTotal > 0) {
    catRowsHtml.push(`<div class="barline" style="padding-top:6px;border-top:1px dashed var(--line)">
      <span class="barline-name" title="Pagamento de cartão de crédito">💳 Pagamento cartão</span>
      <div class="bar-dual"><i class="bar-paid" style="width:100%"></i></div>
      <span class="barline-val barline-val-stack"><b>${eur(ccPayTotal)}</b> <span class="small">pago</span></span>
    </div>`);
  }

  $('cats').innerHTML = catRowsHtml.join('');
  const donutSlices = activeCats
    .map(c => ({
      name: c.name,
      value: sum(bankExItems.filter(t => t.category === c.name)) + sum(ccExpItems.filter(t => t.category === c.name))
    }))
    .filter(s => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (ccPayTotal > 0) donutSlices.push({ name: 'Pagamento cartão', value: ccPayTotal });
  const donutGrandTotal = donutSlices.reduce((acc, s) => acc + s.value, 0);
  drawResumoDonutChart(donutSlices, donutGrandTotal);

  const totalDebt = ccStats.reduce((a, c) => a + c.debt, 0);
  if ($('creditCardsSummaryCard')) {
    $('creditCardsSummaryCard').hidden = ccStats.length === 0;
    $('ccTotalDebtBadge').textContent = `${eur(totalDebt)} em dívida`;
    $('creditCardsSummary').innerHTML = ccStats
      .map(
        c =>
          `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${esc(c.owner)}${c.limit > 0 ? ` · Plafond ${eur(c.limit)}` : ''}</div></div><b class="${c.debt > 0 ? 'minus' : 'plus'}">${eur(c.debt)}</b></div>`
      )
      .join('');
  }
  if ($('ccManagerTotalBadge')) $('ccManagerTotalBadge').textContent = `Dívida total: ${eur(totalDebt)}`;
  if ($('creditCardList')) {
    $('creditCardList').innerHTML = ccStats.length
      ? ccStats
          .map(
            c =>
              `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${esc(c.owner)}${c.limit > 0 ? ` · Plafond ${eur(c.limit)}` : ''} · Dívida atual: <b>${eur(c.debt)}</b></div></div><div class="row" style="gap:6px"><button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-cc="${esc(c.id)}" title="Editar cartão">✎</button><button type="button" class="danger" data-del-cc="${esc(c.id)}">Remover</button></div></div>`
          )
          .join('')
      : '<div class="empty">Sem cartões configurados.</div>';
  }

  const activeGoals = (state.savings_goals || []).filter(g => !g.deleted_at);
  if ($('goalCount')) $('goalCount').textContent = `${activeGoals.length} ativo(s)`;
  if ($('goalsSummary')) {
    $('goalsSummary').innerHTML = activeGoals.length
      ? activeGoals
          .map(g => {
            const saved = goalTotal(state, g.id);
            const hasTarget = Number(g.target) > 0;
            if (!hasTarget) {
              return `<div class="item"><div class="row"><b>${esc(g.name)}</b><span class="small"><b>${eur(saved)}</b> · Fundo livre</span></div></div>`;
            }
            const pct = Math.min(100, (saved / g.target) * 100);
            return `<div class="item"><div class="row"><b>${esc(g.name)}</b><span class="small">${eur(saved)} / ${eur(g.target)} (${Math.round(pct)}%)</span></div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
          })
          .join('')
      : '<div class="empty">Ainda sem objetivos de poupança.</div>';
  }

  if (selectedGoalId && !activeGoals.some(g => String(g.id) === String(selectedGoalId))) {
    selectedGoalId = null;
  }

  $('goalList').innerHTML = activeGoals.length
    ? activeGoals
        .map(g => {
          const saved = goalTotal(state, g.id);
          const hasTarget = Number(g.target) > 0;
          const pct = hasTarget ? Math.min(100, (saved / g.target) * 100) : 0;
          const isSel = String(selectedGoalId) === String(g.id);
          const txCount = (state.transactions || []).filter(t => !t.deleted_at && String(t.goal_id) === String(g.id)).length;
          const badgeHtml = hasTarget ? `<span class="pill">${Math.round(pct)}%</span>` : `<span class="pill">Fundo livre</span>`;
          const amountSub = hasTarget ? `${eur(saved)} / ${eur(g.target)}` : `Acumulado: <b>${eur(saved)}</b>`;
          const progressHtml = hasTarget ? `<div class="progress"><i style="width:${pct}%"></i></div>` : '';
          return `<div class="card goal-card-clickable${isSel ? ' is-selected-goal' : ''}" data-select-goal="${esc(g.id)}" title="Clica para ver os movimentos deste objetivo"><div class="row"><b>${esc(g.name)}</b><div class="row" style="gap:6px">${badgeHtml}<button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-goal="${esc(g.id)}" title="Editar objetivo">✎</button><button type="button" class="danger" data-del-goal="${esc(g.id)}" title="Eliminar objetivo">×</button></div></div><div class="small">${amountSub}${g.deadline ? ` · Meta: ${fmtDate(g.deadline)}` : ''} · ${txCount} mov.</div>${progressHtml}</div>`;
        })
        .join('')
    : '<div class="card empty">Ainda não existem objetivos de poupança.</div>';

  renderGoalMovementsPanel(activeGoals);

  const recent = [...tx]
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, 10);
  $('recent').innerHTML = recent.length
    ? recent.map(renderTxRow).join('')
    : '<div class="empty">Ainda sem movimentos neste ciclo.</div>';

  renderFilteredTransactions(cycles);
  renderQuickTemplates();

  const people = getPeopleList(state);
  const peopleHtml = people.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('person').innerHTML = peopleHtml;
  if ($('qPerson')) $('qPerson').innerHTML = peopleHtml;
  if ($('ccOwner')) $('ccOwner').innerHTML = peopleHtml;
  if ($('recurrencePerson')) $('recurrencePerson').innerHTML = peopleHtml;
  if ($('csvDefaultPerson')) $('csvDefaultPerson').innerHTML = peopleHtml;
  $('filterPerson').innerHTML = '<option value="all">Todos</option>' + peopleHtml;

  const catsHtml = activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('category').innerHTML = catsHtml;
  if ($('qCategory')) $('qCategory').innerHTML = catsHtml;
  if ($('recurrenceCategory')) $('recurrenceCategory').innerHTML = catsHtml;
  if ($('simCategory')) $('simCategory').innerHTML = catsHtml;
  $('filterCategory').innerHTML = '<option value="all">Todas as categorias</option>' + catsHtml;

  populateCreditCardSelects();
  if ($('qCard')) {
    const activeCards = (state.credit_cards || []).filter(c => !c.deleted_at);
    $('qCard').innerHTML = '<option value="">Conta / Débito</option>' +
      activeCards.map(c => `<option value="${esc(c.id)}">💳 ${esc(c.name)}</option>`).join('');
  }
  if ($('qDate') && !$('qDate').value) $('qDate').value = iso();

  $('savingGoal').innerHTML =
    '<option value="">Sem objetivo</option>' + activeGoals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

  if ($('newRuleCategory')) {
    const prevRuleCat = $('newRuleCategory').value;
    $('newRuleCategory').innerHTML = catsHtml;
    if (prevRuleCat && activeCats.some(c => c.name === prevRuleCat)) $('newRuleCategory').value = prevRuleCat;
  }

  $('budgetFields').innerHTML = activeCats
    .map(
      (c, idx) =>
        `<div class="item row cat-edit-row" style="gap:8px;flex-wrap:nowrap">
          <div class="row" style="gap:4px;flex:1 1 auto;min-width:0">
            <button type="button" class="cat-order-btn" data-move-cat="${esc(c.id)}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} title="Subir categoria" aria-label="Subir ${esc(c.name)}">↑</button>
            <button type="button" class="cat-order-btn" data-move-cat="${esc(c.id)}" data-dir="1" ${idx === activeCats.length - 1 ? 'disabled' : ''} title="Descer categoria" aria-label="Descer ${esc(c.name)}">↓</button>
            <input data-cat-name-id="${esc(c.id)}" type="text" maxlength="50" value="${esc(c.name)}" aria-label="Nome da categoria ${esc(c.name)}" style="flex:1 1 auto;min-width:95px;padding:7px 9px;font-weight:600">
          </div>
          <div class="row" style="gap:6px;flex-shrink:0">
            <input data-cat-budget-id="${esc(c.id)}" type="number" min="0" step="0.01" value="${Number(c.budget) || 0}" aria-label="Limite de ${esc(c.name)}" title="Limite por ciclo (€)" style="width:96px;text-align:right;padding:7px 8px">
            <button type="button" class="danger" data-del-cat="${esc(c.id)}" title="Apagar categoria ${esc(c.name)}" aria-label="Apagar categoria ${esc(c.name)}" style="padding:7px 10px;font-size:13px">🗑️</button>
          </div>
        </div>`
    )
    .join('');
  $('budgetTotal').textContent = eur(totalBudget);

  renderCategoryRules();

  $('adult1').value = state.household.adult1_name || 'Adulto 1';
  $('adult2').value = state.household.adult2_name || 'Adulto 2';
  $('cycleGroupingDays').value = state.household.cycle_grouping_days ?? 14;

  renderRecurringSection();
  drawSavingsChart(state);
}

function renderFilteredTransactions(cycles) {
  let list = state.transactions.filter(t => !t.deleted_at);
  if (movementCycleKey && movementCycleKey !== 'all') {
    const cy = cycles.find(c => c.key === movementCycleKey);
    if (cy) list = list.filter(t => t.date >= cy.start && t.date <= cy.end);
  }

  const tp = $('filter').value;
  if (tp === 'expense') list = list.filter(t => t.type === 'expense');
  else if (tp === 'cc_expense') list = list.filter(t => t.type === 'expense' && t.credit_card_id);
  else if (tp !== 'all') list = list.filter(t => t.type === tp);

  const df = $('filterDateFrom').value;
  const dt = $('filterDateTo').value;
  if (df) list = list.filter(t => t.date >= df);
  if (dt) list = list.filter(t => t.date <= dt);

  const q = $('filterSearch').value.trim().toLowerCase();
  if (q) list = list.filter(t => String(t.description || '').toLowerCase().includes(q));

  const cat = $('filterCategory').value;
  if (cat !== 'all') list = list.filter(t => t.category === cat);

  const per = $('filterPerson').value;
  if (per !== 'all') list = list.filter(t => t.person === per);

  if (quickStatusFilter === 'pending') list = list.filter(t => t.status === 'pending');
  else if (quickStatusFilter === 'skipped') list = list.filter(t => t.status === 'skipped');
  else if (quickStatusFilter === 'installments') list = list.filter(t => !!t.installment_group_id);

  const sortDir = $('movementSortOrder') ? $('movementSortOrder').value : 'desc';
  list.sort((a, b) => {
    const cmp = String(a.date || '').localeCompare(String(b.date || ''));
    if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp;
    const ua = Number(a.updated_at || 0);
    const ub = Number(b.updated_at || 0);
    return sortDir === 'asc' ? ua - ub : ub - ua;
  });

  const hasFilters = tp !== 'all' || df || dt || q || cat !== 'all' || per !== 'all' || quickStatusFilter !== 'all';
  $('resetFiltersBtn').hidden = !hasFilters;
  $('filterCountLabel').textContent = `${list.length} movimento(s) · Total: ${eur(sum(list))}`;

  $('transactions').innerHTML = list.length
    ? list.map(renderTxRow).join('')
    : '<div class="empty">Nenhum movimento encontrado com estes filtros.</div>';
}

function renderTxRow(t) {
  const isProj = !!t.isProjected;
  const isVirtualCc = t.type === 'expense' && !!t.credit_card_id;
  const cls = t.type === 'income'
    ? 'plus'
    : isVirtualCc
      ? 'virtual-cc'
      : t.type === 'saving_withdraw' || t.type === 'transfer'
        ? 'neutral'
        : 'minus';
  const sign = t.type === 'income'
    ? '+'
    : t.type === 'saving'
      ? '↗'
      : t.type === 'saving_withdraw'
        ? '↙'
        : t.type === 'transfer'
          ? '⇄'
          : isVirtualCc
            ? '💳'
            : '−';
  const ccBadge = isVirtualCc
    ? '<span class="pill-virtual">Virtual · Cartão</span>'
    : t.type === 'cc_payment'
      ? ' · 💳 Pagamento de cartão'
      : '';
  const statusTag = isProj ? ' · 📋 Caderno de encargos' : t.status === 'pending' ? ' · ⏳ Pendente' : t.status === 'skipped' ? ' · 🚫 Ignorado' : '';
  const clickAttr = isProj ? '' : `data-open-tx="${esc(t.id)}"`;
  const rowCls = isProj
    ? 'item row tx-row-projected'
    : isVirtualCc
      ? 'item row tx-clickable tx-row-virtual-cc'
      : 'item row tx-clickable';
  return `<div class="${rowCls}" ${clickAttr}>
    <div style="min-width:0;flex:1">
      <b>${esc(t.description)}</b>${ccBadge}
      <div class="small">${fmtDate(t.date)} · ${esc(t.category)} · ${esc(t.person)}${statusTag}</div>
    </div>
    <b class="amount ${cls}" style="white-space:nowrap">${sign} ${eur(t.amount)}</b>
  </div>`;
}

function renderCategoryRules() {
  const listEl = $('categoryRulesList');
  const badgeEl = $('autoRulesCountBadge');
  if (!listEl) return;
  const rules = (state.meta?.category_rules || []).slice().sort((a, b) => (b.hits || 0) - (a.hits || 0));
  if (badgeEl) badgeEl.textContent = `${rules.length} regra(s)`;
  if (!rules.length) {
    listEl.innerHTML = '<div class="empty">Ainda sem regras aprendidas ou personalizadas. Adiciona uma acima ou altera categorias ao importar extratos.</div>';
    return;
  }
  listEl.innerHTML = rules
    .map(
      (r, idx) => `<div class="item row" style="gap:8px">
        <div style="min-width:0;flex:1">
          <b>${esc(r.keyword)}</b> → <span class="pill">${esc(r.category)}</span>
          ${r.hits ? `<span class="small" style="margin-left:6px">(${r.hits}x)</span>` : ''}
        </div>
        <button type="button" class="danger" data-del-cat-rule="${idx}" title="Apagar regra">×</button>
      </div>`
    )
    .join('');
}

function renderQuickTemplates() {
  const counts = new Map();
  for (const t of state.transactions) {
    if (t.deleted_at || t.type !== 'expense') continue;
    const key = `${t.description.trim()}|${t.category}`;
    const prev = counts.get(key) || { desc: t.description.trim(), category: t.category, amount: t.amount, n: 0 };
    prev.n++;
    prev.amount = t.amount;
    counts.set(key, prev);
  }
  const top = [...counts.values()].filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 4);
  if (!$('quickTemplatesBar')) return;
  $('quickTemplatesBar').hidden = top.length === 0;
  $('quickTemplatesList').innerHTML = top
    .map(
      (x, idx) =>
        `<button type="button" class="tpl-chip" data-tpl-idx="${idx}">${esc(x.desc)} (${eur(x.amount)})</button>`
    )
    .join('');
  $('quickTemplatesList')._items = top;
}

function getSuggestedEncargoDate(cycle, dayOfMonth) {
  const day = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
  if (!cycle || !cycle.start || !cycle.end) {
    const curM = currentMonth();
    const [y, m] = curM.split('-').map(Number);
    const maxD = new Date(y, m, 0).getDate();
    return `${curM}-${String(Math.min(day, maxD)).padStart(2, '0')}`;
  }
  const [sy, sm] = cycle.start.split('-').map(Number);
  const sMaxD = new Date(sy, sm, 0).getDate();
  const cand1 = `${cycle.start.slice(0, 7)}-${String(Math.min(day, sMaxD)).padStart(2, '0')}`;
  if (cand1 >= cycle.start && cand1 <= cycle.end) return cand1;

  const [ey, em] = cycle.end.split('-').map(Number);
  const eMaxD = new Date(ey, em, 0).getDate();
  const cand2 = `${cycle.end.slice(0, 7)}-${String(Math.min(day, eMaxD)).padStart(2, '0')}`;
  if (cand2 >= cycle.start && cand2 <= cycle.end) return cand2;

  return cycle.start;
}

function renderRecurringSection() {
  const cycles = buildCycles(state);
  const activeCycle = cycles.find(c => c.key === encargosCycleKey) || cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
  if (activeCycle) encargosCycleKey = activeCycle.key;

  const cycleSel = $('encargosCycleSelect');
  if (cycleSel && activeCycle) {
    cycleSel.innerHTML = cycles
      .slice()
      .reverse()
      .map(c => `<option value="${esc(c.key)}">${esc(c.monthLabel)} (${fmtDate(c.start)} – ${fmtDate(c.end)})</option>`)
      .join('');
    cycleSel.value = activeCycle.key;
  }

  const rules = (state.recurring_expenses || []).filter(r => !r.deleted_at && r.active !== false);
  const cycleKey = activeCycle ? activeCycle.key : currentMonth();

  let paidCount = 0;
  let totalPaid = 0;
  let totalExpected = 0;

  const checklistEl = $('encargosChecklist');
  if (checklistEl) {
    if (!rules.length) {
      checklistEl.innerHTML = '<div class="empty">Ainda não tens fornecedores ou serviços no caderno de encargos. Toca em <b>+ Novo serviço</b> para adicionar (ex.: Luz, Água, Telecomunicações).</div>';
    } else {
      checklistEl.innerHTML = rules
        .map(r => {
          const cpMap = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
          const entry = cpMap[cycleKey] || {};
          const isDone = !!entry.paid;
          const amountVal = entry.amount !== undefined && entry.amount !== null && entry.amount !== ''
            ? Number(entry.amount)
            : (Number(r.amount) || 0);
          const dateVal = entry.paidDate || getSuggestedEncargoDate(activeCycle, r.day_of_month);

          totalExpected += amountVal;
          if (isDone) {
            paidCount++;
            totalPaid += amountVal;
          }

          const entityHtml = r.entity
            ? `<button type="button" class="mb-copy-chip" data-copy-mb="${esc(r.entity)}" title="Copiar Entidade">Entidade: <b>${esc(r.entity)}</b> 📋</button>`
            : '';
          const refHtml = r.payment_ref
            ? `<button type="button" class="mb-copy-chip" data-copy-mb="${esc(r.payment_ref)}" title="Copiar Referência">Ref.: <b>${esc(r.payment_ref)}</b> 📋</button>`
            : '';

          return `<div class="encargo-card ${isDone ? 'is-paid' : ''}" data-encargo-id="${esc(r.id)}">
            <div class="encargo-header">
              <div style="min-width:0;flex:1">
                <button type="button" class="encargo-title-btn" data-open-encargo="${esc(r.id)}" title="Ver ficha e editar fornecedor">
                  <span>${esc(r.description)}</span>
                  <span style="font-size:12px;opacity:0.65">ⓘ</span>
                </button>
                <div class="small">${esc(r.category)} · ${esc(r.person)} · Dia habitual: ${r.day_of_month}</div>
              </div>
              <span class="pill" style="cursor:pointer" data-open-encargo="${esc(r.id)}">${isDone ? '✅ Pago' : '⏳ Por pagar'}</span>
            </div>
            ${entityHtml || refHtml ? `<div class="encargo-mb-row">${entityHtml}${refHtml}</div>` : ''}
            <div class="encargo-controls">
              <div>
                <div class="small" style="margin-bottom:2px">Valor (€)</div>
                <input type="number" step="0.01" min="0" data-encargo-amount="${esc(r.id)}" value="${amountVal > 0 ? amountVal.toFixed(2) : ''}" placeholder="0,00">
              </div>
              <div>
                <div class="small" style="margin-bottom:2px">Data pagamento</div>
                <input type="date" data-encargo-date="${esc(r.id)}" value="${esc(dateVal)}">
              </div>
              <label class="encargo-paid-toggle">
                <input type="checkbox" data-encargo-paid="${esc(r.id)}" ${isDone ? 'checked' : ''}>
                <span>Pago</span>
              </label>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  const unpaidCount = Math.max(0, rules.length - paidCount);
  if ($('encargosProgressBadge')) {
    $('encargosProgressBadge').textContent = `${paidCount} / ${rules.length} pagos`;
  }
  if ($('encargosCycleTotals')) {
    $('encargosCycleTotals').textContent = `${eur(totalPaid)} pago / ${eur(totalExpected)} total`;
  }

  ['mobileMoreBadge', 'drawerRecBadge', 'desktopRecBadge'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.hidden = unpaidCount === 0;
    el.textContent = unpaidCount;
  });
}

function renderGoalMovementsPanel(activeGoals) {
  const cardEl = $('goalMovementsCard');
  const titleEl = $('goalMovementsTitle');
  const subEl = $('goalMovementsSubtitle');
  const sumEl = $('goalMovementsSummary');
  const listEl = $('goalMovementsList');
  const quickBtn = $('goalQuickMoveBtn');
  const allBtn = $('goalShowAllMovesBtn');
  if (!cardEl || !listEl) return;

  if (!activeGoals || !activeGoals.length) {
    cardEl.hidden = true;
    return;
  }
  cardEl.hidden = false;

  const selGoal = selectedGoalId
    ? activeGoals.find(g => String(g.id) === String(selectedGoalId))
    : null;

  const goalNameById = new Map(activeGoals.map(g => [String(g.id), g.name]));
  const matchingTx = (state.transactions || [])
    .filter(t => {
      if (t.deleted_at || !t.goal_id) return false;
      if (selGoal) return String(t.goal_id) === String(selGoal.id);
      return goalNameById.has(String(t.goal_id));
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.updated_at || 0) - Number(a.updated_at || 0));

  if (selGoal) {
    titleEl.textContent = `Movimentos — ${selGoal.name}`;
    subEl.textContent = `${matchingTx.length} movimento(s) registado(s) neste objetivo · Toca num movimento para editar`;
    if (quickBtn) quickBtn.hidden = false;
    if (allBtn) allBtn.hidden = activeGoals.length <= 1;
  } else {
    titleEl.textContent = 'Todos os movimentos de objetivos';
    subEl.textContent = 'Clica num cartão de objetivo acima para filtrar apenas os seus movimentos';
    if (quickBtn) quickBtn.hidden = true;
    if (allBtn) allBtn.hidden = true;
  }

  if (!matchingTx.length) {
    if (sumEl) {
      sumEl.hidden = true;
      sumEl.innerHTML = '';
    }
    listEl.innerHTML = selGoal
      ? `<div class="empty">Ainda não existem reforços nem resgates associados a <b>${esc(selGoal.name)}</b>. Toca em <b>+ Reforçar / Resgatar</b> para registar o primeiro.</div>`
      : '<div class="empty">Ainda não existem movimentos associados aos teus objetivos de poupança.</div>';
    return;
  }

  const totalAdded = matchingTx
    .filter(t => t.type === 'saving')
    .reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const totalWithdrawn = matchingTx
    .filter(t => t.type === 'saving_withdraw')
    .reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const netSaved = totalAdded - totalWithdrawn;

  if (sumEl) {
    sumEl.hidden = false;
    sumEl.innerHTML = `
      <div class="day-sum-pill">
        <span class="small">Total reforçado</span>
        <b class="plus">+${eur(totalAdded)}</b>
      </div>
      <div class="day-sum-pill">
        <span class="small">Utilizado / Resgate</span>
        <b class="minus">−${eur(totalWithdrawn)}</b>
      </div>
      <div class="day-sum-pill">
        <span class="small">Saldo acumulado</span>
        <b class="${netSaved >= 0 ? 'plus' : 'minus'}">${eur(netSaved)}</b>
      </div>
    `;
  }

  listEl.innerHTML = `<div class="tx-list-scroll">${matchingTx.map(renderTxRow).join('')}</div>`;
}

function renderCalendar() {
  if ($('calendarMonth')) $('calendarMonth').value = calendarMonthStr;
  const [y, m] = calendarMonthStr.split('-').map(Number);
  const title = new Date(y, m - 1, 2).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
  $('calTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);

  const firstDay = new Date(y, m - 1, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = iso();
  const projectedMonthEvents = getProjectedCalendarEvents(state, calendarMonthStr);

  const weekHeaders = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
    .map(d => `<div class="cal-head">${d}</div>`)
    .join('');

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day is-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calendarMonthStr}-${String(d).padStart(2, '0')}`;
    const realTx = state.transactions.filter(t => !t.deleted_at && t.date === dateStr);
    const projTx = projectedMonthEvents.filter(p => p.date === dateStr);
    const hasFutureScheduled = realTx.some(t => t.date > today);
    const hasExp = realTx.some(t => t.type === 'expense' && t.date <= today);
    const hasInc = realTx.some(t => t.type === 'income');
    const hasSav = realTx.some(t => t.type === 'saving' || t.type === 'saving_withdraw');
    const hasProj = projTx.length > 0 || hasFutureScheduled;
    const dots =
      (hasExp ? '<i class="dot dot-exp"></i>' : '') +
      (hasInc ? '<i class="dot dot-inc"></i>' : '') +
      (hasSav ? '<i class="dot dot-sav"></i>' : '') +
      (hasProj ? '<i class="dot dot-proj"></i>' : '');
    const cls = `cal-day${dateStr === today ? ' is-today' : ''}${dateStr === selectedCalendarDay ? ' is-selected' : ''}${hasProj ? ' has-projected' : ''}`;
    cells += `<div class="${cls}" data-cal-day="${dateStr}"><strong>${d}</strong><div class="cal-dots">${dots}</div></div>`;
  }

  $('calendar').innerHTML = weekHeaders + cells;
  if ($('calScopeToggleBtn')) {
    $('calScopeToggleBtn').textContent = calScopeMode === 'month' ? '📅 Ver só o dia' : '📋 Ver mês inteiro';
  }
  let items = [];
  if (calScopeMode === 'month') {
    $('dayTitle').textContent = `Movimentos de ${title}`;
    const realMonth = state.transactions
      .filter(t => !t.deleted_at && String(t.date || '').startsWith(calendarMonthStr))
      .sort((a, b) => a.date.localeCompare(b.date));
    items = [...realMonth, ...projectedMonthEvents].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  } else {
    $('dayTitle').textContent = `Movimentos de ${fmtDate(selectedCalendarDay)}`;
    const selMonth = selectedCalendarDay.slice(0, 7);
    const selProjected = selMonth === calendarMonthStr
      ? projectedMonthEvents.filter(p => p.date === selectedCalendarDay)
      : getProjectedCalendarEvents(state, selMonth).filter(p => p.date === selectedCalendarDay);
    items = [
      ...state.transactions.filter(t => !t.deleted_at && t.date === selectedCalendarDay),
      ...selProjected
    ];
  }

  const daySummaryEl = $('daySummary');
  if (daySummaryEl) {
    if (!items.length) {
      daySummaryEl.hidden = true;
      daySummaryEl.innerHTML = '';
    } else {
      const validItems = items.filter(t => t.status !== 'skipped');
      const dayInc = sum(validItems.filter(t => t.type === 'income'));
      const dayExp = sum(validItems.filter(t => t.type === 'expense'));
      const dayNet = dayInc - dayExp;
      daySummaryEl.hidden = false;
      daySummaryEl.innerHTML = `
        <div class="day-sum-pill">
          <span class="small">Receitas</span>
          <b class="plus">+${eur(dayInc)}</b>
        </div>
        <div class="day-sum-pill">
          <span class="small">Despesas</span>
          <b class="minus">−${eur(dayExp)}</b>
        </div>
        <div class="day-sum-pill">
          <span class="small">${calScopeMode === 'month' ? 'Saldo do mês' : 'Saldo do dia'}</span>
          <b class="${dayNet > 0 ? 'plus' : dayNet < 0 ? 'minus' : ''}">${dayNet > 0 ? '+' : ''}${eur(dayNet)}</b>
        </div>
      `;
    }
  }

  $('dayItems').innerHTML = items.length ? items.map(renderTxRow).join('') : calScopeMode === 'month' ? '<div class="empty">Sem movimentos neste mês.</div>' : '<div class="empty">Sem movimentos neste dia.</div>';
}

function openTxDetailModal(txId) {
  const tx = state.transactions.find(t => String(t.id) === String(txId));
  if (!tx) return;
  $('modalTxId').value = tx.id;
  $('txModalReadView').hidden = false;
  $('txModalEditForm').hidden = true;

  const typeLabels = {
    expense: 'Despesa',
    cc_payment: 'Pagamento de cartão de crédito',
    income: 'Rendimento',
    saving: 'Poupança transferida',
    saving_withdraw: 'Resgate de poupança',
    transfer: 'Transferência interna entre contas'
  };
  const icons = { expense: '💸', cc_payment: '💳', income: '💰', saving: '🎯', saving_withdraw: '🏦', transfer: '🔁' };
  $('txModalIcon').textContent = icons[tx.type] || '🧾';
  $('txModalAmountDisplay').textContent = eur(tx.amount);
  $('txModalAmountDisplay').className = 'tx-modal-amount ' + (tx.type === 'income' ? 'plus' : tx.type === 'expense' ? 'minus' : 'neutral');
  $('txModalDescDisplay').textContent = tx.description;
  $('txModalDateDisplay').textContent = fmtDate(tx.date);
  $('txModalTypeDisplay').textContent = typeLabels[tx.type] || tx.type;
  $('txModalCatDisplay').textContent = tx.category;
  $('txModalPersonDisplay').textContent = tx.person;
  $('txModalSubtitle').textContent = tx.status === 'pending' ? 'Estado: Pendente' : 'Estado: Confirmado';

  const instBox = $('txModalInstallmentBox');
  if (instBox) {
    if (tx.installment_group_id) {
      const today = iso();
      const groupTxs = state.transactions
        .filter(t => !t.deleted_at && t.installment_group_id === tx.installment_group_id)
        .sort((a, b) => a.date.localeCompare(b.date));
      const futureTxs = groupTxs.filter(t => t.date > today);
      const paidCount = groupTxs.length - futureTxs.length;
      const remainingTotal = sum(futureTxs);
      instBox.hidden = false;
      $('txModalInstProgressBadge').textContent = `${paidCount}/${groupTxs.length} pagas`;
      $('txModalInstSummaryText').textContent = futureTxs.length
        ? `Faltam ${futureTxs.length} prestação(ões) futura(s) · Total em dívida: ${eur(remainingTotal)}`
        : 'Todas as prestações deste plano já venceram.';
      $('txModalSettleInstBtn').hidden = futureTxs.length === 0;
      $('txModalDeleteFutureInstBtn').hidden = futureTxs.length === 0;
    } else {
      instBox.hidden = true;
    }
  }

  $('txDetailModal').hidden = false;
}

function populateCreditCardSelects(selectedCardId = null) {
  const cards = (state.credit_cards || []).filter(c => !c.deleted_at);
  const methodHtml =
    '<option value="bank">Conta à ordem / Débito / Dinheiro</option>' +
    cards.map(c => `<option value="cc:${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');
  const paymentHtml =
    '<option value="">Selecionar cartão…</option>' +
    cards.map(c => `<option value="${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');

  if ($('paymentMethod')) {
    const prev = $('paymentMethod').value;
    $('paymentMethod').innerHTML = methodHtml;
    if (prev && Array.from($('paymentMethod').options).some(o => o.value === prev)) {
      $('paymentMethod').value = prev;
    }
  }
  if ($('ccPaymentCard')) {
    const prev = $('ccPaymentCard').value;
    $('ccPaymentCard').innerHTML = paymentHtml;
    if (prev && Array.from($('ccPaymentCard').options).some(o => o.value === prev)) {
      $('ccPaymentCard').value = prev;
    } else if (cards.length === 1) {
      $('ccPaymentCard').value = String(cards[0].id);
    }
  }
  if ($('modalEditPaymentMethod')) {
    $('modalEditPaymentMethod').innerHTML = methodHtml;
    $('modalEditPaymentMethod').value = selectedCardId ? `cc:${selectedCardId}` : 'bank';
  }
  if ($('modalEditCcPaymentCard')) {
    const prevModal = $('modalEditCcPaymentCard').value;
    $('modalEditCcPaymentCard').innerHTML = paymentHtml;
    const targetVal = selectedCardId || prevModal || (cards.length === 1 ? String(cards[0].id) : '');
    if (targetVal && Array.from($('modalEditCcPaymentCard').options).some(o => String(o.value) === String(targetVal))) {
      $('modalEditCcPaymentCard').value = String(targetVal);
    }
  }
}

function switchModalToEdit() {
  const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
  if (!tx) return;
  $('txModalReadView').hidden = true;
  $('txModalEditForm').hidden = false;

  $('modalEditDate').value = tx.date;
  $('modalEditType').value = tx.type;
  $('modalEditDesc').value = tx.description;
  $('modalEditAmount').value = tx.amount;
  $('modalEditCat').innerHTML = $('category').innerHTML;
  $('modalEditCat').value = tx.category;
  $('modalEditPerson').innerHTML = $('person').innerHTML;
  $('modalEditPerson').value = tx.person;
  $('modalEditCountsCycle').checked = tx.counts_for_cycle !== false;

  if ($('modalEditTransferFrom') && $('modalEditTransferTo')) {
    $('modalEditTransferFrom').innerHTML = $('person').innerHTML;
    $('modalEditTransferTo').innerHTML = $('person').innerHTML;
    const parts = String(tx.person || '').split('→').map(s => s.trim());
    if (parts.length === 2) {
      $('modalEditTransferFrom').value = parts[0];
      $('modalEditTransferTo').value = parts[1];
    }
  }

  populateCreditCardSelects(tx.credit_card_id || null);
  $('modalEditGoal').innerHTML = $('savingGoal').innerHTML;
  $('modalEditGoal').value = tx.goal_id || '';

  updateModalEditVisibility();
}

function updateModalEditVisibility() {
  const tp = $('modalEditType').value;
  if (tp === 'cc_payment' || tp === 'expense') {
    const curVal = tp === 'cc_payment'
      ? $('modalEditCcPaymentCard').value
      : ($('modalEditPaymentMethod').value.startsWith('cc:') ? $('modalEditPaymentMethod').value.slice(3) : null);
    populateCreditCardSelects(curVal || null);
  }
  $('modalEditCatWrap').hidden = tp !== 'expense';
  $('modalEditPaymentMethodWrap').hidden = tp !== 'expense';
  $('modalEditCcPaymentWrap').hidden = tp !== 'cc_payment';
  $('modalEditGoalWrap').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
  $('modalEditIncomeCycleWrap').hidden = tp !== 'income';
  if ($('modalEditTransferWrap')) $('modalEditTransferWrap').hidden = tp !== 'transfer';
}

function runImpactSimulator() {
  const amount = Number($('simAmount').value) || 0;
  const n = Math.max(1, Number($('simInstallments').value) || 1);
  const desc = $('simDesc').value.trim() || 'Compra simulada';
  const box = $('simResultBox');
  const actions = $('simActions');
  if (amount <= 0) {
    box.hidden = true;
    actions.hidden = true;
    return;
  }
  const perMonth = amount / n;
  const cycles = buildCycles(state);
  const cur = currentCycle(cycles);
  const curBal = computeCycleBalance(state, cur, iso());
  const newBal = curBal - perMonth;

  box.hidden = false;
  actions.hidden = false;
  box.innerHTML = `
    <div><strong>${esc(desc)}</strong>: ${n > 1 ? `${n}x de <b>${eur(perMonth)}</b>/ciclo` : `<b>${eur(amount)}</b> a pronto`}</div>
    <div style="margin-top:6px">Saldo atual do ciclo: <b>${eur(curBal)}</b> → Após impacto: <b class="${newBal < 0 ? 'minus' : 'plus'}">${eur(newBal)}</b></div>
  `;
}


async function initStorageProtectionAndBackupReminder() {
  const statusEl = $('storagePersistenceStatus');
  const reminderEl = $('backupReminderLine');
  const lastBackup = localStorage.getItem('duofin2_last_backup_date');

  if (reminderEl) {
    if (!lastBackup) {
      reminderEl.textContent = '⚠️ Ainda não fizeste nenhuma cópia de segurança JSON neste dispositivo.';
    } else {
      const days = Math.floor((Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60 * 24));
      if (days === 0) {
        reminderEl.textContent = '✅ Última cópia de segurança exportada hoje.';
      } else if (days >= 30) {
        reminderEl.style.color = 'var(--amber, #b45309)';
        reminderEl.textContent = `⚠️ Última cópia de segurança há ${days} dias (${fmtDate(lastBackup.slice(0, 10))}). Recomendamos exportar um novo ficheiro JSON.`;
      } else {
        reminderEl.textContent = `ℹ️ Última cópia de segurança há ${days} dia(s) (${fmtDate(lastBackup.slice(0, 10))}).`;
      }
    }
  }

  if (!statusEl) return;

  let persisted = false;
  if (navigator.storage && navigator.storage.persist) {
    try {
      persisted = await navigator.storage.persisted();
      if (!persisted) {
        persisted = await navigator.storage.persist();
      }
    } catch (_) {}
  }

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  if (sync.householdId) {
    statusEl.className = 'alert good';
    statusEl.innerHTML = '☁️ <b>Proteção máxima ativa:</b> Os teus dados estão sincronizados na nuvem (Supabase). Mesmo que limpes o navegador, basta iniciar sessão para recuperar tudo.';
  } else if (isStandalone && persisted) {
    statusEl.className = 'alert good';
    statusEl.innerHTML = '📱 <b>App instalada com armazenamento protegido:</b> Os dados estão isolados do histórico normal do navegador. Ativa também a nuvem Supabase acima para backup automático.';
  } else {
    statusEl.className = 'alert';
    statusEl.innerHTML = '⚠️ <b>Atenção no telemóvel:</b> Estás a usar o DuoFin apenas em modo local no navegador. Se limparas os dados de navegação do Safari/Chrome, o histórico local será apagado. <b>Solução:</b> Instala a app no ecrã principal e liga a sincronização Supabase acima.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyThemeAndDensity(() => drawSavingsChart(state));
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyThemeAndDensity(() => drawSavingsChart(state));
    });
  }

  $('date').value = iso();
  const cfg = sync.getConfig();
  $('sbUrl').value = cfg.url || '';
  $('sbKey').value = cfg.anonKey || '';

  $('themeQuickToggleBtn').onclick = () => {
    const order = ['auto', 'light', 'dark'];
    const cur = loadUiPrefs().theme || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    saveUiPrefs({ theme: next });
    applyThemeAndDensity(() => drawSavingsChart(state));
    showToast(`Tema: ${next === 'dark' ? 'Escuro' : next === 'light' ? 'Claro' : 'Automático'}`);
  };
  $('themeMode').onchange = e => {
    saveUiPrefs({ theme: e.target.value });
    applyThemeAndDensity(() => drawSavingsChart(state));
  };
  $('densityMode').onchange = e => {
    saveUiPrefs({ density: e.target.value });
    applyThemeAndDensity();
  };

  document.querySelectorAll('nav button[data-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });
  $('mobileMoreBtn').onclick = openMobileDrawer;
  $('closeMobileMoreBtn').onclick = closeMobileDrawer;
  $('mobileMoreBackdrop').onclick = closeMobileDrawer;
  document.querySelectorAll('[data-drawer-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.drawerTab);
  });

  function openAddTxModal(focusField = true) {
    const modal = $('addTxModal');
    if (!modal) return;
    if (!$('date').value) $('date').value = iso();
    modal.hidden = false;
    if (focusField && $('desc')) {
      setTimeout(() => $('desc').focus(), 40);
    }
  }

  function closeAddTxModal() {
    const modal = $('addTxModal');
    if (modal) modal.hidden = true;
  }

  $('quickAddFab').onclick = () => openAddTxModal(true);
  if ($('viewAllCycleTxBtn')) {
    $('viewAllCycleTxBtn').onclick = () => {
      movementCycleKey = selectedCycleKey || 'all';
      switchTab('movimentos');
    };
  }
  if ($('goalShowAllMovesBtn')) {
    $('goalShowAllMovesBtn').onclick = () => {
      selectedGoalId = null;
      render();
    };
  }
  if ($('goalQuickMoveBtn')) {
    $('goalQuickMoveBtn').onclick = () => {
      openAddTxModal(true);
      if ($('type')) {
        $('type').value = 'saving';
        $('type').dispatchEvent(new Event('change'));
      }
      if ($('savingGoal') && selectedGoalId) {
        $('savingGoal').value = selectedGoalId;
      }
    };
  }
  document.addEventListener('click', e => {
    if (e.target.closest('[data-jump-encargos]')) {
      encargosCycleKey = selectedCycleKey;
      switchTab('recorrentes');
    }
  });
  if ($('openNewTxModalBtn')) {
    $('openNewTxModalBtn').onclick = () => openAddTxModal(true);
  }
  if ($('closeAddTxModalBtn')) {
    $('closeAddTxModalBtn').onclick = closeAddTxModal;
  }
  if ($('cancelAddTxModalBtn')) {
    $('cancelAddTxModalBtn').onclick = closeAddTxModal;
  }
  if ($('addTxModal')) {
    $('addTxModal').onclick = e => {
      if (e.target === $('addTxModal')) closeAddTxModal();
    };
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('addTxModal') && !$('addTxModal').hidden) {
      closeAddTxModal();
    }
  });

  document.querySelectorAll('[data-summary-level-btn]').forEach(btn => {
    btn.onclick = () => {
      saveUiPrefs({ summaryLevel: btn.dataset.summaryLevelBtn });
      render();
    };
  });
  document.querySelectorAll('[data-accordion-card]').forEach(card => {
    const header = card.querySelector('.accordion-header') || card;
    header.addEventListener('click', e => {
      if (e.target.closest('button,select,input')) return;
      card.classList.toggle('is-collapsed');
    });
  });

  $('cycleSelect').onchange = e => {
    selectedCycleKey = e.target.value;
    movementCycleKey = e.target.value;
    render();
  };
  $('prevCycleBtn').onclick = () => {
    const cycles = buildCycles(state);
    const idx = cycles.findIndex(c => c.key === selectedCycleKey);
    if (idx > 0) {
      selectedCycleKey = cycles[idx - 1].key;
      render();
    }
  };
  $('nextCycleBtn').onclick = () => {
    const cycles = buildCycles(state);
    const idx = cycles.findIndex(c => c.key === selectedCycleKey);
    if (idx >= 0 && idx < cycles.length - 1) {
      selectedCycleKey = cycles[idx + 1].key;
      render();
    }
  };
  $('openSimulatorShortcutBtn').onclick = () => {
    switchTab('orcamento');
    $('simDesc').focus();
  };

  // --- Fecho de Ciclo (Encerra no dia anterior ao novo vencimento e pergunta destino do remanescente) ---
  function markCycleRolloverHandled(cycleKey) {
    state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
    const set = new Set(state.meta.handled_rollovers || []);
    set.add(cycleKey);
    state.meta.handled_rollovers = [...set];
    state.meta.updated_at = Date.now();
    saveLocalState(state);
    if (sync.householdId) {
      enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
    }
  }

  function openCloseCycleModal(explicitCycle = null) {
    const cycles = buildCycles(state);
    const cycle = explicitCycle || cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
    $('closeCycleModal').dataset.targetCycleKey = cycle.key;
    const bal = Number(computeCycleBalance(state, cycle, cycle.end).toFixed(2));

    $('closeCycleSubtitle').textContent = `${cycle.monthLabel} (${fmtDate(cycle.start)} a ${fmtDate(cycle.end)})`;

    const alertBox = $('closeCycleAlertBox');
    const expText = $('closeCycleExplanation');
    const posOpts = $('closeCyclePositiveOptions');
    const confirmBtn = $('confirmCloseCycleBtn');

    if (Math.abs(bal) < 0.01) {
      alertBox.className = 'alert good';
      alertBox.innerHTML = `Saldo final do ciclo: <b>0,00 €</b>`;
      expText.textContent = 'Este ciclo está perfeitamente saldado (0,00 €). Não há saldo remanescente a transitar.';
      posOpts.hidden = true;
      confirmBtn.hidden = true;
    } else if (bal < 0) {
      confirmBtn.hidden = false;
      alertBox.className = 'alert red';
      alertBox.innerHTML = `Saldo final negativo: <b>${eur(bal)}</b>`;
      expText.textContent = 'Como o saldo é negativo, este défice transitará automaticamente para o início do ciclo seguinte para manter o saldo bancário reconciliado.';
      posOpts.hidden = true;
    } else {
      confirmBtn.hidden = false;
      alertBox.className = 'alert good';
      alertBox.innerHTML = `Saldo bancário real no fecho (sobra): <b>+${eur(bal)}</b>`;
      expText.textContent = 'Compras a crédito não abatidas mantêm-se na dívida do cartão sem reduzir o dinheiro em conta. Escolhe o destino desta sobra bancária:';
      posOpts.hidden = false;
      const defaultRadio = document.querySelector('input[name="cycleCloseAction"][value="carryover"]');
      if (defaultRadio) defaultRadio.checked = true;
      $('closeCycleGoalWrap').hidden = true;
      const activeGoals = (state.savings_goals || []).filter(g => !g.deleted_at);
      $('closeCycleGoalSelect').innerHTML =
        '<option value="">Poupança geral (sem objetivo específico)</option>' +
        activeGoals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
    }

    $('closeCycleModal').hidden = false;
  }

  window._openCloseCycleModalFor = openCloseCycleModal;
  if ($('closeCycleBtn')) $('closeCycleBtn').onclick = () => openCloseCycleModal();
  function dismissCloseCycleModal() {
    const targetKey = $('closeCycleModal').dataset.targetCycleKey;
    if (targetKey) markCycleRolloverHandled(targetKey);
    $('closeCycleModal').hidden = true;
    rolloverPromptOpen = false;
  }
  if ($('closeCycleModalXBtn')) $('closeCycleModalXBtn').onclick = dismissCloseCycleModal;
  if ($('cancelCloseCycleBtn')) $('cancelCloseCycleBtn').onclick = dismissCloseCycleModal;
  if ($('closeCycleModal')) {
    $('closeCycleModal').onclick = e => {
      if (e.target === $('closeCycleModal')) dismissCloseCycleModal();
    };
  }

  document.querySelectorAll('input[name="cycleCloseAction"]').forEach(radio => {
    radio.onchange = () => {
      $('closeCycleGoalWrap').hidden = radio.value !== 'savings';
    };
  });

  if ($('confirmCloseCycleBtn')) {
    $('confirmCloseCycleBtn').onclick = () => {
      const cycles = buildCycles(state);
      const targetKey = $('closeCycleModal').dataset.targetCycleKey || selectedCycleKey;
      const cycle = cycles.find(c => c.key === targetKey) || currentCycle(cycles);
      const bal = Number(computeCycleBalance(state, cycle, cycle.end).toFixed(2));
      if (Math.abs(bal) < 0.01) {
        $('closeCycleModal').hidden = true;
        return;
      }

      const [ey, em, ed] = cycle.end.split('-').map(Number);
      const nextDayObj = new Date(ey, em - 1, ed + 1);
      const nextCycleStartDate = `${nextDayObj.getFullYear()}-${String(nextDayObj.getMonth() + 1).padStart(2, '0')}-${String(nextDayObj.getDate()).padStart(2, '0')}`;

      const closureTag = `cycle-close:${cycle.key}`;
      for (const oldTx of state.transactions) {
        if (!oldTx.deleted_at && oldTx.occurrence_key === closureTag) {
          oldTx.deleted_at = Date.now();
          oldTx.updated_at = Date.now();
          enqueueOutbox('transactions', oldTx);
        }
      }

      if (bal < 0) {
        const carryTx = {
          id: uid('carry'),
          date: nextCycleStartDate,
          type: 'expense',
          description: `Saldo negativo transitado (${fmtDate(cycle.start)} – ${fmtDate(cycle.end)})`,
          amount: Math.abs(bal),
          category: 'Saldo transitado',
          person: 'Conta conjunta',
          status: 'confirmed',
          occurrence_key: closureTag,
          counts_for_cycle: false,
          updated_at: Date.now()
        };
        state.transactions.push(carryTx);
        enqueueOutbox('transactions', carryTx);
        showToast(`Défice de ${eur(bal)} transitado para o ciclo seguinte.`, { type: 'success' });
      } else {
        const action = document.querySelector('input[name="cycleCloseAction"]:checked')?.value || 'carryover';
        if (action === 'carryover') {
          const carryTx = {
            id: uid('carry'),
            date: nextCycleStartDate,
            type: 'income',
            description: `Saldo positivo transitado (${fmtDate(cycle.start)} – ${fmtDate(cycle.end)})`,
            amount: bal,
            category: 'Saldo transitado',
            person: 'Conta conjunta',
            status: 'confirmed',
            occurrence_key: closureTag,
            counts_for_cycle: false,
            updated_at: Date.now()
          };
          state.transactions.push(carryTx);
          enqueueOutbox('transactions', carryTx);
          showToast(`Sobra de +${eur(bal)} transitada para o ciclo seguinte!`, { type: 'success' });
        } else {
          const goalId = $('closeCycleGoalSelect').value || null;
          const savTx = {
            id: uid('sav-close'),
            date: cycle.end,
            type: 'saving',
            description: `Sobra de ciclo transferida para Poupança (${fmtDate(cycle.end)})`,
            amount: bal,
            category: 'Poupança',
            person: 'Conta conjunta',
            goal_id: goalId,
            status: 'confirmed',
            occurrence_key: closureTag,
            counts_for_cycle: false,
            updated_at: Date.now()
          };
          state.transactions.push(savTx);
          enqueueOutbox('transactions', savTx);
          showToast(`Sobra de +${eur(bal)} atribuída a Poupança!`, { type: 'success' });
        }
      }

      markCycleRolloverHandled(cycle.key);
      saveLocalState(state);
      $('closeCycleModal').hidden = true;
      rolloverPromptOpen = false;
      const latestCycles = buildCycles(state);
      selectedCycleKey = currentCycle(latestCycles).key;
      render();
      sync.flushOutbox();
    };
  }

  $('amount').oninput = () => {
    const raw = $('amount').value;
    const val = evaluateAmountExpression(raw);
    const badge = $('calcPreviewBadge');
    if (/[+\-*/()]/.test(raw) && Number.isFinite(val)) {
      badge.hidden = false;
      badge.textContent = `= ${eur(val)}`;
    } else {
      badge.hidden = true;
    }
  };
  document.querySelectorAll('[data-calc-op]').forEach(btn => {
    btn.onclick = () => {
      const targetId = btn.dataset.calcTarget || 'amount';
      const inp = $(targetId);
      if (inp) {
        inp.value += ` ${btn.dataset.calcOp} `;
        inp.focus();
      }
    };
  });
  $('calcEvalBtn').onclick = () => {
    const val = evaluateAmountExpression($('amount').value);
    if (Number.isFinite(val)) {
      $('amount').value = val.toFixed(2);
      $('calcPreviewBadge').hidden = true;
    }
  };
  if ($('modalCalcEvalBtn')) {
    $('modalCalcEvalBtn').onclick = () => {
      const val = evaluateAmountExpression($('modalEditAmount').value);
      if (Number.isFinite(val)) $('modalEditAmount').value = val.toFixed(2);
    };
  }

  $('type').onchange = () => {
    const tp = $('type').value;
    if (tp === 'cc_payment' || tp === 'expense') populateCreditCardSelects();
    $('categoryField').hidden = tp !== 'expense';
    $('installmentsField').hidden = tp !== 'expense';
    $('expensePaymentMethodField').hidden = tp !== 'expense';
    $('ccPaymentField').hidden = tp !== 'cc_payment';
    $('savingGoalField').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
    $('incomeCycleField').hidden = tp !== 'income';
    if ($('transferAccountsField')) {
      $('transferAccountsField').hidden = tp !== 'transfer';
      if (tp === 'transfer') {
        $('transferFrom').innerHTML = $('person').innerHTML;
        $('transferTo').innerHTML = $('person').innerHTML;
        if ($('transferTo').options.length > 2) $('transferTo').selectedIndex = 2;
      }
    }
  };
  $('paymentMethod').onchange = () => {
    $('expenseCcHint').hidden = !$('paymentMethod').value.startsWith('cc:');
  };
  $('isInstallment').onchange = () => {
    $('installmentsOptions').hidden = !$('isInstallment').checked;
  };
  $('desc').oninput = () => {
    if ($('type').value === 'expense' && $('desc').value.trim().length >= 3) {
      const guessed = guessCategory(state, $('desc').value);
      $('category').value = guessed;
      $('categoryAutoHint').textContent = `(${guessed})`;
    }
  };

  $('txForm').onsubmit = e => {
    e.preventDefault();
    const rawAmount = evaluateAmountExpression($('amount').value);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      alert('Introduz um valor válido.');
      return;
    }
    const tp = $('type').value;
    let ccId = null;
    if (tp === 'expense' && $('paymentMethod').value.startsWith('cc:')) {
      ccId = $('paymentMethod').value.slice(3);
    } else if (tp === 'cc_payment') {
      ccId = $('ccPaymentCard').value || null;
      if (!ccId) {
        alert('Seleciona o cartão de crédito.');
        return;
      }
    }

    const isInst = tp === 'expense' && $('isInstallment').checked;
    const count = isInst ? Math.max(2, Math.min(60, Math.round(Number($('installmentCount').value) || 2))) : 1;
    const mode = $('installmentAmountMode').value;
    const groupId = isInst ? uid('inst') : null;
    const baseDate = $('date').value;
    const baseDesc = $('desc').value.trim();

    for (let i = 0; i < count; i++) {
      let partAmt = rawAmount;
      if (isInst && mode === 'total') {
        const baseCent = Math.floor((rawAmount * 100) / count);
        const rem = Math.round(rawAmount * 100) - baseCent * count;
        partAmt = (baseCent + (i < rem ? 1 : 0)) / 100;
      }
      const tx = {
        id: uid('tx'),
        date: i === 0 ? baseDate : addMonthsClamp(baseDate, i),
        type: tp,
        description: isInst ? `${baseDesc} (${i + 1}/${count})` : baseDesc,
        amount: Number(partAmt.toFixed(2)),
        category: tp === 'expense' ? $('category').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : tp === 'transfer' ? 'Transferência interna' : 'Poupança',
        person: tp === 'transfer' && $('transferFrom') && $('transferTo') ? `${$('transferFrom').value} → ${$('transferTo').value}` : $('person').value,
        status: 'confirmed',
        credit_card_id: ccId,
        goal_id: tp === 'saving' || tp === 'saving_withdraw' ? $('savingGoal').value || null : null,
        installment_group_id: groupId,
        counts_for_cycle: tp === 'income' ? $('incomeCountsForCycle').checked : true,
        updated_at: Date.now()
      };
      state.transactions.push(tx);
      enqueueOutbox('transactions', tx);
    }

    saveLocalState(state);
    $('txForm').reset();
    $('date').value = iso();
    $('calcPreviewBadge').hidden = true;
    $('categoryAutoHint').textContent = '';
    $('installmentsOptions').hidden = true;
    $('type').dispatchEvent(new Event('change'));
    closeAddTxModal();
    render();
    sync.flushOutbox();
    haptic([14, 25, 14]);
    showToast(isInst ? `${count} prestações registadas e sincronizadas!` : 'Movimento guardado e sincronizado.', { type: 'success' });
    checkAutomaticCycleRollover();
  };

  ['movementCycle', 'filter', 'filterDateFrom', 'filterDateTo', 'filterSearch', 'filterCategory', 'filterPerson', 'movementSortOrder'].forEach(id => {
    $(id).addEventListener('input', () => {
      if (id === 'movementCycle') movementCycleKey = $('movementCycle').value;
      renderFilteredTransactions(buildCycles(state));
    });
  });
  document.querySelectorAll('[data-quick-status]').forEach(btn => {
    btn.onclick = () => {
      quickStatusFilter = btn.dataset.quickStatus;
      document.querySelectorAll('[data-quick-status]').forEach(b => b.classList.toggle('active', b === btn));
      renderFilteredTransactions(buildCycles(state));
    };
  });
  $('resetFiltersBtn').onclick = () => {
    $('filter').value = 'all';
    $('filterDateFrom').value = '';
    $('filterDateTo').value = '';
    $('filterSearch').value = '';
    $('filterCategory').value = 'all';
    $('filterPerson').value = 'all';
    quickStatusFilter = 'all';
    document.querySelectorAll('[data-quick-status]').forEach(b => b.classList.toggle('active', b.dataset.quickStatus === 'all'));
    renderFilteredTransactions(buildCycles(state));
  };

  document.addEventListener('click', e => {
    const openTx = e.target.closest('[data-open-tx]');
    if (openTx) {
      openTxDetailModal(openTx.dataset.openTx);
      return;
    }

    const tplBtn = e.target.closest('[data-tpl-idx]');
    if (tplBtn) {
      const item = $('quickTemplatesList')._items?.[Number(tplBtn.dataset.tplIdx)];
      if (item) {
        $('type').value = 'expense';
        $('type').dispatchEvent(new Event('change'));
        $('desc').value = item.desc;
        $('category').value = item.category;
        $('amount').value = item.amount;
      }
      return;
    }

    const editCc = e.target.closest('[data-edit-cc]');
    if (editCc) {
      const card = state.credit_cards.find(c => String(c.id) === String(editCc.dataset.editCc));
      if (card) {
        $('ccId').value = card.id;
        $('ccName').value = card.name || '';
        $('ccLimit').value = Number(card.card_limit) > 0 ? card.card_limit : '';
        $('ccInitialDebt').value = Number(card.initial_debt) || 0;
        $('ccOwner').value = card.owner || 'Conta conjunta';
        if ($('ccFormTitle')) $('ccFormTitle').textContent = `Editar cartão: ${card.name}`;
        if ($('ccSaveBtn')) $('ccSaveBtn').textContent = 'Guardar alterações';
        if ($('ccCancelBtn')) $('ccCancelBtn').hidden = false;
        $('ccName').focus();
      }
      return;
    }

    const delCc = e.target.closest('[data-del-cc]');
    if (delCc) {
      const card = state.credit_cards.find(c => String(c.id) === String(delCc.dataset.delCc));
      if (card && confirm(`Remover cartão "${card.name}"?`)) {
        if ($('ccId') && String($('ccId').value) === String(card.id) && $('ccCancelBtn')) {
          $('ccCancelBtn').click();
        }
        card.deleted_at = Date.now();
        mutate('credit_cards', card);
      }
      return;
    }

    const editGoal = e.target.closest('[data-edit-goal]');
    if (editGoal) {
      const g = state.savings_goals.find(x => String(x.id) === String(editGoal.dataset.editGoal));
      if (g) {
        $('goalId').value = g.id;
        $('goalName').value = g.name;
        $('goalTarget').value = Number(g.target) > 0 ? g.target : '';
        $('goalDeadline').value = g.deadline || '';
        $('goalFormTitle').textContent = 'Editar objetivo de poupança';
        $('goalSave').textContent = 'Guardar alterações';
        $('goalCancel').hidden = false;
        $('goalName').focus();
      }
      return;
    }

    const delGoal = e.target.closest('[data-del-goal]');
    if (delGoal) {
      const g = state.savings_goals.find(x => String(x.id) === String(delGoal.dataset.delGoal));
      if (g && confirm(`Eliminar objetivo "${g.name}"?`)) {
        if (String(selectedGoalId) === String(g.id)) selectedGoalId = null;
        g.deleted_at = Date.now();
        mutate('savings_goals', g);
      }
      return;
    }

    const selectGoalCard = e.target.closest('[data-select-goal]');
    if (selectGoalCard) {
      const clickedId = selectGoalCard.dataset.selectGoal;
      selectedGoalId = String(selectedGoalId) === String(clickedId) ? null : clickedId;
      render();
      const panelEl = $('goalMovementsCard');
      if (panelEl && window.innerWidth < 1040) {
        panelEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    const dismissAlertBtn = e.target.closest('[data-dismiss-alert]');
    if (dismissAlertBtn) {
      const aid = dismissAlertBtn.dataset.dismissAlert;
      const cKey = dismissAlertBtn.dataset.dismissCycle || selectedCycleKey;
      if (aid && cKey) {
        dismissAlertForCycle(cKey, aid);
        const alertEl = dismissAlertBtn.closest('.alert');
        if (alertEl) alertEl.remove();
        showToast('Alerta ocultado até ao ciclo seguinte.', { type: 'info' });
      }
      return;
    }

    const copyMbBtn = e.target.closest('[data-copy-mb]');
    if (copyMbBtn) {
      const val = copyMbBtn.dataset.copyMb;
      if (val && navigator.clipboard) {
        navigator.clipboard.writeText(val).then(() => {
          showToast(`Copiado: ${val}`, { type: 'success' });
        }).catch(() => {});
      }
      return;
    }

    const openEnc = e.target.closest('[data-open-encargo]');
    if (openEnc) {
      openEncargoDetailModal(openEnc.dataset.openEncargo);
      return;
    }

    const confPend = e.target.closest('[data-confirm-pending]');
    if (confPend) {
      const tx = state.transactions.find(t => String(t.id) === String(confPend.dataset.confirmPending));
      if (tx) {
        tx.status = 'confirmed';
        mutate('transactions', tx);
        showToast('Despesa confirmada!', { type: 'success' });
      }
      return;
    }

    const skipPend = e.target.closest('[data-skip-pending]');
    if (skipPend) {
      const tx = state.transactions.find(t => String(t.id) === String(skipPend.dataset.skipPending));
      if (tx) {
        tx.status = 'skipped';
        mutate('transactions', tx);
      }
      return;
    }

    const calDay = e.target.closest('[data-cal-day]');
    if (calDay) {
      selectedCalendarDay = calDay.dataset.calDay;
      calScopeMode = 'day';
      renderCalendar();
    }
  });

  $('closeTxModalBtn').onclick = () => ($('txDetailModal').hidden = true);
  $('txDetailModal').onclick = e => {
    if (e.target === $('txDetailModal')) $('txDetailModal').hidden = true;
  };
  $('txModalSwitchEditBtn').onclick = switchModalToEdit;
  $('txModalCancelEditBtn').onclick = () => {
    $('txModalEditForm').hidden = true;
    $('txModalReadView').hidden = false;
  };
  $('modalEditType').onchange = updateModalEditVisibility;

  $('txModalDeleteBtn').onclick = () => {
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (tx) {
      tx.deleted_at = Date.now();
      $('txDetailModal').hidden = true;
      mutate('transactions', tx);
      showToast('Movimento eliminado.', {
        duration: 4500,
        undoLabel: 'Desfazer',
        onUndo: () => {
          tx.deleted_at = null;
          mutate('transactions', tx);
        }
      });
    }
  };

  $('txModalDuplicateBtn').onclick = () => {
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (!tx) return;
    const copy = { ...tx, id: uid('tx'), date: iso(), installment_group_id: null, updated_at: Date.now() };
    state.transactions.push(copy);
    $('txDetailModal').hidden = true;
    mutate('transactions', copy);
    showToast('Movimento duplicado para hoje!', { type: 'success' });
  };

  $('txModalEditForm').onsubmit = e => {
    e.preventDefault();
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (!tx) return;
    const val = evaluateAmountExpression($('modalEditAmount').value);
    if (!Number.isFinite(val) || val <= 0) {
      alert('Valor inválido.');
      return;
    }
    const prevCategory = tx.category;
    const tp = $('modalEditType').value;
    tx.date = $('modalEditDate').value;
    tx.type = tp;
    tx.description = $('modalEditDesc').value.trim();
    tx.amount = Number(val.toFixed(2));
    tx.category = tp === 'expense' ? $('modalEditCat').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : tp === 'transfer' ? 'Transferência interna' : 'Poupança';
    tx.person = tp === 'transfer' && $('modalEditTransferFrom') && $('modalEditTransferTo')
      ? `${$('modalEditTransferFrom').value} → ${$('modalEditTransferTo').value}`
      : $('modalEditPerson').value;
    tx.counts_for_cycle = tp === 'income' ? $('modalEditCountsCycle').checked : true;
    tx.credit_card_id =
      tp === 'expense' && $('modalEditPaymentMethod').value.startsWith('cc:')
        ? $('modalEditPaymentMethod').value.slice(3)
        : tp === 'cc_payment'
        ? $('modalEditCcPaymentCard').value || null
        : null;
    tx.goal_id = tp === 'saving' || tp === 'saving_withdraw' ? $('modalEditGoal').value || null : null;

    $('txDetailModal').hidden = true;
    mutate('transactions', tx);

    if (tp === 'expense' && tx.category && tx.category !== prevCategory && tx.description.length >= 3) {
      const learnedDesc = tx.description;
      const learnedCat = tx.category;
      showToast(`Guardado! Memorizar "${learnedCat}" para "${learnedDesc}"?`, {
        type: 'success',
        duration: 5500,
        undoLabel: '🧠 Memorizar regra',
        onUndo: () => {
          learnCategoryRule(state, learnedDesc, learnedCat);
          state.meta.updated_at = Date.now();
          saveLocalState(state);
          if (sync.householdId) {
            enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
            sync.flushOutbox();
          }
          renderCategoryRules();
          showToast(`Regra memorizada: → ${learnedCat}`, { type: 'success' });
        }
      });
    } else {
      showToast('Alterações guardadas e sincronizadas.', { type: 'success' });
    }
  };

  ['analyticsCycleSelect', 'analyticsMetric', 'analyticsChartType'].forEach(id => {
    $(id).onchange = updateAnalyticsView;
  });

  if ($('encargosCycleSelect')) {
    $('encargosCycleSelect').onchange = e => {
      encargosCycleKey = e.target.value;
      renderRecurringSection();
    };
  }

  function updateEncargoCycleEntry(recId, patch) {
    const rule = (state.recurring_expenses || []).find(r => String(r.id) === String(recId));
    if (!rule) return;
    const cycles = buildCycles(state);
    const activeCycle = cycles.find(c => c.key === encargosCycleKey) || currentCycle(cycles);
    const cKey = activeCycle ? activeCycle.key : currentMonth();

    rule.cycle_payments = rule.cycle_payments && typeof rule.cycle_payments === 'object' ? rule.cycle_payments : {};
    const prev = rule.cycle_payments[cKey] || {
      amount: Number(rule.amount) || 0,
      paidDate: getSuggestedEncargoDate(activeCycle, rule.day_of_month),
      paid: false
    };
    rule.cycle_payments[cKey] = { ...prev, ...patch };
    mutate('recurring_expenses', rule);
  }

  if ($('encargosChecklist')) {
    $('encargosChecklist').addEventListener('change', e => {
      const paidCb = e.target.closest('[data-encargo-paid]');
      if (paidCb) {
        const id = paidCb.dataset.encargoPaid;
        const card = paidCb.closest('.encargo-card');
        const amtInp = card?.querySelector('[data-encargo-amount]');
        const dateInp = card?.querySelector('[data-encargo-date]');
        const isPaidNow = paidCb.checked;
        const paidDateVal = dateInp?.value || iso();
        updateEncargoCycleEntry(id, {
          paid: isPaidNow,
          amount: amtInp && amtInp.value !== '' ? Number(amtInp.value) : 0,
          paidDate: paidDateVal
        });
        haptic(14);
        showToast(isPaidNow ? 'Marcado como pago no caderno!' : 'Marcado como por pagar.', { type: isPaidNow ? 'success' : 'info' });
        return;
      }

      const amtInp = e.target.closest('[data-encargo-amount]');
      if (amtInp) {
        const id = amtInp.dataset.encargoAmount;
        updateEncargoCycleEntry(id, { amount: amtInp.value !== '' ? Number(amtInp.value) : 0 });
        return;
      }

      const dateInp = e.target.closest('[data-encargo-date]');
      if (dateInp) {
        const id = dateInp.dataset.encargoDate;
        updateEncargoCycleEntry(id, { paidDate: dateInp.value });
      }
    });
  }

  function openEncargoDetailModal(recId) {
    const r = (state.recurring_expenses || []).find(x => String(x.id) === String(recId));
    if (!r) return;
    $('recurrenceId').value = r.id;
    $('encargoModalTitle').textContent = r.description;
    $('encargoModalSubtitle').textContent = `${r.category} · ${r.person}`;
    $('encargoModalReadView').hidden = false;
    $('recurrenceForm').hidden = true;

    $('encargoViewName').textContent = r.description;
    $('encargoViewMeta').textContent = `${r.category} · ${r.person}`;
    $('encargoViewEntity').textContent = r.entity || '—';
    $('encargoCopyEntityBtn').hidden = !r.entity;
    $('encargoCopyEntityBtn').dataset.copyMb = r.entity || '';

    $('encargoViewRef').textContent = r.payment_ref || '—';
    $('encargoCopyRefBtn').hidden = !r.payment_ref;
    $('encargoCopyRefBtn').dataset.copyMb = r.payment_ref || '';

    $('encargoViewAmount').textContent = Number(r.amount) > 0 ? eur(r.amount) : 'Variável';
    $('encargoViewDay').textContent = `Dia ${r.day_of_month}`;
    $('encargoViewPerson').textContent = r.person;

    // Render history of paid cycles for this supplier
    const cycles = buildCycles(state);
    const cpMap = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
    const historyEntries = Object.entries(cpMap)
      .filter(([, entry]) => entry && entry.paid)
      .map(([cKey, entry]) => {
        const cy = cycles.find(c => c.key === cKey);
        return {
          label: cy ? cy.monthLabel : cKey,
          paidDate: entry.paidDate || '',
          amount: Number(entry.amount) || 0
        };
      })
      .sort((a, b) => b.paidDate.localeCompare(a.paidDate))
      .slice(0, 6);

    $('encargoHistoryList').innerHTML = historyEntries.length
      ? historyEntries
          .map(h => `<div class="item row" style="padding:7px 10px"><div><b>${esc(h.label)}</b><div class="small">${h.paidDate ? `Pago a ${fmtDate(h.paidDate)}` : 'Pago'}</div></div><b>${eur(h.amount)}</b></div>`)
          .join('')
      : '<div class="empty" style="padding:10px">Sem pagamentos registados anteriormente.</div>';

    $('encargoModal').hidden = false;
  }

  function openEncargoCreateModal() {
    $('recurrenceId').value = '';
    $('recurrenceForm').reset();
    $('encargoModalTitle').textContent = 'Novo serviço no caderno';
    $('encargoModalSubtitle').textContent = 'Configura os dados fixos do fornecedor';
    $('encargoModalReadView').hidden = true;
    $('recurrenceForm').hidden = false;
    $('recurrenceSave').textContent = 'Guardar no caderno';
    $('encargoModal').hidden = false;
    setTimeout(() => $('recurrenceDescription').focus(), 50);
  }

  if ($('openNewEncargoBtn')) $('openNewEncargoBtn').onclick = openEncargoCreateModal;
  if ($('closeEncargoModalBtn')) $('closeEncargoModalBtn').onclick = () => ($('encargoModal').hidden = true);
  if ($('encargoModal')) {
    $('encargoModal').onclick = e => {
      if (e.target === $('encargoModal')) $('encargoModal').hidden = true;
    };
  }

  if ($('encargoSwitchEditBtn')) {
    $('encargoSwitchEditBtn').onclick = () => {
      const r = (state.recurring_expenses || []).find(x => String(x.id) === String($('recurrenceId').value));
      if (!r) return;
      $('encargoModalTitle').textContent = 'Editar fornecedor / serviço';
      $('encargoModalSubtitle').textContent = r.description;
      $('encargoModalReadView').hidden = true;
      $('recurrenceForm').hidden = false;

      $('recurrenceDescription').value = r.description;
      $('recurrenceCategory').value = r.category;
      $('recurrenceEntity').value = r.entity || '';
      $('recurrenceRef').value = r.payment_ref || '';
      $('recurrenceAmount').value = Number(r.amount) > 0 ? r.amount : '';
      $('recurrencePerson').value = r.person;
      $('recurrenceDay').value = r.day_of_month;
      $('recurrenceSave').textContent = 'Guardar alterações';
    };
  }

  if ($('encargoDeleteBtn')) {
    $('encargoDeleteBtn').onclick = () => {
      const r = (state.recurring_expenses || []).find(x => String(x.id) === String($('recurrenceId').value));
      if (r && confirm(`Remover "${r.description}" do caderno de encargos?`)) {
        r.deleted_at = Date.now();
        $('encargoModal').hidden = true;
        mutate('recurring_expenses', r);
        showToast('Serviço removido do caderno.');
      }
    };
  }

  $('recurrenceCancel').onclick = () => {
    const editId = $('recurrenceId').value;
    if (editId) {
      openEncargoDetailModal(editId);
    } else {
      $('encargoModal').hidden = true;
    }
  };

  $('recurrenceForm').onsubmit = e => {
    e.preventDefault();
    const editId = $('recurrenceId').value;
    if (editId) {
      const rule = state.recurring_expenses.find(r => String(r.id) === String(editId));
      if (rule) {
        rule.description = $('recurrenceDescription').value.trim();
        rule.category = $('recurrenceCategory').value;
        rule.entity = $('recurrenceEntity') ? $('recurrenceEntity').value.trim() : '';
        rule.payment_ref = $('recurrenceRef') ? $('recurrenceRef').value.trim() : '';
        rule.amount = Number($('recurrenceAmount').value) || 0;
        rule.person = $('recurrencePerson').value;
        rule.day_of_month = Number($('recurrenceDay').value) || 1;
        mutate('recurring_expenses', rule);
        showToast('Fornecedor atualizado!', { type: 'success' });
        openEncargoDetailModal(rule.id);
      }
      return;
    }

    const rule = {
      id: uid('rec'),
      description: $('recurrenceDescription').value.trim(),
      category: $('recurrenceCategory').value,
      entity: $('recurrenceEntity') ? $('recurrenceEntity').value.trim() : '',
      payment_ref: $('recurrenceRef') ? $('recurrenceRef').value.trim() : '',
      amount: Number($('recurrenceAmount').value) || 0,
      person: $('recurrencePerson').value,
      day_of_month: Number($('recurrenceDay').value) || 1,
      start_month: currentMonth(),
      end_month: null,
      active: true,
      cycle_payments: {},
      updated_at: Date.now()
    };
    state.recurring_expenses.push(rule);
    mutate('recurring_expenses', rule);
    $('encargoModal').hidden = true;
    showToast('Serviço adicionado ao caderno de encargos!', { type: 'success' });
  };


  // --- Calendário: Redimensionamento interativo, troca de lado e vista dia/mês ---
  function applyCalLayoutPrefs() {
    const layoutEl = $('calSplitLayout');
    if (!layoutEl) return;
    layoutEl.style.setProperty('--cal-left-size', `${calLayoutPrefs.leftPct}%`);
    layoutEl.classList.toggle('is-swapped', !!calLayoutPrefs.swapped);

    const expandBtn = $('calExpandMovementsBtn');
    if (expandBtn) {
      const movPct = calLayoutPrefs.swapped ? calLayoutPrefs.leftPct : 100 - calLayoutPrefs.leftPct;
      expandBtn.textContent = movPct >= 60 ? '↔ 50 / 50' : '⤢ Ampliar';
    }
  }
  applyCalLayoutPrefs();

  if ($('calScopeToggleBtn')) {
    $('calScopeToggleBtn').onclick = () => {
      calScopeMode = calScopeMode === 'day' ? 'month' : 'day';
      renderCalendar();
    };
  }

  if ($('calSwapOrderBtn')) {
    $('calSwapOrderBtn').onclick = () => {
      calLayoutPrefs.swapped = !calLayoutPrefs.swapped;
      calLayoutPrefs.leftPct = 100 - calLayoutPrefs.leftPct;
      saveCalLayoutPrefs(calLayoutPrefs);
      applyCalLayoutPrefs();
    };
  }

  if ($('calExpandMovementsBtn')) {
    $('calExpandMovementsBtn').onclick = () => {
      const movPct = calLayoutPrefs.swapped ? calLayoutPrefs.leftPct : 100 - calLayoutPrefs.leftPct;
      if (movPct >= 60) {
        calLayoutPrefs.leftPct = 50;
      } else {
        calLayoutPrefs.leftPct = calLayoutPrefs.swapped ? 65 : 35;
      }
      saveCalLayoutPrefs(calLayoutPrefs);
      applyCalLayoutPrefs();
    };
  }

  const splitterEl = $('calSplitter');
  const layoutEl = $('calSplitLayout');
  if (splitterEl && layoutEl) {
    let dragging = false;

    const updateFromClientX = clientX => {
      const rect = layoutEl.getBoundingClientRect();
      if (!rect.width) return;
      const pct = ((clientX - rect.left) / rect.width) * 100;
      calLayoutPrefs.leftPct = Math.round(Math.min(72, Math.max(28, pct)) * 10) / 10;
      applyCalLayoutPrefs();
    };

    splitterEl.addEventListener('pointerdown', e => {
      dragging = true;
      splitterEl.classList.add('is-dragging');
      splitterEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    splitterEl.addEventListener('pointermove', e => {
      if (!dragging) return;
      updateFromClientX(e.clientX);
    });

    const stopDrag = e => {
      if (!dragging) return;
      dragging = false;
      splitterEl.classList.remove('is-dragging');
      if (e && e.pointerId !== undefined) {
        try { splitterEl.releasePointerCapture(e.pointerId); } catch (_) {}
      }
      saveCalLayoutPrefs(calLayoutPrefs);
    };

    splitterEl.addEventListener('pointerup', stopDrag);
    splitterEl.addEventListener('pointercancel', stopDrag);

    splitterEl.addEventListener('dblclick', () => {
      calLayoutPrefs.leftPct = 50;
      saveCalLayoutPrefs(calLayoutPrefs);
      applyCalLayoutPrefs();
    });

    splitterEl.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const delta = e.key === 'ArrowLeft' ? -3 : 3;
        calLayoutPrefs.leftPct = Math.min(72, Math.max(28, calLayoutPrefs.leftPct + delta));
        saveCalLayoutPrefs(calLayoutPrefs);
        applyCalLayoutPrefs();
      }
    });
  }

  $('prevCalMonth').onclick = () => {
    const [y, m] = calendarMonthStr.split('-').map(Number);
    const d = new Date(y, m - 2, 2);
    calendarMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar();
  };
  $('nextCalMonth').onclick = () => {
    const [y, m] = calendarMonthStr.split('-').map(Number);
    const d = new Date(y, m, 2);
    calendarMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar();
  };
  $('calendarMonth').onchange = e => {
    if (e.target.value) {
      calendarMonthStr = e.target.value;
      renderCalendar();
    }
  };

  ['simDesc', 'simAmount', 'simInstallments', 'simCategory', 'simSource'].forEach(id => {
    $(id).addEventListener('input', runImpactSimulator);
  });
  $('simResetBtn').onclick = () => {
    $('simDesc').value = '';
    $('simAmount').value = '';
    $('simResultBox').hidden = true;
    $('simActions').hidden = true;
  };
  $('simConvertToTxBtn').onclick = () => {
    const amount = Number($('simAmount').value) || 0;
    const n = Number($('simInstallments').value) || 1;
    openAddTxModal(false);
    $('type').value = 'expense';
    $('type').dispatchEvent(new Event('change'));
    $('desc').value = $('simDesc').value.trim() || 'Compra planeada';
    $('amount').value = amount.toFixed(2);
    $('category').value = $('simCategory').value;
    if (n > 1) {
      $('isInstallment').checked = true;
      $('installmentsOptions').hidden = false;
      $('installmentCount').value = n;
      $('installmentAmountMode').value = 'total';
    }
  };

  // --- 1. Reconciliação de Saldo Bancário ---
  if ($('openReconcileBtn')) {
    $('openReconcileBtn').onclick = e => {
      e.stopPropagation();
      const cycles = buildCycles(state);
      const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
      const today = iso();
      const curBal = Number(computeCycleBalance(state, cycle, today).toFixed(2));
      $('recCurrentAppBal').textContent = eur(curBal);
      $('recCurrentAppBal').dataset.val = String(curBal);
      $('recRealBankBalance').value = '';
      $('recDiffRow').hidden = true;
      $('recPerson').innerHTML = $('person').innerHTML;
      $('reconcileModal').hidden = false;
      setTimeout(() => $('recRealBankBalance').focus(), 50);
    };
  }
  if ($('closeReconcileModalBtn')) $('closeReconcileModalBtn').onclick = () => ($('reconcileModal').hidden = true);
  if ($('cancelReconcileBtn')) $('cancelReconcileBtn').onclick = () => ($('reconcileModal').hidden = true);
  if ($('reconcileModal')) {
    $('reconcileModal').onclick = e => {
      if (e.target === $('reconcileModal')) $('reconcileModal').hidden = true;
    };
  }
  if ($('recRealBankBalance')) {
    $('recRealBankBalance').oninput = () => {
      const appBal = Number($('recCurrentAppBal').dataset.val) || 0;
      const realVal = parseFloat($('recRealBankBalance').value);
      if (!Number.isFinite(realVal)) {
        $('recDiffRow').hidden = true;
        return;
      }
      const diff = Number((realVal - appBal).toFixed(2));
      $('recDiffRow').hidden = false;
      $('recDiffPreview').textContent = (diff > 0 ? '+' : '') + eur(diff);
      $('recDiffPreview').className = diff > 0 ? 'plus' : diff < 0 ? 'minus' : '';
    };
  }
  if ($('reconcileForm')) {
    $('reconcileForm').onsubmit = e => {
      e.preventDefault();
      const appBal = Number($('recCurrentAppBal').dataset.val) || 0;
      const realVal = parseFloat($('recRealBankBalance').value);
      if (!Number.isFinite(realVal)) return;
      const diff = Number((realVal - appBal).toFixed(2));
      if (Math.abs(diff) < 0.01) {
        $('reconcileModal').hidden = true;
        showToast('O saldo da app já coincide com o banco!', { type: 'success' });
        return;
      }
      const isPositive = diff > 0;
      const tx = {
        id: uid('recbal'),
        date: iso(),
        type: isPositive ? 'income' : 'expense',
        description: 'Acerto de saldo bancário',
        amount: Math.abs(diff),
        category: isPositive ? 'Rendimento' : 'Outros / imprevistos',
        person: $('recPerson').value || 'Conta conjunta',
        status: 'confirmed',
        counts_for_cycle: false,
        updated_at: Date.now()
      };
      state.transactions.push(tx);
      $('reconcileModal').hidden = true;
      mutate('transactions', tx);
      showToast(`Saldo acertado (${diff > 0 ? '+' : ''}${eur(diff)})!`, { type: 'success' });
    };
  }

  // --- 3. Gestão em Grupo de Prestações (Liquidar ou Apagar Futuras) ---
  if ($('txModalSettleInstBtn')) {
    $('txModalSettleInstBtn').onclick = () => {
      const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
      if (!tx || !tx.installment_group_id) return;
      const today = iso();
      const futureTxs = state.transactions.filter(
        t => !t.deleted_at && t.installment_group_id === tx.installment_group_id && t.date > today
      );
      if (!futureTxs.length) return;
      if (!confirm(`Liquidar antecipadamente ${futureTxs.length} prestação(ões) restante(s) (${eur(sum(futureTxs))}) na data de hoje?`)) return;
      const now = Date.now();
      futureTxs.forEach(ft => {
        ft.date = today;
        ft.description = ft.description + ' [Liquidada]';
        ft.updated_at = now;
        enqueueOutbox('transactions', ft);
      });
      saveLocalState(state);
      $('txDetailModal').hidden = true;
      render();
      sync.flushOutbox();
      showToast(`${futureTxs.length} prestação(ões) liquidada(s) hoje!`, { type: 'success' });
    };
  }

  if ($('txModalDeleteFutureInstBtn')) {
    $('txModalDeleteFutureInstBtn').onclick = () => {
      const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
      if (!tx || !tx.installment_group_id) return;
      const today = iso();
      const futureTxs = state.transactions.filter(
        t => !t.deleted_at && t.installment_group_id === tx.installment_group_id && t.date > today
      );
      if (!futureTxs.length) return;
      if (!confirm(`Apagar ${futureTxs.length} prestação(ões) futura(s) deste plano?`)) return;
      const now = Date.now();
      futureTxs.forEach(ft => {
        ft.deleted_at = now;
        ft.updated_at = now;
        enqueueOutbox('transactions', ft);
      });
      saveLocalState(state);
      $('txDetailModal').hidden = true;
      render();
      sync.flushOutbox();
      showToast(`${futureTxs.length} prestação(ões) futura(s) removida(s).`);
    };
  }

  // --- 4. Regras de Categorização Automática Editáveis ---
  if ($('addCategoryRuleForm')) {
    $('addCategoryRuleForm').onsubmit = e => {
      e.preventDefault();
      const kw = $('newRuleKeyword').value.trim().toUpperCase();
      const cat = $('newRuleCategory').value;
      if (!kw || !cat) return;
      state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
      state.meta.category_rules = state.meta.category_rules || [];
      const existing = state.meta.category_rules.find(r => r.keyword.toUpperCase() === kw);
      if (existing) {
        existing.category = cat;
      } else {
        state.meta.category_rules.push({ keyword: kw, category: cat, hits: 1 });
      }
      state.meta.updated_at = Date.now();
      saveLocalState(state);
      if (sync.householdId) {
        enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
        sync.flushOutbox();
      }
      $('newRuleKeyword').value = '';
      renderCategoryRules();
      showToast('Regra automática guardada.', { type: 'success' });
    };
  }

  document.addEventListener('click', e => {
    const delRuleBtn = e.target.closest('[data-del-cat-rule]');
    if (delRuleBtn) {
      const idx = Number(delRuleBtn.dataset.delCatRule);
      const rules = (state.meta?.category_rules || []).slice().sort((a, b) => (b.hits || 0) - (a.hits || 0));
      const targetRule = rules[idx];
      if (targetRule) {
        state.meta.category_rules = state.meta.category_rules.filter(r => r !== targetRule);
        state.meta.updated_at = Date.now();
        saveLocalState(state);
        if (sync.householdId) {
          enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
          sync.flushOutbox();
        }
        renderCategoryRules();
        showToast('Regra removida.');
      }
      return;
    }

    const moveCatBtn = e.target.closest('[data-move-cat]');
    if (moveCatBtn) {
      const catId = moveCatBtn.dataset.moveCat;
      const dir = Number(moveCatBtn.dataset.dir);
      const activeCats = (state.categories || [])
        .filter(c => !c.deleted_at)
        .sort((a, b) => (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999) || String(a.name).localeCompare(String(b.name)));
      const idx = activeCats.findIndex(c => String(c.id) === String(catId));
      const swapIdx = idx + dir;
      if (idx >= 0 && swapIdx >= 0 && swapIdx < activeCats.length) {
        const temp = activeCats[idx];
        activeCats[idx] = activeCats[swapIdx];
        activeCats[swapIdx] = temp;
        const now = Date.now();
        activeCats.forEach((c, i) => {
          c.sort_order = i + 1;
          c.updated_at = now;
          enqueueOutbox('categories', c);
        });
        saveLocalState(state);
        render();
        sync.flushOutbox();
      }
      return;
    }

    const delCatBtn = e.target.closest('[data-del-cat]');
    if (delCatBtn) {
      const catId = delCatBtn.dataset.delCat;
      const activeCats = (state.categories || []).filter(c => !c.deleted_at);
      if (activeCats.length <= 1) {
        showToast('Tem de existir pelo menos uma categoria ativa.', { type: 'error' });
        return;
      }
      const targetCat = activeCats.find(c => String(c.id) === String(catId));
      if (!targetCat) return;

      const fallbackCat =
        activeCats.find(c => String(c.id) !== String(catId) && String(c.name).trim().toLowerCase() === 'outros') ||
        activeCats.find(c => String(c.id) !== String(catId));
      const fallbackName = fallbackCat ? fallbackCat.name : 'Outros';

      const affectedTx = (state.transactions || []).filter(t => !t.deleted_at && t.category === targetCat.name);
      const affectedRec = (state.recurring_expenses || []).filter(r => !r.deleted_at && r.category === targetCat.name);
      const affectedRules = (state.meta?.category_rules || []).filter(r => r.category === targetCat.name);

      const extraMsg =
        affectedTx.length || affectedRec.length || affectedRules.length
          ? `

Existem ${affectedTx.length} movimento(s), ${affectedRec.length} encargo(s) e ${affectedRules.length} regra(s) associados que serão reatribuídos automaticamente para "${fallbackName}".`
          : '';

      if (!confirm(`Tens a certeza que queres apagar a categoria "${targetCat.name}"?${extraMsg}`)) return;

      const now = Date.now();
      targetCat.deleted_at = now;
      targetCat.updated_at = now;
      enqueueOutbox('categories', targetCat);

      affectedTx.forEach(t => {
        t.category = fallbackName;
        t.updated_at = now;
        enqueueOutbox('transactions', t);
      });
      affectedRec.forEach(r => {
        r.category = fallbackName;
        r.updated_at = now;
        enqueueOutbox('recurring_expenses', r);
      });
      if (affectedRules.length && state.meta) {
        affectedRules.forEach(r => {
          r.category = fallbackName;
        });
        state.meta.updated_at = now;
        if (sync.householdId) {
          enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
        }
      }

      saveLocalState(state);
      render();
      sync.flushOutbox();
      showToast(`Categoria "${targetCat.name}" apagada.`, { type: 'success' });
    }
  });

  $('budgetForm').onsubmit = e => {
    e.preventDefault();
    const rows = [];
    const seenNames = new Set();
    let validationErr = '';

    document.querySelectorAll('[data-cat-budget-id]').forEach(budgetInp => {
      if (validationErr) return;
      const catId = budgetInp.dataset.catBudgetId;
      const nameInp = document.querySelector(`[data-cat-name-id="${CSS.escape(catId)}"]`);
      const cat = state.categories.find(c => String(c.id) === String(catId));
      if (!cat) return;

      const newName = nameInp ? nameInp.value.trim() : cat.name;
      if (!newName) {
        validationErr = 'O nome de uma categoria não pode ficar vazio.';
        return;
      }
      const normKey = newName.toLowerCase();
      if (seenNames.has(normKey)) {
        validationErr = `Já existe uma categoria chamada "${newName}".`;
        return;
      }
      seenNames.add(normKey);
      rows.push({
        cat,
        oldName: cat.name,
        newName,
        newBudget: Math.max(0, Number(budgetInp.value) || 0)
      });
    });

    if (validationErr) {
      showToast(validationErr, { type: 'error' });
      return;
    }

    const now = Date.now();
    let metaChanged = false;

    rows.forEach(({ cat, oldName, newName, newBudget }) => {
      const nameChanged = oldName !== newName;
      const budgetChanged = Number(cat.budget || 0) !== newBudget;
      if (!nameChanged && !budgetChanged) return;

      cat.name = newName;
      cat.budget = newBudget;
      cat.updated_at = now;
      enqueueOutbox('categories', cat);

      if (nameChanged) {
        (state.transactions || []).forEach(t => {
          if (!t.deleted_at && t.category === oldName) {
            t.category = newName;
            t.updated_at = now;
            enqueueOutbox('transactions', t);
          }
        });
        (state.recurring_expenses || []).forEach(r => {
          if (!r.deleted_at && r.category === oldName) {
            r.category = newName;
            r.updated_at = now;
            enqueueOutbox('recurring_expenses', r);
          }
        });
        (state.meta?.category_rules || []).forEach(rule => {
          if (rule.category === oldName) {
            rule.category = newName;
            metaChanged = true;
          }
        });
      }
    });

    if (metaChanged && state.meta) {
      state.meta.updated_at = now;
      if (sync.householdId) {
        enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
      }
    }

    saveLocalState(state);
    render();
    sync.flushOutbox();
    showToast('Categorias e limites guardados!', { type: 'success' });
  };

  $('newCategoryForm').onsubmit = e => {
    e.preventDefault();
    const rawName = $('newCategoryName').value.trim();
    if (!rawName) return;
    const exists = (state.categories || []).some(
      c => !c.deleted_at && String(c.name).trim().toLowerCase() === rawName.toLowerCase()
    );
    if (exists) {
      showToast(`A categoria "${rawName}" já existe.`, { type: 'error' });
      return;
    }
    const maxOrder = (state.categories || [])
      .filter(c => !c.deleted_at)
      .reduce((m, c) => Math.max(m, Number(c.sort_order) || 0), 0);
    const cat = {
      id: uid('cat'),
      household_id: sync.householdId || null,
      name: rawName,
      budget: Math.max(0, Number($('newCategoryBudget').value) || 0),
      sort_order: maxOrder + 1,
      updated_at: Date.now(),
      deleted_at: null
    };
    state.categories.push(cat);
    mutate('categories', cat);
    $('newCategoryForm').reset();
    showToast('Categoria criada.', { type: 'success' });
  };

  if ($('ccCancelBtn')) {
    $('ccCancelBtn').onclick = () => {
      $('ccId').value = '';
      $('creditCardForm').reset();
      if ($('ccInitialDebt')) $('ccInitialDebt').value = '0';
      if ($('ccFormTitle')) $('ccFormTitle').textContent = 'Adicionar cartão de crédito';
      if ($('ccSaveBtn')) $('ccSaveBtn').textContent = 'Guardar cartão';
      $('ccCancelBtn').hidden = true;
    };
  }

  $('creditCardForm').onsubmit = e => {
    e.preventDefault();
    const editId = $('ccId') ? $('ccId').value : '';
    const newName = $('ccName').value.trim();
    const newLimit = Math.max(0, Number($('ccLimit').value) || 0);
    const newInitialDebt = Math.max(0, Number($('ccInitialDebt').value) || 0);
    const newOwner = $('ccOwner').value || 'Conta conjunta';

    if (editId) {
      const card = state.credit_cards.find(c => String(c.id) === String(editId));
      if (card) {
        const oldName = card.name;
        card.name = newName;
        card.card_limit = newLimit;
        card.initial_debt = newInitialDebt;
        card.owner = newOwner;

        if (oldName && oldName !== newName) {
          for (const tx of state.transactions || []) {
            if (!tx.deleted_at && (String(tx.card_id) === String(card.id) || tx.card_name === oldName)) {
              tx.card_name = newName;
              tx.updated_at = Date.now();
              enqueueOutbox('transactions', tx);
            }
          }
        }

        mutate('credit_cards', card);
        showToast('Cartão de crédito atualizado.', { type: 'success' });
      }
      if ($('ccCancelBtn')) $('ccCancelBtn').click();
      return;
    }

    const card = {
      id: uid('cc'),
      name: newName,
      card_limit: newLimit,
      initial_debt: newInitialDebt,
      owner: newOwner,
      updated_at: Date.now()
    };
    state.credit_cards.push(card);
    mutate('credit_cards', card);
    $('creditCardForm').reset();
    if ($('ccInitialDebt')) $('ccInitialDebt').value = '0';
    showToast('Cartão de crédito adicionado.', { type: 'success' });
  };

  $('goalCancel').onclick = () => {
    $('goalId').value = '';
    $('goalForm').reset();
    $('goalFormTitle').textContent = 'Criar objetivo de poupança';
    $('goalSave').textContent = 'Guardar objetivo';
    $('goalCancel').hidden = true;
  };

  $('goalForm').onsubmit = e => {
    e.preventDefault();
    const editId = $('goalId').value;
    const rawTarget = String($('goalTarget').value || '').trim();
    const parsedTarget = rawTarget === '' ? 0 : Math.max(0, Number(rawTarget) || 0);
    if (editId) {
      const g = state.savings_goals.find(x => String(x.id) === String(editId));
      if (g) {
        g.name = $('goalName').value.trim();
        g.target = parsedTarget;
        g.deadline = $('goalDeadline').value || null;
        mutate('savings_goals', g);
        showToast('Objetivo atualizado.', { type: 'success' });
      }
      $('goalCancel').click();
      return;
    }

    const goal = {
      id: uid('goal'),
      name: $('goalName').value.trim(),
      target: parsedTarget,
      deadline: $('goalDeadline').value || null,
      status: 'active',
      updated_at: Date.now()
    };
    state.savings_goals.push(goal);
    mutate('savings_goals', goal);
    $('goalForm').reset();
    showToast('Objetivo criado.', { type: 'success' });
  };

  $('savePeople').onclick = () => {
    state.household.adult1_name = $('adult1').value.trim() || 'Adulto 1';
    state.household.adult2_name = $('adult2').value.trim() || 'Adulto 2';
    state.household.cycle_grouping_days = Math.max(0, Math.min(20, Number($('cycleGroupingDays').value) || 14));
    mutate('households', state.household);
    showToast('Definições guardadas.', { type: 'success' });
  };

  $('saveCloudConfig').onclick = () => {
    sync.saveConfig($('sbUrl').value, $('sbKey').value);
    sync.connectAndSubscribe();
    showToast('Configuração Supabase guardada.');
  };
  $('cloudLogin').onclick = async () => {
    try {
      sync.saveConfig($('sbUrl').value, $('sbKey').value);
      await sync.signIn($('cloudEmail').value.trim(), $('cloudPassword').value);
      showToast('Sessão iniciada!', { type: 'success' });
    } catch (err) {
      alert('Erro ao entrar: ' + err.message);
    }
  };
  $('cloudSignup').onclick = async () => {
    try {
      sync.saveConfig($('sbUrl').value, $('sbKey').value);
      const logged = await sync.signUp($('cloudEmail').value.trim(), $('cloudPassword').value);
      showToast(logged ? 'Conta criada e ligada!' : 'Conta criada! Confirma o email se necessário.', { type: 'success' });
    } catch (err) {
      alert('Erro ao criar conta: ' + err.message);
    }
  };
  $('cloudLogout').onclick = () => sync.signOut();
  if ($('refreshDevicesBtn')) {
    $('refreshDevicesBtn').onclick = async () => {
      await sync.registerCurrentDevice();
      await renderLinkedDevicesPanel(true);
      showToast('Lista de dispositivos atualizada.', { type: 'success' });
    };
  }
  document.addEventListener('click', async e => {
    const renBtn = e.target.closest('[data-rename-this-device]');
    if (renBtn) {
      const next = prompt('Nome para identificar este dispositivo (ex.: PC Sala, iPhone, Android):', sync.getDeviceName());
      if (next && next.trim()) {
        await sync.renameCurrentDevice(next);
        await renderLinkedDevicesPanel(true);
        showToast('Nome do dispositivo atualizado.', { type: 'success' });
      }
      return;
    }

    const toggleRoleBtn = e.target.closest('[data-toggle-member-role]');
    if (toggleRoleBtn) {
      const uidTarget = toggleRoleBtn.dataset.toggleMemberRole;
      const nextRole = toggleRoleBtn.dataset.nextRole;
      const label = nextRole === 'admin' ? 'Administrador' : 'Utilizador';
      if (uidTarget && confirm(`Alterar o perfil desta conta para ${label}?`)) {
        try {
          await sync.updateMemberRole(uidTarget, nextRole);
          await renderLinkedDevicesPanel(true);
          applyRolePermissions();
          showToast(`Perfil atualizado para ${label}.`, { type: 'success' });
        } catch (err) {
          alert(err.message);
        }
      }
      return;
    }
    const remMemberBtn = e.target.closest('[data-remove-member]');
    if (remMemberBtn) {
      const uidTarget = remMemberBtn.dataset.removeMember;
      if (uidTarget && confirm('Revogar o acesso desta conta ao orçamento partilhado?')) {
        try {
          await sync.removeMember(uidTarget);
          await renderLinkedDevicesPanel(true);
          showToast('Acesso revogado com sucesso.', { type: 'info' });
        } catch (err) {
          alert(err.message);
        }
      }
      return;
    }

    const remBtn = e.target.closest('[data-remove-device]');
    if (remBtn) {
      const devId = remBtn.dataset.removeDevice;
      if (devId && confirm('Remover este dispositivo da lista de aparelhos registados?')) {
        try {
          await sync.removeDevice(devId);
          await renderLinkedDevicesPanel(true);
          showToast('Registo do dispositivo removido.', { type: 'info' });
        } catch (err) {
          alert(err.message);
        }
      }
    }
  });

  $('createHousehold').onclick = async () => {
    const name = ($('householdName').value || '').trim() || 'Orçamento do casal';
    if (sync.householdId) {
      const msgAlready =
        `ATENÇÃO: Este aparelho já está ligado ao orçamento (${sync.householdId.slice(0, 8)}…).\n\n` +
        `Criar um novo orçamento ("${name}") vai desligar este aparelho do orçamento atual e criar uma sala separada na nuvem.\n\n` +
        `Tens a certeza absoluta de que queres criar um SEGUNDO orçamento?`;
      if (!confirm(msgAlready)) return;
    } else {
      const msgNew =
        `Vais criar um NOVO orçamento partilhado ("${name}") do zero na nuvem.\n\n` +
        `• Se já tens um orçamento criado noutro PC ou telemóvel, clica em CANCELAR e insere o código de convite de 6 caracteres no campo abaixo ("Associar").\n` +
        `• Clica em OK apenas se este for o primeiro aparelho onde estás a criar o orçamento.`;
      if (!confirm(msgNew)) return;
    }
    try {
      await sync.createHousehold(name);
      showToast('Orçamento do casal criado na nuvem!', { type: 'success' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('createInvite').onclick = async () => {
    if (!isCurrentUserAdmin()) {
      alert('Apenas um Administrador pode gerar convites.');
      return;
    }
    const targetEmail = ($('inviteTargetEmail')?.value || '').trim().toLowerCase();
    const targetRole = $('inviteTargetRole')?.value || 'member';
    if (!targetEmail || !targetEmail.includes('@')) {
      alert('Introduz o endereço de email válido do utilizador que queres convidar.');
      if ($('inviteTargetEmail')) $('inviteTargetEmail').focus();
      return;
    }
    try {
      const code = await sync.createInvite(targetEmail, targetRole);
      const roleTxt = targetRole === 'admin' ? 'Administrador' : 'Utilizador';
      $('inviteResult').hidden = false;
      $('inviteResult').innerHTML =
        `Convite criado para <b>${esc(targetEmail)}</b> como <b>${roleTxt}</b>.<br>` +
        `Código alternativo (7 dias): <b>${esc(code)}</b> — Basta a pessoa iniciar sessão com esse email para entrar automaticamente.`;
      if ($('inviteTargetEmail')) $('inviteTargetEmail').value = '';
      showToast(`Convite (${roleTxt}) gerado para ${targetEmail}!`, { type: 'success' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('joinHousehold').onclick = async () => {
    try {
      await sync.acceptInvite($('inviteCode').value);
      showToast('Associado ao orçamento partilhado!', { type: 'success' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('syncNow').onclick = async () => {
    await sync.registerCurrentDevice();
    await sync.flushOutbox();
    await sync.fullPull();
    await renderLinkedDevicesPanel(true);
    const rem = getOutbox().length;
    if (rem > 0) {
      showToast(`Ainda existem ${rem} alteração(ões) pendentes na fila.`, { type: 'info' });
    } else {
      showToast('Sincronização concluída!', { type: 'success' });
    }
  };
  if ($('pushAllLocalBtn')) {
    $('pushAllLocalBtn').onclick = async () => {
      if (!sync.householdId) {
        alert('Liga primeiro a um orçamento partilhado.');
        return;
      }
      if (!confirm('Enviar todos os dados locais deste dispositivo (movimentos, cartões, categorias e objetivos) para a nuvem?')) return;
      await sync.queueAllLocalToOutbox();
      await sync.fullPull();
      const rem = getOutbox().length;
      if (rem === 0) {
        showToast('Todos os dados locais foram enviados para a nuvem!', { type: 'success' });
      } else {
        showToast(`Ficaram ${rem} item(ns) pendentes. Verifica a mensagem de estado acima.`, { type: 'info' });
      }
    };
  }
  if ($('clearOutboxBtn')) {
    $('clearOutboxBtn').onclick = async () => {
      if (!confirm('Remover os itens pendentes presos na fila de sincronização deste dispositivo?')) return;
      sync.clearAllOutbox();
      updateHouseholdPanels();
      render();
      showToast('Fila de sincronização limpa!', { type: 'success' });
      await sync.fullPull({ force: true });
    };
  }

  $('importLegacyBackup').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const converted = convertLegacyV1Backup(json);
      const now = Date.now();
      converted.household.id = sync.householdId || null;
      converted.household.updated_at = now;
      converted.meta = {
        category_rules: converted.meta?.category_rules || [],
        handled_rollovers: converted.meta?.handled_rollovers || [],
        household_id: sync.householdId || null,
        updated_at: now
      };
      ['categories', 'credit_cards', 'savings_goals', 'recurring_expenses', 'transactions'].forEach(tbl => {
        converted[tbl] = (converted[tbl] || [])
          .filter(item => !item.deleted_at)
          .map(item => ({
            ...item,
            household_id: sync.householdId || item.household_id || null,
            deleted_at: null,
            updated_at: now
          }));
      });

      sync.clearAllOutbox();
      state = converted;
      selectedCycleKey = null;
      movementCycleKey = null;
      encargosCycleKey = null;
      saveLocalState(state);
      render();
      if (sync.householdId) {
        await sync.queueAllLocalToOutbox();
        await sync.fullPull({ silent: true });
      }
      showToast(`Cópia de segurança restaurada (${state.transactions.length} movimentos)!`, { type: 'success' });
    } catch (err) {
      alert('Erro ao migrar backup: ' + err.message);
    }
    e.target.value = '';
  };

  $('exportBackupBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duofin2-backup-${iso()}.json`;
    a.click();
    localStorage.setItem('duofin2_last_backup_date', new Date().toISOString());
    initStorageProtectionAndBackupReminder();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Cópia de segurança exportada!', { type: 'success' });
  };

  if ($('exportCyclePdfBtn')) {
    $('exportCyclePdfBtn').onclick = () => {
      const cycles = buildCycles(state);
      const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
      generateCyclePdfReport(state, cycle);
    };
  }

  if ($('exportMovementsPdfBtn')) {
    $('exportMovementsPdfBtn').onclick = () => {
      const cycles = buildCycles(state);
      const cycle = cycles.find(c => c.key === movementCycleKey) || currentCycle(cycles);
      let list = state.transactions.filter(t => !t.deleted_at);
      if (movementCycleKey && movementCycleKey !== 'all') {
        const cy = cycles.find(c => c.key === movementCycleKey);
        if (cy) list = list.filter(t => t.date >= cy.start && t.date <= cy.end);
      }
      const tp = $('filter').value;
      if (tp === 'expense') list = list.filter(t => t.type === 'expense');
      else if (tp === 'cc_expense') list = list.filter(t => t.type === 'expense' && t.credit_card_id);
      else if (tp !== 'all') list = list.filter(t => t.type === tp);
      const df = $('filterDateFrom').value;
      const dt = $('filterDateTo').value;
      if (df) list = list.filter(t => t.date >= df);
      if (dt) list = list.filter(t => t.date <= dt);
      const q = $('filterSearch').value.trim().toLowerCase();
      if (q) list = list.filter(t => String(t.description || '').toLowerCase().includes(q));
      const cat = $('filterCategory').value;
      if (cat !== 'all') list = list.filter(t => t.category === cat);
      const per = $('filterPerson').value;
      if (per !== 'all') list = list.filter(t => t.person === per);

      generateCyclePdfReport(state, cycle, list, 'Relatório de Movimentos Filtrados');
    };
  }

  $('exportCsvBtn').onclick = () => {
    const rows = [['Data', 'Tipo', 'Descrição', 'Categoria', 'Responsável', 'Valor']]
      .concat(state.transactions.filter(t => !t.deleted_at).map(t => [t.date, t.type, `"${t.description}"`, t.category, t.person, t.amount]));
    const blob = new Blob(['\uFEFF' + rows.map(r => r.join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duofin2-movimentos-${iso()}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  $('togglePasteExtractBtn').onclick = () => ($('pasteExtractBox').hidden = !$('pasteExtractBox').hidden);
  $('cancelPasteTextBtn').onclick = () => ($('pasteExtractBox').hidden = true);
  $('parsePastedTextBtn').onclick = () => {
    const lines = $('pasteExtractText').value.split(/\r?\n/);
    showImportPreview(parseStatementLines(state, lines));
  };

  $('csvFileInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const lines = file.name.toLowerCase().endsWith('.pdf')
        ? await extractLinesFromPdf(file)
        : (await file.text()).split(/\r?\n/);
      showImportPreview(parseStatementLines(state, lines));
    } catch (err) {
      alert(err.message);
    }
    e.target.value = '';
  };

  function showImportPreview(rows, skipReeval = false) {
    parsedImportRows = skipReeval ? rows : evaluateStatementDuplicates(rows, state.transactions, { dayWindow: 3 });
    if (!parsedImportRows.length) {
      alert('Nenhum movimento reconhecido neste ficheiro. Experimenta copiar as linhas do extrato e usar "Colar texto".');
      return;
    }
    const activeCats = (state.categories || [])
    .filter(c => !c.deleted_at)
    .sort((a, b) => (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999) || String(a.name).localeCompare(String(b.name)));
    const catOpts = activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    const dupCount = parsedImportRows.filter(r => r.isDuplicate).length;

    $('csvPreviewContainer').hidden = false;
    $('csvToggleAll').checked = dupCount === 0;
    $('csvSummaryCount').textContent = dupCount > 0
      ? `${parsedImportRows.length} detetado(s) · ⚠️ ${dupCount} possível(is) duplicado(s) desmarcado(s)`
      : `${parsedImportRows.length} movimento(s) detetado(s)`;

    $('csvPreviewList').innerHTML = parsedImportRows
      .map((r, i) => `
        <div class="item ${r.isDuplicate ? 'import-row-duplicate' : ''}" style="display:flex;flex-direction:column;gap:6px">
          <div class="row">
            <label class="checkbox-row" style="margin:0;flex:1;min-width:0">
              <input type="checkbox" data-imp-idx="${i}" ${r.selected ? 'checked' : ''}>
              <span style="overflow:hidden;text-overflow:ellipsis">${fmtDate(r.date)} · <b>${esc(r.description)}</b></span>
            </label>
            <b class="${r.type === 'income' ? 'plus' : 'minus'}" style="white-space:nowrap">${r.type === 'income' ? '+' : '−'} ${eur(r.amount)}</b>
          </div>
          ${r.isDuplicate ? `<div style="padding-left:24px"><span class="dup-badge" title="${esc(r.duplicateReason)}">⚠️ Possível duplicado (${fmtDate(r.matchedTx.date)} · ${esc(r.matchedTx.description)})</span></div>` : ''}
          <div class="row" style="gap:8px;padding-left:24px">
            <select data-imp-type="${i}" style="padding:4px 8px;font-size:12px;max-width:155px">
              <option value="expense" ${r.type === 'expense' ? 'selected' : ''}>Despesa</option>
              <option value="income" ${r.type === 'income' ? 'selected' : ''}>Rendimento</option>
              <option value="transfer" ${r.type === 'transfer' ? 'selected' : ''}>Transferência int.</option>
            </select>
            <select data-imp-cat="${i}" style="padding:4px 8px;font-size:12px;flex:1" ${r.type !== 'expense' ? 'disabled' : ''}>
              ${catOpts}
            </select>
          </div>
        </div>
      `)
      .join('');

    parsedImportRows.forEach((r, i) => {
      const catSel = document.querySelector(`[data-imp-cat="${i}"]`);
      if (catSel && r.type === 'expense') catSel.value = r.category;
      const typeSel = document.querySelector(`[data-imp-type="${i}"]`);
      if (typeSel) {
        typeSel.onchange = () => {
          r.type = typeSel.value;
          if (catSel) catSel.disabled = r.type !== 'expense';
          showImportPreview(parsedImportRows, false);
        };
      }
      if (catSel) {
        catSel.onchange = () => {
          r.category = catSel.value;
          r._userChangedCat = true;
        };
      }
    });
  }

  $('csvToggleAll').onchange = e => {
    document.querySelectorAll('[data-imp-idx]').forEach(cb => (cb.checked = e.target.checked));
  };
  $('csvCancelImportBtn').onclick = () => ($('csvPreviewContainer').hidden = true);
  $('csvConfirmImportBtn').onclick = () => {
    let count = 0;
    let learnedAny = false;
    const defPerson = $('csvDefaultPerson').value || 'Conta conjunta';
    document.querySelectorAll('[data-imp-idx]').forEach(cb => {
      if (!cb.checked) return;
      const idx = Number(cb.dataset.impIdx);
      const r = parsedImportRows[idx];
      if (!r) return;

      const finalType = document.querySelector(`[data-imp-type="${idx}"]`)?.value || r.type;
      const finalCat = finalType === 'income'
        ? 'Rendimento'
        : finalType === 'transfer'
        ? 'Transferência interna'
        : (document.querySelector(`[data-imp-cat="${idx}"]`)?.value || r.category);

      if (finalType === 'expense' && r._userChangedCat) {
        learnCategoryRule(state, r.description, finalCat);
        learnedAny = true;
      }

      const tx = {
        id: uid('imp'),
        date: r.date,
        type: finalType,
        description: r.description,
        amount: r.amount,
        category: finalCat,
        person: defPerson,
        status: 'confirmed',
        counts_for_cycle: true,
        updated_at: Date.now()
      };
      state.transactions.push(tx);
      enqueueOutbox('transactions', tx);
      count++;
    });

    if (learnedAny && sync.householdId) {
      enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
    }
    saveLocalState(state);
    $('csvPreviewContainer').hidden = true;
    render();
    sync.flushOutbox();
    showToast(`${count} movimento(s) importado(s) e sincronizado(s)!`, { type: 'success' });
    checkAutomaticCycleRollover();
  };

  $('privacyToggleBtn').onclick = () => security.togglePrivacy();
  $('lockAppHeaderBtn').onclick = () => security.lock();
  $('lockNowBtn').onclick = () => security.lock();
  $('savePinBtn').onclick = async () => {
    const pin = $('newPinInput').value.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      alert('O PIN deve ter entre 4 e 6 dígitos.');
      return;
    }
    await security.setPin(pin, $('autoLockMinutes').value);
    $('newPinInput').value = '';
    render();
    showToast('PIN local guardado.', { type: 'success' });
  };
  $('enableBioBtn').onclick = async () => {
    try {
      await security.enableBiometrics();
      render();
      showToast('Biometria ativada neste dispositivo!', { type: 'success' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('disablePinBtn').onclick = () => {
    if (confirm('Remover o bloqueio por PIN neste dispositivo?')) {
      security.disablePin();
      render();
      showToast('PIN removido.');
    }
  };
  $('appLockUnlockBtn').onclick = async () => {
    const ok = await security.verifyPin($('appLockPinInput').value.trim());
    if (!ok) $('appLockError').textContent = 'PIN incorreto.';
  };
  $('appLockPinInput').onkeydown = e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('appLockUnlockBtn').click();
    }
  };
  $('appLockBioBtn').onclick = () => security.unlockWithBiometrics();

  if ($('resetDatabaseBtn')) {
    $('resetDatabaseBtn').onclick = async () => {
      if (!confirm('Tens a certeza que queres APAGAR TODOS os dados (movimentos, cartões, objetivos, caderno de encargos e regras)? Esta ação não pode ser desfeita.')) return;
      if (!confirm('Confirmação final: Limpar mesmo toda a base de dados e começar de novo?')) return;

      const now = Date.now();
      sync.clearAllOutbox();
      if (sync.householdId) {
        (state.transactions || []).forEach(t => { if (!t.deleted_at) { t.deleted_at = now; t.updated_at = now; enqueueOutbox('transactions', t); } });
        (state.credit_cards || []).forEach(c => { if (!c.deleted_at) { c.deleted_at = now; c.updated_at = now; enqueueOutbox('credit_cards', c); } });
        (state.savings_goals || []).forEach(g => { if (!g.deleted_at) { g.deleted_at = now; g.updated_at = now; enqueueOutbox('savings_goals', g); } });
        (state.recurring_expenses || []).forEach(r => { if (!r.deleted_at) { r.deleted_at = now; r.updated_at = now; enqueueOutbox('recurring_expenses', r); } });
        (state.categories || []).forEach(c => { if (!c.deleted_at) { c.deleted_at = now; c.updated_at = now; enqueueOutbox('categories', c); } });
      }

      const fresh = createInitialState();
      fresh.household.id = sync.householdId || null;
      fresh.household.adult1_name = state.household.adult1_name || 'Adulto 1';
      fresh.household.adult2_name = state.household.adult2_name || 'Adulto 2';
      fresh.household.cycle_grouping_days = state.household.cycle_grouping_days ?? 14;
      state = fresh;

      if (sync.householdId) {
        state.categories.forEach(c => enqueueOutbox('categories', c));
        enqueueOutbox('household_meta', { ...state.meta, household_id: sync.householdId });
      }

      selectedCycleKey = null;
      movementCycleKey = null;
      encargosCycleKey = null;
      try { localStorage.removeItem(DISMISSED_ALERTS_KEY); } catch {}
      saveLocalState(state);
      render();
      if (sync.householdId) await sync.flushOutbox();
      showToast('Base de dados limpa com sucesso! Pronto para começar de novo.', { type: 'success' });
    };
  }

  window.addEventListener('online', () => sync.resumeFromBackground());
  window.addEventListener('offline', () => {
    if (sync.householdId) {
      const badge = $('syncHeaderBadge');
      if (badge) {
        badge.textContent = '○ Offline';
        badge.className = 'sync-badge offline';
      }
    }
  });
  window.addEventListener('pageshow', e => {
    if (e.persisted) sync.resumeFromBackground();
  });
  window.addEventListener('focus', () => {
    sync.resumeFromBackground();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sync.resumeFromBackground();
    }
  });

  if ($('quickTxForm')) {
    $('quickTxForm').onsubmit = e => {
      e.preventDefault();
      const rawAmt = String($('qAmount').value || '').replace(',', '.').trim();
      const amount = Math.abs(parseFloat(rawAmt));
      const description = ($('qDesc').value || '').trim();
      if (!description || !Number.isFinite(amount) || amount <= 0) {
        showToast('Preenche a descrição e um valor válido.', { type: 'error' });
        return;
      }
      const type = $('qType').value || 'expense';
      const cardId = type === 'expense' ? ($('qCard').value || null) : null;
      const rec = {
        id: crypto.randomUUID(),
        household_id: sync.householdId || null,
        date: $('qDate').value || iso(),
        type,
        description,
        amount,
        category: type === 'expense' ? ($('qCategory').value || 'Outros') : 'Outros',
        person: $('qPerson').value || (state.household.adult1_name || 'Adulto 1'),
        status: 'paid',
        credit_card_id: cardId,
        goal_id: null,
        recurrence_id: null,
        occurrence_key: null,
        installment_group_id: null,
        installment_index: null,
        installment_total: null,
        updated_at: Date.now(),
        deleted_at: null
      };
      state.transactions.push(rec);
      $('qDesc').value = '';
      $('qAmount').value = '';
      mutate('transactions', rec);
      showToast('Movimento registado!', { type: 'success' });
    };
  }


  // --- Instalação PWA (PC / Android / iOS) ---
  let deferredInstallPrompt = null;
  function updateInstallAppUi() {
    const btn = $('installPwaBtn');
    const statusEl = $('installAppStatus');
    const badgeEl = $('installAppBadge');
    const guideEl = $('installManualGuide');
    if (!btn || !statusEl) return;

    const isStandalone =
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;

    if (isStandalone) {
      if (badgeEl) badgeEl.textContent = '✅ Instalada';
      statusEl.className = 'alert good';
      statusEl.textContent = '✅ A DuoFin 2 já está instalada e a correr como aplicação neste dispositivo.';
      btn.hidden = true;
      if (guideEl) guideEl.hidden = true;
      return;
    }

    btn.hidden = false;
    if (deferredInstallPrompt) {
      if (badgeEl) badgeEl.textContent = 'Pronta a instalar';
      statusEl.className = 'alert good';
      statusEl.textContent = 'O navegador está pronto para instalar a DuoFin 2 neste dispositivo com um clique.';
      btn.textContent = '📲 Instalar aplicação agora';
    } else {
      if (badgeEl) badgeEl.textContent = 'Instalação PWA';
      statusEl.className = 'alert';
      statusEl.textContent = 'Clica no botão abaixo para instalar ou ver o atalho rápido do teu navegador.';
      btn.textContent = '📲 Instalar aplicação neste dispositivo';
    }
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallAppUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallAppUi();
    showToast('DuoFin 2 instalada com sucesso!', { type: 'success' });
  });

  if ($('installPwaBtn')) {
    $('installPwaBtn').onclick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice.catch(() => null);
        if (choice && choice.outcome === 'accepted') {
          deferredInstallPrompt = null;
        }
        updateInstallAppUi();
        return;
      }

      const guideEl = $('installManualGuide');
      if (guideEl) {
        const ua = navigator.userAgent || '';
        const isIOS = /iPhone|iPad|iPod/i.test(ua);
        const isEdge = /Edg\//i.test(ua);
        guideEl.hidden = false;
        if (isIOS) {
          guideEl.innerHTML =
            '<strong>Como instalar no iPhone / iPad (Safari):</strong><br>' +
            '1. Toca no ícone <b>Partilhar</b> (quadrado com seta para cima) na barra inferior do Safari.<br>' +
            '2. Desliza para baixo e toca em <b>Adicionar ao ecrã principal</b>.<br>' +
            '3. Toca em <b>Adicionar</b> no canto superior direito.';
        } else if (isEdge) {
          guideEl.innerHTML =
            '<strong>Como instalar no PC (Microsoft Edge):</strong><br>' +
            '1. Na extremidade direita da barra de endereços, clica no ícone <b>Aplicação disponível</b> (quadrado com <b>+</b>).<br>' +
            '2. Ou abre o menu <b>⋯</b> (canto superior direito) → <b>Aplicações</b> → <b>Instalar este site como uma aplicação</b>.';
        } else {
          guideEl.innerHTML =
            '<strong>Como instalar no PC / Android (Google Chrome):</strong><br>' +
            '1. Na barra de endereços (à direita), clica no ícone <b>Instalar DuoFin 2</b> (ecrã com seta para baixo).<br>' +
            '2. Ou abre o menu <b>⋮</b> (canto superior direito) → <b>Guardar e partilhar</b> → <b>Instalar página como aplicação…</b>';
        }
      }
    };
  }
  updateInstallAppUi();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js?v=2.9.0').then(reg => reg.update()).catch(() => {});
  }

  render();
  checkAutomaticCycleRollover();
  initStorageProtectionAndBackupReminder();
  sync.connectAndSubscribe();
  // Fechar suavemente o ecrã de arranque (Splash Screen)
  const splashEl = $('appSplashScreen');
  if (splashEl) {
    setTimeout(() => {
      splashEl.classList.add('is-hidden');
      setTimeout(() => splashEl.remove(), 460);
    }, 750);
  }
});
