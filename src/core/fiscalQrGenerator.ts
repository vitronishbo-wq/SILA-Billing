/**
 * SILA-Billing — Gerador de QR Code Fiscal da AGT
 * Em estrita conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 * 
 * Especificações Técnicas Oficiais da AGT:
 * 1. Simbologia: QR Code Modelo 2 (ISO/IEC 18004).
 * 2. Versão: Versão 4 (33x33 módulos) ou adaptativa conforme a densidade.
 * 3. Nível de Correção de Erros: Nível M (capacidade de recuperação até 15%).
 * 4. Dimensão Mínima e Renderização: 350x350 pixels (para garantir legibilidade perfeita a 300 DPI em A4 e POS 80mm).
 * 5. String Canónica com campos estruturados separados por '*':
 *    A: NIF do emitente
 *    B: NIF do adquirente (999999999 se Consumidor Final)
 *    C: País do adquirente (AO)
 *    D: Tipo de documento (FR, FA, FT, TV, NC, RC, etc.)
 *    E: Estado do documento (N = Normal, S = Autofacturação, A = Anulado, R = Resumo, C = Contingência)
 *    F: Data de emissão (YYYYMMDD ou YYYY-MM-DD)
 *    G: Identificação do documento (ex: FR A2026/000001)
 *    H: Código de validação / Hash ou GUID
 *    I1: Espaço fiscal (AO)
 *    I2: Base tributável à taxa normal (NOR 14%)
 *    I3: Total de IVA à taxa normal (NOR 14%)
 *    I4: Base tributável a taxas intermédias/reduzidas (INT/RED)
 *    I5: Total de IVA a taxas intermédias/reduzidas
 *    I6: Total isento de IVA (ISE 0%)
 *    I7: Total de Imposto do Selo (IS)
 *    I8: Total de Imposto Especial de Consumo (IEC)
 *    N: Total de impostos debitados
 *    O: Total ilíquido / valor total a pagar
 *    Q: 4 caracteres da assinatura digital / Hash JWS
 *    R: Número de aprovação do software na AGT (ex: 123/AGT/2026)
 */

import QRCode from 'qrcode';
import { roundKz } from './taxEngine.ts';
import type {
  AgtDocumentStatus,
  AgtDocumentTotals,
  AgtDocumentType,
} from './fiscalTypes.ts';

export interface AgtQrPayloadInput {
  companyNif: string;
  companyName?: string;
  customerNif?: string;
  customerCountry?: string; // Padrão: 'AO'
  documentType: AgtDocumentType | string;
  documentStatus?: AgtDocumentStatus; // Padrão: 'N'
  documentDate: string; // ISO ou YYYY-MM-DD
  documentNo: string; // Ex: 'FR A2026/000001'
  submissionGuidOrHash?: string;
  totals: {
    taxBaseNor?: number;
    taxAmountNor?: number;
    taxBaseIntRed?: number;
    taxAmountIntRed?: number;
    taxBaseIse?: number;
    stampTax?: number;
    iecTax?: number;
    totalTax?: number;
    grandTotal: number;
  };
  signatureJwsPreview?: string; // 4 caracteres ou hash JWS
  softwareApprovalNumber?: string; // Padrão: '123/AGT/2026'
  environment?: 'HOMOLOGACAO' | 'PRODUCAO';
  includePortalUrl?: boolean;
}

export interface AgtQrCodeOptions {
  version?: number; // Padrão: 4
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H'; // Padrão: 'M'
  width?: number; // Padrão: 350
  margin?: number; // Padrão: 2
  darkColor?: string; // Padrão: '#000000'
  lightColor?: string; // Padrão: '#FFFFFF'
}

export const DEFAULT_AGT_SOFTWARE_APPROVAL = '123/AGT/2026';
export const AGT_PORTAL_VERIFY_URL = 'https://agt.minfin.gov.ao/portal/validar-documento';
export const AGT_HOMOLOG_VERIFY_URL = 'https://homologacao-agt.minfin.gov.ao/portal/validar-documento';

/**
 * Normaliza o NIF para a estrutura do QR Code AGT (999999999 para Consumidor Final).
 */
export function normalizeQrNif(raw?: string): string {
  const clean = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!clean || clean === 'CONSUMIDORFINAL' || clean === '999999999' || clean === '000000000') {
    return '999999999';
  }
  return clean;
}

/**
 * Normaliza a data no formato YYYYMMDD ou YYYY-MM-DD exigido pela especificação.
 */
export function formatQrDate(rawIsoOrDate: string): string {
  const d = new Date(rawIsoOrDate);
  if (Number.isNaN(d.getTime())) {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

/**
 * Constrói a string canónica oficial do QR Code da AGT (Decreto Executivo 683/25).
 */
export function buildAgtQrCanonicalString(input: AgtQrPayloadInput): string {
  const compNif = normalizeQrNif(input.companyNif);
  const custNif = normalizeQrNif(input.customerNif);
  const custCountry = (input.customerCountry || 'AO').trim().toUpperCase().slice(0, 2) || 'AO';
  const docType = String(input.documentType || 'FR').trim().toUpperCase();
  const docStatus = input.documentStatus || 'N';
  const docDate = formatQrDate(input.documentDate);
  const docNo = String(input.documentNo || 'FR A2026/000001').trim();
  const guidOrHash = (input.submissionGuidOrHash || '0').trim().slice(0, 36);

  const t = input.totals;
  const baseNor = roundKz(t.taxBaseNor || 0).toFixed(2);
  const taxNor = roundKz(t.taxAmountNor || 0).toFixed(2);
  const baseIntRed = roundKz(t.taxBaseIntRed || 0).toFixed(2);
  const taxIntRed = roundKz(t.taxAmountIntRed || 0).toFixed(2);
  const baseIse = roundKz(t.taxBaseIse || 0).toFixed(2);
  const stampTax = roundKz(t.stampTax || 0).toFixed(2);
  const iecTax = roundKz(t.iecTax || 0).toFixed(2);
  const totalTax = roundKz(
    typeof t.totalTax === 'number'
      ? t.totalTax
      : (t.taxAmountNor || 0) + (t.taxAmountIntRed || 0) + (t.stampTax || 0) + (t.iecTax || 0)
  ).toFixed(2);
  const grandTotal = roundKz(t.grandTotal || 0).toFixed(2);

  // 4 caracteres da assinatura JWS/RSA conforme especificação técnica
  const sigPreview = (input.signatureJwsPreview || '0000').trim().slice(0, 4);
  const softwareAppr = input.softwareApprovalNumber || DEFAULT_AGT_SOFTWARE_APPROVAL;

  const parts = [
    `A:${compNif}`,
    `B:${custNif}`,
    `C:${custCountry}`,
    `D:${docType}`,
    `E:${docStatus}`,
    `F:${docDate}`,
    `G:${docNo}`,
    `H:${guidOrHash}`,
    `I1:AO`,
    `I2:${baseNor}`,
    `I3:${taxNor}`,
    `I4:${baseIntRed}`,
    `I5:${taxIntRed}`,
    `I6:${baseIse}`,
    `I7:${stampTax}`,
    `I8:${iecTax}`,
    `N:${totalTax}`,
    `O:${grandTotal}`,
    `Q:${sigPreview}`,
    `R:${softwareAppr}`,
  ];

  const canonicalString = parts.join('*');

  if (input.includePortalUrl) {
    const baseUrl =
      input.environment === 'HOMOLOGACAO' ? AGT_HOMOLOG_VERIFY_URL : AGT_PORTAL_VERIFY_URL;
    return `${baseUrl}?qr=${encodeURIComponent(canonicalString)}`;
  }

  return canonicalString;
}

/**
 * Gera o QR Code oficial da AGT como Data URL (PNG Base64).
 * Modelo 2, Versão 4 (ou adaptativa para evitar estouro de buffer), Nível M, 350x350 px.
 */
export async function generateAgtQrDataUrl(
  input: AgtQrPayloadInput,
  options?: AgtQrCodeOptions
): Promise<string> {
  const canonical = buildAgtQrCanonicalString(input);
  const width = options?.width || 350;
  const margin = typeof options?.margin === 'number' ? options.margin : 2;
  const darkColor = options?.darkColor || '#000000';
  const lightColor = options?.lightColor || '#FFFFFF';

  // Tentativa primária: Versão 4 com Nível M (especificação padrão Decreto 683/25)
  try {
    return await QRCode.toDataURL(canonical, {
      version: options?.version || 4,
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      width,
      margin,
      color: { dark: darkColor, light: lightColor },
    });
  } catch (err: any) {
    // Se a string canónica for longa com URL ou GUID expandido, recorre à versão adaptativa com Nível M
    try {
      return await QRCode.toDataURL(canonical, {
        errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
        width,
        margin,
        color: { dark: darkColor, light: lightColor },
      });
    } catch (fallbackErr) {
      console.warn('[AgtQrGenerator] Falha ao renderizar QR Code AGT:', fallbackErr);
      return '';
    }
  }
}

/**
 * Gera o QR Code oficial da AGT como vetor SVG escalável de alta precisão
 * para impressão de qualidade profissional sem perda de resolução.
 */
export async function generateAgtQrSvg(
  input: AgtQrPayloadInput,
  options?: AgtQrCodeOptions
): Promise<string> {
  const canonical = buildAgtQrCanonicalString(input);
  const width = options?.width || 350;
  const margin = typeof options?.margin === 'number' ? options.margin : 2;
  const darkColor = options?.darkColor || '#000000';
  const lightColor = options?.lightColor || '#FFFFFF';

  try {
    return await QRCode.toString(canonical, {
      type: 'svg',
      version: options?.version || 4,
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      width,
      margin,
      color: { dark: darkColor, light: lightColor },
    });
  } catch {
    // Fallback adaptativo
    return await QRCode.toString(canonical, {
      type: 'svg',
      errorCorrectionLevel: options?.errorCorrectionLevel || 'M',
      width,
      margin,
      color: { dark: darkColor, light: lightColor },
    });
  }
}

export interface AgtParsedQrData {
  valid: boolean;
  raw: string;
  companyNif?: string;
  customerNif?: string;
  customerCountry?: string;
  documentType?: string;
  documentStatus?: string;
  documentDate?: string;
  documentNo?: string;
  validationHash?: string;
  taxCountry?: string;
  taxBaseNor?: number;
  taxAmountNor?: number;
  taxBaseIntRed?: number;
  taxAmountIntRed?: number;
  taxBaseIse?: number;
  stampTax?: number;
  iecTax?: number;
  totalTax?: number;
  grandTotal?: number;
  signaturePreview?: string;
  softwareApprovalNumber?: string;
}

/**
 * Decodifica e audita uma string canónica de QR Code fiscal da AGT.
 */
export function parseAgtQrString(rawQr: string): AgtParsedQrData {
  let target = String(rawQr || '').trim();
  if (target.includes('?qr=')) {
    try {
      const parsedUrl = new URL(target);
      const param = parsedUrl.searchParams.get('qr');
      if (param) target = decodeURIComponent(param);
    } catch {
      const idx = target.indexOf('?qr=');
      target = decodeURIComponent(target.slice(idx + 4));
    }
  }

  const parts = target.split('*');
  if (parts.length < 10) {
    return { valid: false, raw: target };
  }

  const map: Record<string, string> = {};
  for (const part of parts) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.slice(0, colonIdx).trim();
      const val = part.slice(colonIdx + 1).trim();
      map[key] = val;
    }
  }

  const parseNum = (v?: string) => (v ? parseFloat(v) || 0 : 0);

  return {
    valid: Boolean(map['A'] && map['D'] && map['G'] && map['O']),
    raw: target,
    companyNif: map['A'],
    customerNif: map['B'],
    customerCountry: map['C'],
    documentType: map['D'],
    documentStatus: map['E'],
    documentDate: map['F'],
    documentNo: map['G'],
    validationHash: map['H'],
    taxCountry: map['I1'],
    taxBaseNor: parseNum(map['I2']),
    taxAmountNor: parseNum(map['I3']),
    taxBaseIntRed: parseNum(map['I4']),
    taxAmountIntRed: parseNum(map['I5']),
    taxBaseIse: parseNum(map['I6']),
    stampTax: parseNum(map['I7']),
    iecTax: parseNum(map['I8']),
    totalTax: parseNum(map['N']),
    grandTotal: parseNum(map['O']),
    signaturePreview: map['Q'],
    softwareApprovalNumber: map['R'],
  };
}
