/**
 * Motor de deteção de possíveis duplicados para o DuoFin 2
 * Compara movimentos extraídos de PDF/CSV/Texto contra state.transactions
 */

export function normalizeDescription(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(compra|pag\.?\s*servicos?|transf\.?|mb\s*way|debito\s*direto|dd|pos)\b/g, ' ')
    .replace(/\b\d{2}[\/\-]\d{2}([\/\-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{3,}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function calculateTextSimilarity(descA, descB) {
  const normA = normalizeDescription(descA);
  const normB = normalizeDescription(descB);

  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.85;

  const tokensA = new Set(normA.split(' ').filter(w => w.length > 2));
  const tokensB = new Set(normB.split(' ').filter(w => w.length > 2));

  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) intersection++;
  }

  const union = new Set([...tokensA, ...tokensB]).size;
  return intersection / union;
}

export function getDaysDifference(dateStrA, dateStrB) {
  const msPerDay = 1000 * 60 * 60 * 24;
  const dA = new Date(`${String(dateStrA).slice(0, 10)}T12:00:00Z`);
  const dB = new Date(`${String(dateStrB).slice(0, 10)}T12:00:00Z`);
  return Math.abs(Math.round((dA - dB) / msPerDay));
}

/**
 * Avalia linhas importadas contra os movimentos ativos em state.transactions.
 * No DuoFin 2, amount é sempre positivo e a direção é dada por `type` ('expense' vs 'income').
 */
export function evaluateStatementDuplicates(parsedRows, stateTransactions, options = {}) {
  const { dayWindow = 3, similarityThreshold = 0.45 } = options;

  const activeTxs = (stateTransactions || []).filter(t => !t.deleted_at && t.status !== 'skipped');
  const byAmountAndType = new Map();

  for (const tx of activeTxs) {
    const key = `${tx.type}:${Number(tx.amount).toFixed(2)}`;
    if (!byAmountAndType.has(key)) byAmountAndType.set(key, []);
    byAmountAndType.get(key).push(tx);
  }

  const seenInBatch = [];

  return parsedRows.map((row) => {
    const amt = Number(row.amount) || 0;
    const key = `${row.type}:${amt.toFixed(2)}`;
    const candidates = byAmountAndType.get(key) || [];

    let bestMatch = null;
    let highestScore = 0;

    for (const existing of candidates) {
      const daysDiff = getDaysDifference(row.date, existing.date);
      if (daysDiff > dayWindow) continue;

      const textSim = calculateTextSimilarity(row.description, existing.description);
      const dateBonus = daysDiff === 0 ? 0.25 : daysDiff === 1 ? 0.1 : 0;
      const totalScore = Math.min(1, textSim + dateBonus);

      if (textSim >= similarityThreshold || (daysDiff === 0 && textSim >= 0.2)) {
        if (totalScore > highestScore) {
          highestScore = totalScore;
          bestMatch = existing;
        }
      }
    }

    const batchDup = seenInBatch.find(
      item =>
        item.type === row.type &&
        Number(item.amount).toFixed(2) === amt.toFixed(2) &&
        item.date === row.date &&
        calculateTextSimilarity(item.description, row.description) > 0.8
    );

    seenInBatch.push(row);

    const isDuplicate = Boolean(bestMatch || batchDup);

    return {
      ...row,
      isDuplicate,
      selected: !isDuplicate,
      matchedTx: bestMatch || batchDup || null,
      duplicateReason: bestMatch
        ? `Já existe: "${bestMatch.description}" (${bestMatch.date})`
        : batchDup
          ? 'Linha repetida neste extrato'
          : null
    };
  });
}
