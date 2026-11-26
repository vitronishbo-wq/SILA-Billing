import QRCode from 'qrcode';
import {
  calculateInvoiceTotals,
  formatDateTimePt,
  formatKzNumber,
  roundKz,
} from './billingEngine.ts';
import { kwanzaToWords } from './extenso.ts';
import { buildAgtQrCanonicalString } from './fiscalQrGenerator.ts';
import { computeDocumentSaftHash4 } from './saftGenerator.ts';
import {
  formatDocumentTypeLabelPt,
  resolveCompanyProfileFromSnapshot,
  resolveEstablishmentLocality,
} from './types.ts';
import type {
  CartDraftItem,
  CompanyProfile,
  Customer,
  DirectPaymentMethod,
  InvoiceRecord,
  Product,
} from './types.ts';

export const SILA_PDF_SIGNATURE = 'Emitido por SILA-Billing';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN_L = 40;
const MARGIN_R = 555.28;
const CONTENT_W = MARGIN_R - MARGIN_L; // ~515.28pt
const MARGIN_TOP = 800;
const MARGIN_BOTTOM = 54;

/**
 * Mapeamento de caracteres Unicode frequentes em Português para WinAnsi (Windows-1252)
 * suportado nativamente por /WinAnsiEncoding em PDF 1.4 sem fontes embebidas pesadas.
 */
const WINANSI_MAP: Record<number, number> = {
  0x20ac: 0x80, // €
  0x201a: 0x82,
  0x201e: 0x84,
  0x2026: 0x85, // …
  0x2020: 0x86,
  0x2021: 0x87,
  0x2030: 0x89,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x2122: 0x99,
};

function encodePdfWinAnsiStringBytes(text: string): number[] {
  const bytes: number[] = [0x28]; // '('
  const clean = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\t/g, ' ');

  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    let byte = 0x20;
    if (code >= 0x20 && code <= 0x7e) {
      byte = code;
    } else if (code >= 0xa0 && code <= 0xff) {
      byte = code;
    } else if (WINANSI_MAP[code] !== undefined) {
      byte = WINANSI_MAP[code]!;
    } else {
      // Normalizar acentos ou símbolos raros fora de WinAnsi (ex: emojis)
      const fallback = clean[i]!
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const fc = fallback.charCodeAt(0);
      byte = fc >= 0x20 && fc <= 0x7e ? fc : 0x20;
    }

    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      // Escapar '(', ')' e '\'
      bytes.push(0x5c, byte);
    } else {
      bytes.push(byte);
    }
  }
  bytes.push(0x29); // ')'
  return bytes;
}

type PdfFontKey = 'F1' | 'F2' | 'F3' | 'F4';

function estimateTextWidth(text: string, fontSize: number, font: PdfFontKey): number {
  const s = String(text || '');
  if (font === 'F3' || font === 'F4') {
    return s.length * fontSize * 0.6;
  }
  const boldFactor = font === 'F2' ? 1.07 : 1.0;
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ('ilIjtf.,:;!|\'" '.includes(ch)) units += 0.3;
    else if ('mwMWOQGD@%'.includes(ch)) units += 0.78;
    else if (ch >= 'A' && ch <= 'Z') units += 0.64;
    else if (ch >= '0' && ch <= '9') units += 0.56;
    else units += 0.52;
  }
  return units * fontSize * boldFactor;
}

function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  font: PdfFontKey = 'F1'
): string[] {
  const normalized = String(text || '').trim().replace(/\s+/g, ' ');
  if (!normalized) return [''];
  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize, font) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      if (estimateTextWidth(word, fontSize, font) <= maxWidth) {
        current = word;
      } else {
        // Partir palavra longa se exceder largura da coluna
        let chunk = '';
        for (const ch of word) {
          if (estimateTextWidth(chunk + ch, fontSize, font) <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

function truncateTextToWidth(
  text: string,
  maxWidth: number,
  fontSize: number,
  font: PdfFontKey = 'F1'
): string {
  const raw = String(text || '').trim();
  if (estimateTextWidth(raw, fontSize, font) <= maxWidth) return raw;
  let out = raw;
  while (out.length > 1 && estimateTextWidth(`${out}...`, fontSize, font) > maxWidth) {
    out = out.slice(0, -1);
  }
  return out.length < raw.length ? `${out.trim()}...` : out;
}

class PdfDocumentBuilder {
  private pages: number[][] = [];
  private currentStream: number[] = [];
  private cursorY = MARGIN_TOP;
  private asciiEncoder = new TextEncoder();
  private readonly footerLeftText: string;

  constructor(footerLeftText = SILA_PDF_SIGNATURE) {
    this.footerLeftText = footerLeftText;
    this.startNewPage();
  }

  get y(): number {
    return this.cursorY;
  }

  set y(val: number) {
    this.cursorY = val;
  }

  startNewPage(): void {
    if (this.currentStream.length > 0) {
      this.pages.push(this.currentStream);
    }
    this.currentStream = [];
    this.cursorY = MARGIN_TOP;
  }

  ensureSpace(neededHeight: number, onNewPage?: () => void): boolean {
    if (this.cursorY - neededHeight < MARGIN_BOTTOM) {
      this.startNewPage();
      if (onNewPage) onNewPage();
      return true;
    }
    return false;
  }

  private pushAscii(cmd: string): void {
    const encoded = this.asciiEncoder.encode(cmd);
    for (let i = 0; i < encoded.length; i++) {
      this.currentStream.push(encoded[i]!);
    }
  }

  private pushBytes(bytes: number[]): void {
    for (let i = 0; i < bytes.length; i++) {
      this.currentStream.push(bytes[i]!);
    }
  }

  setFillRgb(r: number, g: number, b: number): void {
    this.pushAscii(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg\n`);
  }

  setStrokeRgb(r: number, g: number, b: number): void {
    this.pushAscii(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG\n`);
  }

  drawRectFill(x: number, yBottom: number, w: number, h: number, rgb: [number, number, number]): void {
    this.setFillRgb(rgb[0], rgb[1], rgb[2]);
    this.pushAscii(`${x.toFixed(2)} ${yBottom.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`);
  }

  drawRectStroke(
    x: number,
    yBottom: number,
    w: number,
    h: number,
    rgb: [number, number, number],
    lineWidth = 0.6
  ): void {
    this.setStrokeRgb(rgb[0], rgb[1], rgb[2]);
    this.pushAscii(`${lineWidth.toFixed(2)} w\n`);
    this.pushAscii(`${x.toFixed(2)} ${yBottom.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S\n`);
  }

  drawLine(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    rgb: [number, number, number] = [0.85, 0.88, 0.91],
    lineWidth = 0.6
  ): void {
    this.setStrokeRgb(rgb[0], rgb[1], rgb[2]);
    this.pushAscii(`${lineWidth.toFixed(2)} w\n`);
    this.pushAscii(`${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S\n`);
  }

  drawText(
    text: string,
    x: number,
    y: number,
    opts?: {
      font?: PdfFontKey;
      size?: number;
      color?: [number, number, number];
      align?: 'left' | 'right' | 'center';
      maxWidth?: number;
    }
  ): void {
    const font = opts?.font || 'F1';
    const size = opts?.size || 9;
    const color = opts?.color || [0.06, 0.09, 0.16];
    const align = opts?.align || 'left';
    const rawText = opts?.maxWidth ? truncateTextToWidth(text, opts.maxWidth, size, font) : text;

    let drawX = x;
    if (align === 'right') {
      drawX = x - estimateTextWidth(rawText, size, font);
    } else if (align === 'center') {
      drawX = x - estimateTextWidth(rawText, size, font) / 2;
    }

    this.pushAscii('BT\n');
    this.pushAscii(`/${font} ${size.toFixed(2)} Tf\n`);
    this.setFillRgb(color[0], color[1], color[2]);
    this.pushAscii(`1 0 0 1 ${drawX.toFixed(2)} ${y.toFixed(2)} Tm\n`);
    this.pushBytes(encodePdfWinAnsiStringBytes(rawText));
    this.pushAscii(' Tj\nET\n');
  }

  drawWrappedText(
    text: string,
    x: number,
    startY: number,
    maxWidth: number,
    opts?: {
      font?: PdfFontKey;
      size?: number;
      lineHeight?: number;
      color?: [number, number, number];
    }
  ): number {
    const font = opts?.font || 'F1';
    const size = opts?.size || 9;
    const lineHeight = opts?.lineHeight || size + 3;
    const lines = wrapText(text, maxWidth, size, font);
    let y = startY;
    for (const ln of lines) {
      this.drawText(ln, x, y, { font, size, color: opts?.color });
      y -= lineHeight;
    }
    return y;
  }

  drawQrMatrix(canonical: string, xLeft: number, yBottom: number, sizePt: number): boolean {
    try {
      const qr = QRCode.create(canonical, { errorCorrectionLevel: 'M' });
      const count = qr.modules.size;
      const data = qr.modules.data;
      const marginModules = 2;
      const totalModules = count + marginModules * 2;
      const cell = sizePt / totalModules;

      this.drawRectFill(xLeft, yBottom, sizePt, sizePt, [1, 1, 1]);
      this.drawRectStroke(xLeft, yBottom, sizePt, sizePt, [0.8, 0.84, 0.88], 0.5);
      this.setFillRgb(0, 0, 0);

      for (let r = 0; r < count; r++) {
        for (let c = 0; c < count; c++) {
          if (data[r * count + c]) {
            const mx = xLeft + (c + marginModules) * cell;
            // Em PDF o eixo Y cresce para cima; linha 0 do QR fica no topo
            const my = yBottom + sizePt - (r + marginModules + 1) * cell;
            this.pushAscii(
              `${mx.toFixed(2)} ${my.toFixed(2)} ${cell.toFixed(2)} ${cell.toFixed(2)} re f\n`
            );
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  build(): Uint8Array {
    if (this.currentStream.length > 0) {
      this.pages.push(this.currentStream);
      this.currentStream = [];
    }

    const totalPages = this.pages.length;

    // Acrescentar rodapé discreto em cada página
    for (let i = 0; i < totalPages; i++) {
      this.currentStream = this.pages[i]!;
      this.drawLine(MARGIN_L, 38, MARGIN_R, 38, [0.86, 0.89, 0.92], 0.5);
      this.drawText(this.footerLeftText, MARGIN_L, 26, {
        font: 'F1',
        size: 7.5,
        color: [0.45, 0.5, 0.58],
      });
      this.drawText(`Página ${i + 1} de ${totalPages}`, MARGIN_R, 26, {
        font: 'F1',
        size: 7.5,
        color: [0.45, 0.5, 0.58],
        align: 'right',
      });
    }
    this.currentStream = [];

    // Construir objectos PDF 1.4:
    // 1: Catalog, 2: Pages, 3..6: Fonts F1..F4, depois pares (Page, ContentStream)
    const objects: number[][] = [];
    const pageObjIds: number[] = [];

    const pushAsciiObj = (str: string): number => {
      const encoded = Array.from(this.asciiEncoder.encode(str));
      objects.push(encoded);
      return objects.length;
    };

    // 1: Catalog (placeholder atualizado após contar páginas)
    pushAsciiObj('');
    // 2: Pages (placeholder atualizado após contar páginas)
    pushAsciiObj('');
    // 3: F1 Helvetica
    pushAsciiObj(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
    );
    // 4: F2 Helvetica-Bold
    pushAsciiObj(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
    );
    // 5: F3 Courier
    pushAsciiObj(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>'
    );
    // 6: F4 Courier-Bold
    pushAsciiObj(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'
    );

    for (let i = 0; i < totalPages; i++) {
      const streamBytes = this.pages[i]!;
      const streamHeader = Array.from(
        this.asciiEncoder.encode(`<< /Length ${streamBytes.length} >>\nstream\n`)
      );
      const streamFooter = Array.from(this.asciiEncoder.encode('\nendstream'));
      objects.push([...streamHeader, ...streamBytes, ...streamFooter]);
      const contentObjId = objects.length;

      const pageObjId = pushAsciiObj(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(
          2
        )}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> /Contents ${contentObjId} 0 R >>`
      );
      pageObjIds.push(pageObjId);
    }

    objects[0] = Array.from(this.asciiEncoder.encode('<< /Type /Catalog /Pages 2 0 R >>'));
    objects[1] = Array.from(
      this.asciiEncoder.encode(
        `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>`
      )
    );

    // Serializar PDF final com tabela xref exata por byte offset
    const out: number[] = [];
    const appendAscii = (s: string) => {
      const enc = this.asciiEncoder.encode(s);
      for (let i = 0; i < enc.length; i++) out.push(enc[i]!);
    };

    appendAscii('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    const offsets: number[] = [0];

    for (let i = 0; i < objects.length; i++) {
      offsets.push(out.length);
      appendAscii(`${i + 1} 0 obj\n`);
      const objBytes = objects[i]!;
      for (let j = 0; j < objBytes.length; j++) out.push(objBytes[j]!);
      appendAscii('\nendobj\n');
    }

    const xrefOffset = out.length;
    appendAscii(`xref\n0 ${objects.length + 1}\n`);
    appendAscii('0000000000 65535 f \n');
    for (let i = 1; i <= objects.length; i++) {
      appendAscii(`${String(offsets[i]!).padStart(10, '0')} 00000 n \n`);
    }
    appendAscii(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    );

    return new Uint8Array(out);
  }
}

function drawCompanyHeaderBlock(
  pdf: PdfDocumentBuilder,
  company: CompanyProfile,
  rightTitle: string,
  rightSub1: string,
  rightSub2?: string,
  localityOverride?: string
): void {
  // Faixa superior discreta institucional
  pdf.drawRectFill(MARGIN_L, 808, CONTENT_W, 3.5, [0.11, 0.31, 0.85]);

  const topY = 792;
  const leftMaxW = 285;

  pdf.drawText(company.legalName || company.shortName || 'Empresa', MARGIN_L, topY, {
    font: 'F2',
    size: 12.5,
    color: [0.06, 0.09, 0.16],
    maxWidth: leftMaxW,
  });

  let ly = topY - 14;
  pdf.drawText(`NIF: ${company.nif || '---'}`, MARGIN_L, ly, {
    font: 'F2',
    size: 8.5,
    color: [0.22, 0.27, 0.35],
  });

  const regimeLabel =
    company.taxRegime === 'SIMPLIFICADO'
      ? 'Regime Simplificado de IVA'
      : company.taxRegime === 'EXCLUSAO'
        ? 'Regime de Exclusão de IVA'
        : 'Regime Geral de IVA';
  pdf.drawText(`· ${regimeLabel}`, MARGIN_L + 95, ly, {
    font: 'F1',
    size: 8.2,
    color: [0.38, 0.43, 0.51],
  });

  ly -= 12;
  const locality = localityOverride || resolveEstablishmentLocality(company);
  const fullAddr = [company.address, locality].filter(Boolean).join(' · ');
  ly = pdf.drawWrappedText(fullAddr, MARGIN_L, ly, leftMaxW, {
    font: 'F1',
    size: 8.2,
    lineHeight: 11,
    color: [0.35, 0.4, 0.48],
  });

  const contactLine = [
    company.phone ? `Tel: ${company.phone}` : '',
    company.whatsapp && company.whatsapp !== company.phone ? `WA: ${company.whatsapp}` : '',
    company.email || '',
  ]
    .filter(Boolean)
    .join(' · ');
  if (contactLine) {
    pdf.drawText(contactLine, MARGIN_L, ly, {
      font: 'F1',
      size: 8,
      color: [0.35, 0.4, 0.48],
      maxWidth: leftMaxW,
    });
    ly -= 11;
  }

  // Caixa documental à direita
  const boxW = 214;
  const boxX = MARGIN_R - boxW;
  const boxH = 54;
  const boxY = topY - boxH + 10;
  pdf.drawRectFill(boxX, boxY, boxW, boxH, [0.97, 0.98, 0.99]);
  pdf.drawRectStroke(boxX, boxY, boxW, boxH, [0.83, 0.87, 0.92], 0.7);
  pdf.drawText(rightTitle, boxX + boxW - 10, topY - 4, {
    font: 'F2',
    size: rightTitle.length > 20 ? 9.5 : 10.5,
    color: [0.11, 0.31, 0.85],
    align: 'right',
    maxWidth: boxW - 20,
  });
  pdf.drawText(rightSub1, boxX + boxW - 10, topY - 19, {
    font: 'F4',
    size: 10,
    color: [0.06, 0.09, 0.16],
    align: 'right',
    maxWidth: boxW - 20,
  });
  if (rightSub2) {
    pdf.drawText(rightSub2, boxX + boxW - 10, topY - 33, {
      font: 'F1',
      size: 8,
      color: [0.35, 0.4, 0.48],
      align: 'right',
      maxWidth: boxW - 20,
    });
  }

  pdf.y = Math.min(ly, boxY) - 10;
  pdf.drawLine(MARGIN_L, pdf.y + 4, MARGIN_R, pdf.y + 4, [0.85, 0.88, 0.92], 0.7);
  pdf.y -= 8;
}

function formatPaymentInstructionsLine(company: CompanyProfile): string[] {
  const out: string[] = [];
  if (company.iban1) {
    const bank = company.bankName1 ? `${company.bankName1}: ` : 'IBAN: ';
    const holder = company.accountHolder1 ? ` (${company.accountHolder1})` : '';
    out.push(`${bank}${company.iban1}${holder}`);
  }
  if (company.iban2) {
    const bank2 = company.bankName2 ? `${company.bankName2}: ` : 'IBAN 2: ';
    out.push(`${bank2}${company.iban2}`);
  }
  if (company.multicaixaExpressPhone) {
    out.push(`Multicaixa Express: ${company.multicaixaExpressPhone}`);
  }
  return out;
}

/**
 * 1. PDF Real de Factura (FR/FA/FT), Recibo (RC), Proforma (FP), Nota de Crédito/Débito (NC/ND)
 */
export function generateInvoicePdfBytes(
  invoice: InvoiceRecord,
  fallbackCompany: CompanyProfile,
  options?: {
    customerAddress?: string;
    customerPhone?: string;
    customerEmail?: string;
    titleOverride?: string;
  }
): Uint8Array {
  const company = resolveCompanyProfileFromSnapshot(invoice, fallbackCompany);
  const dt = formatDateTimePt(invoice.issuedAtIso);
  const docTitle = (options?.titleOverride || formatDocumentTypeLabelPt(invoice.docType)).toUpperCase();
  const estLocality = resolveEstablishmentLocality(company, {
    municipality: invoice.issuerSnapshot?.establishmentMunicipality || company.municipality,
    province: invoice.issuerSnapshot?.establishmentProvince || company.province,
  });

  const pdf = new PdfDocumentBuilder(SILA_PDF_SIGNATURE);
  drawCompanyHeaderBlock(
    pdf,
    company,
    docTitle,
    invoice.number,
    `Emitido em ${dt.slashDate} às ${dt.time}`,
    estLocality
  );

  // Bloco Cliente + Metadados Fiscais
  const metaY = pdf.y;
  const custBoxW = 310;
  const rightMetaX = MARGIN_L + custBoxW + 14;
  const custNifText =
    invoice.customerNif === '999999999'
      ? '999999999 (Consumidor Final)'
      : invoice.customerNif || 'Não informado';
  const custPhone = options?.customerPhone || invoice.customerPhone || '';
  const custAddress = options?.customerAddress || invoice.customerAddress || '';
  const custLoc = invoice.customerLocality || estLocality;

  pdf.drawText('DADOS DO ADQUIRENTE / CLIENTE', MARGIN_L, metaY, {
    font: 'F2',
    size: 7.5,
    color: [0.42, 0.47, 0.55],
  });
  pdf.drawText(invoice.customerName || 'Consumidor Final', MARGIN_L, metaY - 12, {
    font: 'F2',
    size: 10,
    maxWidth: custBoxW,
  });
  pdf.drawText(`NIF: ${custNifText}`, MARGIN_L, metaY - 24, {
    font: 'F1',
    size: 8.5,
    color: [0.22, 0.27, 0.35],
  });
  const custSub = [custAddress, custLoc, custPhone ? `Tel: ${custPhone}` : '']
    .filter(Boolean)
    .join(' · ');
  const afterCustY = pdf.drawWrappedText(custSub || estLocality, MARGIN_L, metaY - 35, custBoxW, {
    font: 'F1',
    size: 8,
    lineHeight: 10.5,
    color: [0.38, 0.43, 0.51],
  });

  // Coluna direita de estado / pagamento / operador
  const stateLabel =
    invoice.status === 'cancelled'
      ? 'ANULADO'
      : invoice.docType === 'FP'
        ? 'PROVISÓRIO / PROFORMA'
        : (invoice.amountDue || 0) > 0
          ? `EM DÍVIDA (${formatKzNumber(invoice.amountDue!)} Kz)`
          : 'PAGO / LIQUIDADO';
  pdf.drawText('ESTADO E PAGAMENTO', rightMetaX, metaY, {
    font: 'F2',
    size: 7.5,
    color: [0.42, 0.47, 0.55],
  });
  pdf.drawText(`Estado: ${stateLabel}`, rightMetaX, metaY - 12, {
    font: 'F2',
    size: 8.5,
    color: invoice.status === 'cancelled' ? [0.75, 0.14, 0.14] : [0.06, 0.09, 0.16],
    maxWidth: MARGIN_R - rightMetaX,
  });
  pdf.drawText(`Modalidade: ${invoice.paymentSummary || invoice.paymentMethod}`, rightMetaX, metaY - 24, {
    font: 'F1',
    size: 8.2,
    color: [0.25, 0.3, 0.38],
    maxWidth: MARGIN_R - rightMetaX,
  });
  pdf.drawText(`Caixa ${invoice.cashier} · Op. ${invoice.operator}`, rightMetaX, metaY - 35, {
    font: 'F1',
    size: 8,
    color: [0.38, 0.43, 0.51],
    maxWidth: MARGIN_R - rightMetaX,
  });

  pdf.y = Math.min(afterCustY, metaY - 46) - 10;

  // Tabela de Linhas
  const drawTableHeader = () => {
    const h = 18;
    pdf.drawRectFill(MARGIN_L, pdf.y - h + 5, CONTENT_W, h, [0.94, 0.96, 0.98]);
    pdf.drawLine(MARGIN_L, pdf.y - h + 5, MARGIN_R, pdf.y - h + 5, [0.8, 0.84, 0.89], 0.6);
    const ty = pdf.y - 7;
    pdf.drawText('COD.', MARGIN_L + 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('DESCRIÇÃO', MARGIN_L + 54, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('QTD/UN', MARGIN_L + 286, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('P. UNIT.', MARGIN_L + 356, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('DESC.', MARGIN_L + 394, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('IVA', MARGIN_L + 428, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('TOTAL (KZ)', MARGIN_R - 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.y -= h + 4;
  };

  drawTableHeader();

  for (let i = 0; i < invoice.lines.length; i++) {
    const ln = invoice.lines[i]!;
    const descLines = wrapText(ln.description, 184, 8.2, 'F1');
    const rowH = Math.max(15, descLines.length * 10.5 + 4);
    pdf.ensureSpace(rowH + 10, drawTableHeader);

    if (i % 2 === 1) {
      pdf.drawRectFill(MARGIN_L, pdf.y - rowH + 6, CONTENT_W, rowH, [0.985, 0.99, 0.995]);
    }
    const ry = pdf.y - 4;
    pdf.drawText(ln.code || '-', MARGIN_L + 4, ry, {
      font: 'F3',
      size: 7.5,
      color: [0.35, 0.4, 0.48],
      maxWidth: 46,
    });
    pdf.drawWrappedText(ln.description, MARGIN_L + 54, ry, 184, {
      font: 'F1',
      size: 8.2,
      lineHeight: 10.5,
    });
    pdf.drawText(`${ln.qty} ${ln.unit || 'un'}`, MARGIN_L + 286, ry, {
      font: 'F3',
      size: 8,
      align: 'right',
    });
    pdf.drawText(formatKzNumber(ln.unitPrice), MARGIN_L + 356, ry, {
      font: 'F3',
      size: 8,
      align: 'right',
    });
    pdf.drawText(ln.discountPct > 0 ? `${ln.discountPct}%` : '-', MARGIN_L + 394, ry, {
      font: 'F3',
      size: 7.8,
      align: 'right',
    });
    pdf.drawText(`${ln.ivaRate}%`, MARGIN_L + 428, ry, {
      font: 'F3',
      size: 7.8,
      align: 'right',
    });
    pdf.drawText(formatKzNumber(ln.lineTotal), MARGIN_R - 4, ry, {
      font: 'F4',
      size: 8.2,
      align: 'right',
    });

    pdf.y -= rowH;
    pdf.drawLine(MARGIN_L, pdf.y + 4, MARGIN_R, pdf.y + 4, [0.93, 0.94, 0.96], 0.4);
  }

  pdf.y -= 10;
  pdf.ensureSpace(175);

  // Secção inferior: Resumo Fiscal + Totais + QR Code Fiscal AGT
  const summaryTopY = pdf.y;

  // Coluna esquerda: QR Code + Dados Fiscais + Pagamento / IBAN
  const sig4 = invoice.saftHash4 || computeDocumentSaftHash4(invoice).hash4;
  const qrPayload = buildAgtQrCanonicalString({
    companyNif: company.nif,
    companyName: company.legalName,
    customerNif: invoice.customerNif,
    customerCountry: (invoice.customerCountryCode || 'AO').slice(0, 2).toUpperCase(),
    documentType: invoice.docType,
    documentStatus: invoice.status === 'cancelled' ? 'A' : 'N',
    documentDate: invoice.issuedAtIso,
    documentNo: invoice.number,
    submissionGuidOrHash: invoice.id,
    totals: {
      taxBaseNor: invoice.taxBase14,
      taxAmountNor: invoice.taxAmount14,
      taxBaseIntRed: roundKz((invoice.taxBaseIntermediate || 0) + (invoice.taxBaseReduced || 0)),
      taxAmountIntRed: roundKz((invoice.taxAmountIntermediate || 0) + (invoice.taxAmountReduced || 0)),
      taxBaseIse: invoice.taxBase0,
      totalTax: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
    },
    signatureJwsPreview: sig4,
    environment: invoice.seriesEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'HOMOLOGACAO',
  });

  const qrSize = 72;
  const qrDrawn = pdf.drawQrMatrix(qrPayload, MARGIN_L, summaryTopY - qrSize, qrSize);
  const leftInfoX = qrDrawn ? MARGIN_L + qrSize + 10 : MARGIN_L;
  const leftInfoMaxW = 290 - (qrDrawn ? qrSize + 10 : 0);

  let infoY = summaryTopY - 8;
  pdf.drawText(`Assinatura Digital: ${sig4}-Processado por programa`, leftInfoX, infoY, {
    font: 'F3',
    size: 7.5,
    color: [0.22, 0.27, 0.35],
    maxWidth: leftInfoMaxW,
  });
  infoY -= 11;
  pdf.drawText(
    invoice.seriesEnvironment === 'PRODUCAO'
      ? `Série Produção AGT${invoice.atcud ? ` · ATCUD: ${invoice.atcud}` : ''}`
      : 'Documento em Ambiente de Simulação / Formação',
    leftInfoX,
    infoY,
    { font: 'F1', size: 7.5, color: [0.38, 0.43, 0.51], maxWidth: leftInfoMaxW }
  );
  infoY -= 12;
  infoY = pdf.drawWrappedText(`Extenso: ${invoice.amountInWords}`, leftInfoX, infoY, leftInfoMaxW, {
    font: 'F1',
    size: 7.8,
    lineHeight: 10,
    color: [0.25, 0.3, 0.38],
  });

  const bankLines = formatPaymentInstructionsLine(company);
  if (bankLines.length > 0) {
    infoY -= 2;
    for (const bl of bankLines.slice(0, 3)) {
      pdf.drawText(bl, leftInfoX, infoY, {
        font: 'F1',
        size: 7.5,
        color: [0.28, 0.33, 0.42],
        maxWidth: leftInfoMaxW,
      });
      infoY -= 10;
    }
  }

  // Coluna direita: Caixa de Totais
  const totBoxW = 206;
  const totBoxX = MARGIN_R - totBoxW;
  let ty = summaryTopY - 10;

  const drawTotalRow = (label: string, valText: string, bold = false, accent = false) => {
    pdf.drawText(label, totBoxX + 8, ty, {
      font: bold ? 'F2' : 'F1',
      size: bold ? 9.5 : 8.2,
      color: accent ? [0.11, 0.31, 0.85] : [0.22, 0.27, 0.35],
    });
    pdf.drawText(valText, MARGIN_R - 8, ty, {
      font: bold ? 'F4' : 'F3',
      size: bold ? 9.5 : 8.2,
      color: accent ? [0.11, 0.31, 0.85] : [0.06, 0.09, 0.16],
      align: 'right',
    });
    ty -= bold ? 15 : 12;
  };

  drawTotalRow('Total Ilíquido / Mercadorias:', `${formatKzNumber(invoice.merchandiseTotal)} Kz`);
  if (invoice.discountTotal > 0) {
    drawTotalRow('Descontos:', `-${formatKzNumber(invoice.discountTotal)} Kz`);
  }
  if ((invoice.taxBase14 || 0) > 0) {
    drawTotalRow(`Incidência 14% (${formatKzNumber(invoice.taxBase14)}):`, `${formatKzNumber(invoice.taxAmount14)} Kz`);
  }
  if ((invoice.taxBase0 || 0) > 0) {
    drawTotalRow('Incidência Isenta (0%):', `${formatKzNumber(invoice.taxBase0)} Kz`);
  }
  drawTotalRow('Total Impostos (IVA):', `${formatKzNumber(invoice.taxTotal)} Kz`);
  pdf.drawLine(totBoxX + 6, ty + 7, MARGIN_R - 6, ty + 7, [0.78, 0.82, 0.88], 0.8);
  ty -= 3;
  drawTotalRow('TOTAL DO DOCUMENTO:', `${formatKzNumber(invoice.grandTotal)} Kz`, true, true);
  if (invoice.docType !== 'FP') {
    drawTotalRow('Valor Recebido:', `${formatKzNumber(invoice.amountReceived)} Kz`);
    if (invoice.changeAmount > 0) {
      drawTotalRow('Troco:', `${formatKzNumber(invoice.changeAmount)} Kz`);
    }
    if ((invoice.amountDue || 0) > 0) {
      drawTotalRow('Saldo em Dívida:', `${formatKzNumber(invoice.amountDue!)} Kz`, true, false);
    }
  }

  if (invoice.notes) {
    const notesY = Math.min(summaryTopY - qrSize - 10, infoY - 6, ty - 6);
    pdf.drawText(`Observações: ${invoice.notes}`, MARGIN_L, notesY, {
      font: 'F1',
      size: 7.8,
      color: [0.38, 0.43, 0.51],
      maxWidth: CONTENT_W,
    });
  }

  return pdf.build();
}

export interface PaymentReceiptPdfPayload {
  receiptNumber: string;
  issuedAtIso: string;
  customerName: string;
  customerNif: string;
  customerPhone?: string;
  paymentMethod: DirectPaymentMethod;
  reference?: string;
  paidAmount: number;
  remainingDebtAfter: number;
  operator: string;
  cashier?: string;
  settledInvoices: Array<{
    invoiceNumber: string;
    invoiceTotal: number;
    appliedAmount: number;
    remainingDue: number;
  }>;
}

/**
 * 2. PDF Real de Comprovativo de Pagamento / Liquidação de Dívida
 */
export function generatePaymentReceiptPdfBytes(
  proof: PaymentReceiptPdfPayload,
  company: CompanyProfile
): Uint8Array {
  const dt = formatDateTimePt(proof.issuedAtIso);
  const pdf = new PdfDocumentBuilder(SILA_PDF_SIGNATURE);
  drawCompanyHeaderBlock(
    pdf,
    company,
    'COMPROVATIVO DE PAGAMENTO',
    proof.receiptNumber,
    `Registado em ${dt.slashDate} às ${dt.time}`
  );

  const y0 = pdf.y;
  pdf.drawText('CLIENTE PAGADOR', MARGIN_L, y0, { font: 'F2', size: 7.5, color: [0.42, 0.47, 0.55] });
  pdf.drawText(proof.customerName, MARGIN_L, y0 - 12, { font: 'F2', size: 10.5, maxWidth: 300 });
  pdf.drawText(`NIF: ${proof.customerNif || '---'}${proof.customerPhone ? ` · Tel: ${proof.customerPhone}` : ''}`, MARGIN_L, y0 - 25, {
    font: 'F1',
    size: 8.5,
    color: [0.3, 0.35, 0.43],
  });

  // Destaque do montante recebido
  const bx = MARGIN_R - 195;
  pdf.drawRectFill(bx, y0 - 36, 195, 42, [0.93, 0.98, 0.95]);
  pdf.drawRectStroke(bx, y0 - 36, 195, 42, [0.68, 0.87, 0.75], 0.7);
  pdf.drawText('MONTANTE RECEBIDO', bx + 10, y0 - 6, { font: 'F2', size: 7.5, color: [0.09, 0.45, 0.25] });
  pdf.drawText(`${formatKzNumber(proof.paidAmount)} Kz`, bx + 10, y0 - 22, {
    font: 'F4',
    size: 13,
    color: [0.06, 0.35, 0.18],
  });

  pdf.y = y0 - 50;
  pdf.drawText(
    `Meio de Pagamento: ${proof.paymentMethod}${proof.reference ? ` · Ref.: ${proof.reference}` : ''} · Operador: ${proof.operator}`,
    MARGIN_L,
    pdf.y,
    { font: 'F1', size: 8.5, color: [0.22, 0.27, 0.35], maxWidth: CONTENT_W }
  );
  pdf.y -= 13;
  pdf.drawWrappedText(`Valor por extenso: ${kwanzaToWords(proof.paidAmount)}`, MARGIN_L, pdf.y, CONTENT_W, {
    font: 'F1',
    size: 8.2,
    lineHeight: 11,
    color: [0.35, 0.4, 0.48],
  });
  pdf.y -= 10;

  // Tabela de documentos amortizados
  const drawHead = () => {
    pdf.drawRectFill(MARGIN_L, pdf.y - 13, CONTENT_W, 18, [0.94, 0.96, 0.98]);
    const ty = pdf.y - 7;
    pdf.drawText('DOCUMENTO LIQUIDADO / ABATIDO', MARGIN_L + 6, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('TOTAL DOC.', MARGIN_L + 280, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('AMORTIZADO', MARGIN_L + 400, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('SALDO PENDENTE', MARGIN_R - 6, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.y -= 22;
  };
  drawHead();

  for (const item of proof.settledInvoices) {
    pdf.ensureSpace(20, drawHead);
    pdf.drawText(item.invoiceNumber, MARGIN_L + 6, pdf.y, { font: 'F4', size: 8.5 });
    pdf.drawText(`${formatKzNumber(item.invoiceTotal)} Kz`, MARGIN_L + 280, pdf.y, { font: 'F3', size: 8.5, align: 'right' });
    pdf.drawText(`${formatKzNumber(item.appliedAmount)} Kz`, MARGIN_L + 400, pdf.y, {
      font: 'F4',
      size: 8.5,
      color: [0.06, 0.45, 0.22],
      align: 'right',
    });
    pdf.drawText(`${formatKzNumber(item.remainingDue)} Kz`, MARGIN_R - 6, pdf.y, {
      font: 'F3',
      size: 8.5,
      color: item.remainingDue > 0 ? [0.7, 0.38, 0.05] : [0.35, 0.4, 0.48],
      align: 'right',
    });
    pdf.y -= 16;
    pdf.drawLine(MARGIN_L, pdf.y + 6, MARGIN_R, pdf.y + 6, [0.92, 0.94, 0.96], 0.4);
  }

  pdf.y -= 10;
  pdf.drawText(
    proof.remainingDebtAfter > 0
      ? `Saldo global remanescente em conta corrente: ${formatKzNumber(proof.remainingDebtAfter)} Kz`
      : 'Conta corrente regularizada — sem saldo devedor pendente.',
    MARGIN_L,
    pdf.y,
    { font: 'F2', size: 9, color: proof.remainingDebtAfter > 0 ? [0.7, 0.38, 0.05] : [0.06, 0.45, 0.22] }
  );

  return pdf.build();
}

export interface CatalogOrQuotePdfPayload {
  mode: 'QUOTE' | 'CATALOG';
  referenceCode: string;
  issuedAtIso: string;
  customer?: Pick<Customer, 'name' | 'nif' | 'phone' | 'locality'> | null;
  cartItems?: CartDraftItem[];
  globalDiscountPct?: number;
  notes?: string;
  validityDays?: number;
  products?: Product[];
  catalogFilterLabel?: string;
}

/**
 * 3. PDF Real de Orçamento Comercial (do carrinho) ou Catálogo de Artigos (sem custos internos)
 */
export function generateCatalogOrQuotePdfBytes(
  payload: CatalogOrQuotePdfPayload,
  company: CompanyProfile
): Uint8Array {
  const dt = formatDateTimePt(payload.issuedAtIso);
  const pdf = new PdfDocumentBuilder(SILA_PDF_SIGNATURE);
  const isQuote = payload.mode === 'QUOTE';

  drawCompanyHeaderBlock(
    pdf,
    company,
    isQuote ? 'ORÇAMENTO COMERCIAL' : 'CATÁLOGO COMERCIAL',
    payload.referenceCode,
    `Gerado em ${dt.slashDate} às ${dt.time}`
  );

  if (isQuote) {
    const items = payload.cartItems || [];
    const totals = calculateInvoiceTotals(items, payload.globalDiscountPct || 0);
    const cust = payload.customer;

    pdf.drawText(
      `Destinatário: ${cust?.name || 'Cliente / Interessado'}${cust?.nif ? ` · NIF ${cust.nif}` : ''}${
        cust?.phone ? ` · Tel: ${cust.phone}` : ''
      }`,
      MARGIN_L,
      pdf.y,
      { font: 'F2', size: 9, maxWidth: CONTENT_W }
    );
    pdf.y -= 12;
    pdf.drawText(
      `Validade da proposta: ${payload.validityDays ?? 15} dias · Preços em Kwanzas (AOA)`,
      MARGIN_L,
      pdf.y,
      { font: 'F1', size: 8.2, color: [0.38, 0.43, 0.51] }
    );
    pdf.y -= 14;

    const drawQuoteHead = () => {
      pdf.drawRectFill(MARGIN_L, pdf.y - 13, CONTENT_W, 18, [0.94, 0.96, 0.98]);
      const ty = pdf.y - 7;
      pdf.drawText('COD.', MARGIN_L + 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
      pdf.drawText('ARTIGO / SERVIÇO', MARGIN_L + 54, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
      pdf.drawText('QTD', MARGIN_L + 295, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
      pdf.drawText('P. UNIT.', MARGIN_L + 365, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
      pdf.drawText('IVA', MARGIN_L + 415, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
      pdf.drawText('TOTAL (KZ)', MARGIN_R - 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
      pdf.y -= 22;
    };
    drawQuoteHead();

    for (const ln of totals.lines) {
      const descLines = wrapText(ln.description, 195, 8.2, 'F1');
      const rowH = Math.max(15, descLines.length * 10.5 + 4);
      pdf.ensureSpace(rowH + 10, drawQuoteHead);
      pdf.drawText(ln.code, MARGIN_L + 4, pdf.y - 4, { font: 'F3', size: 7.5, maxWidth: 46 });
      pdf.drawWrappedText(ln.description, MARGIN_L + 54, pdf.y - 4, 195, { font: 'F1', size: 8.2, lineHeight: 10.5 });
      pdf.drawText(`${ln.qty} ${ln.unit || 'un'}`, MARGIN_L + 295, pdf.y - 4, { font: 'F3', size: 8, align: 'right' });
      pdf.drawText(formatKzNumber(ln.unitPrice), MARGIN_L + 365, pdf.y - 4, { font: 'F3', size: 8, align: 'right' });
      pdf.drawText(`${ln.ivaRate}%`, MARGIN_L + 415, pdf.y - 4, { font: 'F3', size: 8, align: 'right' });
      pdf.drawText(formatKzNumber(ln.lineTotal), MARGIN_R - 4, pdf.y - 4, { font: 'F4', size: 8.2, align: 'right' });
      pdf.y -= rowH;
      pdf.drawLine(MARGIN_L, pdf.y + 4, MARGIN_R, pdf.y + 4, [0.92, 0.94, 0.96], 0.4);
    }

    pdf.y -= 12;
    pdf.ensureSpace(90);
    pdf.drawText(`Total Geral do Orçamento: ${formatKzNumber(totals.grandTotal)} Kz`, MARGIN_R, pdf.y, {
      font: 'F2',
      size: 11,
      color: [0.11, 0.31, 0.85],
      align: 'right',
    });
    pdf.y -= 14;
    pdf.drawText(`Extenso: ${totals.amountInWords}`, MARGIN_L, pdf.y, {
      font: 'F1',
      size: 8,
      color: [0.3, 0.35, 0.43],
      maxWidth: CONTENT_W,
    });
    pdf.y -= 12;
    const banks = formatPaymentInstructionsLine(company);
    for (const b of banks.slice(0, 2)) {
      pdf.drawText(b, MARGIN_L, pdf.y, { font: 'F1', size: 8, color: [0.3, 0.35, 0.43], maxWidth: CONTENT_W });
      pdf.y -= 11;
    }
    if (payload.notes) {
      pdf.drawText(`Notas: ${payload.notes}`, MARGIN_L, pdf.y, { font: 'F1', size: 8, color: [0.4, 0.45, 0.52], maxWidth: CONTENT_W });
    }
    return pdf.build();
  }

  // MODO CATÁLOGO
  const activeProducts = (payload.products || []).filter((p) => p.active !== false);
  pdf.drawText(
    `Lista de Preços de Venda ao Público · ${activeProducts.length} artigo(s)${
      payload.catalogFilterLabel ? ` · ${payload.catalogFilterLabel}` : ''
    }`,
    MARGIN_L,
    pdf.y,
    { font: 'F1', size: 8.5, color: [0.3, 0.35, 0.43], maxWidth: CONTENT_W }
  );
  pdf.y -= 16;

  const drawCatalogHead = () => {
    pdf.drawRectFill(MARGIN_L, pdf.y - 13, CONTENT_W, 18, [0.94, 0.96, 0.98]);
    const ty = pdf.y - 7;
    pdf.drawText('SKU', MARGIN_L + 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('PRODUTO / SERVIÇO', MARGIN_L + 60, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('CATEGORIA', MARGIN_L + 285, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('UN', MARGIN_L + 375, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38] });
    pdf.drawText('IVA', MARGIN_L + 418, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.drawText('PREÇO (KZ)', MARGIN_R - 4, ty, { font: 'F2', size: 7.5, color: [0.25, 0.3, 0.38], align: 'right' });
    pdf.y -= 22;
  };
  drawCatalogHead();

  for (let i = 0; i < activeProducts.length; i++) {
    const p = activeProducts[i]!;
    const nameLines = wrapText(p.name, 215, 8.2, 'F1');
    const rowH = Math.max(15, nameLines.length * 10.5 + 4);
    pdf.ensureSpace(rowH + 10, drawCatalogHead);

    if (i % 2 === 1) {
      pdf.drawRectFill(MARGIN_L, pdf.y - rowH + 6, CONTENT_W, rowH, [0.985, 0.99, 0.995]);
    }
    pdf.drawText(p.code, MARGIN_L + 4, pdf.y - 4, { font: 'F3', size: 7.5, maxWidth: 52 });
    pdf.drawWrappedText(p.name, MARGIN_L + 60, pdf.y - 4, 215, { font: 'F1', size: 8.2, lineHeight: 10.5 });
    pdf.drawText(p.category || 'Geral', MARGIN_L + 285, pdf.y - 4, {
      font: 'F1',
      size: 7.8,
      color: [0.35, 0.4, 0.48],
      maxWidth: 82,
    });
    pdf.drawText(p.unit || 'un', MARGIN_L + 375, pdf.y - 4, { font: 'F3', size: 7.8 });
    pdf.drawText(`${p.ivaRate}%`, MARGIN_L + 418, pdf.y - 4, { font: 'F3', size: 7.8, align: 'right' });
    pdf.drawText(formatKzNumber(p.price), MARGIN_R - 4, pdf.y - 4, {
      font: 'F4',
      size: 8.5,
      color: [0.06, 0.09, 0.16],
      align: 'right',
    });

    pdf.y -= rowH;
    pdf.drawLine(MARGIN_L, pdf.y + 4, MARGIN_R, pdf.y + 4, [0.93, 0.94, 0.96], 0.4);
  }

  return pdf.build();
}

export interface DailyOwnerSummaryPayload {
  dateIso: string;
  generatedAtIso: string;
  totalSalesGross: number;
  validDocCount: number;
  cancelledCount: number;
  averageTicket: number;
  cashTotal: number;
  multicaixaTotal: number;
  transferTotal: number;
  creditTotal: number;
  debtCollectionsTotal: number;
  openReceivablesTotal: number;
  activeCashSessionSummary?: {
    cashier: string;
    operator: string;
    status: 'open' | 'closed';
    openingFloat: number;
    expectedCash: number;
    countedCash: number | null;
    differenceAmount: number | null;
  } | null;
  topProducts?: Array<{ name: string; qty: number; revenue: number }>;
}

/**
 * 4. PDF Real de Resumo Diário para o Proprietário
 */
export function generateDailySummaryPdfBytes(
  summary: DailyOwnerSummaryPayload,
  company: CompanyProfile
): Uint8Array {
  const dt = formatDateTimePt(summary.generatedAtIso);
  const dateLabel = summary.dateIso.split('-').reverse().join('/');
  const pdf = new PdfDocumentBuilder(SILA_PDF_SIGNATURE);

  drawCompanyHeaderBlock(
    pdf,
    company,
    'RESUMO DIÁRIO DE GESTÃO',
    `Data: ${dateLabel}`,
    `Emitido às ${dt.time}`
  );

  // Cards 3x2 com KPIs do dia
  const cardW = (CONTENT_W - 16) / 3;
  const cardH = 44;
  const cards = [
    { label: 'TOTAL FATURADO HOJE', val: `${formatKzNumber(summary.totalSalesGross)} Kz`, accent: true },
    { label: 'DOCUMENTOS EMITIDOS', val: `${summary.validDocCount} válidos (${summary.cancelledCount} anul.)`, accent: false },
    { label: 'TICKET MÉDIO', val: `${formatKzNumber(summary.averageTicket)} Kz`, accent: false },
    { label: 'LIQUIDAÇÕES DE DÍVIDA', val: `${formatKzNumber(summary.debtCollectionsTotal)} Kz`, accent: false },
    { label: 'CRÉDITO CONCEDIDO HOJE', val: `${formatKzNumber(summary.creditTotal)} Kz`, accent: false },
    { label: 'CARTEIRA POR COBRAR', val: `${formatKzNumber(summary.openReceivablesTotal)} Kz`, accent: false },
  ];

  for (let i = 0; i < cards.length; i++) {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const cx = MARGIN_L + col * (cardW + 8);
    const cy = pdf.y - row * (cardH + 8) - cardH + 10;
    const c = cards[i]!;
    pdf.drawRectFill(cx, cy, cardW, cardH, [0.97, 0.98, 0.99]);
    pdf.drawRectStroke(cx, cy, cardW, cardH, [0.85, 0.88, 0.92], 0.6);
    pdf.drawText(c.label, cx + 8, cy + cardH - 13, { font: 'F2', size: 7, color: [0.42, 0.47, 0.55] });
    pdf.drawText(c.val, cx + 8, cy + 12, {
      font: 'F4',
      size: 10,
      color: c.accent ? [0.11, 0.31, 0.85] : [0.06, 0.09, 0.16],
      maxWidth: cardW - 16,
    });
  }

  pdf.y -= cardH * 2 + 22;

  // Recebimentos por Método de Pagamento
  pdf.drawText('RECEBIMENTOS POR MÉTODO DE PAGAMENTO (HOJE)', MARGIN_L, pdf.y, {
    font: 'F2',
    size: 8.5,
    color: [0.15, 0.2, 0.28],
  });
  pdf.y -= 14;
  const methodRows = [
    ['Dinheiro (Numerário)', summary.cashTotal],
    ['Multicaixa / TPA', summary.multicaixaTotal],
    ['Transferência Bancária', summary.transferTotal],
    ['Vendas a Crédito / Conta Corrente', summary.creditTotal],
  ] as const;
  for (const [label, amount] of methodRows) {
    pdf.drawText(label, MARGIN_L + 6, pdf.y, { font: 'F1', size: 8.5 });
    pdf.drawText(`${formatKzNumber(amount)} Kz`, MARGIN_R - 6, pdf.y, { font: 'F4', size: 8.5, align: 'right' });
    pdf.y -= 14;
    pdf.drawLine(MARGIN_L, pdf.y + 5, MARGIN_R, pdf.y + 5, [0.92, 0.94, 0.96], 0.4);
  }

  if (summary.activeCashSessionSummary) {
    const cs = summary.activeCashSessionSummary;
    pdf.y -= 10;
    pdf.drawText(
      `ESTADO DA GAVETA · Caixa ${cs.cashier} (Op. ${cs.operator}) — ${cs.status === 'open' ? 'Turno em Aberto' : 'Turno Encerrado'}`,
      MARGIN_L,
      pdf.y,
      { font: 'F2', size: 8.5, color: [0.15, 0.2, 0.28] }
    );
    pdf.y -= 14;
    pdf.drawText(
      `Fundo Inicial: ${formatKzNumber(cs.openingFloat)} Kz · Numerário Esperado: ${formatKzNumber(cs.expectedCash)} Kz${
        cs.countedCash !== null ? ` · Contado: ${formatKzNumber(cs.countedCash)} Kz` : ''
      }`,
      MARGIN_L + 6,
      pdf.y,
      { font: 'F1', size: 8.5, maxWidth: CONTENT_W - 12 }
    );
    pdf.y -= 14;
  }

  if (summary.topProducts && summary.topProducts.length > 0) {
    pdf.y -= 10;
    pdf.drawText('ARTIGOS MAIS VENDIDOS NO DIA', MARGIN_L, pdf.y, {
      font: 'F2',
      size: 8.5,
      color: [0.15, 0.2, 0.28],
    });
    pdf.y -= 14;
    for (const tp of summary.topProducts.slice(0, 8)) {
      pdf.ensureSpace(20);
      pdf.drawText(`${tp.qty}x · ${tp.name}`, MARGIN_L + 6, pdf.y, {
        font: 'F1',
        size: 8.5,
        maxWidth: 360,
      });
      pdf.drawText(`${formatKzNumber(tp.revenue)} Kz`, MARGIN_R - 6, pdf.y, {
        font: 'F4',
        size: 8.5,
        align: 'right',
      });
      pdf.y -= 14;
    }
  }

  return pdf.build();
}
