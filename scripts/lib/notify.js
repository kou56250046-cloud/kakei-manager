import { spawnSync } from 'node:child_process';

/**
 * Windows のトースト通知。
 *
 * ★依存パッケージを足さない
 *   BurntToast のようなモジュールは入れず、Windows が最初から持っている
 *   WinRT の通知APIを PowerShell 経由で叩く。
 *
 * ★日本語はスクリプトに埋め込まず、環境変数で渡す
 *   PowerShell 5.1 は標準入力を ANSI で読むため、スクリプト本文に日本語を書くと化ける。
 *   環境変数なら Unicode のまま渡る。加えて、店名に含まれる記号（' " $ ` 等）で
 *   スクリプトが壊れる事故も同時に防げる。
 *   → 下の PS_SCRIPT は ASCII のみで書くこと。
 *
 * ★通知の失敗でウォッチャを止めない
 *   通知が出ないことより、取り込みが止まる方が損害が大きい。
 *   失敗したら同じ内容をコンソールに出して false を返すだけにする。
 */

// 通知の送り主。PowerShell 自身の AppId を借りる（独自に登録しなくても表示できる）
const DEFAULT_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

// ASCII のみ。値はすべて $env: 経由で受け取り、XML に入れる前にエスケープする
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime]
$title = [System.Security.SecurityElement]::Escape($env:KAKEI_TOAST_TITLE)
$line1 = [System.Security.SecurityElement]::Escape($env:KAKEI_TOAST_LINE1)
$line2 = [System.Security.SecurityElement]::Escape($env:KAKEI_TOAST_LINE2)
$xml = '<toast><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $line1 + '</text><text>' + $line2 + '</text></binding></visual></toast>'
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml($xml)
$toast = New-Object Windows.UI.Notifications.ToastNotification $doc
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:KAKEI_TOAST_APPID).Show($toast)
`;

/**
 * @param {string} title  1行目（太字で出る）
 * @param {string[]} lines 本文。3行目までしか出ないので2要素までに収める
 * @returns {boolean} 通知できたか
 */
export function notify(title, lines = [], { appId = DEFAULT_APP_ID, timeout = 15_000 } = {}) {
  const [line1 = '', line2 = ''] = lines;
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
    input: PS_SCRIPT,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      KAKEI_TOAST_TITLE: title,
      KAKEI_TOAST_LINE1: line1,
      KAKEI_TOAST_LINE2: line2,
      KAKEI_TOAST_APPID: appId,
    },
  });

  const ok = r.status === 0 && !r.error;
  if (!ok) {
    // 出せなかった内容は必ずコンソールに残す。黙って消えるのが一番困る
    console.log(`  [通知] ${title}`);
    for (const l of [line1, line2].filter(Boolean)) console.log(`         ${l}`);
    const why = r.error?.message ?? (r.stderr || '').trim().split('\n')[0] ?? `終了コード ${r.status}`;
    console.log(`         （通知は出せませんでした: ${why}）`);
  }
  return ok;
}
