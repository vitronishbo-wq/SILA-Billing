import { roundKz } from './billingEngine.ts';
import { resolveDefaultExemptionCodeForCompany } from './companyValidator.ts';
import {
  generateNextCustomerInternalCode,
  validateAndBuildCustomer,
} from './customerValidator.ts';
import { AGT_IVA_EXEMPTION_CODES, type AgtIvaExemptionCode } from './fiscalTypes.ts';
import {
  DEFAULT_IVA_EXEMPTION_REASONS,
  type AngolaTaxRegime,
  type Customer,
  type CustomerPaymentTerms,
  type CustomerType,
  type Product,
  type ProductType,
  type TaxRate,
} from './types.ts';

export type ImportDuplicateMode = 'SKIP' | 'UPDATE';

export interface ParsedSpreadsheetResult {
  fileName: string;
  format: 'XLSX' | 'CSV';
  sheetName: string;
  headers: string[];
  rows: string[][];
}

export interface StagedProductImportRow {
  rowNumber: number;
  status: 'NEW' | 'UPDATE' | 'ERROR' | 'DUPLICATE_SKIP';
  errors: string[];
  warnings: string[];
  rawCode: string;
  rawName: string;
  rawPrice: string;
  rawIva: string;
  rawStock: string;
  product?: Product;
  existingProductId?: string;
}

export interface StagedProductImportBatch {
  id: string;
  fileName: string;
  format: 'XLSX' | 'CSV';
  createdAtIso: string;
  duplicateMode: ImportDuplicateMode;
  detectedColumns: string[];
  totalRows: number;
  newCount: number;
  updateCount: number;
  errorCount: number;
  duplicateSkipCount: number;
  excludedRowNumbers: number[];
  rows: StagedProductImportRow[];
}

export interface StagedCustomerImportRow {
  rowNumber: number;
  status: 'NEW' | 'UPDATE' | 'ERROR' | 'DUPLICATE_SKIP';
  errors: string[];
  warnings: string[];
  rawName: string;
  rawNif: string;
  rawPhone: string;
  rawCity: string;
  customer?: Customer;
  existingCustomerId?: string;
}

export interface StagedCustomerImportBatch {
  id: string;
  fileName: string;
  format: 'XLSX' | 'CSV';
  createdAtIso: string;
  duplicateMode: ImportDuplicateMode;
  detectedColumns: string[];
  totalRows: number;
  newCount: number;
  updateCount: number;
  errorCount: number;
  duplicateSkipCount: number;
  excludedRowNumbers: number[];
  rows: StagedCustomerImportRow[];
}

export interface AppliedProductImportResult {
  toSave: Product[];
  createdCount: number;
  updatedCount: number;
  createdIds: string[];
  previousSnapshots: Product[];
}

export interface AppliedCustomerImportResult {
  toSave: Customer[];
  createdCount: number;
  updatedCount: number;
  createdIds: string[];
  previousSnapshots: Customer[];
}

function normalizeHeaderKey(raw: string): string {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseFlexibleNumber(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : NaN;
  }
  const s = String(raw || '')
    .trim()
    .replace(/kz|aoa|%|€|\$|\s+/gi, '');
  if (!s) return NaN;

  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > lastDot) {
      // Formato PT/AO: 12.500,50
      return Number(s.replace(/\./g, '').replace(',', '.'));
    }
    // Formato EN: 12,500.50
    return Number(s.replace(/,/g, ''));
  }

  if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1]!.length <= 2) {
      return Number(s.replace(',', '.'));
    }
    if (parts.length > 2) {
      return Number(s.replace(/,/g, ''));
    }
    return Number(s.replace(',', '.'));
  }

  if (hasDot) {
    const parts = s.split('.');
    if (parts.length > 2) {
      return Number(s.replace(/\./g, ''));
    }
    // Caso 12.500 vs 12.50: assume ponto decimal padrão exceto múltiplos exatos de 3 dígitos > 1 parte com prefixo claro
    return Number(s);
  }

  return Number(s);
}

function parseBooleanFlag(raw: string, fallback: boolean): boolean {
  const norm = normalizeHeaderKey(raw);
  if (!norm) return fallback;
  if (['1', 'sim', 's', 'yes', 'y', 'true', 'verdadeiro', 'ativo', 'activo'].includes(norm)) {
    return true;
  }
  if (['0', 'nao', 'n', 'no', 'false', 'falso', 'inativo', 'inactivo'].includes(norm)) {
    return false;
  }
  return fallback;
}

function decodeSpreadsheetText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder().decode(bytes);
    }
  }
}

export function detectCsvDelimiter(text: string): ';' | ',' | '\t' {
  const firstLines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 5);

  const candidates: Array<';' | ',' | '\t'> = [';', ',', '\t'];
  let bestDelimiter: ';' | ',' | '\t' = ';';
  let bestScore = -1;

  for (const delim of candidates) {
    const counts = firstLines.map((line) => {
      let count = 0;
      let inQuotes = false;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]!;
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            i += 1;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (!inQuotes && ch === delim) {
          count += 1;
        }
      }
      return count;
    });
    const first = counts[0] || 0;
    if (first === 0) continue;
    const consistent = counts.every((c) => c === first);
    const score = first * 10 + (consistent ? 5 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelimiter = delim;
    }
  }

  return bestDelimiter;
}

export function parseDelimitedText(textRaw: string): string[][] {
  const text = textRaw.replace(/^\uFEFF/, '');
  if (!text.trim()) return [];
  const delimiter = detectCsvDelimiter(text);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\n') {
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }

  return rows;
}

// ==================== LEITOR PURO DE EXCEL .XLSX (OOXML ZIP) ====================

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8)) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

interface ZipEntryRef {
  name: string;
  compressionMethod: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipCentralDirectory(bytes: Uint8Array): Map<string, ZipEntryRef> {
  const entries = new Map<string, ZipEntryRef>();
  // Localiza assinatura End of Central Directory (0x06054b50) a partir do fim
  const minOffset = Math.max(0, bytes.length - 65557);
  let eocdOffset = -1;
  for (let i = bytes.length - 22; i >= minOffset; i -= 1) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error('O ficheiro .xlsx não possui estrutura ZIP/OOXML válida.');
  }

  const totalEntries = readUint16LE(bytes, eocdOffset + 10);
  const centralDirOffset = readUint32LE(bytes, eocdOffset + 16);
  let cursor = centralDirOffset;
  const decoder = new TextDecoder('utf-8');

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > bytes.length || readUint32LE(bytes, cursor) !== 0x02014b50) {
      break;
    }
    const compressionMethod = readUint16LE(bytes, cursor + 10);
    const compressedSize = readUint32LE(bytes, cursor + 20);
    const nameLen = readUint16LE(bytes, cursor + 28);
    const extraLen = readUint16LE(bytes, cursor + 30);
    const commentLen = readUint16LE(bytes, cursor + 32);
    const localHeaderOffset = readUint32LE(bytes, cursor + 42);
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen));
    entries.set(name.replace(/^\/+/, ''), {
      name,
      compressionMethod,
      compressedSize,
      localHeaderOffset,
    });
    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

async function extractZipEntryBytes(
  zipBytes: Uint8Array,
  entry: ZipEntryRef
): Promise<Uint8Array> {
  const lh = entry.localHeaderOffset;
  if (lh + 30 > zipBytes.length || readUint32LE(zipBytes, lh) !== 0x04034b50) {
    throw new Error(`Entrada ZIP corrompida em ${entry.name}.`);
  }
  const nameLen = readUint16LE(zipBytes, lh + 26);
  const extraLen = readUint16LE(zipBytes, lh + 28);
  const dataStart = lh + 30 + nameLen + extraLen;
  const compressed = zipBytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'O navegador atual não suporta descompressão nativa Deflate. Exporte o ficheiro em CSV (;).'
      );
    }
    const ds = new DecompressionStream('deflate-raw');
    const copy = new Uint8Array(compressed.length);
    copy.set(compressed);
    const stream = new Blob([copy]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  throw new Error(`Método de compressão ZIP (${entry.compressionMethod}) não suportado em .xlsx.`);
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseSharedStringsXml(xml: string): string[] {
  const results: string[] = [];
  const siRegex = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let siMatch: RegExpExecArray | null;
  while ((siMatch = siRegex.exec(xml)) !== null) {
    const inner = siMatch[1] || '';
    const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let combined = '';
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(inner)) !== null) {
      combined += decodeXmlEntities(tMatch[1] || '');
    }
    results.push(combined);
  }
  return results;
}

function cellRefToColIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function extractAttr(attrs: string, name: string): string {
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  return m ? decodeXmlEntities(m[1] ?? m[2] ?? '') : '';
}

function parseWorksheetXml(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(xml)) !== null) {
    const rowInner = rowMatch[1] || '';
    const cells: string[] = [];
    let fallbackCol = 0;
    const cellRegex = /<c(\s[^>]*)?(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;

    while ((cellMatch = cellRegex.exec(rowInner)) !== null) {
      const attrs = cellMatch[1] || '';
      const body = cellMatch[2] || '';
      const ref = extractAttr(attrs, 'r');
      const colIdx = ref ? cellRefToColIndex(ref) : fallbackCol;
      fallbackCol = colIdx + 1;

      const cellType = extractAttr(attrs, 't');
      let value = '';

      if (cellType === 'inlineStr') {
        const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch: RegExpExecArray | null;
        while ((tMatch = tRegex.exec(body)) !== null) {
          value += decodeXmlEntities(tMatch[1] || '');
        }
      } else {
        const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
        const rawVal = vMatch ? decodeXmlEntities(vMatch[1] || '') : '';
        if (cellType === 's') {
          const idx = parseInt(rawVal, 10);
          value = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length
            ? sharedStrings[idx]!
            : '';
        } else if (cellType === 'b') {
          value = rawVal === '1' ? 'SIM' : 'NAO';
        } else {
          value = rawVal;
        }
      }

      while (cells.length <= colIdx) {
        cells.push('');
      }
      cells[colIdx] = value.trim();
    }

    if (cells.some((c) => c !== '')) {
      rows.push(cells);
    }
  }

  return rows;
}

export async function parseXlsxBytes(
  bytes: Uint8Array,
  fileName = 'import.xlsx'
): Promise<ParsedSpreadsheetResult> {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    throw new Error(
      'Formato antigo Excel (.xls binário) detectado. No Excel, clique em "Guardar como" e escolha .xlsx ou CSV.'
    );
  }

  const entries = readZipCentralDirectory(bytes);
  const decoder = new TextDecoder('utf-8');

  let sharedStrings: string[] = [];
  const ssEntry = entries.get('xl/sharedStrings.xml');
  if (ssEntry) {
    const ssBytes = await extractZipEntryBytes(bytes, ssEntry);
    sharedStrings = parseSharedStringsXml(decoder.decode(ssBytes));
  }

  // Descobre o caminho da primeira folha
  let sheetPath = 'xl/worksheets/sheet1.xml';
  let sheetName = 'Folha1';

  const wbEntry = entries.get('xl/workbook.xml');
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (wbEntry) {
    const wbXml = decoder.decode(await extractZipEntryBytes(bytes, wbEntry));
    const sheetMatch = /<sheet\s([^>]*?)\/?>(?:<\/sheet>)?/.exec(wbXml);
    if (sheetMatch) {
      const attrs = sheetMatch[1] || '';
      sheetName = extractAttr(attrs, 'name') || 'Folha1';
      const rId = extractAttr(attrs, 'r:id') || extractAttr(attrs, 'id');
      if (rId && relsEntry) {
        const relsXml = decoder.decode(await extractZipEntryBytes(bytes, relsEntry));
        const relRegex = /<Relationship\s([^>]*?)\/?>(?:<\/Relationship>)?/g;
        let relMatch: RegExpExecArray | null;
        while ((relMatch = relRegex.exec(relsXml)) !== null) {
          const rAttrs = relMatch[1] || '';
          if (extractAttr(rAttrs, 'Id') === rId) {
            const target = extractAttr(rAttrs, 'Target').replace(/^\/+/, '');
            if (target) {
              sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
            }
            break;
          }
        }
      }
    }
  }

  let sheetEntry = entries.get(sheetPath);
  if (!sheetEntry) {
    const fallbackKey = Array.from(entries.keys()).find((k) =>
      /^xl\/worksheets\/sheet\d+\.xml$/i.test(k)
    );
    if (fallbackKey) {
      sheetEntry = entries.get(fallbackKey);
    }
  }
  if (!sheetEntry) {
    throw new Error('Nenhuma folha de cálculo encontrada dentro do ficheiro .xlsx.');
  }

  const sheetXml = decoder.decode(await extractZipEntryBytes(bytes, sheetEntry));
  const matrix = parseWorksheetXml(sheetXml, sharedStrings);
  if (matrix.length === 0) {
    throw new Error('A folha do Excel está vazia.');
  }

  return {
    fileName,
    format: 'XLSX',
    sheetName,
    headers: matrix[0] || [],
    rows: matrix.slice(1),
  };
}

export async function parseSpreadsheetFileBytes(params: {
  fileName: string;
  bytes: Uint8Array;
}): Promise<ParsedSpreadsheetResult> {
  const lower = params.fileName.trim().toLowerCase();
  const isZipMagic =
    params.bytes.length >= 2 && params.bytes[0] === 0x50 && params.bytes[1] === 0x4b;

  if (lower.endsWith('.xlsx') || isZipMagic) {
    return parseXlsxBytes(params.bytes, params.fileName);
  }

  if (lower.endsWith('.xls')) {
    throw new Error(
      'Formato .xls legado não suportado directamente. Guarde no Excel como .xlsx ou CSV (;).'
    );
  }

  const text = decodeSpreadsheetText(params.bytes);
  const matrix = parseDelimitedText(text);
  if (matrix.length === 0) {
    throw new Error('O ficheiro CSV está vazio.');
  }

  return {
    fileName: params.fileName,
    format: 'CSV',
    sheetName: 'CSV',
    headers: matrix[0] || [],
    rows: matrix.slice(1),
  };
}

// ==================== GERADOR DE MODELOS OFFLINE (.CSV & .XLSX) ====================

function escapeCsvCell(val: string | number): string {
  const s = String(val ?? '');
  if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsvDocument(rows: Array<Array<string | number>>): string {
  return `\uFEFF${rows.map((r) => r.map(escapeCsvCell).join(';')).join('\r\n')}`;
}

function escapeXmlText(raw: string | number): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function colIndexToLetters(idx: number): string {
  let n = idx + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const CRC32_TABLE = (() => {
  const tbl = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    tbl[i] = c >>> 0;
  }
  return tbl;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC32_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pushU16(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff);
}

function pushU32(buf: number[], v: number): void {
  buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}

export function buildStoreZip(files: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralRecords: number[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = encoder.encode(f.path);
    const sum = crc32(f.data);
    const size = f.data.length;

    const lh: number[] = [];
    pushU32(lh, 0x04034b50);
    pushU16(lh, 20);
    pushU16(lh, 0x0800); // UTF-8
    pushU16(lh, 0); // STORE
    pushU16(lh, 0);
    pushU16(lh, 0);
    pushU32(lh, sum);
    pushU32(lh, size);
    pushU32(lh, size);
    pushU16(lh, nameBytes.length);
    pushU16(lh, 0);

    const lhBytes = new Uint8Array(lh.length + nameBytes.length + f.data.length);
    lhBytes.set(lh, 0);
    lhBytes.set(nameBytes, lh.length);
    lhBytes.set(f.data, lh.length + nameBytes.length);
    localChunks.push(lhBytes);

    pushU32(centralRecords, 0x02014b50);
    pushU16(centralRecords, 20);
    pushU16(centralRecords, 20);
    pushU16(centralRecords, 0x0800);
    pushU16(centralRecords, 0);
    pushU16(centralRecords, 0);
    pushU16(centralRecords, 0);
    pushU32(centralRecords, sum);
    pushU32(centralRecords, size);
    pushU32(centralRecords, size);
    pushU16(centralRecords, nameBytes.length);
    pushU16(centralRecords, 0);
    pushU16(centralRecords, 0);
    pushU16(centralRecords, 0);
    pushU16(centralRecords, 0);
    pushU32(centralRecords, 0);
    pushU32(centralRecords, offset);
    for (let i = 0; i < nameBytes.length; i += 1) centralRecords.push(nameBytes[i]!);

    offset += lhBytes.length;
  }

  const cdOffset = offset;
  const cdSize = centralRecords.length;
  const eocd: number[] = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0);
  pushU16(eocd, 0);
  pushU16(eocd, files.length);
  pushU16(eocd, files.length);
  pushU32(eocd, cdSize);
  pushU32(eocd, cdOffset);
  pushU16(eocd, 0);

  const totalLen = offset + cdSize + eocd.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const chunk of localChunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }
  out.set(centralRecords, pos);
  pos += centralRecords.length;
  out.set(eocd, pos);
  return out;
}

export function buildMinimalXlsxBytes(
  sheetName: string,
  rows: Array<Array<string | number>>
): Uint8Array {
  const encoder = new TextEncoder();
  const safeSheet = escapeXmlText(sheetName.slice(0, 31) || 'Modelo');

  const sheetRowsXml = rows
    .map((row, rIdx) => {
      const rNum = rIdx + 1;
      const cellsXml = row
        .map((cell, cIdx) => {
          const ref = `${colIndexToLetters(cIdx)}${rNum}`;
          if (typeof cell === 'number' && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${escapeXmlText(cell)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rNum}">${cellsXml}</row>`;
    })
    .join('');

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="${safeSheet}" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${sheetRowsXml}</sheetData>
</worksheet>`;

  return buildStoreZip([
    { path: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { path: '_rels/.rels', data: encoder.encode(rels) },
    { path: 'xl/workbook.xml', data: encoder.encode(workbook) },
    { path: 'xl/_rels/workbook.xml.rels', data: encoder.encode(wbRels) },
    { path: 'xl/styles.xml', data: encoder.encode(styles) },
    { path: 'xl/worksheets/sheet1.xml', data: encoder.encode(worksheet) },
  ]);
}

function getSampleProductRows(taxRegime: AngolaTaxRegime): Array<Array<string | number>> {
  const defaultRate = taxRegime === 'GERAL' ? 14 : 0;
  const defaultExemptCode = taxRegime === 'EXCLUSAO' ? 'M80' : taxRegime === 'SIMPLIFICADO' ? 'M81' : '';
  const zeroExemptCode = taxRegime === 'EXCLUSAO' ? 'M80' : taxRegime === 'SIMPLIFICADO' ? 'M81' : 'M10';

  return [
    [
      'codigo',
      'nome',
      'preco',
      'custo',
      'iva',
      'codigo_isencao',
      'categoria',
      'unidade',
      'tipo',
      'codigo_barras',
      'controlar_stock',
      'stock',
      'stock_minimo',
    ],
    ['ART0001', 'Arroz Agulha 25kg', 24500, 19800, 0, zeroExemptCode, 'Mercearia', 'sc', 'P', '5601001000011', 'SIM', 40, 10],
    ['ART0002', 'Óleo Alimentar 1L', 2350, 1850, defaultRate, defaultExemptCode, 'Mercearia', 'un', 'P', '5601001000028', 'SIM', 120, 20],
    ['ART0003', 'Água Mineral Pura 1,5L', 450, 280, defaultRate, defaultExemptCode, 'Bebidas', 'un', 'P', '5601001000035', 'SIM', 240, 48],
    ['ART0004', 'Serviço de Entrega Local', 2500, 0, defaultRate, defaultExemptCode, 'Serviços', 'srv', 'S', '', 'NAO', 0, 0],
  ];
}

function getSampleCustomerRows(): Array<Array<string | number>> {
  return [
    [
      'nome',
      'tipo',
      'nif',
      'telefone',
      'email',
      'morada',
      'localidade',
      'provincia',
      'municipio',
      'limite_credito',
      'prazo',
    ],
    [
      'Kiala Distribuição, Lda',
      'EMPRESA',
      '5401122330',
      '923400500',
      'compras@kiala.ao',
      'Rua da Missão, n.º 45',
      'Luanda',
      'Luanda',
      'Ingombota',
      250000,
      '30 dias',
    ],
    [
      'Maria Domingos',
      'PARTICULAR',
      '005123456LA042',
      '912334455',
      '',
      'Bairro Mártires de Kifangondo',
      'Luanda',
      'Luanda',
      'Maianga',
      0,
      'Pronto pagamento',
    ],
  ];
}

export function buildSampleProductsCsv(taxRegime: AngolaTaxRegime): string {
  return buildCsvDocument(getSampleProductRows(taxRegime));
}

export function buildSampleProductsXlsx(taxRegime: AngolaTaxRegime): Uint8Array {
  return buildMinimalXlsxBytes('Produtos', getSampleProductRows(taxRegime));
}

export function buildSampleCustomersCsv(): string {
  return buildCsvDocument(getSampleCustomerRows());
}

export function buildSampleCustomersXlsx(): Uint8Array {
  return buildMinimalXlsxBytes('Clientes', getSampleCustomerRows());
}

// ==================== VALIDAÇÃO E PRÉ-VISUALIZAÇÃO DE PRODUTOS ====================

type ProductColKey =
  | 'code'
  | 'name'
  | 'price'
  | 'costPrice'
  | 'ivaRate'
  | 'exemptionCode'
  | 'category'
  | 'unit'
  | 'type'
  | 'barcode'
  | 'trackStock'
  | 'stockQty'
  | 'minStockQty'
  | 'active';

const PRODUCT_HEADER_ALIASES: Record<string, ProductColKey> = {
  codigo: 'code',
  cod: 'code',
  code: 'code',
  sku: 'code',
  ref: 'code',
  referencia: 'code',
  codigo_artigo: 'code',
  codigo_produto: 'code',
  nome: 'name',
  name: 'name',
  artigo: 'name',
  produto: 'name',
  descricao: 'name',
  designacao: 'name',
  titulo: 'name',
  preco: 'price',
  price: 'price',
  pvp: 'price',
  preco_venda: 'price',
  valor: 'price',
  unit_price: 'price',
  custo: 'costPrice',
  preco_custo: 'costPrice',
  preco_compra: 'costPrice',
  cost: 'costPrice',
  cost_price: 'costPrice',
  iva: 'ivaRate',
  taxa_iva: 'ivaRate',
  taxa: 'ivaRate',
  tax: 'ivaRate',
  vat: 'ivaRate',
  iva_rate: 'ivaRate',
  codigo_isencao: 'exemptionCode',
  motivo_isencao: 'exemptionCode',
  isencao: 'exemptionCode',
  exemption: 'exemptionCode',
  exemption_code: 'exemptionCode',
  exemption_reason: 'exemptionCode',
  categoria: 'category',
  category: 'category',
  familia: 'category',
  grupo: 'category',
  unidade: 'unit',
  unit: 'unit',
  un: 'unit',
  uom: 'unit',
  tipo: 'type',
  type: 'type',
  natureza: 'type',
  codigo_barras: 'barcode',
  barras: 'barcode',
  ean: 'barcode',
  barcode: 'barcode',
  controlar_stock: 'trackStock',
  controlo_stock: 'trackStock',
  track_stock: 'trackStock',
  stock: 'stockQty',
  qtd: 'stockQty',
  quantidade: 'stockQty',
  stock_atual: 'stockQty',
  stock_qty: 'stockQty',
  qty: 'stockQty',
  stock_minimo: 'minStockQty',
  minimo: 'minStockQty',
  min_stock: 'minStockQty',
  min_stock_qty: 'minStockQty',
  alerta_stock: 'minStockQty',
  ativo: 'active',
  activo: 'active',
  active: 'active',
  estado: 'active',
};

function mapColumns<T extends string>(
  headers: string[],
  aliases: Record<string, T>
): Partial<Record<T, number>> {
  const map: Partial<Record<T, number>> = {};
  headers.forEach((h, idx) => {
    const key = normalizeHeaderKey(h);
    const mapped = aliases[key];
    if (mapped && map[mapped] === undefined) {
      map[mapped] = idx;
    }
  });
  return map;
}

function normalizeProductTypeInput(raw: string): ProductType {
  const norm = normalizeHeaderKey(raw);
  if (!norm) return 'P';
  if (norm === 's' || norm.startsWith('serv')) return 'S';
  if (norm === 'k' || norm.startsWith('kit') || norm.startsWith('comb')) return 'K';
  return 'P';
}

function normalizeTaxRateExact(num: number): TaxRate | null {
  if (num === 0 || num === 1 || num === 5 || num === 7 || num === 14) {
    return num;
  }
  return null;
}

export function prepareProductImportBatch(params: {
  parsed: ParsedSpreadsheetResult;
  companyId: string;
  taxRegime: AngolaTaxRegime;
  defaultExemptionCode?: AgtIvaExemptionCode;
  existingProducts: Product[];
  duplicateMode: ImportDuplicateMode;
  defaultIvaRate?: TaxRate;
}): StagedProductImportBatch {
  const {
    parsed,
    companyId,
    taxRegime,
    defaultExemptionCode,
    existingProducts,
    duplicateMode,
    defaultIvaRate,
  } = params;

  const colMap = mapColumns(parsed.headers, PRODUCT_HEADER_ALIASES);
  const detectedColumns = Object.keys(colMap);
  const nowIso = new Date().toISOString();
  const batchSeed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const existingByCode = new Map<string, Product>();
  const existingByBarcode = new Map<string, Product>();
  for (const p of existingProducts) {
    const codeKey = p.code.trim().toLowerCase();
    if (codeKey) existingByCode.set(codeKey, p);
    const bcKey = (p.barcode || '').trim().toLowerCase();
    if (bcKey) existingByBarcode.set(bcKey, p);
  }

  const seenFileCodes = new Set<string>();
  const seenFileBarcodes = new Set<string>();
  let autoCodeSeq = existingProducts.length + 1;

  const getCell = (row: string[], key: ProductColKey): string => {
    const idx = colMap[key];
    return idx !== undefined ? String(row[idx] ?? '').trim() : '';
  };

  const rows: StagedProductImportRow[] = [];
  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;
  let duplicateSkipCount = 0;

  const missingHeaderErrors: string[] = [];
  if (colMap.name === undefined) {
    missingHeaderErrors.push('Coluna "nome" / "artigo" não identificada no cabeçalho.');
  }
  if (colMap.price === undefined) {
    missingHeaderErrors.push('Coluna "preco" / "pvp" não identificada no cabeçalho.');
  }

  for (let i = 0; i < parsed.rows.length; i += 1) {
    const rawRow = parsed.rows[i]!;
    if (rawRow.every((c) => !String(c || '').trim())) continue;

    const rowNumber = i + 2; // linha 1 é cabeçalho
    const rawCode = getCell(rawRow, 'code');
    const rawName = getCell(rawRow, 'name');
    const rawPrice = getCell(rawRow, 'price');
    const rawCost = getCell(rawRow, 'costPrice');
    const rawIva = getCell(rawRow, 'ivaRate');
    const rawExempt = getCell(rawRow, 'exemptionCode');
    const rawCategory = getCell(rawRow, 'category');
    const rawUnit = getCell(rawRow, 'unit');
    const rawType = getCell(rawRow, 'type');
    const rawBarcode = getCell(rawRow, 'barcode');
    const rawTrack = getCell(rawRow, 'trackStock');
    const rawStock = getCell(rawRow, 'stockQty');
    const rawMinStock = getCell(rawRow, 'minStockQty');
    const rawActive = getCell(rawRow, 'active');

    const errors: string[] = [...missingHeaderErrors];
    const warnings: string[] = [];

    if (!rawName) {
      errors.push('Nome do artigo obrigatório.');
    }

    const parsedPrice = parseFlexibleNumber(rawPrice);
    if (!rawPrice || Number.isNaN(parsedPrice) || parsedPrice < 0 || parsedPrice > 999999999) {
      errors.push('Preço de venda inválido.');
    }

    let costPrice: number | undefined;
    if (rawCost) {
      const parsedCost = parseFlexibleNumber(rawCost);
      if (Number.isNaN(parsedCost) || parsedCost < 0 || parsedCost > 999999999) {
        errors.push('Preço de custo inválido.');
      } else {
        costPrice = roundKz(parsedCost);
      }
    }

    let ivaRate: TaxRate =
      defaultIvaRate !== undefined
        ? defaultIvaRate
        : taxRegime === 'GERAL'
          ? 14
          : 0;

    if (rawIva !== '') {
      const parsedIva = parseFlexibleNumber(rawIva);
      const exactRate = normalizeTaxRateExact(parsedIva);
      if (exactRate === null) {
        errors.push(`Taxa IVA "${rawIva}" inválida (use 0, 1, 5, 7 ou 14).`);
      } else {
        ivaRate = exactRate;
      }
    }

    let exemptionCode: AgtIvaExemptionCode | undefined;
    let exemptionReason = '';
    if (ivaRate === 0) {
      const candidateUpper = rawExempt.trim().toUpperCase() as AgtIvaExemptionCode;
      if (rawExempt && AGT_IVA_EXEMPTION_CODES[candidateUpper]) {
        exemptionCode = candidateUpper;
        exemptionReason = AGT_IVA_EXEMPTION_CODES[candidateUpper].descriptionPt;
      } else if (rawExempt) {
        // Permite motivo textual desde que vinculado ao código padrão do regime
        exemptionCode = resolveDefaultExemptionCodeForCompany({
          taxRegime,
          defaultExemptionCode,
        });
        exemptionReason = rawExempt.slice(0, 120);
      } else {
        exemptionCode = resolveDefaultExemptionCodeForCompany({
          taxRegime,
          defaultExemptionCode,
        });
        exemptionReason =
          AGT_IVA_EXEMPTION_CODES[exemptionCode]?.descriptionPt ||
          DEFAULT_IVA_EXEMPTION_REASONS[0];
      }
    }

    const productType = normalizeProductTypeInput(rawType);
    const hasStockQtyInput = rawStock !== '';
    const parsedStock = hasStockQtyInput ? parseFlexibleNumber(rawStock) : 0;
    if (hasStockQtyInput && (Number.isNaN(parsedStock) || parsedStock < -999999 || parsedStock > 99999999)) {
      errors.push('Quantidade em stock inválida.');
    }
    const parsedMinStock = rawMinStock !== '' ? parseFlexibleNumber(rawMinStock) : 0;
    if (rawMinStock !== '' && (Number.isNaN(parsedMinStock) || parsedMinStock < 0)) {
      errors.push('Stock mínimo inválido.');
    }

    const trackStock =
      productType === 'S'
        ? false
        : rawTrack
          ? parseBooleanFlag(rawTrack, true)
          : hasStockQtyInput || rawMinStock !== '';

    let code = rawCode.slice(0, 32);
    if (!code) {
      while (
        existingByCode.has(`art${String(autoCodeSeq).padStart(4, '0')}`) ||
        seenFileCodes.has(`art${String(autoCodeSeq).padStart(4, '0')}`)
      ) {
        autoCodeSeq += 1;
      }
      code = `ART${String(autoCodeSeq).padStart(4, '0')}`;
      autoCodeSeq += 1;
      warnings.push(`Código gerado automaticamente: ${code}`);
    }

    const codeKey = code.toLowerCase();
    const barcode = rawBarcode.slice(0, 64);
    const barcodeKey = barcode.toLowerCase();

    if (seenFileCodes.has(codeKey)) {
      errors.push(`Código "${code}" duplicado dentro do próprio ficheiro.`);
    } else {
      seenFileCodes.add(codeKey);
    }

    if (barcodeKey) {
      if (seenFileBarcodes.has(barcodeKey)) {
        errors.push(`Código de barras "${barcode}" duplicado no ficheiro.`);
      } else {
        seenFileBarcodes.add(barcodeKey);
      }
    }

    if (errors.length > 0) {
      errorCount += 1;
      rows.push({
        rowNumber,
        status: 'ERROR',
        errors,
        warnings,
        rawCode: code,
        rawName,
        rawPrice,
        rawIva: String(ivaRate),
        rawStock: rawStock || '0',
      });
      continue;
    }

    const matchedExisting =
      existingByCode.get(codeKey) ||
      (barcodeKey ? existingByBarcode.get(barcodeKey) : undefined);

    if (matchedExisting && duplicateMode === 'SKIP') {
      duplicateSkipCount += 1;
      rows.push({
        rowNumber,
        status: 'DUPLICATE_SKIP',
        errors: [],
        warnings: [`Artigo já existe (${matchedExisting.code}) — ignorado.`],
        rawCode: code,
        rawName,
        rawPrice: String(roundKz(parsedPrice)),
        rawIva: String(ivaRate),
        rawStock: String(trackStock ? Math.round(parsedStock * 1000) / 1000 : 0),
        existingProductId: matchedExisting.id,
      });
      continue;
    }

    const cleanUnit = (rawUnit || (productType === 'S' ? 'srv' : 'un')).slice(0, 16);
    const cleanCategory = (rawCategory || (productType === 'S' ? 'Serviços' : 'Geral')).slice(0, 48);
    const isActive = rawActive ? parseBooleanFlag(rawActive, true) : true;
    const cleanPrice = roundKz(parsedPrice);
    const cleanStock = trackStock ? Math.max(0, Math.round(parsedStock * 1000) / 1000) : 0;
    const cleanMinStock = trackStock ? Math.max(0, Math.round(parsedMinStock * 1000) / 1000) : 0;

    const product: Product = matchedExisting
      ? {
          ...matchedExisting,
          companyId,
          code,
          ...(barcode ? { barcode } : {}),
          name: rawName.slice(0, 160),
          productType,
          category: cleanCategory,
          unit: cleanUnit,
          price: cleanPrice,
          ...(costPrice !== undefined ? { costPrice } : {}),
          ivaRate,
          ...(ivaRate === 0 && exemptionCode ? { exemptionCode } : { exemptionCode: undefined }),
          exemptionReason: ivaRate === 0 ? exemptionReason : '',
          trackStock,
          stockQty: trackStock ? cleanStock : matchedExisting.stockQty,
          minStockQty: trackStock ? cleanMinStock : matchedExisting.minStockQty,
          active: isActive,
          syncState: 'pending',
          synced: false,
          updatedAtIso: nowIso,
        }
      : {
          id: `prod_${batchSeed}_${rowNumber}`,
          companyId,
          code,
          ...(barcode ? { barcode } : {}),
          name: rawName.slice(0, 160),
          productType,
          category: cleanCategory,
          unit: cleanUnit,
          price: cleanPrice,
          ...(costPrice !== undefined ? { costPrice } : {}),
          ivaRate,
          ...(ivaRate === 0 && exemptionCode ? { exemptionCode } : {}),
          exemptionReason: ivaRate === 0 ? exemptionReason : '',
          trackStock,
          stockQty: cleanStock,
          minStockQty: cleanMinStock,
          active: isActive,
          syncState: 'pending',
          synced: false,
          createdAtIso: nowIso,
          updatedAtIso: nowIso,
        };

    if (matchedExisting) {
      updateCount += 1;
    } else {
      newCount += 1;
    }

    rows.push({
      rowNumber,
      status: matchedExisting ? 'UPDATE' : 'NEW',
      errors: [],
      warnings,
      rawCode: code,
      rawName: product.name,
      rawPrice: String(product.price),
      rawIva: String(product.ivaRate),
      rawStock: product.trackStock ? String(product.stockQty ?? 0) : '—',
      product,
      existingProductId: matchedExisting?.id,
    });
  }

  return {
    id: `imp_prod_${batchSeed}`,
    fileName: parsed.fileName,
    format: parsed.format,
    createdAtIso: nowIso,
    duplicateMode,
    detectedColumns,
    totalRows: rows.length,
    newCount,
    updateCount,
    errorCount,
    duplicateSkipCount,
    excludedRowNumbers: [],
    rows,
  };
}

export function applyStagedProductImportBatch(params: {
  batch: StagedProductImportBatch;
  existingProducts: Product[];
}): AppliedProductImportResult {
  const excludedSet = new Set(params.batch.excludedRowNumbers);
  const existingMap = new Map(params.existingProducts.map((p) => [p.id, p]));

  const toSave: Product[] = [];
  const createdIds: string[] = [];
  const previousSnapshots: Product[] = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const row of params.batch.rows) {
    if (excludedSet.has(row.rowNumber)) continue;
    if ((row.status !== 'NEW' && row.status !== 'UPDATE') || !row.product) continue;

    toSave.push(row.product);
    if (row.status === 'UPDATE' && row.existingProductId) {
      const prev = existingMap.get(row.existingProductId);
      if (prev) previousSnapshots.push(prev);
      updatedCount += 1;
    } else {
      createdIds.push(row.product.id);
      createdCount += 1;
    }
  }

  return {
    toSave,
    createdCount,
    updatedCount,
    createdIds,
    previousSnapshots,
  };
}

// ==================== VALIDAÇÃO E PRÉ-VISUALIZAÇÃO DE CLIENTES ====================

type CustomerColKey =
  | 'name'
  | 'customerType'
  | 'nif'
  | 'phone'
  | 'email'
  | 'address'
  | 'locality'
  | 'province'
  | 'municipality'
  | 'countryCode'
  | 'creditLimit'
  | 'paymentTerms'
  | 'notes';

const CUSTOMER_HEADER_ALIASES: Record<string, CustomerColKey> = {
  nome: 'name',
  name: 'name',
  cliente: 'name',
  razao_social: 'name',
  denominacao: 'name',
  empresa: 'name',
  tipo: 'customerType',
  tipo_cliente: 'customerType',
  customer_type: 'customerType',
  type: 'customerType',
  nif: 'nif',
  contribuinte: 'nif',
  bi: 'nif',
  tax_id: 'nif',
  telefone: 'phone',
  tel: 'phone',
  telemovel: 'phone',
  whatsapp: 'phone',
  contacto: 'phone',
  phone: 'phone',
  email: 'email',
  e_mail: 'email',
  correio: 'email',
  morada: 'address',
  endereco: 'address',
  rua: 'address',
  address: 'address',
  localidade: 'locality',
  cidade: 'locality',
  locality: 'locality',
  city: 'locality',
  provincia: 'province',
  province: 'province',
  municipio: 'municipality',
  municipality: 'municipality',
  pais: 'countryCode',
  codigo_pais: 'countryCode',
  country: 'countryCode',
  country_code: 'countryCode',
  limite_credito: 'creditLimit',
  limite: 'creditLimit',
  credito: 'creditLimit',
  credit_limit: 'creditLimit',
  prazo: 'paymentTerms',
  condicoes_pagamento: 'paymentTerms',
  payment_terms: 'paymentTerms',
  notas: 'notes',
  observacoes: 'notes',
  notes: 'notes',
};

function inferImportCustomerType(rawType: string, rawNif: string, rawCountry: string): CustomerType {
  const norm = normalizeHeaderKey(rawType);
  if (norm === 'empresa_nacional' || norm === 'empresa' || norm === 'coletivo') {
    return 'EMPRESA';
  }
  if (norm === 'particular_nacional' || norm === 'particular' || norm === 'singular') {
    return 'PARTICULAR';
  }
  if (norm === 'estrangeiro' || norm === 'foreign' || norm === 'internacional') {
    return 'ESTRANGEIRO';
  }
  if (norm === 'consumidor_final') {
    return 'CONSUMIDOR_FINAL';
  }
  const cCode = rawCountry.trim().toUpperCase();
  if (cCode && cCode !== 'AO' && cCode !== 'ANGOLA') {
    return 'ESTRANGEIRO';
  }
  const cleanNif = rawNif.replace(/[\s.-]+/g, '');
  if (/^5\d{8,9}$/.test(cleanNif)) {
    return 'EMPRESA';
  }
  if (cleanNif) {
    return 'PARTICULAR';
  }
  return 'PARTICULAR';
}

function normalizeCustomerPaymentTermsInput(
  rawTerms: string,
  creditLimit: number
): CustomerPaymentTerms {
  const norm = normalizeHeaderKey(rawTerms);
  if (norm === 'imediato' || norm === 'pronto_pagamento' || norm === 'pronto' || norm === 'a_vista') {
    return 'IMEDIATO';
  }
  if (norm === '15_dias' || norm === '15dias' || norm === '15') return '15_DIAS';
  if (norm === '30_dias' || norm === '30dias' || norm === '30') return '30_DIAS';
  if (norm === '45_dias' || norm === '45dias' || norm === '45') return '45_DIAS';
  if (norm === '60_dias' || norm === '60dias' || norm === '60') return '60_DIAS';
  if (norm === 'personalizado' || norm === 'custom') return 'PERSONALIZADO';
  return creditLimit > 0 ? '30_DIAS' : 'IMEDIATO';
}

export function prepareCustomerImportBatch(params: {
  parsed: ParsedSpreadsheetResult;
  companyId: string;
  existingCustomers: Customer[];
  duplicateMode: ImportDuplicateMode;
}): StagedCustomerImportBatch {
  const { parsed, companyId, existingCustomers, duplicateMode } = params;
  const colMap = mapColumns(parsed.headers, CUSTOMER_HEADER_ALIASES);
  const detectedColumns = Object.keys(colMap);
  const nowIso = new Date().toISOString();
  const batchSeed = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  const existingByNif = new Map<string, Customer>();
  const existingByName = new Map<string, Customer>();
  for (const c of existingCustomers) {
    const nifKey = (c.normalizedNif || c.nif || '').trim().toUpperCase();
    if (nifKey && nifKey !== '999999999' && nifKey !== 'CONSUMIDOR_FINAL') {
      existingByNif.set(nifKey, c);
    }
    const nameKey = c.name.trim().toLowerCase();
    if (nameKey) existingByName.set(nameKey, c);
  }

  // Simula incremento sequencial sem colisão de CLI-XXXX dentro do lote
  const virtualCustomerAccumulator: Customer[] = [...existingCustomers];
  const seenFileNifs = new Set<string>();
  const seenFileNames = new Set<string>();

  const getCell = (row: string[], key: CustomerColKey): string => {
    const idx = colMap[key];
    return idx !== undefined ? String(row[idx] ?? '').trim() : '';
  };

  const rows: StagedCustomerImportRow[] = [];
  let newCount = 0;
  let updateCount = 0;
  let errorCount = 0;
  let duplicateSkipCount = 0;

  const missingHeaderErrors: string[] = [];
  if (colMap.name === undefined) {
    missingHeaderErrors.push('Coluna "nome" / "cliente" não identificada no cabeçalho.');
  }

  for (let i = 0; i < parsed.rows.length; i += 1) {
    const rawRow = parsed.rows[i]!;
    if (rawRow.every((c) => !String(c || '').trim())) continue;

    const rowNumber = i + 2;
    const rawName = getCell(rawRow, 'name');
    const rawType = getCell(rawRow, 'customerType');
    const rawNif = getCell(rawRow, 'nif');
    const rawPhone = getCell(rawRow, 'phone');
    const rawEmail = getCell(rawRow, 'email');
    const rawAddress = getCell(rawRow, 'address');
    const rawLocality = getCell(rawRow, 'locality');
    const rawProvince = getCell(rawRow, 'province');
    const rawMunicipality = getCell(rawRow, 'municipality');
    const rawCountry = getCell(rawRow, 'countryCode');
    const rawCredit = getCell(rawRow, 'creditLimit');
    const rawTerms = getCell(rawRow, 'paymentTerms');
    const rawNotes = getCell(rawRow, 'notes');

    if (missingHeaderErrors.length > 0) {
      errorCount += 1;
      rows.push({
        rowNumber,
        status: 'ERROR',
        errors: [...missingHeaderErrors],
        warnings: [],
        rawName,
        rawNif,
        rawPhone,
        rawCity: rawLocality || rawProvince || '',
      });
      continue;
    }

    const customerType = inferImportCustomerType(rawType, rawNif, rawCountry);
    let creditLimit = 0;
    const extraErrors: string[] = [];
    if (rawCredit) {
      const parsedLimit = parseFlexibleNumber(rawCredit);
      if (Number.isNaN(parsedLimit) || parsedLimit < 0) {
        extraErrors.push('Limite de crédito inválido.');
      } else {
        creditLimit = roundKz(parsedLimit);
      }
    }

    const nifKey = rawNif.replace(/[\s.-]+/g, '').toUpperCase();
    const nameKey = rawName.trim().toLowerCase();

    if (nifKey && nifKey !== '999999999') {
      if (seenFileNifs.has(nifKey)) {
        extraErrors.push(`NIF "${rawNif}" duplicado no ficheiro.`);
      } else {
        seenFileNifs.add(nifKey);
      }
    } else if (nameKey) {
      if (seenFileNames.has(nameKey)) {
        extraErrors.push(`Cliente "${rawName}" sem NIF duplicado no ficheiro.`);
      } else {
        seenFileNames.add(nameKey);
      }
    }

    const matchedExisting =
      (nifKey && existingByNif.get(nifKey)) ||
      (!nifKey && nameKey ? existingByName.get(nameKey) : undefined);

    if (matchedExisting && duplicateMode === 'SKIP' && extraErrors.length === 0) {
      duplicateSkipCount += 1;
      rows.push({
        rowNumber,
        status: 'DUPLICATE_SKIP',
        errors: [],
        warnings: [`Cliente já existe (${matchedExisting.name}) — ignorado.`],
        rawName,
        rawNif: rawNif || matchedExisting.nif,
        rawPhone,
        rawCity: rawLocality || rawProvince || matchedExisting.locality || '',
        existingCustomerId: matchedExisting.id,
      });
      continue;
    }

    const validTerms = normalizeCustomerPaymentTermsInput(rawTerms, creditLimit);

    const validation = validateAndBuildCustomer(
      {
        id: matchedExisting?.id || `cust_${batchSeed}_${rowNumber}`,
        companyId,
        internalCode:
          matchedExisting?.internalCode ||
          generateNextCustomerInternalCode(virtualCustomerAccumulator, companyId),
        customerType,
        active: true,
        name: rawName,
        nif: rawNif,
        countryCode: rawCountry || (customerType === 'ESTRANGEIRO' ? 'PT' : 'AO'),
        phone: rawPhone,
        email: rawEmail,
        address: rawAddress,
        locality: rawLocality || rawProvince || rawMunicipality || 'Luanda - Angola',
        province: rawProvince || undefined,
        municipality: rawMunicipality || undefined,
        creditLimit,
        hasCreditAccount: creditLimit > 0,
        paymentTerms: validTerms,
        notes: rawNotes || undefined,
      },
      {
        companyId,
        existingCustomers: virtualCustomerAccumulator,
        previousCustomer: matchedExisting || null,
        defaultLocality: 'Luanda - Angola',
        actorLabel: 'Importação Rápida',
      }
    );

    if (extraErrors.length > 0 || !validation.ok || !validation.customer) {
      errorCount += 1;
      rows.push({
        rowNumber,
        status: 'ERROR',
        errors: [...extraErrors, ...(validation.error ? [validation.error] : [])],
        warnings: [],
        rawName,
        rawNif,
        rawPhone,
        rawCity: rawLocality || rawProvince || '',
      });
      continue;
    }

    const builtCustomer: Customer = {
      ...validation.customer,
      syncState: 'pending',
      synced: false,
      updatedAtIso: nowIso,
    };

    if (!matchedExisting) {
      virtualCustomerAccumulator.push(builtCustomer);
      newCount += 1;
    } else {
      updateCount += 1;
    }

    rows.push({
      rowNumber,
      status: matchedExisting ? 'UPDATE' : 'NEW',
      errors: [],
      warnings: [],
      rawName: builtCustomer.name,
      rawNif: builtCustomer.nif || '—',
      rawPhone: builtCustomer.phone || '—',
      rawCity: builtCustomer.province || builtCustomer.locality || '—',
      customer: builtCustomer,
      existingCustomerId: matchedExisting?.id,
    });
  }

  return {
    id: `imp_cust_${batchSeed}`,
    fileName: parsed.fileName,
    format: parsed.format,
    createdAtIso: nowIso,
    duplicateMode,
    detectedColumns,
    totalRows: rows.length,
    newCount,
    updateCount,
    errorCount,
    duplicateSkipCount,
    excludedRowNumbers: [],
    rows,
  };
}

export function applyStagedCustomerImportBatch(params: {
  batch: StagedCustomerImportBatch;
  existingCustomers: Customer[];
}): AppliedCustomerImportResult {
  const excludedSet = new Set(params.batch.excludedRowNumbers);
  const existingMap = new Map(params.existingCustomers.map((c) => [c.id, c]));

  const toSave: Customer[] = [];
  const createdIds: string[] = [];
  const previousSnapshots: Customer[] = [];
  let createdCount = 0;
  let updatedCount = 0;

  for (const row of params.batch.rows) {
    if (excludedSet.has(row.rowNumber)) continue;
    if ((row.status !== 'NEW' && row.status !== 'UPDATE') || !row.customer) continue;

    toSave.push(row.customer);
    if (row.status === 'UPDATE' && row.existingCustomerId) {
      const prev = existingMap.get(row.existingCustomerId);
      if (prev) previousSnapshots.push(prev);
      updatedCount += 1;
    } else {
      createdIds.push(row.customer.id);
      createdCount += 1;
    }
  }

  return {
    toSave,
    createdCount,
    updatedCount,
    createdIds,
    previousSnapshots,
  };
}
