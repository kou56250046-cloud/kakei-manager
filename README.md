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

## 使い方

```bash
# 明細CSVを imports/ に、給与明細PDFを 給与明細/ に置いてから
npm run update      # 取込 → 給与取込 → 固定費生成 → HTML生成

# dist/index.html をブラウザで開く（ローカル閲覧用・平文）
```

| コマンド | 内容 |
|---|---|
| `npm run import` | カード明細CSV → `data/transactions/` |
| `npm run import:payslip` | 給与明細PDF → `data/incomes.json` |
| `npm run generate` | 固定費・定期収入マスタ → 月次の取引を生成 |
| `npm run summary` | 集計をターミナルに表示 |
| `npm run build` | `dist/index.html`（ローカル閲覧用・平文） |
| `npm run build:web` | `docs/index.html`（Web公開用・**暗号化**） |
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

## 構成

```
scripts/       取込・生成・ビルド（Node.js / 依存ゼロ）
  lib/         Shift_JIS読取・店名正規化・分類・PDFテキスト抽出
ui/            ダッシュボードのHTML/CSS/JS（集計ロジックはCLIと共用）
data/          データの正（gitignore）
docs/          GitHub Pages 用の暗号化済みダッシュボード
```

詳しい作業ルールは `CLAUDE.md` を参照。
