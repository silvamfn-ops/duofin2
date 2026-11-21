/**
 * Gera os limites exatos de um ciclo mensal (dia 21 a dia 20) a partir de uma data de referência.
 */
export function getCycleInfo(referenceDateStr) {
  const ref = new Date(`${referenceDateStr.slice(0, 10)}T12:00:00Z`);
  let year = ref.getUTCFullYear();
  let month = ref.getUTCMonth();
  const day = ref.getUTCDate();

  let startYear = year;
  let startMonth = month;

  if (day < 21) {
    startMonth -= 1;
    if (startMonth < 0) {
      startMonth = 11;
      startYear -= 1;
    }
  }

  let endYear = startYear;
  let endMonth = startMonth + 1;
  if (endMonth > 11) {
    endMonth = 0;
    endYear += 1;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const startDate = `${startYear}-${pad(startMonth + 1)}-21`;
  const endDate = `${endYear}-${pad(endMonth + 1)}-20`;
  const nextStartDate = `${endYear}-${pad(endMonth + 1)}-21`;

  return {
    cycleKey: `${startDate}_${endDate}`,
    startDate,
    endDate,
    nextStartDate
  };
}

/**
 * Calcula métricas do ciclo separando movimentos reais de saldos transitados e poupanças.
 */
export function calculateCycleMetrics(transactions) {
  const regularIncome = transactions
    .filter(t => (t.entry_type || 'regular') === 'regular' && Number(t.amount) > 0)
    .reduce((acc, t) => acc + Number(t.amount), 0);

  const regularExpenses = transactions
    .filter(t => (t.entry_type || 'regular') === 'regular' && Number(t.amount) < 0)
    .reduce((acc, t) => acc + Number(t.amount), 0);

  const carryoverBalance = transactions
    .filter(t => t.entry_type === 'carryover')
    .reduce((acc, t) => acc + Number(t.amount), 0);

  const savingsTransfers = transactions
    .filter(t => t.entry_type === 'savings_transfer')
    .reduce((acc, t) => acc + Number(t.amount), 0);

  const netAvailableBalance = regularIncome + regularExpenses + carryoverBalance + savingsTransfers;

  return {
    regularIncome,
    regularExpenses,
    carryoverBalance,
    savingsTransfers,
    netAvailableBalance
  };
}

/**
 * Executa o fecho do ciclo e aplica o destino do saldo remanescente.
 */
export async function closeBillingCycle(supabase, {
  householdId,
  cycleInfo,
  closingBalance,
  decision,
  mainAccountId,
  savingsAccountId = null
}) {
  const balance = Number(closingBalance.toFixed(2));

  if (balance === 0) {
    const { error } = await supabase.from('cycle_closures').insert({
      household_id: householdId,
      cycle_key: cycleInfo.cycleKey,
      start_date: cycleInfo.startDate,
      end_date: cycleInfo.endDate,
      closing_balance: 0,
      action_taken: 'carryover_positive'
    });
    if (error) throw error;
    return { status: 'closed_zero', message: 'Ciclo fechado com saldo nulo (0,00 €).' };
  }

  if (balance < 0) {
    const { error: closureError } = await supabase.from('cycle_closures').insert({
      household_id: householdId,
      cycle_key: cycleInfo.cycleKey,
      start_date: cycleInfo.startDate,
      end_date: cycleInfo.endDate,
      closing_balance: balance,
      action_taken: 'carryover_negative'
    });
    if (closureError) throw closureError;

    const { error: txError } = await supabase.from('transactions').insert({
      household_id: householdId,
      account_id: mainAccountId,
      date: cycleInfo.nextStartDate,
      description: `Saldo negativo transitado (${cycleInfo.startDate} a ${cycleInfo.endDate})`,
      amount: balance,
      entry_type: 'carryover'
    });
    if (txError) throw txError;

    return {
      status: 'carried_over_negative',
      message: `Défice de ${balance.toFixed(2)} € transitado automaticamente para ${cycleInfo.nextStartDate}.`
    };
  }

  if (balance > 0) {
    if (decision === 'carryover') {
      const { error: closureError } = await supabase.from('cycle_closures').insert({
        household_id: householdId,
        cycle_key: cycleInfo.cycleKey,
        start_date: cycleInfo.startDate,
        end_date: cycleInfo.endDate,
        closing_balance: balance,
        action_taken: 'carryover_positive'
      });
      if (closureError) throw closureError;

      const { error: txError } = await supabase.from('transactions').insert({
        household_id: householdId,
        account_id: mainAccountId,
        date: cycleInfo.nextStartDate,
        description: `Saldo positivo transitado (${cycleInfo.startDate} a ${cycleInfo.endDate})`,
        amount: balance,
        entry_type: 'carryover'
      });
      if (txError) throw txError;

      return {
        status: 'carried_over_positive',
        message: `Sobra de +${balance.toFixed(2)} € transitada para o ciclo seguinte.`
      };
    }

    if (decision === 'savings') {
      if (!savingsAccountId) {
        throw new Error('É necessário selecionar uma conta ou objetivo de poupança.');
      }

      const { error: closureError } = await supabase.from('cycle_closures').insert({
        household_id: householdId,
        cycle_key: cycleInfo.cycleKey,
        start_date: cycleInfo.startDate,
        end_date: cycleInfo.endDate,
        closing_balance: balance,
        action_taken: 'transfer_to_savings',
        target_savings_account_id: savingsAccountId
      });
      if (closureError) throw closureError;

      const { error: txError } = await supabase.from('transactions').insert([
        {
          household_id: householdId,
          account_id: mainAccountId,
          date: cycleInfo.endDate,
          description: `Transferência de sobra de ciclo para Poupança`,
          amount: -balance,
          entry_type: 'savings_transfer'
        },
        {
          household_id: householdId,
          account_id: savingsAccountId,
          date: cycleInfo.endDate,
          description: `Reforço de Poupança (Sobra ciclo ${cycleInfo.endDate})`,
          amount: balance,
          entry_type: 'savings_transfer'
        }
      ]);
      if (txError) throw txError;

      return {
        status: 'transferred_to_savings',
        message: `Sobra de +${balance.toFixed(2)} € transferida para Poupança com sucesso.`
      };
    }
  }
}
