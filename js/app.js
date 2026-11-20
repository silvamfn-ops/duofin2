import {
  APP_VERSION, $, iso, currentMonth, eur, esc, sum, isPaid, fmtDate,
  addMonthsClamp, uid, haptic, showToast, evaluateAmountExpression
} from './config.js';
import {
  loadLocalState, saveLocalState, enqueueOutbox, createInitialState,
  convertLegacyV1Backup, getOutbox
} from './db.js';
import { DuoFinSync } from './supabase-sync.js';
import {
  buildCycles, currentCycle, cycleTransactions, computeCycleBalance,
  computeCycleProjection, computeDailyBurnRate, getAllCreditCardsStats,
  goalTotal, getPeopleList, computeCycleReferenceMonth
} from './finance-engine.js';
import { SecurityManager } from './security.js';
import { extractLinesFromPdf, parseStatementLines, guessCategory } from './importers.js';
import { drawSavingsChart, drawCategoryBarChart } from './charts.js';

let state = loadLocalState();
let selectedCycleKey = null;
let parsedImportRows = [];

const security = new SecurityManager();
security.applyPrivacy();
security.startIdleWatcher();
if (security.hasPin()) security.lock();

const sync = new DuoFinSync(
  () => state,
  () => render(),
  (status, msg) => {
    const el = $('cloudStatus');
    if (el) {
      el.textContent = msg;
      el.className = 'alert' + (status === 'synced' ? ' good' : status === 'offline' ? ' red' : '');
    }
    const badge = $('syncHeaderBadge');
    if (badge) {
      badge.textContent = status === 'synced' ? '● Em tempo real' : status === 'syncing' ? '↻ A sincronizar' : '○ Local';
    }
    updateHouseholdPanels(status);
  }
);

function mutate(table, record) {
  record.updated_at = Date.now();
  saveLocalState(state);
  enqueueOutbox(table, record);
  render();
  sync.flushOutbox();
}

function updateHouseholdPanels(status) {
  const connected = status === 'synced' || status === 'no_household' || status === 'syncing';
  if ($('cloudLogout')) $('cloudLogout').hidden = !sync.user;
  if ($('householdPanel')) $('householdPanel').hidden = !sync.user;
  if ($('householdInfo')) {
    $('householdInfo').textContent = sync.householdId
      ? `Orçamento ligado (${sync.householdId.slice(0, 8)}…) · ${getOutbox().length} pendente(s)`
      : 'Cria um orçamento do casal ou insere o código de convite recebido.';
  }
}

function switchTab(tabId) {
  document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === tabId));
  if (tabId === 'resumo') requestAnimationFrame(() => drawSavingsChart(state));
  if (tabId === 'graficos') {
    const cycles = buildCycles(state);
    const c = cycles.find(x => x.key === selectedCycleKey) || currentCycle(cycles);
    requestAnimationFrame(() => drawCategoryBarChart(state, c));
  }
}

function render() {
  const cycles = buildCycles(state);
  const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
  selectedCycleKey = cycle.key;

  const mLabel = cycle.monthLabel || computeCycleReferenceMonth(cycle);
  $('monthTitle').textContent = cycle.fallback ? `${mLabel} · provisório` : `Ciclo de ${mLabel}${cycle.open ? ' (em curso)' : ''}`;
  $('cycleRange').textContent = `${fmtDate(cycle.start)} a ${fmtDate(cycle.end)}`;

  $('cycleSelect').innerHTML = cycles
    .slice()
    .reverse()
    .map(c => `<option value="${esc(c.key)}">${esc(c.monthLabel)} (${fmtDate(c.start)} – ${fmtDate(c.end)})</option>`)
    .join('');
  $('cycleSelect').value = cycle.key;

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

  // Categorias no Resumo
  $('cats').innerHTML = (state.categories || [])
    .filter(c => !c.deleted_at)
    .map(c => {
      const v = sum(ex.filter(t => t.category === c.name));
      const pct = c.budget ? Math.min(100, (v / c.budget) * 100) : 0;
      const cls = c.budget ? (v > c.budget ? 'over' : v >= c.budget * 0.85 ? 'warn' : '') : '';
      return `<div class="barline"><span class="barline-name">${esc(c.name)}</span><div class="bar"><i class="${cls}" style="width:${pct}%"></i></div><span class="barline-val"><b>${eur(v)}</b> / ${Math.round(c.budget)}€</span></div>`;
    })
    .join('');

  // Cartões de Crédito
  const ccStats = getAllCreditCardsStats(state);
  if ($('creditCardsSummary')) {
    $('creditCardsSummary').innerHTML = ccStats.length
      ? ccStats
          .map(
            c =>
              `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${esc(c.owner)}</div></div><b class="${c.debt > 0 ? 'minus' : 'plus'}">${eur(c.debt)}</b></div>`
          )
          .join('')
      : '<div class="empty">Sem cartões de crédito configurados.</div>';
  }

  // Movimentos Recentes e Histórico
  const recent = [...tx].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  $('recent').innerHTML = recent.length
    ? recent.map(renderTxRow).join('')
    : '<div class="empty">Ainda sem movimentos neste ciclo.</div>';

  const allCycleTx = cycleTransactions(state, cycle).sort((a, b) => b.date.localeCompare(a.date));
  $('transactions').innerHTML = allCycleTx.length
    ? allCycleTx.map(renderTxRow).join('')
    : '<div class="empty">Sem movimentos neste ciclo.</div>';

  // Selects do formulário
  const people = getPeopleList(state);
  $('person').innerHTML = people.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('category').innerHTML = (state.categories || [])
    .filter(c => !c.deleted_at)
    .map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`)
    .join('');

  const cards = (state.credit_cards || []).filter(c => !c.deleted_at);
  $('paymentMethod').innerHTML =
    '<option value="bank">Conta à ordem / Débito / Dinheiro</option>' +
    cards.map(c => `<option value="cc:${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');
  $('ccPaymentCard').innerHTML =
    '<option value="">Selecionar cartão…</option>' +
    cards.map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');

  const goals = (state.savings_goals || []).filter(g => !g.deleted_at && g.status === 'active');
  $('savingGoal').innerHTML =
    '<option value="">Sem objetivo</option>' + goals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

  // Objetivos
  $('goalList').innerHTML = (state.savings_goals || [])
    .filter(g => !g.deleted_at)
    .map(g => {
      const saved = goalTotal(state, g.id);
      const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
      return `<div class="card"><div class="row"><b>${esc(g.name)}</b><span class="pill">${Math.round(pct)}%</span></div><div class="small">${eur(saved)} / ${eur(g.target)}</div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
    })
    .join('') || '<div class="card empty">Ainda não existem objetivos de poupança.</div>';

  // Orçamento & Cartões
  $('budgetFields').innerHTML = (state.categories || [])
    .filter(c => !c.deleted_at)
    .map(
      c =>
        `<div class="item row"><span>${esc(c.name)}</span><input data-cat-budget-id="${esc(c.id)}" type="number" step="0.01" value="${Number(c.budget) || 0}" style="width:120px;text-align:right"></div>`
    )
    .join('');

  $('adult1').value = state.household.adult1_name || 'Adulto 1';
  $('adult2').value = state.household.adult2_name || 'Adulto 2';
  $('cycleGroupingDays').value = state.household.cycle_grouping_days ?? 14;

  drawSavingsChart(state);
}

function renderTxRow(t) {
  const cls = t.type === 'income' ? 'plus' : t.type === 'saving_withdraw' || t.type === 'cc_payment' ? 'neutral' : 'minus';
  const sign = t.type === 'income' ? '+' : t.type === 'saving' ? '↗' : t.type === 'saving_withdraw' ? '↙' : t.type === 'cc_payment' ? '⇄' : '−';
  const ccTag = t.credit_card_id ? ' · 💳 Cartão' : '';
  return `<div class="item row">
    <div>
      <b>${esc(t.description)}</b>
      <div class="small">${fmtDate(t.date)} · ${esc(t.category)} · ${esc(t.person)}${ccTag}</div>
    </div>
    <div class="row" style="gap:8px">
      <b class="amount ${cls}">${sign} ${eur(t.amount)}</b>
      <button type="button" class="danger" data-del-tx="${esc(t.id)}" title="Apagar">×</button>
    </div>
  </div>`;
}

// Inicialização de Eventos
document.addEventListener('DOMContentLoaded', () => {
  $('date').value = iso();
  const cfg = sync.getConfig();
  $('sbUrl').value = cfg.url || '';
  $('sbKey').value = cfg.anonKey || '';

  document.querySelectorAll('nav button[data-tab]').forEach(btn => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  $('cycleSelect').onchange = e => {
    selectedCycleKey = e.target.value;
    render();
  };

  $('type').onchange = () => {
    const tp = $('type').value;
    $('categoryField').hidden = tp !== 'expense';
    $('expensePaymentMethodField').hidden = tp !== 'expense';
    $('ccPaymentField').hidden = tp !== 'cc_payment';
    $('savingGoalField').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
    $('incomeCycleField').hidden = tp !== 'income';
  };

  $('txForm').onsubmit = e => {
    e.preventDefault();
    const amount = evaluateAmountExpression($('amount').value);
    if (!Number.isFinite(amount) || amount <= 0) {
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

    const tx = {
      id: uid('tx'),
      date: $('date').value,
      type: tp,
      description: $('desc').value.trim(),
      amount: Number(amount.toFixed(2)),
      category: tp === 'expense' ? $('category').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : 'Poupança',
      person: $('person').value,
      status: 'confirmed',
      credit_card_id: ccId,
      goal_id: tp === 'saving' || tp === 'saving_withdraw' ? $('savingGoal').value || null : null,
      counts_for_cycle: tp === 'income' ? $('incomeCountsForCycle').checked : true,
      updated_at: Date.now()
    };

    state.transactions.push(tx);
    mutate('transactions', tx);
    $('txForm').reset();
    $('date').value = iso();
    $('type').dispatchEvent(new Event('change'));
    haptic([14, 25, 14]);
    showToast('Movimento guardado e sincronizado.', { type: 'success' });
  };

  document.addEventListener('click', e => {
    const delBtn = e.target.closest('[data-del-tx]');
    if (delBtn) {
      const id = delBtn.dataset.delTx;
      const tx = state.transactions.find(t => String(t.id) === String(id));
      if (tx && confirm(`Apagar "${tx.description}"?`)) {
        tx.deleted_at = Date.now();
        mutate('transactions', tx);
        showToast('Movimento eliminado.');
      }
    }
  });

  // Orçamento
  $('saveBudgetsBtn').onclick = () => {
    document.querySelectorAll('[data-cat-budget-id]').forEach(inp => {
      const cat = state.categories.find(c => c.id === inp.dataset.catBudgetId);
      if (cat) {
        cat.budget = Math.max(0, Number(inp.value) || 0);
        mutate('categories', cat);
      }
    });
    showToast('Limites atualizados.', { type: 'success' });
  };

  // Cartões de Crédito
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

  // Objetivos
  $('goalForm').onsubmit = e => {
    e.preventDefault();
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

  // Nomes & Ciclos
  $('saveHouseholdBtn').onclick = () => {
    state.household.adult1_name = $('adult1').value.trim() || 'Adulto 1';
    state.household.adult2_name = $('adult2').value.trim() || 'Adulto 2';
    state.household.cycle_grouping_days = Math.max(0, Math.min(20, Number($('cycleGroupingDays').value) || 14));
    mutate('households', state.household);
    showToast('Definições do casal guardadas.', { type: 'success' });
  };

  // Supabase Auth & Sync
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

  // Migração do Backup v6.9.0 -> DuoFin 2.0
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
      showToast(`Histórico migrado com sucesso (${state.transactions.length} movimentos)!`, { type: 'success' });
    } catch (err) {
      alert('Erro ao migrar backup: ' + err.message);
    }
    e.target.value = '';
  };

  // Importação PDF/CSV
  $('csvFileInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      let lines = [];
      if (file.name.toLowerCase().endsWith('.pdf')) {
        lines = await extractLinesFromPdf(file);
      } else {
        lines = (await file.text()).split(/?
/);
      }
      parsedImportRows = parseStatementLines(state, lines);
      if (!parsedImportRows.length) throw new Error('Nenhum movimento reconhecido no ficheiro.');
      $('csvPreviewContainer').hidden = false;
      $('csvPreviewList').innerHTML = parsedImportRows
        .map(
          (r, i) =>
            `<div class="item row"><label class="checkbox-row"><input type="checkbox" data-imp-idx="${i}" checked><span>${fmtDate(r.date)} · <b>${esc(r.description)}</b> (${esc(r.category)})</span></label><b>${eur(r.amount)}</b></div>`
        )
        .join('');
    } catch (err) {
      alert(err.message);
    }
    e.target.value = '';
  };

  $('csvConfirmImportBtn').onclick = () => {
    const checks = [...document.querySelectorAll('[data-imp-idx]')];
    let count = 0;
    checks.forEach(cb => {
      if (!cb.checked) return;
      const r = parsedImportRows[Number(cb.dataset.impIdx)];
      if (!r) return;
      const tx = {
        id: uid('imp'),
        date: r.date,
        type: r.type,
        description: r.description,
        amount: r.amount,
        category: r.category,
        person: 'Conta conjunta',
        status: 'confirmed',
        counts_for_cycle: true,
        updated_at: Date.now()
      };
      state.transactions.push(tx);
      enqueueOutbox('transactions', tx);
      count++;
    });
    saveLocalState(state);
    $('csvPreviewContainer').hidden = true;
    render();
    sync.flushOutbox();
    showToast(`${count} movimento(s) importado(s)!`, { type: 'success' });
  };

  // Segurança & Privacidade
  $('privacyToggleBtn').onclick = () => security.togglePrivacy();
  $('savePinBtn').onclick = async () => {
    const pin = $('newPinInput').value.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      alert('O PIN deve ter entre 4 e 6 dígitos.');
      return;
    }
    await security.setPin(pin, $('autoLockMinutes').value);
    $('newPinInput').value = '';
    showToast('PIN local guardado.', { type: 'success' });
  };
  $('appLockUnlockBtn').onclick = async () => {
    const ok = await security.verifyPin($('appLockPinInput').value.trim());
    if (!ok) $('appLockError').textContent = 'PIN incorreto.';
  };
  $('appLockBioBtn').onclick = () => security.unlockWithBiometrics();

  window.addEventListener('online', () => sync.flushOutbox());
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  render();
  sync.connectAndSubscribe();
});
