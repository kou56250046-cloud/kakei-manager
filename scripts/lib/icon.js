/**
 * PWA のアイコンを描く。外部画像を持たず、コードから生成する。
 *
 * 図柄は「棒グラフ + ベースライン」。このアプリが最初に見せる図そのものにして、
 * ホーム画面のアイコンと開いた画面が地続きになるようにしている。
 *
 * ★ maskable 対応：Android はアイコンを円や角丸に切り抜く。
 *   切られても欠けないよう、図柄は中央 80%（セーフゾーン）の内側に収める。
 *   背景は全面を塗る（余白を透明にすると切り抜き時に地が透ける）。
 */

import { encodePNG, hex, fillRoundRect } from './png.js';

// 画面のダークテーマと同じ色。アイコンと中身の印象を揃える
const BG = '#1a1a19';
const BASELINE = '#383835';
const BARS = ['#3987e5', '#d95926', '#199e70'];

/** 512px を基準に設計し、任意サイズへ等倍で写す */
export function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const [br, bg, bb] = hex(BG);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = br; px[i * 4 + 1] = bg; px[i * 4 + 2] = bb; px[i * 4 + 3] = 255;
  }

  const s = size / 512; // 設計座標 → 実サイズ
  const base = 392 * s;

  // 3本の棒。高さを変えて「推移」を示す。
  // ★ 右肩上がりの階段にはしない。家計で棒が伸び続ける絵は「支出が増え続けている」
  //   という意味になってしまう。山型にして「増えて、減らせた」形にしている
  const heights = [214, 300, 158];
  const barW = 68 * s, gapW = 34 * s;
  const totalW = barW * 3 + gapW * 2;
  let x = (size - totalW) / 2;
  for (let i = 0; i < 3; i++) {
    const h = heights[i] * s;
    fillRoundRect(px, size, x, base - h, x + barW, base, 14 * s, BARS[i]);
    x += barW + gapW;
  }

  // ベースライン（棒より少し広く伸ばす）
  fillRoundRect(px, size, (size - totalW) / 2 - 22 * s, base + 12 * s,
    (size + totalW) / 2 + 22 * s, base + 22 * s, 5 * s, BASELINE);

  return encodePNG(size, size, px);
}
