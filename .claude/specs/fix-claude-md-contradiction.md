# CLAUDE.md の絶対制約が実装と真逆なのを直す

改善候補: `ops--kakei-manager--5a94b864`（アンカー: 絶対に守ること）

> **消化済み（2026-09-14）。** `.claude/specs/auto-ingest/` の T0 として実施した。
> `.claude/CLAUDE.md` は正典ではないことを明記した短いファイルに置き換え、
> 作業指示はリポジトリ直下の `CLAUDE.md` に一本化した。

## 背景

`.claude/CLAUDE.md` が「絶対に守ること」として書いている 2 点が、実装と真逆になっている。

| CLAUDE.md の記述 | 実際 | 根拠 |
|---|---|---|
| データの正は `data/*.json`（**Git管理**） | Git 管理外 | `.gitignore:18` に `data/` |
| **GitHub Pages は使わない** | 暗号化して公開している | `docs/` に `index.html` / `sw.js` / `manifest.webmanifest`。`README.md:49,52` が `git push` → Pages 反映を手順として書く |

`scripts/restore.js:10` のコメントが「`data/` は `.gitignore` されているため、
リポジトリはバックアップにならない」と明記しており、**実装側が正しい。**

この文書を素直に信じると 2 つの誤りが起きる。

1. 「`data/` は Git 管理だから壊れても戻せる」と誤認し、復元手段を確認しないまま作業する
2. 「Pages を使わない制約に違反している」と判断して `docs/` を削除する

**2 は唯一のバックアップの消去そのもの。** `data/` は Git 管理外なので、
`docs/index.html`（暗号化済み）が失われると復元手段が無くなる。

月に 1 回しか触らないプロジェクトで、先に読まれるのは短い `.claude/CLAUDE.md` の方。
`README.md:129,176` は正しく書けているので、そちらを正典として揃える。

## 受入条件

- [ ] `.claude/CLAUDE.md` に「`data/` は Git 管理外」と書かれている
- [ ] `.claude/CLAUDE.md` に「Pages は暗号化済み `docs/` に限り使う。平文は置かない」と書かれている
- [ ] `.claude/CLAUDE.md` に「`docs/index.html` は生成物ではなく唯一のバックアップなので消さない」と書かれている
- [ ] `.claude/CLAUDE.md` の記述と `.gitignore` / `README.md` / `scripts/restore.js` の間に矛盾が無い
- [ ] 既存の他の制約（Shift_JIS、口座番号を保存しない、重複登録しない、金額は整数）が消えていない

## 非目標

- **`.gitignore` を変えない。** `data/` を Git 管理に入れる案は採らない。
  家計の明細を履歴に残すことになり、プライベートリポジトリでも判断が変わる
- **`docs/` の生成方法を変えない。** 暗号化の仕組みは正しく動いている
- **README を書き換えない。** あちらが正典で、既に正しい
- **月次運用の手順そのものを直さない。**（`.claude/CLAUDE.md` の手順が `npm run close` を
  案内していない件は別候補 `discovery--kakei-manager--736b96c9` で扱う）
- **合言葉の控えを促す記述は入れない。**（別候補 `data--kakei-manager--e6ffb558`）

## 触るファイル

- `.claude/CLAUDE.md` — 「この構成の要点」節の 2 行を実装に合わせて書き換え、
  `docs/index.html` を消してはいけない旨を足す

## 検証方法

欠陥修正なので数値は測らない。**再現手順を通して、起きなくなったことを確かめる。**

```bash
# 1. data/ が Git 管理外であることと、CLAUDE.md の記述が一致するか
grep -n "^data/" .gitignore
grep -n "Git管理\|Git 管理" .claude/CLAUDE.md

# 2. Pages を使っている事実と、CLAUDE.md の記述が一致するか
ls docs/index.html docs/sw.js
grep -n "Pages" .claude/CLAUDE.md README.md

# 3. docs/ を消してはいけない旨が書かれているか
grep -n "docs/index.html" .claude/CLAUDE.md
```

3 つとも矛盾が無ければ `verdict: improved` として `evidence` に確認結果を書く。
