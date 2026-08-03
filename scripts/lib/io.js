import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
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
