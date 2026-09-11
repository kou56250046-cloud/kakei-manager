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
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "文書が唯一のバックアップを消す指示になっている。直ったかは記述の突き合わせで確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: data/ は gitignore 済みで Git 管理外。docs/ は暗号化バックアップを Pages 公開している。restore.js のコメント自身が「リポジトリはバックアップにならない」と書いている"
evidence: []
baseline:
  capturedAt: null
  mode: ""
  metrics: {}
after:
  capturedAt: null
  mode: ""
  metrics: {}
verdict: null
history:
  - at: 2026-09-10T12:35:02.194Z
    change: detected
---

## 何が問題か

`.claude/CLAUDE.md` は「データの正は data/*.json（Git管理）」「GitHub Pages は使わない」を絶対制約として書いている。実際は `data/` が `.gitignore` 済みで Git 管理外、`docs/` に `.nojekyll` / `sw.js` を生成して Pages 公開している。README の月次手順も `git push` で Pages に反映と書いている。

この制約を素直に信じると (a) 「data/ は Git 管理だから戻せる」と誤認して復元手段を確認しない、(b) 「Pages を使わない制約に違反している」と判断して `docs/` を削除する。**(b) は唯一のバックアップの消去そのもの。**

## どう直すか

`.claude/CLAUDE.md` を実装に合わせて書き換える。「data/ は Git 管理外」「Pages は暗号化済み docs/ に限り使う。平文は置かない」「docs/index.html は生成物ではなく唯一のバックアップなので消さない」の3点を明記する。README のセキュリティ方針の記述が既に正しいので、そちらを正典として揃える。

## 確かめたこと

<!-- 適用後にここへ書く -->
