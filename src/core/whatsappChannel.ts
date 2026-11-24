import {
  calculateInvoiceTotals,
  formatDateTimePt,
  formatKzNumber,
  roundKz,
} from './billingEngine.ts';
import {
  formatDocumentTypeLabelPt,
  resolveCompanyProfileFromSnapshot,
} from './types.ts';
import type {
  CartDraftItem,
  CompanyProfile,
  Customer,
  DirectPaymentMethod,
  InvoiceRecord,
  Product,
} from './types.ts';
import type {
  DailyOwnerSummaryPayload,
  PaymentReceiptPdfPayload,
} from './pdfGenerator.ts';

export const WHATSAPP_DISCREET_SIGNATURE = '«Emitido por SILA-Billing»';

export type WhatsAppCommercialKind =
  | 'DOCUMENT'
  | 'COLLECTION'
  | 'CATALOG'
  | 'QUOTE'
  | 'PAYMENT_RECEIPT'
  | 'DAILY_SUMMARY';

export interface NormalizedWhatsAppPhone {
  digits: string;
  display: string;
  valid: boolean;
}

/**
 * Normaliza números angolanos e internacionais para o padrão E.164 sem '+' exigido por wa.me.
 * - "943 671 515" -> "244943671515"
 * - "+244 943 671 515" ou "00244943671515" -> "244943671515"
 */
export function normalizeWhatsAppPhone(
  rawPhone?: string | null,
  defaultCountryDial = '244'
): NormalizedWhatsAppPhone {
  const cleaned = String(rawPhone || '').trim();
  if (!cleaned) {
    return { digits: '', display: '', valid: false };
  }

  let digits = cleaned.replace(/[^\d]/g, '');
  if (!digits) {
    return { digits: '', display: '', valid: false };
  }

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Número móvel ou fixo nacional angolano com 9 dígitos (ex: 9xxxxxxxx ou 2xxxxxxxx)
  if (digits.length === 9 && (digits.startsWith('9') || digits.startsWith('2'))) {
    digits = `${defaultCountryDial}${digits}`;
  }

  const valid = digits.length >= 9 && digits.length <= 15;
  const display = valid ? `+${digits}` : cleaned;
  return { digits: valid ? digits : '', display, valid };
}

export function buildWhatsAppUrl(phoneDigits: string, text: string): string {
  const encoded = encodeURIComponent(String(text || '').trim());
  const cleanDigits = String(phoneDigits || '').replace(/[^\d]/g, '');
  if (cleanDigits) {
    return `https://wa.me/${cleanDigits}?text=${encoded}`;
  }
  return `https://wa.me/?text=${encoded}`;
}

function appendCompanyPaymentFooterLines(company: CompanyProfile): string[] {
  const lines: string[] = [];
  if (company.iban1) {
    lines.push(
      `• IBAN${company.bankName1 ? ` (${company.bankName1})` : ''}: ${company.iban1}`
    );
  }
  if (company.multicaixaExpressPhone) {
    lines.push(`• Multicaixa Express: ${company.multicaixaExpressPhone}`);
  }
  return lines;
}

/**
 * 1. Mensagem para envio de Factura (FR/FA/FT), Recibo (RC), Proforma (FP) ou Nota (NC/ND)
 */
export function buildDocumentWhatsAppMessage(
  invoice: InvoiceRecord,
  fallbackCompany: CompanyProfile
): string {
  const company = resolveCompanyProfileFromSnapshot(invoice, fallbackCompany);
  const dt = formatDateTimePt(invoice.issuedAtIso);
  const docLabel = formatDocumentTypeLabelPt(invoice.docType);
  const companyLabel = company.shortName || company.legalName;

  const lines: string[] = [
    `Olá *${invoice.customerName || 'Cliente'}*,`,
    `Segue em anexo o documento *${docLabel} ${invoice.number}* emitido por *${companyLabel}*.`,
    ``,
    `• Data: ${dt.slashDate} às ${dt.time}`,
    `• Valor Total: *${formatKzNumber(invoice.grandTotal)} Kz*`,
  ];

  if (invoice.docType === 'FP') {
    lines.push(`• Tipo: Documento Proforma para apreciação e confirmação.`);
    lines.push(...appendCompanyPaymentFooterLines(company));
  } else if (invoice.status === 'cancelled') {
    lines.push(`• Estado: Anulado`);
  } else if ((invoice.amountDue || 0) > 0) {
    lines.push(`• Pago: ${formatKzNumber(invoice.amountReceived)} Kz`);
    lines.push(`• Saldo Pendente: *${formatKzNumber(invoice.amountDue!)} Kz*`);
    lines.push(...appendCompanyPaymentFooterLines(company));
  } else {
    lines.push(`• Pagamento: ${invoice.paymentSummary || invoice.paymentMethod} (Liquidado)`);
  }

  lines.push(``, `Obrigado pela preferência.`, WHATSAPP_DISCREET_SIGNATURE);
  return lines.join('\n');
}

export interface CollectionReminderParams {
  customer: Pick<Customer, 'name' | 'nif' | 'phone' | 'paymentTerms'>;
  openInvoices: InvoiceRecord[];
  referenceNowIso?: string;
}

function getTermsDays(terms?: Customer['paymentTerms']): number {
  switch (terms) {
    case '15_DIAS':
      return 15;
    case '30_DIAS':
      return 30;
    case '45_DIAS':
      return 45;
    case '60_DIAS':
      return 60;
    default:
      return 0;
  }
}

/**
 * 2. Mensagem para Cobrança e Aviso de Vencimento de Conta Corrente
 */
export function buildCollectionReminderWhatsAppMessage(
  params: CollectionReminderParams,
  company: CompanyProfile
): string {
  const { customer, openInvoices } = params;
  const nowMs = new Date(params.referenceNowIso || new Date().toISOString()).getTime();
  const termsDays = getTermsDays(customer.paymentTerms);
  const sorted = [...openInvoices]
    .filter((i) => i.status === 'issued' && (i.amountDue || 0) > 0)
    .sort((a, b) => a.issuedAtIso.localeCompare(b.issuedAtIso));

  const totalDue = roundKz(sorted.reduce((acc, i) => acc + (i.amountDue || 0), 0));
  const oldestMs = sorted[0] ? new Date(sorted[0].issuedAtIso).getTime() : nowMs;
  const daysElapsed = Math.max(0, Math.floor((nowMs - oldestMs) / 86400000));
  const isOverdue = daysElapsed > termsDays;

  const companyLabel = company.shortName || company.legalName;
  const lines: string[] = [
    `Estimado(a) *${customer.name}*,`,
    isOverdue
      ? `*Aviso de Vencimento — ${companyLabel}*: recordamos os documentos pendentes em conta corrente:`
      : `*Lembrete de Pagamento — ${companyLabel}*: partilhamos o resumo dos seus documentos em aberto:`,
    ``,
  ];

  for (const inv of sorted.slice(0, 6)) {
    const dt = formatDateTimePt(inv.issuedAtIso);
    const invDays = Math.max(0, Math.floor((nowMs - new Date(inv.issuedAtIso).getTime()) / 86400000));
    const overdueTag = invDays > termsDays ? ` (${invDays}d)` : '';
    lines.push(
      `• ${inv.number} (${dt.slashDate})${overdueTag}: *${formatKzNumber(inv.amountDue || 0)} Kz*`
    );
  }
  if (sorted.length > 6) {
    lines.push(`• ... e mais ${sorted.length - 6} documento(s)`);
  }

  lines.push(``, `Total em Dívida: *${formatKzNumber(totalDue)} Kz*`);
  const paymentLines = appendCompanyPaymentFooterLines(company);
  if (paymentLines.length > 0) {
    lines.push(``, `Dados para regularização:`, ...paymentLines);
  }
  lines.push(
    ``,
    `Caso já tenha efectuado o pagamento, por favor envie o comprovativo nesta conversa.`,
    WHATSAPP_DISCREET_SIGNATURE
  );
  return lines.join('\n');
}

/**
 * 3. Mensagem para Catálogo Comercial ou Orçamento do Carrinho
 */
export function buildCatalogOrQuoteWhatsAppMessage(
  params: {
    mode: 'QUOTE' | 'CATALOG';
    referenceCode: string;
    customerName?: string;
    cartItems?: CartDraftItem[];
    globalDiscountPct?: number;
    products?: Product[];
    validityDays?: number;
  },
  company: CompanyProfile
): string {
  const companyLabel = company.shortName || company.legalName;

  if (params.mode === 'QUOTE') {
    const items = params.cartItems || [];
    const totals = calculateInvoiceTotals(items, params.globalDiscountPct || 0);
    const lines: string[] = [
      `Olá *${params.customerName || 'Cliente'}*,`,
      `Segue o *Orçamento ${params.referenceCode}* da *${companyLabel}* (PDF em anexo):`,
      ``,
    ];
    for (const ln of totals.lines.slice(0, 8)) {
      lines.push(
        `• ${ln.qty}x ${ln.description}: ${formatKzNumber(ln.lineTotal)} Kz`
      );
    }
    if (totals.lines.length > 8) {
      lines.push(`• ... +${totals.lines.length - 8} artigo(s) no PDF em anexo.`);
    }
    lines.push(
      ``,
      `Total Orçamentado: *${formatKzNumber(totals.grandTotal)} Kz*`,
      `Validade: ${params.validityDays ?? 15} dias.`,
      ...appendCompanyPaymentFooterLines(company),
      ``,
      WHATSAPP_DISCREET_SIGNATURE
    );
    return lines.join('\n');
  }

  const activeProducts = (params.products || []).filter((p) => p.active !== false);
  const lines: string[] = [
    `Olá! Partilhamos o *Catálogo Comercial ${companyLabel}* com *${activeProducts.length} artigo(s)* em PDF.`,
    ``,
    `Destaques de preços:`,
  ];
  for (const p of activeProducts.slice(0, 8)) {
    lines.push(`• ${p.name} — *${formatKzNumber(p.price)} Kz* / ${p.unit || 'un'}`);
  }
  if (activeProducts.length > 8) {
    lines.push(`• Consulte a lista completa no ficheiro PDF em anexo.`);
  }
  lines.push(``, `Para encomendar, responda directamente a esta mensagem.`, WHATSAPP_DISCREET_SIGNATURE);
  return lines.join('\n');
}

/**
 * 4. Mensagem para Comprovativo de Pagamento / Liquidação de Dívida
 */
export function buildPaymentReceiptWhatsAppMessage(
  proof: PaymentReceiptPdfPayload,
  company: CompanyProfile
): string {
  const companyLabel = company.shortName || company.legalName;
  const dt = formatDateTimePt(proof.issuedAtIso);
  const lines: string[] = [
    `Olá *${proof.customerName}*,`,
    `Confirmamos a recepção do seu pagamento junto da *${companyLabel}* (Comprovativo *${proof.receiptNumber}* em PDF):`,
    ``,
    `• Data: ${dt.slashDate} às ${dt.time}`,
    `• Valor Recebido: *${formatKzNumber(proof.paidAmount)} Kz*`,
    `• Meio: ${proof.paymentMethod}${proof.reference ? ` (Ref: ${proof.reference})` : ''}`,
    `• Documentos: ${proof.settledInvoices.map((s) => s.invoiceNumber).join(', ')}`,
    proof.remainingDebtAfter > 0
      ? `• Saldo Pendente Restante: *${formatKzNumber(proof.remainingDebtAfter)} Kz*`
      : `• Situação: *Liquidado na totalidade*`,
    ``,
    `Muito obrigado.`,
    WHATSAPP_DISCREET_SIGNATURE,
  ];
  return lines.join('\n');
}

/**
 * 5. Mensagem para Resumo Diário ao Proprietário
 */
export function buildDailyOwnerSummaryWhatsAppMessage(
  summary: DailyOwnerSummaryPayload,
  company: CompanyProfile
): string {
  const companyLabel = company.shortName || company.legalName;
  const dateLabel = summary.dateIso.split('-').reverse().join('/');
  const lines: string[] = [
    `*Resumo Diário — ${companyLabel}* (${dateLabel})`,
    ``,
    `• Vendas do Dia: *${formatKzNumber(summary.totalSalesGross)} Kz* (${summary.validDocCount} doc.${
      summary.cancelledCount > 0 ? `, ${summary.cancelledCount} anul.` : ''
    })`,
    `• Ticket Médio: ${formatKzNumber(summary.averageTicket)} Kz`,
    `• Dinheiro: ${formatKzNumber(summary.cashTotal)} Kz`,
    `• Multicaixa: ${formatKzNumber(summary.multicaixaTotal)} Kz`,
    `• Transferência: ${formatKzNumber(summary.transferTotal)} Kz`,
  ];

  if (summary.creditTotal > 0) {
    lines.push(`• Vendas a Crédito: ${formatKzNumber(summary.creditTotal)} Kz`);
  }
  if (summary.debtCollectionsTotal > 0) {
    lines.push(`• Cobranças de Dívida: ${formatKzNumber(summary.debtCollectionsTotal)} Kz`);
  }
  if (summary.activeCashSessionSummary) {
    const cs = summary.activeCashSessionSummary;
    lines.push(
      `• Caixa ${cs.cashier} (${cs.status === 'open' ? 'Aberto' : 'Fechado'}): Gaveta esperada *${formatKzNumber(cs.expectedCash)} Kz*`
    );
  }
  lines.push(
    `• Total Geral a Receber (Clientes): ${formatKzNumber(summary.openReceivablesTotal)} Kz`,
    ``,
    `Relatório detalhado em PDF disponível em anexo.`,
    WHATSAPP_DISCREET_SIGNATURE
  );
  return lines.join('\n');
}

export function resolveOwnerWhatsAppPhone(company: CompanyProfile): string {
  return (
    company.whatsapp ||
    company.legalRepresentativePhone ||
    company.mobile ||
    company.phone ||
    ''
  ).trim();
}
