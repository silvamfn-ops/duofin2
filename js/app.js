import {
  APP_VERSION, $, iso, currentMonth, eur, esc, sum, isPaid, fmtDate,
  addMonthsClamp, uid, haptic, showToast, evaluateAmountExpression,
  loadUiPrefs, saveUiPrefs, applyThemeAndDensity
} from './config.js';
import {
  loadLocalState, saveLocalState, enqueueOutbox,
  convertLegacyV1Backup, getOutbox
} from './db.js';
import { DuoFinSync } from './supabase-sync.js';
import {
  buildCycles, currentCycle, cycleTransactions, computeCycleBalance,
  computeCycleProjection, computeDailyBurnRate, getAllCreditCardsStats, computeCreditCardDebt,
  goalTotal, getPeopleList, computeCycleReferenceMonth
} from './finance-engine.js';
import { SecurityManager } from './security.js';
import { extractLinesFromPdf, parseStatementLines, guessCategory, learnCategoryRule } from './importers.js';
import { drawSavingsChart, drawAnalyticsChart } from './charts.js';

let state = loadLocalState();
let selectedCycleKey = null;
let movementCycleKey = null;
let quickStatusFilter = 'all';
let calendarMonthStr = currentMonth();
let selectedCalendarDay = iso();
let parsedImportRows = [];

const security = new SecurityManager();
security.applyPrivacy();
security.startIdleWatcher();
if (security.hasPin()) security.lock();

const sync = new DuoFinSync(
  () => state,
  () => {
    materializeRecurringTransactions();
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
  }
);

function mutate(table, record) {
  record.updated_at = Date.now();
  saveLocalState(state);
  enqueueOutbox(table, record);
  render();
  sync.flushOutbox();
}

function updateHouseholdPanels() {
  if ($('cloudLogout')) $('cloudLogout').hidden = !sync.user;
  if ($('householdPanel')) $('householdPanel').hidden = !sync.user;
  if ($('householdInfo')) {
    $('householdInfo').textContent = sync.householdId
      ? `Orçamento ligado (${sync.householdId.slice(0, 8)}…) · ${getOutbox().length} alteração(ões) na fila`
      : 'Cria um orçamento do casal ou insere o código de convite recebido.';
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

function materializeRecurringTransactions() {
  const curM = currentMonth();
  let changed = false;
  for (const r of state.recurring_expenses || []) {
    if (r.deleted_at || r.active === false) continue;
    if (!r.start_month || r.start_month > curM) continue;
    if (r.end_month && r.end_month < curM) continue;

    const occKey = `${r.id}:${curM}`;
    const exists = state.transactions.some(t => !t.deleted_at && t.occurrence_key === occKey);
    if (!exists) {
      const [y, m] = curM.split('-').map(Number);
      const maxD = new Date(y, m, 0).getDate();
      const day = Math.min(Number(r.day_of_month) || 1, maxD);
      const tx = {
        id: uid('rec-tx'),
        date: `${curM}-${String(day).padStart(2, '0')}`,
        type: 'expense',
        description: r.description,
        amount: Number(r.amount) || 0,
        category: r.category,
        person: r.person || 'Conta conjunta',
        status: 'pending',
        recurrence_id: r.id,
        occurrence_key: occKey,
        counts_for_cycle: true,
        updated_at: Date.now()
      };
      state.transactions.push(tx);
      enqueueOutbox('transactions', tx);
      changed = true;
    }
  }
  if (changed) saveLocalState(state);
}

function render() {
  document.title = `DuoFin ${APP_VERSION} — Gestão financeira a dois`;
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
  const bal = computeCycleBalance(state, cycle, today);

  $('inc').textContent = eur(sum(inc));
  $('exp').textContent = eur(sum(ex));
  $('bal').textContent = eur(bal);
  $('bal').className = bal < 0 ? 'minus' : '';
  $('savm').textContent = eur(sum(svIn) - sum(svOut));

  const totalBudget = (state.categories || []).filter(c => !c.deleted_at).reduce((a, c) => a + (Number(c.budget) || 0), 0);
  if ($('basicCycleProgressWrap')) {
    if (prefs.summaryLevel === 'basic' && totalBudget > 0) {
      $('basicCycleProgressWrap').hidden = false;
      const pct = Math.min(100, (sum(ex) / totalBudget) * 100);
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

  const activeCats = (state.categories || []).filter(c => !c.deleted_at);
  const ccStats = getAllCreditCardsStats(state);
  if ($('alerts')) {
    const alertHtml = [];
    for (const c of activeCats) {
      if (c.budget > 0) {
        const spent = sum(ex.filter(t => t.category === c.name));
        if (spent > c.budget) {
          alertHtml.push(`<div class="alert red">⚠️ <b>${esc(c.name)}</b> ultrapassou o limite em ${eur(spent - c.budget)} (${eur(spent)} / ${eur(c.budget)}).</div>`);
        } else if (spent >= c.budget * 0.85) {
          alertHtml.push(`<div class="alert">⚡ <b>${esc(c.name)}</b> já atingiu ${Math.round((spent / c.budget) * 100)}% do orçamento (${eur(spent)} / ${eur(c.budget)}).</div>`);
        }
      }
    }
    for (const card of ccStats) {
      if (card.limit > 0 && card.debt >= card.limit * 0.8) {
        alertHtml.push(`<div class="alert ${card.debt >= card.limit ? 'red' : ''}">💳 Cartão <b>${esc(card.name)}</b> com ${Math.round(card.pct)}% do plafond utilizado (${eur(card.debt)} / ${eur(card.limit)}).</div>`);
      }
    }
    $('alerts').innerHTML = alertHtml.join('');
  }

  $('cats').innerHTML = activeCats
    .map(c => {
      const v = sum(ex.filter(t => t.category === c.name));
      const pct = c.budget ? Math.min(100, (v / c.budget) * 100) : 0;
      const cls = c.budget ? (v > c.budget ? 'over' : v >= c.budget * 0.85 ? 'warn' : '') : '';
      return `<div class="barline"><span class="barline-name">${esc(c.name)}</span><div class="bar"><i class="${cls}" style="width:${pct}%"></i></div><span class="barline-val"><b>${eur(v)}</b> / ${Math.round(c.budget)}€</span></div>`;
    })
    .join('');

  const people = getPeopleList(state);
  const totalExpVal = Math.max(1, sum(ex));
  $('persons').innerHTML = people
    .map(p => {
      const v = sum(ex.filter(t => t.person === p));
      const pct = Math.min(100, (v / totalExpVal) * 100);
      return `<div class="barline"><span class="barline-name">${esc(p)}</span><div class="bar"><i style="width:${pct}%"></i></div><span class="barline-val"><b>${eur(v)}</b></span></div>`;
    })
    .join('');

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
              `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${esc(c.owner)} · Dívida atual: <b>${eur(c.debt)}</b></div></div><button type="button" class="danger" data-del-cc="${esc(c.id)}">Remover</button></div>`
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
            const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
            return `<div class="item"><div class="row"><b>${esc(g.name)}</b><span class="small">${eur(saved)} / ${eur(g.target)} (${Math.round(pct)}%)</span></div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
          })
          .join('')
      : '<div class="empty">Ainda sem objetivos de poupança.</div>';
  }

  $('goalList').innerHTML = activeGoals.length
    ? activeGoals
        .map(g => {
          const saved = goalTotal(state, g.id);
          const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
          return `<div class="card"><div class="row"><b>${esc(g.name)}</b><div class="row" style="gap:6px"><span class="pill">${Math.round(pct)}%</span><button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-goal="${esc(g.id)}">✎</button><button type="button" class="danger" data-del-goal="${esc(g.id)}">×</button></div></div><div class="small">${eur(saved)} / ${eur(g.target)}${g.deadline ? ` · Meta: ${fmtDate(g.deadline)}` : ''}</div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
        })
        .join('')
    : '<div class="card empty">Ainda não existem objetivos de poupança.</div>';

  const recent = [...tx].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  $('recent').innerHTML = recent.length
    ? recent.map(renderTxRow).join('')
    : '<div class="empty">Ainda sem movimentos neste ciclo.</div>';

  renderFilteredTransactions(cycles);
  renderQuickTemplates();

  const peopleHtml = people.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('person').innerHTML = peopleHtml;
  if ($('ccOwner')) $('ccOwner').innerHTML = peopleHtml;
  if ($('recurrencePerson')) $('recurrencePerson').innerHTML = peopleHtml;
  if ($('csvDefaultPerson')) $('csvDefaultPerson').innerHTML = peopleHtml;
  $('filterPerson').innerHTML = '<option value="all">Todos</option>' + peopleHtml;

  const catsHtml = activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('category').innerHTML = catsHtml;
  if ($('recurrenceCategory')) $('recurrenceCategory').innerHTML = catsHtml;
  if ($('simCategory')) $('simCategory').innerHTML = catsHtml;
  $('filterCategory').innerHTML = '<option value="all">Todas as categorias</option>' + catsHtml;

  const cards = (state.credit_cards || []).filter(c => !c.deleted_at);
  $('paymentMethod').innerHTML =
    '<option value="bank">Conta à ordem / Débito / Dinheiro</option>' +
    cards.map(c => `<option value="cc:${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');
  $('ccPaymentCard').innerHTML =
    '<option value="">Selecionar cartão…</option>' +
    cards.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  $('savingGoal').innerHTML =
    '<option value="">Sem objetivo</option>' + activeGoals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

  $('budgetFields').innerHTML = activeCats
    .map(
      c =>
        `<div class="item row"><span>${esc(c.name)}</span><input data-cat-budget-id="${esc(c.id)}" type="number" step="0.01" value="${Number(c.budget) || 0}" style="width:120px;text-align:right"></div>`
    )
    .join('');
  $('budgetTotal').textContent = eur(totalBudget);

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

  list.sort((a, b) => b.date.localeCompare(a.date));

  const hasFilters = tp !== 'all' || df || dt || q || cat !== 'all' || per !== 'all' || quickStatusFilter !== 'all';
  $('resetFiltersBtn').hidden = !hasFilters;
  $('filterCountLabel').textContent = `${list.length} movimento(s) · Total: ${eur(sum(list))}`;

  $('transactions').innerHTML = list.length
    ? list.map(renderTxRow).join('')
    : '<div class="empty">Nenhum movimento encontrado com estes filtros.</div>';
}

function renderTxRow(t) {
  const cls = t.type === 'income' ? 'plus' : t.type === 'saving_withdraw' || t.type === 'cc_payment' ? 'neutral' : 'minus';
  const sign = t.type === 'income' ? '+' : t.type === 'saving' ? '↗' : t.type === 'saving_withdraw' ? '↙' : t.type === 'cc_payment' ? '⇄' : '−';
  const ccTag = t.credit_card_id ? ' · 💳 Cartão' : '';
  const statusTag = t.status === 'pending' ? ' · ⏳ Pendente' : t.status === 'skipped' ? ' · 🚫 Ignorado' : '';
  return `<div class="item row tx-clickable" data-open-tx="${esc(t.id)}">
    <div style="min-width:0;flex:1">
      <b>${esc(t.description)}</b>
      <div class="small">${fmtDate(t.date)} · ${esc(t.category)} · ${esc(t.person)}${ccTag}${statusTag}</div>
    </div>
    <b class="amount ${cls}" style="white-space:nowrap">${sign} ${eur(t.amount)}</b>
  </div>`;
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

function renderRecurringSection() {
  const rules = (state.recurring_expenses || []).filter(r => !r.deleted_at);
  $('recurrenceRules').innerHTML = rules.length
    ? rules
        .map(
          r =>
            `<div class="item row"><div><b>${esc(r.description)}</b><div class="small">Dia ${r.day_of_month} · ${esc(r.category)} · ${esc(r.person)}</div></div><div class="row" style="gap:6px"><b>${eur(r.amount)}</b><button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-rec="${esc(r.id)}">✎</button><button type="button" class="danger" data-del-rec="${esc(r.id)}">×</button></div></div>`
        )
        .join('')
    : '<div class="empty">Sem despesas recorrentes configuradas.</div>';

  const pending = state.transactions.filter(t => !t.deleted_at && t.status === 'pending');
  $('pendingRecurring').innerHTML = pending.length
    ? pending
        .map(
          t =>
            `<div class="item row"><div><b>${esc(t.description)}</b><div class="small">${fmtDate(t.date)} · ${eur(t.amount)}</div></div><div class="row" style="gap:6px"><button type="button" class="primary" style="padding:6px 10px;font-size:12px" data-confirm-pending="${esc(t.id)}">Confirmar</button><button type="button" class="ghost" style="padding:6px 10px;font-size:12px" data-skip-pending="${esc(t.id)}">Ignorar</button></div></div>`
        )
        .join('')
    : '<div class="empty">Nenhuma despesa pendente de confirmação.</div>';

  const badgeCount = pending.length;
  ['mobileMoreBadge', 'drawerRecBadge', 'desktopRecBadge'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.hidden = badgeCount === 0;
    el.textContent = badgeCount;
  });
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

  const weekHeaders = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom']
    .map(d => `<div class="cal-head">${d}</div>`)
    .join('');

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day is-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calendarMonthStr}-${String(d).padStart(2, '0')}`;
    const dayTx = state.transactions.filter(t => !t.deleted_at && t.date === dateStr);
    const hasExp = dayTx.some(t => t.type === 'expense');
    const hasInc = dayTx.some(t => t.type === 'income');
    const hasSav = dayTx.some(t => t.type === 'saving' || t.type === 'saving_withdraw');
    const dots =
      (hasExp ? '<i class="dot dot-exp"></i>' : '') +
      (hasInc ? '<i class="dot dot-inc"></i>' : '') +
      (hasSav ? '<i class="dot dot-sav"></i>' : '');
    const cls = `cal-day${dateStr === today ? ' is-today' : ''}${dateStr === selectedCalendarDay ? ' is-selected' : ''}`;
    cells += `<div class="${cls}" data-cal-day="${dateStr}"><strong>${d}</strong><div class="cal-dots">${dots}</div></div>`;
  }

  $('calendar').innerHTML = weekHeaders + cells;
  $('dayTitle').textContent = `Movimentos de ${fmtDate(selectedCalendarDay)}`;
  const items = state.transactions.filter(t => !t.deleted_at && t.date === selectedCalendarDay);
  $('dayItems').innerHTML = items.length ? items.map(renderTxRow).join('') : '<div class="empty">Sem movimentos neste dia.</div>';
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
    saving_withdraw: 'Resgate de poupança'
  };
  const icons = { expense: '💸', cc_payment: '💳', income: '💰', saving: '🎯', saving_withdraw: '🏦' };
  $('txModalIcon').textContent = icons[tx.type] || '🧾';
  $('txModalAmountDisplay').textContent = eur(tx.amount);
  $('txModalAmountDisplay').className = 'tx-modal-amount ' + (tx.type === 'income' ? 'plus' : tx.type === 'expense' ? 'minus' : 'neutral');
  $('txModalDescDisplay').textContent = tx.description;
  $('txModalDateDisplay').textContent = fmtDate(tx.date);
  $('txModalTypeDisplay').textContent = typeLabels[tx.type] || tx.type;
  $('txModalCatDisplay').textContent = tx.category;
  $('txModalPersonDisplay').textContent = tx.person;
  $('txModalSubtitle').textContent = tx.status === 'pending' ? 'Estado: Pendente' : 'Estado: Confirmado';

  $('txDetailModal').hidden = false;
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

  $('modalEditPaymentMethod').innerHTML = $('paymentMethod').innerHTML;
  $('modalEditPaymentMethod').value = tx.credit_card_id ? `cc:${tx.credit_card_id}` : 'bank';
  $('modalEditCcPaymentCard').innerHTML = $('ccPaymentCard').innerHTML;
  $('modalEditCcPaymentCard').value = tx.credit_card_id || '';
  $('modalEditGoal').innerHTML = $('savingGoal').innerHTML;
  $('modalEditGoal').value = tx.goal_id || '';

  updateModalEditVisibility();
}

function updateModalEditVisibility() {
  const tp = $('modalEditType').value;
  $('modalEditCatWrap').hidden = tp !== 'expense';
  $('modalEditPaymentMethodWrap').hidden = tp !== 'expense';
  $('modalEditCcPaymentWrap').hidden = tp !== 'cc_payment';
  $('modalEditGoalWrap').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
  $('modalEditIncomeCycleWrap').hidden = tp !== 'income';
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

document.addEventListener('DOMContentLoaded', () => {
  applyThemeAndDensity(() => drawSavingsChart(state));
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      applyThemeAndDensity(() => drawSavingsChart(state));
    });
  }

  $('date').value = iso();
  if ($('recurrenceStart')) $('recurrenceStart').value = currentMonth();
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

  $('quickAddFab').onclick = () => {
    switchTab('movimentos');
    $('desc').focus();
  };

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
    $('categoryField').hidden = tp !== 'expense';
    $('installmentsField').hidden = tp !== 'expense';
    $('expensePaymentMethodField').hidden = tp !== 'expense';
    $('ccPaymentField').hidden = tp !== 'cc_payment';
    $('savingGoalField').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
    $('incomeCycleField').hidden = tp !== 'income';
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
        category: tp === 'expense' ? $('category').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : 'Poupança',
        person: $('person').value,
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
    render();
    sync.flushOutbox();
    haptic([14, 25, 14]);
    showToast(isInst ? `${count} prestações registadas e sincronizadas!` : 'Movimento guardado e sincronizado.', { type: 'success' });
  };

  ['movementCycle', 'filter', 'filterDateFrom', 'filterDateTo', 'filterSearch', 'filterCategory', 'filterPerson'].forEach(id => {
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

    const delCc = e.target.closest('[data-del-cc]');
    if (delCc) {
      const card = state.credit_cards.find(c => String(c.id) === String(delCc.dataset.delCc));
      if (card && confirm(`Remover cartão "${card.name}"?`)) {
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
        $('goalTarget').value = g.target;
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
        g.deleted_at = Date.now();
        mutate('savings_goals', g);
      }
      return;
    }

    const editRec = e.target.closest('[data-edit-rec]');
    if (editRec) {
      const r = state.recurring_expenses.find(x => String(x.id) === String(editRec.dataset.editRec));
      if (r) {
        $('recurrenceId').value = r.id;
        $('recurrenceDescription').value = r.description;
        $('recurrenceAmount').value = r.amount;
        $('recurrenceCategory').value = r.category;
        $('recurrencePerson').value = r.person;
        $('recurrenceDay').value = r.day_of_month;
        $('recurrenceStart').value = r.start_month;
        $('recurrenceEnd').value = r.end_month || '';
        $('recurrenceFormTitle').textContent = 'Editar despesa recorrente';
        $('recurrenceSave').textContent = 'Guardar alterações';
        $('recurrenceCancel').hidden = false;
        $('recurrenceDescription').focus();
      }
      return;
    }

    const delRec = e.target.closest('[data-del-rec]');
    if (delRec) {
      const r = state.recurring_expenses.find(x => String(x.id) === String(delRec.dataset.delRec));
      if (r && confirm(`Remover regra "${r.description}"?`)) {
        r.deleted_at = Date.now();
        mutate('recurring_expenses', r);
      }
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
    const tp = $('modalEditType').value;
    tx.date = $('modalEditDate').value;
    tx.type = tp;
    tx.description = $('modalEditDesc').value.trim();
    tx.amount = Number(val.toFixed(2));
    tx.category = tp === 'expense' ? $('modalEditCat').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : 'Poupança';
    tx.person = $('modalEditPerson').value;
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
    showToast('Alterações guardadas e sincronizadas.', { type: 'success' });
  };

  ['analyticsCycleSelect', 'analyticsMetric', 'analyticsChartType'].forEach(id => {
    $(id).onchange = updateAnalyticsView;
  });

  $('recurrenceCancel').onclick = () => {
    $('recurrenceId').value = '';
    $('recurrenceForm').reset();
    $('recurrenceStart').value = currentMonth();
    $('recurrenceFormTitle').textContent = 'Nova despesa recorrente';
    $('recurrenceSave').textContent = 'Guardar recorrência';
    $('recurrenceCancel').hidden = true;
  };

  $('recurrenceForm').onsubmit = e => {
    e.preventDefault();
    const editId = $('recurrenceId').value;
    if (editId) {
      const rule = state.recurring_expenses.find(r => String(r.id) === String(editId));
      if (rule) {
        rule.description = $('recurrenceDescription').value.trim();
        rule.amount = Number($('recurrenceAmount').value);
        rule.category = $('recurrenceCategory').value;
        rule.person = $('recurrencePerson').value;
        rule.day_of_month = Number($('recurrenceDay').value);
        rule.start_month = $('recurrenceStart').value;
        rule.end_month = $('recurrenceEnd').value || null;
        mutate('recurring_expenses', rule);
        showToast('Regra recorrente atualizada!', { type: 'success' });
      }
      $('recurrenceCancel').click();
      return;
    }

    const rule = {
      id: uid('rec'),
      description: $('recurrenceDescription').value.trim(),
      amount: Number($('recurrenceAmount').value),
      category: $('recurrenceCategory').value,
      person: $('recurrencePerson').value,
      day_of_month: Number($('recurrenceDay').value),
      start_month: $('recurrenceStart').value,
      end_month: $('recurrenceEnd').value || null,
      active: true,
      updated_at: Date.now()
    };
    state.recurring_expenses.push(rule);
    enqueueOutbox('recurring_expenses', rule);
    materializeRecurringTransactions();
    $('recurrenceForm').reset();
    $('recurrenceStart').value = currentMonth();
    render();
    sync.flushOutbox();
    showToast('Regra recorrente criada!', { type: 'success' });
  };

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
    switchTab('movimentos');
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

  $('budgetForm').onsubmit = e => {
    e.preventDefault();
    document.querySelectorAll('[data-cat-budget-id]').forEach(inp => {
      const cat = state.categories.find(c => c.id === inp.dataset.catBudgetId);
      if (cat) {
        cat.budget = Math.max(0, Number(inp.value) || 0);
        cat.updated_at = Date.now();
        enqueueOutbox('categories', cat);
      }
    });
    saveLocalState(state);
    render();
    sync.flushOutbox();
    showToast('Limites atualizados.', { type: 'success' });
  };

  $('newCategoryForm').onsubmit = e => {
    e.preventDefault();
    const cat = {
      id: uid('cat'),
      name: $('newCategoryName').value.trim(),
      budget: Math.max(0, Number($('newCategoryBudget').value) || 0),
      sort_order: state.categories.length + 1,
      updated_at: Date.now()
    };
    state.categories.push(cat);
    mutate('categories', cat);
    $('newCategoryForm').reset();
    showToast('Categoria criada.', { type: 'success' });
  };

  $('creditCardForm').onsubmit = e => {
    e.preventDefault();
    const card = {
      id: uid('cc'),
      name: $('ccName').value.trim(),
      card_limit: Math.max(0, Number($('ccLimit').value) || 0),
      initial_debt: Math.max(0, Number($('ccInitialDebt').value) || 0),
      owner: $('ccOwner').value || 'Conta conjunta',
      updated_at: Date.now()
    };
    state.credit_cards.push(card);
    mutate('credit_cards', card);
    $('creditCardForm').reset();
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
    if (editId) {
      const g = state.savings_goals.find(x => String(x.id) === String(editId));
      if (g) {
        g.name = $('goalName').value.trim();
        g.target = Number($('goalTarget').value);
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
      target: Number($('goalTarget').value),
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
  $('createHousehold').onclick = async () => {
    try {
      await sync.createHousehold($('householdName').value);
      showToast('Orçamento do casal criado na nuvem!', { type: 'success' });
    } catch (err) {
      alert(err.message);
    }
  };
  $('createInvite').onclick = async () => {
    try {
      const code = await sync.createInvite();
      $('inviteResult').hidden = false;
      $('inviteResult').textContent = `Código de convite (7 dias): ${code}`;
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
    await sync.flushOutbox();
    await sync.fullPull();
    showToast('Sincronização concluída.', { type: 'success' });
  };

  $('importLegacyBackup').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const json = JSON.parse(await file.text());
      const converted = convertLegacyV1Backup(json);
      converted.household.id = sync.householdId;
      state = converted;
      saveLocalState(state);
      render();
      if (sync.householdId) await sync.queueAllLocalToOutbox();
      showToast(`Histórico migrado (${state.transactions.length} movimentos)!`, { type: 'success' });
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

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

  function showImportPreview(rows) {
    parsedImportRows = rows;
    if (!parsedImportRows.length) {
      alert('Nenhum movimento reconhecido neste ficheiro. Experimenta copiar as linhas do extrato e usar "Colar texto".');
      return;
    }
    const activeCats = (state.categories || []).filter(c => !c.deleted_at);
    const catOpts = activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');

    $('csvPreviewContainer').hidden = false;
    $('csvSummaryCount').textContent = `${parsedImportRows.length} movimento(s) detetado(s)`;
    $('csvPreviewList').innerHTML = parsedImportRows
      .map((r, i) => `
        <div class="item" style="display:flex;flex-direction:column;gap:6px">
          <div class="row">
            <label class="checkbox-row" style="margin:0;flex:1;min-width:0">
              <input type="checkbox" data-imp-idx="${i}" checked>
              <span style="overflow:hidden;text-overflow:ellipsis">${fmtDate(r.date)} · <b>${esc(r.description)}</b></span>
            </label>
            <b class="${r.type === 'income' ? 'plus' : 'minus'}" style="white-space:nowrap">${r.type === 'income' ? '+' : '−'} ${eur(r.amount)}</b>
          </div>
          <div class="row" style="gap:8px;padding-left:24px">
            <select data-imp-type="${i}" style="padding:4px 8px;font-size:12px;max-width:130px">
              <option value="expense" ${r.type === 'expense' ? 'selected' : ''}>Despesa</option>
              <option value="income" ${r.type === 'income' ? 'selected' : ''}>Rendimento</option>
            </select>
            <select data-imp-cat="${i}" style="padding:4px 8px;font-size:12px;flex:1" ${r.type === 'income' ? 'disabled' : ''}>
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
          if (catSel) catSel.disabled = r.type === 'income';
          showImportPreview(parsedImportRows);
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

  window.addEventListener('online', () => sync.flushOutbox());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && sync.householdId) {
      sync.flushOutbox();
      sync.fullPull();
    }
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  materializeRecurringTransactions();
  render();
  sync.connectAndSubscribe();
});
