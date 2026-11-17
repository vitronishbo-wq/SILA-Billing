import QRCode from 'qrcode';
import { formatDateTimePt, formatKzNumber, roundKz } from '../../src/core/billingEngine';
import { resolveDefaultExemptionCodeForCompany } from '../../src/core/companyValidator';
import {
  CUSTOMER_TYPE_LABELS,
  inferCustomerType,
  isFinalConsumerNif,
} from '../../src/core/customerValidator';
import {
  buildAgtQrCanonicalString,
  DEFAULT_AGT_SOFTWARE_APPROVAL,
  generateAgtQrDataUrl,
} from '../../src/core/fiscalQrGenerator';
import { AGT_IVA_EXEMPTION_CODES, type AgtIvaExemptionCode } from '../../src/core/fiscalTypes';
import { computeDocumentSaftHash4 } from '../../src/core/saftGenerator';
import {
  CashMovement,
  CashSession,
  CashSessionSummary,
  CompanyProfile,
  CustomerType,
  deriveCompanyInitials,
  DocumentFormat,
  formatDocumentTypeLabelPt,
  InvoiceRecord,
  NEUTRAL_PLATFORM_PROFILE,
  normalizeCompanyNif,
  resolveCompanyProfileFromSnapshot,
  resolveEstablishmentLocality,
  VITRONIS_INSTITUTIONAL,
} from '../../src/core/types';
import {
  classifyInvoiceControlStatus,
  summarizeDocumentControlList,
} from '../../src/core/documentExport';

export const SILA_SOFTWARE_VERSION = '1.0';

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTaxRegimeLabelPt(regime?: string): string {
  switch (regime) {
    case 'SIMPLIFICADO':
      return 'Regime Simplificado de IVA';
    case 'EXCLUSAO':
      return 'Regime de Exclusão de IVA';
    case 'GERAL':
    default:
      return 'Regime Geral de IVA';
  }
}

function normalizePhraseForCompare(raw?: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanEstablishmentDisplayName(rawName: string, docCompany: CompanyProfile): string {
  let clean = String(rawName || '').trim();
  if (!clean) return '';
  const prefixes = [docCompany.shortName, docCompany.legalName]
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  for (const prefix of prefixes) {
    const lowerPrefix = prefix.toLowerCase();
    const lowerClean = clean.toLowerCase();
    if (lowerClean.startsWith(lowerPrefix)) {
      const rest = clean.slice(prefix.length).replace(/^[\s·\-—:]+/, '').trim();
      if (rest) {
        clean = rest;
        break;
      }
    }
  }
  return clean;
}

export function getInvoiceQrCacheKey(
  invoice: Pick<InvoiceRecord, 'number' | 'grandTotal' | 'saftHash4' | 'issuerSnapshot'>,
  fallbackCompany?: Pick<CompanyProfile, 'nif'> | null
): string {
  const issuerNif = invoice.issuerSnapshot?.nif || fallbackCompany?.nif || '';
  return `${invoice.number}|${Number(invoice.grandTotal || 0).toFixed(2)}|${issuerNif}|${invoice.saftHash4 || ''}`;
}

interface RenderedTaxRow {
  label: string;
  rateLabel: string;
  base: number;
  amount: number;
  exemptionNote?: string;
}

function buildDocumentTaxRows(invoice: InvoiceRecord, docCompany: CompanyProfile): RenderedTaxRow[] {
  const rows: RenderedTaxRow[] = [];
  const globalPct = Math.min(100, Math.max(0, Number(invoice.globalDiscountPct || 0)));
  const factor = globalPct > 0 ? 1 - globalPct / 100 : 1;

  if (Array.isArray(invoice.lines) && invoice.lines.length > 0) {
    const rateConfigs: Array<{ rate: number; label: string; rateLabel: string }> = [
      { rate: 14, label: 'IVA 14%', rateLabel: '14,00% (NOR)' },
      { rate: 7, label: 'IVA 7%', rateLabel: '7,00% (INT)' },
      { rate: 5, label: 'IVA 5%', rateLabel: '5,00% (RED)' },
      { rate: 1, label: 'IVA 1% Cabinda', rateLabel: '1,00% (INT-CAB)' },
      { rate: 0, label: 'IVA 0%', rateLabel: '0,00% (ISE)' },
    ];

    for (const cfg of rateConfigs) {
      const matchingLines = invoice.lines.filter((l) => Number(l.ivaRate) === cfg.rate);
      if (matchingLines.length === 0) continue;
      const rawNet = roundKz(matchingLines.reduce((acc, l) => acc + (Number(l.lineNet) || 0), 0));
      const net = globalPct > 0 ? roundKz(rawNet * factor) : rawNet;
      if (net <= 0) continue;
      const base = cfg.rate > 0 ? roundKz(net / (1 + cfg.rate / 100)) : net;
      const amount = cfg.rate > 0 ? roundKz(base * (cfg.rate / 100)) : 0;
      let exemptionNote: string | undefined;
      if (cfg.rate === 0) {
        const codes = Array.from(
          new Set(
            matchingLines.map((l) =>
              resolveDefaultExemptionCodeForCompany(docCompany, l.exemptionCode)
            )
          )
        );
        const customReasons = Array.from(
          new Set(
            matchingLines
              .map((l) => String(l.exemptionReason || '').trim())
              .filter(Boolean)
          )
        );
        const codeText = codes
          .map((c) => {
            const meta = AGT_IVA_EXEMPTION_CODES[c as AgtIvaExemptionCode];
            return meta ? `${c}: ${meta.descriptionPt} (${meta.legalBasis})` : c;
          })
          .join(' · ');
        exemptionNote =
          customReasons.length > 0 && !codeText.toLowerCase().includes(customReasons[0]!.toLowerCase())
            ? `${codeText} — ${customReasons.join('; ')}`
            : codeText;
      }
      rows.push({
        label: cfg.label,
        rateLabel: cfg.rateLabel,
        base,
        amount,
        exemptionNote,
      });
    }
  }

  if (rows.length === 0) {
    if ((invoice.taxBase14 || 0) > 0 || (invoice.taxBase0 || 0) === 0) {
      rows.push({
        label: 'IVA 14%',
        rateLabel: '14,00% (NOR)',
        base: invoice.taxBase14 || 0,
        amount: invoice.taxAmount14 || 0,
      });
    }
    if ((invoice.taxBaseIntermediate || 0) > 0) {
      rows.push({
        label: 'IVA Interm.',
        rateLabel: 'INT (1%/7%)',
        base: invoice.taxBaseIntermediate || 0,
        amount: invoice.taxAmountIntermediate || 0,
      });
    }
    if ((invoice.taxBaseReduced || 0) > 0) {
      rows.push({
        label: 'IVA 5%',
        rateLabel: '5,00% (RED)',
        base: invoice.taxBaseReduced || 0,
        amount: invoice.taxAmountReduced || 0,
      });
    }
    const defCode = resolveDefaultExemptionCodeForCompany(docCompany);
    const defMeta = AGT_IVA_EXEMPTION_CODES[defCode];
    rows.push({
      label: 'IVA 0%',
      rateLabel: '0,00% (ISE)',
      base: invoice.taxBase0 || 0,
      amount: 0,
      exemptionNote: defMeta ? `${defCode}: ${defMeta.descriptionPt}` : defCode,
    });
  }

  return rows;
}

function buildLineTaxBadge(
  rate: number,
  exemptionCode: string | undefined,
  docCompany: CompanyProfile
): string {
  const r = Number(rate) || 0;
  if (r === 14) return 'NOR 14%';
  if (r === 7) return 'INT 7%';
  if (r === 5) return 'RED 5%';
  if (r === 1) return 'INT-CAB 1%';
  const code = resolveDefaultExemptionCodeForCompany(docCompany, exemptionCode);
  return `ISE ${code}`;
}

function buildInvoiceQrPayloadInput(invoice: InvoiceRecord, docCompany: CompanyProfile) {
  const sig4 = invoice.saftHash4 || computeDocumentSaftHash4(invoice).hash4;
  const taxBaseIntRed = roundKz(
    (invoice.taxBaseIntermediate || 0) + (invoice.taxBaseReduced || 0)
  );
  const taxAmountIntRed = roundKz(
    (invoice.taxAmountIntermediate || 0) + (invoice.taxAmountReduced || 0)
  );
  const environment: 'PRODUCAO' | 'HOMOLOGACAO' =
    invoice.seriesEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'HOMOLOGACAO';
  const customerCountry = (invoice.customerCountryCode || 'AO').trim().toUpperCase().slice(0, 2) || 'AO';

  return {
    companyNif: docCompany.nif,
    companyName: docCompany.legalName,
    customerNif: invoice.customerNif,
    customerCountry,
    documentType: invoice.docType,
    documentStatus: (invoice.status === 'cancelled' ? 'A' : 'N') as 'A' | 'N',
    documentDate: invoice.issuedAtIso,
    documentNo: invoice.number,
    submissionGuidOrHash: invoice.id,
    totals: {
      taxBaseNor: invoice.taxBase14,
      taxAmountNor: invoice.taxAmount14,
      taxBaseIntRed,
      taxAmountIntRed,
      taxBaseIse: invoice.taxBase0,
      totalTax: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
    },
    signatureJwsPreview: sig4,
    environment,
  };
}

function renderQrSvgSync(canonical: string, sizeClass: string, altLabel: string): string {
  try {
    const qr = QRCode.create(canonical, { errorCorrectionLevel: 'M' });
    const count = qr.modules.size;
    const data = qr.modules.data;
    const margin = 2;
    const total = count + margin * 2;
    const rects: string[] = [];
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (data[r * count + c]) {
          rects.push(`<rect x="${c + margin}" y="${r + margin}" width="1" height="1"/>`);
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(altLabel)}" class="${sizeClass} bg-white"><rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#000000">${rects.join('')}</g></svg>`;
  } catch {
    return '';
  }
}

export async function generateInvoiceQrDataUrl(
  invoice: InvoiceRecord,
  company: CompanyProfile = NEUTRAL_PLATFORM_PROFILE
): Promise<string> {
  try {
    const docCompany = resolveCompanyProfileFromSnapshot(invoice, company);
    const payloadInput = buildInvoiceQrPayloadInput(invoice, docCompany);
    return await generateAgtQrDataUrl(payloadInput, {
      width: 350,
      margin: 2,
      errorCorrectionLevel: 'M',
      version: 4,
    });
  } catch {
    return '';
  }
}

export function renderDocumentHtml(
  invoice: InvoiceRecord,
  format: DocumentFormat,
  company: CompanyProfile = NEUTRAL_PLATFORM_PROFILE,
  qrDataUrl = '',
  options?: {
    showViralFooter?: boolean;
    customerAddress?: string;
    customerPhone?: string;
    customerEmail?: string;
    customerType?: CustomerType;
    customerCountryCode?: string;
    isReprint?: boolean;
  }
): string {
  const docCompany = resolveCompanyProfileFromSnapshot(invoice, company);
  const dt = formatDateTimePt(invoice.issuedAtIso);
  const isCreditNote = invoice.docType === 'NC';
  const isProforma = invoice.docType === 'FP';
  const titleLabel = formatDocumentTypeLabelPt(invoice.docType).toUpperCase();
  const isSecondCopy = Boolean(options?.isReprint || (invoice.reprintCount || 0) > 0);
  const cancelledDt = invoice.cancelledAtIso ? formatDateTimePt(invoice.cancelledAtIso) : null;
  const showViralFooter = Boolean(options?.showViralFooter);
  const isProductionDoc = invoice.seriesEnvironment === 'PRODUCAO';

  const estCode = invoice.establishmentCode || invoice.issuerSnapshot?.establishmentCode || '';
  const rawEstName = invoice.establishmentName || invoice.issuerSnapshot?.establishmentName || '';
  const cleanEstName = cleanEstablishmentDisplayName(rawEstName, docCompany);
  const estLabel = [estCode ? `Est. ${estCode}` : '', cleanEstName].filter(Boolean).join(' · ');
  const estAddress =
    invoice.issuerSnapshot?.establishmentAddress &&
    invoice.issuerSnapshot.establishmentAddress.trim().toLowerCase() !==
      docCompany.address.trim().toLowerCase()
      ? invoice.issuerSnapshot.establishmentAddress.trim()
      : '';
  const issuerLocalityLabel = resolveEstablishmentLocality(docCompany, {
    municipality: invoice.issuerSnapshot?.establishmentMunicipality || docCompany.municipality,
    province: invoice.issuerSnapshot?.establishmentProvince || docCompany.province,
  });

  const resolvedCustomerType: CustomerType =
    invoice.customerType ||
    options?.customerType ||
    inferCustomerType({
      id: invoice.customerId,
      name: invoice.customerName,
      nif: invoice.customerNif,
      countryCode: invoice.customerCountryCode || options?.customerCountryCode,
    });
  const customerTypeLabel = CUSTOMER_TYPE_LABELS[resolvedCustomerType];
  const custCountryCode = (
    invoice.customerCountryCode ||
    options?.customerCountryCode ||
    'AO'
  )
    .trim()
    .toUpperCase();

  let custNifDisplay = 'Não informado';
  if (resolvedCustomerType === 'CONSUMIDOR_FINAL') {
    custNifDisplay = '999999999 (Consumidor Final)';
  } else if (resolvedCustomerType === 'ESTRANGEIRO') {
    const rawCustNif = String(invoice.customerNif || '').trim();
    custNifDisplay =
      rawCustNif && !isFinalConsumerNif(rawCustNif)
        ? `${rawCustNif} (${custCountryCode})`
        : `Estrangeiro (${custCountryCode})`;
  } else if (invoice.customerNif && !isFinalConsumerNif(invoice.customerNif)) {
    custNifDisplay = invoice.customerNif.trim();
  }

  const rawCustLoc = (invoice.customerLocality || '').trim();
  const custLoc =
    resolvedCustomerType === 'CONSUMIDOR_FINAL'
      ? !rawCustLoc ||
        rawCustLoc === 'Angola' ||
        (rawCustLoc === 'Luanda - Angola' &&
          issuerLocalityLabel &&
          issuerLocalityLabel !== 'Luanda - Angola')
        ? issuerLocalityLabel
        : rawCustLoc
      : rawCustLoc || issuerLocalityLabel;

  const rawCustAddr = (invoice.customerAddress || options?.customerAddress || '').trim();
  const isGenericCounterAddr =
    resolvedCustomerType === 'CONSUMIDOR_FINAL' &&
    rawCustAddr.toLowerCase().startsWith('venda a balcão');
  const custAddr =
    rawCustAddr && !isGenericCounterAddr && rawCustAddr.toLowerCase() !== custLoc.toLowerCase()
      ? rawCustAddr
      : '';
  const custPhone = (invoice.customerPhone || options?.customerPhone || '').trim();
  const custEmail = (invoice.customerEmail || options?.customerEmail || '').trim();

  const docHash4 = invoice.saftHash4 || computeDocumentSaftHash4(invoice).hash4;
  const taxRows = buildDocumentTaxRows(invoice, docCompany);
  const qrKey = getInvoiceQrCacheKey(invoice, docCompany);
  const qrCaption = isProductionDoc
    ? 'QR AGT (Produção)'
    : 'QR Verificação (Simulação)';
  const qrImgOrSvgHtml = qrDataUrl
    ? `<img src="${qrDataUrl}" data-qr-key="${escapeHtml(qrKey)}" alt="${escapeHtml(qrCaption)}" referrerpolicy="no-referrer" class="h-24 w-24 object-contain" />`
    : renderQrSvgSync(
        buildAgtQrCanonicalString(buildInvoiceQrPayloadInput(invoice, docCompany)),
        'h-24 w-24',
        qrCaption
      );
  const qrA4ImgOrSvgHtml = qrDataUrl
    ? `<img src="${qrDataUrl}" data-qr-key="${escapeHtml(qrKey)}" alt="${escapeHtml(qrCaption)}" referrerpolicy="no-referrer" class="h-16 w-16 border border-slate-200 p-0.5" />`
    : renderQrSvgSync(
        buildAgtQrCanonicalString(buildInvoiceQrPayloadInput(invoice, docCompany)),
        'h-16 w-16 border border-slate-200 p-0.5',
        qrCaption
      );

  const docStateLabel =
    invoice.status === 'cancelled'
      ? 'ANULADO'
      : isProforma
        ? 'PROVISÓRIO / PROFORMA (SEM VALIDADE FISCAL)'
        : isProductionDoc
          ? 'FISCAL VÁLIDO (PRODUÇÃO AGT)'
          : 'DEMONSTRAÇÃO / SIMULAÇÃO (SEM VALIDADE FISCAL)';

  const atcudDisplay = invoice.atcud
    ? invoice.atcud
    : isProductionDoc
      ? 'Pendente de atribuição AGT'
      : 'Não atribuído (Simulação)';

  const normalizedTagline = normalizePhraseForCompare(docCompany.tagline);
  const isRedundantThankYou =
    normalizedTagline === 'obrigadopelasuapreferencia' ||
    normalizedTagline === 'obrigadopelapreferencia' ||
    (normalizedTagline.includes('obrigado') && normalizedTagline.includes('preferencia'));
  const showCustomTagline =
    Boolean(docCompany.tagline && docCompany.tagline.trim()) && !isRedundantThankYou;

  const showLogoPos = Boolean(docCompany.logoUrl) && docCompany.showLogoOnPos !== false;
  const showLogoA4 = Boolean(docCompany.logoUrl) && docCompany.showLogoOnA4 !== false;

  const paymentSplits = Array.isArray(invoice.paymentSplits)
    ? invoice.paymentSplits.filter((s) => s && Number(s.amount) > 0)
    : [];

  if (format === 'POS') {
    const itemsHtml = invoice.lines
      .map((line) => {
        const qtyStr = Number.isInteger(line.qty) ? String(line.qty) : formatKzNumber(line.qty);
        const taxBadge = buildLineTaxBadge(line.ivaRate, line.exemptionCode, docCompany);
        const hasLineDiscount = (line.discountPct || 0) > 0 || (line.lineDiscount || 0) > 0;
        return `
          <tr class="border-t border-dotted border-slate-300 align-top">
            <td colspan="4" class="pt-1.5 pb-0.5 leading-tight">
              <span class="font-bold">${escapeHtml(line.description)}</span>
              <span class="ml-1 text-[9.5px] font-semibold text-slate-700">[${escapeHtml(taxBadge)}]</span>
            </td>
          </tr>
          <tr class="align-top">
            <td class="pb-1 text-[10px] text-slate-600">${escapeHtml(line.code || '')}${line.unit ? ` · ${escapeHtml(line.unit)}` : ''}</td>
            <td class="pb-1 text-right whitespace-nowrap">${qtyStr}</td>
            <td class="pb-1 text-right whitespace-nowrap">${formatKzNumber(line.unitPrice)}</td>
            <td class="pb-1 text-right font-bold whitespace-nowrap">${formatKzNumber(line.lineTotal)}</td>
          </tr>
          ${
            hasLineDiscount
              ? `<tr>
                  <td colspan="4" class="pb-1 text-[9.5px] text-slate-600">
                    Desc. artigo: -${formatKzNumber(line.discountPct)}% (-${formatKzNumber(line.lineDiscount)} Kz)
                  </td>
                </tr>`
              : ''
          }
        `;
      })
      .join('');

    const posTaxRowsHtml = taxRows
      .map(
        (tr) =>
          `<div class="tabular-nums">${escapeHtml(tr.label)} — Base: ${formatKzNumber(tr.base)} — IVA: ${formatKzNumber(tr.amount)}</div>${
            tr.exemptionNote
              ? `<div class="text-[9.5px] text-slate-600 pl-1.5">${escapeHtml(tr.exemptionNote)}</div>`
              : ''
          }`
      )
      .join('');

    const posPaymentLinesHtml =
      paymentSplits.length > 0
        ? paymentSplits
            .map(
              (sp) =>
                `<div class="flex justify-between"><span>· ${escapeHtml(sp.method)}${sp.reference ? ` (${escapeHtml(sp.reference)})` : ''}</span><span>${formatKzNumber(sp.amount)} Kz</span></div>`
            )
            .join('')
        : invoice.paymentSummary
          ? `<div class="text-[10.5px]">${escapeHtml(invoice.paymentSummary)}</div>`
          : !isCreditNote && invoice.paymentMethod !== 'Crédito' && invoice.amountReceived > 0
            ? `<div class="flex justify-between"><span>· ${escapeHtml(invoice.paymentMethod)}</span><span>${formatKzNumber(Math.min(invoice.amountReceived, invoice.grandTotal))} Kz</span></div>`
            : '';

    return `
      <div class="print-target mx-auto w-full max-w-[330px] bg-white p-4 text-[12px] leading-snug text-black font-sans border border-slate-200">
        <div class="text-center space-y-0.5">
          ${
            showLogoPos && docCompany.logoUrl
              ? `<div class="mb-2 flex justify-center"><img src="${escapeHtml(docCompany.logoUrl)}" class="max-h-12 max-w-[140px] object-contain" alt="Logótipo" /></div>`
              : ''
          }
          ${
            isProductionDoc
              ? `<div class="font-bold text-[10.5px] tracking-tight">DOCUMENTO FISCAL · SÉRIE ${escapeHtml(invoice.seriesCode || 'A')}</div>`
              : `<div class="font-bold text-[11px] tracking-tight">MODELO — SEM VALIDADE FISCAL</div>`
          }
          <div class="font-bold text-[13px] leading-tight">${escapeHtml(docCompany.legalName)}</div>
          ${estLabel ? `<div class="text-[10.5px] font-semibold">${escapeHtml(estLabel)}</div>` : ''}
          <div class="text-[11px]">${escapeHtml(estAddress || docCompany.address)}</div>
          <div class="text-[10.5px]">${escapeHtml(issuerLocalityLabel)}</div>
          ${docCompany.phone ? `<div class="text-[11px]">Tel.: ${escapeHtml(docCompany.phone)}${docCompany.mobile ? ` / ${escapeHtml(docCompany.mobile)}` : ''}</div>` : ''}
          ${docCompany.email ? `<div class="text-[11px]">${escapeHtml(docCompany.email)}</div>` : ''}
          <div class="text-[11px] font-semibold tabular-nums">Contribuinte (NIF): ${escapeHtml(docCompany.nif)}</div>
          ${
            docCompany.taxRegime
              ? `<div class="text-[10px] text-slate-700">${escapeHtml(formatTaxRegimeLabelPt(docCompany.taxRegime))}</div>`
              : ''
          }
        </div>

        ${
          qrImgOrSvgHtml
            ? `<div class="my-2.5 flex flex-col items-center gap-1">
                ${qrImgOrSvgHtml}
                <div class="text-[9px] text-slate-500">${escapeHtml(qrCaption)}</div>
              </div>`
            : ''
        }

        <div class="border-y border-black py-1.5 text-center my-2 space-y-0.5">
          <div class="font-bold text-[13px] tabular-nums">${titleLabel} N.º ${escapeHtml(invoice.number)}</div>
          <div class="text-[10.5px] font-semibold">Estado: ${escapeHtml(docStateLabel)}</div>
          <div class="text-[10px] tabular-nums">Série: ${escapeHtml(invoice.seriesCode || 'Não atribuída')} · Ambiente: ${isProductionDoc ? 'Produção AGT' : 'Simulação'}</div>
          <div class="text-[10px] tabular-nums">ATCUD: ${escapeHtml(atcudDisplay)}</div>
          <div class="text-[10.5px]">${
            isCreditNote
              ? invoice.returnOriginNumber
                ? `Retificação / Devolução ref. ${escapeHtml(invoice.returnOriginNumber)}`
                : 'Devolução / Retificação Comercial'
              : isProforma
                ? 'Orçamento / Documento Provisório'
                : 'Venda Directa a Retalho'
          }</div>
          ${
            isSecondCopy
              ? `<div class="mt-0.5 font-semibold text-[10px] tracking-tight">2.ª VIA · REIMPRESSÃO${
                  invoice.reprintCount && invoice.reprintCount > 1 ? ` (#${invoice.reprintCount})` : ''
                }</div>`
              : ''
          }
          ${
            invoice.status === 'cancelled'
              ? `<div class="mt-0.5 font-bold text-red-700 text-[11px]">DOCUMENTO ANULADO</div>${
                  invoice.cancelReason
                    ? `<div class="text-[10px] text-red-700">Motivo: ${escapeHtml(invoice.cancelReason)}</div>`
                    : ''
                }${
                  invoice.cancelledBy
                    ? `<div class="text-[9.5px] text-red-700 tabular-nums">Por: ${escapeHtml(invoice.cancelledBy)}${
                        cancelledDt ? ` · ${cancelledDt.slashDate} ${cancelledDt.time}` : ''
                      }</div>`
                    : ''
                }`
              : ''
          }
        </div>

        <div class="space-y-0.5 text-[11px] pb-2 border-b border-black">
          <div class="font-bold tabular-nums">Data/Hora: ${dt.slashDate} ${dt.time}</div>
          <div class="tabular-nums">Caixa: <span class="font-semibold">${escapeHtml(invoice.cashier)}</span></div>
          <div class="tabular-nums">Operador(a): <span class="font-semibold">${escapeHtml(invoice.operator)}</span></div>
          <div>Local de emissão: ${escapeHtml(issuerLocalityLabel)}</div>
          <div class="pt-1 mt-1 border-t border-dotted border-slate-400 space-y-0.5">
            <div class="font-bold text-[10.5px]">ADQUIRENTE / CLIENTE</div>
            <div>Tipo: <span class="font-semibold">${escapeHtml(customerTypeLabel)}</span></div>
            <div>Nome: <span class="font-semibold">${escapeHtml(invoice.customerName)}</span></div>
            <div class="tabular-nums">NIF Cliente: ${escapeHtml(custNifDisplay)}</div>
            ${custPhone ? `<div class="tabular-nums">Tel.: ${escapeHtml(custPhone)}</div>` : ''}
            ${custEmail ? `<div>E-mail: ${escapeHtml(custEmail)}</div>` : ''}
            ${custAddr ? `<div>Morada: ${escapeHtml(custAddr)}</div>` : ''}
            <div>Localidade: ${escapeHtml(custLoc)}</div>
          </div>
        </div>

        <div class="py-2 border-b border-dashed border-black">
          <div class="font-bold text-[12px] mb-1">ARTIGOS</div>
          <table class="w-full border-collapse text-[10.5px] tabular-nums">
            <thead>
              <tr class="border-b border-black text-[9.5px] text-slate-700">
                <th class="pb-1 text-left font-bold">Artigo</th>
                <th class="pb-1 text-right font-bold">Qtd.</th>
                <th class="pb-1 text-right font-bold">P. Unit.</th>
                <th class="pb-1 text-right font-bold">Subtotal</th>
              </tr>
            </thead>
            <tbody>${itemsHtml}</tbody>
          </table>
        </div>

        <div class="py-2 border-b border-black text-[11px] space-y-1">
          <div class="font-bold text-[12px]">RESUMO DE IMPOSTOS</div>
          ${posTaxRowsHtml}
          <div class="pt-1 space-y-0.5 tabular-nums">
            <div class="flex justify-between">
              <span>Total de mercadorias</span>
              <span class="font-bold">${formatKzNumber(invoice.merchandiseTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span>Desconto comercial${invoice.globalDiscountPct ? ` (incl. global ${formatKzNumber(invoice.globalDiscountPct)}%)` : ''}</span>
              <span>${formatKzNumber(invoice.discountTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span>Total de impostos</span>
              <span>${formatKzNumber(invoice.taxTotal)}</span>
            </div>
          </div>
        </div>

        <div class="py-2 border-b border-dashed border-black">
          <div class="font-bold text-[13px]">${isCreditNote ? 'TOTAL A CREDITAR' : 'TOTAL A PAGAR'}</div>
          <div class="text-right font-bold text-[16px] tabular-nums">${formatKzNumber(invoice.grandTotal)} Kz</div>
          <div class="mt-1.5 text-[10.5px] font-bold leading-snug">Por extenso: ${escapeHtml(invoice.amountInWords)}</div>
        </div>

        <div class="py-2 border-b border-black text-[11px] space-y-0.5 tabular-nums">
          <div class="font-bold">${isCreditNote ? 'Modo de regularização' : 'Pagamentos'}: ${escapeHtml(invoice.paymentMethod)}</div>
          ${posPaymentLinesHtml}
          ${
            invoice.transferReference
              ? `<div class="text-[10.5px]">Ref. Pagamento: ${escapeHtml(invoice.transferReference)}</div>`
              : ''
          }
          ${
            invoice.returnOriginNumber
              ? `<div class="text-[10.5px]">${isCreditNote ? 'Fatura Retificada' : 'Ref. Troca/Devolução'}: ${escapeHtml(invoice.returnOriginNumber)}${
                  !isCreditNote && invoice.returnCreditApplied
                    ? ` (Crédito: ${formatKzNumber(invoice.returnCreditApplied)} Kz)`
                    : ''
                }</div>`
              : ''
          }
          <div class="flex justify-between pt-0.5 font-semibold">
            <span>${isCreditNote ? 'Valor reembolsado' : 'Total recebido'}:</span>
            <span>${formatKzNumber(invoice.amountReceived)} Kz</span>
          </div>
          ${
            isCreditNote
              ? ''
              : invoice.amountDue && invoice.amountDue > 0
                ? `<div class="flex justify-between font-bold"><span>Em dívida (Conta Corrente):</span><span>${formatKzNumber(invoice.amountDue)} Kz</span></div>`
                : invoice.changeAmount > 0
                  ? `<div class="flex justify-between font-semibold"><span>Troco:</span><span>${formatKzNumber(invoice.changeAmount)} Kz</span></div>`
                  : ''
          }
        </div>

        ${
          invoice.notes
            ? `<div class="py-2 border-b border-dashed border-black text-[11px]">
                <div class="font-bold">Observações</div>
                <div>${escapeHtml(invoice.notes)}</div>
              </div>`
            : ''
        }

        <div class="pt-2.5 text-center space-y-1">
          <div class="font-bold text-[11.5px]">OBRIGADO PELA SUA PREFERÊNCIA!</div>
          ${showCustomTagline ? `<div class="text-[11px]">${escapeHtml(docCompany.tagline)}</div>` : ''}
          <div class="border-t border-black mt-2 pt-1.5 text-[9.5px] space-y-0.5">
            ${
              isProductionDoc
                ? `<div class="font-bold tabular-nums">${escapeHtml(docHash4)}-Processado por programa validado SILA-Billing</div>
                   <div class="tabular-nums">Assinatura RSA-SHA1 SAF-T · NIF Emissor: ${escapeHtml(docCompany.nif)}${invoice.agtAuthorizationCode ? ` · Aut.: ${escapeHtml(invoice.agtAuthorizationCode)}` : ''}</div>`
                : `<div class="font-bold tabular-nums">Assinatura de teste SAF-T (RSA-SHA1): ${escapeHtml(docHash4)} — Simulação</div>
                   <div>Documento de demonstração · Não substitui factura fiscal perante a AGT</div>`
            }
            <div class="pt-1 mt-1 border-t border-dashed border-black/50 text-[9px] text-slate-700 tabular-nums">
              Software SILA-Billing v${SILA_SOFTWARE_VERSION} · Produtor: ${escapeHtml(VITRONIS_INSTITUTIONAL.shortName)}, Lda · NIF ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)} · Ref. ${escapeHtml(DEFAULT_AGT_SOFTWARE_APPROVAL)}
            </div>
            ${
              showViralFooter
                ? `<div class="text-[9px] text-slate-600">${escapeHtml(VITRONIS_INSTITUTIONAL.website)}</div>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }

  // Formato Comercial A4 Unificado
  const rowsA4 = invoice.lines
    .map(
      (line) => `
        <tr>
          <td class="py-2 px-2.5 font-mono text-slate-600">${escapeHtml(line.code)}</td>
          <td class="py-2 px-2.5 font-medium text-slate-900">
            <div>${escapeHtml(line.description)}</div>
            <div class="text-[9.5px] text-slate-500">${escapeHtml(buildLineTaxBadge(line.ivaRate, line.exemptionCode, docCompany))}</div>
          </td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.qty)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.unitPrice)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.ivaRate)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.discountPct)}</td>
          <td class="py-2 px-2.5 text-right font-semibold text-slate-900">${formatKzNumber(line.lineTotal)}</td>
        </tr>
      `
    )
    .join('');

  const a4TaxRowsHtml = taxRows
    .map(
      (tr) => `
              <tr>
                <td class="py-1.5">
                  <div>${escapeHtml(tr.rateLabel)}</div>
                  ${tr.exemptionNote ? `<div class="text-[9.5px] text-slate-500">${escapeHtml(tr.exemptionNote)}</div>` : ''}
                </td>
                <td class="py-1.5 text-right">${formatKzNumber(tr.base)}</td>
                <td class="py-1.5 text-right">${formatKzNumber(tr.amount)}</td>
              </tr>`
    )
    .join('');

  const a4PaymentSplitsHtml =
    paymentSplits.length > 0
      ? `<div class="mt-1 space-y-0.5 text-[10px] text-slate-600">${paymentSplits
          .map(
            (sp) =>
              `<div>· ${escapeHtml(sp.method)}: <strong>${formatKzNumber(sp.amount)} Kz</strong>${sp.reference ? ` (${escapeHtml(sp.reference)})` : ''}</div>`
          )
          .join('')}</div>`
      : invoice.paymentSummary
        ? `<div class="text-[10px] text-slate-600 mt-0.5">${escapeHtml(invoice.paymentSummary)}</div>`
        : '';

  return `
    <div class="print-target mx-auto w-full max-w-[794px] bg-white p-6 sm:p-8 text-slate-900 border border-slate-200 text-xs">
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-5 border-b border-slate-200">
        <div class="flex items-center gap-3.5">
          ${
            showLogoA4 && docCompany.logoUrl
              ? `<img src="${escapeHtml(docCompany.logoUrl)}" class="h-14 w-auto max-w-[130px] object-contain rounded" alt="Logótipo" />`
              : `<div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-blue-600 bg-slate-900 text-white font-bold text-lg tracking-tight">${escapeHtml(deriveCompanyInitials(docCompany))}</div>`
          }
          <div>
            <div class="text-base font-bold tracking-tight text-slate-900">${escapeHtml(docCompany.shortName)}</div>
            <div class="text-[11px] font-medium text-slate-600">${escapeHtml(docCompany.legalName)}</div>
            ${
              showCustomTagline || normalizeCompanyNif(docCompany.nif) === '5003069940'
                ? `<div class="text-[10px] text-blue-700 mt-0.5">${
                    normalizeCompanyNif(docCompany.nif) === '5003069940'
                      ? 'Qualidade · Confiança · Soluções'
                      : escapeHtml(docCompany.tagline || '')
                  }</div>`
                : ''
            }
            ${
              docCompany.taxRegime || docCompany.commercialRegistry || docCompany.cae || docCompany.taxOffice
                ? `<div class="text-[9.5px] text-slate-500 mt-0.5">
                    ${docCompany.taxRegime ? escapeHtml(formatTaxRegimeLabelPt(docCompany.taxRegime)) : ''}
                    ${docCompany.taxOffice ? ` · ${escapeHtml(docCompany.taxOffice)}` : ''}
                    ${docCompany.cae ? ` · CAE: ${escapeHtml(docCompany.cae)}` : ''}
                    ${docCompany.commercialRegistry ? ` · CRC: ${escapeHtml(docCompany.commercialRegistry)}` : ''}
                    ${docCompany.shareCapital ? ` · Cap. Social: ${escapeHtml(docCompany.shareCapital)}` : ''}
                  </div>`
                : ''
            }
          </div>
        </div>
        <div class="text-[11px] text-slate-600 space-y-0.5 sm:text-right tabular-nums">
          ${estLabel ? `<div class="font-semibold text-slate-800">${escapeHtml(estLabel)}</div>` : ''}
          <div>${escapeHtml(estAddress || docCompany.address)}${docCompany.postalCode ? ` · CP ${escapeHtml(docCompany.postalCode)}` : ''}</div>
          <div>${escapeHtml(issuerLocalityLabel)}</div>
          ${docCompany.phone ? `<div>Tel.: ${escapeHtml(docCompany.phone)}${docCompany.mobile ? ` / ${escapeHtml(docCompany.mobile)}` : ''}</div>` : ''}
          ${docCompany.email ? `<div>${escapeHtml(docCompany.email)}</div>` : ''}
          ${docCompany.website ? `<div>${escapeHtml(docCompany.website)}</div>` : ''}
          <div class="font-semibold text-slate-900">Contribuinte / NIF: ${escapeHtml(docCompany.nif)}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 py-5">
        <div class="sm:col-span-7 space-y-3">
          <div>
            <div class="flex items-center gap-2.5 flex-wrap">
              <div class="text-lg font-bold ${isCreditNote ? 'text-amber-700' : 'text-blue-700'} tracking-tight">${titleLabel}</div>
              ${
                isSecondCopy
                  ? `<span class="text-[10.5px] font-semibold text-slate-500 tabular-nums">· 2.ª VIA (Reimpressão${
                      invoice.reprintCount && invoice.reprintCount > 1 ? ` #${invoice.reprintCount}` : ''
                    })</span>`
                  : ''
              }
            </div>
            <div class="text-sm font-semibold text-slate-800 tabular-nums">N.º ${escapeHtml(invoice.number)}</div>
            <div class="text-[10.5px] font-medium text-slate-600 tabular-nums">
              Estado: ${escapeHtml(docStateLabel)} · ATCUD: ${escapeHtml(atcudDisplay)}
            </div>
            ${
              invoice.seriesCode
                ? `<div class="text-[10.5px] text-slate-500 tabular-nums">Série: ${escapeHtml(invoice.seriesCode)} · Ambiente: ${isProductionDoc ? 'Produção AGT' : 'Simulação'}${
                    invoice.agtAuthorizationCode ? ` · Aut. AGT: ${escapeHtml(invoice.agtAuthorizationCode)}` : ''
                  }</div>`
                : ''
            }
            ${
              isCreditNote && invoice.returnOriginNumber
                ? `<div class="mt-0.5 text-[11px] font-medium text-slate-600 tabular-nums">Documento Origem Retificado: <span class="font-mono font-semibold text-slate-900">${escapeHtml(invoice.returnOriginNumber)}</span></div>`
                : ''
            }
            ${
              invoice.status === 'cancelled'
                ? `<div class="mt-1 space-y-0.5">
                    <div class="text-xs font-bold text-red-600">DOCUMENTO ANULADO</div>
                    ${
                      invoice.cancelReason
                        ? `<div class="text-[11px] text-red-700">Motivo: ${escapeHtml(invoice.cancelReason)}</div>`
                        : ''
                    }
                    ${
                      invoice.cancelledBy
                        ? `<div class="text-[10.5px] text-slate-500 tabular-nums">Anulado por ${escapeHtml(invoice.cancelledBy)}${
                            cancelledDt ? ` em ${cancelledDt.slashDate} ${cancelledDt.time}` : ''
                          }</div>`
                        : ''
                    }
                  </div>`
                : ''
            }
          </div>
          <div class="rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 space-y-0.5">
            <div class="flex items-center justify-between">
              <div class="text-[10px] font-semibold text-blue-700">Adquirente / Cliente</div>
              <div class="text-[10px] font-semibold text-slate-600">${escapeHtml(customerTypeLabel)}</div>
            </div>
            <div class="text-[11px] text-slate-500">Exmo.(s) Sr.(s)</div>
            <div class="text-xs font-bold text-slate-900">${escapeHtml(invoice.customerName)}</div>
            <div class="text-[11px] text-slate-600 tabular-nums">NIF: ${escapeHtml(custNifDisplay)}</div>
            ${custPhone ? `<div class="text-[11px] text-slate-600 tabular-nums">Tel.: ${escapeHtml(custPhone)}</div>` : ''}
            ${custEmail ? `<div class="text-[11px] text-slate-600">E-mail: ${escapeHtml(custEmail)}</div>` : ''}
            ${custAddr ? `<div class="text-[11px] text-slate-600">Morada: ${escapeHtml(custAddr)}</div>` : ''}
            <div class="text-[11px] text-slate-600">Localidade: ${escapeHtml(custLoc)}</div>
          </div>
        </div>

        <div class="sm:col-span-5 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 flex flex-col justify-between space-y-2 tabular-nums">
          <div>
            <div class="text-[10px] text-slate-500">Data/Hora de emissão</div>
            <div class="font-semibold text-slate-900">${dt.slashDate} ${dt.time}</div>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <div class="text-[10px] text-slate-500">Caixa</div>
              <div class="font-semibold text-slate-900">${escapeHtml(invoice.cashier)}</div>
            </div>
            <div>
              <div class="text-[10px] text-slate-500">Operador(a)</div>
              <div class="font-semibold text-slate-900">${escapeHtml(invoice.operator)}</div>
            </div>
          </div>
          <div>
            <div class="text-[10px] text-slate-500">Local de emissão</div>
            <div class="font-semibold text-slate-900">${escapeHtml(issuerLocalityLabel)}</div>
          </div>
        </div>
      </div>

      <div class="overflow-x-auto border border-slate-200 rounded-lg">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-900 text-white text-[10.5px]">
              <th class="py-2 px-2.5 font-semibold">Código</th>
              <th class="py-2 px-2.5 font-semibold">Descrição / Taxa</th>
              <th class="py-2 px-2.5 font-semibold text-right">Qtd.</th>
              <th class="py-2 px-2.5 font-semibold text-right">Preço Unit.</th>
              <th class="py-2 px-2.5 font-semibold text-right">IVA %</th>
              <th class="py-2 px-2.5 font-semibold text-right">Desc. %</th>
              <th class="py-2 px-2.5 font-semibold text-right">Total</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-[11px] tabular-nums">${rowsA4}</tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 mt-5">
        <div class="sm:col-span-6 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80">
          <div class="text-[11px] font-bold text-slate-900 mb-2">Resumo de Impostos</div>
          <table class="w-full text-[11px] tabular-nums">
            <thead>
              <tr class="text-slate-500 border-b border-slate-200">
                <th class="pb-1 text-left font-medium">IVA %</th>
                <th class="pb-1 text-right font-medium">Base de Cálculo</th>
                <th class="pb-1 text-right font-medium">Valor de IVA</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200/70">
              ${a4TaxRowsHtml}
            </tbody>
          </table>
        </div>

        <div class="sm:col-span-6 flex flex-col justify-between rounded-lg bg-slate-50 border border-slate-200/80 overflow-hidden tabular-nums">
          <div class="p-3.5 space-y-1.5 text-[11px]">
            <div class="flex justify-between">
              <span class="text-slate-600">Total de mercadorias</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.merchandiseTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-600">Desconto comercial${invoice.globalDiscountPct ? ` (incl. global ${formatKzNumber(invoice.globalDiscountPct)}%)` : ''}</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.discountTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-600">Total de impostos</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.taxTotal)}</span>
            </div>
          </div>
          <div class="${isCreditNote ? 'bg-amber-700' : 'bg-blue-600'} px-4 py-3 text-white flex items-center justify-between">
            <span class="font-bold text-xs">${isCreditNote ? 'TOTAL A CREDITAR' : 'TOTAL A PAGAR'}</span>
            <span class="font-bold text-base">${formatKzNumber(invoice.grandTotal)} Kz</span>
          </div>
        </div>
      </div>

      <div class="mt-4 space-y-3">
        <div class="text-[11px]">
          <span class="font-semibold text-slate-700">Valor por extenso: </span>
          <span class="text-slate-600">${escapeHtml(invoice.amountInWords)}</span>
        </div>

        <div class="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 border border-slate-200/80 text-[11px] tabular-nums">
          <div>
            <div class="text-[10px] text-slate-500">${isCreditNote ? 'Modo de regularização' : 'Pagamentos'}</div>
            <div class="font-bold text-slate-900">${escapeHtml(invoice.paymentMethod)}</div>
            ${a4PaymentSplitsHtml}
            ${
              invoice.transferReference
                ? `<div class="text-[10px] text-slate-600 mt-0.5">Ref.: ${escapeHtml(invoice.transferReference)}</div>`
                : ''
            }
            ${
              invoice.returnOriginNumber
                ? `<div class="text-[10px] text-slate-600 mt-0.5">${isCreditNote ? 'Ref. Origem' : 'Troca/Dev.'}: ${escapeHtml(invoice.returnOriginNumber)}</div>`
                : ''
            }
          </div>
          <div>
            <div class="text-[10px] text-slate-500">${isCreditNote ? 'Reembolsado no ato' : 'Valor recebido'}</div>
            <div class="font-bold text-slate-900">${formatKzNumber(invoice.amountReceived)} Kz</div>
          </div>
          <div>
            <div class="text-[10px] text-slate-500">${
              isCreditNote
                ? 'Abatimento / Crédito'
                : invoice.amountDue && invoice.amountDue > 0
                  ? 'Em dívida (Conta Corrente)'
                  : invoice.changeAmount > 0
                    ? 'Troco'
                    : 'Situação financeira'
            }</div>
            <div class="font-bold ${!isCreditNote && invoice.amountDue && invoice.amountDue > 0 ? 'text-amber-700' : 'text-slate-900'}">${
              isCreditNote
                ? `${formatKzNumber(Math.max(0, invoice.grandTotal - (invoice.amountReceived || 0)))} Kz`
                : invoice.amountDue && invoice.amountDue > 0
                  ? `${formatKzNumber(invoice.amountDue)} Kz`
                  : invoice.changeAmount > 0
                    ? `${formatKzNumber(invoice.changeAmount)} Kz`
                    : 'Liquidado'
            }</div>
          </div>
        </div>

        ${
          invoice.notes
            ? `<div class="text-[11px] text-slate-600">
                <span class="font-semibold text-slate-800">Observações: </span>
                ${escapeHtml(invoice.notes)}
              </div>`
            : ''
        }

        ${
          docCompany.iban1 || docCompany.multicaixaExpressPhone
            ? `<div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[10.5px] text-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 tabular-nums">
                ${
                  docCompany.iban1
                    ? `<div>
                        <span class="font-semibold text-slate-900">Coordenadas Bancárias:</span>
                        <span>${escapeHtml(docCompany.bankName1 || 'Banco Principal')} · IBAN: <strong class="font-mono text-slate-900">${escapeHtml(docCompany.iban1)}</strong>${
                          docCompany.accountHolder1 ? ` · Titular: ${escapeHtml(docCompany.accountHolder1)}` : ''
                        }${docCompany.swift1 ? ` · SWIFT: ${escapeHtml(docCompany.swift1)}` : ''}</span>
                      </div>`
                    : ''
                }
                ${
                  docCompany.iban2
                    ? `<div>
                        <span>${escapeHtml(docCompany.bankName2 || 'Banco Secundário')} · IBAN: <strong class="font-mono text-slate-900">${escapeHtml(docCompany.iban2)}</strong>${
                          docCompany.swift2 ? ` · SWIFT: ${escapeHtml(docCompany.swift2)}` : ''
                        }</span>
                      </div>`
                    : ''
                }
                ${
                  docCompany.multicaixaExpressPhone
                    ? `<div>Multicaixa Express: <strong class="font-mono text-slate-900">${escapeHtml(docCompany.multicaixaExpressPhone)}</strong></div>`
                    : ''
                }
              </div>`
            : ''
        }
      </div>

      <div class="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          ${qrA4ImgOrSvgHtml}
          <div class="text-[10.5px] text-slate-600 space-y-0.5">
            <div class="font-bold text-slate-900">OBRIGADO PELA SUA PREFERÊNCIA!</div>
            <div>${escapeHtml(docCompany.legalName)}</div>
            ${
              isProductionDoc
                ? `<div class="text-slate-700 font-medium tabular-nums">${escapeHtml(docHash4)}-Processado por programa validado SILA-Billing · Série ${escapeHtml(invoice.seriesCode || 'A')} (Assinatura RSA-SHA1 SAF-T)</div>`
                : `<div class="text-slate-500 tabular-nums">Modelo — Sem validade fiscal · Não substitui factura fiscal · Assinatura teste RSA-SHA1: ${escapeHtml(docHash4)}</div>`
            }
            <div class="text-[9.5px] text-slate-400 tabular-nums">Software SILA-Billing v${SILA_SOFTWARE_VERSION} · Produtor: ${escapeHtml(VITRONIS_INSTITUTIONAL.shortName)}, Lda · Ref. ${escapeHtml(DEFAULT_AGT_SOFTWARE_APPROVAL)} · NIF Produtor: ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}</div>
          </div>
        </div>
        ${showCustomTagline ? `<div class="text-right text-xs font-semibold text-slate-700">${escapeHtml(docCompany.tagline)}</div>` : ''}
      </div>
      ${
        showViralFooter
          ? `<div class="mt-3 pt-2 border-t border-slate-100 text-center text-[10px] text-slate-400">${escapeHtml(VITRONIS_INSTITUTIONAL.website)}</div>`
          : ''
      }
    </div>
  `;
}

function formatMovementTypeLabelPt(type: CashMovement['type']): string {
  switch (type) {
    case 'REFORCO':
      return 'Reforço';
    case 'SANGRIA':
      return 'Sangria';
    case 'ENTRADA':
      return 'Entrada';
    case 'SAIDA':
      return 'Saída';
    case 'LIQUIDACAO_DIVIDA':
      return 'Liq. Dívida';
  }
}

export function renderCashClosureReportHtml(
  session: CashSession,
  summary: CashSessionSummary,
  movements: ReadonlyArray<CashMovement>,
  company: CompanyProfile = NEUTRAL_PLATFORM_PROFILE,
  format: DocumentFormat = 'POS',
  showViralFooter = false
): string {
  const openDt = formatDateTimePt(session.openedAtIso);
  const closeDt = session.closedAtIso ? formatDateTimePt(session.closedAtIso) : null;
  const counted = summary.countedCash;
  const diff = summary.differenceAmount;
  const diffLabel =
    diff === null
      ? 'Em aberto (Contagem pendente)'
      : Math.abs(diff) < 0.005
        ? 'CONFERIDO (0,00 Kz)'
        : diff > 0
          ? `SOBRA (+${formatKzNumber(diff)} Kz)`
          : `QUEBRA (${formatKzNumber(diff)} Kz)`;

  const sessionMovs = movements
    .filter((m) => m.sessionId === session.id)
    .slice()
    .sort((a, b) => a.createdAtIso.localeCompare(b.createdAtIso));

  if (format === 'POS') {
    const movLines =
      sessionMovs.length === 0
        ? `<div class="text-[10.5px] text-slate-600">Sem movimentos manuais registados.</div>`
        : sessionMovs
            .map((m) => {
              const dt = formatDateTimePt(m.createdAtIso);
              const isOut = m.type === 'SANGRIA' || m.type === 'SAIDA';
              const sign = isOut ? '-' : '+';
              return `
                <div class="text-[10.5px] leading-snug">
                  <div class="flex justify-between tabular-nums font-semibold">
                    <span>${dt.time} · ${escapeHtml(formatMovementTypeLabelPt(m.type))} (${escapeHtml(m.paymentMethod)})</span>
                    <span>${sign}${formatKzNumber(m.amount)}</span>
                  </div>
                  <div class="pl-1.5 text-[10px]">${escapeHtml(m.reason)}${m.invoiceNumber ? ` · ${escapeHtml(m.invoiceNumber)}` : ''}</div>
                </div>
              `;
            })
            .join('');

    return `
      <div class="print-target mx-auto w-full max-w-[330px] bg-white p-4 text-[12px] leading-snug text-black font-sans border border-slate-200">
        <div class="text-center space-y-0.5">
          <div class="font-bold text-[13px] leading-tight">${escapeHtml(company.legalName)}</div>
          <div class="text-[11px]">Contribuinte: ${escapeHtml(company.nif)}</div>
          <div class="text-[11px]">${escapeHtml(company.address)}</div>
        </div>

        <div class="border-y border-black py-1.5 text-center my-2">
          <div class="font-bold text-[13px]">${session.status === 'closed' ? 'MAPA DE FECHO DE CAIXA' : 'RELATÓRIO PARCIAL DE CAIXA'}</div>
          <div class="text-[11px] tabular-nums">Caixa ${escapeHtml(session.cashier)} · Operador(a): ${escapeHtml(session.operator)}</div>
        </div>

        <div class="space-y-0.5 text-[11px] pb-2 border-b border-black tabular-nums">
          <div>Abertura: ${openDt.slashDate} ${openDt.time}</div>
          <div>Fecho: ${closeDt ? `${closeDt.slashDate} ${closeDt.time}` : 'Turno em curso'}</div>
          ${session.closedByOperator ? `<div>Conferido por: ${escapeHtml(session.closedByOperator)}</div>` : ''}
          <div>Documentos FR válidos: ${summary.invoiceCount}${summary.cancelledCount > 0 ? ` (Anul.: ${summary.cancelledCount})` : ''}</div>
        </div>

        <div class="py-2 border-b border-dashed border-black text-[11px] space-y-0.5 tabular-nums">
          <div class="font-bold text-[11.5px] mb-0.5">RECEBIMENTOS POR MÉTODO</div>
          <div class="flex justify-between"><span>Dinheiro (líquido)</span><span>${formatKzNumber(summary.totalByMethod.Dinheiro)} Kz</span></div>
          <div class="flex justify-between"><span>Multicaixa (TPA)</span><span>${formatKzNumber(summary.totalByMethod.Multicaixa)} Kz</span></div>
          <div class="flex justify-between"><span>Transferência</span><span>${formatKzNumber(summary.totalByMethod.Transferência)} Kz</span></div>
          <div class="flex justify-between font-bold pt-0.5 border-t border-black/30"><span>Total Recebido</span><span>${formatKzNumber(summary.totalReceivedAllMethods)} Kz</span></div>
          ${summary.salesCredit > 0 ? `<div class="flex justify-between pt-0.5"><span>Vendas a Crédito (Dívida)</span><span>${formatKzNumber(summary.salesCredit)} Kz</span></div>` : ''}
        </div>

        <div class="py-2 border-b border-black text-[11px] space-y-0.5 tabular-nums">
          <div class="font-bold text-[11.5px] mb-0.5">CONFERÊNCIA DE GAVETA (NUMERÁRIO)</div>
          <div class="flex justify-between"><span>(+) Fundo inicial</span><span>${formatKzNumber(summary.openingFloat)} Kz</span></div>
          <div class="flex justify-between"><span>(+) Vendas em Dinheiro</span><span>${formatKzNumber(summary.salesCash)} Kz</span></div>
          ${summary.debtCash > 0 ? `<div class="flex justify-between"><span>(+) Liq. Dívida Dinheiro</span><span>${formatKzNumber(summary.debtCash)} Kz</span></div>` : ''}
          <div class="flex justify-between"><span>(+) Reforços de caixa</span><span>${formatKzNumber(summary.reforcosTotal)} Kz</span></div>
          <div class="flex justify-between"><span>(+) Outras entradas</span><span>${formatKzNumber(summary.entradasTotal)} Kz</span></div>
          <div class="flex justify-between"><span>(-) Sangrias de caixa</span><span>${formatKzNumber(summary.sangriasTotal)} Kz</span></div>
          <div class="flex justify-between"><span>(-) Saídas / Despesas</span><span>${formatKzNumber(summary.saidasTotal)} Kz</span></div>
          <div class="flex justify-between font-bold pt-1 border-t border-black text-[12px]">
            <span>Saldo Esperado</span>
            <span>${formatKzNumber(summary.expectedCash)} Kz</span>
          </div>
          <div class="flex justify-between font-bold text-[12px]">
            <span>Dinheiro Contado</span>
            <span>${counted !== null ? `${formatKzNumber(counted)} Kz` : '—'}</span>
          </div>
          <div class="flex justify-between font-bold pt-0.5">
            <span>Diferença</span>
            <span>${diffLabel}</span>
          </div>
        </div>

        <div class="py-2 border-b border-dashed border-black space-y-1">
          <div class="font-bold text-[11.5px]">MOVIMENTOS REGISTADOS (${sessionMovs.length})</div>
          <div class="space-y-1">${movLines}</div>
        </div>

        ${
          session.closingNotes
            ? `<div class="py-2 border-b border-black text-[11px]">
                <div class="font-bold">Observações / Justificação</div>
                <div>${escapeHtml(session.closingNotes)}</div>
              </div>`
            : ''
        }

        <div class="pt-5 text-center space-y-3 text-[10.5px]">
          <div class="pt-3 border-t border-black mx-4">Assinatura do Operador / Responsável</div>
          ${
            showViralFooter
              ? `<div class="pt-1 border-t border-dashed border-black/50 text-[9.5px]">Processado por SILA-Billing · VITRONIS (www.vitronis.co.ao)</div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  // Formato A4 de Mapa de Fecho de Caixa
  const movRowsA4 =
    sessionMovs.length === 0
      ? `<tr><td colspan="5" class="py-3 px-3 text-slate-500 text-center">Nenhum movimento manual ou liquidação avulsa registada neste turno.</td></tr>`
      : sessionMovs
          .map((m) => {
            const dt = formatDateTimePt(m.createdAtIso);
            const isOut = m.type === 'SANGRIA' || m.type === 'SAIDA';
            return `
              <tr>
                <td class="py-2 px-2.5 font-mono text-slate-600">${dt.slashDate} ${dt.time}</td>
                <td class="py-2 px-2.5 font-semibold text-slate-900">${escapeHtml(formatMovementTypeLabelPt(m.type))}</td>
                <td class="py-2 px-2.5 text-slate-700">${escapeHtml(m.paymentMethod)}</td>
                <td class="py-2 px-2.5 text-slate-700">${escapeHtml(m.reason)}${m.reference ? ` · Ref: ${escapeHtml(m.reference)}` : ''}${m.invoiceNumber ? ` · Doc: ${escapeHtml(m.invoiceNumber)}` : ''}</td>
                <td class="py-2 px-2.5 text-right font-mono font-semibold ${isOut ? 'text-red-700' : 'text-emerald-700'}">${isOut ? '-' : '+'}${formatKzNumber(m.amount)} Kz</td>
              </tr>
            `;
          })
          .join('');

  return `
    <div class="print-target mx-auto w-full max-w-[794px] bg-white p-6 sm:p-8 text-slate-900 border border-slate-200 text-xs">
      <div class="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <div class="text-base font-bold text-slate-900">${escapeHtml(company.shortName)} — ${session.status === 'closed' ? 'MAPA DE FECHO DE CAIXA' : 'RELATÓRIO DE TURNO EM ABERTO'}</div>
          <div class="text-[11px] text-slate-600">${escapeHtml(company.legalName)} · NIF ${escapeHtml(company.nif)}</div>
        </div>
        <div class="text-right text-[11px] font-mono tabular-nums text-slate-600 space-y-0.5">
          <div class="font-bold text-slate-900">Caixa ${escapeHtml(session.cashier)} · Operador: ${escapeHtml(session.operator)}</div>
          <div>Abertura: ${openDt.slashDate} ${openDt.time}</div>
          <div>Fecho: ${closeDt ? `${closeDt.slashDate} ${closeDt.time}` : 'Em curso'}</div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 py-4">
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 tabular-nums">
          <div class="text-[11px] font-bold text-slate-900 pb-1 border-b border-slate-200">Separação por Método de Pagamento</div>
          <div class="flex justify-between"><span>Dinheiro (Vendas + Liq. Dívida)</span><span class="font-mono font-semibold">${formatKzNumber(summary.totalByMethod.Dinheiro)} Kz</span></div>
          <div class="flex justify-between"><span>Multicaixa / TPA</span><span class="font-mono font-semibold">${formatKzNumber(summary.totalByMethod.Multicaixa)} Kz</span></div>
          <div class="flex justify-between"><span>Transferência Bancária</span><span class="font-mono font-semibold">${formatKzNumber(summary.totalByMethod.Transferência)} Kz</span></div>
          <div class="flex justify-between pt-1 border-t border-slate-200 font-bold text-slate-900"><span>Total Recebido no Turno</span><span class="font-mono">${formatKzNumber(summary.totalReceivedAllMethods)} Kz</span></div>
          <div class="flex justify-between text-amber-800 pt-0.5"><span>Faturado a Crédito (Conta Corrente)</span><span class="font-mono font-semibold">${formatKzNumber(summary.salesCredit)} Kz</span></div>
          <div class="text-[10.5px] text-slate-500 pt-1">Faturas/Recibos válidos: ${summary.invoiceCount}${summary.cancelledCount > 0 ? ` · Anulados: ${summary.cancelledCount}` : ''}</div>
        </div>

        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-1.5 tabular-nums">
          <div class="text-[11px] font-bold text-slate-900 pb-1 border-b border-slate-200">Conferência Física de Gaveta (Numerário)</div>
          <div class="flex justify-between"><span>(+) Fundo inicial de abertura</span><span class="font-mono">${formatKzNumber(summary.openingFloat)} Kz</span></div>
          <div class="flex justify-between"><span>(+) Vendas líquidas em Dinheiro</span><span class="font-mono">${formatKzNumber(summary.salesCash)} Kz</span></div>
          <div class="flex justify-between"><span>(+) Liquidações de dívida em Dinheiro</span><span class="font-mono">${formatKzNumber(summary.debtCash)} Kz</span></div>
          <div class="flex justify-between"><span>(+) Reforços (${formatKzNumber(summary.reforcosTotal)}) + Entradas (${formatKzNumber(summary.entradasTotal)})</span><span class="font-mono">${formatKzNumber(summary.reforcosTotal + summary.entradasTotal)} Kz</span></div>
          <div class="flex justify-between"><span>(-) Sangrias (${formatKzNumber(summary.sangriasTotal)}) + Saídas (${formatKzNumber(summary.saidasTotal)})</span><span class="font-mono">${formatKzNumber(summary.sangriasTotal + summary.saidasTotal)} Kz</span></div>
          <div class="flex justify-between pt-1 border-t border-slate-200 font-bold text-slate-900"><span>Saldo Esperado em Caixa</span><span class="font-mono">${formatKzNumber(summary.expectedCash)} Kz</span></div>
          <div class="flex justify-between font-bold text-blue-700"><span>Dinheiro Contado pelo Operador</span><span class="font-mono">${counted !== null ? `${formatKzNumber(counted)} Kz` : '—'}</span></div>
          <div class="flex justify-between font-bold ${diff !== null && diff < -0.005 ? 'text-red-700' : diff !== null && diff > 0.005 ? 'text-amber-700' : 'text-emerald-700'}">
            <span>Diferença de Caixa</span>
            <span class="font-mono">${diffLabel}</span>
          </div>
        </div>
      </div>

      <div class="border border-slate-200 rounded-lg overflow-hidden">
        <table class="w-full text-left border-collapse text-[11px]">
          <thead>
            <tr class="bg-slate-900 text-white">
              <th class="py-2 px-2.5 font-semibold">Data / Hora</th>
              <th class="py-2 px-2.5 font-semibold">Tipo</th>
              <th class="py-2 px-2.5 font-semibold">Método</th>
              <th class="py-2 px-2.5 font-semibold">Descrição / Referência</th>
              <th class="py-2 px-2.5 font-semibold text-right">Valor</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 tabular-nums">${movRowsA4}</tbody>
        </table>
      </div>

      ${
        session.closingNotes
          ? `<div class="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-[11px]">
              <span class="font-bold text-slate-900">Observações / Justificação de fecho: </span>
              <span>${escapeHtml(session.closingNotes)}</span>
            </div>`
          : ''
      }

      <div class="mt-8 pt-6 grid grid-cols-2 gap-8 text-center text-[11px] text-slate-600">
        <div class="border-t border-slate-300 pt-2">Operador(a): ${escapeHtml(session.closedByOperator || session.operator)}</div>
        <div class="border-t border-slate-300 pt-2">Conferência / Gerência</div>
      </div>
      ${
        showViralFooter
          ? `<div class="mt-4 pt-2 border-t border-slate-100 text-center text-[10px] text-slate-400">Processado por SILA-Billing · Solução institucional VITRONIS (www.vitronis.co.ao)</div>`
          : ''
      }
    </div>
  `;
}

export function renderHistoryControlReportHtml(
  invoices: ReadonlyArray<InvoiceRecord>,
  filterLabel: string,
  company: CompanyProfile = NEUTRAL_PLATFORM_PROFILE,
  showViralFooter = false
): string {
  const sum = summarizeDocumentControlList(invoices);
  const nowDt = formatDateTimePt(new Date().toISOString());

  const rowsHtml =
    invoices.length === 0
      ? `<tr><td colspan="9" class="py-4 px-3 text-center text-slate-500">Nenhum documento encontrado para os filtros aplicados.</td></tr>`
      : invoices
          .map((inv) => {
            const dt = formatDateTimePt(inv.issuedAtIso);
            const cls = classifyInvoiceControlStatus(inv);
            const isCanc = inv.status === 'cancelled';
            const isNc = inv.docType === 'NC' && !isCanc;
            const totalPrefix = isNc ? '-' : '';
            return `
              <tr class="${isCanc ? 'text-slate-400' : 'text-slate-800'}">
                <td class="py-1.5 px-2 font-mono font-semibold ${isCanc ? 'line-through text-red-600' : 'text-slate-900'}">${escapeHtml(inv.number)}</td>
                <td class="py-1.5 px-2 font-mono">${dt.slashDate} ${dt.time}</td>
                <td class="py-1.5 px-2 truncate max-w-[160px]">${escapeHtml(inv.customerName)}</td>
                <td class="py-1.5 px-2 font-mono">${escapeHtml(inv.operator)} · Cx ${escapeHtml(inv.cashier)}</td>
                <td class="py-1.5 px-2 ${
                  isCanc
                    ? 'text-red-600 font-semibold'
                    : cls.state === 'PENDING' || cls.state === 'PARTIAL'
                      ? 'text-amber-700 font-semibold'
                      : isNc
                        ? 'text-blue-700 font-semibold'
                        : 'text-emerald-700 font-medium'
                }">${escapeHtml(cls.labelPt)}${inv.returnOriginNumber ? ` (${escapeHtml(inv.returnOriginNumber)})` : ''}</td>
                <td class="py-1.5 px-2 text-right font-mono">${isCanc ? '0,00' : `${totalPrefix}${formatKzNumber(inv.taxTotal || inv.taxAmount14)}`}</td>
                <td class="py-1.5 px-2 text-right font-mono font-semibold">${isCanc ? formatKzNumber(inv.grandTotal) : `${totalPrefix}${formatKzNumber(inv.grandTotal)}`}</td>
                <td class="py-1.5 px-2 text-right font-mono">${formatKzNumber(cls.paidAmount)}</td>
                <td class="py-1.5 px-2 text-right font-mono ${cls.dueAmount > 0 ? 'text-amber-700 font-semibold' : ''}">${formatKzNumber(cls.dueAmount)}</td>
              </tr>
              ${
                isCanc && inv.cancelReason
                  ? `<tr class="bg-red-50/40 text-[10px] text-red-700">
                      <td colspan="9" class="py-1 px-2">Anulação (${escapeHtml(inv.cancelledBy || 'Operador')}): ${escapeHtml(inv.cancelReason)}</td>
                    </tr>`
                  : ''
              }
            `;
          })
          .join('');

  return `
    <div class="print-target mx-auto w-full max-w-[794px] bg-white p-6 sm:p-8 text-slate-900 border border-slate-200 text-xs">
      <div class="flex items-start justify-between gap-4 pb-4 border-b border-slate-200">
        <div>
          <div class="text-base font-bold text-slate-900">${escapeHtml(company.shortName)} — MAPA DE CONTROLO DOCUMENTAL</div>
          <div class="text-[11px] text-slate-600">${escapeHtml(company.legalName)} · NIF ${escapeHtml(company.nif)}</div>
          <div class="text-[10.5px] text-slate-500 mt-0.5">${escapeHtml(filterLabel)}</div>
        </div>
        <div class="text-right text-[11px] font-mono tabular-nums text-slate-600 space-y-0.5">
          <div class="font-semibold text-slate-900">Emitido: ${nowDt.slashDate} ${nowDt.time}</div>
          <div>Registos listados: ${sum.totalDocs}</div>
        </div>
      </div>

      <div class="grid grid-cols-4 gap-3 py-4 tabular-nums">
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div class="text-[10px] text-slate-500">Faturação Líquida (Docs - NC)</div>
          <div class="text-sm font-bold font-mono text-slate-900 mt-0.5">${formatKzNumber(sum.netCommercialTotal)} Kz</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${sum.issuedFrCount} Docs · ${sum.creditNoteCount} NC</div>
        </div>
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div class="text-[10px] text-slate-500">Total Recebido (Pagas + Parc.)</div>
          <div class="text-sm font-bold font-mono text-emerald-700 mt-0.5">${formatKzNumber(sum.paidTotal)} Kz</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${sum.paidCount} pagas · ${sum.partialCount} parciais</div>
        </div>
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div class="text-[10px] text-slate-500">Saldo Pendente em Dívida</div>
          <div class="text-sm font-bold font-mono text-amber-700 mt-0.5">${formatKzNumber(sum.dueTotal)} Kz</div>
          <div class="text-[10px] text-slate-500 mt-0.5">${sum.pendingCount} pendentes · ${sum.partialCount} parciais</div>
        </div>
        <div class="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div class="text-[10px] text-slate-500">Notas Crédito / Anuladas</div>
          <div class="text-sm font-bold font-mono text-slate-900 mt-0.5">${formatKzNumber(sum.creditNoteTotal)} Kz</div>
          <div class="text-[10px] text-red-600 mt-0.5">${sum.cancelledCount} anuladas (${formatKzNumber(sum.cancelledTotal)} Kz)</div>
        </div>
      </div>

      <div class="border border-slate-200 rounded-lg overflow-hidden">
        <table class="w-full text-left border-collapse text-[10.5px]">
          <thead>
            <tr class="bg-slate-900 text-white">
              <th class="py-2 px-2 font-semibold">Documento</th>
              <th class="py-2 px-2 font-semibold">Data/Hora</th>
              <th class="py-2 px-2 font-semibold">Cliente</th>
              <th class="py-2 px-2 font-semibold">Operador</th>
              <th class="py-2 px-2 font-semibold">Estado</th>
              <th class="py-2 px-2 font-semibold text-right">Impostos</th>
              <th class="py-2 px-2 font-semibold text-right">Total</th>
              <th class="py-2 px-2 font-semibold text-right">Pago</th>
              <th class="py-2 px-2 font-semibold text-right">Dívida</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 tabular-nums">${rowsHtml}</tbody>
          <tfoot>
            <tr class="bg-slate-100 font-bold text-slate-900 border-t border-slate-300 tabular-nums">
              <td colspan="5" class="py-2 px-2">TOTAIS LÍQUIDOS VÁLIDOS (Base 14%: ${formatKzNumber(sum.taxBase14Total)} Kz${
                sum.taxBaseIntermediateTotal + sum.taxBaseReducedTotal > 0
                  ? ` · Interm./Red.: ${formatKzNumber(roundKz(sum.taxBaseIntermediateTotal + sum.taxBaseReducedTotal))} Kz`
                  : ''
              } · Isento 0%: ${formatKzNumber(sum.taxBase0Total)} Kz)</td>
              <td class="py-2 px-2 text-right font-mono">${formatKzNumber(sum.taxTotalAllRates)}</td>
              <td class="py-2 px-2 text-right font-mono">${formatKzNumber(sum.netCommercialTotal)}</td>
              <td class="py-2 px-2 text-right font-mono text-emerald-700">${formatKzNumber(sum.paidTotal)}</td>
              <td class="py-2 px-2 text-right font-mono text-amber-700">${formatKzNumber(sum.dueTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      ${
        showViralFooter
          ? `<div class="mt-4 pt-2 border-t border-slate-100 text-center text-[10px] text-slate-400">Processado por SILA-Billing · Solução institucional VITRONIS (www.vitronis.co.ao)</div>`
          : ''
      }
    </div>
  `;
}


