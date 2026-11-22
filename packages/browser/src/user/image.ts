/**
 * Pixel work for the `user` backend, in plain JS (the extension loader allows `zlib` and nothing native): decode the
 * bridge's PNG, draw the marked boxes and their `eN` labels, scale down, and encode PNG (zlib) or JPEG (jpeg-js, bundled).
 * The managed backend draws marks inside the page; here nothing is added to the person's page, so the marks are drawn on
 * the picture instead.
 */
// The extension loader provides zlib under its bare name only (not node:zlib).
import zlib from 'zlib';
import jpeg from 'jpeg-js';

export interface Rgba {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row by row. */
  readonly data: Uint8Array;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The picture's format by its signature bytes (PNG's 8-byte signature, JPEG's SOI marker), or null for anything else. */
export function imageFormat(data: Buffer): 'png' | 'jpeg' | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(SIGNATURE)) return 'png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  return null;
}

/** A JPEG's pixel size from its first start-of-frame segment (SOF0-SOF15 except DHT, JPG and DAC), or null. */
export function jpegSize(data: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const length = data.readUInt16BE(offset + 2);
    const frame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (frame && offset + 9 <= data.length)
      return { height: data.readUInt16BE(offset + 5), width: data.readUInt16BE(offset + 7) };
    if (marker === 0xd9 || marker === 0xda || length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

export function decodePng(png: Buffer): Rgba {
  if (png.length < 8 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('IMAGE_NOT_PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  if (depth !== 8) throw new Error(`IMAGE_UNSUPPORTED: bit depth ${String(depth)}`);
  if (interlace !== 0) throw new Error('IMAGE_UNSUPPORTED: interlaced');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || width <= 0 || height <= 0)
    throw new Error(`IMAGE_UNSUPPORTED: color type ${String(colorType)}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start] ?? 0;
    const line = new Uint8Array(raw.subarray(start + 1, start + 1 + stride));
    unfilter(filter, line, previous, channels);
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const i = x * channels;
      switch (colorType) {
        case 0:
          out[o] = out[o + 1] = out[o + 2] = line[i] ?? 0;
          out[o + 3] = 255;
          break;
        case 2:
          out[o] = line[i] ?? 0;
          out[o + 1] = line[i + 1] ?? 0;
          out[o + 2] = line[i + 2] ?? 0;
          out[o + 3] = 255;
          break;
        case 3: {
          const index = line[i] ?? 0;
          out[o] = palette?.[index * 3] ?? 0;
          out[o + 1] = palette?.[index * 3 + 1] ?? 0;
          out[o + 2] = palette?.[index * 3 + 2] ?? 0;
          out[o + 3] = transparency?.[index] ?? 255;
          break;
        }
        case 4:
          out[o] = out[o + 1] = out[o + 2] = line[i] ?? 0;
          out[o + 3] = line[i + 1] ?? 255;
          break;
        default:
          out[o] = line[i] ?? 0;
          out[o + 1] = line[i + 1] ?? 0;
          out[o + 2] = line[i + 2] ?? 0;
          out[o + 3] = line[i + 3] ?? 255;
      }
    }
    previous = line;
  }
  return { width, height, data: out };
}

function unfilter(filter: number, line: Uint8Array, previous: Uint8Array, bpp: number): void {
  for (let i = 0; i < line.length; i += 1) {
    const a = i >= bpp ? (line[i - bpp] ?? 0) : 0;
    const b = previous[i] ?? 0;
    const c = i >= bpp ? (previous[i - bpp] ?? 0) : 0;
    const x = line[i] ?? 0;
    let add = 0;
    if (filter === 1) add = a;
    else if (filter === 2) add = b;
    else if (filter === 3) add = (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    line[i] = (x + add) & 0xff;
  }
}

export function encodePng(image: Rgba): Buffer {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.data.buffer, image.data.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function encodeJpeg(image: Rgba, quality: number): Buffer {
  const encoded = jpeg.encode(
    { width: image.width, height: image.height, data: Buffer.from(image.data) },
    Math.max(1, Math.min(100, Math.round(quality))),
  );
  return Buffer.from(encoded.data);
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'latin1');
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Area-average downscale to `width` (keeps the aspect). Returns the input when it is already narrow enough. */
export function scaleTo(image: Rgba, width: number): Rgba {
  if (!(width > 0) || image.width <= width) return image;
  const ratio = image.width / width;
  const height = Math.max(1, Math.round(image.height / ratio));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * ratio);
    const y1 = Math.min(image.height, Math.max(y0 + 1, Math.floor((y + 1) * ratio)));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(image.width, Math.max(x0 + 1, Math.floor((x + 1) * ratio)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i] ?? 0;
          g += image.data[i + 1] ?? 0;
          b += image.data[i + 2] ?? 0;
          a += image.data[i + 3] ?? 0;
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}

/** The managed backend's mark colours (page/scripts.ts drawMarksScript). */
const COLORS: readonly (readonly [number, number, number])[] = [
  [0xe6, 0x19, 0x4b],
  [0x3c, 0xb4, 0x4b],
  [0x43, 0x63, 0xd8],
  [0xf5, 0x82, 0x31],
  [0x91, 0x1e, 0xb4],
  [0x00, 0x80, 0x80],
  [0xf0, 0x32, 0xe6],
  [0x9a, 0x63, 0x24],
];

export interface Mark {
  readonly ref: string;
  /** CSS-pixel box [x, y, w, h] in the viewport. */
  readonly box: readonly [number, number, number, number];
}

/**
 * Draws one 2px box per mark and its ref on a filled tag above it (inside it near the top edge), as drawMarksScript
 * does in the page. `scale` maps CSS pixels to image pixels (device pixel ratio).
 */
export function drawMarks(image: Rgba, marks: readonly Mark[], scale: number): number {
  let drawn = 0;
  marks.forEach((mark, index) => {
    const [bx, by, bw, bh] = mark.box.map((v) => Math.round(v * scale)) as [
      number,
      number,
      number,
      number,
    ];
    if (bw <= 0 || bh <= 0 || bx + bw < 0 || by + bh < 0 || bx >= image.width || by >= image.height)
      return;
    const color = COLORS[index % COLORS.length] as readonly [number, number, number];
    const line = Math.max(2, Math.round(2 * scale));
    fillRect(image, bx, by, bw, line, color);
    fillRect(image, bx, by + bh - line, bw, line, color);
    fillRect(image, bx, by, line, bh, color);
    fillRect(image, bx + bw - line, by, line, bh, color);
    const size = Math.max(1, Math.round(1.6 * scale));
    const textW = textWidth(mark.ref) * size;
    const tagH = (GLYPH_H + 2) * size;
    const tagY = by > tagH ? by - tagH : by;
    fillRect(image, bx, tagY, textW + 2 * size, tagH, color);
    drawText(image, mark.ref, bx + size, tagY + size, size, [255, 255, 255]);
    drawn += 1;
  });
  return drawn;
}

function fillRect(
  image: Rgba,
  x: number,
  y: number,
  w: number,
  h: number,
  [r, g, b]: readonly [number, number, number],
): void {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(image.width, x + w);
  const y1 = Math.min(image.height, y + h);
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const o = (yy * image.width + xx) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = 255;
    }
  }
}

/** A 5x7 pixel font for what a ref is made of: `e` and the digits. */
const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
};

function textWidth(text: string): number {
  return text.length * (GLYPH_W + 1) - 1;
}

function drawText(
  image: Rgba,
  text: string,
  x: number,
  y: number,
  size: number,
  color: readonly [number, number, number],
): void {
  // Refs are ASCII (e and digits), so indexing by UTF-16 unit is exact.
  for (let index = 0; index < text.length; index += 1) {
    const glyph = GLYPHS[text.charAt(index)];
    if (!glyph) continue;
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < row.length; gx += 1) {
        if (row.charAt(gx) === '#')
          fillRect(
            image,
            x + (index * (GLYPH_W + 1) + gx) * size,
            y + gy * size,
            size,
            size,
            color,
          );
      }
    });
  }
}
