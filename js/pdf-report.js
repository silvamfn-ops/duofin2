/**
 * Gerador de Relatórios Financeiros A4 (PDF via impressão nativa do sistema)
 * Funciona offline em iOS, Android, Windows e macOS sem dependências pesadas.
 */
import { APP_VERSION, iso, eur, esc, sum, isPaid, fmtDate } from './config.js';
import {
  cycleTransactions, computeCycleBalance, getAllCreditCardsStats, goalTotal, getPeopleList
} from './finance-engine.js';

export function generateCyclePdfReport(state, cycle, customTransactions = null, customTitle = null) {
  const container = document.getElementById('printReportContainer');
  if (!container) return;

  const today = iso();
  const txList = customTransactions
    ? [...customTransactions].sort((a, b) => a.date.localeCompare(b.date))
    : cycleTransactions(state, cycle).sort((a, b) => a.date.localeCompare(b.date));

  const paidTx = txList.filter(t => isPaid(t));
  const ex = paidTx.filter(t => t.type === 'expense');
  const inc = paidTx.filter(t => t.type === 'income');
  const svIn = paidTx.filter(t => t.type === 'saving');
  const svOut = paidTx.filter(t => t.type === 'saving_withdraw');

  const totalInc = sum(inc);
  const totalExp = sum(ex);
  const netSav = sum(svIn) - sum(svOut);
  const bal = customTransactions
    ? totalInc - totalExp - netSav
    : computeCycleBalance(state, cycle, cycle.end);

  const activeCats = (state.categories || []).filter(c => !c.deleted_at);
  const people = getPeopleList(state);
  const ccStats = getAllCreditCardsStats(state);
  const activeGoals = (state.savings_goals || []).filter(g => !g.deleted_at);

  const reportTitle = customTitle || `Relatório Financeiro — ${cycle.monthLabel}`;
  const periodLabel = customTitle
    ? `Exportado em ${fmtDate(today)} (${txList.length} movimentos)`
    : `Período: ${fmtDate(cycle.start)} a ${fmtDate(cycle.end)} · Emitido em ${fmtDate(today)}`;

  const typeLabels = {
    expense: 'Despesa',
    cc_payment: 'Pag. Cartão',
    income: 'Rendimento',
    saving: 'Poupança (+)',
    saving_withdraw: 'Resgate (−)'
  };

  const catRowsHtml = activeCats
    .map(c => {
      const spent = sum(ex.filter(t => t.category === c.name));
      const budget = Number(c.budget) || 0;
      if (spent === 0 && budget === 0) return '';
      const diff = budget - spent;
      return `
        <tr>
          <td>${esc(c.name)}</td>
          <td class="num">${budget > 0 ? eur(budget) : '—'}</td>
          <td class="num"><b>${eur(spent)}</b></td>
          <td class="num ${budget > 0 && diff < 0 ? 'neg' : ''}">${budget > 0 ? eur(diff) : '—'}</td>
        </tr>`;
    })
    .filter(Boolean)
    .join('');

  const personRowsHtml = people
    .map(p => {
      const spent = sum(ex.filter(t => t.person === p));
      const pct = totalExp > 0 ? Math.round((spent / totalExp) * 100) : 0;
      return `<tr><td>${esc(p)}</td><td class="num"><b>${eur(spent)}</b></td><td class="num">${pct}%</td></tr>`;
    })
    .join('');

  const ccSectionHtml = ccStats.length
    ? `
      <h3>Cartões de Crédito</h3>
      <table class="rep-table">
        <thead><tr><th>Cartão</th><th>Titular</th><th class="num">Plafond</th><th class="num">Dívida Atual</th></tr></thead>
        <tbody>
          ${ccStats
            .map(
              c => `<tr>
                <td>${esc(c.name)}</td>
                <td>${esc(c.owner)}</td>
                <td class="num">${c.limit > 0 ? eur(c.limit) : '—'}</td>
                <td class="num ${c.debt > 0 ? 'neg' : ''}"><b>${eur(c.debt)}</b></td>
              </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : '';

  const goalsSectionHtml = activeGoals.length
    ? `
      <h3>Objetivos de Poupança</h3>
      <table class="rep-table">
        <thead><tr><th>Objetivo</th><th>Meta</th><th class="num">Acumulado</th><th class="num">Alvo</th><th class="num">Progresso</th></tr></thead>
        <tbody>
          ${activeGoals
            .map(g => {
              const saved = goalTotal(state, g.id);
              const pct = g.target > 0 ? Math.min(100, Math.round((saved / g.target) * 100)) : 0;
              return `<tr>
                <td>${esc(g.name)}</td>
                <td>${g.deadline ? fmtDate(g.deadline) : '—'}</td>
                <td class="num"><b>${eur(saved)}</b></td>
                <td class="num">${eur(g.target)}</td>
                <td class="num">${pct}%</td>
              </tr>`;
            })
            .join('')}
        </tbody>
      </table>`
    : '';

  const txRowsHtml = txList.length
    ? txList
        .map(t => {
          const sign = t.type === 'income' ? '+' : t.type === 'saving_withdraw' ? '↙' : '−';
          const cls = t.type === 'income' ? 'pos' : t.type === 'expense' ? 'neg' : '';
          return `
            <tr>
              <td style="white-space:nowrap">${fmtDate(t.date)}</td>
              <td>${esc(t.description)}${t.status === 'pending' ? ' <i>(Pendente)</i>' : ''}</td>
              <td>${esc(t.category)}</td>
              <td>${esc(t.person)}</td>
              <td>${typeLabels[t.type] || t.type}</td>
              <td class="num ${cls}"><b>${sign} ${eur(t.amount)}</b></td>
            </tr>`;
        })
        .join('')
    : '<tr><td colspan="6" style="text-align:center;color:#666">Sem movimentos registados neste período.</td></tr>';

  container.innerHTML = `
    <div class="rep-sheet">
      <div class="rep-header">
        <div>
          <div class="rep-brand">DUOFIN 2 · GESTÃO FINANCEIRA A DOIS</div>
          <h1>${esc(reportTitle)}</h1>
          <div class="rep-sub">${esc(periodLabel)}</div>
        </div>
        <div class="rep-meta">
          <div><b>${esc(state.household?.adult1_name || 'Adulto 1')}</b> &amp; <b>${esc(state.household?.adult2_name || 'Adulto 2')}</b></div>
          <div>Versão ${APP_VERSION}</div>
        </div>
      </div>

      <div class="rep-kpis">
        <div class="rep-kpi"><span>Rendimentos</span><b class="pos">${eur(totalInc)}</b></div>
        <div class="rep-kpi"><span>Despesas Pagas</span><b class="neg">${eur(totalExp)}</b></div>
        <div class="rep-kpi"><span>Poupança Líquida</span><b>${eur(netSav)}</b></div>
        <div class="rep-kpi"><span>Saldo do Período</span><b class="${bal < 0 ? 'neg' : 'pos'}">${eur(bal)}</b></div>
      </div>

      <div class="rep-two-col">
        <div>
          <h3>Despesas por Categoria</h3>
          <table class="rep-table">
            <thead><tr><th>Categoria</th><th class="num">Limite</th><th class="num">Gasto</th><th class="num">Diferença</th></tr></thead>
            <tbody>${catRowsHtml || '<tr><td colspan="4">Sem despesas</td></tr>'}</tbody>
          </table>
        </div>
        <div>
          <h3>Despesas por Adulto</h3>
          <table class="rep-table">
            <thead><tr><th>Responsável</th><th class="num">Total</th><th class="num">%</th></tr></thead>
            <tbody>${personRowsHtml}</tbody>
          </table>
          ${ccSectionHtml}
        </div>
      </div>

      ${goalsSectionHtml}

      <h3>Extrato Detalhado de Movimentos (${txList.length})</h3>
      <table class="rep-table">
        <thead>
          <tr>
            <th>Data</th>
            <th>Descrição</th>
            <th>Categoria</th>
            <th>Responsável</th>
            <th>Tipo</th>
            <th class="num">Valor</th>
          </tr>
        </thead>
        <tbody>${txRowsHtml}</tbody>
      </table>
    </div>
  `;

  const prevTitle = document.title;
  document.title = `DuoFin_${(cycle?.key || iso()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  setTimeout(() => {
    window.print();
    document.title = prevTitle;
  }, 120);
}
