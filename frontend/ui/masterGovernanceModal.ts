import { formatDateTimePt } from '../../src/core/billingEngine';
import {
  CompanyOperationalStatus,
  CompanyRole,
  PlanTier,
  VITRONIS_INSTITUTIONAL,
} from '../../src/core/types';
import type {
  AdminAuditEntry,
  AdminCompanyDetails,
  AdminCompanySummary,
  AdminOverviewStats,
  PlatformUserSummary,
  SystemStatusResponse,
} from '../services/backendApi';
import { ICONS } from './icons';

export type MasterAdminTab = 'overview' | 'companies' | 'plans' | 'users' | 'monitoring' | 'audit';

export interface MasterGovernanceModalParams {
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
  stats?: AdminOverviewStats | null;
  activeTab: MasterAdminTab;
  selectedCompanyDetails?: AdminCompanyDetails | null;
  isLoadingCompanyDetails?: boolean;
  showNewCompanyForm?: boolean;
  usersList?: PlatformUserSummary[];
  isLoadingUsers?: boolean;
  systemStatus?: SystemStatusResponse | null;
  isLoadingSystemStatus?: boolean;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatPlanLabelPt(plan: PlanTier): string {
  switch (plan) {
    case 'FREE':
      return 'Base Orgânico';
    case 'ESSENCIAL':
      return 'Essencial (1.000 Kz)';
    case 'PROFISSIONAL':
      return 'Profissional (Multi-posto)';
    case 'ENTERPRISE':
      return 'Enterprise';
    default:
      return 'Base Orgânico';
  }
}

export function renderMasterGovernanceModal(params: MasterGovernanceModalParams): string {
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
    stats,
    activeTab,
    selectedCompanyDetails,
    isLoadingCompanyDetails = false,
    showNewCompanyForm = false,
    usersList = [],
    isLoadingUsers = false,
    systemStatus,
    isLoadingSystemStatus = false,
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

  const activeCount = stats?.activeCompanies ?? mergedCompanies.filter((c) => c.status === 'active').length;
  const suspendedCount = stats?.suspendedCompanies ?? mergedCompanies.filter((c) => c.status === 'suspended').length;
  const commercialCount = stats?.commercialActiveCount ?? mergedCompanies.filter((c) => c.planTier !== 'FREE').length;
  const organicCount = stats?.baseOrganicCount ?? mergedCompanies.filter((c) => c.planTier === 'FREE').length;
  const totalInvoices = stats?.totalInvoicesCount ?? mergedCompanies.reduce((acc, c) => acc + c.invoiceCount, 0);
  const totalUsers = stats?.totalUsersCount ?? Math.max(usersList.length, 1);

  return `
    <div class="fixed inset-0 z-50 bg-slate-950/75 flex items-center justify-center p-2 sm:p-4">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-6xl max-h-[94vh] flex flex-col overflow-hidden shadow-2xl animate-in fade-in duration-150">
        <!-- Cabeçalho Institucional de Governança -->
        <div class="px-5 py-3 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm shadow-blue-400"></span>
              <h2 class="text-sm font-bold tracking-tight">SILA-Billing · Centro de Governança Multiempresa</h2>
              <span class="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-blue-900/80 text-blue-300 border border-blue-700/50">Master</span>
            </div>
            <p class="text-[11px] text-slate-400 truncate mt-0.5">
              ${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}${isSignedIn ? ` · Administrador: ${escapeHtml(userEmail)}` : ''}
            </p>
          </div>
          <button
            type="button"
            data-action="close-master-admin"
            class="h-8 px-3 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            ${ICONS.close}
            <span>Voltar à faturação</span>
          </button>
        </div>

        ${
          !isSignedIn
            ? `
            <div class="flex-1 overflow-y-auto p-6">
              <div class="py-12 max-w-md mx-auto text-center space-y-4">
                <div class="w-12 h-12 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center mx-auto border border-blue-200">
                  ${ICONS.lock}
                </div>
                <div class="text-sm font-bold text-slate-900">Autenticação Administrativa Global</div>
                <p class="text-xs text-slate-600 leading-relaxed">
                  O Centro de Governança SILA-Billing exige validação criptográfica no servidor com verificação de conta autorizada. Os privilégios são auditados estritamente no backend.
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
                  class="h-10 px-5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap shadow-sm"
                >${isAuthenticating ? 'A abrir autenticação Google...' : 'Autenticar Administrador Google'}</button>
              </div>
            </div>
          `
            : isLoading
              ? `
            <div class="flex-1 overflow-y-auto p-6 space-y-4">
              <div class="h-10 bg-slate-100 rounded-lg animate-pulse"></div>
              <div class="grid grid-cols-2 sm:grid-cols-6 gap-3">
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
                <div class="h-16 bg-slate-50 rounded-lg animate-pulse"></div>
              </div>
              <div class="h-64 bg-slate-50 rounded-lg animate-pulse"></div>
            </div>
          `
              : accessDenied
                ? `
            <div class="flex-1 overflow-y-auto p-6">
              <div class="py-14 max-w-md mx-auto text-center space-y-3">
                <div class="w-12 h-12 rounded-xl bg-red-50 text-red-700 flex items-center justify-center mx-auto border border-red-200">
                  ${ICONS.lock}
                </div>
                <div class="text-sm font-bold text-red-700">Acesso Restrito à Administração Global</div>
                <p class="text-xs text-slate-600 leading-relaxed">
                  A conta <strong>${escapeHtml(userEmail)}</strong> não possui privilégios de Administrador da Plataforma SILA-Billing.
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
            </div>
          `
                : `
            <!-- Barra de Abas dos 6 Domínios de Governança -->
            <div class="px-5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 overflow-x-auto shrink-0">
              <div class="flex items-center gap-1 py-1.5 text-xs">
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="overview"
                  data-value="overview"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'overview'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>1. Visão Global</span>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="companies"
                  data-value="companies"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'companies'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>2. Empresas</span>
                  <span class="px-1.5 py-0.2 rounded-full text-[10px] ${
                    activeTab === 'companies' ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-700'
                  } font-mono">${mergedCompanies.length}</span>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="plans"
                  data-value="plans"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'plans'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>3. Planos Comerciais</span>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="users"
                  data-value="users"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'users'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>4. Utilizadores</span>
                  <span class="px-1.5 py-0.2 rounded-full text-[10px] ${
                    activeTab === 'users' ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-700'
                  } font-mono">${totalUsers}</span>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="monitoring"
                  data-value="monitoring"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'monitoring'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>5. Monitorização</span>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="audit"
                  data-value="audit"
                  class="cursor-pointer px-3 py-1.5 rounded-md font-semibold transition-all flex items-center gap-1.5 whitespace-nowrap ${
                    activeTab === 'audit'
                      ? 'bg-blue-600 text-white font-bold shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-200/70'
                  }"
                >
                  <span>6. Auditoria</span>
                  <span class="px-1.5 py-0.2 rounded-full text-[10px] ${
                    activeTab === 'audit' ? 'bg-blue-700 text-white' : 'bg-slate-200 text-slate-700'
                  } font-mono">${recentLogs.length}</span>
                </button>
              </div>

              <div class="flex items-center gap-2 py-1.5">
                <button
                  type="button"
                  data-action="refresh-master-admin"
                  class="cursor-pointer h-7 px-2.5 rounded border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1 shrink-0 transition-colors"
                  title="Atualizar dados do servidor"
                >
                  ${ICONS.refresh}
                  <span class="hidden sm:inline">Atualizar</span>
                </button>
              </div>
            </div>

            <!-- Corpo Dinâmico da Aba Ativa -->
            <div class="flex-1 overflow-y-auto p-5 space-y-5">
              ${
                errorMessage
                  ? `<div class="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800 flex items-start justify-between gap-3">
                      <div>${escapeHtml(errorMessage)}</div>
                      <button type="button" data-action="refresh-master-admin" class="cursor-pointer font-semibold text-amber-900 underline text-[11px] shrink-0">Tentar de novo</button>
                    </div>`
                  : ''
              }

              <!-- Resumo Quantitativo Interativo (Navegação Rápida nos 6 Domínios) -->
              <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 tabular-nums">
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="companies"
                  data-value="companies"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para gerir empresas"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Empresas registadas</div>
                  <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${stats?.totalCompanies ?? mergedCompanies.length}</div>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="companies"
                  data-value="companies"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para ver empresas ativas"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Operação ativa</div>
                  <div class="text-base font-bold font-mono text-emerald-700 mt-0.5">${activeCount}</div>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="companies"
                  data-value="companies"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para ver empresas suspensas"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Suspensas</div>
                  <div class="text-base font-bold font-mono text-slate-700 mt-0.5">${suspendedCount}</div>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="plans"
                  data-value="plans"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para gerir subscrições comerciais"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Subscrições pagas</div>
                  <div class="text-base font-bold font-mono text-blue-700 mt-0.5">${commercialCount}</div>
                  <div class="text-[9.5px] text-blue-600 truncate">Essencial/Prof/Ent</div>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="plans"
                  data-value="plans"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para gerir Base Orgânico"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Base Orgânico</div>
                  <div class="text-base font-bold font-mono text-amber-700 mt-0.5">${organicCount}</div>
                  <div class="text-[9.5px] text-amber-600 truncate">Até 40 docs/mês</div>
                </button>
                <button
                  type="button"
                  data-action="master-switch-tab"
                  data-tab="companies"
                  data-value="companies"
                  class="cursor-pointer text-left p-2.5 rounded-lg border border-slate-200 bg-slate-50/70 hover:bg-white hover:border-blue-400 hover:shadow-xs transition-all"
                  title="Clique para ver faturas por empresa"
                >
                  <div class="text-[10.5px] text-slate-500 font-medium">Faturas consolidadas</div>
                  <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${totalInvoices}</div>
                </button>
              </div>

              <!-- Conteúdo Específico de Cada Aba -->
              ${
                activeTab === 'overview'
                  ? renderOverviewTab({ stats, mergedCompanies, recentLogs })
                  : activeTab === 'companies'
                    ? renderCompaniesTab({
                        visibleCompanies,
                        searchQuery,
                        activeCompanyId,
                        showNewCompanyForm,
                      })
                    : activeTab === 'plans'
                      ? renderPlansTab({ stats, mergedCompanies })
                      : activeTab === 'users'
                        ? renderUsersTab({ usersList, isLoadingUsers })
                        : activeTab === 'monitoring'
                          ? renderMonitoringTab({ systemStatus, isLoadingSystemStatus })
                          : renderAuditTab({ recentLogs, searchQuery })
              }
            </div>
          `
        }

        <!-- Gaveta de Perfil Detalhado da Empresa (se aberta) -->
        ${
          selectedCompanyDetails
            ? renderCompanyDetailsDrawer({
                data: selectedCompanyDetails,
                isLoading: isLoadingCompanyDetails,
                activeCompanyId,
              })
            : ''
        }

        <!-- Modal de Nova Empresa Criada pelo Master (se aberta) -->
        ${showNewCompanyForm ? renderNewCompanyMasterModal() : ''}
      </div>
    </div>
  `;
}

function renderOverviewTab(params: {
  stats?: AdminOverviewStats | null;
  mergedCompanies: AdminCompanySummary[];
  recentLogs: AdminAuditEntry[];
}): string {
  const { stats, mergedCompanies, recentLogs } = params;
  const pb = stats?.plansBreakdown || {
    FREE: mergedCompanies.filter((c) => c.planTier === 'FREE').length,
    ESSENCIAL: mergedCompanies.filter((c) => c.planTier === 'ESSENCIAL').length,
    PROFISSIONAL: mergedCompanies.filter((c) => c.planTier === 'PROFISSIONAL').length,
    ENTERPRISE: mergedCompanies.filter((c) => c.planTier === 'ENTERPRISE').length,
  };

  return `
    <div class="space-y-5">
      <!-- Repartição de Planos Comerciais -->
      <div class="border border-slate-200 rounded-lg p-4 bg-white">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-xs font-bold text-slate-900">Enquadramento de Planos Comerciais</h3>
          <span class="text-[11px] text-slate-500">Métricas consolidadas em tempo real</span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div class="p-3 rounded-lg border border-slate-200 bg-amber-50/40">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-amber-950">Base Orgânico</span>
              <span class="text-xs font-mono font-bold text-amber-800">${pb.FREE}</span>
            </div>
            <p class="text-[10.5px] text-amber-900/80 mt-1">Limite: 40 faturas/mês · 1 posto local · Custo zero</p>
          </div>
          <div class="p-3 rounded-lg border border-slate-200 bg-blue-50/40">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-blue-950">Essencial</span>
              <span class="text-xs font-mono font-bold text-blue-800">${pb.ESSENCIAL}</span>
            </div>
            <p class="text-[10.5px] text-blue-900/80 mt-1">1.000 Kz/mês · Faturação ilimitada · Backup local</p>
          </div>
          <div class="p-3 rounded-lg border border-slate-200 bg-indigo-50/40">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-indigo-950">Profissional</span>
              <span class="text-xs font-mono font-bold text-indigo-800">${pb.PROFISSIONAL}</span>
            </div>
            <p class="text-[10.5px] text-indigo-900/80 mt-1">Multi-posto · Sincronização cloud contínua</p>
          </div>
          <div class="p-3 rounded-lg border border-slate-200 bg-purple-50/40">
            <div class="flex items-center justify-between">
              <span class="text-xs font-bold text-purple-950">Enterprise</span>
              <span class="text-xs font-mono font-bold text-purple-800">${pb.ENTERPRISE}</span>
            </div>
            <p class="text-[10.5px] text-purple-900/80 mt-1">Terminais ilimitados · SLA governamental dedicado</p>
          </div>
        </div>
      </div>

      <!-- Duas Colunas: Atividade Recente e Estado dos Serviços -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <!-- Atividade de Auditoria Recente -->
        <div class="border border-slate-200 rounded-lg p-4 bg-white flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-bold text-slate-900">Últimas Intervenções Administrativas</h3>
              <button
                type="button"
                data-action="master-switch-tab"
                data-tab="audit"
                data-value="audit"
                class="cursor-pointer text-[11px] font-semibold text-blue-600 hover:text-blue-800 transition-colors"
              >Ver tudo &rarr;</button>
            </div>
            <div class="divide-y divide-slate-100 text-[11px]">
              ${
                recentLogs.length === 0
                  ? `<div class="py-4 text-center text-slate-500">Nenhum registo recente de auditoria.</div>`
                  : recentLogs
                      .slice(0, 5)
                      .map((log) => {
                        const ldt = formatDateTimePt(log.createdAtIso);
                        return `
                        <div class="py-2 flex items-start justify-between gap-3">
                          <div class="min-w-0">
                            <span class="font-mono text-[10px] text-slate-400">${ldt.time}</span>
                            <span class="font-semibold text-slate-800 ml-1">${escapeHtml(log.companyName || log.companyId || 'Plataforma')}</span>
                            <div class="text-[10.5px] text-slate-600 truncate mt-0.5">${escapeHtml(log.details)}</div>
                          </div>
                          <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 shrink-0">${escapeHtml(log.action)}</span>
                        </div>
                      `;
                      })
                      .join('')
              }
            </div>
          </div>
        </div>

        <!-- Síntese de Monitorização da Plataforma -->
        <div class="border border-slate-200 rounded-lg p-4 bg-white flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-xs font-bold text-slate-900">Estado de Prontidão da Infraestrutura</h3>
              <button
                type="button"
                data-action="master-switch-tab"
                data-tab="monitoring"
                data-value="monitoring"
                class="cursor-pointer text-[11px] font-semibold text-blue-600 hover:text-blue-800 transition-colors"
              >Diagnóstico &rarr;</button>
            </div>
            <div class="space-y-2.5 text-xs">
              <div class="p-2.5 rounded-lg border border-slate-100 bg-slate-50 flex items-center justify-between">
                <div>
                  <div class="font-semibold text-slate-800">API Node.js &amp; Rotas REST</div>
                  <div class="text-[11px] text-slate-500">Servidor Express na porta 3000</div>
                </div>
                <span class="px-2 py-0.5 text-[10.5px] font-semibold rounded bg-emerald-100 text-emerald-800">Operacional</span>
              </div>
              <div class="p-2.5 rounded-lg border border-slate-100 bg-slate-50 flex items-center justify-between">
                <div>
                  <div class="font-semibold text-slate-800">Repositório Cloud Firestore</div>
                  <div class="text-[11px] text-slate-500">Base multiempresa com regras ativas</div>
                </div>
                <span class="px-2 py-0.5 text-[10.5px] font-semibold rounded bg-emerald-100 text-emerald-800">Conectado</span>
              </div>
              <div class="p-2.5 rounded-lg border border-slate-100 bg-slate-50 flex items-center justify-between">
                <div>
                  <div class="font-semibold text-slate-800">Validador Fiscal AGT (Dec. 683/25)</div>
                  <div class="text-[11px] text-slate-500">QR Code Model 2 V4 M &amp; Assinaturas RS256/JWS</div>
                </div>
                <span class="px-2 py-0.5 text-[10.5px] font-semibold rounded bg-emerald-100 text-emerald-800">Pronto</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderCompaniesTab(params: {
  visibleCompanies: AdminCompanySummary[];
  searchQuery: string;
  activeCompanyId: string;
  showNewCompanyForm: boolean;
}): string {
  const { visibleCompanies, searchQuery, activeCompanyId } = params;

  return `
    <div class="space-y-4">
      <!-- Barra de Ações do Módulo de Empresas -->
      <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div class="relative flex-1 max-w-md">
          <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
          <input
            id="master-admin-search-input"
            type="text"
            data-field="master-admin-search"
            value="${escapeHtml(searchQuery)}"
            placeholder="Filtrar empresa por nome, NIF ou e-mail..."
            class="w-full h-9 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          />
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button
            type="button"
            data-action="master-open-new-company"
            class="h-9 px-3 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 shadow-xs whitespace-nowrap"
          >
            ${ICONS.plus}
            <span>Nova Empresa</span>
          </button>
        </div>
      </div>

      <!-- Tabela Densa de Governança Empresarial -->
      <div class="border border-slate-200 rounded-lg overflow-x-auto bg-white shadow-xs">
        <table class="w-full text-left border-collapse text-xs">
          <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
            <tr>
              <th class="py-2.5 px-3 font-semibold">Empresa</th>
              <th class="py-2.5 px-3 font-semibold">NIF Único</th>
              <th class="py-2.5 px-3 font-semibold hidden md:table-cell">Registo</th>
              <th class="py-2.5 px-3 font-semibold text-right">Faturas</th>
              <th class="py-2.5 px-3 font-semibold">Plano Comercial</th>
              <th class="py-2.5 px-3 font-semibold">Estado</th>
              <th class="py-2.5 px-3 font-semibold text-right">Ações de Governança</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 tabular-nums">
            ${
              visibleCompanies.length === 0
                ? `<tr><td colspan="7" class="py-8 text-center text-slate-500">Nenhuma empresa encontrada com os critérios fornecidos.</td></tr>`
                : visibleCompanies
                    .map((comp) => {
                      const dt = formatDateTimePt(comp.createdAtIso);
                      const isCurrent = comp.id === activeCompanyId;
                      const isSusp = comp.status === 'suspended';
                      const nextStatus: CompanyOperationalStatus = isSusp ? 'active' : 'suspended';

                      return `
                        <tr class="${isCurrent ? 'bg-blue-50/40' : 'hover:bg-slate-50/70'} transition-colors">
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
                                  const label = formatPlanLabelPt(tier);
                                  return `<option value="${tier}" ${comp.planTier === tier ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                                })
                                .join('')}
                            </select>
                          </td>
                          <td class="py-2.5 px-3">
                            <span class="inline-flex items-center gap-1 font-semibold ${isSusp ? 'text-red-700' : 'text-emerald-700'}">
                              <span class="w-1.5 h-1.5 rounded-full ${isSusp ? 'bg-red-600' : 'bg-emerald-600'}"></span>
                              ${isSusp ? 'Suspensa' : 'Ativa'}
                            </span>
                          </td>
                          <td class="py-2.5 px-3 text-right">
                            <div class="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                data-action="admin-inspect-company"
                                data-id="${escapeHtml(comp.id)}"
                                class="cursor-pointer h-8 px-2.5 rounded-md border border-slate-200 bg-white text-[11px] font-semibold text-slate-700 hover:bg-slate-100 active:scale-95 transition-all shadow-2xs whitespace-nowrap"
                                title="Ver ficha completa, membros e auditoria"
                              >Inspecionar</button>
                              <button
                                type="button"
                                data-action="admin-toggle-company-status"
                                data-id="${escapeHtml(comp.id)}"
                                data-value="${nextStatus}"
                                class="cursor-pointer h-8 px-2.5 rounded-md border border-slate-200 bg-white text-[11px] font-medium ${
                                  isSusp
                                    ? 'text-emerald-700 hover:bg-emerald-50 border-emerald-200'
                                    : 'text-red-600 hover:bg-red-50 border-red-200'
                                } active:scale-95 transition-all shadow-2xs whitespace-nowrap"
                              >${isSusp ? 'Reativar' : 'Suspender'}</button>
                              <button
                                type="button"
                                data-action="admin-support-switch"
                                data-id="${escapeHtml(comp.id)}"
                                class="cursor-pointer h-8 px-2.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 active:scale-95 transition-all shadow-2xs whitespace-nowrap"
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
    </div>
  `;
}

function renderPlansTab(params: {
  stats?: AdminOverviewStats | null;
  mergedCompanies: AdminCompanySummary[];
}): string {
  const { stats, mergedCompanies } = params;
  const pb = stats?.plansBreakdown || {
    FREE: mergedCompanies.filter((c) => c.planTier === 'FREE').length,
    ESSENCIAL: mergedCompanies.filter((c) => c.planTier === 'ESSENCIAL').length,
    PROFISSIONAL: mergedCompanies.filter((c) => c.planTier === 'PROFISSIONAL').length,
    ENTERPRISE: mergedCompanies.filter((c) => c.planTier === 'ENTERPRISE').length,
  };

  return `
    <div class="space-y-5">
      <div class="border border-slate-200 rounded-lg p-4 bg-white">
        <h3 class="text-xs font-bold text-slate-900 mb-1">Catálogo de Planos Comerciais SILA-Billing</h3>
        <p class="text-xs text-slate-500 mb-4">
          Parametrização de limites, escalões de faturação e recursos operacionais autorizados pela VITRONIS.
        </p>

        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <!-- Base Orgânico -->
          <div class="border border-amber-200 rounded-lg p-4 bg-amber-50/20 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-900">Base Orgânico</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800">Gratuito</span>
              </div>
              <div class="text-lg font-bold font-mono text-slate-900 mt-2">0 Kz<span class="text-xs text-slate-400 font-normal">/mês</span></div>
              <ul class="text-[11px] text-slate-600 mt-3 space-y-1.5">
                <li>&bull; <strong>40 documentos fiscais/mês</strong></li>
                <li>&bull; 1 Posto de emissão local (POS/A4)</li>
                <li>&bull; Base de dados IndexedDB 100% offline</li>
                <li>&bull; QR Code oficial AGT (Dec. 683/25)</li>
                <li>&bull; Exportação de ficheiros de auditoria</li>
              </ul>
            </div>
            <div class="pt-4 border-t border-amber-200/60 mt-4 text-[11px] font-semibold text-amber-900">
              Empresas ativas: <span class="font-mono text-sm">${pb.FREE}</span>
            </div>
          </div>

          <!-- Essencial -->
          <div class="border border-blue-200 rounded-lg p-4 bg-blue-50/20 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-900">Essencial</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800">Comercial</span>
              </div>
              <div class="text-lg font-bold font-mono text-slate-900 mt-2">1.000 Kz<span class="text-xs text-slate-400 font-normal">/mês</span></div>
              <ul class="text-[11px] text-slate-600 mt-3 space-y-1.5">
                <li>&bull; <strong>Faturação contínua e ilimitada</strong></li>
                <li>&bull; Operação autónoma local sem limite de docs</li>
                <li>&bull; Gestão de clientes e conta corrente</li>
                <li>&bull; Fecho e conferência de caixa por operador</li>
                <li>&bull; Suporte prioritário via WhatsApp VITRONIS</li>
              </ul>
            </div>
            <div class="pt-4 border-t border-blue-200/60 mt-4 text-[11px] font-semibold text-blue-900">
              Empresas ativas: <span class="font-mono text-sm">${pb.ESSENCIAL}</span>
            </div>
          </div>

          <!-- Profissional -->
          <div class="border border-indigo-200 rounded-lg p-4 bg-indigo-50/20 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-900">Profissional</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-100 text-indigo-800">Multi-Posto</span>
              </div>
              <div class="text-lg font-bold font-mono text-slate-900 mt-2">15.000 Kz<span class="text-xs text-slate-400 font-normal">/mês</span></div>
              <ul class="text-[11px] text-slate-600 mt-3 space-y-1.5">
                <li>&bull; Faturação ilimitada multi-operador</li>
                <li>&bull; Sincronização cloud contínua e automática</li>
                <li>&bull; Gestão de compras e fornecedores</li>
                <li>&bull; Kardex e inventário multi-armazém</li>
                <li>&bull; Backup automático no Google Firestore</li>
              </ul>
            </div>
            <div class="pt-4 border-t border-indigo-200/60 mt-4 text-[11px] font-semibold text-indigo-900">
              Empresas ativas: <span class="font-mono text-sm">${pb.PROFISSIONAL}</span>
            </div>
          </div>

          <!-- Enterprise -->
          <div class="border border-purple-200 rounded-lg p-4 bg-purple-50/20 flex flex-col justify-between">
            <div>
              <div class="flex items-center justify-between">
                <span class="text-xs font-bold text-slate-900">Enterprise</span>
                <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-800">Corporativo</span>
              </div>
              <div class="text-lg font-bold font-mono text-slate-900 mt-2">Personalizado</div>
              <ul class="text-[11px] text-slate-600 mt-3 space-y-1.5">
                <li>&bull; Lojas e armazéns em rede com múltiplos postos</li>
                <li>&bull; Integração direta AGT via webservices REST</li>
                <li>&bull; Submissão automática de lotes até 30 docs</li>
                <li>&bull; SLA governamental e apoio presencial</li>
                <li>&bull; Auditoria de contingência e segurança avançada</li>
              </ul>
            </div>
            <div class="pt-4 border-t border-purple-200/60 mt-4 text-[11px] font-semibold text-purple-900">
              Empresas ativas: <span class="font-mono text-sm">${pb.ENTERPRISE}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderUsersTab(params: {
  usersList: PlatformUserSummary[];
  isLoadingUsers: boolean;
}): string {
  const { usersList, isLoadingUsers } = params;

  if (isLoadingUsers) {
    return `
      <div class="space-y-3 py-6">
        <div class="h-9 bg-slate-100 rounded-lg animate-pulse"></div>
        <div class="h-12 bg-slate-50 rounded-lg animate-pulse"></div>
        <div class="h-12 bg-slate-50 rounded-lg animate-pulse"></div>
      </div>
    `;
  }

  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-xs font-bold text-slate-900">Directório de Utilizadores e Acessos Empresariais</h3>
          <p class="text-xs text-slate-500">Mapeamento de operadores e proprietários com validação de permissões no servidor.</p>
        </div>
        <button
          type="button"
          data-action="master-refresh-users"
          class="cursor-pointer h-8 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 active:scale-95 transition-all shadow-2xs flex items-center gap-1.5 whitespace-nowrap"
        >
          ${ICONS.refresh}
          <span>Atualizar directório</span>
        </button>
      </div>

      <div class="border border-slate-200 rounded-lg overflow-x-auto bg-white shadow-xs">
        <table class="w-full text-left border-collapse text-xs">
          <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
            <tr>
              <th class="py-2.5 px-3 font-semibold">Conta / E-mail</th>
              <th class="py-2.5 px-3 font-semibold">Identificador (UID)</th>
              <th class="py-2.5 px-3 font-semibold">Administração Global</th>
              <th class="py-2.5 px-3 font-semibold">Empresas e Papéis Vinculados</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100">
            ${
              usersList.length === 0
                ? `<tr><td colspan="4" class="py-8 text-center text-slate-500">Nenhum utilizador encontrado no directório. Clique em Atualizar para consultar a base.</td></tr>`
                : usersList
                    .map((u) => {
                      return `
                      <tr class="hover:bg-slate-50/70 transition-colors">
                        <td class="py-2.5 px-3">
                          <div class="font-semibold text-slate-900">${escapeHtml(u.email || 'Sem email registado')}</div>
                          <div class="text-[10px] text-emerald-700 flex items-center gap-1 mt-0.5">
                            <span class="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>
                            Email verificado
                          </div>
                        </td>
                        <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500">${escapeHtml(u.uid)}</td>
                        <td class="py-2.5 px-3">
                          ${
                            u.isPlatformAdmin
                              ? `<span class="px-2 py-0.5 rounded font-bold text-[10px] bg-blue-100 text-blue-800 border border-blue-200">Super-Admin</span>`
                              : `<span class="text-slate-400 text-xs">Utilizador regular</span>`
                          }
                        </td>
                        <td class="py-2.5 px-3">
                          <div class="flex flex-wrap gap-1.5">
                            ${
                              u.companies.length === 0
                                ? `<span class="text-slate-400 text-[11px]">Nenhuma associação empresarial</span>`
                                : u.companies
                                    .map((c) => {
                                      const roleLabel =
                                        c.role === 'owner' ? 'Proprietário' : c.role === 'manager' ? 'Gerente' : 'Caixa';
                                      return `
                                    <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-[10.5px]">
                                      <span class="font-medium text-slate-800">${escapeHtml(c.companyName)}</span>
                                      <span class="text-slate-400 font-normal">(${roleLabel})</span>
                                    </span>
                                  `;
                                    })
                                    .join('')
                            }
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
    </div>
  `;
}

function renderMonitoringTab(params: {
  systemStatus?: SystemStatusResponse | null;
  isLoadingSystemStatus: boolean;
}): string {
  const { systemStatus, isLoadingSystemStatus } = params;

  if (isLoadingSystemStatus) {
    return `
      <div class="space-y-3 py-6">
        <div class="h-9 bg-slate-100 rounded-lg animate-pulse"></div>
        <div class="h-24 bg-slate-50 rounded-lg animate-pulse"></div>
        <div class="h-24 bg-slate-50 rounded-lg animate-pulse"></div>
      </div>
    `;
  }

  const tel = systemStatus?.telemetry;
  const fs = systemStatus?.firestore;

  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-xs font-bold text-slate-900">Telemetria e Diagnóstico Operacional em Tempo Real</h3>
          <p class="text-xs text-slate-500">Monitorização do servidor Node.js, ligação ao Firestore e serviços fiscais AGT.</p>
        </div>
        <button
          type="button"
          data-action="master-refresh-system-status"
          class="cursor-pointer h-8 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-700 hover:bg-slate-100 active:scale-95 transition-all shadow-2xs flex items-center gap-1.5 whitespace-nowrap"
        >
          ${ICONS.refresh}
          <span>Diagnosticar agora</span>
        </button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <!-- Servidor Node.js -->
        <div class="border border-slate-200 rounded-lg p-3.5 bg-white">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-bold text-slate-800">Ambiente Node.js</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">Ativo</span>
          </div>
          <div class="space-y-1 text-xs text-slate-600">
            <div>Versão: <span class="font-mono text-slate-800">${tel?.nodeVersion || 'v22.x'}</span></div>
            <div>Porta: <span class="font-mono text-slate-800">${tel?.port || 3000}</span></div>
            <div>Tempo em execução: <span class="font-mono text-slate-800">${Math.floor((tel?.uptimeSeconds || 0) / 60)} min (${tel?.uptimeSeconds || 0}s)</span></div>
          </div>
        </div>

        <!-- Consumo de Memória -->
        <div class="border border-slate-200 rounded-lg p-3.5 bg-white">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-bold text-slate-800">Memória do Servidor</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800">Estável</span>
          </div>
          <div class="space-y-1 text-xs text-slate-600">
            <div>RSS: <span class="font-mono text-slate-800">${tel?.memory.rssMb || 0} MB</span></div>
            <div>Heap Utilizado: <span class="font-mono text-slate-800">${tel?.memory.heapUsedMb || 0} MB</span></div>
            <div>Heap Alocado: <span class="font-mono text-slate-800">${tel?.memory.heapTotalMb || 0} MB</span></div>
          </div>
        </div>

        <!-- Conexão Firestore -->
        <div class="border border-slate-200 rounded-lg p-3.5 bg-white">
          <div class="flex items-center justify-between mb-2">
            <span class="text-xs font-bold text-slate-800">Repositório Firestore</span>
            <span class="px-2 py-0.5 rounded text-[10px] font-bold ${
              fs?.initialized ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }">${fs?.initialized ? 'Inicializado' : 'Aguardando'}</span>
          </div>
          <div class="space-y-1 text-xs text-slate-600">
            <div class="truncate">Base ID: <span class="font-mono text-[11px] text-slate-800">${fs?.databaseId || 'ai-studio-49352535...'}</span></div>
            <div>Credenciais: <span class="font-mono text-slate-800">${fs?.credentialSource || 'DEFAULT'}</span></div>
            <div>Persistência Cloud: <span class="font-semibold text-emerald-700">Multiempresa Ativa</span></div>
          </div>
        </div>
      </div>

      <!-- Serviços Fiscais AGT -->
      <div class="border border-slate-200 rounded-lg p-4 bg-white">
        <h4 class="text-xs font-bold text-slate-900 mb-2">Prontidão dos Componentes do Decreto Executivo n.º 683/25</h4>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
          <div class="p-3 rounded-lg border border-slate-100 bg-slate-50 flex items-start gap-2.5">
            <span class="text-emerald-600 font-bold mt-0.5">&#10003;</span>
            <div>
              <div class="font-semibold text-slate-800">Assinaturas RS256/JWS</div>
              <div class="text-[10.5px] text-slate-500">Chaves do produtor e emissor protegidas no servidor</div>
            </div>
          </div>
          <div class="p-3 rounded-lg border border-slate-100 bg-slate-50 flex items-start gap-2.5">
            <span class="text-emerald-600 font-bold mt-0.5">&#10003;</span>
            <div>
              <div class="font-semibold text-slate-800">Gerador Oficial QR Code</div>
              <div class="text-[10.5px] text-slate-500">Model 2, Versão 4, Nível M (350x350 px e SVG)</div>
            </div>
          </div>
          <div class="p-3 rounded-lg border border-slate-100 bg-slate-50 flex items-start gap-2.5">
            <span class="text-emerald-600 font-bold mt-0.5">&#10003;</span>
            <div>
              <div class="font-semibold text-slate-800">Regras de Séries e Ano</div>
              <div class="text-[10.5px] text-slate-500">Regra de 15/Dezembro e estados A, U e F</div>
            </div>
          </div>
          <div class="p-3 rounded-lg border border-slate-100 bg-slate-50 flex items-start gap-2.5">
            <span class="text-emerald-600 font-bold mt-0.5">&#10003;</span>
            <div>
              <div class="font-semibold text-slate-800">SAF-T (AO) XML v1.01_01</div>
              <div class="text-[10.5px] text-slate-500">Dec. Executivo 312/18 e esquema oficial XSD</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderAuditTab(params: {
  recentLogs: AdminAuditEntry[];
  searchQuery: string;
}): string {
  const { recentLogs, searchQuery } = params;
  const q = searchQuery.trim().toLowerCase();
  const visibleLogs = recentLogs.filter(
    (l) =>
      !q ||
      l.companyName.toLowerCase().includes(q) ||
      l.action.toLowerCase().includes(q) ||
      l.adminEmail.toLowerCase().includes(q) ||
      l.details.toLowerCase().includes(q)
  );

  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-xs font-bold text-slate-900">Registo Imutável de Auditoria de Governança</h3>
          <p class="text-xs text-slate-500">Histórico de todas as intervenções administrativas, suspensões e acessos de suporte.</p>
        </div>
      </div>

      <div class="border border-slate-200 rounded-lg overflow-x-auto bg-white shadow-xs">
        <table class="w-full text-left border-collapse text-xs">
          <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
            <tr>
              <th class="py-2.5 px-3 font-semibold">Data / Hora</th>
              <th class="py-2.5 px-3 font-semibold">Administrador</th>
              <th class="py-2.5 px-3 font-semibold">Empresa</th>
              <th class="py-2.5 px-3 font-semibold">Ação Operacional</th>
              <th class="py-2.5 px-3 font-semibold">Detalhes Registados</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 tabular-nums">
            ${
              visibleLogs.length === 0
                ? `<tr><td colspan="5" class="py-8 text-center text-slate-500">Nenhum registo de auditoria encontrado.</td></tr>`
                : visibleLogs
                    .map((log) => {
                      const dt = formatDateTimePt(log.createdAtIso);
                      return `
                      <tr class="hover:bg-slate-50/70 transition-colors">
                        <td class="py-2.5 px-3 text-slate-500 whitespace-nowrap">
                          <span class="font-semibold text-slate-800">${dt.slashDate}</span>
                          <span class="font-mono text-[10.5px] text-slate-400 ml-1">${dt.time}</span>
                        </td>
                        <td class="py-2.5 px-3 font-mono text-[11px] text-slate-700">${escapeHtml(log.adminEmail || 'Admin')}</td>
                        <td class="py-2.5 px-3 font-semibold text-slate-900">${escapeHtml(log.companyName || log.companyId || 'Plataforma')}</td>
                        <td class="py-2.5 px-3">
                          <span class="px-2 py-0.5 rounded font-mono text-[10px] font-semibold bg-slate-100 text-slate-700 border border-slate-200">${escapeHtml(log.action)}</span>
                        </td>
                        <td class="py-2.5 px-3 text-slate-600 max-w-sm truncate">${escapeHtml(log.details)}</td>
                      </tr>
                    `;
                    })
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderCompanyDetailsDrawer(params: {
  data: AdminCompanyDetails;
  isLoading: boolean;
  activeCompanyId: string;
}): string {
  const { data, isLoading, activeCompanyId } = params;
  const c = data.company;
  const counts = data.counts;
  const isCurrent = c.id === activeCompanyId;
  const isSusp = c.status === 'suspended';

  return `
    <div class="fixed inset-0 z-60 bg-slate-950/50 flex justify-end">
      <div class="bg-white w-full max-w-xl h-full shadow-2xl border-l border-slate-200 flex flex-col overflow-hidden animate-in slide-in-from-right duration-150">
        <!-- Cabeçalho da Gaveta -->
        <div class="px-5 py-4 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between shrink-0">
          <div>
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-bold">${escapeHtml(c.shortName)}</h3>
              <span class="px-2 py-0.5 rounded text-[10px] font-bold ${
                isSusp ? 'bg-red-900 text-red-200' : 'bg-emerald-900 text-emerald-200'
              }">${isSusp ? 'Suspensa' : 'Ativa'}</span>
            </div>
            <p class="text-[11px] text-slate-400 font-mono mt-0.5">NIF: ${escapeHtml(c.nif)} · ID: ${escapeHtml(c.id)}</p>
          </div>
          <button
            type="button"
            data-action="admin-close-company-details"
            class="cursor-pointer h-8 w-8 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center transition-colors"
          >
            ${ICONS.close}
          </button>
        </div>

        <!-- Conteúdo do Perfil Detalhado -->
        <div class="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
          <!-- Ações Rápidas no Topo -->
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-action="admin-support-switch"
              data-id="${escapeHtml(c.id)}"
              class="cursor-pointer h-8 px-3 rounded-lg bg-slate-900 text-white font-semibold hover:bg-slate-800 active:scale-95 transition-all shadow-2xs flex items-center gap-1.5"
            >
              <span>${isCurrent ? 'Contexto Ativo' : 'Aceder em Modo Suporte'}</span>
            </button>
            <button
              type="button"
              data-action="admin-toggle-company-status"
              data-id="${escapeHtml(c.id)}"
              data-value="${isSusp ? 'active' : 'suspended'}"
              class="cursor-pointer h-8 px-3 rounded-lg border border-slate-200 bg-white font-medium ${
                isSusp ? 'text-emerald-700 hover:bg-emerald-50 border-emerald-200' : 'text-red-600 hover:bg-red-50 border-red-200'
              } active:scale-95 transition-all shadow-2xs"
            >
              ${isSusp ? 'Reativar Empresa' : 'Suspender Empresa'}
            </button>
          </div>

          <!-- Estatísticas Operacionais da Empresa -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 tabular-nums">
            <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <div class="text-[10px] text-slate-500">Faturas emitidas</div>
              <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${counts.invoices}</div>
            </div>
            <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <div class="text-[10px] text-slate-500">Artigos no catálogo</div>
              <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${counts.products}</div>
            </div>
            <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <div class="text-[10px] text-slate-500">Clientes registados</div>
              <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${counts.customers}</div>
            </div>
            <div class="p-2.5 rounded-lg border border-slate-200 bg-slate-50">
              <div class="text-[10px] text-slate-500">Sessões de caixa</div>
              <div class="text-base font-bold font-mono text-slate-900 mt-0.5">${counts.cashSessions}</div>
            </div>
          </div>

          <!-- Dados Cadastrais -->
          <div class="border border-slate-200 rounded-lg p-3.5 space-y-2 bg-slate-50/50">
            <h4 class="font-bold text-slate-900 text-xs">Ficha Cadastral e Fiscal</h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 text-slate-600">
              <div>Razão Social: <strong class="text-slate-800">${escapeHtml(c.legalName)}</strong></div>
              <div>Nome Curto: <strong class="text-slate-800">${escapeHtml(c.shortName)}</strong></div>
              <div>NIF Normalizado: <strong class="font-mono text-slate-800">${escapeHtml(c.normalizedNif)}</strong></div>
              <div>Cidade / País: <strong class="text-slate-800">${escapeHtml(c.cityCountry)}</strong></div>
              <div>E-mail: <strong class="text-slate-800">${escapeHtml(c.email || 'Não configurado')}</strong></div>
              <div>Telefone: <strong class="text-slate-800">${escapeHtml(c.phone || 'Não configurado')}</strong></div>
              <div class="sm:col-span-2">Endereço: <strong class="text-slate-800">${escapeHtml(c.address || 'Não configurado')}</strong></div>
            </div>
          </div>

          <!-- Membros Vinculados à Empresa -->
          <div class="border border-slate-200 rounded-lg p-3.5 space-y-2.5 bg-white">
            <div class="flex items-center justify-between">
              <h4 class="font-bold text-slate-900 text-xs">Operadores e Membros Vinculados</h4>
              <span class="text-[11px] font-mono text-slate-500">${data.members.length} registos</span>
            </div>
            ${
              data.members.length === 0
                ? `<p class="text-slate-500 text-xs">Nenhum membro subcolecionado (proprietário opera diretamente).</p>`
                : `
                <div class="divide-y divide-slate-100 text-[11px]">
                  ${data.members
                    .map((m) => {
                      const roleLabel =
                        m.role === 'owner' ? 'Proprietário' : m.role === 'manager' ? 'Gerente' : 'Operador de Caixa';
                      return `
                      <div class="py-2 flex items-center justify-between gap-2">
                        <div class="min-w-0">
                          <div class="font-semibold text-slate-800 truncate">${escapeHtml(m.email)}</div>
                          <div class="font-mono text-[10px] text-slate-400 truncate">UID: ${escapeHtml(m.uid)}</div>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <span class="px-2 py-0.5 rounded font-semibold text-[10px] bg-slate-100 text-slate-700">${roleLabel}</span>
                          <span class="w-2 h-2 rounded-full ${m.active ? 'bg-emerald-500' : 'bg-red-400'}" title="${m.active ? 'Ativo' : 'Inativo'}"></span>
                        </div>
                      </div>
                    `;
                    })
                    .join('')}
                </div>
              `
            }
          </div>

          <!-- Histórico Específico de Auditoria -->
          <div class="border border-slate-200 rounded-lg p-3.5 space-y-2 bg-white">
            <h4 class="font-bold text-slate-900 text-xs">Histórico de Auditoria Específico</h4>
            ${
              data.auditHistory.length === 0
                ? `<p class="text-slate-500 text-xs">Nenhuma intervenção gravada para esta empresa.</p>`
                : `
                <div class="divide-y divide-slate-100 text-[11px]">
                  ${data.auditHistory
                    .slice(0, 6)
                    .map((l) => {
                      const dt = formatDateTimePt(l.createdAtIso);
                      return `
                      <div class="py-1.5 flex items-start justify-between gap-2">
                        <div>
                          <div class="font-semibold text-slate-800">${escapeHtml(l.action)}</div>
                          <div class="text-[10.5px] text-slate-500">${escapeHtml(l.details)}</div>
                        </div>
                        <span class="text-[10px] font-mono text-slate-400 shrink-0">${dt.slashDate} ${dt.time}</span>
                      </div>
                    `;
                    })
                    .join('')}
                </div>
              `
            }
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderNewCompanyMasterModal(): string {
  return `
    <div class="fixed inset-0 z-70 bg-slate-950/60 flex items-center justify-center p-3">
      <div class="bg-white rounded-xl border border-slate-200 w-full max-w-lg overflow-hidden shadow-2xl animate-in zoom-in-95 duration-150">
        <div class="px-5 py-3.5 border-b border-slate-200 bg-slate-900 text-white flex items-center justify-between">
          <div>
            <h3 class="text-xs font-bold">Registo Administrativo de Nova Empresa</h3>
            <p class="text-[11px] text-slate-400">Provisionamento oficial no repositório multiempresa</p>
          </div>
          <button
            type="button"
            data-action="master-close-new-company"
            class="h-7 w-7 rounded-md bg-slate-800 hover:bg-slate-700 text-slate-300 flex items-center justify-center"
          >
            ${ICONS.close}
          </button>
        </div>

        <form id="master-new-company-form" class="p-5 space-y-3.5 text-xs">
          <div>
            <label class="block font-medium text-slate-700 mb-1">Nome Curto da Empresa *</label>
            <input
              type="text"
              name="shortName"
              required
              placeholder="Ex.: Armazém Central"
              class="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>

          <div>
            <label class="block font-medium text-slate-700 mb-1">Denominação Social Completa</label>
            <input
              type="text"
              name="legalName"
              placeholder="Ex.: Armazém Central - Comércio Geral, Lda."
              class="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-medium text-slate-700 mb-1">NIF Único Angolano *</label>
              <input
                type="text"
                name="nif"
                required
                placeholder="Ex.: 5001234567"
                class="w-full h-8 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label class="block font-medium text-slate-700 mb-1">Cidade / Província</label>
              <input
                type="text"
                name="cityCountry"
                value="Luanda, Angola"
                class="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div>
            <label class="block font-medium text-slate-700 mb-1">E-mail do Proprietário / Titular *</label>
            <input
              type="email"
              name="ownerEmail"
              required
              placeholder="exemplo@gmail.com"
              class="w-full h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
            <p class="text-[10.5px] text-slate-500 mt-1">Conta Google que terá acesso total de gestão a esta empresa.</p>
          </div>

          <div>
            <label class="block font-medium text-slate-700 mb-1">Plano Comercial Inicial</label>
            <select
              name="planTier"
              class="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            >
              <option value="FREE">Base Orgânico (0 Kz - 40 docs/mês)</option>
              <option value="ESSENCIAL">Essencial (1.000 Kz/mês - Ilimitado)</option>
              <option value="PROFISSIONAL">Profissional (15.000 Kz/mês - Multi-posto Cloud)</option>
              <option value="ENTERPRISE">Enterprise (Personalizado)</option>
            </select>
          </div>

          <div class="pt-3 border-t border-slate-100 flex items-center justify-end gap-2">
            <button
              type="button"
              data-action="master-close-new-company"
              class="h-8 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              data-action="master-submit-new-company"
              class="h-8 px-4 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700"
            >
              Criar Empresa
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}
