import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, yen } from './lib/io.js';
import { parseDcard } from './lib/parse-dcard.js';

/**
 * d-カード/*.txt（ドコモのご利用料金内訳）を取り込み、
 * data/dcard_bills.json に「利用月ごとの実額」として記録する。
 *
 * ★ ここでは取引を作らない。
 *   dカードは明細CSVを取り込んでいないため、固定費マスタ（fc_docomo）から
 *   generate-fixed.js が毎月の取引を生成している。二重計上を避けるため、
 *   このスクリプトは「生成に使う実額」を用意するだけにしてある。
 *   実額が無い月は、これまで通り fixed_costs.json の amount（概算）が使われる。
 *
 * ★ 電話番号は保存しない（parse-dcard.js が回線数だけ数えて捨てている）。
 *
 * 検算：回線ごとの金額の合計 ＝ 合計欄。
 *   カード明細と同じく、合わなくても中止せず警告して続行する。
 */

const SRC = join(ROOT, 'd-カード');

function main() {
  if (!existsSync(SRC)) {
    console.log('d-カード/ がありません。ドコモの請求内訳を置いてから再実行してください。');
    return;
  }
  const files = readdirSync(SRC).filter((f) => f.toLowerCase().endsWith('.txt')).sort();
  if (files.length === 0) {
    console.log('d-カード/ に .txt がありません。');
    return;
  }

  const config = readJson(join(ROOT, 'config.json'), {});
  const startMonth = config?.analysis?.start_month ?? null;
  const today = new Date().toISOString().slice(0, 10);
  const bills = readJson(dataPath('dcard_bills.json'), []);

  let mismatches = 0, excluded = 0;
  console.log('');

  for (const file of files) {
    const p = parseDcard(join(SRC, file), today);

    if (!p.usageMonth) {
      console.log(`  ${file}  ⚠ ファイル名から利用月を読めませんでした（例: 7月（8月請求分）.txt）`);
      continue;
    }
    if (startMonth && p.usageMonth < startMonth) {
      excluded++;
      console.log(`  ${file}  期間外（${p.usageMonth}）としてスキップ`);
      continue;
    }

    const ok = p.diff === 0;
    if (!ok) mismatches++;

    const entry = {
      usage_month: p.usageMonth,
      billing_month: p.billingMonth,
      amount: p.amount,
      line_sum: p.lineSum,
      lines: p.lineCount,
      diff: p.diff,
      status: ok ? 'OK' : 'MISMATCH',
      breakdown: p.breakdown,
      one_time: p.oneTime,
      file,
      imported_at: today,
    };
    const i = bills.findIndex((b) => b.usage_month === p.usageMonth);
    if (i >= 0) bills[i] = entry; else bills.push(entry);

    const status = ok
      ? `検算 OK`
      : `検算 ⚠不一致 (合計 ${yen(p.amount)} / 回線計 ${yen(p.lineSum)})`;
    const one = p.oneTime.length ? `  一時費用 ${p.oneTime.map((o) => o.name).join('・')}` : '';
    console.log(`  ${file}  ${p.usageMonth}分  ${String(yen(p.amount)).padStart(10)}  回線 ${p.lineCount}  ${status}${one}`);
  }

  bills.sort((a, b) => a.usage_month.localeCompare(b.usage_month));
  writeJson(dataPath('dcard_bills.json'), bills);

  console.log('  ' + '─'.repeat(76));
  console.log(`  実額のある月 ${bills.length}ヶ月（${bills[0]?.usage_month ?? '-'} 〜 ${bills[bills.length - 1]?.usage_month ?? '-'}）`);
  if (excluded > 0) console.log(`  期間外として除外 ${excluded}件（analysis.start_month = ${startMonth}）`);
  if (mismatches > 0) console.log(`  ⚠ 検算不一致 ${mismatches}ファイル（取り込みは継続。data/dcard_bills.json を確認してください）`);
  console.log(`  ※ 実額のない月は data/fixed_costs.json の概算が使われます（npm run generate で反映）`);
  console.log('');
}

main();
