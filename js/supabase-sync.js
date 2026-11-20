import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getOutbox, clearOutboxItems, saveLocalState, enqueueOutbox } from './db.js';

const CFG_KEY = 'duofin2-sb-config-v1';

export class DuoFinSync {
  constructor(getState, onRemoteUpdate, onStatusChange) {
    this.getState = getState;
    this.onRemoteUpdate = onRemoteUpdate;
    this.onStatusChange = onStatusChange;
    this.supabase = null;
    this.householdId = null;
    this.user = null;
    this.channel = null;
    this.isFlushing = false;
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
      auth: { persistSession: true, autoRefreshToken: true }
    });
    return true;
  }

  async connectAndSubscribe() {
    if (!this.supabase && !this.init()) return;
    const { data: { session } } = await this.supabase.auth.getSession();
    if (!session) {
      this.user = null;
      this.onStatusChange('logged_out', 'Configurado. Inicia sessão ou cria conta para sincronizar.');
      return;
    }
    this.user = session.user;

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
    if (this.channel && this.supabase) this.supabase.removeChannel(this.channel);
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

  async flushOutbox() {
    if (!this.supabase || !this.householdId || this.isFlushing || !navigator.onLine) return;
    const queue = getOutbox();
    if (!queue.length) return;

    this.isFlushing = true;
    this.onStatusChange('syncing', `A sincronizar ${queue.length} alteração(ões)...`);
    const processed = [];

    try {
      for (const item of queue) {
        const rec = { ...item.record };
        if (item.table === 'households') {
          rec.id = this.householdId;
          const { error } = await this.supabase.from('households').upsert(rec, { onConflict: 'id' });
          if (!error) processed.push(`${item.table}:${rec.id}:${item.queuedAt}`);
        } else if (item.table === 'household_meta') {
          rec.household_id = this.householdId;
          const { error } = await this.supabase.from('household_meta').upsert(rec, { onConflict: 'household_id' });
          if (!error) processed.push(`${item.table}:${rec.household_id}:${item.queuedAt}`);
        } else {
          rec.household_id = this.householdId;
          const { error } = await this.supabase.from(item.table).upsert(rec, { onConflict: 'id' });
          if (!error) processed.push(`${item.table}:${rec.id}:${item.queuedAt}`);
        }
      }
      clearOutboxItems(processed);
      this.onStatusChange('synced', `Sincronizado em tempo real (${this.user?.email || 'ligado'})`);
    } catch {
      this.onStatusChange('offline', 'Alterações guardadas localmente (aguarda ligação).');
    } finally {
      this.isFlushing = false;
    }
  }

  async fullPull() {
    if (!this.supabase || !this.householdId) return;
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

    const state = this.getState();
    if (hhRes.data && (hhRes.data.updated_at || 0) >= (state.household.updated_at || 0)) {
      state.household = hhRes.data;
    }
    if (catRes.data) state.categories = this.mergeTable(state.categories, catRes.data);
    if (ccRes.data) state.credit_cards = this.mergeTable(state.credit_cards, ccRes.data);
    if (goalRes.data) state.savings_goals = this.mergeTable(state.savings_goals, goalRes.data);
    if (recRes.data) state.recurring_expenses = this.mergeTable(state.recurring_expenses, recRes.data);
    if (txRes.data) state.transactions = this.mergeTable(state.transactions, txRes.data);
    if (metaRes.data && (metaRes.data.updated_at || 0) >= (state.meta.updated_at || 0)) {
      state.meta = metaRes.data;
    }

    saveLocalState(state);
    this.onRemoteUpdate();
    this.onStatusChange('synced', `Sincronizado em tempo real (${this.user?.email || 'ligado'})`);
  }

  mergeTable(localList, remoteList) {
    const map = new Map();
    localList.forEach(item => map.set(String(item.id), item));
    remoteList.forEach(rem => {
      const id = String(rem.id);
      const loc = map.get(id);
      if (!loc || (Number(rem.updated_at) || 0) >= (Number(loc.updated_at) || 0)) {
        map.set(id, rem);
      }
    });
    return Array.from(map.values()).filter(item => !item.deleted_at);
  }

  subscribeRealtime() {
    if (this.channel) this.supabase.removeChannel(this.channel);
    const tables = ['transactions', 'categories', 'credit_cards', 'savings_goals', 'recurring_expenses'];

    this.channel = this.supabase.channel(`duofin2-${this.householdId}`);
    tables.forEach(table => {
      this.channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `household_id=eq.${this.householdId}` },
        payload => {
          const record = payload.new;
          if (!record) return;
          const state = this.getState();
          state[table] = this.mergeTable(state[table], [record]);
          saveLocalState(state);
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
        if ((payload.new.updated_at || 0) >= (state.household.updated_at || 0)) {
          state.household = payload.new;
          saveLocalState(state);
          this.onRemoteUpdate();
        }
      }
    );

    this.channel.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        this.onStatusChange('synced', `Sincronizado em tempo real (${this.user?.email || 'ligado'})`);
      }
    });
  }
}
