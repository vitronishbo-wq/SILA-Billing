import {
  formatDateTimePt,
  formatKzNumber,
} from '../../src/core/billingEngine';
import {
  type AccountantAuditCategory,
  type AccountantAuditTrailItem,
  type AccountantMonthlyPackage,
  type AccountantMonthOption,
} from '../../src/core/accountantEngine';
import {
  formatDocumentTypeLabelPt,
  type CompanyProfile,
} from '../../src/core/types';
import { type AuthorizedCompanyPortfolioItem } from '../../src/services/localStore';
import { ICONS } from './icons';

export type AccountantWorkspaceTab =
  | 'OVERVIEW'
  | 'VAT_WITHHOLDING'
  | 'CANCELLED_RECTIFIED'
  | 'AUDIT_HISTORY'
  | 'PORTFOLIO';

export interface AccountantWorkspaceRenderProps {
  companyId: string;
  company: CompanyProfile;
  activeTab: AccountantWorkspaceTab;
  yearMonth: string;
  monthOptions: AccountantMonthOption[];
  pkg: AccountantMonthlyPackage;
  auditItems: AccountantAuditTrailItem[];
  auditCategory: AccountantAuditCategory;
  auditPeriodMode: 'MONTH' | 'ALL';
  auditSearch: string;
  portfolioItems: AuthorizedCompanyPortfolioItem[];
  portfolioSearch: string;
  canViewCostPrices: boolean;
  canViewMaster: boolean;
  canManageUsers: boolean;
  isOnline: boolean;
  isSignedIn: boolean;
  noticeMessage: string | null;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPtTimestamp(iso?: string): string {
  if (!iso) return '---';
  const dt = formatDateTimePt(iso);
  return `${dt.date} ${dt.time}`;
}

function formatRegimePt(regime?: string): string {
  switch (regime) {
    case 'EXCLUSAO':
      return 'Regime de Exclusão';
    case 'SIMPLIFICADO':
      return 'Regime Simplificado';
    default:
      return 'Regime Geral';
  }
}

export function renderAccountantWorkspaceHtml(props: AccountantWorkspaceRenderProps): string {
  const {
    company,
    activeTab,
    yearMonth,
    monthOptions,
    pkg,
    auditItems,
    auditCategory,
    auditPeriodMode,
    auditSearch,
    portfolioItems,
    portfolioSearch,
    noticeMessage,
  } = props;

  const { vatReport, withholdingReport, cancelledRectified, auxiliaryMaps, saftResult, xsdReport } =
    pkg;

  const tabs: Array<{ id: AccountantWorkspaceTab; label: string }> = [
    { id: 'OVERVIEW', label: 'Fecho Mensal & SAF-T' },
    { id: 'VAT_WITHHOLDING', label: 'IVA & Retenções' },
    { id: 'CANCELLED_RECTIFIED', label: 'Anulados & Rectificados' },
    { id: 'AUDIT_HISTORY', label: 'Alterações & Auditoria' },
    { id: 'PORTFOLIO', label: `Empresas (${portfolioItems.length})` },
  ];

  const filteredPortfolio = portfolioItems.filter((item) => {
    const q = portfolioSearch.trim().toLowerCase();
    if (!q) return true;
    const hay = `${item.company.profile.shortName} ${item.company.profile.legalName} ${item.company.profile.nif} ${item.viewerRoleLabelPt}`.toLowerCase();
    return hay.includes(q);
  });

  const ocpcaLine = company.accountantName
    ? `${company.accountantName}${company.accountantOcpcaNumber ? ` · Cédula OCPCA ${company.accountantOcpcaNumber}` : ''}`
    : 'Contabilista certificado não indicado na Ficha Mestre';

  return `
    <div class="h-full overflow-y-auto p-4 md:p-6">
      <div class="max-w-7xl mx-auto space-y-5">
        <!-- Cabeçalho Principal do Contabilista -->
        <section class="bg-white border border-slate-200 rounded-lg p-4 md:p-5 space-y-4">
          <div class="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span class="font-semibold text-slate-700">Modo Contabilista</span>
                <span aria-hidden="true">·</span>
                <span class="font-mono tabular-nums">NIF ${escapeHtml(company.nif || '---')}</span>
                <span aria-hidden="true">·</span>
                <span>${escapeHtml(formatRegimePt(company.taxRegime))}</span>
                <span aria-hidden="true">·</span>
                <span>AGT ${company.agtEnvironment === 'PRODUCAO' ? 'Produção' : 'Simulação'}</span>
              </div>
              <h1 class="text-lg md:text-xl font-bold text-slate-900 truncate">
                ${escapeHtml(company.legalName || company.shortName)}
              </h1>
              <p class="text-xs text-slate-600 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>Responsável técnico: ${escapeHtml(ocpcaLine)}</span>
                ${
                  props.canViewMaster
                    ? `<button type="button" data-action="open-company-master-direct" class="text-blue-600 hover:underline font-medium whitespace-nowrap">Editar na Ficha Mestre</button>`
                    : ''
                }
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2 shrink-0">
              <label for="accountant-month-select" class="sr-only">Período contabilístico</label>
              <select
                id="accountant-month-select"
                class="h-9 px-3 rounded-md border border-slate-300 bg-white text-xs font-medium text-slate-800 focus:outline-none focus:border-blue-600"
              >
                ${monthOptions
                  .map(
                    (opt) =>
                      `<option value="${escapeHtml(opt.yearMonth)}" ${
                        opt.yearMonth === yearMonth ? 'selected' : ''
                      }>${escapeHtml(opt.labelPt)} (${opt.invoiceCount} doc.)</option>`
                  )
                  .join('')}
              </select>

              <button
                type="button"
                data-action="export-accountant-saft"
                class="h-9 px-3 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                ${ICONS.download}
                <span>SAF-T (AO) XML</span>
              </button>

              <button
                type="button"
                data-action="export-accountant-dossier"
                class="h-9 px-3 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                ${ICONS.printer}
                <span>Dossier A4 (PDF)</span>
              </button>

              <button
                type="button"
                data-action="export-accountant-zip"
                class="h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-700 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                ${ICONS.download}
                <span>Exportar Pacote Mensal (.zip)</span>
              </button>
            </div>
          </div>

          ${
            noticeMessage
              ? `<div class="px-3 py-2 rounded-md border border-emerald-200 bg-emerald-50 text-xs text-emerald-800 font-medium">${escapeHtml(
                  noticeMessage
                )}</div>`
              : ''
          }

          <!-- Navegação Interna do Modo Contabilista -->
          <div class="border-t border-slate-200 pt-3 flex items-center gap-1.5 overflow-x-auto">
            ${tabs
              .map((t) => {
                const isActive = t.id === activeTab;
                return `
                  <button
                    type="button"
                    data-action="set-accountant-tab"
                    data-value="${t.id}"
                    class="h-9 px-3.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                    }"
                  >
                    ${escapeHtml(t.label)}
                  </button>
                `;
              })
              .join('')}
          </div>
        </section>

        ${
          activeTab === 'OVERVIEW'
            ? renderOverviewTab(pkg, props.canViewCostPrices)
            : activeTab === 'VAT_WITHHOLDING'
              ? renderVatAndWithholdingTab(pkg)
              : activeTab === 'CANCELLED_RECTIFIED'
                ? renderCancelledAndRectifiedTab(pkg)
                : activeTab === 'AUDIT_HISTORY'
                  ? renderAuditHistoryTab({
                      items: auditItems,
                      category: auditCategory,
                      periodMode: auditPeriodMode,
                      search: auditSearch,
                      scopeLabel: pkg.scope.labelPt,
                      canViewCostPrices: props.canViewCostPrices,
                    })
                  : renderPortfolioTab({
                      activeCompanyId: props.companyId,
                      items: filteredPortfolio,
                      totalCount: portfolioItems.length,
                      search: portfolioSearch,
                      canManageUsers: props.canManageUsers,
                      isOnline: props.isOnline,
                      isSignedIn: props.isSignedIn,
                    })
        }
      </div>
    </div>
  `;

  function renderOverviewTab(p: AccountantMonthlyPackage, canSeeCosts: boolean): string {
    const xsdOk = xsdReport.valid && saftResult.validation.valid;
    return `
      <!-- Indicadores do Período -->
      <section class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Facturação Líquida (${escapeHtml(p.scope.labelPt)})</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${formatKzNumber(vatReport.netGrandTotal)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            ${vatReport.activeFiscalCount} doc. fiscais · ${vatReport.creditNotesCount} NC
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">IVA Líquido Apurado</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${formatKzNumber(vatReport.netVatPayable)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            Base tributável: ${formatKzNumber(vatReport.netTaxableBase)} Kz
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Retenção II Estimada (${withholdingReport.iiRatePct}%)</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${formatKzNumber(withholdingReport.estimatedIiTotal)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            Base serviços: ${formatKzNumber(withholdingReport.netServiceBase)} Kz
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Anulações &amp; Caixa</div>
          <div class="mt-1 text-lg font-bold ${
            cancelledRectified.cancelledCount > 0 ? 'text-amber-700' : 'text-slate-900'
          } font-mono tabular-nums">
            ${cancelledRectified.cancelledCount} anulado(s)
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            Dif. caixa: ${formatKzNumber(auxiliaryMaps.cashNetDifference)} Kz (${auxiliaryMaps.cashClosedCount} fechos)
          </div>
        </div>
      </section>

      <!-- Conformidade SAF-T (AO) e Ficheiros do Fecho -->
      <section class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="lg:col-span-2 bg-white border border-slate-200 rounded-lg p-4 md:p-5 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-3">
            <div>
              <h2 class="text-sm font-semibold text-slate-900">SAF-T (AO) v1.01_01 — Estado Estrutural AGT</h2>
              <p class="text-xs text-slate-500">
                Prazo limite de submissão: <span class="font-medium text-slate-800">${escapeHtml(p.scope.submissionDeadline)}</span>
                <span aria-hidden="true"> · </span>
                <span class="font-mono">${escapeHtml(saftResult.filename)}</span>
              </p>
            </div>
            <span class="text-xs font-semibold px-2.5 py-1 rounded border ${
              xsdOk
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-800'
            }">
              ${xsdOk ? 'Conforme XSD &amp; Integridade' : `Atenção: ${xsdReport.errors.length} erro(s) XSD`}
            </span>
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <div class="text-slate-500">SalesInvoices</div>
              <div class="font-semibold text-slate-900 font-mono tabular-nums">${xsdReport.stats.salesInvoices}</div>
            </div>
            <div>
              <div class="text-slate-500">WorkingDocuments</div>
              <div class="font-semibold text-slate-900 font-mono tabular-nums">${xsdReport.stats.workingDocuments}</div>
            </div>
            <div>
              <div class="text-slate-500">Clientes / Artigos</div>
              <div class="font-semibold text-slate-900 font-mono tabular-nums">${xsdReport.stats.customers} / ${xsdReport.stats.products}</div>
            </div>
            <div>
              <div class="text-slate-500">Séries Activas</div>
              <div class="font-semibold text-slate-900 font-mono tabular-nums">${auxiliaryMaps.activeSeriesCount} / ${auxiliaryMaps.configuredSeriesCount}</div>
            </div>
          </div>

          ${
            xsdReport.errors.length > 0 || saftResult.validation.issues.length > 0
              ? `<div class="border border-amber-200 bg-amber-50 rounded-md p-3 text-xs text-amber-900 space-y-1">
                  <div class="font-semibold">Alertas de validação detectados:</div>
                  ${[
                    ...xsdReport.errors.slice(0, 4).map((e) => `${e.code}: ${e.message}`),
                    ...saftResult.validation.issues.slice(0, 4).map((i) => i.message),
                  ]
                    .map((msg) => `<div>• ${escapeHtml(msg)}</div>`)
                    .join('')}
                </div>`
              : `<p class="text-xs text-slate-600">
                  Sequência numérica, assinaturas RSA-SHA1 e reconciliação de totais do período verificadas com sucesso.
                </p>`
          }
        </div>

        <!-- Exportações Individuais -->
        <div class="bg-white border border-slate-200 rounded-lg p-4 md:p-5 space-y-3">
          <h2 class="text-sm font-semibold text-slate-900 border-b border-slate-200 pb-2.5">
            Ficheiros Individuais do Mês
          </h2>
          <div class="space-y-2">
            <button
              type="button"
              data-action="export-accountant-vat-xlsx"
              class="w-full h-9 px-3 rounded-md border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-800 flex items-center justify-between"
            >
              <span>Mapa de IVA (.xlsx)</span>
              <span class="text-slate-500">${ICONS.download}</span>
            </button>
            <button
              type="button"
              data-action="export-accountant-wht-xlsx"
              class="w-full h-9 px-3 rounded-md border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-800 flex items-center justify-between"
            >
              <span>Mapa Retenções &amp; Compras (.xlsx)</span>
              <span class="text-slate-500">${ICONS.download}</span>
            </button>
            <button
              type="button"
              data-action="export-accountant-cancelled-xlsx"
              class="w-full h-9 px-3 rounded-md border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-800 flex items-center justify-between"
            >
              <span>Anulados &amp; Rectificados (.xlsx)</span>
              <span class="text-slate-500">${ICONS.download}</span>
            </button>
            <button
              type="button"
              data-action="export-accountant-aux-xlsx"
              class="w-full h-9 px-3 rounded-md border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-800 flex items-center justify-between"
            >
              <span>Mapas Auxiliares &amp; Caixa (.xlsx)</span>
              <span class="text-slate-500">${ICONS.download}</span>
            </button>
          </div>
          ${
            !canSeeCosts
              ? `<p class="text-[11px] text-slate-500">Preços de custo ocultos pelo perfil RBAC activo.</p>`
              : ''
          }
        </div>
      </section>

      <!-- Mapas Auxiliares: Vendas por Série & Meios de Pagamento -->
      <section class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="lg:col-span-2 bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-slate-900">Vendas por Tipo Documental e Série</h2>
            <span class="text-xs text-slate-500 font-mono tabular-nums">${auxiliaryMaps.seriesSales.length} série(s)</span>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
                <tr>
                  <th class="text-left font-medium px-4 py-2.5">Documento</th>
                  <th class="text-left font-medium px-3 py-2.5">Série</th>
                  <th class="text-right font-medium px-3 py-2.5">Emit.</th>
                  <th class="text-right font-medium px-3 py-2.5">Anul.</th>
                  <th class="text-right font-medium px-3 py-2.5">Base (Kz)</th>
                  <th class="text-right font-medium px-3 py-2.5">IVA (Kz)</th>
                  <th class="text-right font-medium px-4 py-2.5">Total (Kz)</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100">
                ${
                  auxiliaryMaps.seriesSales.length === 0
                    ? `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-500">Sem documentos registados em ${escapeHtml(p.scope.labelPt)}.</td></tr>`
                    : auxiliaryMaps.seriesSales
                        .map(
                          (row) => `
                          <tr class="hover:bg-slate-50/70">
                            <td class="px-4 py-2.5 text-slate-800">
                              <span class="font-semibold font-mono">${escapeHtml(row.docType)}</span>
                              <span class="text-slate-500"> · ${escapeHtml(row.docTypeLabel)}</span>
                            </td>
                            <td class="px-3 py-2.5 font-mono text-slate-700">${escapeHtml(row.seriesCode)}</td>
                            <td class="px-3 py-2.5 text-right font-mono tabular-nums">${row.activeCount}</td>
                            <td class="px-3 py-2.5 text-right font-mono tabular-nums ${
                              row.cancelledCount > 0 ? 'text-amber-700 font-semibold' : 'text-slate-400'
                            }">${row.cancelledCount}</td>
                            <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(row.taxBaseTotal)}</td>
                            <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(row.taxTotal)}</td>
                            <td class="px-4 py-2.5 text-right font-semibold font-mono tabular-nums text-slate-900">${formatKzNumber(row.grandTotal)}</td>
                          </tr>
                        `
                        )
                        .join('')
                }
              </tbody>
            </table>
          </div>
        </div>

        <div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <h2 class="text-sm font-semibold text-slate-900">Meios de Pagamento</h2>
            <span class="text-xs text-slate-500">${escapeHtml(p.scope.labelPt)}</span>
          </div>
          <div class="p-4 space-y-3">
            ${
              auxiliaryMaps.paymentMethods.length === 0
                ? `<p class="text-xs text-slate-500 py-4 text-center">Sem recebimentos facturados no período.</p>`
                : auxiliaryMaps.paymentMethods
                    .map(
                      (pm) => `
                      <div class="space-y-1">
                        <div class="flex items-center justify-between text-xs">
                          <span class="font-medium text-slate-800">${escapeHtml(pm.method)}</span>
                          <span class="font-mono tabular-nums text-slate-900 font-semibold">
                            ${formatKzNumber(pm.amount)} Kz <span class="text-slate-500 font-normal">(${pm.sharePct.toFixed(1)}%)</span>
                          </span>
                        </div>
                        <div class="h-1.5 w-full bg-slate-100 rounded overflow-hidden">
                          <div class="h-full bg-slate-800" style="width:${Math.min(100, Math.max(2, pm.sharePct))}%"></div>
                        </div>
                      </div>
                    `
                    )
                    .join('')
            }
          </div>
        </div>
      </section>

      <!-- Sessões de Caixa no Período -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">Reconciliação de Sessões de Caixa</h2>
          <span class="text-xs text-slate-500 font-mono tabular-nums">
            Esperado (fechos): ${formatKzNumber(auxiliaryMaps.cashTotalExpected)} Kz · Contado: ${formatKzNumber(auxiliaryMaps.cashTotalCounted)} Kz · Diferença: ${formatKzNumber(auxiliaryMaps.cashNetDifference)} Kz
          </span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Caixa / Operador</th>
                <th class="text-left font-medium px-3 py-2.5">Abertura</th>
                <th class="text-left font-medium px-3 py-2.5">Fecho</th>
                <th class="text-right font-medium px-3 py-2.5">Fundo Inicial</th>
                <th class="text-right font-medium px-3 py-2.5">Esperado</th>
                <th class="text-right font-medium px-3 py-2.5">Contado</th>
                <th class="text-right font-medium px-4 py-2.5">Diferença</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                auxiliaryMaps.cashSessions.length === 0
                  ? `<tr><td colspan="7" class="px-4 py-5 text-center text-slate-500">Nenhuma sessão de caixa registada neste mês.</td></tr>`
                  : auxiliaryMaps.cashSessions
                      .map(
                        (cs) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 text-slate-800">
                            <span class="font-medium">Caixa ${escapeHtml(cs.cashier)}</span>
                            <span class="text-slate-500"> · ${escapeHtml(cs.operator)} · ${cs.status === 'closed' ? 'Fechado' : 'Aberto'}</span>
                          </td>
                          <td class="px-3 py-2.5 font-mono tabular-nums text-slate-600">${formatPtTimestamp(cs.openedAtIso)}</td>
                          <td class="px-3 py-2.5 font-mono tabular-nums text-slate-600">${cs.closedAtIso ? formatPtTimestamp(cs.closedAtIso) : 'Em curso'}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(cs.openingFloat)}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(cs.expectedCash)}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${cs.countedCash === null ? '---' : formatKzNumber(cs.countedCash)}</td>
                          <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                            cs.differenceAmount === null
                              ? 'text-slate-400'
                              : Math.abs(cs.differenceAmount) < 0.01
                                ? 'text-emerald-700'
                                : 'text-red-700'
                          }">${cs.differenceAmount === null ? '---' : formatKzNumber(cs.differenceAmount)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderVatAndWithholdingTab(p: AccountantMonthlyPackage): string {
    const v = p.vatReport;
    const w = p.withholdingReport;

    return `
      <!-- Apuramento de IVA -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-semibold text-slate-900">Apuramento de IVA por Escalão Legal</h2>
            <p class="text-xs text-slate-500">
              Exclui documentos anulados e proformas/comprovativos não fiscais (Proformas: ${formatKzNumber(v.proformaReferenceTotal)} Kz · Anulados: ${formatKzNumber(v.cancelledReferenceTotal)} Kz).
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" data-action="export-accountant-vat-csv" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">CSV IVA</button>
            <button type="button" data-action="export-accountant-vat-xlsx" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">Excel IVA (.xlsx)</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Código / Escalão</th>
                <th class="text-right font-medium px-3 py-2.5">Taxa</th>
                <th class="text-right font-medium px-3 py-2.5">Base Bruta</th>
                <th class="text-right font-medium px-3 py-2.5">IVA Liquidado</th>
                <th class="text-right font-medium px-3 py-2.5">Dedução NC (Base)</th>
                <th class="text-right font-medium px-3 py-2.5">Dedução NC (IVA)</th>
                <th class="text-right font-medium px-3 py-2.5">Base Líquida</th>
                <th class="text-right font-medium px-4 py-2.5">IVA Líquido</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${v.rateLines
                .map(
                  (r) => `
                  <tr class="hover:bg-slate-50/70">
                    <td class="px-4 py-2.5 text-slate-800">
                      <span class="font-semibold font-mono">${escapeHtml(r.code)}</span>
                      <span class="text-slate-600"> · ${escapeHtml(r.label)}</span>
                    </td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums">${escapeHtml(r.rateLabel)}</td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(r.grossBase)}</td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(r.grossTax)}</td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">${formatKzNumber(r.creditNotesBase)}</td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">${formatKzNumber(r.creditNotesTax)}</td>
                    <td class="px-3 py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">${formatKzNumber(r.netBase)}</td>
                    <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">${formatKzNumber(r.netTax)}</td>
                  </tr>
                `
                )
                .join('')}
            </tbody>
            <tfoot class="bg-slate-50 border-t border-slate-200 font-semibold text-slate-900">
              <tr>
                <td colspan="2" class="px-4 py-2.5">Total Consolidado</td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.grossTaxableBase)}</td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.grossVatTotal)}</td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.creditNotesBase)}</td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.creditNotesVat)}</td>
                <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.netTaxableBase)}</td>
                <td class="px-4 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(v.netVatPayable)} Kz</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="border-t border-slate-200 px-4 py-3">
          <h3 class="text-xs font-semibold text-slate-800 mb-2">Desdobramento de Isenções e Não Sujeição (0%)</h3>
          ${
            v.exemptionLines.length === 0
              ? `<p class="text-xs text-slate-500">Sem operações isentas registadas no período.</p>`
              : `<div class="overflow-x-auto">
                  <table class="w-full text-xs">
                    <thead class="text-slate-500 border-b border-slate-100">
                      <tr>
                        <th class="text-left font-medium py-1.5 pr-3">Código</th>
                        <th class="text-left font-medium py-1.5 pr-3">Enquadramento Legal AGT</th>
                        <th class="text-right font-medium py-1.5 px-3">Docs.</th>
                        <th class="text-right font-medium py-1.5 pl-3">Base Líquida (Kz)</th>
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-100">
                      ${v.exemptionLines
                        .map(
                          (e) => `
                          <tr>
                            <td class="py-2 pr-3 font-mono font-semibold text-slate-800">${escapeHtml(e.exemptionCode)}</td>
                            <td class="py-2 pr-3 text-slate-700">${escapeHtml(e.descriptionPt)}</td>
                            <td class="py-2 px-3 text-right font-mono tabular-nums">${e.documentCount}</td>
                            <td class="py-2 pl-3 text-right font-mono tabular-nums font-medium text-slate-900">${formatKzNumber(e.netBase)}</td>
                          </tr>
                        `
                        )
                        .join('')}
                    </tbody>
                  </table>
                </div>`
          }
        </div>
      </section>

      <!-- Mapa de Retenções na Fonte -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 class="text-sm font-semibold text-slate-900">Mapa de Retenções na Fonte (II / IVA_RET)</h2>
            <p class="text-xs text-slate-500">
              Estimativa sobre prestações de serviços facturadas (II ${w.iiRatePct}%) · Agente de Retenção de IVA: ${
                w.isVatRetentionAgent ? 'Sim (50% ref.)' : 'Não assinalado'
              }
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" data-action="export-accountant-wht-csv" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">CSV Retenções</button>
            <button type="button" data-action="export-accountant-wht-xlsx" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">Excel Retenções (.xlsx)</button>
          </div>
        </div>

        <div class="p-4 grid grid-cols-1 sm:grid-cols-4 gap-3 border-b border-slate-200 bg-slate-50/50 text-xs">
          <div>
            <div class="text-slate-500">Base Serviços Líquida</div>
            <div class="font-semibold font-mono tabular-nums text-slate-900">${formatKzNumber(w.netServiceBase)} Kz</div>
          </div>
          <div>
            <div class="text-slate-500">IVA sobre Serviços</div>
            <div class="font-semibold font-mono tabular-nums text-slate-900">${formatKzNumber(w.netServiceVat)} Kz</div>
          </div>
          <div>
            <div class="text-slate-500">Retenção II Est. (${w.iiRatePct}%)</div>
            <div class="font-semibold font-mono tabular-nums text-slate-900">${formatKzNumber(w.estimatedIiTotal)} Kz</div>
          </div>
          <div>
            <div class="text-slate-500">Retenção IVA Est.</div>
            <div class="font-semibold font-mono tabular-nums text-slate-900">${formatKzNumber(w.estimatedVatRetentionTotal)} Kz</div>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Documento</th>
                <th class="text-left font-medium px-3 py-2.5">Data</th>
                <th class="text-left font-medium px-3 py-2.5">Cliente / NIF</th>
                <th class="text-right font-medium px-3 py-2.5">Base Serviços</th>
                <th class="text-right font-medium px-3 py-2.5">IVA Serviços</th>
                <th class="text-right font-medium px-4 py-2.5">II Est. (${w.iiRatePct}%)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                w.serviceDocuments.length === 0
                  ? `<tr><td colspan="6" class="px-4 py-5 text-center text-slate-500">Nenhum documento com itens classificados como Serviço neste mês.</td></tr>`
                  : w.serviceDocuments
                      .map(
                        (d) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 font-mono font-medium text-slate-900">${escapeHtml(d.number)}</td>
                          <td class="px-3 py-2.5 font-mono tabular-nums text-slate-600">${d.issuedAtIso.slice(0, 10)}</td>
                          <td class="px-3 py-2.5 text-slate-700">${escapeHtml(d.customerName)} · <span class="font-mono text-slate-500">${escapeHtml(d.customerNif)}</span></td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(d.serviceBase)}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(d.serviceVat)}</td>
                          <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-slate-900">${formatKzNumber(d.estimatedIiWithholding)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- Compras a Fornecedores no Período -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">Compras e Obrigações a Fornecedores (${w.purchasesActiveCount})</h2>
          <span class="text-xs font-mono tabular-nums text-slate-600">
            Total: ${formatKzNumber(w.purchasesTotalAmount)} Kz · Pago: ${formatKzNumber(w.purchasesPaidAmount)} Kz · Por Pagar: ${formatKzNumber(w.purchasesDueAmount)} Kz
          </span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Fornecedor</th>
                <th class="text-left font-medium px-3 py-2.5">NIF</th>
                <th class="text-right font-medium px-3 py-2.5">Registos</th>
                <th class="text-right font-medium px-3 py-2.5">Total Compras</th>
                <th class="text-right font-medium px-3 py-2.5">Pago</th>
                <th class="text-right font-medium px-4 py-2.5">Em Dívida</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                w.supplierRows.length === 0
                  ? `<tr><td colspan="6" class="px-4 py-5 text-center text-slate-500">Sem compras registadas em ${escapeHtml(p.scope.labelPt)}.</td></tr>`
                  : w.supplierRows
                      .map(
                        (s) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 font-medium text-slate-800">${escapeHtml(s.supplierName)}</td>
                          <td class="px-3 py-2.5 font-mono text-slate-600">${escapeHtml(s.supplierNif)}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${s.purchaseCount}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(s.totalAmount)}</td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">${formatKzNumber(s.amountPaid)}</td>
                          <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                            s.amountDue > 0 ? 'text-amber-700' : 'text-slate-900'
                          }">${formatKzNumber(s.amountDue)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderCancelledAndRectifiedTab(p: AccountantMonthlyPackage): string {
    const cr = p.cancelledRectified;
    return `
      <!-- Resumo Anulações & Rectificações -->
      <section class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Documentos Anulados</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${cr.cancelledCount} · ${formatKzNumber(cr.cancelledGrossTotal)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            IVA anulado: ${formatKzNumber(cr.cancelledVatTotal)} Kz
          </div>
        </div>
        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Notas de Crédito (NC)</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${cr.creditNotesCount} · -${formatKzNumber(cr.creditNotesGrossTotal)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            IVA deduzido: ${formatKzNumber(cr.creditNotesVatTotal)} Kz
          </div>
        </div>
        <div class="bg-white border border-slate-200 rounded-lg p-4">
          <div class="text-xs text-slate-500">Notas de Débito (ND)</div>
          <div class="mt-1 text-lg font-bold text-slate-900 font-mono tabular-nums">
            ${cr.debitNotesCount} · +${formatKzNumber(cr.debitNotesGrossTotal)} Kz
          </div>
          <div class="mt-1 text-[11px] text-slate-500 font-mono tabular-nums">
            IVA acrescido: ${formatKzNumber(cr.debitNotesVatTotal)} Kz
          </div>
        </div>
      </section>

      <!-- Lista de Anulados -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2">
          <h2 class="text-sm font-semibold text-slate-900">Registo de Documentos Anulados (${cr.cancelledCount})</h2>
          <div class="flex items-center gap-2">
            <button type="button" data-action="export-accountant-cancelled-csv" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">CSV</button>
            <button type="button" data-action="export-accountant-cancelled-xlsx" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">Excel (.xlsx)</button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Número</th>
                <th class="text-left font-medium px-3 py-2.5">Emissão / Anulação</th>
                <th class="text-left font-medium px-3 py-2.5">Cliente</th>
                <th class="text-left font-medium px-3 py-2.5">Responsável &amp; Motivo</th>
                <th class="text-right font-medium px-3 py-2.5">IVA</th>
                <th class="text-right font-medium px-4 py-2.5">Valor Anulado</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                cr.cancelledDocs.length === 0
                  ? `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-500">Sem documentos anulados em ${escapeHtml(p.scope.labelPt)}.</td></tr>`
                  : cr.cancelledDocs
                      .map(
                        (d) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 font-mono font-semibold text-slate-900">${escapeHtml(d.number)}</td>
                          <td class="px-3 py-2.5 font-mono tabular-nums text-slate-600">
                            <div>Em.: ${d.issuedAtIso.slice(0, 10)}</div>
                            <div class="text-[11px] text-amber-700">An.: ${formatPtTimestamp(d.cancelledAtIso)}</div>
                          </td>
                          <td class="px-3 py-2.5 text-slate-700">
                            <div>${escapeHtml(d.customerName)}</div>
                            <div class="text-[11px] font-mono text-slate-500">${escapeHtml(d.customerNif)}</div>
                          </td>
                          <td class="px-3 py-2.5 text-slate-700">
                            <div class="font-medium">${escapeHtml(d.cancelledBy)}</div>
                            <div class="text-[11px] text-slate-500">${escapeHtml(d.cancelReason)}</div>
                          </td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(d.taxTotal)}</td>
                          <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold text-red-700">${formatKzNumber(d.grandTotal)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- Lista de Documentos Rectificativos -->
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="px-4 py-3 border-b border-slate-200">
          <h2 class="text-sm font-semibold text-slate-900">Documentos Rectificativos — Notas de Crédito e Débito (${cr.rectifyingDocs.length})</h2>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Número</th>
                <th class="text-left font-medium px-3 py-2.5">Data</th>
                <th class="text-left font-medium px-3 py-2.5">Doc. Origem</th>
                <th class="text-left font-medium px-3 py-2.5">Cliente</th>
                <th class="text-left font-medium px-3 py-2.5">Justificação / Operador</th>
                <th class="text-right font-medium px-3 py-2.5">Impacto IVA</th>
                <th class="text-right font-medium px-4 py-2.5">Impacto Líquido</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                cr.rectifyingDocs.length === 0
                  ? `<tr><td colspan="7" class="px-4 py-6 text-center text-slate-500">Sem notas de crédito ou débito emitidas em ${escapeHtml(p.scope.labelPt)}.</td></tr>`
                  : cr.rectifyingDocs
                      .map(
                        (d) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 font-mono font-semibold text-slate-900">${escapeHtml(d.number)}</td>
                          <td class="px-3 py-2.5 font-mono tabular-nums text-slate-600">${d.issuedAtIso.slice(0, 10)}</td>
                          <td class="px-3 py-2.5 font-mono text-slate-700">${escapeHtml(d.originNumber)}</td>
                          <td class="px-3 py-2.5 text-slate-700">${escapeHtml(d.customerName)} · <span class="font-mono text-slate-500">${escapeHtml(d.customerNif)}</span></td>
                          <td class="px-3 py-2.5 text-slate-700">
                            <div>${escapeHtml(d.notes || '---')}</div>
                            <div class="text-[11px] text-slate-500">Op.: ${escapeHtml(d.operator)}</div>
                          </td>
                          <td class="px-3 py-2.5 text-right font-mono tabular-nums">${formatKzNumber(d.taxImpact)}</td>
                          <td class="px-4 py-2.5 text-right font-mono tabular-nums font-semibold ${
                            d.grossImpact < 0 ? 'text-red-700' : 'text-slate-900'
                          }">${formatKzNumber(d.grossImpact)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderAuditHistoryTab(opts: {
    items: AccountantAuditTrailItem[];
    category: AccountantAuditCategory;
    periodMode: 'MONTH' | 'ALL';
    search: string;
    scopeLabel: string;
    canViewCostPrices: boolean;
  }): string {
    const categories: Array<{ id: AccountantAuditCategory; label: string }> = [
      { id: 'ALL', label: 'Tudo' },
      { id: 'DOCUMENTS', label: 'Documentos' },
      { id: 'PRICES_CUSTOMERS', label: 'Preços & Clientes' },
      { id: 'USERS_ROLES', label: 'Equipa & Permissões' },
      { id: 'ACCESS_SECURITY', label: 'Acessos & PIN' },
    ];

    return `
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="p-4 border-b border-slate-200 space-y-3">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 class="text-sm font-semibold text-slate-900">Histórico Consolidado de Alterações e Auditoria</h2>
              <p class="text-xs text-slate-500">
                Reúne logs de segurança, anulações, reimpressões, alterações de preços e edições de clientes (${opts.items.length} registo(s)).
              </p>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" data-action="export-accountant-audit-csv" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">CSV Auditoria</button>
              <button type="button" data-action="export-accountant-audit-xlsx" class="h-8 px-3 rounded border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 whitespace-nowrap">Excel Auditoria (.xlsx)</button>
            </div>
          </div>

          <div class="flex flex-col md:flex-row md:items-center gap-2.5">
            <input
              id="accountant-audit-search-input"
              type="text"
              value="${escapeHtml(opts.search)}"
              placeholder="Pesquisar utilizador, referência, artigo ou descrição..."
              class="flex-1 h-9 px-3 rounded-md border border-slate-300 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
            />

            <div class="flex items-center gap-1 p-0.5 bg-slate-100 rounded-md shrink-0">
              <button
                type="button"
                data-action="accountant-audit-period"
                data-value="MONTH"
                class="h-8 px-3 rounded text-xs font-medium whitespace-nowrap ${
                  opts.periodMode === 'MONTH' ? 'bg-white text-slate-900 border border-slate-200' : 'text-slate-600'
                }"
              >
                Só ${escapeHtml(opts.scopeLabel)}
              </button>
              <button
                type="button"
                data-action="accountant-audit-period"
                data-value="ALL"
                class="h-8 px-3 rounded text-xs font-medium whitespace-nowrap ${
                  opts.periodMode === 'ALL' ? 'bg-white text-slate-900 border border-slate-200' : 'text-slate-600'
                }"
              >
                Todo o Histórico
              </button>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-1.5">
            ${categories
              .map(
                (c) => `
                <button
                  type="button"
                  data-action="accountant-audit-category"
                  data-value="${c.id}"
                  class="h-8 px-3 rounded-md text-xs font-medium whitespace-nowrap ${
                    opts.category === c.id
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }"
                >
                  ${escapeHtml(c.label)}
                </button>
              `
              )
              .join('')}
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Data / Hora</th>
                <th class="text-left font-medium px-3 py-2.5">Evento</th>
                <th class="text-left font-medium px-3 py-2.5">Utilizador / Perfil</th>
                <th class="text-left font-medium px-3 py-2.5">Ref.</th>
                <th class="text-left font-medium px-4 py-2.5">Detalhe</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                opts.items.length === 0
                  ? `<tr><td colspan="5" class="px-4 py-8 text-center text-slate-500">Sem registos de auditoria para os filtros aplicados.</td></tr>`
                  : opts.items
                      .slice(0, 250)
                      .map(
                        (it) => `
                        <tr class="hover:bg-slate-50/70">
                          <td class="px-4 py-2.5 font-mono tabular-nums text-slate-600 whitespace-nowrap">${formatPtTimestamp(it.timestampIso)}</td>
                          <td class="px-3 py-2.5 whitespace-nowrap">
                            <span class="font-medium ${
                              it.outcome === 'denied' ? 'text-red-700' : 'text-slate-900'
                            }">${escapeHtml(it.actionLabel)}</span>
                            ${
                              it.outcome === 'denied'
                                ? `<span class="text-red-600 font-semibold"> · Bloqueado</span>`
                                : ''
                            }
                          </td>
                          <td class="px-3 py-2.5 text-slate-700">
                            <span class="font-medium">${escapeHtml(it.actorName)}</span>
                            <span class="text-slate-500"> · ${escapeHtml(it.actorRole)}</span>
                          </td>
                          <td class="px-3 py-2.5 font-mono text-slate-600">${escapeHtml(it.targetRef)}</td>
                          <td class="px-4 py-2.5 text-slate-700">${escapeHtml(it.summary)}</td>
                        </tr>
                      `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  function renderPortfolioTab(opts: {
    activeCompanyId: string;
    items: AuthorizedCompanyPortfolioItem[];
    totalCount: number;
    search: string;
    canManageUsers: boolean;
    isOnline: boolean;
    isSignedIn: boolean;
  }): string {
    return `
      <section class="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div class="p-4 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <h2 class="text-sm font-semibold text-slate-900">Carteira de Empresas Autorizadas (${opts.totalCount})</h2>
            <p class="text-xs text-slate-500">
              Acesso multiempresa estritamente isolado por NIF e validado pelo seu perfil de utilizador.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <input
              id="accountant-portfolio-search-input"
              type="text"
              value="${escapeHtml(opts.search)}"
              placeholder="Filtrar empresa ou NIF..."
              class="h-9 px-3 rounded-md border border-slate-300 text-xs text-slate-800 focus:outline-none focus:border-blue-600"
            />
            ${
              opts.canManageUsers
                ? `<button
                    type="button"
                    data-action="accountant-invite-shortcut"
                    class="h-9 px-3 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-xs font-medium text-slate-800 whitespace-nowrap"
                  >
                    Convidar / Gerir Contabilista
                  </button>`
                : ''
            }
          </div>
        </div>

        ${
          !opts.isSignedIn
            ? `<div class="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                Modo offline local activo: são exibidas as empresas guardadas neste terminal com acesso autorizado. Entre com Google para sincronizar convites Cloud de outros clientes.
              </div>`
            : !opts.isOnline
              ? `<div class="px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                  Ligação offline: a alternância usa os dados locais já sincronizados de cada empresa.
                </div>`
              : ''
        }

        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead class="bg-slate-50 text-slate-600 border-b border-slate-200">
              <tr>
                <th class="text-left font-medium px-4 py-2.5">Empresa</th>
                <th class="text-left font-medium px-3 py-2.5">NIF</th>
                <th class="text-left font-medium px-3 py-2.5">Enquadramento</th>
                <th class="text-left font-medium px-3 py-2.5">Seu Perfil</th>
                <th class="text-right font-medium px-3 py-2.5">Documentos</th>
                <th class="text-right font-medium px-4 py-2.5">Acção</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${
                opts.items.length === 0
                  ? `<tr><td colspan="6" class="px-4 py-8 text-center text-slate-500">Nenhuma empresa autorizada encontrada para o filtro indicado.</td></tr>`
                  : opts.items
                      .map((item) => {
                        const isCurrent = item.company.id === opts.activeCompanyId;
                        const prof = item.company.profile;
                        return `
                          <tr class="${isCurrent ? 'bg-blue-50/40' : 'hover:bg-slate-50/70'}">
                            <td class="px-4 py-3">
                              <div class="font-semibold text-slate-900">
                                ${escapeHtml(prof.shortName || prof.legalName)}
                                ${isCurrent ? '<span class="text-blue-700 font-medium"> · Activa</span>' : ''}
                              </div>
                              <div class="text-[11px] text-slate-500">${escapeHtml(prof.legalName)}</div>
                            </td>
                            <td class="px-3 py-3 font-mono tabular-nums text-slate-800">${escapeHtml(prof.nif)}</td>
                            <td class="px-3 py-3 text-slate-700">
                              <div>${escapeHtml(formatRegimePt(prof.taxRegime))}</div>
                              <div class="text-[11px] text-slate-500">
                                ${
                                  prof.accountantOcpcaNumber
                                    ? `OCPCA ${escapeHtml(prof.accountantOcpcaNumber)}`
                                    : prof.accountantName
                                      ? escapeHtml(prof.accountantName)
                                      : 'OCPCA não preenchido'
                                }
                              </div>
                            </td>
                            <td class="px-3 py-3 text-slate-700">
                              <div class="font-medium">${escapeHtml(item.viewerRoleLabelPt)}</div>
                              <div class="text-[11px] text-slate-500">${escapeHtml(item.memberDisplayName)}</div>
                            </td>
                            <td class="px-3 py-3 text-right font-mono tabular-nums text-slate-800">
                              <div>${item.invoiceCount}</div>
                              <div class="text-[11px] text-slate-500">${
                                item.lastInvoiceIso ? item.lastInvoiceIso.slice(0, 10) : '---'
                              }</div>
                            </td>
                            <td class="px-4 py-3 text-right">
                              ${
                                isCurrent
                                  ? `<span class="text-xs font-semibold text-blue-700">Em análise</span>`
                                  : `<button
                                      type="button"
                                      data-action="accountant-switch-company"
                                      data-company-id="${escapeHtml(item.company.id)}"
                                      class="h-8 px-3 rounded-md bg-slate-900 hover:bg-slate-800 text-xs font-medium text-white whitespace-nowrap"
                                    >
                                      Abrir Empresa
                                    </button>`
                              }
                            </td>
                          </tr>
                        `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>
    `;
  }
}

export function renderAccountantMonthlyDossierHtml(
  pkg: AccountantMonthlyPackage,
  company: CompanyProfile,
  showViralFooter: boolean
): string {
  const { vatReport, withholdingReport, cancelledRectified, auxiliaryMaps, saftResult, xsdReport } =
    pkg;
  const generatedAt = formatPtTimestamp(new Date().toISOString());

  return `
    <article class="a4-sheet bg-white text-slate-900 p-8 text-[11px] leading-relaxed font-sans max-w-[210mm] mx-auto">
      <header class="border-b-2 border-slate-900 pb-4 mb-5 flex justify-between items-start gap-6">
        <div>
          <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">Dossier Contabilístico Mensal</div>
          <h1 class="text-lg font-bold text-slate-900 mt-0.5">${escapeHtml(company.legalName)}</h1>
          <div class="text-xs text-slate-700 font-mono mt-1">
            NIF: ${escapeHtml(company.nif)} · ${escapeHtml(formatRegimePt(company.taxRegime))}
          </div>
          <div class="text-[11px] text-slate-600">${escapeHtml(company.address || '')} ${escapeHtml(company.cityCountry || '')}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="text-sm font-bold text-slate-900">${escapeHtml(pkg.scope.labelPt)}</div>
          <div class="font-mono text-[10px] text-slate-600">${pkg.scope.startDate} a ${pkg.scope.endDate}</div>
          <div class="text-[10px] text-slate-600 mt-1">Prazo SAF-T: ${escapeHtml(pkg.scope.submissionDeadline)}</div>
          <div class="text-[10px] font-semibold mt-1 ${xsdReport.valid ? 'text-emerald-700' : 'text-red-700'}">
            SAF-T XSD: ${xsdReport.valid ? 'CONFORME' : `${xsdReport.errors.length} ERRO(S)`}
          </div>
        </div>
      </header>

      <section class="mb-4 p-3 border border-slate-300 bg-slate-50 rounded grid grid-cols-2 gap-3 text-[10px]">
        <div>
          <span class="text-slate-500">Contabilista Certificado:</span>
          <strong class="text-slate-900 ml-1">${escapeHtml(company.accountantName || 'Não indicado')}</strong>
          ${company.accountantOcpcaNumber ? ` · OCPCA ${escapeHtml(company.accountantOcpcaNumber)}` : ''}
        </div>
        <div class="text-right font-mono">
          Ficheiro SAF-T: ${escapeHtml(saftResult.filename)}
        </div>
      </section>

      <section class="mb-5">
        <h2 class="text-xs font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">1. Apuramento de IVA do Período</h2>
        <table class="w-full border-collapse text-[10px]">
          <thead>
            <tr class="bg-slate-100 border-b border-slate-300">
              <th class="text-left p-1.5">Escalão</th>
              <th class="text-right p-1.5">Taxa</th>
              <th class="text-right p-1.5">Base Bruta</th>
              <th class="text-right p-1.5">IVA Bruto</th>
              <th class="text-right p-1.5">Dedução NC (IVA)</th>
              <th class="text-right p-1.5">Base Líquida</th>
              <th class="text-right p-1.5">IVA Líquido</th>
            </tr>
          </thead>
          <tbody>
            ${vatReport.rateLines
              .map(
                (r) => `
                <tr class="border-b border-slate-200">
                  <td class="p-1.5">${escapeHtml(r.code)} — ${escapeHtml(r.label)}</td>
                  <td class="p-1.5 text-right font-mono">${escapeHtml(r.rateLabel)}</td>
                  <td class="p-1.5 text-right font-mono">${formatKzNumber(r.grossBase)}</td>
                  <td class="p-1.5 text-right font-mono">${formatKzNumber(r.grossTax)}</td>
                  <td class="p-1.5 text-right font-mono">${formatKzNumber(r.creditNotesTax)}</td>
                  <td class="p-1.5 text-right font-mono">${formatKzNumber(r.netBase)}</td>
                  <td class="p-1.5 text-right font-mono font-semibold">${formatKzNumber(r.netTax)}</td>
                </tr>
              `
              )
              .join('')}
            <tr class="bg-slate-100 font-bold">
              <td colspan="2" class="p-1.5">Totais Consolidados</td>
              <td class="p-1.5 text-right font-mono">${formatKzNumber(vatReport.grossTaxableBase)}</td>
              <td class="p-1.5 text-right font-mono">${formatKzNumber(vatReport.grossVatTotal)}</td>
              <td class="p-1.5 text-right font-mono">${formatKzNumber(vatReport.creditNotesVat)}</td>
              <td class="p-1.5 text-right font-mono">${formatKzNumber(vatReport.netTaxableBase)}</td>
              <td class="p-1.5 text-right font-mono">${formatKzNumber(vatReport.netVatPayable)} Kz</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="mb-5 grid grid-cols-2 gap-4">
        <div>
          <h2 class="text-xs font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">2. Retenções na Fonte &amp; Compras</h2>
          <table class="w-full text-[10px]">
            <tr class="border-b border-slate-200"><td class="py-1">Base Serviços Líquida</td><td class="py-1 text-right font-mono">${formatKzNumber(withholdingReport.netServiceBase)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Estimativa Retenção II (${withholdingReport.iiRatePct}%)</td><td class="py-1 text-right font-mono font-semibold">${formatKzNumber(withholdingReport.estimatedIiTotal)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Retenção IVA (${withholdingReport.isVatRetentionAgent ? 'Agente' : 'N/A'})</td><td class="py-1 text-right font-mono">${formatKzNumber(withholdingReport.estimatedVatRetentionTotal)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Compras Activas (${withholdingReport.purchasesActiveCount})</td><td class="py-1 text-right font-mono">${formatKzNumber(withholdingReport.purchasesTotalAmount)} Kz</td></tr>
            <tr><td class="py-1">Saldo em Dívida a Fornecedores</td><td class="py-1 text-right font-mono">${formatKzNumber(withholdingReport.purchasesDueAmount)} Kz</td></tr>
          </table>
        </div>

        <div>
          <h2 class="text-xs font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">3. Anulações, Rectificações &amp; Caixa</h2>
          <table class="w-full text-[10px]">
            <tr class="border-b border-slate-200"><td class="py-1">Documentos Anulados (${cancelledRectified.cancelledCount})</td><td class="py-1 text-right font-mono">${formatKzNumber(cancelledRectified.cancelledGrossTotal)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Notas de Crédito (${cancelledRectified.creditNotesCount})</td><td class="py-1 text-right font-mono">${formatKzNumber(cancelledRectified.creditNotesGrossTotal)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Notas de Débito (${cancelledRectified.debitNotesCount})</td><td class="py-1 text-right font-mono">${formatKzNumber(cancelledRectified.debitNotesGrossTotal)} Kz</td></tr>
            <tr class="border-b border-slate-200"><td class="py-1">Sessões de Caixa Fechadas</td><td class="py-1 text-right font-mono">${auxiliaryMaps.cashClosedCount}</td></tr>
            <tr><td class="py-1">Diferença Líquida de Caixa</td><td class="py-1 text-right font-mono font-semibold">${formatKzNumber(auxiliaryMaps.cashNetDifference)} Kz</td></tr>
          </table>
        </div>
      </section>

      ${
        cancelledRectified.cancelledDocs.length > 0 || cancelledRectified.rectifyingDocs.length > 0
          ? `<section class="mb-6">
              <h2 class="text-xs font-bold text-slate-900 border-b border-slate-300 pb-1 mb-2">4. Detalhe de Anulações e Rectificações</h2>
              <table class="w-full border-collapse text-[9.5px]">
                <thead>
                  <tr class="bg-slate-100 border-b border-slate-300">
                    <th class="text-left p-1">Documento</th>
                    <th class="text-left p-1">Natureza</th>
                    <th class="text-left p-1">Cliente</th>
                    <th class="text-left p-1">Motivo / Origem</th>
                    <th class="text-right p-1">Valor (Kz)</th>
                  </tr>
                </thead>
                <tbody>
                  ${cancelledRectified.cancelledDocs
                    .slice(0, 15)
                    .map(
                      (d) => `
                      <tr class="border-b border-slate-200">
                        <td class="p-1 font-mono">${escapeHtml(d.number)}</td>
                        <td class="p-1">Anulado (${escapeHtml(d.cancelledBy)})</td>
                        <td class="p-1">${escapeHtml(d.customerName)}</td>
                        <td class="p-1">${escapeHtml(d.cancelReason)}</td>
                        <td class="p-1 text-right font-mono">${formatKzNumber(d.grandTotal)}</td>
                      </tr>
                    `
                    )
                    .join('')}
                  ${cancelledRectified.rectifyingDocs
                    .slice(0, 15)
                    .map(
                      (d) => `
                      <tr class="border-b border-slate-200">
                        <td class="p-1 font-mono">${escapeHtml(d.number)}</td>
                        <td class="p-1">${escapeHtml(formatDocumentTypeLabelPt(d.docType))}</td>
                        <td class="p-1">${escapeHtml(d.customerName)}</td>
                        <td class="p-1">Orig.: ${escapeHtml(d.originNumber)} ${d.notes ? `· ${escapeHtml(d.notes)}` : ''}</td>
                        <td class="p-1 text-right font-mono">${formatKzNumber(d.grossImpact)}</td>
                      </tr>
                    `
                    )
                    .join('')}
                </tbody>
              </table>
            </section>`
          : ''
      }

      <footer class="pt-6 border-t border-slate-300 grid grid-cols-2 gap-8 text-center text-[10px]">
        <div>
          <div class="border-b border-slate-400 h-10 mb-1"></div>
          <div class="font-semibold text-slate-800">O Contabilista Certificado</div>
          <div class="text-slate-500">${escapeHtml(company.accountantName || 'OCPCA')}</div>
        </div>
        <div>
          <div class="border-b border-slate-400 h-10 mb-1"></div>
          <div class="font-semibold text-slate-800">A Gerência / Administração</div>
          <div class="text-slate-500">${escapeHtml(company.legalRepresentativeName || company.shortName)}</div>
        </div>
      </footer>

      <div class="mt-4 text-[9px] text-slate-500 flex justify-between">
        <span>Gerado em ${generatedAt}</span>
        ${showViralFooter ? '<span>Emitido por SILA-Billing</span>' : '<span>Fecho Contabilístico SILA-Billing</span>'}
      </div>
    </article>
  `;
}
