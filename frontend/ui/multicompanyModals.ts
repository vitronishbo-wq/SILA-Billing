import { formatDateTimePt } from '../../src/core/billingEngine';
import {
  CompanyOperationalStatus,
  CompanyRecord,
  CompanyRole,
  GrowthTriggerReason,
  InvoiceRecord,
  PlanTier,
  VITRONIS_INSTITUTIONAL,
} from '../../src/core/types';
import type { AdminAuditEntry, AdminCompanySummary } from '../services/backendApi';
import { ICONS } from './icons';

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatRoleLabelPt(role: CompanyRole): string {
  if (role === 'owner') return 'Proprietário';
  if (role === 'manager') return 'Gerente';
  return 'Operador de Caixa';
}

export function formatPlanLabelPt(plan: PlanTier): string {
  switch (plan) {
    case 'ESSENCIAL':
      return 'Essencial (Local Ilimitado)';
    case 'PROFISSIONAL':
      return 'Cloud Profissional';
    case 'ENTERPRISE':
      return 'Enterprise';
    default:
      return 'Base Orgânico';
  }
}

export function renderCompanySwitcherDropdown(params: {
  activeCompany: CompanyRecord;
  companies: CompanyRecord[];
  effectiveRole: CompanyRole;
}): string {
  const { activeCompany, companies, effectiveRole } = params;

  return `
    <div class="absolute left-1/2 -translate-x-1/2 top-11 z-40 w-80 bg-white text-slate-900 rounded-lg border border-slate-200 shadow-lg overflow-hidden">
      <div class="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-[11px] text-slate-500">
        <span>Empresas registadas (${companies.length})</span>
        <span>${escapeHtml(formatRoleLabelPt(effectiveRole))}</span>
      </div>

      <div class="max-h-64 overflow-y-auto divide-y divide-slate-100">
        ${
          companies.length === 0
            ? `<div class="px-3 py-5 text-center text-xs text-slate-500">
                Nenhuma empresa associada a esta sessão. Cadastre a sua empresa abaixo para iniciar a faturação.
              </div>`
            : companies
                .map((comp) => {
                  const isActive = comp.id === activeCompany.id;
                  const isSuspended = comp.status === 'suspended';
                  return `
                    <button
                      type="button"
                      data-action="switch-company"
                      data-id="${escapeHtml(comp.id)}"
                      class="w-full px-3 py-2.5 text-left flex items-center justify-between gap-2 transition-colors ${
                        isActive ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                      }"
                    >
                      <div class="min-w-0">
                        <div class="flex items-center gap-1.5 text-xs font-semibold text-slate-900 truncate">
                          <span class="truncate">${escapeHtml(comp.profile.shortName)}</span>
                          ${
                            isSuspended
                              ? `<span class="text-[10px] text-red-600 font-medium shrink-0">· Suspensa</span>`
                              : ''
                          }
                        </div>
                        <div class="text-[10.5px] font-mono text-slate-500 tabular-nums truncate">
                          NIF ${escapeHtml(comp.profile.nif)} · ${escapeHtml(comp.profile.cityCountry)}
                        </div>
                      </div>
                      ${
                        isActive
                          ? `<span class="text-blue-600 shrink-0">${ICONS.check}</span>`
                          : ''
                      }
                    </button>
                  `;
                })
                .join('')
        }
      </div>

      <div class="p-2 bg-slate-50 border-t border-slate-200">
        <button
          type="button"
          data-action="open-new-company-modal"
          class="w-full h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap"
        >
          ${ICONS.plus}
          <span>Cadastrar nova empresa</span>
        </button>
      </div>
    </div>
  `;
}

export function renderNewCompanyModal(params: {
  errorMessage: string | null;
  isSubmitting: boolean;
  isSignedIn: boolean;
}): string {
  const { errorMessage, isSubmitting, isSignedIn } = params;

  return `
    <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-md overflow-hidden shadow-xl">
        <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 class="text-sm font-bold text-slate-900">Cadastrar Nova Empresa</h2>
            <p class="text-[11px] text-slate-500">Registo simplificado · 1 NIF cria apenas 1 empresa no sistema.</p>
          </div>
          <button
            type="button"
            data-action="close-new-company-modal"
            class="h-8 w-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >${ICONS.close}</button>
        </div>

        <form data-form="new-company-form" class="p-4 space-y-3">
          ${
            errorMessage
              ? `<div class="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(errorMessage)}</div>`
              : ''
          }

          <div>
            <label class="block text-[11px] font-medium text-slate-700 mb-1">Designação Social *</label>
            <input
              name="legalName"
              type="text"
              required
              maxlength="160"
              placeholder="Ex: Kiala Comercial, Lda"
              class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <div>
              <label class="block text-[11px] font-medium text-slate-700 mb-1">Nome Curto / Marca *</label>
              <input
                name="shortName"
                type="text"
                required
                maxlength="64"
                placeholder="Ex: KIALA"
                class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label class="block text-[11px] font-medium text-slate-700 mb-1">NIF Empresarial (Único) *</label>
              <input
                name="nif"
                type="text"
                required
                maxlength="20"
                placeholder="Ex: 5401122330"
                class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <div>
              <label class="block text-[11px] font-medium text-slate-700 mb-1">Cidade / Província</label>
              <input
                name="cityCountry"
                type="text"
                maxlength="80"
                value="Luanda - Angola"
                class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label class="block text-[11px] font-medium text-slate-700 mb-1">Telefone</label>
              <input
                name="phone"
                type="text"
                maxlength="40"
                placeholder="(+244) 9..."
                class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <label class="block text-[11px] font-medium text-slate-700 mb-1">Endereço Fiscal</label>
            <input
              name="address"
              type="text"
              maxlength="160"
              placeholder="Rua / Bairro / Município"
              class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>

          <label class="flex items-center gap-2 pt-1 text-xs text-slate-600 cursor-pointer select-none">
            <input
              name="copyStarterCatalog"
              type="checkbox"
              class="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span>Incluir artigos base de demonstração (desmarcado inicia catálogo limpo)</span>
          </label>

          <label class="flex items-start gap-2 pt-2 border-t border-slate-100 text-[11px] text-slate-600 leading-snug cursor-pointer select-none">
            <input
              name="acceptTerms"
              type="checkbox"
              required
              checked
              class="h-4 w-4 mt-0.5 rounded border-slate-300 text-blue-600 shrink-0"
            />
            <span>
              Declaro aceitar as condições operacionais do <strong>SILA-Billing</strong>, dependência institucional de <strong>${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}</strong> (NIF ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}), assumindo responsabilidade pelos dados emitidos.
            </span>
          </label>

          <div class="text-[11px] text-slate-500 pt-1">
            Numeração própria iniciada em <span class="font-mono tabular-nums font-semibold">000001</span> · Armazenamento autónomo neste dispositivo${
              isSignedIn ? ' · Identidade empresarial vinculada' : ''
            }.
          </div>

          <div class="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              data-action="close-new-company-modal"
              class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
            >Cancelar</button>
            <button
              type="submit"
              ${isSubmitting ? 'disabled' : ''}
              class="h-9 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
            >${isSubmitting ? 'A validar NIF...' : 'Criar empresa'}</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

export function renderCancelInvoiceModal(params: {
  invoice: InvoiceRecord;
  errorMessage: string | null;
}): string {
  const { invoice, errorMessage } = params;

  return `
    <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-sm overflow-hidden shadow-xl">
        <div class="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 class="text-sm font-bold text-slate-900">Anular Documento Emitido</h2>
            <p class="text-[11px] font-mono text-slate-500 tabular-nums">${escapeHtml(invoice.number)} · ${escapeHtml(invoice.customerName)}</p>
          </div>
          <button
            type="button"
            data-action="close-cancel-invoice-modal"
            class="h-8 w-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >${ICONS.close}</button>
        </div>

        <form data-form="cancel-invoice-form" class="p-4 space-y-3">
          <input type="hidden" name="invoiceId" value="${escapeHtml(invoice.id)}" />

          ${
            errorMessage
              ? `<div class="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(errorMessage)}</div>`
              : ''
          }

          <div>
            <label class="block text-[11px] font-medium text-slate-700 mb-1">Motivo / Justificação de Anulação *</label>
            <textarea
              name="cancelReason"
              required
              minlength="4"
              maxlength="240"
              rows="3"
              placeholder="Ex: Erro no NIF do cliente ou devolução imediata no balcão..."
              class="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-red-600 resize-none"
            ></textarea>
            <p class="text-[10.5px] text-slate-400 mt-1">Esta operação é irreversível e fica registada para auditoria.</p>
          </div>

          <div class="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              data-action="close-cancel-invoice-modal"
              class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
            >Voltar</button>
            <button
              type="submit"
              class="h-9 px-3.5 rounded-lg bg-red-600 text-white text-xs font-semibold hover:bg-red-700 whitespace-nowrap"
            >Confirmar anulação</button>
          </div>
        </form>
      </div>
    </div>
  `;
}

export function renderMasterAdminModal(params: {
  isSignedIn: boolean;
  isAuthenticating?: boolean;
  userEmail: string;
  isLoading: boolean;
  accessDenied: boolean;
  errorMessage: string | null;
  searchQuery: string;
  mergedCompanies: AdminCompanySummary[];
  recentLogs: AdminAuditEntry[];
  activeCompanyId: string;
}): string {
  const {
    isSignedIn,
    isAuthenticating = false,
    userEmail,
    isLoading,
    accessDenied,
    errorMessage,
    searchQuery,
    mergedCompanies,
    recentLogs,
    activeCompanyId,
  } = params;

  const q = searchQuery.trim().toLowerCase();
  const visibleCompanies = mergedCompanies.filter(
    (c) =>
      !q ||
      c.shortName.toLowerCase().includes(q) ||
      c.legalName.toLowerCase().includes(q) ||
      c.nif.toLowerCase().includes(q) ||
      c.ownerEmail.toLowerCase().includes(q)
  );

  const activeCount = mergedCompanies.filter((c) => c.status === 'active').length;
  const suspendedCount = mergedCompanies.filter((c) => c.status === 'suspended').length;

  return `
    <div class="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-3 sm:p-6">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden shadow-2xl">
        <!-- Cabeçalho Ultraminimalista do Painel Master -->
        <div class="px-5 py-3.5 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div class="min-w-0">
            <h2 class="text-sm font-bold tracking-tight">Painel Master SILA-Billing</h2>
            <p class="text-[11px] text-slate-400 truncate">
              Governança Multiempresa · ${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}${
                isSignedIn ? ` · ${escapeHtml(userEmail)}` : ''
              }
            </p>
          </div>
          <button
            type="button"
            data-action="close-master-admin"
            class="h-8 px-3 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            ${ICONS.close}
            <span>Voltar à faturação</span>
          </button>
        </div>

        <div class="flex-1 overflow-y-auto p-5 space-y-5">
          ${
            !isSignedIn
              ? `
              <div class="py-10 max-w-md mx-auto text-center space-y-4">
                <div class="text-sm font-bold text-slate-900">Autenticação Administrativa Verificada</div>
                <p class="text-xs text-slate-600 leading-relaxed">
                  O Painel Master utiliza autenticação real com validação no servidor e nas regras do Firestore, sem chaves fixas expostas no navegador.
                </p>
                ${
                  errorMessage
                    ? `<div class="p-3 rounded-lg border border-amber-300 bg-amber-50 text-left text-xs text-amber-900 leading-relaxed">${escapeHtml(errorMessage)}</div>`
                    : ''
                }
                <button
                  type="button"
                  data-action="master-admin-signin"
                  ${isAuthenticating ? 'disabled' : ''}
                  class="h-10 px-5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap"
                >${isAuthenticating ? 'A abrir autenticação Google...' : 'Autenticar Administrador Google'}</button>
              </div>
            `
              : isLoading
                ? `
              <div class="space-y-3 py-8">
                <div class="h-10 bg-slate-100 rounded-lg animate-pulse"></div>
                <div class="h-12 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-12 bg-slate-50 rounded-lg animate-pulse"></div>
              </div>
            `
                : accessDenied
                  ? `
              <div class="py-12 max-w-md mx-auto text-center space-y-3">
                <div class="text-sm font-bold text-red-700">Acesso Restrito à Administração Global</div>
                <p class="text-xs text-slate-600 leading-relaxed">
                  A conta autenticada (<strong>${escapeHtml(userEmail)}</strong>) não consta na lista de administradores globais da plataforma SILA-Billing.
                </p>
                <div class="flex items-center justify-center gap-2 pt-2">
                  <button
                    type="button"
                    data-action="signout-google"
                    class="h-9 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >Trocar de conta</button>
                  <button
                    type="button"
                    data-action="close-master-admin"
                    class="h-9 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800"
                  >Fechar</button>
                </div>
              </div>
            `
                  : `
              ${
                errorMessage
                  ? `<div class="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">${escapeHtml(errorMessage)}</div>`
                  : ''
              }

              <!-- Resumo Quantitativo Limpo -->
              <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
                <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div class="text-[11px] text-slate-500">Empresas registadas</div>
                  <div class="text-lg font-bold font-mono text-slate-900 mt-0.5">${mergedCompanies.length}</div>
                </div>
                <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div class="text-[11px] text-slate-500">Operação ativa</div>
                  <div class="text-lg font-bold font-mono text-emerald-700 mt-0.5">${activeCount}</div>
                </div>
                <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div class="text-[11px] text-slate-500">Suspensas</div>
                  <div class="text-lg font-bold font-mono text-slate-700 mt-0.5">${suspendedCount}</div>
                </div>
                <div class="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div class="text-[11px] text-slate-500">Planos comerciais ativos</div>
                  <div class="text-lg font-bold font-mono text-blue-700 mt-0.5">${mergedCompanies.filter((c) => c.planTier !== 'FREE').length}</div>
                </div>
              </div>

              <!-- Pesquisa e Atualização -->
              <div class="flex items-center justify-between gap-2">
                <div class="relative flex-1 max-w-md">
                  <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                  <input
                    id="master-admin-search-input"
                    type="text"
                    data-field="master-admin-search"
                    value="${escapeHtml(searchQuery)}"
                    placeholder="Filtrar empresa por nome, NIF único ou email..."
                    class="w-full h-9 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <button
                  type="button"
                  data-action="refresh-master-admin"
                  class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.refresh}
                  <span>Atualizar lista</span>
                </button>
              </div>

              <!-- Tabela Densa de Empresas -->
              <div class="border border-slate-200 rounded-lg overflow-x-auto">
                <table class="w-full text-left border-collapse text-xs">
                  <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                    <tr>
                      <th class="py-2.5 px-3 font-medium">Empresa</th>
                      <th class="py-2.5 px-3 font-medium">NIF Único</th>
                      <th class="py-2.5 px-3 font-medium hidden md:table-cell">Registo</th>
                      <th class="py-2.5 px-3 font-medium text-right">Faturas</th>
                      <th class="py-2.5 px-3 font-medium">Plano Comercial</th>
                      <th class="py-2.5 px-3 font-medium">Estado</th>
                      <th class="py-2.5 px-3 font-medium text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 tabular-nums">
                    ${
                      visibleCompanies.length === 0
                        ? `<tr><td colspan="7" class="py-6 text-center text-slate-500">Nenhuma empresa encontrada.</td></tr>`
                        : visibleCompanies
                            .map((comp) => {
                              const dt = formatDateTimePt(comp.createdAtIso);
                              const isCurrent = comp.id === activeCompanyId;
                              const isSusp = comp.status === 'suspended';
                              const nextStatus: CompanyOperationalStatus = isSusp ? 'active' : 'suspended';

                              return `
                                <tr class="${isCurrent ? 'bg-blue-50/40' : 'hover:bg-slate-50/70'}">
                                  <td class="py-2.5 px-3">
                                    <div class="font-semibold text-slate-900">${escapeHtml(comp.shortName)}</div>
                                    <div class="text-[10.5px] text-slate-500 truncate max-w-[220px]">${escapeHtml(comp.legalName)}</div>
                                  </td>
                                  <td class="py-2.5 px-3 font-mono text-slate-700">${escapeHtml(comp.nif)}</td>
                                  <td class="py-2.5 px-3 text-slate-500 hidden md:table-cell">${dt.slashDate}</td>
                                  <td class="py-2.5 px-3 text-right font-mono font-semibold text-slate-900">${comp.invoiceCount}</td>
                                  <td class="py-2.5 px-3">
                                    <select
                                      data-field="admin-company-plan"
                                      data-id="${escapeHtml(comp.id)}"
                                      aria-label="Plano comercial"
                                      class="h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                    >
                                      ${(['FREE', 'ESSENCIAL', 'PROFISSIONAL', 'ENTERPRISE'] as PlanTier[])
                                        .map((tier) => {
                                          const label =
                                            tier === 'ESSENCIAL'
                                              ? 'Essencial (1.000 Kz)'
                                              : formatPlanLabelPt(tier);
                                          return `<option value="${tier}" ${comp.planTier === tier ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                                        })
                                        .join('')}
                                    </select>
                                  </td>
                                  <td class="py-2.5 px-3">
                                    <span class="font-medium ${isSusp ? 'text-red-700' : 'text-emerald-700'}">
                                      ${isSusp ? 'Suspensa' : 'Ativa'}
                                    </span>
                                  </td>
                                  <td class="py-2.5 px-3 text-right">
                                    <div class="inline-flex items-center gap-1.5">
                                      <button
                                        type="button"
                                        data-action="admin-toggle-company-status"
                                        data-id="${escapeHtml(comp.id)}"
                                        data-value="${nextStatus}"
                                        class="h-8 px-2.5 rounded-md border border-slate-200 text-[11px] font-medium ${
                                          isSusp
                                            ? 'text-emerald-700 hover:bg-emerald-50'
                                            : 'text-red-600 hover:bg-red-50'
                                        } whitespace-nowrap"
                                      >${isSusp ? 'Reativar' : 'Suspender'}</button>
                                      <button
                                        type="button"
                                        data-action="admin-support-switch"
                                        data-id="${escapeHtml(comp.id)}"
                                        class="h-8 px-2.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 whitespace-nowrap"
                                      >${isCurrent ? 'Em uso' : 'Suporte'}</button>
                                    </div>
                                  </td>
                                </tr>
                              `;
                            })
                            .join('')
                    }
                  </tbody>
                </table>
              </div>

              ${
                recentLogs.length > 0
                  ? `
                  <div class="space-y-2 pt-2">
                    <h3 class="text-xs font-semibold text-slate-900">Registo Recente de Auditoria Master</h3>
                    <div class="border border-slate-200 rounded-lg divide-y divide-slate-100 text-[11px]">
                      ${recentLogs
                        .slice(0, 8)
                        .map((log) => {
                          const ldt = formatDateTimePt(log.createdAtIso);
                          return `
                            <div class="px-3 py-2 flex items-center justify-between gap-3">
                              <div class="min-w-0 truncate text-slate-700">
                                <span class="font-semibold text-slate-900">${escapeHtml(log.companyName)}</span>
                                <span class="text-slate-400"> · </span>
                                <span>${escapeHtml(log.details || log.action)}</span>
                              </div>
                              <div class="font-mono text-slate-400 shrink-0 tabular-nums">${ldt.slashDate} ${ldt.time}</div>
                            </div>
                          `;
                        })
                        .join('')}
                    </div>
                  </div>
                `
                  : ''
              }
            `
          }
        </div>
      </div>
    </div>
  `;
}

export function renderTenantOnboardingView(params: {
  userEmail: string;
  isSignedIn: boolean;
  isOnline: boolean;
  isSyncing: boolean;
  syncMessage: string | null;
}): string {
  const { userEmail, isSignedIn, isOnline, isSyncing, syncMessage } = params;

  return `
    <div class="h-full overflow-y-auto bg-slate-50 p-4 sm:p-8 flex items-center justify-center">
      <div class="w-full max-w-xl bg-white border border-slate-200 rounded-xl p-6 sm:p-8 space-y-6">
        <div class="space-y-2">
          <div class="text-[11px] font-bold tracking-wide text-blue-600 uppercase">SILA-Billing · Plataforma Multiempresa</div>
          <h1 class="text-lg font-bold text-slate-900 tracking-tight">Cadastre ou sincronize a sua empresa</h1>
          <p class="text-xs text-slate-600 leading-relaxed">
            ${
              isSignedIn
                ? `A conta autenticada (<strong>${escapeHtml(userEmail)}</strong>) ainda não tem nenhuma empresa associada neste terminal. Crie a sua empresa com isolamento próprio ou sincronize empresas já registadas na Cloud.`
                : 'Inicie o seu espaço empresarial isolado para emitir faturas térmicas POS 80mm e A4 com numeração própria.'
            }
          </p>
        </div>

        ${
          syncMessage
            ? `<div class="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">${escapeHtml(syncMessage)}</div>`
            : ''
        }

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs border-y border-slate-100 py-4 tabular-nums">
          <div class="space-y-0.5">
            <div class="font-semibold text-slate-900">1 NIF = 1 Empresa</div>
            <div class="text-[11px] text-slate-500">Contribuinte único validado localmente e na Cloud.</div>
          </div>
          <div class="space-y-0.5">
            <div class="font-semibold text-slate-900">Série 000001</div>
            <div class="text-[11px] text-slate-500">Numeração, clientes e catálogo 100% isolados.</div>
          </div>
          <div class="space-y-0.5">
            <div class="font-semibold text-slate-900">POS 80mm &amp; A4</div>
            <div class="text-[11px] text-slate-500">Operação imediata offline-first e sincronização segura.</div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            data-action="open-new-company-modal"
            class="h-10 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
          >
            ${ICONS.plus}
            <span>Cadastrar Nova Empresa</span>
          </button>

          ${
            isSignedIn
              ? `<button
                  type="button"
                  data-action="sync-now"
                  ${!isOnline || isSyncing ? 'disabled' : ''}
                  class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.refresh}
                  <span>${isSyncing ? 'A procurar na Cloud...' : 'Procurar empresas na Cloud'}</span>
                </button>
                <button
                  type="button"
                  data-action="signout-google"
                  class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                >Trocar de conta</button>`
              : `<button
                  type="button"
                  data-action="signin-google"
                  ${!isOnline ? 'disabled' : ''}
                  class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 whitespace-nowrap"
                >Já tenho empresa na Cloud (Entrar)</button>`
          }
        </div>

        <div class="pt-3 border-t border-slate-100 text-[11px] text-slate-400 leading-relaxed">
          SILA-Billing · Dependência institucional de <span class="text-slate-600 font-medium">${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}</span> · Cidade-Alta, ${escapeHtml(VITRONIS_INSTITUTIONAL.city)} · ${escapeHtml(VITRONIS_INSTITUTIONAL.website)}
        </div>
      </div>
    </div>
  `;
}

export function renderFriendlyGrowthModal(params: {
  reason: GrowthTriggerReason;
  company: CompanyRecord;
  monthlyUsed: number;
  monthlyLimit: number;
  canActivateCourtesy: boolean;
  isSignedIn: boolean;
  isOnline: boolean;
  isVerifyingPlan: boolean;
  copiedIbanFeedback: boolean;
  noticeMessage: string | null;
}): string {
  const {
    reason,
    company,
    monthlyUsed,
    monthlyLimit,
    canActivateCourtesy,
    isSignedIn,
    isOnline,
    isVerifyingPlan,
    copiedIbanFeedback,
    noticeMessage,
  } = params;

  let kicker = 'Crescimento Empresarial SILA-Billing';
  let headline = `Parabéns pelo movimento da ${company.profile.shortName}`;
  let lead =
    'A sua operação superou o ciclo mensal orgânico. Desbloqueie emissão local ilimitada ou proteção automática na Cloud com ativação institucional imediata.';

  if (reason === 'monthly_limit') {
    kicker = 'Volume Mensal Atingido';
    headline = `Excelente ritmo comercial na ${company.profile.shortName}`;
    lead = `Emitiu ${monthlyUsed} de ${monthlyLimit} documentos incluídos neste mês neste terminal. Para continuar a faturar sem limites todos os meses e emitir documentos sem rodapé promocional, ative o Plano Essencial por apenas 1.000 Kz/mês.`;
  } else if (reason === 'cloud_protection') {
    kicker = 'Proteção e Continuidade na Cloud';
    headline = `Proteja o histórico da ${company.profile.shortName} na nuvem`;
    lead =
      'O armazenamento local no dispositivo funciona a custo zero. Para sincronizar automaticamente faturas, catálogo e clientes na Cloud contra perda ou avaria de equipamento, ative o Plano Cloud Profissional.';
  } else if (reason === 'clean_footer') {
    kicker = 'Identidade Corporativa Limpa';
    headline = 'Documentos exclusivos com a marca da sua empresa';
    lead =
      'A ocultação da assinatura institucional no rodapé dos talões POS 80mm e faturas A4 fica disponível automaticamente a partir do Plano Essencial (1.000 Kz/mês).';
  } else if (reason === 'team_access') {
    kicker = 'Operação Multi-Operador';
    headline = 'Equipa sincronizada com Gerentes e Operadores de Caixa';
    lead =
      'A adição de múltiplos colaboradores autenticados e sincronização entre terminais faz parte do Plano Cloud Profissional.';
  }

  const waText = encodeURIComponent(
    `Olá VITRONIS! Pretendo ativar o plano comercial no SILA-Billing para a empresa ${company.profile.shortName} (NIF: ${company.profile.nif}). Segue comprovativo.`
  );
  const waHref = `https://wa.me/${VITRONIS_INSTITUTIONAL.whatsappDigits}?text=${waText}`;

  return `
    <div class="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-3 sm:p-5">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden shadow-2xl">
        <div class="px-5 py-4 border-b border-slate-200 flex items-start justify-between gap-4 shrink-0">
          <div class="space-y-1 min-w-0">
            <div class="text-[11px] font-semibold text-blue-600">${escapeHtml(kicker)}</div>
            <h2 class="text-base font-bold text-slate-900 tracking-tight">${escapeHtml(headline)}</h2>
            <p class="text-xs text-slate-600 leading-relaxed">${escapeHtml(lead)}</p>
          </div>
          <button
            type="button"
            data-action="close-growth-modal"
            aria-label="Fechar"
            class="h-8 w-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          >${ICONS.close}</button>
        </div>

        <div class="flex-1 overflow-y-auto p-5 space-y-4">
          ${
            noticeMessage
              ? `<div class="p-3 rounded-lg border border-blue-200 bg-blue-50 text-xs text-blue-900 leading-relaxed">${escapeHtml(noticeMessage)}</div>`
              : ''
          }

          ${
            reason === 'monthly_limit' && canActivateCourtesy
              ? `<div class="p-3.5 rounded-lg border border-emerald-200 bg-emerald-50/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div class="text-xs text-emerald-950 leading-snug">
                    <span class="font-semibold">Está com cliente no balcão agora?</span>
                    Liberamos de imediato +10 documentos de cortesia neste mês para não interromper o seu atendimento.
                  </div>
                  <button
                    type="button"
                    data-action="activate-monthly-courtesy"
                    class="h-9 px-3.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold whitespace-nowrap shrink-0 transition-colors"
                  >Liberar +10 documentos agora</button>
                </div>`
              : ''
          }

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div class="p-4 rounded-lg border ${
              reason === 'monthly_limit' || reason === 'clean_footer'
                ? 'border-blue-600 bg-blue-50/30'
                : 'border-slate-200 bg-slate-50/60'
            } flex flex-col justify-between space-y-3">
              <div class="space-y-1.5">
                <div class="flex items-baseline justify-between gap-2">
                  <h3 class="text-xs font-bold text-slate-900">Plano Essencial</h3>
                  <span class="text-sm font-bold font-mono text-slate-900 tabular-nums">1.000 Kz <span class="text-[11px] font-normal text-slate-500">/ mês</span></span>
                </div>
                <p class="text-[11px] text-slate-600 leading-relaxed">
                  Ideal para comércio, serviços e retalho com operação 100% local neste dispositivo.
                </p>
                <ul class="space-y-1 text-[11px] text-slate-700 pt-1">
                  <li class="flex items-center gap-1.5"><span class="text-emerald-600">${ICONS.check}</span><span>Faturas POS 80mm e A4 ilimitadas</span></li>
                  <li class="flex items-center gap-1.5"><span class="text-emerald-600">${ICONS.check}</span><span>Documentos limpos sem rodapé promocional</span></li>
                  <li class="flex items-center gap-1.5"><span class="text-emerald-600">${ICONS.check}</span><span>Funcionamento 100% autónomo offline</span></li>
                </ul>
              </div>
            </div>

            <div class="p-4 rounded-lg border ${
              reason === 'cloud_protection' || reason === 'team_access'
                ? 'border-blue-600 bg-blue-50/30'
                : 'border-slate-200 bg-slate-50/60'
            } flex flex-col justify-between space-y-3">
              <div class="space-y-1.5">
                <div class="flex items-baseline justify-between gap-2">
                  <h3 class="text-xs font-bold text-slate-900">Plano Cloud Profissional</h3>
                  <span class="text-xs font-semibold text-blue-700">Sob consulta corporativa</span>
                </div>
                <p class="text-[11px] text-slate-600 leading-relaxed">
                  Para empresas que exigem salvaguarda automática na nuvem e equipa multi-operador.
                </p>
                <ul class="space-y-1 text-[11px] text-slate-700 pt-1">
                  <li class="flex items-center gap-1.5"><span class="text-blue-600">${ICONS.check}</span><span>Tudo do Plano Essencial incluído</span></li>
                  <li class="flex items-center gap-1.5"><span class="text-blue-600">${ICONS.check}</span><span>Sincronização e Backup Cloud automático</span></li>
                  <li class="flex items-center gap-1.5"><span class="text-blue-600">${ICONS.check}</span><span>Equipa com Gerentes e Operadores de Caixa</span></li>
                </ul>
              </div>
            </div>
          </div>

          <!-- Dados Institucionais VITRONIS para Ativação Rápida -->
          <div class="p-4 rounded-lg border border-slate-200 bg-slate-50 space-y-2.5 text-xs">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
              <div class="font-bold text-slate-900">${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}</div>
              <div class="font-mono text-[11px] text-slate-600 tabular-nums">Contribuinte: ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}</div>
            </div>
            <div class="text-[11px] text-slate-500">
              ${escapeHtml(VITRONIS_INSTITUTIONAL.address)} · Tel: ${escapeHtml(VITRONIS_INSTITUTIONAL.phone)} · ${escapeHtml(VITRONIS_INSTITUTIONAL.email)}
            </div>

            <div class="pt-2 border-t border-slate-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div class="min-w-0">
                <div class="text-[10.5px] text-slate-500">Coordenada Bancária Oficial (IBAN BAI)</div>
                <div class="font-mono font-bold text-xs text-slate-900 tabular-nums select-all break-all">${escapeHtml(VITRONIS_INSTITUTIONAL.ibanBai)}</div>
              </div>
              <button
                type="button"
                data-action="copy-vitronis-iban"
                class="h-8 px-3 rounded-md border border-slate-200 bg-white hover:bg-slate-100 text-xs font-medium text-slate-800 flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
              >
                ${copiedIbanFeedback ? ICONS.check : ICONS.copy}
                <span>${copiedIbanFeedback ? 'IBAN copiado' : 'Copiar IBAN'}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div class="flex flex-wrap items-center gap-2">
            <a
              href="${waHref}"
              target="_blank"
              rel="noopener noreferrer"
              class="h-9 px-3.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
            >
              ${ICONS.externalLink}
              <span>Enviar comprovativo no WhatsApp</span>
            </a>

            ${
              isSignedIn
                ? `<button
                    type="button"
                    data-action="verify-plan-activation"
                    ${!isOnline || isVerifyingPlan ? 'disabled' : ''}
                    class="h-9 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-medium text-slate-700 disabled:opacity-40 inline-flex items-center gap-1.5 whitespace-nowrap transition-colors"
                  >
                    ${ICONS.refresh}
                    <span>${isVerifyingPlan ? 'A verificar licença...' : 'Já ativei — Atualizar licença'}</span>
                  </button>`
                : `<button
                    type="button"
                    data-action="signin-google"
                    ${!isOnline ? 'disabled' : ''}
                    class="h-9 px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-medium text-slate-700 disabled:opacity-40 whitespace-nowrap transition-colors"
                  >Autenticar conta para sincronizar licença</button>`
            }
          </div>

          <button
            type="button"
            data-action="close-growth-modal"
            class="h-9 px-3 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-200/60 whitespace-nowrap"
          >Voltar</button>
        </div>
      </div>
    </div>
  `;
}
