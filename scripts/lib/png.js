/**
 * 最小限の PNG エンコーダ（RGBA 8bit）。
 *
 * ★ なぜ自前で書くか
 *   このプロジェクトは依存パッケージゼロを原則にしている（CLAUDE.md）。
 *   PWA のアイコンは PNG でないと iOS のホーム画面追加が効かないため、
 *   sharp や canvas を入れずに済むよう、必要な部分だけ実装する。
 *   使うのは Node 標準の zlib だけ。
 *
 * PNG の構造は「シグネチャ + IHDR + IDAT + IEND」で足りる。
 * IDAT は「各行の先頭にフィルタ種別バイト 0 を付けた生データ」を zlib 圧縮したもの。
 */

import { deflateSync } from 'node:zlib';

// CRC-32。node:zlib にも crc32 があるが Node のバージョンで有無が変わるため自前で持つ
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA バイト列（width*height*4）を PNG バッファにする */
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // フィルタなし
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** #rrggbb → [r,g,b] */
export function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}

/**
 * 角丸長方形の符号付き距離。0未満なら内側。
 * 距離が分かると縁を 1px で滑らかに合成できる（アンチエイリアス）。
 * ドット絵のままだと 512px のアイコンで角がガタつく。
 */
export function roundRectSDF(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2 - r, hh = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hw, qy = Math.abs(py - cy) - hh;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** キャンバス（RGBA）に角丸長方形を alpha 合成で塗る */
export function fillRoundRect(px, size, x0, y0, x1, y1, r, color) {
  const [cr, cg, cb] = hex(color);
  const yMin = Math.max(0, Math.floor(y0 - 1)), yMax = Math.min(size - 1, Math.ceil(y1 + 1));
  const xMin = Math.max(0, Math.floor(x0 - 1)), xMax = Math.min(size - 1, Math.ceil(x1 + 1));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const d = roundRectSDF(x + 0.5, y + 0.5, x0, y0, x1, y1, r);
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      px[i] = Math.round(px[i] * (1 - a) + cr * a);
      px[i + 1] = Math.round(px[i + 1] * (1 - a) + cg * a);
      px[i + 2] = Math.round(px[i + 2] * (1 - a) + cb * a);
      px[i + 3] = 255;
    }
  }
}
