import { readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, DATA, TX_DIR, dataPath, readJson, writeJson, readAllTransactions, writeTransactionsByMonth, yen } from './lib/io.js';
import { parseMeisai } from './lib/parse-meisai.js';
import { merchantKey, merchantDisplay, normalizeNote } from './lib/normalize.js';
import { loadRules, classify, buildHistory } from './lib/classify.js';

/**
 * imports/*.csv を取り込んで data/transactions/YYYY-MM.json を更新する。
 *
 * ・重複は id で除去する（同じCSVを何度読んでも増えない）
 * ・検算が合わなくても中止せず、警告して続行する
 *   （返品行やポイント充当で実際にズレ得るため、止めると運用が破綻する）
 * ・口座番号・名義人は parse-meisai.js の時点で読み捨てている
 */

const IMPORTS = join(ROOT, 'imports');
const CARD_ID = 'aeon_gold';

function main() {
  if (!existsSync(IMPORTS)) {
    console.error(`imports/ がありません: ${IMPORTS}`);
    process.exit(1);
  }
  const files = readdirSync(IMPORTS).filter((f) => f.toLowerCase().endsWith('.csv')).sort();
  if (files.length === 0) {
    console.log('imports/ に CSV がありません。カード明細を置いてから再実行してください。');
    return;
  }

  const config = readJson(join(ROOT, 'config.json'), {});
  // この月より前の利用日は取り込まない。
  // 期間の先頭の月はカードの締め日の関係で必ず一部しか含まれず、
  // 収支として成立しないため（理由は config.json の analysis._note を参照）。
  const startMonth = config?.analysis?.start_month ?? null;

  const existing = readAllTransactions().filter(
    (t) => !startMonth || t.date.slice(0, 7) >= startMonth,
  );
  const byId = new Map(existing.map((t) => [t.id, t]));
  const rules = loadRules();
  const history = buildHistory(existing);
  const importLog = readJson(dataPath('import_log.json'), []);
  const today = new Date().toISOString().slice(0, 10);

  let totalNew = 0, totalSkip = 0, totalExcluded = 0, mismatches = 0;

  console.log('');
  for (const file of files) {
    const parsed = parseMeisai(join(IMPORTS, file));
    const seq = new Map();
    let added = 0, skipped = 0, excluded = 0;

    for (const row of parsed.rows) {
      // ※ 検算（parse-meisai 側）は明細の全行で行っており、
      //    ここでの除外は検算結果に影響しない
      if (startMonth && row.date.slice(0, 7) < startMonth) { excluded++; continue; }
      const key = merchantKey(row.merchantRaw);
      // 同日・同店・同額が複数あり得るため、グループ内連番で一意化する。
      // CSVを跨いでも同じ取引には同じ id が振られ、重複計上を防げる。
      const base = `${row.date.replace(/-/g, '')}-${key}-${row.amount}`;
      const n = seq.get(base) ?? 0;
      seq.set(base, n + 1);
      const id = `${base}-${n}`;

      if (byId.has(id)) { skipped++; continue; }

      const c = classify(key, rules, history);
      byId.set(id, {
        id,
        date: row.date,
        billing_month: parsed.billingMonth,
        billing_date: parsed.paymentDate,
        amount: row.amount,
        type: row.amount < 0 ? 'refund' : 'expense',
        category: c.category,
        subcategory: c.subcategory,
        merchant_raw: row.merchantRaw,
        merchant: c.display ?? merchantDisplay(row.merchantRaw),
        merchant_key: key,
        source: 'card',
        account_id: CARD_ID,
        card_holder: row.cardHolder,
        payment_method: row.paymentMethod,
        is_fixed_cost: c.is_fixed_cost,
        fixed_cost_id: null,
        note: normalizeNote(row.noteRaw),
        confidence: c.confidence,
        needs_review: c.needs_review,
      });
      added++;
    }

    const ok = parsed.diff === 0;
    if (!ok) mismatches++;
    totalNew += added; totalSkip += skipped; totalExcluded += excluded;

    const status = ok
      ? `検算 OK  (${yen(parsed.billed)})`
      : `検算 ⚠不一致 (請求 ${yen(parsed.billed)} / 明細 ${yen(parsed.detailSum)} / 差 ${parsed.diff > 0 ? '+' : ''}${parsed.diff.toLocaleString('ja-JP')}円)`;
    const exc = excluded > 0 ? ` / 期間外 ${String(excluded).padStart(2)}件` : '';
    console.log(`  ${file}  新規 ${String(added).padStart(3)}件 / スキップ ${String(skipped).padStart(3)}件${exc} / ${status}`);

    // 明細がカバーする利用日の範囲。どの月が「明細で全日そろっているか」の判定に使う
    const dates = parsed.rows.map((r) => r.date).sort();
    const entry = {
      file,
      billing_month: parsed.billingMonth,
      payment_date: parsed.paymentDate,
      billed: parsed.billed,
      detail_sum: parsed.detailSum,
      installment_sum: parsed.installmentSum,
      diff: parsed.diff,
      status: ok ? 'OK' : 'MISMATCH',
      rows: parsed.rows.length,
      usage_from: dates[0] ?? null,
      usage_to: dates[dates.length - 1] ?? null,
      excluded: excluded,
      imported_at: today,
    };
    const i = importLog.findIndex((e) => e.file === file);
    if (i >= 0) importLog[i] = entry; else importLog.push(entry);
  }

  const all = [...byId.values()];
  // 除外対象になった月のファイルが残っていると集計に混ざるため消す
  if (startMonth && existsSync(TX_DIR)) {
    for (const f of readdirSync(TX_DIR).filter((f) => f.endsWith('.json'))) {
      if (f.slice(0, 7) < startMonth) rmSync(join(TX_DIR, f));
    }
  }
  const months = writeTransactionsByMonth(all);
  importLog.sort((a, b) => (a.billing_month ?? '').localeCompare(b.billing_month ?? ''));
  writeJson(dataPath('import_log.json'), importLog);

  const review = all.filter((t) => t.needs_review);
  const total = all.reduce((a, t) => a + t.amount, 0);

  console.log('  ' + '─'.repeat(76));
  console.log(`  合計 ${all.length}件 / ${yen(total)} / 対象月 ${months[0]}〜${months[months.length - 1]}`);
  console.log(`  新規 ${totalNew}件 / スキップ ${totalSkip}件 / 要確認 ${review.length}件`);
  if (totalExcluded > 0) {
    console.log(`  期間外として除外 ${totalExcluded}件（config.json の analysis.start_month = ${startMonth} より前の利用日）`);
  }
  if (mismatches > 0) {
    console.log(`  ⚠ 検算不一致 ${mismatches}ファイル（取り込みは継続。data/import_log.json を確認してください）`);
  }
  if (review.length > 0) {
    console.log('\n  要確認の取引（npm run review で確定できます）:');
    const grouped = new Map();
    for (const t of review) {
      const g = grouped.get(t.merchant_key) ?? { n: 0, sum: 0, merchant: t.merchant };
      g.n++; g.sum += t.amount; grouped.set(t.merchant_key, g);
    }
    for (const [key, g] of [...grouped].sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`    ${String(g.sum).padStart(8)}円 ${String(g.n).padStart(3)}件  ${g.merchant}  [${key}]`);
    }
  }
  console.log('');
}

main();
