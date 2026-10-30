/** Browser-side spreadsheet reader. The Worker never unzips or decodes uploads. */

export class SpreadsheetError extends Error {
  constructor(public code: "xls" | "xlsx" | "empty" | "encoding") {
    super(code);
  }
}

export type SheetEncoding = "utf-8" | "big5" | "xlsx";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function decodeBytes(bytes: Uint8Array, encoding: "auto" | "utf-8" | "big5" = "auto"): { text: string; encoding: "utf-8" | "big5" } {
  if (encoding === "utf-8") return { text: stripBom(decodeUtf8(bytes)), encoding: "utf-8" };
  if (encoding === "big5") return { text: stripBom(decodeBig5(bytes)), encoding: "big5" };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: stripBom(decodeUtf8(bytes)), encoding: "utf-8" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text: stripBom(text), encoding: "utf-8" };
  } catch {
    return { text: stripBom(decodeBig5(bytes)), encoding: "big5" };
  }
}

function decodeUtf8(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeBig5(bytes: Uint8Array) {
  try {
    return new TextDecoder("big5").decode(bytes);
  } catch {
    throw new SpreadsheetError("encoding");
  }
}

function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** RFC-style CSV. Newlines inside quotes are kept. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some((value) => value.trim() !== "")) rows.push(row);
  }
  return rows;
}

export function csvDocument(rows: string[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value: string) {
  let text = value;
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export async function readSpreadsheet(
  fileName: string,
  bytes: Uint8Array,
  encoding: "auto" | "utf-8" | "big5" = "auto",
): Promise<{ rows: string[][]; encoding: SheetEncoding }> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".xls") && !lower.endsWith(".xlsx")) throw new SpreadsheetError("xls");
  if (lower.endsWith(".xlsx")) {
    const rows = trimBlank(await readXlsx(bytes));
    if (rows.length === 0) throw new SpreadsheetError("empty");
    return { rows, encoding: "xlsx" };
  }
  const decoded = decodeBytes(bytes, encoding);
  const rows = trimBlank(parseCsv(decoded.text));
  if (rows.length === 0) throw new SpreadsheetError("empty");
  return { rows, encoding: decoded.encoding };
}

function trimBlank(rows: string[][]) {
  return rows.filter((row) => row.some((cell) => cell.trim() !== ""));
}

export async function buildXlsx(rows: string[][]): Promise<Uint8Array> {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const sheetRows = rows.map((row, rowIndex) => {
    const cells = row.map((value, column) => {
      let at = index.get(value);
      if (at === undefined) {
        at = strings.length;
        strings.push(value);
        index.set(value, at);
      }
      const ref = `${columnLetters(column)}${rowIndex + 1}`;
      return `<c r="${ref}" t="s"><v>${at}</v></c>`;
    });
    return `<row r="${rowIndex + 1}">${cells.join("")}</row>`;
  });
  const shared = strings.map((value) => `<si><t xml:space="preserve">${escapeXml(value)}</t></si>`).join("");
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="匯入" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`,
    "xl/sharedStrings.xml": `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${shared}</sst>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows.join("")}</sheetData></worksheet>`,
  };
  return zipStore(files);
}

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function columnLetters(index: number) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function columnIndex(letters: string) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsx(bytes: Uint8Array): Promise<string[][]> {
  let entries: Map<string, Uint8Array>;
  try {
    entries = await unzip(bytes);
  } catch {
    throw new SpreadsheetError("xlsx");
  }
  const byName = new Map([...entries.entries()].map(([name, value]) => [name.toLowerCase(), value]));
  const sheet = byName.get("xl/worksheets/sheet1.xml") ?? [...byName.entries()].find(([name]) => name.startsWith("xl/worksheets/sheet") && name.endsWith(".xml"))?.[1];
  if (!sheet) throw new SpreadsheetError("xlsx");
  const sharedXml = byName.get("xl/sharedstrings.xml");
  const strings = sharedXml ? sharedStrings(textDecoder.decode(sharedXml)) : [];
  return sheetRows(textDecoder.decode(sheet), strings);
}

function sharedStrings(xml: string) {
  const out: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const parts = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1]));
    out.push(parts.join(""));
  }
  return out;
}

function sheetRows(xml: string, strings: string[]) {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let cursor = 0;
    for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cell[1] ?? "";
      const body = cell[2] ?? "";
      const letters = /r="([A-Z]+)/i.exec(attrs)?.[1];
      const column = letters ? columnIndex(letters.toUpperCase()) : cursor;
      while (cells.length < column) cells.push("");
      cells[column] = cellText(attrs, body, strings);
      cursor = column + 1;
    }
    rows.push(cells);
  }
  return rows;
}

function cellText(attrs: string, body: string, strings: string[]) {
  const kind = /t="([^"]+)"/.exec(attrs)?.[1] ?? "";
  if (kind === "inlineStr") {
    return [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join("");
  }
  const raw = decodeXml(/<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
  if (kind === "s") return strings[Number(raw)] ?? "";
  return raw;
}

function decodeXml(value: string) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

type ZipEntry = { name: string; method: number; compressed: Uint8Array };

async function unzip(bytes: Uint8Array) {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new SpreadsheetError("xlsx");
  const count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw new SpreadsheetError("xlsx");
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const nameLen = u16(bytes, offset + 28);
    const extraLen = u16(bytes, offset + 30);
    const commentLen = u16(bytes, offset + 32);
    const local = u32(bytes, offset + 42);
    const name = textDecoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    const localName = u16(bytes, local + 26);
    const localExtra = u16(bytes, local + 28);
    const dataStart = local + 30 + localName + localExtra;
    entries.push({ name, method, compressed: bytes.subarray(dataStart, dataStart + compressedSize) });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  const out = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    if (entry.method === 0) out.set(entry.name, entry.compressed);
    else if (entry.method === 8) out.set(entry.name, await inflateRaw(entry.compressed));
    else throw new SpreadsheetError("xlsx");
  }
  return out;
}

async function inflateRaw(data: Uint8Array) {
  const stream = new Blob([copyBytes(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function copyBytes(data: Uint8Array) {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}

function findEocd(bytes: Uint8Array) {
  const start = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  return -1;
}

function u16(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function u32(bytes: Uint8Array, offset: number) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function zipStore(files: Record<string, string>) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, xml] of Object.entries(files)) {
    const data = textEncoder.encode(xml);
    const compressed = await deflateRaw(data);
    const nameBytes = textEncoder.encode(name);
    const crc = crc32(data);
    const local = concat([
      u32b(0x04034b50),
      u16b(20),
      u16b(0x800),
      u16b(8),
      u16b(0),
      u16b(0),
      u32b(crc),
      u32b(compressed.length),
      u32b(data.length),
      u16b(nameBytes.length),
      u16b(0),
      nameBytes,
      compressed,
    ]);
    const central = concat([
      u32b(0x02014b50),
      u16b(20),
      u16b(20),
      u16b(0x800),
      u16b(8),
      u16b(0),
      u16b(0),
      u32b(crc),
      u32b(compressed.length),
      u32b(data.length),
      u16b(nameBytes.length),
      u16b(0),
      u16b(0),
      u16b(0),
      u16b(0),
      u32b(0),
      u32b(offset),
      nameBytes,
    ]);
    offset += local.length;
    locals.push(local);
    centrals.push(central);
  }
  const centralDir = concat(centrals);
  const eocd = concat([
    u32b(0x06054b50),
    u16b(0),
    u16b(0),
    u16b(centrals.length),
    u16b(centrals.length),
    u32b(centralDir.length),
    u32b(offset),
    u16b(0),
  ]);
  return concat([...locals, centralDir, eocd]);
}

async function deflateRaw(data: Uint8Array) {
  const stream = new Blob([copyBytes(data)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function concat(parts: Uint8Array[]) {
  const len = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(len);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function u16b(value: number) {
  return new Uint8Array([value & 255, (value >> 8) & 255]);
}

function u32b(value: number) {
  return new Uint8Array([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255]);
}

function crc32(data: Uint8Array) {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
