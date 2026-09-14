import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { ROOT, dataPath, readJson, readAllTransactions } from './io.js';

/**
 * 取込からビルドまでの一連を1か所にまとめる。
 *
 * ★なぜ関数にするか
 *   同じ順番を `close.js`（対話つきの締め）と `watch.js`（無人の常駐ウォッチャ）が
 *   それぞれ持つと、片方にスクリプトを足したときにもう片方が漏れる。
 *   漏れても例外は出ず、ただ「その処理だけ走らない」状態になるため気づけない。
 *
 * ★例外を投げない
 *   無人実行では、落ちた場所を通知に載せる必要がある。
 *   どこで何番の終了コードで止まったかを戻り値で返す。
 */

const LABELS = {
  'import-card.js': 'カード明細を取り込む',
  'import-payslip.js': '給与明細を取り込む',
  'import-dcard.js': 'ドコモ（dカード）の請求内訳を取り込む',
  'generate-fixed.js': '固定費・定期収入を生成する',
  'build.js': 'ダッシュボードを生成する',
  'build-web.js': 'Web公開版（バックアップ）を生成する',
};

/** 取り込みと生成。ここまでで data/ が最新になる */
export const IMPORT_STEPS = ['import-card.js', 'import-payslip.js', 'import-dcard.js', 'generate-fixed.js'];

/** 出力。build-web.js は docs/index.html ＝ data/ の唯一のバックアップを作る */
export const BUILD_STEPS = ['build.js', 'build-web.js'];

export const ALL_STEPS = [...IMPORT_STEPS, ...BUILD_STEPS];

export const stepLabel = (script) => LABELS[script] ?? script;

/**
 * 指定したスクリプトを順に実行する。1つでも失敗したらそこで止める。
 *
 * @param {string[]} scripts  scripts/ 直下のファイル名
 * @param {(script: string, index: number, total: number) => void} [onStep]
 * @returns {{ ok: boolean, failedStep: string|null, exitCode: number|null, steps: object[] }}
 */
export function runPipeline(scripts, { onStep } = {}) {
  const steps = [];
  for (const [i, script] of scripts.entries()) {
    onStep?.(script, i, scripts.length);
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
      // ★ stdin は渡さない。'inherit' にすると子プロセスが親の標準入力を奪い、
      //   このあとの対話（要確認の確定・残高入力）が応答しなくなる
      stdio: ['ignore', 'inherit', 'inherit'],
      cwd: ROOT,
    });
    const code = r.status;
    steps.push({ script, code, ok: code === 0 });
    if (code !== 0) {
      return { ok: false, failedStep: script, exitCode: code, steps };
    }
  }
  return { ok: true, failedStep: null, exitCode: null, steps };
}

/**
 * docs/index.html（＝ data/ の唯一のバックアップ）の最終更新日。
 *
 * `build-web.js` は合言葉が無い・短いときに終了コード1で止まる。
 * 取込は成功し続けるため、**バックアップだけが黙って古くなる**。
 * 日付を報告に出さないと気づく手段が無い。
 *
 * @returns {{ date: string, stale: boolean }|null} 未生成なら null
 */
export function backupStatus(today = new Date().toISOString().slice(0, 10)) {
  const file = join(ROOT, 'docs', 'index.html');
  if (!existsSync(file)) return null;
  const date = new Date(statSync(file).mtime).toISOString().slice(0, 10);
  return { date, stale: date < today };
}

/**
 * 実行前後の差分を取るためのスナップショット。
 *
 * 各スクリプトの標準出力を読み取って件数を得ると、出力の書式を変えた瞬間に
 * 静かに壊れる。data/ を読み直す方が確実。
 */
export function snapshot() {
  const tx = readAllTransactions();
  const log = readJson(dataPath('import_log.json'), []);
  return {
    total: tx.length,
    pending: tx.filter((t) => t.needs_review).length,
    mismatch: log.filter((e) => e.status === 'MISMATCH').length,
  };
}
