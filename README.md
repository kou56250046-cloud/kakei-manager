# 家計管理ダッシュボード

カード明細CSVと給与明細PDFを取り込んで、家計の全体像を1画面で見るためのツール。
**依存パッケージゼロ・外部通信ゼロ・運用コスト0円**（Node.js だけで動く）。

## できること

- イオンゴールドカードの明細CSV（Shift_JIS）を取り込み、重複除去・検算・自動分類
- 給与明細PDFから手取り・支給・控除を読み取り（PDFパーサーも自前実装）
- 固定費・定期収入をマスタから毎月自動生成
- 献金額を手取りから毎月自動計算
- 口座残高の理論値と実額の突合
- 単一HTMLのダッシュボードを生成（グラフも自前SVG。オフラインで動く）

## 毎月の更新手順

基本は3ステップ。それ以外は必要なときだけ。

### ① ファイルを置く

| 何を | どこに |
|---|---|
| イオンカードの明細CSV | `imports/` |
| 給与明細PDF | `給与明細/` |

ファイル名は変えなくてよい。**古いファイルを消す必要もない**
（同じ取引には同じ `id` が振られるため、何度読み込んでも重複しない）。

### ② 更新する

```bash
npm run update
```

「取込 → 給与取込 → 固定費生成 → ローカル版HTML → 暗号化版HTML」まで一度に走る。

### ③ 公開する

```bash
git add -A && git commit -m "2026-09分を取り込み" && git push
```

1〜2分で GitHub Pages に反映される。

---

### 出力の見かた

```
meisai202609.csv  新規  62件 / スキップ  18件 / 検算 OK  (142,380円)
  ...
  新規 62件 / スキップ 380件 / 要確認 3件      ← ここだけ見る
```

**要確認が0件なら、そのまま③へ進んで終わり。**

### 要確認が出たとき

新しい店で買ったということ。まず一覧を見る。

```bash
npm run review -- --list
```

対応は店の性質で分ける。

**扱う物が決まっている店**（スーパー・薬局・書店など）→ `data/category_rules.json` に追記する。
配列は**上から順に評価され、先にヒットしたものが勝つ**ことに注意。

```json
{ "pattern": "ライフ|ライフコーポ", "category": "食費", "subcategory": "スーパー", "display": "ライフ" },
```

**毎回中身が違う店**（商業施設・百貨店・モール）→ ルールにせず、その1件だけ確定させる。
ルールにすると翌月以降を誤分類するため。

```bash
node scripts/set-category.js --match ルミネ --date 2026-09-14 --category 被服費 --sub 衣類
```

どちらの場合も最後に反映する。

```bash
npm run review -- --all
npm run build && npm run build:web
```

### 検算が「⚠不一致」と出たとき

**取り込みは止まらない。** 返品行（マイナス金額）やポイント充当で実際にズレ得るため、
中止せず警告して続行する設計になっている。ダッシュボード上部に警告バナーが出るので、
金額が大きいときだけカードの明細と照合すればよい。

---

## ときどきやること

### 口座残高の更新（月1回）

`data/balances.json` に**追記**する（上書きしない）。
過去の記録が残っていると、理論残高との差額＝記録漏れが見える。

```json
{ "account_id": "mizuho_main", "date": "2026-09-01", "actual_balance": 51200 },
{ "account_id": "smbc_sub",    "date": "2026-09-01", "actual_balance": 430000 }
```

### 固定費が変わったとき

`data/fixed_costs.json` を直して `npm run generate`。
生成分は毎回作り直されるので、過去月にも遡って反映される。

### 献金を納めなかった月があったとき

固定費として毎月納めている前提で自動計上している。
実額が違う月は `data/tithe.json` に書くと、そちらが優先される。

---

## コマンド一覧

| コマンド | 内容 |
|---|---|
| `npm run update` | 下の import〜build:web を一括実行（通常はこれだけ） |
| `npm run import` | カード明細CSV → `data/transactions/` |
| `npm run import:payslip` | 給与明細PDF → `data/incomes.json` |
| `npm run generate` | 固定費・定期収入マスタ → 月次の取引を生成 |
| `npm run summary` | 集計をターミナルに表示（`-- 2026-05` で月指定） |
| `npm run build` | `dist/index.html`（ローカル閲覧用・平文） |
| `npm run build:web` | `docs/index.html`（Web公開用・**暗号化**） |
| `npm run restore` | `docs/index.html` から `data/` を復元（`--force` で書き戻し） |
| `npm run review -- --list` | 分類が未確定の取引を一覧 |
| `npm run review -- --all` | 分類ルールを直した後、既存データに反映 |

## セキュリティ方針

**家計データはこのリポジトリに含まれません。** `data/` `imports/` `給与明細/` `dist/` は
すべて `.gitignore` 済みです。

Web公開用の `docs/index.html` は、家計データを **AES-256-GCM で暗号化**して埋め込んでいます
（鍵は PBKDF2-SHA256 60万回で合言葉から導出）。
GitHub Pages は**プライベートリポジトリからでも公開サイトになる**ため、平文では置けません。
復号はブラウザ内でのみ行われ、合言葉はどこにも送信されません。

合言葉はリポジトリ直下の `.webpass`（`.gitignore` 済み）に置きます。
変更するときは `.webpass` を書き換えて `npm run build:web` → commit → push。

ビルド時に**平文混入の自己点検**が走ります。暗号文を除いた残りに
3桁区切りの数字・店名・金額が1つでも見つかると、ビルドが中断します。

> `git add -f` などで `data/` を強制的に追加すると、家計データがそのまま公開されます。
> public リポジトリであることに注意してください。

## バックアップと復元

`data/` は `.gitignore` していますが、**`docs/index.html` が実質のバックアップ**です。
全データが AES-256-GCM で暗号化されて入っており、毎月コミットされます。

### PCが壊れたときの復旧手順

```bash
git clone https://github.com/<user>/kakei-manager.git
cd kakei-manager
npm run restore -- --pass "合言葉" --force
npm run build
```

これだけで `data/` 一式（取引・収入・口座・残高・固定費・**分類ルール**）が戻ります。
必要なのは**合言葉だけ**です。

### 確認だけしたいとき

```bash
npm run restore                      # 中身を表示するだけ。何も書かない
npm run restore -- --out ./check     # 別の場所に出して、既存データと見比べる
```

`data/` に既存ファイルがある場合、`--force` なしでは上書きしません。

> 復元後は JSON の整形（インデント）が変わりますが、内容は同一です。

## 構成

```
scripts/       取込・生成・ビルド（Node.js / 依存ゼロ）
  lib/         Shift_JIS読取・店名正規化・分類・PDFテキスト抽出
ui/            ダッシュボードのHTML/CSS/JS（集計ロジックはCLIと共用）
data/          データの正（gitignore）
docs/          GitHub Pages 用の暗号化済みダッシュボード
```

詳しい作業ルールは `CLAUDE.md` を参照。
