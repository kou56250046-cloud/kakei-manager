import { dataPath, readJson, writeJson } from './io.js';

/**
 * 口座残高の記録。
 *
 * ★なぜ関数にするか
 *   これまで `close.js` の中だけにあった。残高はネットバンキングを見ないと分からないので
 *   自動化できず、**月次運用でターミナルを開く理由がここ1か所だけ残っていた**。
 *   確定パネルからも入れられるようにするにあたり、書き方が2か所に分かれると
 *   「同じ日に2件」のような壊れ方をする。
 *
 * ★同じ日の記録は上書きする
 *   残高は「その日時点のスナップショット」なので、同じ口座・同じ日に2つあっても
 *   どちらが正しいか決められない。入れ直したら置き換える。
 */

/**
 * @param {string} accountId
 * @param {number} amount 円（整数）
 * @param {string} date    YYYY-MM-DD
 * @returns {{ ok: boolean, error?: string, replaced?: boolean, record?: object }}
 */
export function recordBalance(accountId, amount, date) {
  const accounts = readJson(dataPath('accounts.json'), []);
  if (!accounts.some((a) => a.id === accountId)) {
    return { ok: false, error: `口座 ${accountId} が accounts.json にありません` };
  }
  if (!Number.isInteger(amount) || amount < 0) {
    return { ok: false, error: '残高は0以上の整数（円）で入れてください' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: '日付は YYYY-MM-DD で指定してください' };
  }

  const balances = readJson(dataPath('balances.json'), []);
  const record = { account_id: accountId, date, actual_balance: amount };
  const i = balances.findIndex((b) => b.account_id === accountId && b.date === date);
  const replaced = i >= 0;
  if (replaced) balances[i] = record;
  else balances.push(record);

  balances.sort((a, b) => a.date.localeCompare(b.date) || a.account_id.localeCompare(b.account_id));
  writeJson(dataPath('balances.json'), balances);
  return { ok: true, replaced, record };
}

/** 入力された文字列を円（整数）にする。「1,234円」「 1234 」なども受ける */
export function parseAmount(raw) {
  const s = String(raw ?? '').replace(/[,\s円￥¥]/g, '');
  if (!/^\d+$/.test(s)) return null;
  return parseInt(s, 10);
}
