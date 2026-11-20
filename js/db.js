const DB_STORAGE_KEY = 'duofin2-state-v1';
const OUTBOX_KEY = 'duofin2-outbox-v1';

export function createInitialState() {
  const nowTs = Date.now();
  return {
    household: {
      id: null,
      name: 'Orçamento do Casal',
      income_ref: 3200,
      cycle_grouping_days: 14,
      adult1_name: 'Adulto 1',
      adult2_name: 'Adulto 2',
      auto_adjust_budgets: false,
      updated_at: nowTs
    },
    categories: [
      { id: 'cat-1', name: 'Habitação', budget: 850, locked: false, sort_order: 1, updated_at: nowTs },
      { id: 'cat-2', name: 'Supermercado', budget: 450, locked: false, sort_order: 2, updated_at: nowTs },
      { id: 'cat-3', name: 'Água, luz e gás', budget: 180, locked: false, sort_order: 3, updated_at: nowTs },
      { id: 'cat-4', name: 'Transportes', budget: 250, locked: false, sort_order: 4, updated_at: nowTs },
      { id: 'cat-5', name: 'Telecomunicações', budget: 70, locked: false, sort_order: 5, updated_at: nowTs },
      { id: 'cat-6', name: 'Saúde e farmácia', budget: 80, locked: false, sort_order: 6, updated_at: nowTs },
      { id: 'cat-7', name: 'Crianças e família', budget: 150, locked: false, sort_order: 7, updated_at: nowTs },
      { id: 'cat-8', name: 'Restaurantes e lazer', budget: 150, locked: false, sort_order: 8, updated_at: nowTs },
      { id: 'cat-9', name: 'Vestuário e pessoal', budget: 120, locked: false, sort_order: 9, updated_at: nowTs },
      { id: 'cat-10', name: 'Outros / imprevistos', budget: 300, locked: false, sort_order: 10, updated_at: nowTs }
    ],
    credit_cards: [],
    savings_goals: [],
    recurring_expenses: [],
    transactions: [],
    meta: {
      category_rules: [],
      handled_rollovers: [],
      updated_at: nowTs
    }
  };
}

export function loadLocalState() {
  try {
    const raw = JSON.parse(localStorage.getItem(DB_STORAGE_KEY));
    if (raw && raw.household && Array.isArray(raw.transactions)) {
      raw.categories = Array.isArray(raw.categories) ? raw.categories : [];
      raw.credit_cards = Array.isArray(raw.credit_cards) ? raw.credit_cards : [];
      raw.savings_goals = Array.isArray(raw.savings_goals) ? raw.savings_goals : [];
      raw.recurring_expenses = Array.isArray(raw.recurring_expenses) ? raw.recurring_expenses : [];
      raw.meta = raw.meta || { category_rules: [], handled_rollovers: [] };
      return raw;
    }
  } catch (e) {
    console.warn('Erro ao ler estado local:', e);
  }
  return createInitialState();
}

export function saveLocalState(state) {
  localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(state));
}

export function getOutbox() {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
  } catch {
    return [];
  }
}

export function enqueueOutbox(table, record) {
  const queue = getOutbox();
  const keyId = record.id || record.household_id || 'singleton';
  const filtered = queue.filter(item => !(item.table === table && (item.record?.id || item.record?.household_id || 'singleton') === keyId));
  filtered.push({
    table,
    record: { ...record },
    queuedAt: Date.now()
  });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(filtered));
}

export function clearOutboxItems(processedKeys) {
  const set = new Set(processedKeys);
  const remaining = getOutbox().filter(item => {
    const k = `${item.table}:${item.record?.id || item.record?.household_id || 'singleton'}:${item.queuedAt}`;
    return !set.has(k);
  });
  localStorage.setItem(OUTBOX_KEY, JSON.stringify(remaining));
}

export function clearAllOutbox() {
  localStorage.removeItem(OUTBOX_KEY);
}

// Conversor automático do formato antigo DuoFin v6.x (backup JSON) para DuoFin 2.0
export function convertLegacyV1Backup(legacyJson) {
  if (!legacyJson || !legacyJson.settings || !Array.isArray(legacyJson.transactions)) {
    throw new Error('O ficheiro não corresponde a um backup válido do DuoFin.');
  }
  const nowTs = Date.now();
  const s = legacyJson.settings;
  const people = Array.isArray(s.people) ? s.people : ['Adulto 1', 'Adulto 2'];

  const state = createInitialState();
  state.household = {
    id: null,
    name: 'Orçamento do Casal',
    income_ref: Number(s.income) || 3200,
    cycle_grouping_days: Number(s.cycleGroupingDays ?? 14),
    adult1_name: people[0] || 'Adulto 1',
    adult2_name: people[1] || 'Adulto 2',
    auto_adjust_budgets: !!s.autoAdjustBudgets,
    updated_at: nowTs
  };

  state.categories = (s.categories || []).map((c, idx) => ({
    id: `cat-v1-${idx}-${nowTs.toString(36)}`,
    name: c.name,
    budget: Number(c.budget) || 0,
    locked: !!c.locked,
    sort_order: idx + 1,
    updated_at: Number(c.updatedAt) || nowTs
  }));

  state.credit_cards = (legacyJson.creditCards || []).map(c => ({
    id: String(c.id),
    name: c.name,
    card_limit: Number(c.limit) || 0,
    initial_debt: Number(c.initialDebt) || 0,
    owner: c.owner || 'Conta conjunta',
    updated_at: Number(c.updatedAt) || nowTs
  }));

  state.savings_goals = (legacyJson.savingsGoals || []).map(g => ({
    id: String(g.id),
    name: g.name,
    target: Number(g.target) || 0,
    deadline: g.deadline || null,
    status: g.status || 'active',
    updated_at: Number(g.updatedAt) || nowTs
  }));

  state.recurring_expenses = (legacyJson.recurringExpenses || []).map(r => ({
    id: String(r.id),
    description: r.description,
    amount: Number(r.amount) || 0,
    category: r.category,
    person: r.person || 'Conta conjunta',
    day_of_month: Number(r.day) || 1,
    start_month: r.startMonth,
    end_month: r.endMonth || null,
    active: r.active !== false,
    updated_at: Number(r.updatedAt) || nowTs
  }));

  state.transactions = (legacyJson.transactions || []).map(t => ({
    id: String(t.id),
    date: t.date,
    type: t.type,
    description: t.description,
    amount: Number(t.amount) || 0,
    category: t.category || 'Outros / imprevistos',
    person: t.person || 'Conta conjunta',
    status: t.status || 'confirmed',
    credit_card_id: t.creditCardId ? String(t.creditCardId) : null,
    goal_id: t.goalId ? String(t.goalId) : null,
    recurrence_id: t.recurrenceId ? String(t.recurrenceId) : null,
    occurrence_key: t.occurrenceKey || null,
    installment_group_id: t.installmentGroupId || null,
    counts_for_cycle: t.countsForCycle !== false,
    updated_at: Number(t.updatedAt) || nowTs
  }));

  state.meta = {
    category_rules: Array.isArray(s.categoryRules) ? s.categoryRules : [],
    handled_rollovers: Array.isArray(legacyJson.handledCycleRollovers) ? legacyJson.handledCycleRollovers : [],
    updated_at: nowTs
  };

  return state;
}
