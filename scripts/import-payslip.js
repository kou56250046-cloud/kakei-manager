import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, dataPath, readJson, writeJson, yen } from './lib/io.js';
import { parsePayslip } from './lib/parse-payslip.js';

/**
 * 給与明細PDF を取り込んで data/incomes.json を更新する。
 *
 * 献金は「手取り（差引支給額）の1/10」で計算するため、net_amount が必須。
 * gross_amount（支給合計）は記録用に併せて保持する。
 *
 * 「拠出金」など、天引きされるが自分の資産として残る控除は
 * savings_deduction に切り出しておき、config.json の
 * add_back_savings_deduction で献金対象へ戻すかを切り替えられるようにする。
 */

const PAYSLIP_DIR = join(ROOT, '給与明細');
const DEFAULT_DEPOSIT_ACCOUNT = 'mizuho_main';

// 「天引きされるが自分の資産として残る」項目（仕様書 7.1 の論点A）
const SAVINGS_DEDUCTION_KEYS = /拠出金|財形|持株|社内預金/;

function main() {
  if (!existsSync(PAYSLIP_DIR)) {
    console.log(`給与明細フォルダがありません: ${PAYSLIP_DIR}`);
    return;
  }
  const files = readdirSync(PAYSLIP_DIR).filter((f) => f.toLowerCase().endsWith('.pdf')).sort();
  if (files.length === 0) {
    console.log('給与明細/ に PDF がありません。');
    return;
  }

  const incomes = readJson(dataPath('incomes.json'), []);
  const byId = new Map(incomes.map((i) => [i.id, i]));
  let added = 0, updated = 0, warned = 0;

  console.log('');
  for (const file of files) {
    let p;
    try {
      p = parsePayslip(join(PAYSLIP_DIR, file));
    } catch (e) {
      console.log(`  ⚠ ${file}  読み取り失敗: ${e.message}`);
      warned++;
      continue;
    }

    // 支給内訳のうち「自分の資産として積み立てられる」控除額を拾う
    let savings = 0;
    for (const [k, v] of Object.entries(p.deductions)) {
      if (SAVINGS_DEDUCTION_KEYS.test(k) && typeof v === 'number') savings += v;
    }
    for (const [k, v] of Object.entries(p.earnings)) {
      // 選択制DCでは「拠出金」が支給欄にマイナス計上されることがある
      if (SAVINGS_DEDUCTION_KEYS.test(k) && typeof v === 'number' && v < 0) savings += -v;
    }

    const id = `inc_${p.month}_salary`;
    const record = {
      id,
      date: p.payDate,
      name: '給与',
      period_month: p.periodMonth,
      period_start: p.periodStart,
      period_end: p.periodEnd,
      gross_amount: p.grossTotal,
      net_amount: p.netAmount,
      other_amount: p.otherTotal,
      savings_deduction: savings,
      deposit_account_id: byId.get(id)?.deposit_account_id ?? DEFAULT_DEPOSIT_ACCOUNT,
      is_tithe_target: byId.get(id)?.is_tithe_target ?? true,
      tithe_base: 'net',
      source: 'payslip',
      source_file: file,
      detail: { earnings: p.earnings, deductions: p.deductions, others: p.others },
    };

    const checks = p.checks;
    const allOk = checks.netMatches && checks.earningsMatches && checks.deductionsMatches;
    if (!allOk) warned++;

    if (byId.has(id)) updated++; else added++;
    byId.set(id, record);

    const mark = allOk ? '検算 OK ' : '検算 ⚠不一致';
    const other = p.otherTotal ? ` − その他 ${String(p.otherTotal).padStart(7)}` : '';
    console.log(
      `  ${file}  ${p.payDate} 支給（${p.periodMonth}分）  ` +
      `支給 ${String(p.grossTotal).padStart(7)} − 控除 ${String(p.deductionTotal).padStart(6)}${other} = 手取り ${String(p.netAmount).padStart(7)}  ${mark}`,
    );
    if (!allOk) {
      console.log(`      内訳: 差引=${checks.netMatches} 支給内訳=${checks.earningsMatches}(${checks.earningsSum}) 控除内訳=${checks.deductionsMatches}(${checks.deductionsSum})`);
    }
    if (savings > 0) {
      console.log(`      天引き積立 ${yen(savings)} を検出（config.json の add_back_savings_deduction で献金対象に戻せます）`);
    }
  }

  const list = [...byId.values()].sort((a, b) => a.date.localeCompare(b.date));
  writeJson(dataPath('incomes.json'), list);

  const totalNet = list.reduce((a, i) => a + (i.net_amount ?? 0), 0);
  console.log('  ' + '─'.repeat(76));
  console.log(`  収入 ${list.length}件（新規 ${added} / 更新 ${updated}） 手取り合計 ${yen(totalNet)}`);
  if (warned > 0) console.log(`  ⚠ ${warned}件で検算不一致または読み取り失敗がありました`);
  console.log('');
}

main();
