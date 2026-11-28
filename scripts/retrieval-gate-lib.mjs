// SPDX-License-Identifier: AGPL-3.0-only
// © 2026 wangzhen110 · https://github.com/wangzhen110/omni-memory

/**
 * Retrieval gate rules, separated from the runner so the thresholds can be
 * unit-tested without running the two-minute LoCoMo harness.
 */

export const GATE = {
  // Session granularity: whole conversations as notes. These numbers were
  // already above target before 4.7.0; the gate exists to stop them slipping.
  session: { recall: 0.70, ndcg: 0.55 },
  // Turn granularity: the answer-bearing turn itself must rank. This was 0.3179
  // in 4.6.19 and is the metric 4.7.0 improved.
  turn: { recall: 0.40, ndcg: null },
};

export const GATE_LABELS = {
  session: `session recall@10 >= ${GATE.session.recall}, session nDCG@10 >= ${GATE.session.ndcg}`,
  turn: `turn recall@10 >= ${GATE.turn.recall}`,
};

export function evaluateGate(reports, k = 10) {
  const failures = [];
  const lines = [];
  for (const granularity of ['session', 'turn']) {
    const report = reports[granularity];
    if (!report) {
      failures.push(`${granularity}: no benchmark report`);
      continue;
    }
    const gate = GATE[granularity];
    const recall = Number(report.metrics?.evidenceRecall);
    const ndcg = Number(report.metrics?.ndcg);
    if (!Number.isFinite(recall)) {
      failures.push(`${granularity}: evidenceRecall missing`);
      continue;
    }
    const parts = [`${granularity}: recall@${k}=${recall.toFixed(4)}`];
    if (recall < gate.recall) failures.push(`${granularity} recall ${recall.toFixed(4)} < ${gate.recall}`);
    if (gate.ndcg != null) {
      if (!Number.isFinite(ndcg)) {
        failures.push(`${granularity}: ndcg missing`);
      } else {
        parts.push(`nDCG=${ndcg.toFixed(4)}`);
        if (ndcg < gate.ndcg) failures.push(`${granularity} nDCG ${ndcg.toFixed(4)} < ${gate.ndcg}`);
      }
    }
    parts.push(`questions=${report.questions}`);
    lines.push(parts.join(' '));
  }
  return { ok: failures.length === 0, failures, lines };
}
