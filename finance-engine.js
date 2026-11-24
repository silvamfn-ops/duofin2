import {
  iso, currentMonth, sum, isPaid, dateMs, validDate, addDays,
  daysBetween, monthLast, mName, capFirst, addMonthsClamp
} from './config.js';

export const isSavingTx = t => t && (t.type === 'saving' || t.type === 'saving_withdraw');
export const savingSigned = t => (t.type === 'saving_withdraw' ? -(Number(t.amount) || 0) : Number(t.amount) || 0);

export function getPeopleList(state) {
  return [state.household.adult1_name || 'Adulto 1', state.household.adult2_name || 'Adulto 2', 'Conta conjunta'];
}

export function computeCreditCardDebt(state, card, upToDate = null) {
  if (!card) return 0;
  const cid = String(card.id);
  const baseDebt = Math.max(0, Number(card.initial_debt) || 0);
  const relevant = state.transactions.filter(
    t => !t.deleted_at && isPaid(t) && String(t.credit_card_id || '') === cid && (!upToDate || t.date <= upToDate)
  );
  const charges = sum(relevant.filter(t => t.type === 'expense'));
  const payments = sum(relevant.filter(t => t.type === 'cc_payment'));
  return Math.max(0, Number((baseDebt + charges - payments).toFixed(2)));
}

export function getAllCreditCardsStats(state) {
  return (state.credit_cards || [])
    .filter(c => !c.deleted_at)
    .map(c => {
      const debt = computeCreditCardDebt(state, c);
      const limit = Math.max(0, Number(c.card_limit) || 0);
      const available = limit > 0 ? Math.max(0, limit - debt) : null;
      const pct = limit > 0 ? Math.min(100, (debt / limit) * 100) : 0;
      return { ...c, debt, limit, available, pct };
    });
}

export function computeCycleReferenceMonth(c) {
  if (c.fallback) return capFirst(mName(c.key.slice(6)));
  if (c.preCycle) return 'Período inicial (' + capFirst(mName(c.end.slice(0, 7))) + ')';
  const [sy, sm, sd] = c.start.split('-').map(Number);
  let refY = sy, refM = sm;
  if (sd >= 15) {
    refM += 1;
    if (refM > 12) {
      refM = 1;
      refY += 1;
    }
  }
  return capFirst(mName(`${refY}-${String(refM).padStart(2, '0')}`));
}

function assignCycleMonthLabels(cycles) {
  const counts = {};
  cycles.forEach(c => {
    const base = computeCycleReferenceMonth(c);
    c.monthLabel = base;
    counts[base] = (counts[base] || 0) + 1;
  });
  const seen = {};
  cycles.forEach(c => {
    if (counts[c.monthLabel] > 1) {
      seen[c.monthLabel] = (seen[c.monthLabel] || 0) + 1;
      c.monthLabel = `${c.monthLabel} (${seen[c.monthLabel]}.º)`;
    }
  });
  return cycles;
}

export function buildCycles(state) {
  const today = iso();
  const cur = currentMonth();
  const validTx = state.transactions.filter(t => !t.deleted_at && validDate(t.date) && t.date <= today);
  const cycleIncomes = validTx
    .filter(t => t.type === 'income' && isPaid(t) && t.counts_for_cycle !== false)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));

  if (!cycleIncomes.length) {
    const monthKeys = [...new Set([...validTx.map(t => t.date.slice(0, 7)), cur])].sort();
    return assignCycleMonthLabels(
      monthKeys.map(m => ({
        key: 'month:' + m,
        start: m + '-01',
        end: monthLast(m),
        fallback: true,
        preCycle: false,
        open: false
      }))
    );
  }

  const maxGap = Math.max(0, Math.min(20, Math.round(Number(state.household.cycle_grouping_days ?? 14))));
  const groups = [];
  cycleIncomes.forEach(t => {
    const g = groups[groups.length - 1];
    if (g && daysBetween(g.lastDate, t.date) <= maxGap) {
      g.items.push(t);
      g.lastDate = t.date;
    } else {
      groups.push({ items: [t], firstDate: t.date, lastDate: t.date });
    }
  });

  const cycles = [];
  const firstMovement = validTx.map(t => t.date).sort()[0];
  if (firstMovement && firstMovement < groups[0].firstDate) {
    const preEnd = addDays(groups[0].firstDate, -1);
    cycles.push({ key: 'pre:' + firstMovement + ':' + preEnd, start: firstMovement, end: preEnd, open: false, fallback: false, preCycle: true });
  }

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i], next = groups[i + 1];
    const start = g.firstDate;
    if (next) {
      const end = addDays(next.firstDate, -1);
      cycles.push({ key: 'cycle:' + start + ':' + end, start, end, open: false, fallback: false, preCycle: false });
    } else {
      const futureDates = state.transactions.filter(t => !t.deleted_at && validDate(t.date) && t.date > today).map(t => t.date).sort();
      const maxEnd = futureDates.length ? futureDates[futureDates.length - 1] : today;
      cycles.push({ key: 'open:' + start, start, end: maxEnd, open: true, fallback: false, preCycle: false });
    }
  }
  return assignCycleMonthLabels(cycles);
}

export function currentCycle(cycles) {
  const today = iso();
  return (
    cycles.find(c => c.start <= today && c.end >= today && !c.preCycle) ||
    cycles.find(c => c.start <= today && c.end >= today) ||
    cycles[cycles.length - 1]
  );
}

export function cycleTransactions(state, c) {
  return state.transactions.filter(t => !t.deleted_at && validDate(t.date) && t.date >= c.start && t.date <= c.end);
}

export function computeCycleBalance(state, c, upToDate = iso()) {
  const tx = cycleTransactions(state, c).filter(t => t.date <= upToDate);
  const bankEx = tx.filter(t => t.type === 'expense' && isPaid(t) && !t.credit_card_id);
  const ccPay = tx.filter(t => t.type === 'cc_payment' && isPaid(t));
  const inc = tx.filter(t => t.type === 'income' && isPaid(t));
  const svIn = tx.filter(t => t.type === 'saving' && isPaid(t));
  const svOut = tx.filter(t => t.type === 'saving_withdraw' && isPaid(t));
  return sum(inc) + sum(svOut) - sum(bankEx) - sum(ccPay) - sum(svIn);
}

export function computeCycleProjection(state, cycle, currentBalance) {
  const today = iso();
  if (!cycle.open && cycle.end <= today) return null;

  const estimatedCycleEnd = cycle.open ? addDays(addMonthsClamp(cycle.start, 1), -1) : cycle.end;
  const horizonEnd = estimatedCycleEnd > today ? estimatedCycleEnd : today;

  const pendingInCycle = cycleTransactions(state, cycle).filter(t => t.type === 'expense' && t.status === 'pending' && !t.credit_card_id && t.date <= today);
  const scheduledFutureExp = state.transactions.filter(
    t => !t.deleted_at && ((t.type === 'expense' && !t.credit_card_id) || t.type === 'cc_payment') && t.status !== 'skipped' && t.date > today && t.date <= horizonEnd
  );
  const scheduledFutureSavOut = state.transactions.filter(
    t => !t.deleted_at && t.type === 'saving' && t.status !== 'skipped' && t.date > today && t.date <= horizonEnd
  );
  const scheduledFutureSavIn = state.transactions.filter(
    t => !t.deleted_at && t.type === 'saving_withdraw' && t.status !== 'skipped' && t.date > today && t.date <= horizonEnd
  );
  const futureInc = state.transactions.filter(
    t => !t.deleted_at && t.type === 'income' && t.status !== 'skipped' && t.date > today && t.date <= horizonEnd
  );

  const committedOut = sum(pendingInCycle) + sum(scheduledFutureExp) + sum(scheduledFutureSavOut);
  const committedIn = sum(futureInc) + sum(scheduledFutureSavIn);
  const itemCount = pendingInCycle.length + scheduledFutureExp.length + scheduledFutureSavOut.length + scheduledFutureSavIn.length + futureInc.length;

  return {
    projectedBalance: currentBalance + committedIn - committedOut,
    itemCount
  };
}

export function computeDailyBurnRate(state, cycle, currentBalance) {
  const today = iso();
  if (!cycle || !(cycle.start <= today && (cycle.open || cycle.end >= today))) return null;
  const estimatedEnd = cycle.open ? addDays(addMonthsClamp(cycle.start, 1), -1) : cycle.end;
  const daysLeft = Math.max(1, daysBetween(today, estimatedEnd) + 1);
  const proj = computeCycleProjection(state, cycle, currentBalance);
  const freeToSpend = proj ? proj.projectedBalance : currentBalance;
  return {
    dailyAllowance: freeToSpend / daysLeft,
    freeToSpend,
    daysLeft
  };
}

export function goalTotal(state, goalId) {
  return Math.max(
    0,
    state.transactions
      .filter(t => !t.deleted_at && isSavingTx(t) && isPaid(t) && String(t.goal_id) === String(goalId))
      .reduce((acc, t) => acc + savingSigned(t), 0)
  );
}

export function getProjectedCalendarEvents(state, yearMonth) {
  const events = [];
  const [y, m] = yearMonth.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = iso();

  for (const r of state.recurring_expenses || []) {
    if (r.deleted_at || r.active === false) continue;
    if (r.start_month && r.start_month > yearMonth) continue;
    if (r.end_month && r.end_month < yearMonth) continue;

    const day = Math.min(Math.max(1, Number(r.day_of_month) || 1), daysInMonth);
    const dateStr = `${yearMonth}-${String(day).padStart(2, '0')}`;
    if (dateStr < today && yearMonth < currentMonth()) continue;

    const cp = r.cycle_payments || {};
    const alreadyPaidInMonth = Object.values(cp).some(entry => entry && entry.paid && String(entry.paidDate || '').startsWith(yearMonth));
    if (alreadyPaidInMonth) continue;

    events.push({
      id: `proj-${r.id}-${yearMonth}`,
      date: dateStr,
      type: 'expense',
      description: r.description,
      amount: Number(r.amount) || 0,
      category: r.category,
      person: r.person || 'Conta conjunta',
      isProjected: true,
      projSource: 'Caderno de encargos'
    });
  }
  return events;
}
