import { dataPath, readJson, writeJson } from './io.js';

/**
 * 分類を確定するときの書き戻しを1か所にまとめる。
 *
 * ★なぜまとめるか
 *   同じことを `close.js`（対話）・`set-category.js`（CLI）・確定パネル（ブラウザ）の
 *   3か所が行う。立てるフィールドが1つでもずれると、
 *   「npm run review -- --all を流したら手で確定したものが消えた」という形で表に出る。
 *   消えたことに気づけるのは、その店の支出を探したときだけ。
 */

/**
 * 1件だけ確定する（商業施設のように毎回中身が違う店）。
 *
 * `manual_override` を立てるのが肝。これがある取引は `reclassify.js` が触らない。
 *
 * @returns {number} 書き換えた件数。**保存はしない**（呼び出し側が
 *   まとめて writeTransactionsByMonth する。1件ごとに保存すると月ファイルを何度も書く）
 */
export function applyOverride(transactions, match, { category, subcategory, merchant, note }) {
  let n = 0;
  for (const t of transactions) {
    if (!match(t)) continue;
    t.category = category;
    t.subcategory = subcategory || null;
    if (merchant) t.merchant = merchant;
    if (note) t.note = note;
    t.needs_review = false;
    t.confidence = 'high';
    t.manual_override = true; // 以降 reclassify で上書きされない
    n++;
  }
  return n;
}

/**
 * 要確認キューから確定するときの絞り込み。
 *
 * ★「まだ未確定のものだけ」に限ること。
 *   キーの一致だけで選ぶと、**同じ店の過去の取引まで巻き込む**。
 *   商業施設は毎回中身が違うから1件ずつ確定しているのに、
 *   6月のベビー用品を確定した拍子に3月の文具まで同じ分類に塗り替わり、
 *   しかも manual_override が付くので再分類でも戻らない。
 *   実データでも店名キーの4割近くが複数月にまたがっている。
 */
export const byKey = (key) => (t) => t.merchant_key === key && t.needs_review === true;

/** キーが一致するものすべて（過去に確定した分も含めて塗り替えたいときだけ使う） */
export const byKeyIncludingSettled = (key) => (t) => t.merchant_key === key;

/**
 * 店名ルールを追加する。
 *
 * ★配列は先勝ち。
 *   既にそのキーに当たるルールがある場合、末尾に足しても永久に効かない。
 *   （`needs_review: true` の暫定ルールを上書きしたい場合がこれに当たる）
 *   そのため、当たっている既存ルールの**直前**に挿入する。
 *
 * @param {string} key 正規化済みの店名。挿入位置の判定に使う
 * @returns {{ insertedBefore: number }} 既存ルールの前に入れたなら位置、末尾なら -1
 */
export function insertRule(rules, rule, key) {
  const idx = rules.findIndex((r) => {
    try { return new RegExp(r.pattern, 'i').test(key); } catch { return false; }
  });
  if (idx >= 0) rules.splice(idx, 0, rule);
  else rules.push(rule);
  return { insertedBefore: idx };
}

/**
 * 正規表現として使える形にする。
 *
 * ★店名をそのままパターンにすると、いつか取り込みが丸ごと止まる。
 *   パターンは `loadRules()` が `new RegExp(pattern, 'i')` に渡す。明細の店名は
 *   途中で切り詰められて届くため、閉じていない括弧で終わるキー（例 `ABC(`）が出る。
 *   それをルールにすると以降 `SyntaxError: Unterminated group` で
 *   **取り込みも再分類もビルドも起動しなくなる**。
 *
 *   正規表現として成立するならそのまま使う（`AMAZON.CO.JP` のような既存ルールや、
 *   人が意図して書いた `A|B` を壊さないため）。壊れているものだけ全体をエスケープする。
 */
export function safePattern(source) {
  try {
    new RegExp(source, 'i');
    return source;
  } catch {
    return source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

/**
 * 店名ルールを追加して `data/category_rules.json` に保存する。
 *
 * @returns {{ insertedBefore: number, rule: object }}
 */
export function addRule({ key, pattern, category, subcategory, display, isFixedCost = false }) {
  const file = readJson(dataPath('category_rules.json'), { rules: [] });
  const rule = {
    pattern: safePattern(pattern || key),
    category,
    subcategory: subcategory || null,
    display: display || null,
  };
  if (isFixedCost) rule.is_fixed_cost = true;

  const { insertedBefore } = insertRule(file.rules, rule, key);
  writeJson(dataPath('category_rules.json'), file);
  return { insertedBefore, rule };
}
