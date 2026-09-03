/**
 * PWA のアイコンを描く。外部画像を持たず、コードから生成する。
 *
 * 図柄は「お札の入った財布」。ホーム画面には他のアプリと並ぶため、
 * 抽象的な図（グラフ）ではなく物にして、一目でこのアプリだと分かるようにしている。
 *
 * ★ maskable 対応：Android はアイコンを円や角丸に切り抜く。
 *   切られても欠けないよう、図柄は中央 80%（セーフゾーン）の内側に収める。
 *   背景は全面を塗る（余白を透明にすると切り抜き時に地が透ける）。
 *
 * ★ 描けるのは角丸長方形だけ（png.js の fillRoundRect）。円は「正方形 ＋ 半径＝辺の半分」で描く。
 *   曲線の要らない図柄を選んでいるのはこのため（依存パッケージを入れないための制約）。
 */

import { encodePNG, hex, fillRoundRect } from './png.js';

// 画面のダークテーマと同じ色。アイコンと中身の印象を揃える
const BG = '#1a1a19';
const WALLET = '#d95926';             // 財布の本体
const FLAP = '#b0431c';               // かぶせ蓋。本体より暗くして段差を出す
const CLASP = '#f2c14e';              // 留め金
const BILLS = ['#3987e5', '#199e70']; // 口から覗くお札（奥 / 手前）

/** 512px を基準に設計し、任意サイズへ等倍で写す */
export function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const [br, bg, bb] = hex(BG);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = br; px[i * 4 + 1] = bg; px[i * 4 + 2] = bb; px[i * 4 + 3] = 255;
  }

  const s = size / 512;      // 設計座標 → 実サイズ
  const S = (v) => v * s;

  // お札。奥に1枚、手前に1枚ずらして重ね、厚み（＝入っている感じ）を出す。
  // 下端は財布に隠れるので、上に覗く部分だけが見える
  fillRoundRect(px, size, S(172), S(80), S(356), S(200), S(12), BILLS[0]);
  fillRoundRect(px, size, S(150), S(100), S(334), S(200), S(12), BILLS[1]);

  // 財布の本体
  fillRoundRect(px, size, S(88), S(166), S(424), S(400), S(46), WALLET);

  // かぶせ蓋。本体より上に出しつつ左右は内側に収める。
  // こうすると蓋の両脇に本体の縁が見えて、かぶさっている厚みが出る
  // （左右いっぱいに広げるとブリーフケースに見えてしまう）
  fillRoundRect(px, size, S(110), S(150), S(402), S(304), S(38), FLAP);

  // 留め金。蓋の下端をまたぐ位置に置くと「閉じている」ことが伝わる
  fillRoundRect(px, size, S(226), S(280), S(286), S(340), S(30), CLASP);

  return encodePNG(size, size, px);
}
