import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, readJson } from './lib/io.js';
import { acquireLock, readLock, roleName } from './lib/lock.js';
import { startPanel } from './lib/panel-server.js';
import { snapshot } from './lib/pipeline.js';

/**
 * 確定パネルだけを起動する（ウォッチャを常駐させていないとき用）。
 *
 * ウォッチャを動かしているならパネルはその中に入っているので、こちらは要らない。
 * 2つ立てると、別々のポートで同じ data/ を書く二重系になるため、
 * 在席票を見て案内だけして終わる。
 *
 * 使い方:
 *   npm run panel
 */

const held = readLock();
if (held) {
  console.log('');
  console.log(`  ${roleName(held.role)}が既に動いています（PID ${held.pid}）。`);
  console.log(`  確定パネルはそちらに入っています: http://127.0.0.1:${held.port}/`);
  console.log('');
  process.exit(0);
}

const config = readJson(join(ROOT, 'config.json'), {});
const wanted = config.panel?.port ?? 4649;

const panel = await startPanel({ port: wanted });

// ★ 在席票を取れなかったら起動しない。
//   票が無いまま動くと、`npm run close` や set-category.js からは
//   「誰も居ない」ように見え、同時に data/ を書いて片方の変更が消える。
//   上の readLock() との隙間で誰かが先に取った場合にここへ来る
const lock = acquireLock({ port: panel.port, role: 'panel' });
if (!lock) {
  panel.close();
  const now = readLock();
  console.log('');
  console.log(`  ちょうど${now ? roleName(now.role) : '別のプロセス'}が起動したため、こちらは終了します。`);
  if (now) console.log(`  そちらを使ってください: http://127.0.0.1:${now.port}/`);
  console.log('');
  process.exit(0);
}

const { pending } = snapshot();
console.log('');
console.log(`  確定パネル: http://127.0.0.1:${panel.port}/`);
console.log(pending > 0
  ? `  分類が未確定の取引が ${pending}件あります。ブラウザで確定できます。`
  : '  分類が未確定の取引はありません。');
console.log('  止めるときは Ctrl+C。');
console.log('');

if (config.panel?.open_browser) {
  spawnSync('cmd', ['/c', 'start', '', `http://127.0.0.1:${panel.port}/`], { stdio: 'ignore' });
}

const shutdown = () => {
  panel.close();
  lock.release();
  console.log('\n  確定パネルを停止しました。');
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
