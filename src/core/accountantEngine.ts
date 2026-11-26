import { formatDateTimePt, formatKzNumber, roundKz } from './billingEngine.ts';
import {
  AGT_IVA_EXEMPTION_CODES,
  type AgtIvaExemptionCode,
  type AgtSeriesRecord,
} from './fiscalTypes.ts';
import {
  generateMonthlySaftAoXml,
  type SaftExportResult,
} from './saftGenerator.ts';
import {
  validateSaftAoXsdStrict,
  type SaftXsdValidationReport,
} from './saftXsdValidator.ts';
import {
  buildMinimalXlsxBytes,
  buildStoreZip,
} from './spreadsheetImport.ts';
import {
  formatDocumentTypeLabelPt,
  type CashMovement,
  type CashSession,
  type CompanyProfile,
  type Customer,
  type InvoiceRecord,
  type Product,
  type PurchaseRecord,
  type SecurityAuditEntry,
  type Supplier,
} from './types.ts';

const PT_MONTH_NAMES = [
  'Janeiro',
  'Fevereiro',
  'Março',
  'Abril',
  'Maio',
  'Junho',
  'Julho',
  'Agosto',
  'Setembro',
  'Outubro',
  'Novembro',
  'Dezembro',
] as const;

const SERVICE_UNIT_SET = new Set([
  'serv',
  'srv',
  'hr',
  'h',
  'hora',
  'horas',
  'mês',
  'mes',
  'meses',
  'dia',
  'dias',
]);

export interface AccountantMonthScope {
  yearMonth: string; // YYYY-MM
  year: number;
  month: number; // 1..12
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  labelPt: string;
  submissionDeadline: string;
}

export interface AccountantMonthOption {
  yearMonth: string;
  labelPt: string;
  invoiceCount: number;
}

export interface AccountantVatRateLine {
  code: 'NOR' | 'INT' | 'RED' | 'ISE';
  label: string;
  rateLabel: string;
  grossBase: number;
  grossTax: number;
  creditNotesBase: number;
  creditNotesTax: number;
  netBase: number;
  netTax: number;
}

export interface AccountantVatExemptionLine {
  exemptionCode: string;
  descriptionPt: string;
  grossBase: number;
  creditNotesBase: number;
  netBase: number;
  documentCount: number;
}

export interface AccountantVatReport {
  scope: AccountantMonthScope;
  activeFiscalCount: number;
  creditNotesCount: number;
  cancelledInMonthCount: number;
  nonFiscalProformaCount: number;
  receiptsCount: number;
  grossTaxableBase: number;
  grossVatTotal: number;
  grossGrandTotal: number;
  creditNotesBase: number;
  creditNotesVat: number;
  creditNotesGrandTotal: number;
  netTaxableBase: number;
  netVatPayable: number;
  netGrandTotal: number;
  proformaReferenceTotal: number;
  cancelledReferenceTotal: number;
  rateLines: AccountantVatRateLine[];
  exemptionLines: AccountantVatExemptionLine[];
}

export interface AccountantWithholdingDocRow {
  invoiceId: string;
  number: string;
  docType: string;
  issuedAtIso: string;
  customerName: string;
  customerNif: string;
  serviceBase: number;
  serviceVat: number;
  estimatedIiWithholding: number;
  estimatedVatRetention: number;
  isCreditNote: boolean;
}

export interface AccountantSupplierPurchaseRow {
  supplierId: string;
  supplierName: string;
  supplierNif: string;
  purchaseCount: number;
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
}

export interface AccountantWithholdingReport {
  scope: AccountantMonthScope;
  iiRatePct: number;
  isVatRetentionAgent: boolean;
  vatRetentionRatePct: number;
  netServiceBase: number;
  netServiceVat: number;
  estimatedIiTotal: number;
  estimatedVatRetentionTotal: number;
  serviceDocumentCount: number;
  serviceDocuments: AccountantWithholdingDocRow[];
  purchasesActiveCount: number;
  purchasesCancelledCount: number;
  purchasesTotalAmount: number;
  purchasesPaidAmount: number;
  purchasesDueAmount: number;
  supplierRows: AccountantSupplierPurchaseRow[];
}

export interface AccountantCancelledDocRow {
  id: string;
  number: string;
  docType: string;
  docTypeLabel: string;
  issuedAtIso: string;
  cancelledAtIso: string;
  cancelledBy: string;
  cancelReason: string;
  customerName: string;
  customerNif: string;
  taxTotal: number;
  grandTotal: number;
}

export interface AccountantRectifiedDocRow {
  id: string;
  number: string;
  docType: 'NC' | 'ND';
  docTypeLabel: string;
  issuedAtIso: string;
  originNumber: string;
  customerName: string;
  customerNif: string;
  operator: string;
  notes: string;
  taxImpact: number;
  grossImpact: number;
  grandTotal: number;
}

export interface AccountantCancelledRectifiedReport {
  scope: AccountantMonthScope;
  cancelledCount: number;
  cancelledVatTotal: number;
  cancelledGrossTotal: number;
  creditNotesCount: number;
  creditNotesVatTotal: number;
  creditNotesGrossTotal: number;
  debitNotesCount: number;
  debitNotesVatTotal: number;
  debitNotesGrossTotal: number;
  cancelledDocs: AccountantCancelledDocRow[];
  rectifyingDocs: AccountantRectifiedDocRow[];
}

export type AccountantAuditCategory =
  | 'ALL'
  | 'DOCUMENTS'
  | 'PRICES_CUSTOMERS'
  | 'ACCESS_SECURITY'
  | 'USERS_ROLES';

export interface AccountantAuditTrailItem {
  id: string;
  timestampIso: string;
  category: Exclude<AccountantAuditCategory, 'ALL'>;
  actionCode: string;
  actionLabel: string;
  actorName: string;
  actorRole: string;
  targetRef: string;
  summary: string;
  outcome: 'allowed' | 'denied';
  source: 'security_log' | 'price_history' | 'customer_history' | 'invoice_lifecycle';
}

export interface AccountantSeriesSalesRow {
  docType: string;
  docTypeLabel: string;
  seriesCode: string;
  activeCount: number;
  cancelledCount: number;
  taxBaseTotal: number;
  taxTotal: number;
  grandTotal: number;
}

export interface AccountantPaymentMethodRow {
  method: string;
  amount: number;
  sharePct: number;
}

export interface AccountantCashSessionRow {
  id: string;
  cashier: string;
  operator: string;
  status: 'open' | 'closed';
  openedAtIso: string;
  closedAtIso: string;
  openingFloat: number;
  expectedCash: number;
  countedCash: number | null;
  differenceAmount: number | null;
  invoiceCount: number;
}

export interface AccountantAuxiliaryMaps {
  scope: AccountantMonthScope;
  seriesSales: AccountantSeriesSalesRow[];
  paymentMethods: AccountantPaymentMethodRow[];
  cashSessions: AccountantCashSessionRow[];
  cashSessionCount: number;
  cashClosedCount: number;
  cashTotalExpected: number;
  cashTotalCounted: number;
  cashNetDifference: number;
  configuredSeriesCount: number;
  activeSeriesCount: number;
}

export interface AccountantMonthlyPackage {
  scope: AccountantMonthScope;
  company: CompanyProfile;
  saftResult: SaftExportResult;
  xsdReport: SaftXsdValidationReport;
  vatReport: AccountantVatReport;
  withholdingReport: AccountantWithholdingReport;
  cancelledRectified: AccountantCancelledRectifiedReport;
  auxiliaryMaps: AccountantAuxiliaryMaps;
  auditEntriesInMonth: AccountantAuditTrailItem[];
}

export function resolveAccountantMonthScope(yearMonthRaw?: string): AccountantMonthScope {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  const match = String(yearMonthRaw || '')
    .trim()
    .match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const parsedYear = Number(match[1]);
    const parsedMonth = Number(match[2]);
    if (parsedYear >= 2020 && parsedYear <= 2099 && parsedMonth >= 1 && parsedMonth <= 12) {
      year = parsedYear;
      month = parsedMonth;
    }
  }

  const monthPad = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const monthName = PT_MONTH_NAMES[month - 1] || monthPad;
  const nextMonthName = PT_MONTH_NAMES[nextMonth - 1] || String(nextMonth).padStart(2, '0');

  return {
    yearMonth: `${year}-${monthPad}`,
    year,
    month,
    startDate: `${year}-${monthPad}-01`,
    endDate: `${year}-${monthPad}-${String(lastDay).padStart(2, '0')}`,
    labelPt: `${monthName} ${year}`,
    submissionDeadline: `15 de ${nextMonthName} de ${nextYear}`,
  };
}

export function buildAccountantMonthOptions(params: {
  invoices: InvoiceRecord[];
  purchases?: PurchaseRecord[];
  cashSessions?: CashSession[];
  securityAuditLogs?: SecurityAuditEntry[];
  referenceDate?: Date;
}): AccountantMonthOption[] {
  const ref = params.referenceDate || new Date();
  const counts = new Map<string, number>();

  for (let i = 0; i < 3; i += 1) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!counts.has(ym)) counts.set(ym, 0);
  }

  for (const inv of params.invoices) {
    const ym = (inv.issuedAtIso || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym)) {
      counts.set(ym, (counts.get(ym) || 0) + 1);
    }
  }
  for (const pur of params.purchases || []) {
    const ym = (pur.issuedAtIso || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym) && !counts.has(ym)) {
      counts.set(ym, 0);
    }
  }
  for (const sess of params.cashSessions || []) {
    const ym = (sess.openedAtIso || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym) && !counts.has(ym)) {
      counts.set(ym, 0);
    }
  }
  for (const log of params.securityAuditLogs || []) {
    const ym = (log.createdAtIso || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym) && !counts.has(ym)) {
      counts.set(ym, 0);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([ym, invoiceCount]) => ({
      yearMonth: ym,
      labelPt: resolveAccountantMonthScope(ym).labelPt,
      invoiceCount,
    }));
}

function isDateInScope(isoDate: string | undefined, scope: AccountantMonthScope): boolean {
  if (!isoDate || isoDate.length < 10) return false;
  const d = isoDate.slice(0, 10);
  return d >= scope.startDate && d <= scope.endDate;
}

function getInvoiceTotalBase(inv: InvoiceRecord): number {
  return roundKz(
    (inv.taxBase14 || 0) +
      (inv.taxBaseIntermediate || 0) +
      (inv.taxBaseReduced || 0) +
      (inv.taxBase0 || 0)
  );
}

function resolveDefaultExemptionCode(company: CompanyProfile): AgtIvaExemptionCode {
  if (company.defaultExemptionCode && AGT_IVA_EXEMPTION_CODES[company.defaultExemptionCode]) {
    return company.defaultExemptionCode;
  }
  if (company.taxRegime === 'EXCLUSAO') return 'M80';
  if (company.taxRegime === 'SIMPLIFICADO') return 'M81';
  return 'M10';
}

function distributeInvoiceExemptionBases(
  inv: InvoiceRecord,
  fallbackCode: AgtIvaExemptionCode
): Map<string, number> {
  const result = new Map<string, number>();
  const targetBase0 = roundKz(inv.taxBase0 || 0);
  if (targetBase0 <= 0.004) return result;

  const discountFactor =
    typeof inv.globalDiscountPct === 'number' && inv.globalDiscountPct > 0
      ? Math.max(0, 1 - inv.globalDiscountPct / 100)
      : 1;

  let rawSum = 0;
  const entries: Array<{ code: string; base: number }> = [];
  for (const line of inv.lines || []) {
    if (line.ivaRate !== 0) continue;
    const code = (line.exemptionCode || fallbackCode || 'M10').trim().toUpperCase();
    const scaled = roundKz((line.lineBase || line.lineNet || 0) * discountFactor);
    if (scaled > 0) {
      entries.push({ code, base: scaled });
      rawSum += scaled;
    }
  }

  if (entries.length === 0) {
    result.set(fallbackCode, targetBase0);
    return result;
  }

  let running = 0;
  entries.forEach((e, idx) => {
    const val =
      idx === entries.length - 1
        ? roundKz(targetBase0 - running)
        : roundKz(rawSum > 0 ? (e.base / rawSum) * targetBase0 : e.base);
    running = roundKz(running + val);
    result.set(e.code, roundKz((result.get(e.code) || 0) + val));
  });

  return result;
}

export function buildAccountantVatReport(params: {
  company: CompanyProfile;
  invoices: InvoiceRecord[];
  yearMonth: string;
}): AccountantVatReport {
  const scope = resolveAccountantMonthScope(params.yearMonth);
  const fallbackExemption = resolveDefaultExemptionCode(params.company);

  const monthInvoices = params.invoices.filter((inv) => isDateInScope(inv.issuedAtIso, scope));
  const activeFiscalSales: InvoiceRecord[] = [];
  const creditNotes: InvoiceRecord[] = [];
  const cancelledInMonth: InvoiceRecord[] = [];
  const nonFiscalWorkDocs: InvoiceRecord[] = [];
  const receipts: InvoiceRecord[] = [];

  for (const inv of monthInvoices) {
    if (inv.status === 'cancelled') {
      cancelledInMonth.push(inv);
      continue;
    }
    if (inv.docType === 'NC') {
      creditNotes.push(inv);
    } else if (inv.docType === 'FP' || inv.docType === 'CS') {
      nonFiscalWorkDocs.push(inv);
    } else if (inv.docType === 'RC') {
      receipts.push(inv);
    } else {
      activeFiscalSales.push(inv);
    }
  }

  const acc = {
    NOR: { grossBase: 0, grossTax: 0, creditBase: 0, creditTax: 0 },
    INT: { grossBase: 0, grossTax: 0, creditBase: 0, creditTax: 0 },
    RED: { grossBase: 0, grossTax: 0, creditBase: 0, creditTax: 0 },
    ISE: { grossBase: 0, grossTax: 0, creditBase: 0, creditTax: 0 },
  };

  let grossGrandTotal = 0;
  let creditNotesGrandTotal = 0;

  const exemptionMap = new Map<
    string,
    { grossBase: number; creditNotesBase: number; docIds: Set<string> }
  >();

  const touchExemption = (code: string, amount: number, isCredit: boolean, docId: string) => {
    const existing = exemptionMap.get(code) || {
      grossBase: 0,
      creditNotesBase: 0,
      docIds: new Set<string>(),
    };
    if (isCredit) existing.creditNotesBase = roundKz(existing.creditNotesBase + amount);
    else existing.grossBase = roundKz(existing.grossBase + amount);
    existing.docIds.add(docId);
    exemptionMap.set(code, existing);
  };

  for (const inv of activeFiscalSales) {
    acc.NOR.grossBase = roundKz(acc.NOR.grossBase + (inv.taxBase14 || 0));
    acc.NOR.grossTax = roundKz(acc.NOR.grossTax + (inv.taxAmount14 || 0));
    acc.INT.grossBase = roundKz(acc.INT.grossBase + (inv.taxBaseIntermediate || 0));
    acc.INT.grossTax = roundKz(acc.INT.grossTax + (inv.taxAmountIntermediate || 0));
    acc.RED.grossBase = roundKz(acc.RED.grossBase + (inv.taxBaseReduced || 0));
    acc.RED.grossTax = roundKz(acc.RED.grossTax + (inv.taxAmountReduced || 0));
    acc.ISE.grossBase = roundKz(acc.ISE.grossBase + (inv.taxBase0 || 0));
    grossGrandTotal = roundKz(grossGrandTotal + (inv.grandTotal || 0));

    const exDist = distributeInvoiceExemptionBases(inv, fallbackExemption);
    for (const [code, base] of exDist.entries()) {
      touchExemption(code, base, false, inv.id);
    }
  }

  for (const nc of creditNotes) {
    acc.NOR.creditBase = roundKz(acc.NOR.creditBase + (nc.taxBase14 || 0));
    acc.NOR.creditTax = roundKz(acc.NOR.creditTax + (nc.taxAmount14 || 0));
    acc.INT.creditBase = roundKz(acc.INT.creditBase + (nc.taxBaseIntermediate || 0));
    acc.INT.creditTax = roundKz(acc.INT.creditTax + (nc.taxAmountIntermediate || 0));
    acc.RED.creditBase = roundKz(acc.RED.creditBase + (nc.taxBaseReduced || 0));
    acc.RED.creditTax = roundKz(acc.RED.creditTax + (nc.taxAmountReduced || 0));
    acc.ISE.creditBase = roundKz(acc.ISE.creditBase + (nc.taxBase0 || 0));
    creditNotesGrandTotal = roundKz(creditNotesGrandTotal + (nc.grandTotal || 0));

    const exDist = distributeInvoiceExemptionBases(nc, fallbackExemption);
    for (const [code, base] of exDist.entries()) {
      touchExemption(code, base, true, nc.id);
    }
  }

  const rateLines: AccountantVatRateLine[] = [
    {
      code: 'NOR',
      label: 'Taxa Normal (Geral)',
      rateLabel: '14%',
      grossBase: acc.NOR.grossBase,
      grossTax: acc.NOR.grossTax,
      creditNotesBase: acc.NOR.creditBase,
      creditNotesTax: acc.NOR.creditTax,
      netBase: roundKz(acc.NOR.grossBase - acc.NOR.creditBase),
      netTax: roundKz(acc.NOR.grossTax - acc.NOR.creditTax),
    },
    {
      code: 'INT',
      label: 'Taxa Intermédia (Cesta / Cabinda)',
      rateLabel: params.company.specialTaxTerritory === 'AO-CAB' ? '1% / 7%' : '7% / 1%',
      grossBase: acc.INT.grossBase,
      grossTax: acc.INT.grossTax,
      creditNotesBase: acc.INT.creditBase,
      creditNotesTax: acc.INT.creditTax,
      netBase: roundKz(acc.INT.grossBase - acc.INT.creditBase),
      netTax: roundKz(acc.INT.grossTax - acc.INT.creditTax),
    },
    {
      code: 'RED',
      label: 'Taxa Reduzida',
      rateLabel: '5%',
      grossBase: acc.RED.grossBase,
      grossTax: acc.RED.grossTax,
      creditNotesBase: acc.RED.creditBase,
      creditNotesTax: acc.RED.creditTax,
      netBase: roundKz(acc.RED.grossBase - acc.RED.creditBase),
      netTax: roundKz(acc.RED.grossTax - acc.RED.creditTax),
    },
    {
      code: 'ISE',
      label: 'Isento / Não Sujeito',
      rateLabel: '0%',
      grossBase: acc.ISE.grossBase,
      grossTax: 0,
      creditNotesBase: acc.ISE.creditBase,
      creditNotesTax: 0,
      netBase: roundKz(acc.ISE.grossBase - acc.ISE.creditBase),
      netTax: 0,
    },
  ];

  const grossTaxableBase = roundKz(rateLines.reduce((s, r) => s + r.grossBase, 0));
  const grossVatTotal = roundKz(rateLines.reduce((s, r) => s + r.grossTax, 0));
  const creditNotesBase = roundKz(rateLines.reduce((s, r) => s + r.creditNotesBase, 0));
  const creditNotesVat = roundKz(rateLines.reduce((s, r) => s + r.creditNotesTax, 0));

  const exemptionLines: AccountantVatExemptionLine[] = Array.from(exemptionMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, data]) => {
      const meta = AGT_IVA_EXEMPTION_CODES[code as AgtIvaExemptionCode];
      return {
        exemptionCode: code,
        descriptionPt: meta?.descriptionPt || `Código de isenção ${code}`,
        grossBase: data.grossBase,
        creditNotesBase: data.creditNotesBase,
        netBase: roundKz(data.grossBase - data.creditNotesBase),
        documentCount: data.docIds.size,
      };
    });

  return {
    scope,
    activeFiscalCount: activeFiscalSales.length,
    creditNotesCount: creditNotes.length,
    cancelledInMonthCount: cancelledInMonth.length,
    nonFiscalProformaCount: nonFiscalWorkDocs.length,
    receiptsCount: receipts.length,
    grossTaxableBase,
    grossVatTotal,
    grossGrandTotal,
    creditNotesBase,
    creditNotesVat,
    creditNotesGrandTotal,
    netTaxableBase: roundKz(grossTaxableBase - creditNotesBase),
    netVatPayable: roundKz(grossVatTotal - creditNotesVat),
    netGrandTotal: roundKz(grossGrandTotal - creditNotesGrandTotal),
    proformaReferenceTotal: roundKz(nonFiscalWorkDocs.reduce((s, d) => s + (d.grandTotal || 0), 0)),
    cancelledReferenceTotal: roundKz(cancelledInMonth.reduce((s, d) => s + (d.grandTotal || 0), 0)),
    rateLines,
    exemptionLines,
  };
}

function isServiceLine(
  line: InvoiceRecord['lines'][number],
  productById: Map<string, Product>
): boolean {
  const prod = line.productId ? productById.get(line.productId) : undefined;
  if (prod?.productType === 'S') return true;
  if (prod?.productType === 'P' || prod?.productType === 'K') return false;
  const unit = (line.unit || '').trim().toLowerCase();
  if (SERVICE_UNIT_SET.has(unit)) return true;
  const cat = (prod?.category || '').trim().toLowerCase();
  return cat.includes('servi');
}

export function buildAccountantWithholdingReport(params: {
  company: CompanyProfile;
  invoices: InvoiceRecord[];
  products: Product[];
  purchases?: PurchaseRecord[];
  yearMonth: string;
}): AccountantWithholdingReport {
  const scope = resolveAccountantMonthScope(params.yearMonth);
  const productById = new Map<string, Product>();
  for (const p of params.products) productById.set(p.id, p);

  const iiRatePct =
    typeof params.company.defaultWithholdingTax === 'number' &&
    params.company.defaultWithholdingTax > 0
      ? params.company.defaultWithholdingTax
      : 6.5;
  const isVatRetentionAgent = Boolean(params.company.isVatRetentionAgent);
  const vatRetentionRatePct = isVatRetentionAgent ? 50 : 0;

  const monthDocs = params.invoices.filter(
    (inv) =>
      isDateInScope(inv.issuedAtIso, scope) &&
      inv.status !== 'cancelled' &&
      inv.docType !== 'FP' &&
      inv.docType !== 'CS' &&
      inv.docType !== 'RC'
  );

  const serviceDocuments: AccountantWithholdingDocRow[] = [];
  let netServiceBase = 0;
  let netServiceVat = 0;

  for (const inv of monthDocs) {
    const discountFactor =
      typeof inv.globalDiscountPct === 'number' && inv.globalDiscountPct > 0
        ? Math.max(0, 1 - inv.globalDiscountPct / 100)
        : 1;

    let docServiceBase = 0;
    let docServiceVat = 0;

    for (const line of inv.lines || []) {
      if (!isServiceLine(line, productById)) continue;
      docServiceBase = roundKz(docServiceBase + (line.lineBase || 0) * discountFactor);
      docServiceVat = roundKz(docServiceVat + (line.lineTax || 0) * discountFactor);
    }

    if (docServiceBase <= 0.004 && docServiceVat <= 0.004) continue;

    const sign = inv.docType === 'NC' ? -1 : 1;
    const signedBase = roundKz(docServiceBase * sign);
    const signedVat = roundKz(docServiceVat * sign);
    const iiWithheld = roundKz(signedBase * (iiRatePct / 100));
    const vatRet = isVatRetentionAgent ? roundKz(signedVat * (vatRetentionRatePct / 100)) : 0;

    netServiceBase = roundKz(netServiceBase + signedBase);
    netServiceVat = roundKz(netServiceVat + signedVat);

    serviceDocuments.push({
      invoiceId: inv.id,
      number: inv.number,
      docType: inv.docType,
      issuedAtIso: inv.issuedAtIso,
      customerName: inv.customerName,
      customerNif: inv.customerNif,
      serviceBase: signedBase,
      serviceVat: signedVat,
      estimatedIiWithholding: iiWithheld,
      estimatedVatRetention: vatRet,
      isCreditNote: inv.docType === 'NC',
    });
  }

  serviceDocuments.sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso));

  const monthPurchases = (params.purchases || []).filter((p) => isDateInScope(p.issuedAtIso, scope));
  const activePurchases = monthPurchases.filter((p) => p.status !== 'cancelled');
  const cancelledPurchases = monthPurchases.filter((p) => p.status === 'cancelled');

  const supplierMap = new Map<string, AccountantSupplierPurchaseRow>();
  for (const p of activePurchases) {
    const key = p.supplierId || p.supplierNif || p.supplierName;
    const prev = supplierMap.get(key) || {
      supplierId: p.supplierId,
      supplierName: p.supplierName || 'Fornecedor',
      supplierNif: p.supplierNif || '---',
      purchaseCount: 0,
      totalAmount: 0,
      amountPaid: 0,
      amountDue: 0,
    };
    prev.purchaseCount += 1;
    prev.totalAmount = roundKz(prev.totalAmount + (p.totalAmount || 0));
    prev.amountPaid = roundKz(prev.amountPaid + (p.amountPaid || 0));
    prev.amountDue = roundKz(prev.amountDue + (p.amountDue || 0));
    supplierMap.set(key, prev);
  }

  return {
    scope,
    iiRatePct,
    isVatRetentionAgent,
    vatRetentionRatePct,
    netServiceBase,
    netServiceVat,
    estimatedIiTotal: roundKz(netServiceBase * (iiRatePct / 100)),
    estimatedVatRetentionTotal: isVatRetentionAgent
      ? roundKz(netServiceVat * (vatRetentionRatePct / 100))
      : 0,
    serviceDocumentCount: serviceDocuments.length,
    serviceDocuments,
    purchasesActiveCount: activePurchases.length,
    purchasesCancelledCount: cancelledPurchases.length,
    purchasesTotalAmount: roundKz(activePurchases.reduce((s, p) => s + (p.totalAmount || 0), 0)),
    purchasesPaidAmount: roundKz(activePurchases.reduce((s, p) => s + (p.amountPaid || 0), 0)),
    purchasesDueAmount: roundKz(activePurchases.reduce((s, p) => s + (p.amountDue || 0), 0)),
    supplierRows: Array.from(supplierMap.values()).sort((a, b) => b.totalAmount - a.totalAmount),
  };
}

export function buildCancelledAndRectifiedReport(params: {
  invoices: InvoiceRecord[];
  yearMonth: string;
}): AccountantCancelledRectifiedReport {
  const scope = resolveAccountantMonthScope(params.yearMonth);

  const cancelledDocs: AccountantCancelledDocRow[] = params.invoices
    .filter(
      (inv) =>
        inv.status === 'cancelled' &&
        (isDateInScope(inv.issuedAtIso, scope) || isDateInScope(inv.cancelledAtIso, scope))
    )
    .sort((a, b) =>
      (b.cancelledAtIso || b.issuedAtIso).localeCompare(a.cancelledAtIso || a.issuedAtIso)
    )
    .map((inv) => ({
      id: inv.id,
      number: inv.number,
      docType: inv.docType,
      docTypeLabel: formatDocumentTypeLabelPt(inv.docType),
      issuedAtIso: inv.issuedAtIso,
      cancelledAtIso: inv.cancelledAtIso || inv.updatedAtIso || inv.issuedAtIso,
      cancelledBy: inv.cancelledBy || inv.operator || '---',
      cancelReason: inv.cancelReason || 'Sem justificação registada',
      customerName: inv.customerName,
      customerNif: inv.customerNif,
      taxTotal: roundKz(inv.taxTotal || 0),
      grandTotal: roundKz(inv.grandTotal || 0),
    }));

  const rectifyingDocs: AccountantRectifiedDocRow[] = params.invoices
    .filter(
      (inv) =>
        inv.status !== 'cancelled' &&
        (inv.docType === 'NC' || inv.docType === 'ND') &&
        isDateInScope(inv.issuedAtIso, scope)
    )
    .sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso))
    .map((inv) => {
      const sign = inv.docType === 'NC' ? -1 : 1;
      return {
        id: inv.id,
        number: inv.number,
        docType: inv.docType as 'NC' | 'ND',
        docTypeLabel: formatDocumentTypeLabelPt(inv.docType),
        issuedAtIso: inv.issuedAtIso,
        originNumber: inv.returnOriginNumber || '---',
        customerName: inv.customerName,
        customerNif: inv.customerNif,
        operator: inv.operator || '---',
        notes: inv.notes || '',
        taxImpact: roundKz((inv.taxTotal || 0) * sign),
        grossImpact: roundKz((inv.grandTotal || 0) * sign),
        grandTotal: roundKz(inv.grandTotal || 0),
      };
    });

  const creditDocs = rectifyingDocs.filter((r) => r.docType === 'NC');
  const debitDocs = rectifyingDocs.filter((r) => r.docType === 'ND');

  return {
    scope,
    cancelledCount: cancelledDocs.length,
    cancelledVatTotal: roundKz(cancelledDocs.reduce((s, d) => s + d.taxTotal, 0)),
    cancelledGrossTotal: roundKz(cancelledDocs.reduce((s, d) => s + d.grandTotal, 0)),
    creditNotesCount: creditDocs.length,
    creditNotesVatTotal: roundKz(creditDocs.reduce((s, d) => s + Math.abs(d.taxImpact), 0)),
    creditNotesGrossTotal: roundKz(creditDocs.reduce((s, d) => s + d.grandTotal, 0)),
    debitNotesCount: debitDocs.length,
    debitNotesVatTotal: roundKz(debitDocs.reduce((s, d) => s + d.taxImpact, 0)),
    debitNotesGrossTotal: roundKz(debitDocs.reduce((s, d) => s + d.grandTotal, 0)),
    cancelledDocs,
    rectifyingDocs,
  };
}

function classifySecurityActionCategory(
  action: string
): Exclude<AccountantAuditCategory, 'ALL'> {
  if (action === 'INVOICE_EMIT' || action === 'INVOICE_CANCEL') return 'DOCUMENTS';
  if (action === 'PRICE_EDIT' || action === 'DISCOUNT_OVERRIDE') return 'PRICES_CUSTOMERS';
  if (
    action === 'USER_CREATE' ||
    action === 'USER_UPDATE' ||
    action === 'USER_SUSPEND' ||
    action === 'ROLE_UPDATE' ||
    action === 'INVITE_CLAIM'
  ) {
    return 'USERS_ROLES';
  }
  return 'ACCESS_SECURITY';
}

function formatSecurityActionPt(action: string): string {
  switch (action) {
    case 'LOGIN':
      return 'Início de sessão Cloud';
    case 'LOGOUT':
      return 'Fim de sessão Cloud';
    case 'PIN_SETUP':
      return 'Configuração de PIN';
    case 'PIN_UNLOCK_OK':
      return 'Desbloqueio de terminal';
    case 'PIN_UNLOCK_FAIL':
      return 'PIN inválido';
    case 'PIN_LOCKOUT':
      return 'Bloqueio por tentativas';
    case 'TERMINAL_LOCK':
      return 'Terminal bloqueado';
    case 'OPERATOR_SWITCH':
      return 'Troca de operador';
    case 'ACCESS_DENIED':
      return 'Acesso bloqueado (RBAC)';
    case 'INVOICE_EMIT':
      return 'Emissão documental';
    case 'INVOICE_CANCEL':
      return 'Anulação de documento';
    case 'PRICE_EDIT':
      return 'Alteração de preço';
    case 'DISCOUNT_OVERRIDE':
      return 'Desconto especial';
    case 'USER_CREATE':
      return 'Criação de utilizador';
    case 'USER_UPDATE':
      return 'Edição de utilizador';
    case 'USER_SUSPEND':
      return 'Suspensão / estado de utilizador';
    case 'ROLE_UPDATE':
      return 'Alteração de função / permissões';
    case 'INVITE_CLAIM':
      return 'Convite aceite na equipa';
    case 'PRIVACY_ACCEPTED':
      return 'Política de privacidade aceite';
    default:
      return action;
  }
}

export function buildAccountantAuditTrail(params: {
  securityAuditLogs: SecurityAuditEntry[];
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  yearMonth?: string;
  periodMode?: 'MONTH' | 'ALL';
  category?: AccountantAuditCategory;
  search?: string;
  canViewCostPrices: boolean;
}): AccountantAuditTrailItem[] {
  const items: AccountantAuditTrailItem[] = [];
  const scope = params.yearMonth ? resolveAccountantMonthScope(params.yearMonth) : null;
  const periodMode = params.periodMode || 'MONTH';
  const loggedCancelTargets = new Set<string>();

  for (const log of params.securityAuditLogs) {
    if (log.action === 'INVOICE_CANCEL' && log.targetId) {
      loggedCancelTargets.add(log.targetId);
    }
    items.push({
      id: `sec_${log.id}`,
      timestampIso: log.createdAtIso,
      category: classifySecurityActionCategory(log.action),
      actionCode: log.action,
      actionLabel: formatSecurityActionPt(log.action),
      actorName: log.actorName || log.actorEmail || 'Sistema',
      actorRole: log.actorRole || '---',
      targetRef: log.targetId || log.targetType || '---',
      summary: log.summary,
      outcome: log.outcome === 'denied' ? 'denied' : 'allowed',
      source: 'security_log',
    });
  }

  for (const prod of params.products) {
    for (const [idx, ch] of (prod.priceHistory || []).entries()) {
      const costSuffix =
        params.canViewCostPrices &&
        typeof ch.previousCost === 'number' &&
        typeof ch.newCost === 'number' &&
        ch.previousCost !== ch.newCost
          ? ` · Custo: ${formatKzNumber(ch.previousCost)} → ${formatKzNumber(ch.newCost)} Kz`
          : '';
      items.push({
        id: `price_${prod.id}_${idx}_${ch.changedAtIso}`,
        timestampIso: ch.changedAtIso,
        category: 'PRICES_CUSTOMERS',
        actionCode: 'PRODUCT_PRICE_CHANGE',
        actionLabel: 'Histórico de preço (Artigo)',
        actorName: ch.changedBy || 'Operador',
        actorRole: 'Catálogo',
        targetRef: prod.code || prod.name,
        summary: `${prod.name} (${prod.code}): Preço ${formatKzNumber(ch.previousPrice)} → ${formatKzNumber(ch.newPrice)} Kz${costSuffix}`,
        outcome: 'allowed',
        source: 'price_history',
      });
    }
  }

  for (const cust of params.customers) {
    for (const [idx, ch] of (cust.changeHistory || []).entries()) {
      items.push({
        id: `cust_${cust.id}_${idx}_${ch.changedAtIso}`,
        timestampIso: ch.changedAtIso,
        category: 'PRICES_CUSTOMERS',
        actionCode: 'CUSTOMER_CHANGE',
        actionLabel: 'Alteração de ficha de cliente',
        actorName: ch.changedBy || 'Operador',
        actorRole: 'Clientes',
        targetRef: cust.internalCode || cust.nif || cust.name,
        summary: `${cust.name}: ${ch.summary}`,
        outcome: 'allowed',
        source: 'customer_history',
      });
    }
  }

  for (const inv of params.invoices) {
    if (inv.status === 'cancelled' && !loggedCancelTargets.has(inv.id) && !loggedCancelTargets.has(inv.number)) {
      items.push({
        id: `invcancel_${inv.id}`,
        timestampIso: inv.cancelledAtIso || inv.updatedAtIso || inv.issuedAtIso,
        category: 'DOCUMENTS',
        actionCode: 'INVOICE_CANCEL',
        actionLabel: 'Anulação de documento',
        actorName: inv.cancelledBy || inv.operator || 'Gestão',
        actorRole: 'Facturação',
        targetRef: inv.number,
        summary: `${inv.number} (${inv.customerName}, ${formatKzNumber(inv.grandTotal)} Kz) anulado: ${inv.cancelReason || 'Sem motivo'}`,
        outcome: 'allowed',
        source: 'invoice_lifecycle',
      });
    }
    if ((inv.reprintCount || 0) > 0 && inv.lastReprintedAtIso) {
      items.push({
        id: `invreprint_${inv.id}`,
        timestampIso: inv.lastReprintedAtIso,
        category: 'DOCUMENTS',
        actionCode: 'INVOICE_REPRINT',
        actionLabel: '2.ª Via / Reimpressão',
        actorName: inv.lastReprintedBy || inv.operator || 'Operador',
        actorRole: 'Facturação',
        targetRef: inv.number,
        summary: `${inv.number} reimpresso (${inv.reprintCount}x no total) — Cliente: ${inv.customerName}`,
        outcome: 'allowed',
        source: 'invoice_lifecycle',
      });
    }
  }

  const query = String(params.search || '')
    .trim()
    .toLowerCase();
  const cat = params.category || 'ALL';

  return items
    .filter((item) => {
      if (periodMode === 'MONTH' && scope && !isDateInScope(item.timestampIso, scope)) {
        return false;
      }
      if (cat !== 'ALL' && item.category !== cat) {
        return false;
      }
      if (query) {
        const hay = `${item.actionLabel} ${item.actorName} ${item.targetRef} ${item.summary}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    })
    .sort((a, b) => b.timestampIso.localeCompare(a.timestampIso));
}

export function buildAccountantAuxiliaryMaps(params: {
  invoices: InvoiceRecord[];
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
  series?: AgtSeriesRecord[];
  yearMonth: string;
}): AccountantAuxiliaryMaps {
  const scope = resolveAccountantMonthScope(params.yearMonth);
  const monthInvoices = params.invoices.filter((inv) => isDateInScope(inv.issuedAtIso, scope));

  const seriesSalesMap = new Map<string, AccountantSeriesSalesRow>();
  const paymentTotals = new Map<string, number>();

  for (const inv of monthInvoices) {
    const seriesCode =
      inv.seriesCode ||
      (inv.number.includes(' ') ? inv.number.split(' ')[1]?.split('/')[0] || 'PADRAO' : 'PADRAO');
    const key = `${inv.docType}::${seriesCode}`;
    const row = seriesSalesMap.get(key) || {
      docType: inv.docType,
      docTypeLabel: formatDocumentTypeLabelPt(inv.docType),
      seriesCode,
      activeCount: 0,
      cancelledCount: 0,
      taxBaseTotal: 0,
      taxTotal: 0,
      grandTotal: 0,
    };

    if (inv.status === 'cancelled') {
      row.cancelledCount += 1;
      seriesSalesMap.set(key, row);
      continue;
    }

    row.activeCount += 1;
    const sign = inv.docType === 'NC' ? -1 : 1;
    if (inv.docType !== 'FP' && inv.docType !== 'CS' && inv.docType !== 'RC') {
      row.taxBaseTotal = roundKz(row.taxBaseTotal + getInvoiceTotalBase(inv) * sign);
      row.taxTotal = roundKz(row.taxTotal + (inv.taxTotal || 0) * sign);
      row.grandTotal = roundKz(row.grandTotal + (inv.grandTotal || 0) * sign);
    } else if (inv.docType === 'RC') {
      row.grandTotal = roundKz(row.grandTotal + (inv.grandTotal || 0));
    }
    seriesSalesMap.set(key, row);

    if (inv.docType !== 'FP' && inv.docType !== 'CS' && inv.docType !== 'NC') {
      if (Array.isArray(inv.paymentSplits) && inv.paymentSplits.length > 0) {
        for (const sp of inv.paymentSplits) {
          if (sp.amount > 0) {
            paymentTotals.set(sp.method, roundKz((paymentTotals.get(sp.method) || 0) + sp.amount));
          }
        }
      } else {
        const method = inv.paymentMethod || 'Dinheiro';
        paymentTotals.set(
          method,
          roundKz((paymentTotals.get(method) || 0) + (inv.grandTotal || 0))
        );
      }
    }
  }

  const totalPayments = roundKz(
    Array.from(paymentTotals.values()).reduce((sum, val) => sum + val, 0)
  );
  const paymentMethods: AccountantPaymentMethodRow[] = Array.from(paymentTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([method, amount]) => ({
      method,
      amount,
      sharePct: totalPayments > 0 ? Math.round((amount / totalPayments) * 1000) / 10 : 0,
    }));

  const cashSessions: AccountantCashSessionRow[] = params.cashSessions
    .filter((s) => isDateInScope(s.openedAtIso, scope) || isDateInScope(s.closedAtIso, scope))
    .sort((a, b) => b.openedAtIso.localeCompare(a.openedAtIso))
    .map((s) => ({
      id: s.id,
      cashier: s.cashier,
      operator: s.operator,
      status: s.status,
      openedAtIso: s.openedAtIso,
      closedAtIso: s.closedAtIso || '',
      openingFloat: roundKz(s.openingFloat || 0),
      expectedCash: roundKz(s.expectedCash || 0),
      countedCash: typeof s.countedCash === 'number' ? roundKz(s.countedCash) : null,
      differenceAmount:
        typeof s.differenceAmount === 'number' ? roundKz(s.differenceAmount) : null,
      invoiceCount: s.invoiceCount || 0,
    }));

  const closedSessions = cashSessions.filter((s) => s.status === 'closed');
  const cashTotalExpected = roundKz(closedSessions.reduce((sum, s) => sum + s.expectedCash, 0));
  const cashTotalCounted = roundKz(
    closedSessions.reduce((sum, s) => sum + (s.countedCash ?? 0), 0)
  );
  const cashNetDifference = roundKz(
    closedSessions.reduce((sum, s) => sum + (s.differenceAmount ?? 0), 0)
  );

  const seriesList = params.series || [];

  return {
    scope,
    seriesSales: Array.from(seriesSalesMap.values()).sort((a, b) =>
      `${a.docType}-${a.seriesCode}`.localeCompare(`${b.docType}-${b.seriesCode}`)
    ),
    paymentMethods,
    cashSessions,
    cashSessionCount: cashSessions.length,
    cashClosedCount: closedSessions.length,
    cashTotalExpected,
    cashTotalCounted,
    cashNetDifference,
    configuredSeriesCount: seriesList.length,
    activeSeriesCount: seriesList.filter((s) => s.status === 'A' || s.status === 'U').length,
  };
}

export function buildAccountantMonthlyPackage(params: {
  company: CompanyProfile;
  invoices: InvoiceRecord[];
  products: Product[];
  customers: Customer[];
  suppliers?: Supplier[];
  purchases?: PurchaseRecord[];
  cashSessions?: CashSession[];
  cashMovements?: CashMovement[];
  securityAuditLogs?: SecurityAuditEntry[];
  series?: AgtSeriesRecord[];
  yearMonth: string;
  canViewCostPrices: boolean;
}): AccountantMonthlyPackage {
  const scope = resolveAccountantMonthScope(params.yearMonth);
  const saftResult = generateMonthlySaftAoXml({
    company: params.company,
    invoices: params.invoices,
    products: params.products,
    customers: params.customers,
    suppliers: params.suppliers || [],
    year: scope.year,
    month: scope.month,
  });
  const xsdReport = validateSaftAoXsdStrict(saftResult.xml);

  const vatReport = buildAccountantVatReport({
    company: params.company,
    invoices: params.invoices,
    yearMonth: scope.yearMonth,
  });

  const withholdingReport = buildAccountantWithholdingReport({
    company: params.company,
    invoices: params.invoices,
    products: params.products,
    purchases: params.purchases || [],
    yearMonth: scope.yearMonth,
  });

  const cancelledRectified = buildCancelledAndRectifiedReport({
    invoices: params.invoices,
    yearMonth: scope.yearMonth,
  });

  const auxiliaryMaps = buildAccountantAuxiliaryMaps({
    invoices: params.invoices,
    cashSessions: params.cashSessions || [],
    cashMovements: params.cashMovements || [],
    series: params.series || [],
    yearMonth: scope.yearMonth,
  });

  const auditEntriesInMonth = buildAccountantAuditTrail({
    securityAuditLogs: params.securityAuditLogs || [],
    products: params.products,
    customers: params.customers,
    invoices: params.invoices,
    yearMonth: scope.yearMonth,
    periodMode: 'MONTH',
    category: 'ALL',
    canViewCostPrices: params.canViewCostPrices,
  });

  return {
    scope,
    company: params.company,
    saftResult,
    xsdReport,
    vatReport,
    withholdingReport,
    cancelledRectified,
    auxiliaryMaps,
    auditEntriesInMonth,
  };
}

// ============================================================================
// EXPORTADORES CONTABILÍSTICOS OFFLINE (CSV, XLSX E PACOTE MENSAL ZIP)
// ============================================================================

function toCsvField(val: string | number): string {
  const s = String(val ?? '');
  if (/[;"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(rows: Array<Array<string | number>>): string {
  return '\uFEFF' + rows.map((r) => r.map(toCsvField).join(';')).join('\r\n');
}

function buildVatExportRows(
  report: AccountantVatReport,
  company: CompanyProfile
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    [`Mapa de Apuramento de IVA — ${company.legalName} (NIF ${company.nif})`],
    [`Período: ${report.scope.labelPt} (${report.scope.startDate} a ${report.scope.endDate})`, `Regime Fiscal: ${company.taxRegime || 'GERAL'}`],
    [],
    ['Código Taxa', 'Escalão IVA', 'Taxa', 'Base Bruta (Kz)', 'IVA Liquidado (Kz)', 'Base NC (Kz)', 'IVA NC (Kz)', 'Base Líquida (Kz)', 'IVA Líquido (Kz)'],
    ...report.rateLines.map((r) => [
      r.code,
      r.label,
      r.rateLabel,
      r.grossBase,
      r.grossTax,
      r.creditNotesBase,
      r.creditNotesTax,
      r.netBase,
      r.netTax,
    ]),
    [
      'TOTAL',
      'Totais Fiscais Consolidados',
      '',
      report.grossTaxableBase,
      report.grossVatTotal,
      report.creditNotesBase,
      report.creditNotesVat,
      report.netTaxableBase,
      report.netVatPayable,
    ],
    [],
    ['Desdobramento de Isenções e Não Sujeição (Taxa 0%)'],
    ['Código Isenção AGT', 'Fundamentação Legal', 'Base Bruta (Kz)', 'Base NC (Kz)', 'Base Líquida (Kz)', 'N.º Documentos'],
    ...(report.exemptionLines.length > 0
      ? report.exemptionLines.map((e) => [
          e.exemptionCode,
          e.descriptionPt,
          e.grossBase,
          e.creditNotesBase,
          e.netBase,
          e.documentCount,
        ])
      : [['---', 'Sem operações isentas no período', 0, 0, 0, 0]]),
    [],
    ['Resumo Documental do Período'],
    ['Documentos Fiscais Activos', report.activeFiscalCount],
    ['Notas de Crédito Activas', report.creditNotesCount],
    ['Documentos Anulados no Mês (excluídos do IVA)', report.cancelledInMonthCount],
    ['Proformas / Comprovativos Não Fiscais', report.nonFiscalProformaCount],
    ['Recibos de Quitação (RC)', report.receiptsCount],
  ];
  return rows;
}

export function buildVatCsv(report: AccountantVatReport, company: CompanyProfile): string {
  return rowsToCsv(buildVatExportRows(report, company));
}

export function buildVatExcelBytes(
  report: AccountantVatReport,
  company: CompanyProfile
): Uint8Array {
  return buildMinimalXlsxBytes(`IVA_${report.scope.yearMonth}`, buildVatExportRows(report, company));
}

function buildWithholdingExportRows(
  report: AccountantWithholdingReport,
  company: CompanyProfile
): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [
    [`Mapa de Retenções na Fonte e Compras — ${company.legalName} (NIF ${company.nif})`],
    [
      `Período: ${report.scope.labelPt}`,
      `Taxa Retenção II Serviços: ${report.iiRatePct}%`,
      `Agente Retenção IVA: ${report.isVatRetentionAgent ? 'Sim (50% ref.)' : 'Não'}`,
    ],
    [],
    ['Base Líquida de Serviços (Kz)', report.netServiceBase],
    ['IVA sobre Serviços (Kz)', report.netServiceVat],
    ['Estimativa Retenção II (Kz)', report.estimatedIiTotal],
    ['Estimativa Retenção IVA (Kz)', report.estimatedVatRetentionTotal],
    [],
    ['Documentos com Linhas de Serviços'],
    ['Número', 'Tipo', 'Data', 'Cliente', 'NIF', 'Base Serviços (Kz)', 'IVA Serviços (Kz)', `II Est. ${report.iiRatePct}% (Kz)`, 'IVA Ret. Est. (Kz)'],
    ...(report.serviceDocuments.length > 0
      ? report.serviceDocuments.map((d) => [
          d.number,
          d.docType,
          d.issuedAtIso.slice(0, 10),
          d.customerName,
          d.customerNif,
          d.serviceBase,
          d.serviceVat,
          d.estimatedIiWithholding,
          d.estimatedVatRetention,
        ])
      : [['---', '---', '---', 'Sem serviços facturados neste período', '---', 0, 0, 0, 0]]),
    [],
    ['Compras a Fornecedores no Período'],
    ['Fornecedor', 'NIF', 'N.º Compras', 'Total Compras (Kz)', 'Pago (Kz)', 'Em Dívida (Kz)'],
    ...(report.supplierRows.length > 0
      ? report.supplierRows.map((s) => [
          s.supplierName,
          s.supplierNif,
          s.purchaseCount,
          s.totalAmount,
          s.amountPaid,
          s.amountDue,
        ])
      : [['Sem compras registadas no período', '---', 0, 0, 0, 0]]),
  ];
  return rows;
}

export function buildWithholdingCsv(
  report: AccountantWithholdingReport,
  company: CompanyProfile
): string {
  return rowsToCsv(buildWithholdingExportRows(report, company));
}

export function buildWithholdingExcelBytes(
  report: AccountantWithholdingReport,
  company: CompanyProfile
): Uint8Array {
  return buildMinimalXlsxBytes(
    `Retencoes_${report.scope.yearMonth}`,
    buildWithholdingExportRows(report, company)
  );
}

function buildCancelledRectifiedExportRows(
  report: AccountantCancelledRectifiedReport,
  company: CompanyProfile
): Array<Array<string | number>> {
  return [
    [`Documentos Anulados e Rectificados — ${company.legalName} (NIF ${company.nif})`],
    [`Período: ${report.scope.labelPt} (${report.scope.startDate} a ${report.scope.endDate})`],
    [],
    ['SECÇÃO 1: DOCUMENTOS ANULADOS'],
    ['Número', 'Tipo', 'Emissão', 'Data Anulação', 'Anulado Por', 'Cliente', 'NIF', 'IVA Anulado (Kz)', 'Total Anulado (Kz)', 'Motivo / Justificação'],
    ...(report.cancelledDocs.length > 0
      ? report.cancelledDocs.map((d) => [
          d.number,
          d.docType,
          d.issuedAtIso.slice(0, 10),
          d.cancelledAtIso.slice(0, 16).replace('T', ' '),
          d.cancelledBy,
          d.customerName,
          d.customerNif,
          d.taxTotal,
          d.grandTotal,
          d.cancelReason,
        ])
      : [['Sem documentos anulados no período', '', '', '', '', '', '', 0, 0, '']]),
    [],
    ['SECÇÃO 2: NOTAS DE CRÉDITO E DÉBITO (RECTIFICAÇÕES)'],
    ['Número', 'Tipo', 'Data', 'Documento Origem', 'Cliente', 'NIF', 'Operador', 'Impacto IVA (Kz)', 'Impacto Total (Kz)', 'Observações'],
    ...(report.rectifyingDocs.length > 0
      ? report.rectifyingDocs.map((d) => [
          d.number,
          d.docType,
          d.issuedAtIso.slice(0, 10),
          d.originNumber,
          d.customerName,
          d.customerNif,
          d.operator,
          d.taxImpact,
          d.grossImpact,
          d.notes,
        ])
      : [['Sem notas rectificativas no período', '', '', '', '', '', '', 0, 0, '']]),
  ];
}

export function buildCancelledRectifiedCsv(
  report: AccountantCancelledRectifiedReport,
  company: CompanyProfile
): string {
  return rowsToCsv(buildCancelledRectifiedExportRows(report, company));
}

export function buildCancelledRectifiedExcelBytes(
  report: AccountantCancelledRectifiedReport,
  company: CompanyProfile
): Uint8Array {
  return buildMinimalXlsxBytes(
    `Anulados_Rect_${report.scope.yearMonth}`,
    buildCancelledRectifiedExportRows(report, company)
  );
}

function formatPtTimestamp(iso?: string): string {
  if (!iso) return '---';
  const dt = formatDateTimePt(iso);
  return `${dt.date} ${dt.time}`;
}

function buildAuditTrailExportRows(
  items: AccountantAuditTrailItem[],
  company: CompanyProfile,
  periodLabel: string
): Array<Array<string | number>> {
  return [
    [`Histórico de Alterações e Auditoria — ${company.legalName} (NIF ${company.nif})`],
    [`Âmbito: ${periodLabel} · Registos: ${items.length}`],
    [],
    ['Data / Hora', 'Categoria', 'Acção', 'Utilizador / Operador', 'Perfil', 'Referência', 'Resultado', 'Descrição'],
    ...(items.length > 0
      ? items.map((it) => [
          formatPtTimestamp(it.timestampIso),
          it.category,
          it.actionLabel,
          it.actorName,
          it.actorRole,
          it.targetRef,
          it.outcome === 'denied' ? 'Bloqueado' : 'Permitido',
          it.summary,
        ])
      : [['---', '---', '---', '---', '---', '---', '---', 'Sem eventos de auditoria no âmbito seleccionado']]),
  ];
}

export function buildAuditTrailCsv(
  items: AccountantAuditTrailItem[],
  company: CompanyProfile,
  periodLabel: string
): string {
  return rowsToCsv(buildAuditTrailExportRows(items, company, periodLabel));
}

export function buildAuditTrailExcelBytes(
  items: AccountantAuditTrailItem[],
  company: CompanyProfile,
  periodLabel: string
): Uint8Array {
  return buildMinimalXlsxBytes(
    'Auditoria_Alteracoes',
    buildAuditTrailExportRows(items, company, periodLabel)
  );
}

export function buildAuxiliaryMapsExcelBytes(
  maps: AccountantAuxiliaryMaps,
  withholding: AccountantWithholdingReport,
  company: CompanyProfile
): Uint8Array {
  const rows: Array<Array<string | number>> = [
    [`Mapas Auxiliares de Contabilidade — ${company.legalName} (NIF ${company.nif})`],
    [`Período: ${maps.scope.labelPt} (${maps.scope.startDate} a ${maps.scope.endDate})`],
    [],
    ['1. VENDAS POR TIPO DOCUMENTAL E SÉRIE'],
    ['Tipo Doc.', 'Designação', 'Série', 'Emitidos', 'Anulados', 'Base Tributável (Kz)', 'IVA (Kz)', 'Total Bruto (Kz)'],
    ...(maps.seriesSales.length > 0
      ? maps.seriesSales.map((s) => [
          s.docType,
          s.docTypeLabel,
          s.seriesCode,
          s.activeCount,
          s.cancelledCount,
          s.taxBaseTotal,
          s.taxTotal,
          s.grandTotal,
        ])
      : [['---', 'Sem movimentos no período', '---', 0, 0, 0, 0, 0]]),
    [],
    ['2. RECEBIMENTOS POR MEIO DE PAGAMENTO'],
    ['Meio de Pagamento', 'Valor (Kz)', 'Quota (%)'],
    ...(maps.paymentMethods.length > 0
      ? maps.paymentMethods.map((p) => [p.method, p.amount, p.sharePct])
      : [['Sem cobranças no período', 0, 0]]),
    [],
    ['3. SESSÕES DE CAIXA E RECONCILIAÇÃO DE NUMERÁRIO'],
    ['Caixa', 'Operador', 'Estado', 'Abertura', 'Fecho', 'Fundo Inicial (Kz)', 'Esperado (Kz)', 'Contado (Kz)', 'Diferença (Kz)'],
    ...(maps.cashSessions.length > 0
      ? maps.cashSessions.map((c) => [
          c.cashier,
          c.operator,
          c.status === 'closed' ? 'Fechado' : 'Aberto',
          formatPtTimestamp(c.openedAtIso),
          c.closedAtIso ? formatPtTimestamp(c.closedAtIso) : 'Em curso',
          c.openingFloat,
          c.expectedCash,
          c.countedCash ?? 0,
          c.differenceAmount ?? 0,
        ])
      : [['Sem sessões de caixa neste mês', '', '', '', '', 0, 0, 0, 0]]),
    [],
    ['4. RESUMO DE COMPRAS A FORNECEDORES'],
    ['Fornecedor', 'NIF', 'N.º Registos', 'Total Compras (Kz)', 'Pago (Kz)', 'Por Pagar (Kz)'],
    ...(withholding.supplierRows.length > 0
      ? withholding.supplierRows.map((s) => [
          s.supplierName,
          s.supplierNif,
          s.purchaseCount,
          s.totalAmount,
          s.amountPaid,
          s.amountDue,
        ])
      : [['Sem compras registadas', '', 0, 0, 0, 0]]),
  ];

  return buildMinimalXlsxBytes(`Mapas_${maps.scope.yearMonth}`, rows);
}

function buildDocumentControlExcelBytes(
  invoices: InvoiceRecord[],
  scope: AccountantMonthScope,
  company: CompanyProfile
): Uint8Array {
  const monthInvoices = invoices
    .filter((i) => isDateInScope(i.issuedAtIso, scope))
    .sort((a, b) => a.issuedAtIso.localeCompare(b.issuedAtIso));

  const rows: Array<Array<string | number>> = [
    [`Controlo Documental Mensal — ${company.legalName} (NIF ${company.nif})`],
    [`Período: ${scope.labelPt} (${scope.startDate} a ${scope.endDate}) · Total: ${monthInvoices.length} documento(s)`],
    [],
    ['Número', 'Tipo', 'Série', 'Data Emissão', 'Estado', 'Cliente', 'NIF Cliente', 'Base Tributável (Kz)', 'IVA (Kz)', 'Total (Kz)', 'Pago (Kz)', 'Por Cobrar (Kz)', 'Hash 4', 'Meio Pagamento'],
    ...(monthInvoices.length > 0
      ? monthInvoices.map((inv) => {
          const isCancelled = inv.status === 'cancelled';
          const payable = isCancelled
            ? 0
            : Math.max(0, roundKz((inv.grandTotal || 0) - (inv.returnCreditApplied || 0)));
          const due = isCancelled ? 0 : Math.max(0, roundKz(inv.amountDue || 0));
          const paid = isCancelled ? 0 : Math.max(0, roundKz(payable - due));
          return [
            inv.number,
            inv.docType,
            inv.seriesCode || '',
            inv.issuedAtIso.slice(0, 19).replace('T', ' '),
            isCancelled ? 'ANULADO' : 'EMITIDO',
            inv.customerName,
            inv.customerNif,
            getInvoiceTotalBase(inv),
            roundKz(inv.taxTotal || 0),
            roundKz(inv.grandTotal || 0),
            paid,
            due,
            inv.saftHash4 || '',
            inv.paymentSummary || inv.paymentMethod,
          ];
        })
      : [['Sem documentos emitidos no período', '', '', '', '', '', '', 0, 0, 0, 0, 0, '', '']]),
  ];

  return buildMinimalXlsxBytes(`Docs_${scope.yearMonth}`, rows);
}

export function buildAccountantMonthlyZipPackage(params: {
  pkg: AccountantMonthlyPackage;
  invoices: InvoiceRecord[];
}): {
  filename: string;
  bytes: Uint8Array;
  includedFiles: string[];
} {
  const { pkg, invoices } = params;
  const encoder = new TextEncoder();
  const cleanNif = (pkg.company.nif || 'SEM_NIF').replace(/[^A-Za-z0-9]/g, '') || 'EMPRESA';
  const monthPad = String(pkg.scope.month).padStart(2, '0');
  const tag = `${cleanNif}_${pkg.scope.year}_${monthPad}`;

  const summaryLines = [
    `SILA-BILLING — PACOTE MENSAL DE CONTABILIDADE`,
    `================================================================`,
    `Empresa: ${pkg.company.legalName} (${pkg.company.shortName})`,
    `NIF: ${pkg.company.nif}`,
    `Regime Fiscal: ${pkg.company.taxRegime || 'GERAL'}`,
    `Contabilista Registado: ${pkg.company.accountantName || 'Não indicado'}${pkg.company.accountantOcpcaNumber ? ` (OCPCA ${pkg.company.accountantOcpcaNumber})` : ''}`,
    `Período de Fecho: ${pkg.scope.labelPt} (${pkg.scope.startDate} a ${pkg.scope.endDate})`,
    `Prazo Legal Submissão SAF-T (AO): ${pkg.scope.submissionDeadline}`,
    ``,
    `1. SAF-T (AO) & VALIDAÇÃO XSD`,
    `   - Ficheiro: ${pkg.saftResult.filename}`,
    `   - Estado XSD v1.01_01: ${pkg.xsdReport.valid ? 'CONFORME (0 erros)' : `COM ${pkg.xsdReport.errors.length} ERRO(S)`}`,
    `   - Facturas Fiscais: ${pkg.saftResult.summary.totalSalesInvoices}`,
    `   - Documentos de Trabalho (Proformas/CS): ${pkg.saftResult.summary.totalWorkingDocuments}`,
    ``,
    `2. APURAMENTO DE IVA`,
    `   - Base Tributável Líquida: ${formatKzNumber(pkg.vatReport.netTaxableBase)} Kz`,
    `   - IVA Líquido Apurado: ${formatKzNumber(pkg.vatReport.netVatPayable)} Kz`,
    `   - Total Líquido Facturado: ${formatKzNumber(pkg.vatReport.netGrandTotal)} Kz`,
    ``,
    `3. RETENÇÕES NA FONTE & COMPRAS`,
    `   - Base Serviços: ${formatKzNumber(pkg.withholdingReport.netServiceBase)} Kz`,
    `   - Estimativa Retenção II (${pkg.withholdingReport.iiRatePct}%): ${formatKzNumber(pkg.withholdingReport.estimatedIiTotal)} Kz`,
    `   - Compras a Fornecedores: ${formatKzNumber(pkg.withholdingReport.purchasesTotalAmount)} Kz (Dívida: ${formatKzNumber(pkg.withholdingReport.purchasesDueAmount)} Kz)`,
    ``,
    `4. ANULAÇÕES E RECTIFICAÇÕES`,
    `   - Documentos Anulados: ${pkg.cancelledRectified.cancelledCount} (${formatKzNumber(pkg.cancelledRectified.cancelledGrossTotal)} Kz)`,
    `   - Notas de Crédito (NC): ${pkg.cancelledRectified.creditNotesCount} (${formatKzNumber(pkg.cancelledRectified.creditNotesGrossTotal)} Kz)`,
    `   - Notas de Débito (ND): ${pkg.cancelledRectified.debitNotesCount} (${formatKzNumber(pkg.cancelledRectified.debitNotesGrossTotal)} Kz)`,
    ``,
    `5. AUDITORIA DO PERÍODO`,
    `   - Eventos registados no mês: ${pkg.auditEntriesInMonth.length}`,
    `   - Diferença Líquida de Caixa (sessões fechadas): ${formatKzNumber(pkg.auxiliaryMaps.cashNetDifference)} Kz`,
    ``,
    `Gerado offline por SILA-Billing em ${formatPtTimestamp(new Date().toISOString())}.`,
  ];

  const files: Array<{ path: string; data: Uint8Array }> = [
    {
      path: `00_Resumo_Fecho_Mensal_${tag}.txt`,
      data: encoder.encode(summaryLines.join('\r\n')),
    },
    {
      path: `01_SAFT_AO/${pkg.saftResult.filename}`,
      data: encoder.encode(pkg.saftResult.xml),
    },
    {
      path: `02_IVA_e_Retencoes/Mapa_IVA_${tag}.xlsx`,
      data: buildVatExcelBytes(pkg.vatReport, pkg.company),
    },
    {
      path: `02_IVA_e_Retencoes/Mapa_IVA_${tag}.csv`,
      data: encoder.encode(buildVatCsv(pkg.vatReport, pkg.company)),
    },
    {
      path: `02_IVA_e_Retencoes/Mapa_Retencoes_${tag}.xlsx`,
      data: buildWithholdingExcelBytes(pkg.withholdingReport, pkg.company),
    },
    {
      path: `03_Documentos_e_Anulacoes/Anulados_e_Rectificados_${tag}.xlsx`,
      data: buildCancelledRectifiedExcelBytes(pkg.cancelledRectified, pkg.company),
    },
    {
      path: `03_Documentos_e_Anulacoes/Controlo_Documental_${tag}.xlsx`,
      data: buildDocumentControlExcelBytes(invoices, pkg.scope, pkg.company),
    },
    {
      path: `04_Mapas_Auxiliares/Compras_Fornecedores_Caixa_${tag}.xlsx`,
      data: buildAuxiliaryMapsExcelBytes(pkg.auxiliaryMaps, pkg.withholdingReport, pkg.company),
    },
    {
      path: `05_Auditoria/Historico_Alteracoes_Auditoria_${tag}.xlsx`,
      data: buildAuditTrailExcelBytes(
        pkg.auditEntriesInMonth,
        pkg.company,
        pkg.scope.labelPt
      ),
    },
  ];

  return {
    filename: `Contabilidade_${tag}.zip`,
    bytes: buildStoreZip(files),
    includedFiles: files.map((f) => f.path),
  };
}
