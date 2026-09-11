---
generated:
  id: dashboard--kakei-manager--8f273fdf
  axis: ダッシュボード
  project: kakei-manager
  title: "不完全な月を選ぶと、hero の最大の数字が実額より小さいまま無警告で出る"
  detector: viz-reviewer
  anchor: renderHero
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/app.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 採点差分
  expected:
    metric: "可視化の採点"
    direction: up
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "viz-reviewer: import_log.json の usage_to は 2026-08-10。markIncompleteMonths は 2026-08 を incomplete と判定するが renderBanner は警告しない"
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

月1回開いた人が最初にやるのは「今月」＝2026-08 のチップを押すこと。押すと hero は「2026-08 の支出」として8月1〜10日分だけの額を画面最大のフォントで出す。

しかも delta は不完全月では null になるため、前月比の枠が「N件の取引」に差し替わり、**比較の欠落すら気づけない。** 手がかりはチップの小さな「不完全」タグと、別カードの棒の斜線だけ。決めたいことの筆頭「今月使いすぎていないか」を逆に読む。

## どう直すか

選択月が incomplete のとき #banners に警告を1本出し、hero-label にも範囲（〜08-10 まで）を入れる。前月比を消すのではなく「明細が 08-10 までのため前月比は出せない」と理由を書く。

## 確かめたこと

<!-- 適用後にここへ書く -->
