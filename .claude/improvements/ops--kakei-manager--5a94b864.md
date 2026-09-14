---
generated:
  id: ops--kakei-manager--5a94b864
  axis: 運用性
  project: kakei-manager
  title: "CLAUDE.md の絶対制約2つが実装と真逆で、唯一のバックアップを消す指示になっている"
  detector: ops-reviewer
  anchor: 絶対に守ること
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - .claude/CLAUDE.md
curated:
  status: verified
  statusReason: "auto-ingest の T0 として消化する。自動化で無人実行が増えるため、誤った前提が残っていると被害が大きい"
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "文書が唯一のバックアップを消す指示になっている。直ったかは記述の突き合わせで確かめる"
  specPath: ".claude/specs/auto-ingest/"
  branch: "main"
  adoptedAt: 2026-09-14T02:05:23.000Z
sources:
  - "ops-reviewer: data/ は gitignore 済みで Git 管理外。docs/ は暗号化バックアップを Pages 公開している。restore.js のコメント自身が「リポジトリはバックアップにならない」と書いている"
evidence:
  - "2026-09-14 記述の突き合わせ: .claude/CLAUDE.md で誤読できる記述 2件 → 0件。残る2行は「古い記述｜実際」の訂正表の左列で、同じ行の右列が否定している。実装側（.gitignore:18 の `data/`、build-web.js の docs/ 出力3箇所）と文書が一致することを確認した"
baseline:
  capturedAt: 2026-09-14T02:05:23.000Z
  mode: "記述の突き合わせ"
  metrics:
    reproduced: true
    誤読できる記述: 2
    詳細: ".claude/CLAUDE.md に「データの正は data/*.json（Git管理）」と「GitHub Pages は使わない」の2箇所。実際は .gitignore に data/ があり、build-web.js が docs/ へ暗号化出力している"
after:
  capturedAt: 2026-09-14T07:30:00.000Z
  mode: "記述の突き合わせ"
  metrics:
    reproduced: false
    誤読できる記述: 0
verdict: improved
history:
  - at: 2026-09-10T12:35:02.194Z
    change: detected
  - at: 2026-09-14T02:05:23.000Z
    change: adopted（auto-ingest の T0）
  - at: 2026-09-14T07:30:00.000Z
    change: verified（再現手順を通して起きないことを確認）
---

## 何が問題か

`.claude/CLAUDE.md` は「データの正は data/*.json（Git管理）」「GitHub Pages は使わない」を絶対制約として書いている。実際は `data/` が `.gitignore` 済みで Git 管理外、`docs/` に `.nojekyll` / `sw.js` を生成して Pages 公開している。README の月次手順も `git push` で Pages に反映と書いている。

この制約を素直に信じると (a) 「data/ は Git 管理だから戻せる」と誤認して復元手段を確認しない、(b) 「Pages を使わない制約に違反している」と判断して `docs/` を削除する。**(b) は唯一のバックアップの消去そのもの。**

## どう直すか

`.claude/CLAUDE.md` を実装に合わせて書き換える。「data/ は Git 管理外」「Pages は暗号化済み docs/ に限り使う。平文は置かない」「docs/index.html は生成物ではなく唯一のバックアップなので消さない」の3点を明記する。README のセキュリティ方針の記述が既に正しいので、そちらを正典として揃える。

## 確かめたこと

<!-- 適用後にここへ書く -->
