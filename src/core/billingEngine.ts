import { kwanzaToWords } from './extenso.ts';
import type {
  CalculatedLineItem,
  CartDraftItem,
  CashMovement,
  CashSession,
  CashSessionSummary,
  InvoiceRecord,
  InvoiceTotals,
} from './types.ts';

export function roundKz(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Formata valores monetários no padrão angolano: 7.802,40
 */
export function formatKzNumber(val: number): string {
  const fixed = roundKz(val).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${withDots},${decPart}`;
}

export function formatKz(val: number): string {
  return `${formatKzNumber(val)} Kz`;
}

export function formatDateTimePt(iso: string): { date: string; time: string; slashDate: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { date: '2026-10-27', time: '00:00', slashDate: '27/10/2026' };
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${min}`,
    slashDate: `${dd}/${mm}/${yyyy}`,
  };
}

/**
 * Motor unificado de cálculo fiscal (IVA Angolano 14% ou Isento 0%).
 * Segue rigorosamente o modelo JAIMONA-COMÉRCIO E SERVIÇOS:
 * - Cada linha apresenta Total Bruto da Linha = Qtd × Preço Unit. (ex: 2×700 = 1.400,00)
 * - Para artigos sujeitos a IVA 14%, extrai-se a Base Tributável (Líquido / 1,14) e aplica-se 14% de IVA
 *   (ex: 5.350,00 / 1,14 ≈ 4.695,65 Base; IVA 14% ≈ 657,40)
 * - Para artigos Isentos (0%), Base 0% = valor líquido da linha, IVA = 0,00
 * - Total de mercadorias + Total de impostos - Desconto comercial = TOTAL A PAGAR em Kwanzas (Kz)
 */
export function calculateInvoiceTotals(
  draftItems: CartDraftItem[],
  globalDiscountPct = 0
): InvoiceTotals {
  const lines: CalculatedLineItem[] = draftItems.map((item, idx) => {
    const qty = Math.max(0.01, roundKz(item.qty));
    const unitPrice = Math.max(0, roundKz(item.unitPrice));
    const discountPct = Math.min(100, Math.max(0, roundKz(item.discountPct || 0)));

    const lineGross = roundKz(qty * unitPrice);
    const lineDiscount = roundKz(lineGross * (discountPct / 100));
    const afterDiscount = roundKz(lineGross - lineDiscount);

    // Base de cálculo para resumo de impostos (extração de IVA 14% sobre PVP comercial)
    const lineBase = item.ivaRate === 14 ? roundKz(afterDiscount / 1.14) : afterDiscount;
    const lineTax = item.ivaRate === 14 ? roundKz(lineBase * 0.14) : 0;
    const lineNet = afterDiscount;

    return {
      ...item,
      id: `item_${idx + 1}_${item.productId.replace(/[^a-zA-Z0-9_-]/g, '')}`.slice(0, 64),
      qty,
      unitPrice,
      discountPct,
      lineGross,
      lineDiscount,
      lineBase,
      lineTax,
      lineNet,
      lineTotal: afterDiscount,
    };
  });

  const clampedGlobalPct = Math.min(100, Math.max(0, roundKz(Number(globalDiscountPct) || 0)));
  const globalFactor = clampedGlobalPct > 0 ? 1 - clampedGlobalPct / 100 : 1;

  const grossItemsTotal = roundKz(lines.reduce((acc, l) => acc + l.lineGross, 0));
  const lineDiscountTotal = roundKz(lines.reduce((acc, l) => acc + l.lineDiscount, 0));
  const subtotalAfterLineDiscounts = Math.max(0, roundKz(grossItemsTotal - lineDiscountTotal));
  const globalDiscountAmount =
    clampedGlobalPct > 0 ? roundKz(subtotalAfterLineDiscounts * (clampedGlobalPct / 100)) : 0;
  const discountTotal = roundKz(lineDiscountTotal + globalDiscountAmount);

  const rawNet14Sum = roundKz(
    lines.filter((l) => l.ivaRate === 14).reduce((acc, l) => acc + l.lineNet, 0)
  );
  const net14Sum = clampedGlobalPct > 0 ? roundKz(rawNet14Sum * globalFactor) : rawNet14Sum;
  const taxBase14 = net14Sum > 0 ? roundKz(net14Sum / 1.14) : 0;
  const taxAmount14 = taxBase14 > 0 ? roundKz(taxBase14 * 0.14) : 0;

  const rawTaxBase0 = roundKz(
    lines.filter((l) => l.ivaRate === 0).reduce((acc, l) => acc + l.lineNet, 0)
  );
  const taxBase0 = clampedGlobalPct > 0 ? roundKz(rawTaxBase0 * globalFactor) : rawTaxBase0;
  const taxAmount0 = 0;

  const merchandiseTotal = Math.max(0, roundKz(grossItemsTotal - discountTotal));
  const taxTotal = taxAmount14;
  const grandTotal = roundKz(merchandiseTotal + taxTotal);

  return {
    lines,
    merchandiseTotal,
    grossItemsTotal,
    lineDiscountTotal,
    globalDiscountPct: clampedGlobalPct,
    globalDiscountAmount,
    discountTotal,
    taxBase14,
    taxAmount14,
    taxBase0,
    taxAmount0,
    taxTotal,
    grandTotal,
    amountInWords: kwanzaToWords(grandTotal),
  };
}

export function generateNextInvoiceNumber(
  existingNumbers: string[],
  docType: 'FR' | 'FP',
  baseSequence = 0
): string {
  const year = new Date().getFullYear();
  const prefix = docType === 'FP' ? `FP ${year}/` : `FV ${year}/`;
  let maxSeq = Math.max(0, Math.floor(baseSequence));

  for (const num of existingNumbers) {
    const match = num.match(/\/(\d+)$/);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!Number.isNaN(parsed) && parsed > maxSeq) {
        maxSeq = parsed;
      }
    }
  }

  const nextSeq = String(maxSeq + 1).padStart(6, '0');
  return `${prefix}${nextSeq}`;
}

export interface InvoiceSaleReceiptsBreakdown {
  cash: number;
  multicaixa: number;
  transfer: number;
  credit: number;
  netReceived: number;
}

/**
 * Extrai os recebimentos líquidos da venda original separados por meio de pagamento
 * (preservando os valores iniciais antes de liquidações posteriores de conta corrente).
 * Quando há troco num pagamento em Dinheiro ou Combinado, o troco sai fisicamente da gaveta (Dinheiro).
 */
export function extractInvoiceSaleReceipts(inv: InvoiceRecord): InvoiceSaleReceiptsBreakdown {
  if (inv.docType !== 'FR' || inv.status === 'cancelled') {
    return { cash: 0, multicaixa: 0, transfer: 0, credit: 0, netReceived: 0 };
  }

  const returnCredit = Math.max(0, roundKz(inv.returnCreditApplied || 0));
  const payable = Math.max(0, roundKz(inv.grandTotal - returnCredit));
  const rawReceived =
    typeof inv.initialAmountReceived === 'number'
      ? roundKz(inv.initialAmountReceived)
      : roundKz(inv.amountReceived);
  const rawChange =
    typeof inv.initialChangeAmount === 'number'
      ? roundKz(inv.initialChangeAmount)
      : Math.max(0, roundKz(rawReceived - payable));
  const netReceived = Math.max(0, roundKz(Math.min(payable, rawReceived - rawChange)));
  const initialCredit = Math.max(0, roundKz(payable - netReceived));

  if (inv.paymentMethod === 'Dinheiro') {
    return {
      cash: netReceived,
      multicaixa: 0,
      transfer: 0,
      credit: initialCredit,
      netReceived,
    };
  }

  if (inv.paymentMethod === 'Multicaixa') {
    return {
      cash: 0,
      multicaixa: netReceived,
      transfer: 0,
      credit: initialCredit,
      netReceived,
    };
  }

  if (inv.paymentMethod === 'Transferência') {
    return {
      cash: 0,
      multicaixa: 0,
      transfer: netReceived,
      credit: initialCredit,
      netReceived,
    };
  }

  if (inv.paymentMethod === 'Crédito') {
    // Caso tenha havido entrada parcial no ato da venda a crédito, entra como numerário salvo indicação de ref. bancária
    const downPaymentAsTransfer = Boolean(inv.transferReference && netReceived > 0);
    return {
      cash: downPaymentAsTransfer ? 0 : netReceived,
      multicaixa: 0,
      transfer: downPaymentAsTransfer ? netReceived : 0,
      credit: initialCredit,
      netReceived,
    };
  }

  // Pagamento Combinado: utiliza paymentSplits estruturado ou extrai do paymentSummary legado
  let splitCash = 0;
  let splitMbx = 0;
  let splitTrf = 0;

  if (Array.isArray(inv.paymentSplits) && inv.paymentSplits.length > 0) {
    for (const sp of inv.paymentSplits) {
      const amt = Math.max(0, roundKz(Number(sp.amount) || 0));
      if (sp.method === 'Dinheiro') splitCash = roundKz(splitCash + amt);
      else if (sp.method === 'Multicaixa') splitMbx = roundKz(splitMbx + amt);
      else if (sp.method === 'Transferência') splitTrf = roundKz(splitTrf + amt);
    }
  } else if (inv.paymentSummary) {
    // Fallback para documentos antigos sem array paymentSplits (ex: "Dinheiro: 2.000,00 Kz + Multicaixa: 3.000,00 Kz")
    const baseSegment = inv.paymentSummary.split('+ Liq.')[0] || '';
    const parts = baseSegment.split('+');
    for (const part of parts) {
      const m = part.match(/(Dinheiro|Multicaixa|Transferência)\s*:\s*([\d.,]+)/i);
      if (m) {
        const methodLabel = m[1]!.toLowerCase();
        const parsedVal = Number(m[2]!.replace(/\./g, '').replace(',', '.')) || 0;
        if (methodLabel === 'dinheiro') splitCash = roundKz(splitCash + parsedVal);
        else if (methodLabel === 'multicaixa') splitMbx = roundKz(splitMbx + parsedVal);
        else splitTrf = roundKz(splitTrf + parsedVal);
      }
    }
  }

  const grossSplits = roundKz(splitCash + splitMbx + splitTrf);
  if (grossSplits <= 0) {
    return {
      cash: netReceived,
      multicaixa: 0,
      transfer: 0,
      credit: initialCredit,
      netReceived,
    };
  }

  const overpaid = Math.max(0, roundKz(grossSplits - payable));
  const netCash = Math.max(0, roundKz(splitCash - overpaid));
  const residualOverpay = Math.max(0, roundKz(overpaid - splitCash));
  const netMbx = Math.max(0, roundKz(splitMbx - residualOverpay));
  const netTrf = Math.max(0, roundKz(payable - netCash - netMbx - initialCredit));

  return {
    cash: netCash,
    multicaixa: netMbx,
    transfer: Math.min(splitTrf, netTrf),
    credit: initialCredit,
    netReceived: roundKz(netCash + netMbx + Math.min(splitTrf, netTrf)),
  };
}

export function doesInvoiceBelongToSession(inv: InvoiceRecord, session: CashSession): boolean {
  if (inv.docType !== 'FR') return false;
  if (inv.sessionId) {
    return inv.sessionId === session.id;
  }
  const sameCashier =
    inv.cashier.trim().toLowerCase() === session.cashier.trim().toLowerCase();
  if (!sameCashier) return false;
  if (inv.issuedAtIso < session.openedAtIso) return false;
  if (session.closedAtIso && inv.issuedAtIso > session.closedAtIso) return false;
  return true;
}

export function calculateCashSessionSummary(
  session: CashSession,
  invoices: ReadonlyArray<InvoiceRecord>,
  movements: ReadonlyArray<CashMovement>,
  liveCountedCash?: number | null
): CashSessionSummary {
  const openingFloat = Math.max(0, roundKz(Number(session.openingFloat) || 0));

  let salesCash = 0;
  let salesMulticaixa = 0;
  let salesTransfer = 0;
  let salesCredit = 0;
  let invoiceCount = 0;
  let cancelledCount = 0;

  for (const inv of invoices) {
    if (!doesInvoiceBelongToSession(inv, session)) continue;
    if (inv.status === 'cancelled') {
      cancelledCount += 1;
      continue;
    }
    invoiceCount += 1;
    const br = extractInvoiceSaleReceipts(inv);
    salesCash = roundKz(salesCash + br.cash);
    salesMulticaixa = roundKz(salesMulticaixa + br.multicaixa);
    salesTransfer = roundKz(salesTransfer + br.transfer);
    salesCredit = roundKz(salesCredit + br.credit);
  }

  const sessionMovements = movements.filter((m) => m.sessionId === session.id);
  let reforcosTotal = 0;
  let entradasTotal = 0;
  let sangriasTotal = 0;
  let saidasTotal = 0;
  let debtCash = 0;
  let debtMulticaixa = 0;
  let debtTransfer = 0;

  for (const mov of sessionMovements) {
    const amt = Math.max(0, roundKz(Number(mov.amount) || 0));
    if (amt <= 0) continue;
    if (mov.type === 'REFORCO') {
      reforcosTotal = roundKz(reforcosTotal + amt);
    } else if (mov.type === 'ENTRADA') {
      entradasTotal = roundKz(entradasTotal + amt);
    } else if (mov.type === 'SANGRIA') {
      sangriasTotal = roundKz(sangriasTotal + amt);
    } else if (mov.type === 'SAIDA') {
      saidasTotal = roundKz(saidasTotal + amt);
    } else if (mov.type === 'LIQUIDACAO_DIVIDA') {
      if (mov.paymentMethod === 'Multicaixa') {
        debtMulticaixa = roundKz(debtMulticaixa + amt);
      } else if (mov.paymentMethod === 'Transferência') {
        debtTransfer = roundKz(debtTransfer + amt);
      } else {
        debtCash = roundKz(debtCash + amt);
      }
    }
  }

  const expectedCash = roundKz(
    openingFloat +
      salesCash +
      debtCash +
      reforcosTotal +
      entradasTotal -
      sangriasTotal -
      saidasTotal
  );

  const totalCashReceipts = roundKz(salesCash + debtCash);
  const totalMulticaixaReceipts = roundKz(salesMulticaixa + debtMulticaixa);
  const totalTransferReceipts = roundKz(salesTransfer + debtTransfer);
  const totalReceivedAllMethods = roundKz(
    totalCashReceipts + totalMulticaixaReceipts + totalTransferReceipts
  );

  const resolvedCounted =
    typeof liveCountedCash === 'number' && Number.isFinite(liveCountedCash)
      ? roundKz(liveCountedCash)
      : typeof session.countedCash === 'number' && Number.isFinite(session.countedCash)
        ? roundKz(session.countedCash)
        : null;

  const differenceAmount =
    resolvedCounted !== null ? roundKz(resolvedCounted - expectedCash) : null;

  return {
    openingFloat,
    salesCash,
    salesMulticaixa,
    salesTransfer,
    salesCredit,
    debtCash,
    debtMulticaixa,
    debtTransfer,
    totalByMethod: {
      Dinheiro: totalCashReceipts,
      Multicaixa: totalMulticaixaReceipts,
      Transferência: totalTransferReceipts,
      Crédito: salesCredit,
    },
    totalReceivedAllMethods,
    reforcosTotal,
    entradasTotal,
    sangriasTotal,
    saidasTotal,
    expectedCash,
    countedCash: resolvedCounted,
    differenceAmount,
    invoiceCount,
    cancelledCount,
    movementCount: sessionMovements.length,
  };
}

