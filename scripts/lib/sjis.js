import { readFileSync } from 'node:fs';

// Node 20+ 同梱の full-icu により 'shift_jis' ラベルが使える。
// WHATWG の 'shift_jis' は実質 Windows-31J (CP932) なので、
// イオンカードの明細CSVに含まれる機種依存文字も正しく復号できる。
const decoder = new TextDecoder('shift_jis');

/** Shift_JIS のファイルを読み、CRLF を LF に正規化した行配列で返す */
export function readSjisLines(path) {
  const text = decoder.decode(readFileSync(path));
  return text.replace(/\r\n/g, '\n').split('\n');
}

/**
 * Shift_JIS(CP932) のバイト列を文字列にする。
 *
 * Windows のコマンド（schtasks など）は日本語環境で CP932 を吐く。
 * `spawnSync` に `encoding: 'utf8'` を渡すと化けて、出力を読み取る処理が黙って外れる。
 */
export function decodeSjis(buffer) {
  return decoder.decode(buffer);
}

/**
 * CSVの1行をフィールド配列に分割する。
 * イオンの明細はクォートを使わない単純な形式だが、
 * 店名に , が入る可能性に備えてダブルクォートも解釈する。
 */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuote = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
