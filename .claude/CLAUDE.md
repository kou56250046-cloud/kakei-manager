# 家計管理アプリ — Claude Code への作業指示書

`家計管理アプリ_仕様書.md` が仕様の正。本ファイルは**実装上の約束事**を書く。

## この構成の要点

- **ローカル完結**。Firebase・Next.js・外部DB・外部AI APIは使わない。**依存パッケージはゼロ**
- **データの正は `data/*.json`**（Git管理）。`dist/index.html` は生成物であり、いつ消してもよい
- GitHub は**プライベートリポジトリでの保管・履歴管理のみ**に使う。**GitHub Pages は使わない**
  （プライベートリポジトリからでも Pages は公開できるが、**サイトの中身は全世界から見える**ため）

## 絶対に守ること

1. **CSVは必ず Shift_JIS で読む**。`new TextDecoder('shift_jis')` を使う（`cp932` というラベルは Node が受け付けない）
2. **口座番号・名義人（CSV 行4-5）は絶対に保存しない**。`scripts/lib/parse-meisai.js` が読み捨てている。ここを変更しない
3. **取り込み前に必ず既存 `id` と照合し、重複を登録しない**
4. **検算（明細合計 ＝ 今回ご請求金額）は必ず行う。ただし不一致でも中止しない** — 警告して `data/import_log.json` に記録し、続行する
   - 仕様書11章は「不一致なら中止」としているが、**返品行（マイナス金額）やポイント充当で実際にズレ得る**ため中止すると運用が止まる
5. **金額は必ず整数（円）で扱う。浮動小数点を使わない**
6. **分類が確定したら `data/category_rules.json` に追記する**
7. `imports/*.csv` と `dist/` は `.gitignore` 済み。**コミットしない**

## コマンド

```bash
npm run import           # imports/*.csv → data/transactions/YYYY-MM.json
npm run import:payslip   # 給与明細/*.pdf → data/incomes.json
npm run summary          # 集計をターミナルに表示（npm run summary -- 2026-05 で月指定）
npm run build            # data/ + ui/ → dist/index.html（単一ファイル）
npm run update           # import → import:payslip → build を一括実行

npm run review -- --list # 要確認の一覧（正規化キー付き）
npm run review -- --all  # category_rules.json を直した後、既存データに反映する

# 特定の1件だけ分類を確定する（商業施設など、店名ルールにできないもの）
node scripts/set-category.js --match ノクテイプラザ --date 2026-05-02 \
     --category 教養・娯楽 --sub 書籍 --note "ベビー用の布絵本"
```

### 店名ルールにするか、1件だけ確定するかの判断

| 店の性質 | 対応 | 例 |
|---|---|---|
| 扱う物が決まっている | `category_rules.json` にルールを追加 | スーパー・ドラッグストア・ガソリンスタンド |
| **毎回中身が違う** | **`set-category.js` で1件だけ確定** | 商業施設・百貨店・モール |

後者にルールを作ると翌月以降を誤分類する。`set-category.js` が付ける `manual_override: true` は
`npm run review -- --all` でも上書きされない。

## 月次運用（10分）

1. イオンカード会員サイトから明細CSVをダウンロードし `imports/` に置く
2. 給与明細PDFを `給与明細/` に置く
3. `npm run update`
4. 要確認が出たら `data/category_rules.json` にルールを追記 → `npm run review -- --all`
5. 献金したら `data/tithe.json` に記録 → `npm run build`
6. `dist/index.html` を開いて確認 → `git commit`

**固定費は触らない。カード引落額も手入力しない**（CSVの「今回ご請求金額」から自動取得）。

## 店名の正規化（`scripts/lib/normalize.js`）

分類用の `merchant_key` と表示用の `merchant` を分けている。

1. `normalize('NFKC')` — 全角英数→半角、半角カナ→全角カナ
2. 空白（U+3000 含む）をすべて除去
3. **カタカナ直後の**ハイフン類のみ長音「ー」に統一

手順3を「カナ直後のみ」に限定するのが重要。無条件に変換すると `2CO.COM|CYBER-LIAM…` のような英字のハイフンまで壊れる。

> この規則で `クリエイト　エス　デイ－`(42件) と `クリエイトエスデイ－`(10件) が
> 同一キー `クリエイトエスデイー`(52件 / 84,555円) に統合される。

## 分類ルールの書き方（`data/category_rules.json`）

- パターンは **`merchant_key`（正規化済み）に対して**大小文字を無視してマッチする
- **配列の上から順に評価し、先にヒットしたものが勝つ**
  - 例：`Amazonプライム会費` は `AMAZON.CO.JP` より**前**に置く必要がある
- 正規化後の表記に注意する。例：`くまざわ書店` はひらがな（`クマザワ` では当たらない）
- カード払いの固定費には `is_fixed_cost: true` を付ける（**固定費マスタから自動生成しない**＝二重計上防止）

## 集計ロジックは1箇所（`ui/summary.js`）

CLI（`calc-summary.js`）とブラウザの両方から使う。`build.js` が `export ` を落として HTML に埋め込む。
**このファイルには import を書かない**（自己完結させる）。

集計値は**保存しない**。カード明細は利用日と請求月がずれ、過去月の集計は後から変わり得るため、常に取引データから再計算する。

## 判明済みの事実（実データ由来・再調査不要）

| 項目 | 内容 |
|---|---|
| カード | イオンゴールド。10日締め・翌月2日払い（実績では2〜7日） |
| 光熱費 | **電気・ガス・水道すべてカード払い**（東京電力 / JA組合プロパン / 川崎市水道料金） |
| サブスク | Amazonプライム / APPLE.COM / CLAUDE.AI・ANTHROPIC もカード払い |
| 天引き積立 | **なし**（拠出金は5ヶ月とも0円）→ `add_back_savings_deduction: false` のままでよい |
| 給与 | 支給日は毎月17〜20日ごろ。対象期間は前月1日〜末日 |
| 2026-03支給 | 欠勤控除減額 −119,037円があり手取り157,760円。社会保険料の控除もない（異常値ではない） |
| 2CO.COM の正体 | **MyEdit（CyberLink）の年間プラン**（本人確認済み）。明細表記 `2CO.COM¦CYBERLIAMSTERDAM` は 2Checkout(Verifone) 経由で、加盟店名が7文字に切られた `CYBERLI`(=CyberLink) ＋ 請求地 `AMSTERDAM`。**年額のため次回は2027年5月ごろ**（月次で出てこなくても異常ではない） |

## カテゴリ体系の変更

仕様書6.2の一覧に **`交際費`（ギフト）** を追加した。LINEギフトなど、他人へ贈るものが
どのカテゴリにも入らなかったため。

## 未登録（セットアップ待ち）

- `data/accounts.json` — 銀行口座の正式名称・サブ口座
- `data/balances.json` — 起点となる口座残高（これが入ると理論残高との突合が動く）
- `data/tithe.json` — 献金の実績記録
- `data/fixed_costs.json` — 口座振替の固定費（家賃・通信費・保険）。カード払い分は登録済み
