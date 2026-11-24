import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getOutbox, clearOutboxItems, saveLocalState, enqueueOutbox } from './db.js';

const CFG_KEY = 'duofin2-sb-config-v1';

const TABLE_COLUMNS = {
  households: ['id', 'name', 'income_ref', 'cycle_grouping_days', 'adult1_name', 'adult2_name', 'auto_adjust_budgets', 'updated_at'],
  household_meta: ['household_id', 'category_rules', 'handled_rollovers', 'updated_at'],
  categories: ['id', 'household_id', 'name', 'budget', 'locked', 'sort_order', 'updated_at', 'deleted_at'],
  credit_cards: ['id', 'household_id', 'name', 'card_limit', 'initial_debt', 'owner', 'updated_at', 'deleted_at'],
  savings_goals: ['id', 'household_id', 'name', 'target', 'deadline', 'status', 'updated_at', 'deleted_at'],
  recurring_expenses: ['id', 'household_id', 'description', 'amount', 'category', 'person', 'day_of_month', 'start_month', 'end_month', 'active', 'entity', 'payment_ref', 'cycle_payments', 'updated_at', 'deleted_at'],
  transactions: ['id', 'household_id', 'date', 'type', 'description', 'amount', 'category', 'person', 'status', 'credit_card_id', 'goal_id', 'recurrence_id', 'occurrence_key', 'installment_group_id', 'counts_for_cycle', 'updated_at', 'deleted_at']
};

const NULLABLE_FIELDS = new Set([
  'credit_card_id', 'goal_id', 'recurrence_id', 'occurrence_key',
  'installment_group_id', 'deadline', 'end_month', 'deleted_at'
]);

function sanitizeRecord(table, raw) {
  const cols = TABLE_COLUMNS[table];
  if (!cols) return { ...raw };
  const clean = {};
  for (const col of cols) {
    if (col === 'deleted_at' && raw[col] === undefined) {
      clean.deleted_at = null;
      continue;
    }
    if (raw[col] !== undefined) {
      let val = raw[col];
      if (NULLABLE_FIELDS.has(col) && (val === '' || val === undefined)) {
        val = null;
      }
      if (col === 'updated_at') {
        val = Math.floor(Number(val) || Date.now());
      } else if (col === 'deleted_at') {
        val = val ? Math.floor(Number(val)) : null;
      } else if (col === 'day_of_month') {
        val = Math.max(1, Math.min(31, parseInt(val, 10) || 1));
      } else if (col === 'sort_order') {
        val = parseInt(val, 10) || 999;
      } else if (col === 'cycle_grouping_days') {
        val = parseInt(val, 10) || 14;
      }
      clean[col] = val;
    }
  }
  return clean;
}

export class DuoFinSync {
  constructor(getState, onRemoteUpdate, onStatusChange) {
    this.getState = getState;
    this.onRemoteUpdate = onRemoteUpdate;
    this.onStatusChange = onStatusChange;
    this.supabase = null;
    this.householdId = null;
    this.user = null;
    this.channel = null;
    this.channelHealthy = false;
    this.isFlushing = false;
    this.flushPendingAgain = false;
    this.isPulling = false;
    this.pullPendingAgain = false;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.resumeDebounceTimer = null;
    this.lastSyncAt = null;
    this.lastFullPullAt = 0;
    this.maxKnownUpdatedAt = Date.now();
    this.lastOutboxErrors = [];
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('duofin2-sync-bus') : null;
    if (this.bc) {
      this.bc.onmessage = ev => {
        const msg = ev?.data;
        if (!msg || !this.householdId || msg.householdId !== this.householdId) return;
        if (msg.type === 'local_mutation' || msg.type === 'remote_pulled') {
          this.fullPull({ silent: true, force: true });
        }
      };
    }
  }

  observeTimestamp(ts) {
    const num = Number(ts) || 0;
    if (num > this.maxKnownUpdatedAt) {
      this.maxKnownUpdatedAt = num;
    }
  }

  nextMonotonicTimestamp() {
    const now = Date.now();
    const next = now > this.maxKnownUpdatedAt ? now : this.maxKnownUpdatedAt + 1;
    this.maxKnownUpdatedAt = next;
    return next;
  }

  notifyLocalMutation(table, record) {
    if (record && record.updated_at) this.observeTimestamp(record.updated_at);
    if (this.bc && this.householdId) {
      try {
        this.bc.postMessage({ type: 'local_mutation', householdId: this.householdId, table, at: Date.now() });
      } catch {}
    }
  }

  clearAllOutbox() {
    const queue = getOutbox();
    if (queue.length) {
      const keys = queue.map(item => {
        const pk = item.table === 'household_meta' || item.table === 'households'
          ? (this.householdId || item.record?.household_id || item.record?.id || '')
          : (item.record?.id ?? '');
        return `${item.table}:${pk}:${item.queuedAt}`;
      });
      clearOutboxItems(keys);
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && /outbox/i.test(k)) {
          localStorage.setItem(k, '[]');
        }
      }
    } catch (_) {}
    this.flushPendingAgain = false;
    this.lastOutboxErrors = [];
    this.onStatusChange('synced', `Fila limpa (${this.user?.email || 'ligado'})`);
  }

  getConfig() {
    try {
      return JSON.parse(localStorage.getItem(CFG_KEY)) || { url: '', anonKey: '', householdId: null };
    } catch {
      return { url: '', anonKey: '', householdId: null };
    }
  }

  saveConfig(url, anonKey, householdId = this.householdId) {
    this.householdId = householdId;
    const cleanUrl = String(url || '').trim().replace(/\/+$/, '');
    const cleanKey = String(anonKey || '').trim();
    localStorage.setItem(CFG_KEY, JSON.stringify({ url: cleanUrl, anonKey: cleanKey, householdId }));
  }

  isConfigured() {
    const cfg = this.getConfig();
    const cleanUrl = String(cfg.url || '').trim().replace(/\/+$/, '');
    const cleanKey = String(cfg.anonKey || '').trim();
    return /^https:\/\/.+\.supabase\.co$/i.test(cleanUrl) && cleanKey.length > 20;
  }

  init() {
    const cfg = this.getConfig();
    if (!this.isConfigured()) {
      this.onStatusChange('unconfigured', 'Configura o URL e a Chave Pública do projeto Supabase.');
      return false;
    }
    this.householdId = cfg.householdId;
    this.supabase = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 15 } }
    });
    return true;
  }

  formatLastSyncTime() {
    if (!this.lastSyncAt) return '';
    const d = new Date(this.lastSyncAt);
    return ` · ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
  }

  async ensureValidSession() {
    if (!this.supabase && !this.init()) return null;
    const { data: { session }, error } = await this.supabase.auth.getSession();
    if (error || !session) return null;
    const expiresAtMs = (session.expires_at || 0) * 1000;
    if (expiresAtMs && expiresAtMs - Date.now() < 120_000) {
      const { data: refreshed } = await this.supabase.auth.refreshSession();
      if (refreshed?.session) {
        this.user = refreshed.session.user;
        return refreshed.session;
      }
    }
    this.user = session.user;
    return session;
  }

  startHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || !this.householdId) return;
      if (getOutbox().length > 0) {
        await this.flushOutbox();
      }
      await this.fullPull({ silent: true });
      if (!this.channelHealthy) {
        this.subscribeRealtime();
      }
    }, 15_000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async connectAndSubscribe() {
    const session = await this.ensureValidSession();
    if (!session) {
      this.user = null;
      this.stopHeartbeat();
      this.onStatusChange('logged_out', 'Configurado. Inicia sessão ou cria conta para sincronizar.');
      return;
    }

    if (!this.householdId) {
      const { data: members, error } = await this.supabase
        .from('household_members')
        .select('household_id')
        .limit(1);
      if (!error && members && members.length) {
        this.householdId = members[0].household_id;
        const cfg = this.getConfig();
        this.saveConfig(cfg.url, cfg.anonKey, this.householdId);
      } else {
        this.onStatusChange('no_household', `Sessão ativa (${this.user.email}). Cria ou associa o orçamento do casal.`);
        return;
      }
    }

    await this.flushOutbox();
    await this.fullPull({ force: true });
    this.subscribeRealtime();
    this.startHeartbeat();
  }

  resumeFromBackground() {
    if (!this.isConfigured()) return;
    if (this.resumeDebounceTimer) clearTimeout(this.resumeDebounceTimer);
    this.resumeDebounceTimer = setTimeout(async () => {
      this.resumeDebounceTimer = null;
      const session = await this.ensureValidSession();
      if (!session || !this.householdId) return;
      await this.flushOutbox();
      await this.fullPull({ silent: true, force: true });
      if (!this.channelHealthy) {
        this.subscribeRealtime();
      }
    }, 180);
  }

  async signIn(email, password) {
    if (!this.supabase && !this.init()) throw new Error('Configura primeiro o Supabase.');
    const { data, error } = await this.supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
    await this.connectAndSubscribe();
  }

  async signUp(email, password) {
    if (!this.supabase && !this.init()) throw new Error('Configura primeiro o Supabase.');
    const { data, error } = await this.supabase.auth.signUp({ email, password });
    if (error) throw error;
    if (data.session) {
      this.user = data.user;
      await this.connectAndSubscribe();
      return true;
    }
    return false;
  }

  async signOut() {
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.resumeDebounceTimer) clearTimeout(this.resumeDebounceTimer);
    if (this.channel && this.supabase) this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.channelHealthy = false;
    if (this.supabase) await this.supabase.auth.signOut();
    this.user = null;
    this.householdId = null;
    const cfg = this.getConfig();
    this.saveConfig(cfg.url, cfg.anonKey, null);
    this.onStatusChange('logged_out', 'Sessão terminada.');
  }

  async createHousehold(name) {
    if (!this.supabase) throw new Error('Sem ligação ao Supabase.');
    const { data: hid, error } = await this.supabase.rpc('create_household_v2', { p_name: name });
    if (error) throw error;
    const cfg = this.getConfig();
    this.saveConfig(cfg.url, cfg.anonKey, hid);
    const st = this.getState();
    const hasLocalData = (st.transactions?.length || 0) > 0 || (st.credit_cards?.length || 0) > 0 || (st.savings_goals?.length || 0) > 0 || (st.recurring_expenses?.length || 0) > 0;
    if (hasLocalData) {
      await this.queueAllLocalToOutbox();
    }
    await this.fullPull({ force: true });
    this.subscribeRealtime();
    this.startHeartbeat();
    return hid;
  }

  async createInvite() {
    if (!this.supabase || !this.householdId) throw new Error('Associa primeiro um orçamento.');
    const { data: code, error } = await this.supabase.rpc('create_invite_v2', { p_household: this.householdId });
    if (error) throw error;
    return code;
  }

  async acceptInvite(code) {
    if (!this.supabase) throw new Error('Sem ligação ao Supabase.');
    const { data: hid, error } = await this.supabase.rpc('accept_invite_v2', { p_code: code });
    if (error) throw error;
    const cfg = this.getConfig();
    this.saveConfig(cfg.url, cfg.anonKey, hid);
    await this.fullPull({ force: true });
    this.subscribeRealtime();
    this.startHeartbeat();
    return hid;
  }

  async queueAllLocalToOutbox() {
    const st = this.getState();
    const ts = this.nextMonotonicTimestamp();
    enqueueOutbox('households', { ...st.household, id: this.householdId, updated_at: ts });
    st.categories.forEach(c => enqueueOutbox('categories', { ...c, updated_at: c.updated_at || ts }));
    st.credit_cards.forEach(c => enqueueOutbox('credit_cards', { ...c, updated_at: c.updated_at || ts }));
    st.savings_goals.forEach(g => enqueueOutbox('savings_goals', { ...g, updated_at: g.updated_at || ts }));
    st.recurring_expenses.forEach(r => enqueueOutbox('recurring_expenses', { ...r, updated_at: r.updated_at || ts }));
    st.transactions.forEach(t => enqueueOutbox('transactions', { ...t, updated_at: t.updated_at || ts }));
    enqueueOutbox('household_meta', { ...st.meta, household_id: this.householdId, updated_at: st.meta?.updated_at || ts });
    await this.flushOutbox();
  }

  scheduleOutboxRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delays = [2500, 6000, 12000, 25000];
    const waitMs = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      if (navigator.onLine) this.flushOutbox();
    }, waitMs);
  }

  async flushOutbox() {
    if (!this.supabase || !this.householdId) return;
    if (this.isFlushing) {
      this.flushPendingAgain = true;
      return;
    }
    if (!navigator.onLine) {
      this.onStatusChange('offline', 'Sem internet — alterações guardadas localmente.');
      return;
    }
    const queue = getOutbox();
    if (!queue.length) return;

    this.isFlushing = true;
    this.flushPendingAgain = false;
    this.onStatusChange('syncing', `A sincronizar ${queue.length} alteração(ões)...`);
    const processed = [];
    const failedDetails = [];
    let failedCount = 0;
    let lastErrorMsg = '';

    try {
      const session = await this.ensureValidSession();
      if (!session) {
        this.onStatusChange('logged_out', 'Sessão expirada. Inicia sessão novamente para sincronizar.');
        return;
      }

      const grouped = new Map();
      for (const item of queue) {
        if (!grouped.has(item.table)) grouped.set(item.table, []);
        grouped.get(item.table).push(item);
      }

      for (const [table, items] of grouped.entries()) {
        const conflictCol = table === 'household_meta' ? 'household_id' : 'id';
        const dedupMap = new Map();
        for (const item of items) {
          const rec = { ...item.record };
          if (table === 'households') rec.id = this.householdId;
          else if (table === 'household_meta') rec.household_id = this.householdId;
          else rec.household_id = this.householdId;

          const clean = sanitizeRecord(table, rec);
          this.observeTimestamp(clean.updated_at);
          const pk = String(clean[conflictCol]);
          const prev = dedupMap.get(pk);
          if (!prev || (Number(clean.updated_at) || 0) >= (Number(prev.updated_at) || 0)) {
            dedupMap.set(pk, clean);
          }
        }

        const batchRecords = Array.from(dedupMap.values());
        const { error } = await this.supabase.from(table).upsert(batchRecords, { onConflict: conflictCol });
        if (!error) {
          for (const item of items) {
            const pk = table === 'household_meta' ? this.householdId : (table === 'households' ? this.householdId : item.record.id);
            processed.push(`${item.table}:${pk}:${item.queuedAt}`);
          }
        } else {
          console.warn(`Erro lote ${table}:`, error.message);
          for (const item of items) {
            const rec = { ...item.record };
            if (table === 'households') rec.id = this.householdId;
            else rec.household_id = this.householdId;
            const clean = sanitizeRecord(table, rec);
            const { error: itemErr } = await this.supabase.from(table).upsert(clean, { onConflict: conflictCol });
            if (!itemErr) {
              const pk = table === 'household_meta' || table === 'households' ? this.householdId : item.record.id;
              processed.push(`${item.table}:${pk}:${item.queuedAt}`);
            } else {
              failedCount++;
              lastErrorMsg = `${table}: ${itemErr.message}`;
              failedDetails.push({ table, id: item.record?.id || item.record?.description || '?', message: itemErr.message });
              console.warn(`Erro sync ${table}:`, itemErr.message, clean);
            }
          }
        }
      }

      if (processed.length) clearOutboxItems(processed);

      this.lastOutboxErrors = failedDetails;
      if (failedCount > 0) {
        this.onStatusChange('offline', `${failedCount} pendente(s): ${lastErrorMsg || 'a repetir sincronização...'}`);
        this.scheduleOutboxRetry();
      } else {
        this.retryAttempt = 0;
        this.lastSyncAt = Date.now();
        this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
        if (this.bc && this.householdId) {
          try {
            this.bc.postMessage({ type: 'remote_pulled', householdId: this.householdId, at: Date.now() });
          } catch {}
        }
      }
    } catch (err) {
      this.onStatusChange('offline', 'Falha temporária de rede — nova tentativa automática em breve.');
      this.scheduleOutboxRetry();
    } finally {
      this.isFlushing = false;
      if (this.flushPendingAgain || (failedCount === 0 && getOutbox().length > 0)) {
        this.flushPendingAgain = false;
        setTimeout(() => this.flushOutbox(), 80);
      }
    }
  }

  async fullPull({ silent = false, force = false } = {}) {
    if (!this.supabase || !this.householdId || !navigator.onLine) return;
    if (this.isPulling) {
      this.pullPendingAgain = true;
      return;
    }
    if (!force && Date.now() - this.lastFullPullAt < 1800) return;
    this.isPulling = true;
    this.pullPendingAgain = false;
    this.lastFullPullAt = Date.now();
    try {
      const session = await this.ensureValidSession();
      if (!session) return;
      const hid = this.householdId;

      const [hhRes, catRes, ccRes, goalRes, recRes, txRes, metaRes] = await Promise.all([
        this.supabase.from('households').select('*').eq('id', hid).single(),
        this.supabase.from('categories').select('*').eq('household_id', hid),
        this.supabase.from('credit_cards').select('*').eq('household_id', hid),
        this.supabase.from('savings_goals').select('*').eq('household_id', hid),
        this.supabase.from('recurring_expenses').select('*').eq('household_id', hid),
        this.supabase.from('transactions').select('*').eq('household_id', hid),
        this.supabase.from('household_meta').select('*').eq('household_id', hid).maybeSingle()
      ]);

      const firstError = [hhRes.error, catRes.error, ccRes.error, goalRes.error, recRes.error, txRes.error, metaRes.error].find(Boolean);
      if (firstError) {
        if (!silent) {
          this.onStatusChange('offline', `Erro ao ler nuvem: ${firstError.message}`);
        }
        return;
      }

      const state = this.getState();
      const outbox = getOutbox();

      if (hhRes.data) {
        this.observeTimestamp(hhRes.data.updated_at);
        if ((Number(hhRes.data.updated_at) || 0) >= (Number(state.household.updated_at) || 0)) {
          state.household = hhRes.data;
        }
      }
      if (catRes.data) {
        catRes.data.forEach(r => this.observeTimestamp(r.updated_at));
        const remoteActiveCats = catRes.data.filter(c => !c.deleted_at);
        const hasPendingCatChanges = outbox.some(item => item.table === 'categories');
        if (remoteActiveCats.length > 0 && !hasPendingCatChanges && this.isUntouchedStarterState(state)) {
          state.categories = remoteActiveCats;
        } else {
          state.categories = this.mergeCategoriesSmart(state.categories, catRes.data, outbox);
        }
      }
      if (ccRes.data) {
        ccRes.data.forEach(r => this.observeTimestamp(r.updated_at));
        state.credit_cards = this.mergeTable('credit_cards', state.credit_cards, ccRes.data, outbox);
      }
      if (goalRes.data) {
        goalRes.data.forEach(r => this.observeTimestamp(r.updated_at));
        state.savings_goals = this.mergeTable('savings_goals', state.savings_goals, goalRes.data, outbox);
      }
      if (recRes.data) {
        recRes.data.forEach(r => this.observeTimestamp(r.updated_at));
        state.recurring_expenses = this.mergeTable('recurring_expenses', state.recurring_expenses, recRes.data, outbox);
      }
      if (txRes.data) {
        txRes.data.forEach(r => this.observeTimestamp(r.updated_at));
        state.transactions = this.mergeTable('transactions', state.transactions, txRes.data, outbox);
      }
      if (metaRes.data) {
        this.observeTimestamp(metaRes.data.updated_at);
        if ((Number(metaRes.data.updated_at) || 0) >= (Number(state.meta.updated_at) || 0)) {
          state.meta = metaRes.data;
        }
      }

      saveLocalState(state);
      this.lastSyncAt = Date.now();
      this.onRemoteUpdate();
      if (getOutbox().length === 0) {
        this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
      }
    } finally {
      this.isPulling = false;
      if (this.pullPendingAgain) {
        this.pullPendingAgain = false;
        setTimeout(() => this.fullPull({ silent: true, force: true }), 120);
      }
    }
  }

  isUntouchedStarterState(state) {
    if (!state) return true;
    const hasTx = (state.transactions || []).some(t => !t.deleted_at);
    const hasCc = (state.credit_cards || []).some(c => !c.deleted_at);
    const hasGoals = (state.savings_goals || []).some(g => !g.deleted_at);
    const hasRec = (state.recurring_expenses || []).some(r => !r.deleted_at);
    if (hasTx || hasCc || hasGoals || hasRec) return false;
    const localCats = (state.categories || []).filter(c => !c.deleted_at);
    if (!localCats.length) return true;
    return localCats.every(c => (Number(c.budget) || 0) === 0 && !c.household_id);
  }

  mergeCategoriesSmart(localList, remoteList, outbox = getOutbox()) {
    const merged = this.mergeTable('categories', localList, remoteList, outbox);
    const remoteIds = new Set(remoteList.filter(r => !r.deleted_at).map(r => String(r.id)));
    const remoteNames = new Set(
      remoteList
        .filter(r => !r.deleted_at && r.name)
        .map(r => String(r.name).trim().toLowerCase())
    );
    const pendingIds = new Set(
      outbox
        .filter(item => item.table === 'categories' && item.record?.id)
        .map(item => String(item.record.id))
    );
    if (remoteIds.size > 0) {
      return merged.filter(cat => {
        const id = String(cat.id);
        if (remoteIds.has(id) || pendingIds.has(id)) return true;
        if (!cat.household_id && (Number(cat.budget) || 0) === 0) return false;
        const norm = String(cat.name || '').trim().toLowerCase();
        if (remoteNames.has(norm) && !cat.household_id) return false;
        return true;
      });
    }
    return merged;
  }

  mergeTable(tableName, localList, remoteList, outbox = getOutbox()) {
    const pendingMap = new Map();
    outbox
      .filter(item => item.table === tableName && item.record?.id)
      .forEach(item => pendingMap.set(String(item.record.id), item.record));

    const map = new Map();
    localList.forEach(item => map.set(String(item.id), item));

    remoteList.forEach(rem => {
      const id = String(rem.id);
      if (rem.updated_at) this.observeTimestamp(rem.updated_at);
      const pending = pendingMap.get(id);
      if (pending && (Number(pending.updated_at) || 0) >= (Number(rem.updated_at) || 0)) {
        map.set(id, pending);
        return;
      }
      const loc = map.get(id);
      if (!loc || (Number(rem.updated_at) || 0) >= (Number(loc.updated_at) || 0)) {
        map.set(id, rem);
      }
    });

    pendingMap.forEach((pending, id) => {
      const cur = map.get(id);
      if (!cur || (Number(pending.updated_at) || 0) >= (Number(cur.updated_at) || 0)) {
        map.set(id, pending);
      }
    });

    return Array.from(map.values()).filter(item => !item.deleted_at);
  }

  subscribeRealtime() {
    if (!this.supabase || !this.householdId) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.channel) {
      try {
        this.supabase.removeChannel(this.channel);
      } catch {}
      this.channel = null;
    }
    this.channelHealthy = false;
    const tables = ['transactions', 'categories', 'credit_cards', 'savings_goals', 'recurring_expenses'];

    this.channel = this.supabase.channel(`duofin2-${this.householdId}-${Date.now()}`);
    tables.forEach(table => {
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `household_id=eq.${this.householdId}` },
        payload => {
          const state = this.getState();
          if (payload.eventType === 'DELETE' && payload.old?.id) {
            const delId = String(payload.old.id);
            state[table] = (state[table] || []).filter(item => String(item.id) !== delId);
          } else {
            const record = payload.new;
            if (!record) return;
            this.observeTimestamp(record.updated_at);
            state[table] = table === 'categories'
              ? this.mergeCategoriesSmart(state[table], [record])
              : this.mergeTable(table, state[table], [record]);
          }
          saveLocalState(state);
          this.lastSyncAt = Date.now();
          this.onRemoteUpdate();
          if (getOutbox().length === 0) {
            this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
          }
        }
      );
    });

    this.channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'households', filter: `id=eq.${this.householdId}` },
      payload => {
        if (!payload.new) return;
        const state = this.getState();
        this.observeTimestamp(payload.new.updated_at);
        if ((Number(payload.new.updated_at) || 0) >= (Number(state.household.updated_at) || 0)) {
          state.household = payload.new;
          saveLocalState(state);
          this.lastSyncAt = Date.now();
          this.onRemoteUpdate();
        }
      }
    );

    this.channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'household_meta', filter: `household_id=eq.${this.householdId}` },
      payload => {
        if (!payload.new) return;
        const state = this.getState();
        this.observeTimestamp(payload.new.updated_at);
        if ((Number(payload.new.updated_at) || 0) >= (Number(state.meta.updated_at) || 0)) {
          state.meta = payload.new;
          saveLocalState(state);
          this.lastSyncAt = Date.now();
          this.onRemoteUpdate();
        }
      }
    );

    this.channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        this.channelHealthy = true;
        const pending = getOutbox().length;
        if (pending > 0) {
          this.onStatusChange('syncing', `${pending} alteração(ões) por enviar para a nuvem...`);
          this.flushOutbox();
        } else {
          this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
        }
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.channelHealthy = false;
        if (!this.reconnectTimer && navigator.onLine && this.householdId) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.subscribeRealtime();
          }, 3500);
        }
      }
    });
  }
}
