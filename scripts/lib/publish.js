import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, readJson } from './io.js';
import { notify } from './notify.js';

/**
 * 公開版（docs/）を自動でコミットし、origin/main へプッシュする。
 *
 * ★なぜ要るか
 *   ウォッチャと確定パネルは docs/index.html まで作り直すが、プッシュしないと
 *   GitHub Pages の公開版（スマホで見る方）は古いままになる。
 *   また docs/index.html は data/ の唯一のバックアップなので、
 *   プッシュされるまでは PC と一緒に失われる。
 *
 * ★漏らさないための約束（リポジトリは public）
 *   1. コミットするのは ALLOWLIST のファイルだけ。`git commit -- <paths>` で呼ぶので、
 *      人が作業中の変更がインデックスにあっても巻き込まない
 *   2. 未プッシュのコミットに ALLOWLIST 以外のパスが1つでもあれば、プッシュしない（blocked）。
 *      人の作業途中のコミットを無人で公開しない
 *   3. コミットメッセージは定型文だけ。件数やファイル名（給与明細は氏名入り）を入れない
 *   4. pull / rebase はしない。リモートが先行していれば失敗として知らせ、人が直す
 *
 * ★止まらないための約束
 *   git は spawn で非同期に呼ぶ（spawnSync だと鼓動と確定パネルが止まる）。
 *   対話を禁止し、1回ごとにタイムアウトを付ける。認証ダイアログは画面に出ないため、
 *   待つと永久に止まる。
 */

export const ALLOWLIST = [
  'docs/index.html',
  'docs/sw.js',
  'docs/manifest.webmanifest',
  'docs/icon-192.png',
  'docs/icon-512.png',
  'docs/apple-touch-icon.png',
];

const MESSAGES = {
  import: '自動反映（取込）',
  classify: '自動反映（分類の確定）',
  balance: '自動反映（残高）',
  catchup: '自動反映（未反映分）',
};

const GIT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------- 作業ツリーの鍵

/**
 * docs/ を書く側（取り込み〜ビルド）と、git add〜commit する側を重ねない。
 *
 * build-web.js が書いている途中に git add が走ると、書きかけのファイルをコミットし得る。
 * プッシュは作業ツリーを読まないので、鍵の外で走らせてよい。
 */
let worktree = Promise.resolve();
let committing = false;

/** 鍵を取る。返り値の関数を呼ぶと手放す */
export async function holdWorktree() {
  let release;
  const next = new Promise((r) => { release = r; });
  const prev = worktree;
  worktree = prev.then(() => next);
  await prev;
  return release;
}

/** git add〜commit の最中か。確定パネルはこの間だけ書き込みを断る */
export const isCommitting = () => committing;

// ---------------------------------------------------------------- git

function git(args, { root, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };

    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => finish({ code: -1, stdout, stderr: String(e?.message ?? e) }));
    // ★ 'close' ではなく 'exit' で終える。push は git-remote-https を子に持ち、
    //   それが標準出力を握ったままだと 'close' が来ない
    child.on('exit', (code) => finish({ code, stdout, stderr }));

    const timer = setTimeout(() => {
      // 子プロセスごと落とす。git.exe だけ殺すと git-remote-https が残って資格情報を待ち続ける
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => {});
      } else {
        child.kill('SIGKILL');
      }
      finish({ code: -1, stdout, stderr: `git ${args[0]} が ${Math.round(timeoutMs / 1000)}秒で応答しませんでした` });
    }, timeoutMs);
  });
}

/**
 * 通知に載せる1行。git の失敗文は複数行で、最後の行は
 * 「and the repository exists.」のような続きの文なので、原因の行を優先する
 */
const lastLine = (s) => {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => /^(fatal|error):|\[rejected\]/.test(l)) ?? lines.pop() ?? '';
};

// ---------------------------------------------------------------- 本体

let chain = Promise.resolve();

/**
 * 公開を1回走らせる。呼び出しは直列化され、前の公開（プッシュ含む）が終わってから始まる。
 *
 * @param {'import'|'classify'|'balance'|'catchup'} reason
 * @param {object} [opts]
 * @param {string} [opts.root]       リポジトリの場所（検証用。既定は本リポジトリ）
 * @param {number} [opts.timeoutMs]  git 1回ごとの上限
 * @returns {{ committed: Promise<void>, result: Promise<{status: string, detail?: string}> }}
 *
 * ★ 呼び出し側は作業ツリーの鍵を持ったまま呼ばないこと。
 *   先に並んでいる公開がその鍵を待っていると、互いに待ち合って止まる。
 */
export function startPublish(reason, { root = ROOT, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  let markCommitted;
  const committed = new Promise((r) => { markCommitted = r; });

  const run = async () => {
    let unlock = null;
    try {
      const config = readJson(join(root, 'config.json'), {});
      if (config.publish?.auto_push !== true) return { status: 'disabled' };

      const opt = { root, timeoutMs };
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], opt);
      if (head.code !== 0) return { status: 'commit_failed', detail: lastLine(head.stderr) };
      if (head.stdout.trim() !== 'main') return { status: 'not_main', detail: head.stdout.trim() };

      // ---- コミット区間
      unlock = await holdWorktree();
      committing = true;
      try {
        const paths = ALLOWLIST.filter((p) => existsSync(join(root, p)));
        if (paths.length > 0) {
          const add = await git(['add', '--', ...paths], opt);
          if (add.code !== 0) return { status: 'commit_failed', detail: lastLine(add.stderr) };
          const diff = await git(['diff', '--cached', '--quiet', '--', ...paths], opt);
          if (diff.code === 1) {
            const c = await git(['commit', '-m', MESSAGES[reason] ?? MESSAGES.catchup, '--', ...paths], opt);
            if (c.code !== 0) return { status: 'commit_failed', detail: lastLine(c.stderr) || lastLine(c.stdout) };
          } else if (diff.code !== 0) {
            return { status: 'commit_failed', detail: lastLine(diff.stderr) };
          }
        }
      } finally {
        committing = false;
        unlock();
        unlock = null;
        markCommitted();
      }

      // ---- プッシュ区間（作業ツリーは触らない）
      const log = await git(['log', '--format=', '--name-only', 'origin/main..HEAD'], opt);
      if (log.code !== 0) return { status: 'push_failed', detail: lastLine(log.stderr) };
      const changed = [...new Set(log.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))];
      const unpushed = await git(['rev-list', '--count', 'origin/main..HEAD'], opt);
      if (unpushed.code !== 0) return { status: 'push_failed', detail: lastLine(unpushed.stderr) };
      if (Number(unpushed.stdout.trim()) === 0) return { status: 'no_change' };

      const outside = changed.filter((p) => !ALLOWLIST.includes(p));
      if (outside.length > 0) return { status: 'blocked', detail: `${outside.length}件のパス` };

      const push = await git(['push', 'origin', 'main'], opt);
      if (push.code !== 0) return { status: 'push_failed', detail: lastLine(push.stderr) };
      return { status: 'pushed' };
    } catch (e) {
      return { status: 'commit_failed', detail: String(e?.message ?? e) };
    } finally {
      // 例外で抜けた場合も鍵は必ず返す
      if (unlock) unlock();
      markCommitted();
    }
  };

  const result = chain.then(run);
  chain = result.catch(() => {});
  return { committed, result };
}

// ---------------------------------------------------------------- パネル用の予約

let timer = null;
let pendingReason = null;

/**
 * 公開を予約する。最後の予約から delayMs 何も来なければ走る。
 * 確定パネルで続けて何件も確定したとき、1件ごとにコミットを作らないため。
 */
export function schedulePublish(reason, { delayMs = 60_000, onResult = reportPublish, ...opts } = {}) {
  pendingReason = reason;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const r = pendingReason;
    timer = null;
    pendingReason = null;
    startPublish(r, opts).result.then((res) => onResult(res, r));
  }, delayMs);
}

// ---------------------------------------------------------------- 知らせ方

const stamp = () => new Date().toLocaleTimeString('ja-JP');

/**
 * 結果をコンソールに1行残し、人の手が要るものだけトーストで知らせる。
 * 成功は知らせない（取り込みの通知が既に出ている）。
 */
export function reportPublish(res, reason = '') {
  const label = {
    pushed: '公開版をプッシュしました',
    no_change: '公開版に変化なし',
    disabled: '自動公開は無効（config.json の publish.auto_push）',
    not_main: `main 以外のブランチ（${res.detail}）のため公開を見送り`,
    blocked: 'docs/ 以外の未プッシュのコミットがあるため公開を見送り',
    commit_failed: `公開版のコミットに失敗: ${res.detail}`,
    push_failed: `公開版のプッシュに失敗: ${res.detail}`,
  }[res.status] ?? res.status;
  console.log(`  ${stamp()}  [公開${reason ? `:${reason}` : ''}] ${label}`);

  if (res.status === 'blocked') {
    notify('公開版の更新を見送りました', ['docs/ 以外の未プッシュのコミットがあります', 'git push を手動で行ってください']);
  } else if (res.status === 'push_failed' || res.status === 'commit_failed') {
    notify('公開版の更新に失敗', [res.detail || '理由不明', '次の自動反映で再試行します']);
  }
}
