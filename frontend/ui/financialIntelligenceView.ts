import { formatDateTimePt, formatKzNumber } from '../../src/core/billingEngine';
import type {
  CashSessionVarianceInfo,
  FinancialIntelligenceSnapshot,
} from '../../src/core/financialIntelligence';
import { ICONS } from './icons';

export interface FinancialIntelligenceRenderOptions {
  companyName: string;
  canAccessCash: boolean;
  canAccessProducts: boolean;
  canAccessFinance: boolean;
  canAccessHistory: boolean;
  canShareDailyWhatsApp: boolean;
  mode?: 'EMBEDDED' | 'MODAL';
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatCashVarianceHeadline(info: CashSessionVarianceInfo | null): {
  valueText: string;
  toneClassLight: string;
  toneClassDark: string;
  detailText: string;
} {
  if (!info) {
    return {
      valueText: 'Sem turno',
      toneClassLight: 'text-slate-600',
      toneClassDark: 'text-slate-300',
      detailText: 'Nenhum turno de caixa registado ainda.',
    };
  }

  if (info.varianceStatus === 'UNCOUNTED_OPEN') {
    return {
      valueText: `${formatKzNumber(info.expectedCash)} Kz esp.`,
      toneClassLight: 'text-slate-900',
      toneClassDark: 'text-white',
      detailText: `Caixa ${info.cashier} aberto · Contagem física faz-se no fecho.`,
    };
  }

  const diff = info.differenceAmount ?? 0;
  const counted = info.countedCash ?? 0;

  if (info.varianceStatus === 'EXACT') {
    return {
      valueText: '0,00 Kz (Certo)',
      toneClassLight: 'text-emerald-700',
      toneClassDark: 'text-emerald-400',
      detailText: `Caixa ${info.cashier} · Esperado ${formatKzNumber(info.expectedCash)} Kz · Contado ${formatKzNumber(counted)} Kz.`,
    };
  }

  if (info.varianceStatus === 'SURPLUS') {
    return {
      valueText: `+${formatKzNumber(diff)} Kz (Sobra)`,
      toneClassLight: 'text-blue-700',
      toneClassDark: 'text-blue-400',
      detailText: `Caixa ${info.cashier} · Esperado ${formatKzNumber(info.expectedCash)} Kz · Contado ${formatKzNumber(counted)} Kz.`,
    };
  }

  return {
    valueText: `${formatKzNumber(diff)} Kz (Falta)`,
    toneClassLight: 'text-red-700',
    toneClassDark: 'text-red-400',
    detailText: `Caixa ${info.cashier} · Esperado ${formatKzNumber(info.expectedCash)} Kz · Contado ${formatKzNumber(counted)} Kz.`,
  };
}

export function renderFinancialIntelligenceGrid(
  snap: FinancialIntelligenceSnapshot,
  opts: FinancialIntelligenceRenderOptions
): string {
  const soldDeltaText =
    snap.soldToday.vsYesterdayPct !== null
      ? `${snap.soldToday.vsYesterdayPct > 0 ? '+' : ''}${formatKzNumber(snap.soldToday.vsYesterdayPct)}% vs ontem (${formatKzNumber(snap.soldToday.yesterdayGrossTotal)} Kz)`
      : snap.soldToday.yesterdayGrossTotal > 0
        ? `Ontem: ${formatKzNumber(snap.soldToday.yesterdayGrossTotal)} Kz`
        : 'Sem vendas registadas ontem';

  const topList =
    snap.topProducts.today.length > 0 ? snap.topProducts.today : snap.topProducts.last30Days;
  const topListScopeLabel =
    snap.topProducts.today.length > 0 ? 'Hoje' : 'Últimos 30 dias';

  const activeMargin = snap.estimatedMargin.today && snap.estimatedMargin.today.totalLinesCount > 0
    ? { scope: 'Hoje', data: snap.estimatedMargin.today }
    : snap.estimatedMargin.last30Days
      ? { scope: 'Últimos 30 dias', data: snap.estimatedMargin.last30Days }
      : null;

  const varianceTarget =
    snap.cashDifference.primary?.varianceStatus === 'UNCOUNTED_OPEN' && snap.cashDifference.latestClosed
      ? { primary: snap.cashDifference.primary, closedRef: snap.cashDifference.latestClosed }
      : { primary: snap.cashDifference.primary, closedRef: null };

  const primaryCashHeadline = formatCashVarianceHeadline(varianceTarget.primary);

  return `
    <div class="space-y-3">
      <!-- Linha 1: 4 Perguntas Financeiras Directas (Hoje, Recebido, Por Receber, Margem) -->
      <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <!-- 1. Quanto vendi hoje? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-semibold text-slate-600">1. Quanto vendi hoje?</span>
            ${
              opts.canAccessHistory
                ? `<button
                    type="button"
                    data-action="intel-go-today-docs"
                    data-id="${escapeHtml(snap.todayIso)}"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Ver docs →</button>`
                : ''
            }
          </div>
          <div>
            <div class="text-xl font-bold text-slate-900 font-mono tabular-nums tracking-tight">
              ${formatKzNumber(snap.soldToday.grossTotal)} Kz
            </div>
            <div class="mt-0.5 text-[11px] text-slate-500 font-mono tabular-nums">
              ${snap.soldToday.docCount} ${snap.soldToday.docCount === 1 ? 'venda' : 'vendas'} · Ticket ${formatKzNumber(snap.soldToday.averageTicket)} Kz
            </div>
          </div>
          <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-500 font-mono tabular-nums truncate">
            ${escapeHtml(soldDeltaText)}${snap.soldToday.returnsDeducted > 0 ? ` · NC -${formatKzNumber(snap.soldToday.returnsDeducted)}` : ''}
          </div>
        </div>

        <!-- 2. Quanto recebi efectivamente? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-semibold text-slate-600">2. Quanto recebi efectivamente?</span>
            ${
              opts.canAccessCash
                ? `<button
                    type="button"
                    data-action="intel-go-module"
                    data-value="CASH"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Caixa →</button>`
                : ''
            }
          </div>
          <div>
            <div class="text-xl font-bold text-emerald-700 font-mono tabular-nums tracking-tight">
              ${formatKzNumber(snap.collectedToday.totalReceived)} Kz
            </div>
            <div class="mt-0.5 text-[11px] text-slate-500 font-mono tabular-nums truncate">
              Din ${formatKzNumber(snap.collectedToday.byMethod.Dinheiro)} · MCX ${formatKzNumber(snap.collectedToday.byMethod.Multicaixa)} · Trf ${formatKzNumber(snap.collectedToday.byMethod.Transferência)}
            </div>
          </div>
          <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-500 font-mono tabular-nums truncate">
            ${
              snap.collectedToday.fromDebtCollections > 0
                ? `Inclui ${formatKzNumber(snap.collectedToday.fromDebtCollections)} Kz de dívidas`
                : snap.collectedToday.creditLeftUnpaidToday > 0
                  ? `${formatKzNumber(snap.collectedToday.creditLeftUnpaidToday)} Kz ficou a crédito`
                  : '100% do faturado recebido hoje'
            }
          </div>
        </div>

        <!-- 3. Quanto tenho por receber? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-semibold text-slate-600">3. Quanto tenho por receber?</span>
            ${
              !snap.receivables.restricted && opts.canAccessFinance
                ? `<button
                    type="button"
                    data-action="intel-go-receivables"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Cobrar →</button>`
                : ''
            }
          </div>
          ${
            snap.receivables.restricted
              ? `<div>
                  <div class="text-sm font-semibold text-slate-500">Acesso restrito</div>
                  <div class="mt-0.5 text-[11px] text-slate-400">Disponível para perfil financeiro autorizado.</div>
                </div>
                <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-400">Sem permissão de carteira</div>`
              : `<div>
                  <div class="text-xl font-bold font-mono tabular-nums tracking-tight ${
                    snap.receivables.totalDue > 0 ? 'text-amber-700' : 'text-slate-900'
                  }">
                    ${formatKzNumber(snap.receivables.totalDue)} Kz
                  </div>
                  <div class="mt-0.5 text-[11px] text-slate-500 font-mono tabular-nums">
                    ${snap.receivables.customerCount} ${snap.receivables.customerCount === 1 ? 'cliente' : 'clientes'} · ${snap.receivables.invoiceCount} doc(s) em aberto
                  </div>
                </div>
                <div class="pt-2 border-t border-slate-100 text-[11px] font-mono tabular-nums truncate ${
                  snap.receivables.overdueTotal > 0 ? 'text-red-700 font-medium' : 'text-slate-500'
                }">
                  ${
                    snap.receivables.overdueTotal > 0
                      ? `Vencido: ${formatKzNumber(snap.receivables.overdueTotal)} Kz (${snap.receivables.overdueCount} doc.)`
                      : snap.receivables.topDebtors[0]
                        ? `Maior saldo: ${escapeHtml(snap.receivables.topDebtors[0].name)}`
                        : 'Sem dívidas de clientes em aberto'
                  }
                </div>`
          }
        </div>

        <!-- 6. Qual é a minha margem estimada? (RBAC estrito) -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-semibold text-slate-600">6. Qual é a minha margem estimada?</span>
            ${
              !snap.estimatedMargin.restricted && opts.canAccessFinance
                ? `<button
                    type="button"
                    data-action="intel-go-margins"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Detalhes →</button>`
                : ''
            }
          </div>
          ${
            snap.estimatedMargin.restricted
              ? `<div>
                  <div class="text-sm font-semibold text-slate-500">Protegido por perfil</div>
                  <div class="mt-0.5 text-[11px] text-slate-400">Custos e margens ocultos para este operador.</div>
                </div>
                <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-400">Regra RBAC activa</div>`
              : activeMargin && activeMargin.data.estimatedMarginPct !== null
                ? `<div>
                    <div class="text-xl font-bold font-mono tabular-nums tracking-tight ${
                      activeMargin.data.estimatedProfitKz >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }">
                      ${formatKzNumber(activeMargin.data.estimatedMarginPct)}%
                      <span class="text-xs font-semibold text-slate-600">(${formatKzNumber(activeMargin.data.estimatedProfitKz)} Kz)</span>
                    </div>
                    <div class="mt-0.5 text-[11px] text-slate-500 font-mono tabular-nums">
                      Base: ${escapeHtml(activeMargin.scope)} · s/ IVA ${formatKzNumber(activeMargin.data.coveredNetRevenue)} Kz
                    </div>
                  </div>
                  <div class="pt-2 border-t border-slate-100 text-[11px] font-mono tabular-nums truncate ${
                    activeMargin.data.costCoveragePct < 100 ? 'text-amber-700' : 'text-slate-500'
                  }">
                    ${
                      activeMargin.data.costCoveragePct < 100
                        ? `Custo definido em ${formatKzNumber(activeMargin.data.costCoveragePct)}% das vendas`
                        : 'Cobertura de custo 100% nas linhas'
                    }
                  </div>`
                : `<div>
                    <div class="text-base font-bold text-slate-500">Sem custo definido</div>
                    <div class="mt-0.5 text-[11px] text-slate-500">Registe o preço de custo nos artigos ou compras.</div>
                  </div>
                  <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-400">Base pronta para cálculo automático</div>`
          }
        </div>
      </div>

      <!-- Linha 2: 3 Respostas Operacionais (Mais Vendidos, Stock a Acabar, Diferença de Caixa) -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <!-- 4. Quais são os produtos mais vendidos? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-slate-700">4. Produtos mais vendidos</span>
            <span class="text-[11px] text-slate-500 whitespace-nowrap">${escapeHtml(topListScopeLabel)}</span>
          </div>
          ${
            topList.length === 0
              ? `<div class="py-4 text-xs text-slate-500">Ainda sem vendas concluídas para classificar artigos.</div>`
              : `<div class="divide-y divide-slate-100">
                  ${topList
                    .slice(0, 4)
                    .map(
                      (item, idx) => `
                        <div class="py-1.5 flex items-center justify-between gap-2 text-xs">
                          <div class="min-w-0 flex items-center gap-2">
                            <span class="text-[11px] font-mono tabular-nums text-slate-400 w-4 shrink-0">${idx + 1}.</span>
                            <span class="font-medium text-slate-800 truncate">${escapeHtml(item.name)}</span>
                          </div>
                          <div class="text-right font-mono tabular-nums shrink-0">
                            <span class="font-semibold text-slate-900">${formatKzNumber(item.qty)} ${escapeHtml(item.unit)}</span>
                            <span class="text-[11px] text-slate-500 ml-1.5">${formatKzNumber(item.grossRevenue)} Kz</span>
                          </div>
                        </div>
                      `
                    )
                    .join('')}
                </div>`
          }
        </div>

        <!-- 5. Quais estão a acabar? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2.5">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-slate-700">5. Quais estão a acabar?</span>
            ${
              !snap.lowStock.restricted && opts.canAccessProducts
                ? `<button
                    type="button"
                    data-action="intel-go-module"
                    data-value="PRODUCTS"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Ver stock →</button>`
                : ''
            }
          </div>
          ${
            snap.lowStock.restricted
              ? `<div class="py-4 text-xs text-slate-400">Gestão de stock não autorizada para este operador.</div>`
              : snap.lowStock.trackedCount === 0
                ? `<div class="py-4 text-xs text-slate-500">Nenhum artigo com controlo de stock activo.</div>`
                : snap.lowStock.urgentItems.length === 0
                  ? `<div class="py-4 text-xs text-emerald-700 font-medium">Stock saudável nos ${snap.lowStock.trackedCount} artigo(s) controlados.</div>`
                  : `<div class="space-y-1.5">
                      <div class="text-[11px] font-mono tabular-nums text-slate-500">
                        ${snap.lowStock.outOfStockCount} esgotado(s) · ${snap.lowStock.lowStockCount} em mínimo
                      </div>
                      <div class="divide-y divide-slate-100">
                        ${snap.lowStock.urgentItems
                          .slice(0, 4)
                          .map(
                            (st) => `
                              <div class="py-1.5 flex items-center justify-between gap-2 text-xs">
                                <span class="font-medium text-slate-800 truncate">${escapeHtml(st.name)}</span>
                                <span class="font-mono tabular-nums text-[11px] shrink-0 ${
                                  st.isOutOfStock ? 'text-red-700 font-bold' : 'text-amber-700 font-semibold'
                                }">
                                  ${st.isOutOfStock ? 'Esgotado (0)' : `${formatKzNumber(st.stockQty)} / min ${formatKzNumber(st.minStockQty)} ${escapeHtml(st.unit)}`}
                                </span>
                              </div>
                            `
                          )
                          .join('')}
                      </div>
                    </div>`
          }
        </div>

        <!-- 7. Qual foi a diferença entre o dinheiro esperado e o dinheiro contado? -->
        <div class="p-3.5 rounded-lg border border-slate-200 bg-white flex flex-col justify-between gap-2">
          <div class="flex items-start justify-between gap-2">
            <span class="text-xs font-semibold text-slate-700">7. Esperado vs. Contado (Caixa)</span>
            ${
              opts.canAccessCash
                ? `<button
                    type="button"
                    data-action="intel-go-module"
                    data-value="CASH"
                    class="text-[11px] font-medium text-blue-600 hover:underline whitespace-nowrap shrink-0"
                  >Abrir Caixa →</button>`
                : ''
            }
          </div>
          ${
            snap.cashDifference.restricted
              ? `<div class="py-4 text-xs text-slate-400">Conferência de gaveta visível apenas para perfil de caixa autorizado.</div>`
              : `<div>
                  <div class="text-lg font-bold font-mono tabular-nums ${primaryCashHeadline.toneClassLight}">
                    ${escapeHtml(primaryCashHeadline.valueText)}
                  </div>
                  <div class="mt-0.5 text-[11px] text-slate-600 font-mono tabular-nums">
                    ${escapeHtml(primaryCashHeadline.detailText)}
                  </div>
                </div>
                <div class="pt-2 border-t border-slate-100 text-[11px] text-slate-500 font-mono tabular-nums">
                  ${
                    varianceTarget.closedRef
                      ? `Último fecho (${escapeHtml(varianceTarget.closedRef.cashier)}): ${
                          varianceTarget.closedRef.differenceAmount === 0
                            ? '0,00 Kz (Certo)'
                            : `${(varianceTarget.closedRef.differenceAmount ?? 0) > 0 ? '+' : ''}${formatKzNumber(varianceTarget.closedRef.differenceAmount ?? 0)} Kz`
                        }`
                      : varianceTarget.primary?.closedAtIso
                        ? `Fechado em ${formatDateTimePt(varianceTarget.primary.closedAtIso).slashDate}`
                        : 'Conferência actual do turno em curso'
                  }
                </div>`
          }
        </div>
      </div>
    </div>
  `;
}

export function renderFinancialIntelligenceModal(
  snap: FinancialIntelligenceSnapshot,
  opts: FinancialIntelligenceRenderOptions
): string {
  const dt = formatDateTimePt(snap.generatedAtIso);

  return `
    <div
      data-action="intel-backdrop-close"
      class="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-[1px] flex items-center justify-center p-3 sm:p-5 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="intel-modal-title"
    >
      <div
        onclick="event.stopPropagation()"
        class="w-full max-w-5xl bg-slate-50 border border-slate-200 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
      >
        <!-- Cabeçalho limpo -->
        <header class="px-4 py-3 bg-white border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div class="min-w-0">
            <h2 id="intel-modal-title" class="text-sm font-bold text-slate-900 flex items-center gap-2">
              <span class="text-blue-600">${ICONS.trendingUp}</span>
              <span>Pulso Financeiro · ${escapeHtml(opts.companyName)}</span>
            </h2>
            <p class="text-[11px] text-slate-500 font-mono tabular-nums">
              7 respostas imediatas · Actualizado às ${dt.time} de ${dt.slashDate} · Cálculo local instantâneo
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            ${
              opts.canShareDailyWhatsApp
                ? `<button
                    type="button"
                    data-action="whatsapp-daily-summary"
                    class="h-8 px-3 rounded-md border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    ${ICONS.whatsapp}
                    <span>Enviar Resumo (WA)</span>
                  </button>`
                : ''
            }
            ${
              opts.canAccessFinance
                ? `<button
                    type="button"
                    data-action="intel-go-module"
                    data-value="FINANCE"
                    class="h-8 px-3 rounded-md border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium whitespace-nowrap shrink-0"
                  >Gestão Financeira</button>`
                : ''
            }
            <button
              type="button"
              data-action="close-financial-intelligence"
              aria-label="Fechar Pulso Financeiro"
              class="h-8 w-8 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-slate-600 flex items-center justify-center shrink-0"
            >${ICONS.close}</button>
          </div>
        </header>

        <!-- Conteúdo com scroll -->
        <div class="p-4 overflow-y-auto">
          ${renderFinancialIntelligenceGrid(snap, { ...opts, mode: 'MODAL' })}
        </div>
      </div>
    </div>
  `;
}

export function renderMobileFinancialIntelligenceSection(
  snap: FinancialIntelligenceSnapshot,
  opts: {
    canAccessProducts: boolean;
    canShareDailyWhatsApp: boolean;
  }
): string {
  const topList =
    snap.topProducts.today.length > 0 ? snap.topProducts.today : snap.topProducts.last30Days;
  const topScope = snap.topProducts.today.length > 0 ? 'Hoje' : '30 dias';

  const activeMargin =
    snap.estimatedMargin.today && snap.estimatedMargin.today.totalLinesCount > 0
      ? { scope: 'Hoje', data: snap.estimatedMargin.today }
      : snap.estimatedMargin.last30Days
        ? { scope: '30d', data: snap.estimatedMargin.last30Days }
        : null;

  const varianceTarget =
    snap.cashDifference.primary?.varianceStatus === 'UNCOUNTED_OPEN' && snap.cashDifference.latestClosed
      ? snap.cashDifference.latestClosed
      : snap.cashDifference.primary;
  const cashHeadline = formatCashVarianceHeadline(varianceTarget);

  return `
    <section class="bg-slate-900/85 border border-slate-800/90 rounded-2xl p-3.5 flex flex-col gap-3">
      <div class="flex items-center justify-between gap-2">
        <div class="min-w-0">
          <h3 class="text-sm font-bold text-white flex items-center gap-1.5">
            <span class="text-blue-400">${ICONS.trendingUp}</span>
            <span>Pulso Financeiro</span>
          </h3>
          <span class="text-[11px] text-slate-400 block">Respostas imediatas sem sair do telemóvel</span>
        </div>
        ${
          opts.canShareDailyWhatsApp
            ? `<button
                type="button"
                data-action="whatsapp-daily-summary"
                title="Enviar resumo diário ao proprietário via WhatsApp"
                class="min-h-[44px] px-3 rounded-xl bg-emerald-600/20 hover:bg-emerald-600 border border-emerald-700/60 text-emerald-300 hover:text-white text-xs font-semibold flex items-center gap-1.5 active:scale-95 transition-colors whitespace-nowrap shrink-0"
              >
                ${ICONS.whatsapp}
                <span>Resumo WA</span>
              </button>`
            : ''
        }
      </div>

      <!-- 1 & 2: Vendas vs Recebido Efectivo -->
      <div class="grid grid-cols-2 gap-2.5">
        <div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
          <span class="text-[11px] text-slate-400 block">1. Vendi hoje</span>
          <span class="text-sm font-bold text-white font-mono tabular-nums block mt-0.5">${formatKzNumber(snap.soldToday.grossTotal)} Kz</span>
          <span class="text-[10px] text-slate-400 font-mono tabular-nums block mt-0.5">${snap.soldToday.docCount} doc(s) · Méd. ${formatKzNumber(snap.soldToday.averageTicket)}</span>
        </div>
        <div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
          <span class="text-[11px] text-slate-400 block">2. Recebi de facto</span>
          <span class="text-sm font-bold text-emerald-400 font-mono tabular-nums block mt-0.5">${formatKzNumber(snap.collectedToday.totalReceived)} Kz</span>
          <span class="text-[10px] text-slate-400 font-mono tabular-nums block mt-0.5 truncate">Din ${formatKzNumber(snap.collectedToday.byMethod.Dinheiro)} · MCX ${formatKzNumber(snap.collectedToday.byMethod.Multicaixa)}</span>
        </div>
      </div>

      <!-- 3 & 6: Por Receber & Margem Estimada -->
      <div class="grid grid-cols-2 gap-2.5">
        ${
          snap.receivables.restricted
            ? `<div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
                <span class="text-[11px] text-slate-400 block">3. Por receber</span>
                <span class="text-xs font-medium text-slate-500 block mt-1">Acesso restrito</span>
              </div>`
            : `<div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
                <span class="text-[11px] text-slate-400 block">3. Por receber</span>
                <span class="text-sm font-bold font-mono tabular-nums block mt-0.5 ${
                  snap.receivables.totalDue > 0 ? 'text-amber-400' : 'text-slate-200'
                }">${formatKzNumber(snap.receivables.totalDue)} Kz</span>
                <span class="text-[10px] text-slate-400 font-mono tabular-nums block mt-0.5">${snap.receivables.customerCount} cliente(s) · ${snap.receivables.overdueCount} venc.</span>
              </div>`
        }

        ${
          snap.estimatedMargin.restricted
            ? `<div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
                <span class="text-[11px] text-slate-400 block">6. Margem estimada</span>
                <span class="text-xs font-medium text-slate-500 block mt-1">Perfil protegido</span>
              </div>`
            : `<div class="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800/80">
                <span class="text-[11px] text-slate-400 block">6. Margem estimada</span>
                ${
                  activeMargin && activeMargin.data.estimatedMarginPct !== null
                    ? `<span class="text-sm font-bold text-emerald-400 font-mono tabular-nums block mt-0.5">${formatKzNumber(activeMargin.data.estimatedMarginPct)}%</span>
                       <span class="text-[10px] text-slate-400 font-mono tabular-nums block mt-0.5 truncate">${activeMargin.scope} · ${formatKzNumber(activeMargin.data.estimatedProfitKz)} Kz</span>`
                    : `<span class="text-xs font-medium text-slate-400 block mt-1">Sem custo registado</span>`
                }
              </div>`
        }
      </div>

      <!-- 4, 5 e 7 em linhas compactas de leitura rápida -->
      <div class="divide-y divide-slate-800/80 border-t border-slate-800/80 text-xs">
        <!-- 4. Mais vendidos -->
        <div class="py-2 flex items-start justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[11px] text-slate-400 block">4. Mais vendidos (${escapeHtml(topScope)})</span>
            ${
              topList.length === 0
                ? `<span class="text-slate-500 text-xs">Sem vendas ainda</span>`
                : `<span class="text-slate-100 font-medium block truncate">${topList
                    .slice(0, 2)
                    .map((i) => `${escapeHtml(i.name)} (${formatKzNumber(i.qty)})`)
                    .join(' · ')}</span>`
            }
          </div>
        </div>

        <!-- 5. Stock a acabar -->
        ${
          snap.lowStock.restricted
            ? ''
            : `<div class="py-2 flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <span class="text-[11px] text-slate-400 block">5. Stock a acabar</span>
                  ${
                    snap.lowStock.urgentItems.length === 0
                      ? `<span class="text-emerald-400 font-medium text-xs">Sem alertas de ruptura</span>`
                      : `<span class="text-amber-300 font-medium block truncate">${snap.lowStock.urgentItems
                          .slice(0, 2)
                          .map((s) => `${escapeHtml(s.name)} (${formatKzNumber(s.stockQty)})`)
                          .join(' · ')}</span>`
                  }
                </div>
                ${
                  opts.canAccessProducts
                    ? `<button
                        type="button"
                        data-action="mobile-go-products"
                        class="min-h-[44px] px-2.5 text-xs font-semibold text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
                      >Ver stock</button>`
                    : ''
                }
              </div>`
        }

        <!-- 7. Diferença de caixa -->
        ${
          snap.cashDifference.restricted
            ? ''
            : `<div class="pt-2 flex items-start justify-between gap-2">
                <div class="min-w-0">
                  <span class="text-[11px] text-slate-400 block">7. Esperado vs. Contado (Caixa)</span>
                  <span class="font-bold font-mono tabular-nums ${cashHeadline.toneClassDark}">${escapeHtml(cashHeadline.valueText)}</span>
                  <span class="text-[10px] text-slate-400 font-mono tabular-nums block mt-0.5">${escapeHtml(cashHeadline.detailText)}</span>
                </div>
              </div>`
        }
      </div>
    </section>
  `;
}
