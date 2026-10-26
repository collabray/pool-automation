/** Dependency-free QR Code generator: byte mode, error correction M, versions 1-10 (up to 213 bytes). Output verified by decoding in tests. */
const EC: Record<number, { ec: number; g1: [number, number]; g2: [number, number] }> = {
  1: { ec: 10, g1: [1, 16], g2: [0, 0] }, 2: { ec: 16, g1: [1, 28], g2: [0, 0] }, 3: { ec: 26, g1: [1, 44], g2: [0, 0] },
  4: { ec: 18, g1: [2, 32], g2: [0, 0] }, 5: { ec: 24, g1: [2, 43], g2: [0, 0] }, 6: { ec: 16, g1: [4, 27], g2: [0, 0] },
  7: { ec: 18, g1: [4, 31], g2: [0, 0] }, 8: { ec: 22, g1: [2, 38], g2: [2, 39] }, 9: { ec: 22, g1: [3, 36], g2: [2, 37] }, 10: { ec: 26, g1: [4, 43], g2: [1, 44] },
};
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
(() => { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsGen(n: number): number[] { let g = [1]; for (let i = 0; i < n; i++) { const next = new Array(g.length + 1).fill(0); g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); }); g = next; } return g; }
function rsRemainder(data: number[], n: number): number[] {
  const g = rsGen(n); const r = new Array(n).fill(0);
  for (const d of data) { const f = d ^ r.shift()!; r.push(0); if (f) for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f); }
  return r;
}
const bch = (v: number, poly: number, bits: number) => { let r = v << bits; const hb = (x: number) => 31 - Math.clz32(x); for (let i = hb(r) - hb(poly); i >= 0 && r >= 1 << bits; i = hb(r) - hb(poly)) r ^= poly << i; return (v << bits) | r; };

export function qrMatrix(text: string, forceMask?: number): boolean[][] {
  const bytes = [...Buffer.from(text, 'utf8')];
  let ver = 0;
  for (let v = 1; v <= 10; v++) { const e = EC[v]; const dcw = e.g1[0] * e.g1[1] + e.g2[0] * e.g2[1]; if (bytes.length <= dcw - (v < 10 ? 2 : 3)) { ver = v; break; } }
  if (!ver) throw new Error('QR payload too long (max 213 bytes)');
  const e = EC[ver]; const dataCw = e.g1[0] * e.g1[1] + e.g2[0] * e.g2[1];
  const bits: number[] = []; const put = (v: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, dataCw * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < dataCw * 8; pad ^= 0xec ^ 0x11) put(pad, 8);
  const cw: number[] = []; for (let i = 0; i < bits.length; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const blocks: number[][] = []; let p = 0;
  for (const [n, len] of [e.g1, e.g2]) for (let i = 0; i < n; i++) { blocks.push(cw.slice(p, p + len)); p += len; }
  const ecs = blocks.map((b) => rsRemainder(b, e.ec));
  const out: number[] = []; const maxLen = Math.max(...blocks.map((b) => b.length));
  for (let i = 0; i < maxLen; i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
  for (let i = 0; i < e.ec; i++) ecs.forEach((b) => out.push(b[i]));
  const stream: number[] = []; out.forEach((b) => put2(stream, b, 8));

  const size = 17 + 4 * ver;
  const m: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null));
  const fn: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r: number, c: number, v: boolean) => { if (r >= 0 && c >= 0 && r < size && c < size) { m[r][c] = v; fn[r][c] = true; } };
  const finder = (r: number, c: number) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) set(r + i, c + j, i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))); };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) { if ((r === 6 && c === 6) || (r === 6 && c === al.at(-1)) || (r === al.at(-1) && c === 6)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1); }
  set(size - 8, 8, true);
  for (let i = 0; i < 9; i++) { if (i !== 6) { set(8, i, false); set(i, 8, false); } } for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  if (ver >= 7) { const vi = bch(ver, 0x1f25, 12); for (let i = 0; i < 18; i++) { const v = !!((vi >> i) & 1); set(Math.floor(i / 3), size - 11 + (i % 3), v); set(size - 11 + (i % 3), Math.floor(i / 3), v); } }

  const place = (mask: number): boolean[][] => {
    const g = m.map((r) => r.slice()); let i = 0; let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < size; k++) { const r = up ? size - 1 - k : k;
        for (let c = col; c > col - 2; c--) { if (fn[r][c]) continue; let v = i < stream.length ? stream[i++] === 1 : false;
          const mk = [(r + c) % 2 === 0, r % 2 === 0, c % 3 === 0, (r + c) % 3 === 0, (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, ((r * c) % 2) + ((r * c) % 3) === 0, (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (((r + c) % 2) + ((r * c) % 3)) % 2 === 0][mask];
          g[r][c] = v !== mk; } }
      up = !up;
    }
    const fmt = bch((0 << 3) | mask, 0x537, 10) ^ 0x5412; // ECC level M = 00
    const b = (k: number) => !!((fmt >> k) & 1);
    for (let k = 0; k < 6; k++) g[k][8] = b(k); g[7][8] = b(6); g[8][8] = b(7); g[8][7] = b(8); for (let k = 9; k < 15; k++) g[8][14 - k] = b(k);
    for (let k = 0; k < 8; k++) g[8][size - 1 - k] = b(k); for (let k = 8; k < 15; k++) g[size - 15 + k][8] = b(k);
    g[size - 8][8] = true;
    return g;
  };
  const penalty = (g: boolean[][]): number => {
    let s = 0;
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) { let run = 1; for (let b = 1; b < size; b++) { const cur = pass ? g[b][a] : g[a][b], prev = pass ? g[b - 1][a] : g[a][b - 1]; if (cur === prev) { run++; if (run === 5) s += 3; else if (run > 5) s++; } else run = 1; } }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) if (g[r][c] === g[r][c + 1] && g[r][c] === g[r + 1][c] && g[r][c] === g[r + 1][c + 1]) s += 3;
    const pat = [true, false, true, true, true, false, true, false, false, false, false];
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < size; a++) for (let b = 0; b <= size - 11; b++) for (const rev of [false, true]) { let ok = true; for (let k = 0; k < 11 && ok; k++) { const v = pass ? g[b + k][a] : g[a][b + k]; if (v !== pat[rev ? 10 - k : k]) ok = false; } if (ok) s += 40; }
    const dark = g.flat().filter(Boolean).length; s += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return s;
  };
  if (forceMask !== undefined) return place(forceMask);
  let best = place(0), bs = penalty(best);
  for (let mk = 1; mk < 8; mk++) { const g = place(mk); const p = penalty(g); if (p < bs) { bs = p; best = g; } }
  return best;
}
function put2(arr: number[], v: number, n: number) { for (let i = n - 1; i >= 0; i--) arr.push((v >> i) & 1); }

/** SVG with a 4-module quiet zone; shape-rendering keeps edges crisp for printing. */
export function qrSvg(text: string, px = 256): string {
  const g = qrMatrix(text); const n = g.length + 8; let d = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${px}" height="${px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
