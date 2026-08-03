/**
 * 店名の正規化。
 *
 * カード明細の店名は全角・半角カナ・伸ばし棒の揺れが激しく、
 * 同じ店が別グループとして集計されてしまう。
 * （実データ例：「クリエイト　エス　デイ－」42件 と「クリエイトエスデイ－」10件）
 *
 * 分類・集計に使う merchant_key と、表示に使う merchant を分ける。
 * merchant には原文（merchant_raw）に近い読みやすい形を残す。
 */

// NFKC 後に残るハイフン類。U+FF0D(全角ハイフンマイナス) と U+FF70(半角長音) は
// NFKC でそれぞれ U+002D と U+30FC に畳まれるため、ここには含めない。
const HYPHEN_CLASS = '\\u002D\\u2010-\\u2015\\u2212\\u2500\\u30FC';
// 直前がこれらの文字なら、ハイフンは「伸ばし棒」とみなす
const KANA_CLASS = '\\u3041-\\u309F\\u30A1-\\u30FA\\u30FC';

const KANA_HYPHEN_RE = new RegExp(`([${KANA_CLASS}])[${HYPHEN_CLASS}]`, 'g');
const SPACE_RE = /[\s　 ]+/g;

/**
 * 分類・グルーピング用のキーを生成する。
 * 1. NFKC 正規化   ＡＭＡＺＯＮ．ＣＯ．ＪＰ → AMAZON.CO.JP / ﾐｽﾞﾎ → ミズホ
 * 2. 空白をすべて除去   クリエイト　エス　デイ- → クリエイトエスデイ-
 * 3. カナ直後のハイフン類を長音「ー」に統一   クリエイトエスデイ- → クリエイトエスデイー
 *
 * 手順3を「カナ直後のみ」に限定するのが重要。無条件に変換すると
 * 「2CO.COM|CYBER-LIAMSTERDAM」のような英字のハイフンまで壊れる。
 * 大文字小文字は畳まない（分類側で i フラグ付き正規表現を使う）。
 */
export function merchantKey(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC');
  s = s.replace(SPACE_RE, '');
  // 連続したハイフンにも対応するため収束するまで適用する
  let prev;
  do { prev = s; s = s.replace(KANA_HYPHEN_RE, '$1ー'); } while (s !== prev);
  return s;
}

/**
 * 表示用の店名。NFKC で全角英数と半角カナだけ整え、
 * 語の区切りとしての空白は1つに詰めて残す（人が読むため）。
 */
export function merchantDisplay(raw) {
  if (!raw) return '';
  let s = String(raw).normalize('NFKC').replace(SPACE_RE, ' ').trim();
  let prev;
  do { prev = s; s = s.replace(KANA_HYPHEN_RE, '$1ー'); } while (s !== prev);
  return s;
}

/** 備考欄など、自由記述の軽い正規化 */
export function normalizeNote(raw) {
  if (!raw) return '';
  return String(raw).normalize('NFKC').replace(SPACE_RE, ' ').trim();
}
