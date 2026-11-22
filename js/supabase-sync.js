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

function sanitizeRecord(table, raw) {
  const cols = TABLE_COLUMNS[table];
  if (!cols) return { ...raw };
  const clean = {};
  for (const col of cols) {
    if (raw[col] !== undefined) clean[col] = raw[col];
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
    this.isPulling = false;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.lastSyncAt = null;
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
    localStorage.setItem(CFG_KEY, JSON.stringify({ url: url.trim(), anonKey: anonKey.trim(), householdId }));
  }

  isConfigured() {
    const cfg = this.getConfig();
    return /^https:\/\/.+\.supabase\.co$/i.test(cfg.url) && cfg.anonKey.length > 20;
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
      realtime: { params: { eventsPerSecond: 10 } }
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
    // Refresh token proactively if expiring within 90 seconds
    const expiresAtMs = (session.expires_at || 0) * 1000;
    if (expiresAtMs && expiresAtMs - Date.now() < 90_000) {
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
      await this.flushOutbox();
      await this.fullPull({ silent: true });
      if (!this.channelHealthy) {
        this.subscribeRealtime();
      }
    }, 30_000);
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
    await this.fullPull();
    this.subscribeRealtime();
    this.startHeartbeat();
  }

  async resumeFromBackground() {
    if (!this.isConfigured()) return;
    const session = await this.ensureValidSession();
    if (!session || !this.householdId) return;
    await this.flushOutbox();
    await this.fullPull({ silent: true });
    this.subscribeRealtime();
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
    await this.fullPull();
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
    await this.fullPull();
    this.subscribeRealtime();
    this.startHeartbeat();
    return hid;
  }

  async queueAllLocalToOutbox() {
    const st = this.getState();
    enqueueOutbox('households', { ...st.household, id: this.householdId });
    st.categories.forEach(c => enqueueOutbox('categories', c));
    st.credit_cards.forEach(c => enqueueOutbox('credit_cards', c));
    st.savings_goals.forEach(g => enqueueOutbox('savings_goals', g));
    st.recurring_expenses.forEach(r => enqueueOutbox('recurring_expenses', r));
    st.transactions.forEach(t => enqueueOutbox('transactions', t));
    enqueueOutbox('household_meta', { ...st.meta, household_id: this.householdId });
    await this.flushOutbox();
  }

  scheduleOutboxRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const delays = [4000, 10000, 20000, 30000];
    const waitMs = delays[Math.min(this.retryAttempt, delays.length - 1)];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      if (navigator.onLine) this.flushOutbox();
    }, waitMs);
  }

  async flushOutbox() {
    if (!this.supabase || !this.householdId || this.isFlushing) return;
    if (!navigator.onLine) {
      this.onStatusChange('offline', 'Sem internet — alterações guardadas localmente.');
      return;
    }
    const queue = getOutbox();
    if (!queue.length) return;

    this.isFlushing = true;
    this.onStatusChange('syncing', `A sincronizar ${queue.length} alteração(ões)...`);
    const processed = [];
    let failedCount = 0;
    let lastErrorMsg = '';

    try {
      const session = await this.ensureValidSession();
      if (!session) {
        this.onStatusChange('logged_out', 'Sessão expirada. Inicia sessão novamente para sincronizar.');
        return;
      }

      // Group queue items by table and deduplicate latest version per record key for atomic batch upserts
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
          // Fallback to item-by-item upsert if a single record in the batch caused an error
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
              lastErrorMsg = itemErr.message;
              console.warn(`Erro sync ${table}:`, itemErr.message);
            }
          }
        }
      }

      if (processed.length) clearOutboxItems(processed);

      if (failedCount > 0) {
        this.onStatusChange('offline', `${failedCount} pendente(s): ${lastErrorMsg || 'a repetir sincronização...'}`);
        this.scheduleOutboxRetry();
      } else {
        this.retryAttempt = 0;
        this.lastSyncAt = Date.now();
        this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
      }
    } catch (err) {
      this.onStatusChange('offline', 'Falha temporária de rede — nova tentativa automática em breve.');
      this.scheduleOutboxRetry();
    } finally {
      this.isFlushing = false;
    }
  }

  async fullPull({ silent = false } = {}) {
    if (!this.supabase || !this.householdId || this.isPulling || !navigator.onLine) return;
    this.isPulling = true;
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

      if (hhRes.data && (Number(hhRes.data.updated_at) || 0) >= (Number(state.household.updated_at) || 0)) {
        state.household = hhRes.data;
      }
      if (catRes.data) state.categories = this.mergeTable('categories', state.categories, catRes.data, outbox);
      if (ccRes.data) state.credit_cards = this.mergeTable('credit_cards', state.credit_cards, ccRes.data, outbox);
      if (goalRes.data) state.savings_goals = this.mergeTable('savings_goals', state.savings_goals, goalRes.data, outbox);
      if (recRes.data) state.recurring_expenses = this.mergeTable('recurring_expenses', state.recurring_expenses, recRes.data, outbox);
      if (txRes.data) state.transactions = this.mergeTable('transactions', state.transactions, txRes.data, outbox);
      if (metaRes.data && (Number(metaRes.data.updated_at) || 0) >= (Number(state.meta.updated_at) || 0)) {
        state.meta = metaRes.data;
      }

      saveLocalState(state);
      this.lastSyncAt = Date.now();
      this.onRemoteUpdate();
      if (getOutbox().length === 0) {
        this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
      }
    } finally {
      this.isPulling = false;
    }
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
          const record = payload.new;
          if (!record) return;
          const state = this.getState();
          state[table] = this.mergeTable(table, state[table], [record]);
          saveLocalState(state);
          this.lastSyncAt = Date.now();
          this.onRemoteUpdate();
        }
      );
    });

    this.channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'households', filter: `id=eq.${this.householdId}` },
      payload => {
        if (!payload.new) return;
        const state = this.getState();
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
        this.onStatusChange('synced', `Sincronizado (${this.user?.email || 'ligado'}${this.formatLastSyncTime()})`);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        this.channelHealthy = false;
        if (!this.reconnectTimer && navigator.onLine && this.householdId) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.subscribeRealtime();
          }, 5000);
        }
      }
    });
  }
}
