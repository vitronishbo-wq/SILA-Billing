import {
  calculateCashSessionSummary,
  extractInvoiceSaleReceipts,
  roundKz,
} from './billingEngine.ts';
import type {
  CashMovement,
  CashSession,
  Customer,
  CustomerPaymentTerms,
  InvoiceRecord,
  Product,
  PurchaseRecord,
} from './types.ts';

export interface FinancialIntelligencePermissions {
  canViewMargins: boolean;
  canViewCashVariance: boolean;
  canViewReceivables: boolean;
  canViewStockAlerts: boolean;
  activeCashierFilter?: string;
}

export interface FinancialIntelligenceInput {
  invoices: ReadonlyArray<InvoiceRecord>;
  products: ReadonlyArray<Product>;
  customers: ReadonlyArray<Customer>;
  cashSessions: ReadonlyArray<CashSession>;
  cashMovements: ReadonlyArray<CashMovement>;
  purchases?: ReadonlyArray<PurchaseRecord>;
  permissions: FinancialIntelligencePermissions;
  referenceNowIso?: string;
}

export interface TopSoldProductStat {
  productId: string;
  code: string;
  name: string;
  unit: string;
  qty: number;
  grossRevenue: number;
  sharePct: number;
}

export interface LowStockAlertItem {
  id: string;
  code: string;
  name: string;
  unit: string;
  stockQty: number;
  minStockQty: number;
  isOutOfStock: boolean;
}

export interface DebtorQuickStat {
  customerId: string;
  name: string;
  phone: string;
  openDebt: number;
  openCount: number;
  isOverdue: boolean;
}

export interface MarginWindowSummary {
  grossSales: number;
  netSalesRevenue: number;
  coveredNetRevenue: number;
  coveredCostTotal: number;
  estimatedProfitKz: number;
  estimatedMarginPct: number | null;
  costCoveragePct: number;
  uncostedLinesCount: number;
  totalLinesCount: number;
}

export type CashVarianceStatus =
  | 'UNCOUNTED_OPEN'
  | 'EXACT'
  | 'SURPLUS'
  | 'SHORTAGE'
  | 'NO_SESSION';

export interface CashSessionVarianceInfo {
  sessionId: string;
  cashier: string;
  operator: string;
  sessionStatus: 'open' | 'closed';
  openedAtIso: string;
  closedAtIso?: string;
  expectedCash: number;
  countedCash: number | null;
  differenceAmount: number | null;
  varianceStatus: CashVarianceStatus;
}

export interface FinancialIntelligenceSnapshot {
  generatedAtIso: string;
  todayIso: string;

  // 1. Quanto vendi hoje?
  soldToday: {
    grossTotal: number;
    grossBeforeReturns: number;
    returnsDeducted: number;
    docCount: number;
    cancelledCount: number;
    averageTicket: number;
    yesterdayGrossTotal: number;
    vsYesterdayPct: number | null;
  };

  // 2. Quanto recebi efectivamente?
  collectedToday: {
    totalReceived: number;
    fromSalesToday: number;
    fromDebtCollections: number;
    refundsDeducted: number;
    creditLeftUnpaidToday: number;
    byMethod: {
      Dinheiro: number;
      Multicaixa: number;
      Transferência: number;
    };
  };

  // 3. Quanto tenho por receber?
  receivables: {
    restricted: boolean;
    totalDue: number;
    invoiceCount: number;
    customerCount: number;
    overdueTotal: number;
    overdueCount: number;
    topDebtors: DebtorQuickStat[];
  };

  // 4. Quais são os produtos mais vendidos?
  topProducts: {
    today: TopSoldProductStat[];
    last30Days: TopSoldProductStat[];
    todayTotalUnits: number;
    last30DaysTotalUnits: number;
  };

  // 5. Quais estão a acabar?
  lowStock: {
    restricted: boolean;
    trackedCount: number;
    outOfStockCount: number;
    lowStockCount: number;
    urgentItems: LowStockAlertItem[];
  };

  // 6. Qual é a minha margem estimada?
  estimatedMargin: {
    restricted: boolean;
    today: MarginWindowSummary | null;
    last30Days: MarginWindowSummary | null;
  };

  // 7. Qual foi a diferença entre o dinheiro esperado e o dinheiro contado?
  cashDifference: {
    restricted: boolean;
    primary: CashSessionVarianceInfo | null;
    latestClosed: CashSessionVarianceInfo | null;
  };
}

function getPaymentTermsDays(terms?: CustomerPaymentTerms): number {
  switch (terms) {
    case '15_DIAS':
      return 15;
    case '30_DIAS':
      return 30;
    case '45_DIAS':
      return 45;
    case '60_DIAS':
      return 60;
    case 'IMEDIATO':
    case 'PERSONALIZADO':
    default:
      return 0;
  }
}

function resolveLineNetRevenue(lineTotal: number, ivaRate: number): number {
  if (!Number.isFinite(ivaRate) || ivaRate <= 0) return roundKz(lineTotal);
  return roundKz(lineTotal / (1 + ivaRate / 100));
}

function isCustomerRefundMovement(mov: CashMovement): boolean {
  if (mov.type !== 'SAIDA') return false;
  if (mov.category === 'Reembolsos e Devoluções de Clientes') return true;
  return /^Reembolso Nota de Crédito /i.test((mov.reason || '').trim());
}

function classifyCashVarianceStatus(
  sessionStatus: 'open' | 'closed',
  countedCash: number | null,
  differenceAmount: number | null
): CashVarianceStatus {
  if (countedCash === null || differenceAmount === null) {
    return 'UNCOUNTED_OPEN';
  }
  if (Math.abs(differenceAmount) < 0.01) {
    return 'EXACT';
  }
  if (differenceAmount > 0) {
    return 'SURPLUS';
  }
  return sessionStatus === 'open' || sessionStatus === 'closed' ? 'SHORTAGE' : 'NO_SESSION';
}

export function buildFinancialIntelligenceSnapshot(
  input: FinancialIntelligenceInput
): FinancialIntelligenceSnapshot {
  const generatedAtIso = input.referenceNowIso || new Date().toISOString();
  const todayIso = generatedAtIso.slice(0, 10);

  const [ty, tm, td] = todayIso.split('-').map(Number);
  const baseUtcMs = Date.UTC(ty || 2026, (tm || 1) - 1, td || 1);
  const yesterdayIso = new Date(baseUtcMs - 86400000).toISOString().slice(0, 10);
  const thirtyDaysAgoIso = new Date(baseUtcMs - 29 * 86400000).toISOString().slice(0, 10);
  const nowMs = new Date(generatedAtIso).getTime();

  // Mapas auxiliares de produtos e clientes (O(N))
  const prodById = new Map<string, Product>();
  const prodByCode = new Map<string, Product>();
  for (const p of input.products) {
    prodById.set(p.id, p);
    if (p.code) prodByCode.set(p.code.trim().toLowerCase(), p);
  }

  const custById = new Map<string, Customer>();
  for (const c of input.customers) {
    custById.set(c.id, c);
  }

  // Custo de compra mais recente como fallback quando product.costPrice ainda não está definido
  const latestPurchaseCostByProd = new Map<string, number>();
  if (input.permissions.canViewMargins && input.purchases && input.purchases.length > 0) {
    const recordedPurchases = [...input.purchases]
      .filter((p) => p.status === 'recorded')
      .sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso));
    for (const pur of recordedPurchases) {
      for (const ln of pur.lines) {
        if (ln.productId && ln.unitCost > 0 && !latestPurchaseCostByProd.has(ln.productId)) {
          latestPurchaseCostByProd.set(ln.productId, roundKz(ln.unitCost));
        }
      }
    }
  }

  // Acumuladores 1, 2, 3, 4 e 6
  let soldTodayGrossBeforeReturns = 0;
  let soldTodayReturnsDeducted = 0;
  let soldTodayDocCount = 0;
  let soldTodayCancelledCount = 0;
  let yesterdayGrossBeforeReturns = 0;
  let yesterdayReturnsDeducted = 0;

  let salesCashToday = 0;
  let salesMulticaixaToday = 0;
  let salesTransferToday = 0;
  let creditLeftUnpaidToday = 0;

  let receivablesTotalDue = 0;
  let receivablesInvoiceCount = 0;
  let receivablesOverdueTotal = 0;
  let receivablesOverdueCount = 0;
  const debtorMap = new Map<string, DebtorQuickStat>();

  type ProdWindowAcc = {
    productId: string;
    code: string;
    name: string;
    unit: string;
    qty: number;
    grossRevenue: number;
  };
  const topProdTodayMap = new Map<string, ProdWindowAcc>();
  const topProd30dMap = new Map<string, ProdWindowAcc>();

  const makeMarginAcc = () => ({
    grossSales: 0,
    netSalesRevenue: 0,
    coveredNetRevenue: 0,
    coveredCostTotal: 0,
    uncostedLinesCount: 0,
    totalLinesCount: 0,
  });
  const marginTodayAcc = makeMarginAcc();
  const margin30dAcc = makeMarginAcc();

  const addProductWindowLine = (
    map: Map<string, ProdWindowAcc>,
    key: string,
    code: string,
    name: string,
    unit: string,
    qtyDelta: number,
    grossDelta: number
  ) => {
    const prev = map.get(key);
    if (prev) {
      prev.qty = roundKz(prev.qty + qtyDelta);
      prev.grossRevenue = roundKz(prev.grossRevenue + grossDelta);
    } else {
      map.set(key, {
        productId: key,
        code,
        name,
        unit,
        qty: roundKz(qtyDelta),
        grossRevenue: roundKz(grossDelta),
      });
    }
  };

  for (const inv of input.invoices) {
    const invDay = inv.issuedAtIso.slice(0, 10);
    const isSaleDoc = inv.docType === 'FR' || inv.docType === 'FA' || inv.docType === 'FT';
    const isCreditNote = inv.docType === 'NC';

    if (isSaleDoc && invDay === todayIso && inv.status === 'cancelled') {
      soldTodayCancelledCount += 1;
      continue;
    }

    if (inv.status !== 'issued') continue;

    if (isSaleDoc) {
      if (invDay === todayIso) {
        soldTodayGrossBeforeReturns = roundKz(soldTodayGrossBeforeReturns + inv.grandTotal);
        soldTodayDocCount += 1;
        const receipts = extractInvoiceSaleReceipts(inv);
        salesCashToday = roundKz(salesCashToday + receipts.cash);
        salesMulticaixaToday = roundKz(salesMulticaixaToday + receipts.multicaixa);
        salesTransferToday = roundKz(salesTransferToday + receipts.transfer);
        if ((inv.amountDue || 0) > 0) {
          creditLeftUnpaidToday = roundKz(creditLeftUnpaidToday + (inv.amountDue || 0));
        } else if (receipts.credit > 0 && inv.docType === 'FR') {
          creditLeftUnpaidToday = roundKz(creditLeftUnpaidToday + receipts.credit);
        }
      } else if (invDay === yesterdayIso) {
        yesterdayGrossBeforeReturns = roundKz(yesterdayGrossBeforeReturns + inv.grandTotal);
      }

      // Contas a receber abertas (estado actual)
      if (
        input.permissions.canViewReceivables &&
        (inv.docType === 'FR' || inv.docType === 'FA') &&
        (inv.amountDue || 0) > 0
      ) {
        const due = roundKz(inv.amountDue || 0);
        receivablesTotalDue = roundKz(receivablesTotalDue + due);
        receivablesInvoiceCount += 1;

        const cust = custById.get(inv.customerId);
        const termsDays = getPaymentTermsDays(cust?.paymentTerms);
        const issuedMs = new Date(inv.issuedAtIso).getTime();
        const elapsedDays = Number.isFinite(issuedMs)
          ? Math.max(0, Math.floor((nowMs - issuedMs) / 86400000))
          : 0;
        const isInvOverdue = elapsedDays > termsDays;
        if (isInvOverdue) {
          receivablesOverdueTotal = roundKz(receivablesOverdueTotal + due);
          receivablesOverdueCount += 1;
        }

        const custKey = inv.customerId || `anon_${inv.customerName}`;
        const prevDebtor = debtorMap.get(custKey);
        if (prevDebtor) {
          prevDebtor.openDebt = roundKz(prevDebtor.openDebt + due);
          prevDebtor.openCount += 1;
          if (isInvOverdue) prevDebtor.isOverdue = true;
        } else {
          debtorMap.set(custKey, {
            customerId: inv.customerId || '',
            name: cust?.name || inv.customerName || 'Cliente',
            phone: cust?.phone || inv.customerPhone || '',
            openDebt: due,
            openCount: 1,
            isOverdue: isInvOverdue,
          });
        }
      }

      // Linhas para ranking de produtos e margem (Hoje e 30 dias)
      const inToday = invDay === todayIso;
      const in30d = invDay >= thirtyDaysAgoIso && invDay <= todayIso;
      if (inToday || in30d) {
        const globalDiscFactor =
          typeof inv.globalDiscountPct === 'number' && inv.globalDiscountPct > 0
            ? Math.max(0, 1 - inv.globalDiscountPct / 100)
            : 1;

        for (const ln of inv.lines) {
          const matchedProd =
            prodById.get(ln.productId) ||
            (ln.code ? prodByCode.get(ln.code.trim().toLowerCase()) : undefined);
          const resolvedKey = matchedProd?.id || ln.productId || `code_${ln.code || ln.description}`;
          const lineGross = roundKz(ln.lineTotal * globalDiscFactor);

          if (inToday) {
            addProductWindowLine(
              topProdTodayMap,
              resolvedKey,
              matchedProd?.code || ln.code || 'S/COD',
              matchedProd?.name || ln.description || 'Artigo',
              matchedProd?.unit || ln.unit || 'un',
              ln.qty,
              lineGross
            );
          }
          if (in30d) {
            addProductWindowLine(
              topProd30dMap,
              resolvedKey,
              matchedProd?.code || ln.code || 'S/COD',
              matchedProd?.name || ln.description || 'Artigo',
              matchedProd?.unit || ln.unit || 'un',
              ln.qty,
              lineGross
            );
          }

          if (input.permissions.canViewMargins) {
            const unitCost =
              matchedProd && typeof matchedProd.costPrice === 'number' && matchedProd.costPrice > 0
                ? roundKz(matchedProd.costPrice)
                : latestPurchaseCostByProd.get(resolvedKey) || 0;
            const lineNet = resolveLineNetRevenue(lineGross, ln.ivaRate);
            const hasCost = unitCost > 0;
            const lineCost = hasCost ? roundKz(ln.qty * unitCost) : 0;

            if (inToday) {
              marginTodayAcc.grossSales = roundKz(marginTodayAcc.grossSales + lineGross);
              marginTodayAcc.netSalesRevenue = roundKz(marginTodayAcc.netSalesRevenue + lineNet);
              marginTodayAcc.totalLinesCount += 1;
              if (hasCost) {
                marginTodayAcc.coveredNetRevenue = roundKz(
                  marginTodayAcc.coveredNetRevenue + lineNet
                );
                marginTodayAcc.coveredCostTotal = roundKz(
                  marginTodayAcc.coveredCostTotal + lineCost
                );
              } else {
                marginTodayAcc.uncostedLinesCount += 1;
              }
            }
            if (in30d) {
              margin30dAcc.grossSales = roundKz(margin30dAcc.grossSales + lineGross);
              margin30dAcc.netSalesRevenue = roundKz(margin30dAcc.netSalesRevenue + lineNet);
              margin30dAcc.totalLinesCount += 1;
              if (hasCost) {
                margin30dAcc.coveredNetRevenue = roundKz(margin30dAcc.coveredNetRevenue + lineNet);
                margin30dAcc.coveredCostTotal = roundKz(margin30dAcc.coveredCostTotal + lineCost);
              } else {
                margin30dAcc.uncostedLinesCount += 1;
              }
            }
          }
        }
      }
    } else if (isCreditNote) {
      if (invDay === todayIso) {
        soldTodayReturnsDeducted = roundKz(soldTodayReturnsDeducted + inv.grandTotal);
      } else if (invDay === yesterdayIso) {
        yesterdayReturnsDeducted = roundKz(yesterdayReturnsDeducted + inv.grandTotal);
      }

      const inToday = invDay === todayIso;
      const in30d = invDay >= thirtyDaysAgoIso && invDay <= todayIso;
      if (inToday || in30d) {
        const globalDiscFactor =
          typeof inv.globalDiscountPct === 'number' && inv.globalDiscountPct > 0
            ? Math.max(0, 1 - inv.globalDiscountPct / 100)
            : 1;

        for (const ln of inv.lines) {
          const matchedProd =
            prodById.get(ln.productId) ||
            (ln.code ? prodByCode.get(ln.code.trim().toLowerCase()) : undefined);
          const resolvedKey = matchedProd?.id || ln.productId || `code_${ln.code || ln.description}`;
          const lineGross = roundKz(ln.lineTotal * globalDiscFactor);

          if (inToday) {
            addProductWindowLine(
              topProdTodayMap,
              resolvedKey,
              matchedProd?.code || ln.code || 'S/COD',
              matchedProd?.name || ln.description || 'Artigo',
              matchedProd?.unit || ln.unit || 'un',
              -ln.qty,
              -lineGross
            );
          }
          if (in30d) {
            addProductWindowLine(
              topProd30dMap,
              resolvedKey,
              matchedProd?.code || ln.code || 'S/COD',
              matchedProd?.name || ln.description || 'Artigo',
              matchedProd?.unit || ln.unit || 'un',
              -ln.qty,
              -lineGross
            );
          }

          if (input.permissions.canViewMargins) {
            const unitCost =
              matchedProd && typeof matchedProd.costPrice === 'number' && matchedProd.costPrice > 0
                ? roundKz(matchedProd.costPrice)
                : latestPurchaseCostByProd.get(resolvedKey) || 0;
            const lineNet = resolveLineNetRevenue(lineGross, ln.ivaRate);
            const hasCost = unitCost > 0;
            const lineCost = hasCost ? roundKz(ln.qty * unitCost) : 0;

            if (inToday) {
              marginTodayAcc.grossSales = Math.max(0, roundKz(marginTodayAcc.grossSales - lineGross));
              marginTodayAcc.netSalesRevenue = Math.max(
                0,
                roundKz(marginTodayAcc.netSalesRevenue - lineNet)
              );
              if (hasCost) {
                marginTodayAcc.coveredNetRevenue = Math.max(
                  0,
                  roundKz(marginTodayAcc.coveredNetRevenue - lineNet)
                );
                marginTodayAcc.coveredCostTotal = Math.max(
                  0,
                  roundKz(marginTodayAcc.coveredCostTotal - lineCost)
                );
              }
            }
            if (in30d) {
              margin30dAcc.grossSales = Math.max(0, roundKz(margin30dAcc.grossSales - lineGross));
              margin30dAcc.netSalesRevenue = Math.max(
                0,
                roundKz(margin30dAcc.netSalesRevenue - lineNet)
              );
              if (hasCost) {
                margin30dAcc.coveredNetRevenue = Math.max(
                  0,
                  roundKz(margin30dAcc.coveredNetRevenue - lineNet)
                );
                margin30dAcc.coveredCostTotal = Math.max(
                  0,
                  roundKz(margin30dAcc.coveredCostTotal - lineCost)
                );
              }
            }
          }
        }
      }
    }
  }

  // 2. Liquidações de dívida e reembolsos efectivos de hoje via cashMovements
  let debtCashToday = 0;
  let debtMulticaixaToday = 0;
  let debtTransferToday = 0;
  let refundCashToday = 0;
  let refundMulticaixaToday = 0;
  let refundTransferToday = 0;

  for (const mov of input.cashMovements) {
    if (mov.createdAtIso.slice(0, 10) !== todayIso) continue;
    const amt = Math.max(0, roundKz(Number(mov.amount) || 0));
    if (amt <= 0) continue;

    if (mov.type === 'LIQUIDACAO_DIVIDA') {
      if (mov.paymentMethod === 'Multicaixa') debtMulticaixaToday = roundKz(debtMulticaixaToday + amt);
      else if (mov.paymentMethod === 'Transferência')
        debtTransferToday = roundKz(debtTransferToday + amt);
      else debtCashToday = roundKz(debtCashToday + amt);
    } else if (isCustomerRefundMovement(mov)) {
      if (mov.paymentMethod === 'Multicaixa')
        refundMulticaixaToday = roundKz(refundMulticaixaToday + amt);
      else if (mov.paymentMethod === 'Transferência')
        refundTransferToday = roundKz(refundTransferToday + amt);
      else refundCashToday = roundKz(refundCashToday + amt);
    }
  }

  const netCashToday = Math.max(0, roundKz(salesCashToday + debtCashToday - refundCashToday));
  const netMulticaixaToday = Math.max(
    0,
    roundKz(salesMulticaixaToday + debtMulticaixaToday - refundMulticaixaToday)
  );
  const netTransferToday = Math.max(
    0,
    roundKz(salesTransferToday + debtTransferToday - refundTransferToday)
  );
  const fromSalesToday = roundKz(salesCashToday + salesMulticaixaToday + salesTransferToday);
  const fromDebtCollections = roundKz(debtCashToday + debtMulticaixaToday + debtTransferToday);
  const refundsDeducted = roundKz(refundCashToday + refundMulticaixaToday + refundTransferToday);
  const totalReceivedToday = roundKz(netCashToday + netMulticaixaToday + netTransferToday);

  // 1. Totais finais de venda hoje
  const soldTodayGrossTotal = Math.max(
    0,
    roundKz(soldTodayGrossBeforeReturns - soldTodayReturnsDeducted)
  );
  const yesterdayGrossTotal = Math.max(
    0,
    roundKz(yesterdayGrossBeforeReturns - yesterdayReturnsDeducted)
  );
  const vsYesterdayPct =
    yesterdayGrossTotal > 0
      ? roundKz(((soldTodayGrossTotal - yesterdayGrossTotal) / yesterdayGrossTotal) * 100)
      : null;

  // 4. Produtos mais vendidos
  const finalizeTopList = (map: Map<string, ProdWindowAcc>) => {
    const valid = Array.from(map.values()).filter((item) => item.qty > 0 && item.grossRevenue > 0);
    const totalUnits = roundKz(valid.reduce((acc, i) => acc + i.qty, 0));
    const totalRev = roundKz(valid.reduce((acc, i) => acc + i.grossRevenue, 0));
    valid.sort((a, b) => b.qty - a.qty || b.grossRevenue - a.grossRevenue);
    const items: TopSoldProductStat[] = valid.slice(0, 5).map((item) => ({
      ...item,
      sharePct: totalRev > 0 ? roundKz((item.grossRevenue / totalRev) * 100) : 0,
    }));
    return { items, totalUnits };
  };
  const topTodayRes = finalizeTopList(topProdTodayMap);
  const top30dRes = finalizeTopList(topProd30dMap);

  // 5. Stock a acabar / esgotado
  let trackedCount = 0;
  let outOfStockCount = 0;
  let lowStockCount = 0;
  const urgentItems: LowStockAlertItem[] = [];

  if (input.permissions.canViewStockAlerts) {
    for (const prod of input.products) {
      if (prod.active === false || !prod.trackStock) continue;
      trackedCount += 1;
      const qty = roundKz(prod.stockQty ?? 0);
      const minQty = roundKz(prod.minStockQty ?? 0);
      if (qty <= 0) {
        outOfStockCount += 1;
        urgentItems.push({
          id: prod.id,
          code: prod.code,
          name: prod.name,
          unit: prod.unit || 'un',
          stockQty: qty,
          minStockQty: minQty,
          isOutOfStock: true,
        });
      } else if (minQty > 0 && qty <= minQty) {
        lowStockCount += 1;
        urgentItems.push({
          id: prod.id,
          code: prod.code,
          name: prod.name,
          unit: prod.unit || 'un',
          stockQty: qty,
          minStockQty: minQty,
          isOutOfStock: false,
        });
      }
    }
    urgentItems.sort((a, b) => {
      if (a.isOutOfStock !== b.isOutOfStock) return a.isOutOfStock ? -1 : 1;
      const ratioA = a.minStockQty > 0 ? a.stockQty / a.minStockQty : a.stockQty;
      const ratioB = b.minStockQty > 0 ? b.stockQty / b.minStockQty : b.stockQty;
      return ratioA - ratioB || a.name.localeCompare(b.name, 'pt');
    });
  }

  // 6. Margem estimada (estritamente bloqueada por RBAC)
  const finalizeMarginWindow = (acc: ReturnType<typeof makeMarginAcc>): MarginWindowSummary | null => {
    if (!input.permissions.canViewMargins) return null;
    const profit = roundKz(acc.coveredNetRevenue - acc.coveredCostTotal);
    const marginPct =
      acc.coveredNetRevenue > 0 ? roundKz((profit / acc.coveredNetRevenue) * 100) : null;
    const costCoveragePct =
      acc.netSalesRevenue > 0
        ? Math.min(100, roundKz((acc.coveredNetRevenue / acc.netSalesRevenue) * 100))
        : 0;
    return {
      grossSales: acc.grossSales,
      netSalesRevenue: acc.netSalesRevenue,
      coveredNetRevenue: acc.coveredNetRevenue,
      coveredCostTotal: acc.coveredCostTotal,
      estimatedProfitKz: profit,
      estimatedMarginPct: marginPct,
      costCoveragePct,
      uncostedLinesCount: acc.uncostedLinesCount,
      totalLinesCount: acc.totalLinesCount,
    };
  };

  // 7. Diferença entre dinheiro esperado e dinheiro contado (Caixa)
  let primaryVariance: CashSessionVarianceInfo | null = null;
  let latestClosedVariance: CashSessionVarianceInfo | null = null;

  if (input.permissions.canViewCashVariance) {
    const cashierFilter = (input.permissions.activeCashierFilter || '').trim().toLowerCase();
    const scopedSessions = cashierFilter
      ? input.cashSessions.filter((s) => s.cashier.trim().toLowerCase() === cashierFilter)
      : input.cashSessions;

    const toVarianceInfo = (sess: CashSession): CashSessionVarianceInfo => {
      const summary = calculateCashSessionSummary(sess, input.invoices, input.cashMovements);
      const counted = summary.countedCash;
      const diff = summary.differenceAmount;
      return {
        sessionId: sess.id,
        cashier: sess.cashier,
        operator: sess.operator,
        sessionStatus: sess.status,
        openedAtIso: sess.openedAtIso,
        closedAtIso: sess.closedAtIso,
        expectedCash: summary.expectedCash,
        countedCash: counted,
        differenceAmount: diff,
        varianceStatus: classifyCashVarianceStatus(sess.status, counted, diff),
      };
    };

    const openSessions = [...scopedSessions]
      .filter((s) => s.status === 'open')
      .sort((a, b) => b.openedAtIso.localeCompare(a.openedAtIso));
    const closedSessions = [...scopedSessions]
      .filter((s) => s.status === 'closed')
      .sort((a, b) =>
        (b.closedAtIso || b.openedAtIso).localeCompare(a.closedAtIso || a.openedAtIso)
      );

    const latestClosed = closedSessions[0] || null;
    if (latestClosed) {
      latestClosedVariance = toVarianceInfo(latestClosed);
    }

    const latestClosedToday = closedSessions.find(
      (s) => (s.closedAtIso || s.openedAtIso).slice(0, 10) === todayIso
    );
    const activeOpen = openSessions[0] || null;

    if (activeOpen) {
      primaryVariance = toVarianceInfo(activeOpen);
    } else if (latestClosedToday) {
      primaryVariance = toVarianceInfo(latestClosedToday);
    } else if (latestClosed) {
      primaryVariance = latestClosedVariance;
    }
  }

  const topDebtors = Array.from(debtorMap.values())
    .sort((a, b) => b.openDebt - a.openDebt)
    .slice(0, 4);

  return {
    generatedAtIso,
    todayIso,
    soldToday: {
      grossTotal: soldTodayGrossTotal,
      grossBeforeReturns: soldTodayGrossBeforeReturns,
      returnsDeducted: soldTodayReturnsDeducted,
      docCount: soldTodayDocCount,
      cancelledCount: soldTodayCancelledCount,
      averageTicket: soldTodayDocCount > 0 ? roundKz(soldTodayGrossTotal / soldTodayDocCount) : 0,
      yesterdayGrossTotal,
      vsYesterdayPct,
    },
    collectedToday: {
      totalReceived: totalReceivedToday,
      fromSalesToday,
      fromDebtCollections,
      refundsDeducted,
      creditLeftUnpaidToday,
      byMethod: {
        Dinheiro: netCashToday,
        Multicaixa: netMulticaixaToday,
        Transferência: netTransferToday,
      },
    },
    receivables: {
      restricted: !input.permissions.canViewReceivables,
      totalDue: receivablesTotalDue,
      invoiceCount: receivablesInvoiceCount,
      customerCount: debtorMap.size,
      overdueTotal: receivablesOverdueTotal,
      overdueCount: receivablesOverdueCount,
      topDebtors,
    },
    topProducts: {
      today: topTodayRes.items,
      last30Days: top30dRes.items,
      todayTotalUnits: topTodayRes.totalUnits,
      last30DaysTotalUnits: top30dRes.totalUnits,
    },
    lowStock: {
      restricted: !input.permissions.canViewStockAlerts,
      trackedCount,
      outOfStockCount,
      lowStockCount,
      urgentItems: urgentItems.slice(0, 6),
    },
    estimatedMargin: {
      restricted: !input.permissions.canViewMargins,
      today: finalizeMarginWindow(marginTodayAcc),
      last30Days: finalizeMarginWindow(margin30dAcc),
    },
    cashDifference: {
      restricted: !input.permissions.canViewCashVariance,
      primary: primaryVariance,
      latestClosed: latestClosedVariance,
    },
  };
}
