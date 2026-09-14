import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './io.js';

/**
 * 常駐ウォッチャの在席票（`.watch.lock`）。
 *
 * ★何のためにあるか
 *   ウォッチャ・確定パネル・`npm run close` の3つは、どれも
 *   「data/ を読む → 変える → 書き戻す」を行う。同時に走ると、後から書いた方が
 *   相手の変更を黙って消す（ファイルが壊れるわけではないので気づけない）。
 *   そこで「今ウォッチャが動いているか」を1か所で判定できるようにする。
 *
 * ★PIDの生存確認だけでは足りない
 *   PIDは使い回される。ウォッチャが落ちたあと別のプロセスが同じ番号を取ると
 *   「動いている」と誤判定し、二度と起動できなくなる。
 *   そこで1分ごとに鼓動（beatAt）を打ち、その鮮度と併せて見る。
 */

export const LOCK_PATH = join(ROOT, '.watch.lock');

/** 鼓動の間隔。これを過ぎても更新が無ければ、そのうち「死んでいる」と見なされる */
export const BEAT_INTERVAL_MS = 60_000;

/** 鼓動がこれより古ければ死んでいると判断する。間隔の3倍（一時的な高負荷で誤判定しない幅） */
export const BEAT_STALE_MS = 3 * 60_000;

function readRaw() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    const v = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
    return v && typeof v.pid === 'number' ? v : null;
  } catch {
    // 壊れた在席票は無いものとして扱う（書き込み中に電源が落ちた場合など）
    return null;
  }
}

function pidAlive(pid) {
  try {
    // シグナル0は「送らずに存在だけ確かめる」。権限が無い場合は EPERM ＝ 存在はする
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** 在席票が今も有効か。PIDが生きていて、かつ鼓動が新しいこと */
export function isAlive(lock, now = Date.now()) {
  if (!lock) return false;
  if (!pidAlive(lock.pid)) return false;
  const beat = Date.parse(lock.beatAt ?? lock.startedAt ?? '');
  if (Number.isNaN(beat)) return false;
  return now - beat < BEAT_STALE_MS;
}

/**
 * 生きているウォッチャの在席票を返す。誰も居なければ null。
 * 自分自身が持ち主のときも null を返す（自分と競合はしない）。
 */
export function readLock({ ignoreSelf = true } = {}) {
  const lock = readRaw();
  if (!lock) return null;
  if (ignoreSelf && lock.pid === process.pid) return null;
  return isAlive(lock) ? lock : null;
}

/** パイプライン実行中かどうか（在席票の busy 欄）。パネルはこの間 409 を返す */
export function isBusy() {
  const lock = readRaw();
  return isAlive(lock) && lock.busy === true;
}

/**
 * 在席票を取る。既に生きた在席票があれば null を返す（起動を諦める側が案内を出す）。
 *
 * 死んだ在席票は奪う。PCの強制終了で残った票のせいで二度と起動できない、
 * という状態を避けるため。
 *
 * @returns {{ release: () => void, setBusy: (v: boolean) => void, port: number }|null}
 */
export function acquireLock({ port = null, role = 'watch' } = {}) {
  const existing = readLock();
  if (existing) return null;

  // role は「今 data/ を握っているのが誰か」を人に伝えるためだけのもの。
  // 排他の強さは変えない（パネル単体でも close とは同時に走らせない）
  const state = { pid: process.pid, role, startedAt: new Date().toISOString(), port, busy: false };
  const flush = () => {
    state.beatAt = new Date().toISOString();
    try {
      writeFileSync(LOCK_PATH, JSON.stringify(state, null, 2) + '\n', 'utf8');
    } catch { /* 書けなくても本体は動かす。次の鼓動で復帰する */ }
  };
  flush();

  const timer = setInterval(flush, BEAT_INTERVAL_MS);
  // ★ 鼓動でプロセスを生かし続けない。他に仕事が無くなれば終われるようにする
  timer.unref?.();

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    try {
      // 自分の票のときだけ消す（奪われた後に他人の票を消さない）
      const now = readRaw();
      if (now?.pid === process.pid) rmSync(LOCK_PATH, { force: true });
    } catch { /* 消せなくても、鼓動が止まればそのうち死票と判定される */ }
  };

  return {
    port,
    release,
    setBusy: (v) => { state.busy = v === true; flush(); },
    // パネルのポートは listen してみるまで確定しない（使用中なら1つずれる）ので後から入れる
    setPort: (v) => { state.port = v; flush(); },
  };
}

/** `watch:status` 用。登録の有無に関わらず「今生きているか」を人が読める形で返す */
export function describeLock(now = Date.now()) {
  const lock = readRaw();
  if (!lock) return { alive: false, text: '停止中（在席票なし）' };
  const beat = Date.parse(lock.beatAt ?? lock.startedAt ?? '');
  const ago = Number.isNaN(beat) ? null : Math.round((now - beat) / 1000);
  if (!isAlive(lock, now)) {
    return { alive: false, lock, text: `停止中（最終鼓動 ${ago === null ? '不明' : agoText(ago)}）` };
  }
  return {
    alive: true,
    lock,
    text: `${roleName(lock.role)}が動作中（PID ${lock.pid}／鼓動 ${agoText(ago)}／http://127.0.0.1:${lock.port}/）`,
  };
}

export const roleName = (role) => (role === 'panel' ? '確定パネル' : 'ウォッチャ');

function agoText(sec) {
  if (sec < 60) return `${sec}秒前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分前`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}時間前`;
  return `${Math.floor(sec / 86400)}日前`;
}
