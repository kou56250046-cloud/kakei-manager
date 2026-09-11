---
generated:
  id: data--kakei-manager--e6ffb558
  axis: データの寿命と移行耐性
  project: kakei-manager
  title: "合言葉が .webpass にしか無く、PC が壊れると復元不能になる"
  detector: ops-reviewer
  anchor: webpass
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - README.md
    - scripts/build-web.js
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "再現手順で確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: .webpass は25バイト、gitignore 済み。日常の build:web / restore が自動で読むので本人は一度も入力しない"
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

README は復旧に「必要なのは**合言葉だけ**です」と書いている。その合言葉は `.webpass` にファイルとして置かれ、日常運用では自動で読まれるため**本人は一度も入力しないまま何ヶ月も運用できる。**

記憶に残らないまま PC が壊れると、暗号文（docs/index.html）は手元にあるのに開けない。PBKDF2 60万回で総当たりも現実的でない。これは部分損失ではなく**全損の経路**。

## どう直すか

README の「バックアップと復元」に、合言葉をリポジトリ外に控える手順を必須ステップとして書く。build-web.js が .webpass を新規作成・変更したときに「別の場所に控えてください」と明示的に出す。年1回 `npm run restore -- --out ./check` で復元が通ることを確かめる手順も載せる。

## 確かめたこと

<!-- 適用後にここへ書く -->
