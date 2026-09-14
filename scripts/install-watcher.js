import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './lib/io.js';
import { describeLock } from './lib/lock.js';
import { decodeSjis } from './lib/sjis.js';

/**
 * ログオン時にウォッチャが立ち上がるよう、タスクスケジューラへ登録する。
 *
 * ★なぜスタートアップフォルダではないのか
 *   .cmd を置くと最小化されたコンソールが residents として残り続け、
 *   .vbs（完全に隠す定番の手）は Windows から段階的に取り除かれる予定にある。
 *   タスクスケジューラなら窓が出ないうえ、状態の確認・停止・自動再起動を
 *   同じ仕組みで扱える。
 *
 * ★XML で登録する理由
 *   「落ちたら立て直す」は schtasks のコマンドライン引数では指定できない。
 *   タスク定義XMLの RestartOnFailure でしか書けないため、XMLを組み立てて渡す。
 *
 * 使い方:
 *   npm run watch:install
 *   npm run watch:status
 *   npm run watch:uninstall
 */

// タスク名はASCIIにする。日本語だと schtasks へ渡す途中の文字コードで化ける環境がある。
// 画面に出る説明は日本語にしてあるので、タスクスケジューラ上では区別できる
const TASK_NAME = 'KakeiWatcher';
const DESCRIPTION = '家計管理アプリの自動反映ウォッチャ（imports/・給与明細/・d-カード/ を監視）';

const CMD_PATH = join(ROOT, 'scripts', 'watch-run.cmd');
const LOG_REL = 'data\\watch.out.log';

/**
 * 生存確認の間隔。
 *
 * ★RestartOnFailure だけでは足りない
 *   タスク定義に書いた RestartOnFailure は、実測したところ
 *   「アクションが終了コード1で終わった」では発動しなかった（State は Ready のまま、
 *   NextRun も空）。Windows のこれは主に起動そのものに失敗した場合のもので、
 *   中で動かしたプログラムが落ちた場合には効かない。
 *
 *   そこで、この間隔でタスクを起こし直す。既に動いていれば
 *   MultipleInstancesPolicy=IgnoreNew で何も起きず、
 *   仮にすり抜けてもウォッチャ自身が在席票を見て即座に終わる。
 *   落ちていたときだけ立ち上がる。
 *
 *   最大でこの間隔ぶん反応が遅れるが、起動時に「止まっている間に置かれたファイル」を
 *   拾う仕掛けがあるので、取りこぼしにはならない。
 */
const CHECK_INTERVAL = process.env.KAKEI_WATCH_INTERVAL || 'PT30M'; // 検証時だけ環境変数で縮める

const args = process.argv.slice(2);
const mode = args.includes('--uninstall') ? 'uninstall' : args.includes('--status') ? 'status' : 'install';

/**
 * schtasks を呼ぶ。
 *
 * ★出力は CP932 で返る。`encoding: 'utf8'` で受けると日本語が化け、
 *   「状態: 実行中」を読み取る正規表現が黙って外れる（登録の有無は終了コードで分かるので
 *   気づきにくい）。Buffer で受けて、CSV 取り込みと同じデコーダを通す。
 */
const schtasks = (params) => {
  const r = spawnSync('schtasks', params, { windowsHide: true });
  return {
    status: r.status,
    stdout: r.stdout ? decodeSjis(r.stdout) : '',
    stderr: r.stderr ? decodeSjis(r.stderr) : '',
  };
};

// ---------------------------------------------------------------- status

if (mode === 'status') {
  const q = schtasks(['/query', '/tn', TASK_NAME, '/fo', 'list']);
  const registered = q.status === 0;
  console.log('');
  console.log(`  タスク登録   ${registered ? '登録済み（ログオン時に起動）' : '未登録（npm run watch:install で登録できます）'}`);
  if (registered) {
    const state = (q.stdout.match(/^(?:状態|Status):\s*(.+)$/m) ?? [])[1];
    if (state) console.log(`  タスクの状態 ${state.trim()}`);
  }
  console.log(`  ウォッチャ   ${describeLock().text}`);
  console.log('');
  process.exit(0);
}

// ---------------------------------------------------------------- uninstall

if (mode === 'uninstall') {
  const r = schtasks(['/delete', '/tn', TASK_NAME, '/f']);
  if (r.status === 0) {
    rmSync(CMD_PATH, { force: true });
    console.log('\n  登録を解除しました。次回のログオンからは自動で起動しません。');
    console.log('  今動いているウォッチャは止まりません（止めるときはタスクマネージャか PC の再起動で）。\n');
  } else {
    console.log(`\n  登録が見つかりませんでした（${(r.stderr || r.stdout).trim()}）\n`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------- install

// ラッパーを挟む。長いコマンドを /tr に直接書くと引用符の扱いで壊れる
const cmd = [
  '@echo off',
  `cd /d "${ROOT}"`,
  'rem ログが 1MB を超えたら1世代だけ退避する（無限に伸ばさない）',
  `if exist "${LOG_REL}" for %%F in ("${LOG_REL}") do if %%~zF GTR 1048576 move /y "${LOG_REL}" "${LOG_REL}.1" >nul`,
  `"${process.execPath}" "${join(ROOT, 'scripts', 'watch.js')}" >> "${LOG_REL}" 2>&1`,
  '',
].join('\r\n');
writeFileSync(CMD_PATH, cmd, 'utf8');

const user = `${process.env.USERDOMAIN ?? process.env.COMPUTERNAME}\\${process.env.USERNAME}`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${esc(DESCRIPTION)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${esc(user)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>${esc(CHECK_INTERVAL)}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${esc(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(CMD_PATH)}</Command>
      <WorkingDirectory>${esc(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;

// schtasks /xml は UTF-16LE（BOM つき）しか受け付けない
const xmlPath = join(ROOT, 'scripts', '.watch-task.xml');
writeFileSync(xmlPath, '﻿' + xml, 'utf16le');

const r = schtasks(['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f']);
rmSync(xmlPath, { force: true });

console.log('');
if (r.status === 0) {
  console.log(`  登録しました（タスク名: ${TASK_NAME}）。`);
  console.log('  次にログオンしたときから、ウォッチャが自動で立ち上がります。');
  console.log(`  落ちていないかを ${CHECK_INTERVAL.replace('PT', '').toLowerCase()} ごとに見て、`
    + '止まっていれば立て直します。コンソールの窓は出ません。');
  console.log('');
  console.log(`  ログ: ${join(ROOT, LOG_REL)}`);
  console.log('  状態: npm run watch:status');
  console.log('  解除: npm run watch:uninstall');
  console.log('');
  console.log('  ※ 今すぐ動かすなら npm run watch（この窓で動きます）。');
} else {
  console.error('  登録できませんでした。');
  console.error(`  ${(r.stderr || r.stdout).trim()}`);
  if (!existsSync(CMD_PATH)) console.error('  ラッパー（scripts/watch-run.cmd）の作成にも失敗しています。');
  process.exitCode = 1;
}
console.log('');
