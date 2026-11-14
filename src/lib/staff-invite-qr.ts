/** Local QR Model 2 encoder: version 6, byte mode, ECC L, mask 0.
 * Fixed capacity (134 UTF-8 bytes) covers the configured app origins + /join/ +
 * 43-byte token. No network, image service, dependency or token-bearing SVG text.
 */
export function inviteQrMatrix(value: string): boolean[][] {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length > 134) throw new Error("QR capacity exceeded");
  const bits: number[] = [];
  const put = (n: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((n >>> i) & 1); };
  put(4, 4); put(bytes.length, 8);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, 1088 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
  for (let i = 0; data.length < 136; i++) data.push(i % 2 ? 0x11 : 0xec);
  const mul = (a: number, b: number) => {
    let r = 0;
    for (let i = 7; i >= 0; i--) { r = (r << 1) ^ ((r >>> 7) * 0x11d); r ^= ((b >>> i) & 1) * a; }
    return r;
  };
  let poly = [1], root = 1;
  for (let i = 0; i < 18; i++) {
    const next = Array(poly.length + 1).fill(0) as number[];
    poly.forEach((v, j) => { next[j] ^= v; next[j + 1] ^= mul(v, root); });
    poly = next; root = mul(root, 2);
  }
  const blocks = [data.slice(0, 68), data.slice(68)];
  const ecc = blocks.map(block => {
    const remainder = [...block, ...Array(18).fill(0)] as number[];
    for (let i = 0; i < 68; i++) {
      const factor = remainder[i];
      poly.forEach((v, j) => { remainder[i + j] ^= mul(v, factor); });
    }
    return remainder.slice(68);
  });
  const words: number[] = [];
  for (let i = 0; i < 68; i++) for (const block of blocks) words.push(block[i]);
  for (let i = 0; i < 18; i++) for (const block of ecc) words.push(block[i]);
  const size = 41;
  const matrix = Array.from({ length: size }, () => Array(size).fill(false) as boolean[]);
  const reserved = Array.from({ length: size }, () => Array(size).fill(false) as boolean[]);
  const set = (x: number, y: number, dark: boolean) => { matrix[y][x] = dark; reserved[y][x] = true; };
  for (const [cx, cy] of [[3, 3], [37, 3], [3, 37]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && y >= 0 && x < size && y < size) set(x, y, d !== 2 && d !== 4);
    }
  }
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(34 + dx, 34 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  // BCH format information: L / mask 0 (0x77c4), both copies.
  const format = 0x77c4, bit = (i: number) => ((format >>> i) & 1) !== 0;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (reserved[y][x]) continue;
        const dark = at < words.length * 8 && ((words[at >>> 3] >>> (7 - (at & 7))) & 1) !== 0;
        matrix[y][x] = dark !== ((x + y) % 2 === 0); at++;
      }
    }
  }
  return matrix;
}
export function inviteQrSvg(value: string): string {
  const matrix = inviteQrMatrix(value);
  const path = matrix.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 49 49" role="img" aria-label="QR" shape-rendering="crispEdges"><rect width="49" height="49" fill="white"/><path d="${path}" fill="black"/></svg>`;
}
