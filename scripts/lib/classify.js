import { dataPath, readJson } from './io.js';

/**
 * カテゴリ自動分類。
 *
 *   ① category_rules.json の正規表現マッチ  → confidence: high
 *   ② 過去の同一 merchant_key の分類履歴     → confidence: high
 *   ③ どちらにも該当しなければ「不明 / 要確認」
 *
 * 外部AI APIは使わない（従量課金を発生させない方針）。
 * ③に落ちたものは Claude Code 上で対話的に確定させ、ルールへ追記する。
 */

export function loadRules() {
  const raw = readJson(dataPath('category_rules.json'), { rules: [] });
  return (raw.rules ?? []).map((r) => ({
    ...r,
    regex: new RegExp(r.pattern, 'i'), // merchant_key は大小を畳んでいないため i フラグで吸収
  }));
}

/**
 * @param {string} key      正規化済みの店名（merchantKey の結果）
 * @param {object} rules    loadRules() の結果
 * @param {Map}    history  merchant_key → 過去の分類結果
 */
export function classify(key, rules, history = new Map()) {
  for (const r of rules) {
    if (r.regex.test(key)) {
      return {
        category: r.category,
        subcategory: r.subcategory ?? null,
        display: r.display ?? null,
        is_fixed_cost: r.is_fixed_cost === true,
        confidence: r.confidence ?? 'high',
        needs_review: r.needs_review === true,
        matched_by: 'rule',
      };
    }
  }
  const past = history.get(key);
  if (past) {
    return { ...past, confidence: 'high', needs_review: false, matched_by: 'history' };
  }
  return {
    category: '不明',
    subcategory: '要確認',
    display: null,
    is_fixed_cost: false,
    confidence: 'low',
    needs_review: true,
    matched_by: 'none',
  };
}

/** 既存の取引から「店名 → 分類」の履歴を作る（人が確定した結果を再利用するため） */
export function buildHistory(transactions) {
  const history = new Map();
  for (const t of transactions) {
    if (!t.merchant_key || t.needs_review || t.category === '不明') continue;
    history.set(t.merchant_key, {
      category: t.category,
      subcategory: t.subcategory ?? null,
      display: t.merchant ?? null,
      is_fixed_cost: t.is_fixed_cost === true,
    });
  }
  return history;
}
