import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const DATA = join(ROOT, 'data');
export const TX_DIR = join(DATA, 'transactions');

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return fallback;
  return JSON.parse(text);
}

/**
 * JSON を書く。
 *
 * ★ 同じ場所へ直接書かず、`.tmp` に書いてから rename で差し替える。
 *   直接書くと、書き込みの途中で止まった（強制終了・電源断）ときに
 *   中途半端なJSONがその場に残り、次回の readJson が例外を投げて全部止まる。
 *   同一ボリューム内の rename は不可分なので、この経路なら
 *   「古いまま」か「新しい内容」のどちらかにしかならない。
 *
 *   常駐ウォッチャと確定パネルから書く回数が増えたため、
 *   中断に当たる確率が上がっている。
 */
export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, path);
  } catch (e) {
    // 失敗したら .tmp を残さない。残すと次回の書き込みで古い残骸を掴む
    try { rmSync(tmp, { force: true }); } catch { /* 消せなくても本来の例外を優先する */ }
    throw e;
  }
}

export function dataPath(...parts) {
  return join(DATA, ...parts);
}

/** data/transactions/*.json をすべて読み、1つの配列にして返す */
export function readAllTransactions() {
  if (!existsSync(TX_DIR)) return [];
  const out = [];
  for (const f of readdirSync(TX_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const arr = readJson(join(TX_DIR, f), []);
    if (Array.isArray(arr)) out.push(...arr);
  }
  return out;
}

/** 取引配列を利用日(date)ベースで月別ファイルに書き分ける */
export function writeTransactionsByMonth(transactions) {
  const byMonth = new Map();
  for (const t of transactions) {
    const m = t.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(t);
  }
  for (const [m, list] of byMonth) {
    list.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    writeJson(join(TX_DIR, `${m}.json`), list);
  }
  return [...byMonth.keys()].sort();
}

export const yen = (n) => (n ?? 0).toLocaleString('ja-JP') + '円';
