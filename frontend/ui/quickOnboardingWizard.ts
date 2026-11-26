import { formatKzNumber } from '../../src/core/billingEngine';
import type {
  ImportDuplicateMode,
  StagedCustomerImportBatch,
  StagedProductImportBatch,
} from '../../src/core/spreadsheetImport';
import {
  VITRONIS_INSTITUTIONAL,
  type AppSettings,
  type CashSession,
  type CompanyRecord,
  type TaxRate,
} from '../../src/core/types';
import { ICONS } from './icons';

export type QuickWizardStep =
  | 'COMPANY'
  | 'PRODUCTS'
  | 'CUSTOMERS'
  | 'CASH_PRINTER'
  | 'READY';

export type QuickOnboardingModalMode =
  | 'WIZARD'
  | 'IMPORT_PRODUCTS'
  | 'IMPORT_CUSTOMERS';

export type ImportPreviewFilter = 'ALL' | 'VALID' | 'ERRORS';

export interface UndoableProductImportRecord {
  createdIds: string[];
  previousSnapshotsCount: number;
  summaryText: string;
}

export interface UndoableCustomerImportRecord {
  createdIds: string[];
  previousSnapshotsCount: number;
  summaryText: string;
}

export interface QuickOnboardingWizardProps {
  mode: QuickOnboardingModalMode;
  step: QuickWizardStep;
  hasActiveCompany: boolean;
  activeCompany: CompanyRecord;
  settings: AppSettings;
  productsCount: number;
  customersCount: number;
  openCashSession: CashSession | null;
  isSignedIn: boolean;
  isOnline: boolean;
  // Step 1 (Empresa)
  showCreateCompanyForm: boolean;
  isCreatingCompany: boolean;
  companyFormError: string | null;
  // Step 2 (Produtos)
  productBatch: StagedProductImportBatch | null;
  productDuplicateMode: ImportDuplicateMode;
  productDefaultIvaRate: TaxRate;
  productPreviewFilter: ImportPreviewFilter;
  productPreviewPage: number;
  productImportError: string | null;
  productImportNotice: string | null;
  isCommittingProducts: boolean;
  lastUndoableProductImport: UndoableProductImportRecord | null;
  // Step 3 (Clientes)
  customerBatch: StagedCustomerImportBatch | null;
  customerDuplicateMode: ImportDuplicateMode;
  customerPreviewFilter: ImportPreviewFilter;
  customerPreviewPage: number;
  customerImportError: string | null;
  customerImportNotice: string | null;
  isCommittingCustomers: boolean;
  lastUndoableCustomerImport: UndoableCustomerImportRecord | null;
  // Step 4 (Caixa e Impressora)
  cashPrinterError: string | null;
  cashPrinterNotice: string | null;
  // Permissões
  canCreateCompany: boolean;
  canManageProducts: boolean;
  canImportCustomers: boolean;
  canManageSettings: boolean;
  canOperateCash: boolean;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WIZARD_STEPS: ReadonlyArray<{ id: QuickWizardStep; num: string; label: string }> = [
  { id: 'COMPANY', num: '1', label: 'Empresa' },
  { id: 'PRODUCTS', num: '2', label: 'Produtos (Excel/CSV)' },
  { id: 'CUSTOMERS', num: '3', label: 'Clientes' },
  { id: 'CASH_PRINTER', num: '4', label: 'Caixa e Impressora' },
  { id: 'READY', num: '5', label: 'Vender' },
];

const PREVIEW_PAGE_SIZE = 40;

export function renderQuickOnboardingModal(props: QuickOnboardingWizardProps): string {
  const isWizard = props.mode === 'WIZARD';
  const title =
    props.mode === 'IMPORT_PRODUCTS'
      ? 'Importar Produtos por Excel / CSV'
      : props.mode === 'IMPORT_CUSTOMERS'
        ? 'Importar Clientes por Excel / CSV'
        : 'Entrada Rápida no Mercado (< 10 minutos)';

  const subtitle =
    props.mode === 'IMPORT_PRODUCTS'
      ? 'Carregue 500 ou 5.000 artigos com pré-visualização, validação de erros e controlo antes da confirmação.'
      : props.mode === 'IMPORT_CUSTOMERS'
        ? 'Importe a sua carteira de clientes com validação de NIF e pré-visualização antes de gravar.'
        : 'Crie a empresa, importe catálogo e clientes, configure caixa e impressora e comece a faturar.';

  let bodyHtml = '';
  if (props.mode === 'IMPORT_PRODUCTS') {
    bodyHtml = renderProductsImportStep(props, false);
  } else if (props.mode === 'IMPORT_CUSTOMERS') {
    bodyHtml = renderCustomersImportStep(props, false);
  } else {
    switch (props.step) {
      case 'COMPANY':
        bodyHtml = renderCompanyStep(props);
        break;
      case 'PRODUCTS':
        bodyHtml = renderProductsImportStep(props, true);
        break;
      case 'CUSTOMERS':
        bodyHtml = renderCustomersImportStep(props, true);
        break;
      case 'CASH_PRINTER':
        bodyHtml = renderCashPrinterStep(props);
        break;
      case 'READY':
        bodyHtml = renderReadyStep(props);
        break;
    }
  }

  return `
    <div class="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-2 sm:p-4">
      <div class="bg-white text-slate-900 rounded-xl border border-slate-200 w-full max-w-5xl max-h-[94dvh] flex flex-col overflow-hidden shadow-2xl">
        <!-- Cabeçalho -->
        <div class="px-4 sm:px-5 py-3.5 border-b border-slate-200 flex items-start justify-between gap-3 shrink-0 bg-white">
          <div class="min-w-0">
            <div class="text-[11px] font-semibold uppercase tracking-wide text-blue-700">
              ${isWizard ? 'Arranque Guiado · SILA-Billing' : 'Importação em Massa · SILA-Billing'}
            </div>
            <h2 class="text-base font-bold text-slate-900 tracking-tight truncate">${escapeHtml(title)}</h2>
            <p class="text-xs text-slate-500 mt-0.5">${escapeHtml(subtitle)}</p>
          </div>
          <button
            type="button"
            data-action="close-quick-onboarding-wizard"
            aria-label="Fechar assistente"
            class="h-9 w-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          >${ICONS.close}</button>
        </div>

        ${
          isWizard
            ? `<div class="px-4 sm:px-5 py-2.5 border-b border-slate-200 bg-slate-50/80 flex items-center gap-1.5 overflow-x-auto shrink-0">
                ${WIZARD_STEPS.map((st, idx) => {
                  const active = props.step === st.id;
                  const disabled = st.id !== 'COMPANY' && !props.hasActiveCompany;
                  const stepIdx = WIZARD_STEPS.findIndex((s) => s.id === props.step);
                  const completed = !active && (idx < stepIdx || (st.id === 'COMPANY' && props.hasActiveCompany));
                  return `
                    <button
                      type="button"
                      data-action="quick-wizard-go-step"
                      data-value="${st.id}"
                      ${disabled ? 'disabled' : ''}
                      class="h-9 px-3 rounded-lg text-xs font-medium flex items-center gap-2 border transition-colors whitespace-nowrap shrink-0 tabular-nums disabled:opacity-40 ${
                        active
                          ? 'bg-slate-900 text-white border-slate-900 font-semibold'
                          : completed
                            ? 'bg-white text-emerald-800 border-emerald-200 hover:bg-emerald-50/60'
                            : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-100'
                      }"
                    >
                      <span class="font-mono text-[11px] ${
                        active ? 'text-blue-300' : completed ? 'text-emerald-600' : 'text-slate-400'
                      }">${completed ? ICONS.check : `${st.num}.`}</span>
                      <span>${escapeHtml(st.label)}</span>
                    </button>
                  `;
                }).join('')}
              </div>`
            : ''
        }

        <!-- Corpo rolável -->
        <div class="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `;
}

function renderCompanyStep(props: QuickOnboardingWizardProps): string {
  const showForm = !props.hasActiveCompany || props.showCreateCompanyForm;

  return `
    <div class="space-y-4">
      ${
        props.hasActiveCompany && !props.showCreateCompanyForm
          ? `<div class="rounded-xl border border-slate-200 bg-slate-50/70 p-4 sm:p-5 space-y-4">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div>
                  <div class="text-xs font-semibold text-emerald-700 flex items-center gap-1.5">
                    ${ICONS.check}
                    <span>Empresa activa configurada e pronta</span>
                  </div>
                  <h3 class="text-base font-bold text-slate-900 mt-1">${escapeHtml(
                    props.settings.company.legalName || props.activeCompany.profile.legalName
                  )}</h3>
                  <p class="text-xs text-slate-600 font-mono tabular-nums mt-0.5">
                    NIF ${escapeHtml(props.settings.company.nif)} · Regime ${escapeHtml(
                      props.settings.company.taxRegime || 'GERAL'
                    )} · ${escapeHtml(props.settings.company.cityCountry)}
                  </p>
                </div>
                <div class="flex flex-wrap items-center gap-2 shrink-0">
                  ${
                    props.canCreateCompany
                      ? `<button
                          type="button"
                          data-action="quick-wizard-toggle-new-company"
                          class="h-10 px-3.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                        >Criar outra empresa</button>`
                      : ''
                  }
                  <button
                    type="button"
                    data-action="quick-wizard-go-step"
                    data-value="PRODUCTS"
                    class="h-10 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <span>Continuar para Produtos</span>
                    ${ICONS.chevronRight}
                  </button>
                </div>
              </div>
            </div>`
          : ''
      }

      ${
        showForm
          ? `<form data-form="quick-wizard-company-form" class="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-3.5">
              <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
                <div>
                  <h3 class="text-sm font-bold text-slate-900">1. Criar Empresa</h3>
                  <p class="text-xs text-slate-500">1 NIF cria 1 empresa com numeração e catálogo próprios. Inicia em Simulação.</p>
                </div>
                ${
                  props.hasActiveCompany
                    ? `<button
                        type="button"
                        data-action="quick-wizard-toggle-new-company"
                        class="h-8 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 whitespace-nowrap"
                      >Usar empresa actual</button>`
                    : ''
                }
              </div>

              ${
                props.companyFormError
                  ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
                      props.companyFormError
                    )}</div>`
                  : ''
              }

              ${
                !props.isSignedIn
                  ? `<div class="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-900 flex flex-wrap items-center justify-between gap-2">
                      <span>Sem sessão Google, a empresa funciona normalmente neste dispositivo offline.</span>
                      <button
                        type="button"
                        data-action="signin-google"
                        ${!props.isOnline ? 'disabled' : ''}
                        class="h-8 px-3 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                      >Entrar Google</button>
                    </div>`
                  : ''
              }

              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div class="sm:col-span-2">
                  <label class="block text-xs font-medium text-slate-700 mb-1">Denominação Social *</label>
                  <input
                    name="legalName"
                    type="text"
                    required
                    maxlength="160"
                    placeholder="Ex: Kiala Comercial, Lda"
                    class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">Nome Comercial / Loja *</label>
                  <input
                    name="shortName"
                    type="text"
                    required
                    maxlength="64"
                    placeholder="Ex: Loja Kiala"
                    class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">NIF Empresarial (Único) *</label>
                  <input
                    name="nif"
                    type="text"
                    required
                    maxlength="20"
                    placeholder="Ex: 5401122330"
                    class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">Regime de IVA *</label>
                  <select
                    name="taxRegime"
                    required
                    class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
                  >
                    <option value="" selected disabled>Seleccionar regime de IVA...</option>
                    <option value="GERAL">Regime Geral de IVA (14%)</option>
                    <option value="SIMPLIFICADO">Regime Simplificado de IVA</option>
                    <option value="EXCLUSAO">Regime de Exclusão de IVA</option>
                  </select>
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">Cidade / Província</label>
                  <input
                    name="cityCountry"
                    type="text"
                    maxlength="80"
                    value="Luanda - Angola"
                    class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">Telefone</label>
                  <input
                    name="phone"
                    type="text"
                    maxlength="40"
                    placeholder="(+244) 9..."
                    class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div>
                  <label class="block text-xs font-medium text-slate-700 mb-1">Endereço Fiscal</label>
                  <input
                    name="address"
                    type="text"
                    maxlength="160"
                    placeholder="Rua / Bairro / Município"
                    class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                </div>
              </div>

              <label class="flex items-start gap-2 pt-2 border-t border-slate-100 text-xs text-slate-600 leading-snug cursor-pointer select-none">
                <input
                  name="acceptTerms"
                  type="checkbox"
                  required
                  checked
                  class="h-4 w-4 mt-0.5 rounded border-slate-300 text-blue-600 shrink-0"
                />
                <span>
                  Declaro aceitar os termos operacionais do <strong>SILA-Billing</strong> (${escapeHtml(
                    VITRONIS_INSTITUTIONAL.legalName
                  )} · NIF ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}).
                </span>
              </label>

              <div class="flex flex-wrap items-center justify-end gap-2 pt-2">
                <button
                  type="submit"
                  ${props.isCreatingCompany ? 'disabled' : ''}
                  class="h-10 px-5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <span>${props.isCreatingCompany ? 'A criar empresa...' : 'Criar Empresa e Avançar'}</span>
                  ${ICONS.chevronRight}
                </button>
              </div>
            </form>`
          : ''
      }
    </div>
  `;
}

function renderProductsImportStep(props: QuickOnboardingWizardProps, isWizard: boolean): string {
  const batch = props.productBatch;
  const excludedSet = new Set(batch?.excludedRowNumbers || []);

  const readyRowsCount = batch
    ? batch.rows.filter(
        (r) => (r.status === 'NEW' || r.status === 'UPDATE') && !excludedSet.has(r.rowNumber)
      ).length
    : 0;

  const filteredRows = batch
    ? batch.rows.filter((r) => {
        if (props.productPreviewFilter === 'ERRORS') return r.status === 'ERROR';
        if (props.productPreviewFilter === 'VALID') {
          return (r.status === 'NEW' || r.status === 'UPDATE') && !excludedSet.has(r.rowNumber);
        }
        return true;
      })
    : [];

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, props.productPreviewPage), totalPages);
  const startIdx = (currentPage - 1) * PREVIEW_PAGE_SIZE;
  const visibleRows = filteredRows.slice(startIdx, startIdx + PREVIEW_PAGE_SIZE);

  return `
    <div class="space-y-4">
      ${
        props.productImportNotice
          ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 font-medium">
                ${ICONS.check}
                <span>${escapeHtml(props.productImportNotice)}</span>
              </div>
              ${
                props.lastUndoableProductImport
                  ? `<button
                      type="button"
                      data-action="undo-last-product-import"
                      class="h-8 px-3 rounded-md border border-emerald-300 bg-white text-emerald-900 hover:bg-emerald-100 text-xs font-semibold whitespace-nowrap"
                    >Desfazer última importação</button>`
                  : ''
              }
            </div>`
          : ''
      }

      ${
        props.productImportError
          ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
              props.productImportError
            )}</div>`
          : ''
      }

      <!-- Barra de Modelos, Opções e Carregamento de Ficheiro -->
      <div class="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-bold text-slate-900">Importar Produtos por Excel (.xlsx) ou CSV</h3>
            <p class="text-xs text-slate-500 mt-0.5">
              Suporta 500 a 5.000+ artigos offline. Colunas aceites: <span class="font-mono text-slate-700">codigo, nome, preco, custo, iva, codigo_isencao, categoria, unidade, tipo, codigo_barras, controlar_stock, stock, stock_minimo</span>.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              data-action="download-products-template-xlsx"
              class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap"
            >
              ${ICONS.download}
              <span>Modelo .XLSX</span>
            </button>
            <button
              type="button"
              data-action="download-products-template-csv"
              class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap"
            >
              ${ICONS.download}
              <span>Modelo .CSV</span>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-2 border-t border-slate-200/80">
          <label class="block">
            <span class="block text-[11px] font-medium text-slate-700 mb-1">Se o código já existir</span>
            <select
              id="quick-import-product-dup-mode"
              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
            >
              <option value="SKIP" ${props.productDuplicateMode === 'SKIP' ? 'selected' : ''}>Ignorar duplicados (manter actual)</option>
              <option value="UPDATE" ${props.productDuplicateMode === 'UPDATE' ? 'selected' : ''}>Actualizar preços e dados existentes</option>
            </select>
          </label>

          <label class="block">
            <span class="block text-[11px] font-medium text-slate-700 mb-1">IVA padrão (quando omitido na folha)</span>
            <select
              id="quick-import-product-default-iva"
              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
            >
              <option value="14" ${props.productDefaultIvaRate === 14 ? 'selected' : ''}>14% — Taxa Geral</option>
              <option value="7" ${props.productDefaultIvaRate === 7 ? 'selected' : ''}>7% — Taxa Reduzida</option>
              <option value="5" ${props.productDefaultIvaRate === 5 ? 'selected' : ''}>5% — Cesta Básica</option>
              <option value="1" ${props.productDefaultIvaRate === 1 ? 'selected' : ''}>1% — Regime Cabinda</option>
              <option value="0" ${props.productDefaultIvaRate === 0 ? 'selected' : ''}>0% — Isento / Não Sujeito</option>
            </select>
          </label>

          <div class="flex items-end">
            <label class="w-full h-9 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap">
              ${ICONS.upload}
              <span>${batch ? 'Carregar outro ficheiro' : 'Escolher Excel / CSV'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                data-action="upload-products-spreadsheet"
                class="hidden"
              />
            </label>
          </div>
        </div>
      </div>

      ${
        batch
          ? `<div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <!-- Resumo da pré-visualização -->
              <div class="p-3.5 border-b border-slate-200 bg-slate-50/70 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div class="space-y-1">
                  <div class="text-xs font-bold text-slate-900">
                    Pré-visualização: ${escapeHtml(batch.fileName)}
                  </div>
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span class="text-slate-600">Lidas: <strong class="text-slate-900 font-mono">${batch.totalRows}</strong></span>
                    <span class="text-emerald-700">Novos: <strong class="font-mono">${batch.newCount}</strong></span>
                    ${
                      batch.updateCount > 0
                        ? `<span class="text-blue-700">Actualizar: <strong class="font-mono">${batch.updateCount}</strong></span>`
                        : ''
                    }
                    ${
                      batch.errorCount > 0
                        ? `<span class="text-red-700">Com erros: <strong class="font-mono">${batch.errorCount}</strong></span>`
                        : `<span class="text-slate-500">Erros: <strong class="font-mono">0</strong></span>`
                    }
                    ${
                      batch.duplicateSkipCount > 0
                        ? `<span class="text-amber-700">Duplicados ignorados: <strong class="font-mono">${batch.duplicateSkipCount}</strong></span>`
                        : ''
                    }
                    ${
                      excludedSet.size > 0
                        ? `<span class="text-slate-600">Desmarcados por si: <strong class="font-mono">${excludedSet.size}</strong></span>`
                        : ''
                    }
                  </div>
                </div>

                <!-- Filtros da pré-visualização -->
                <div class="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg shrink-0">
                  ${(
                    [
                      { id: 'ALL', label: `Todos (${batch.totalRows})` },
                      { id: 'VALID', label: `Prontos (${readyRowsCount})` },
                      { id: 'ERRORS', label: `Erros (${batch.errorCount})` },
                    ] as const
                  )
                    .map(
                      (tab) => `
                      <button
                        type="button"
                        data-action="set-product-import-filter"
                        data-value="${tab.id}"
                        class="h-8 px-2.5 rounded-md text-xs font-medium tabular-nums whitespace-nowrap ${
                          props.productPreviewFilter === tab.id
                            ? 'bg-white text-slate-900 shadow-xs font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }"
                      >${tab.label}</button>
                    `
                    )
                    .join('')}
                </div>
              </div>

              <!-- Tabela paginada (40 linhas por página para fluidez a 5.000+ linhas) -->
              <div class="overflow-x-auto max-h-[320px] overflow-y-auto">
                <table class="w-full text-left border-collapse text-xs">
                  <thead class="sticky top-0 bg-slate-100 text-slate-600 border-b border-slate-200 z-10">
                    <tr>
                      <th class="py-2 px-2.5 font-semibold w-14">Incluir</th>
                      <th class="py-2 px-2.5 font-semibold w-14">Linha</th>
                      <th class="py-2 px-2.5 font-semibold w-24">Estado</th>
                      <th class="py-2 px-2.5 font-semibold">Código</th>
                      <th class="py-2 px-2.5 font-semibold">Artigo</th>
                      <th class="py-2 px-2.5 font-semibold text-right">Preço (Kz)</th>
                      <th class="py-2 px-2.5 font-semibold text-right">IVA</th>
                      <th class="py-2 px-2.5 font-semibold text-right">Stock</th>
                      <th class="py-2 px-2.5 font-semibold">Validação</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 tabular-nums">
                    ${
                      visibleRows.length === 0
                        ? `<tr><td colspan="9" class="py-8 text-center text-slate-500">Nenhuma linha corresponde ao filtro seleccionado.</td></tr>`
                        : visibleRows
                            .map((r) => {
                              const isExcluded = excludedSet.has(r.rowNumber);
                              const canToggle = r.status === 'NEW' || r.status === 'UPDATE';
                              const statusLabel = isExcluded
                                ? 'Desmarcado'
                                : r.status === 'NEW'
                                  ? 'Novo'
                                  : r.status === 'UPDATE'
                                    ? 'Actualizar'
                                    : r.status === 'ERROR'
                                      ? 'Erro'
                                      : 'Ignorado';
                              const statusColor = isExcluded
                                ? 'text-slate-500'
                                : r.status === 'NEW'
                                  ? 'text-emerald-700 font-semibold'
                                  : r.status === 'UPDATE'
                                    ? 'text-blue-700 font-semibold'
                                    : r.status === 'ERROR'
                                      ? 'text-red-700 font-semibold'
                                      : 'text-amber-700';

                              const note =
                                r.errors.length > 0
                                  ? r.errors.join(' ')
                                  : r.warnings.length > 0
                                    ? r.warnings.join(' ')
                                    : 'Válido';

                              return `
                                <tr class="${r.status === 'ERROR' ? 'bg-red-50/40' : isExcluded ? 'opacity-50 bg-slate-50' : 'hover:bg-slate-50'}">
                                  <td class="py-2 px-2.5">
                                    ${
                                      canToggle
                                        ? `<button
                                            type="button"
                                            data-action="toggle-product-import-row"
                                            data-id="${r.rowNumber}"
                                            class="h-7 px-2 rounded border text-[11px] font-medium whitespace-nowrap ${
                                              isExcluded
                                                ? 'border-slate-300 bg-white text-slate-700'
                                                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                                            }"
                                          >${isExcluded ? 'Restaurar' : 'Excluir'}</button>`
                                        : '<span class="text-slate-300">—</span>'
                                    }
                                  </td>
                                  <td class="py-2 px-2.5 font-mono text-slate-500">#${r.rowNumber}</td>
                                  <td class="py-2 px-2.5 ${statusColor}">${statusLabel}</td>
                                  <td class="py-2 px-2.5 font-mono text-slate-700">${escapeHtml(r.rawCode || '—')}</td>
                                  <td class="py-2 px-2.5 font-medium text-slate-900 max-w-[220px] truncate">${escapeHtml(r.rawName || '—')}</td>
                                  <td class="py-2 px-2.5 font-mono text-right text-slate-900">${
                                    r.product ? formatKzNumber(r.product.price) : escapeHtml(r.rawPrice || '—')
                                  }</td>
                                  <td class="py-2 px-2.5 font-mono text-right text-slate-700">${escapeHtml(r.rawIva)}%</td>
                                  <td class="py-2 px-2.5 font-mono text-right text-slate-700">${escapeHtml(r.rawStock)}</td>
                                  <td class="py-2 px-2.5 ${r.errors.length > 0 ? 'text-red-700 font-medium' : 'text-slate-500'}">${escapeHtml(note)}</td>
                                </tr>
                              `;
                            })
                            .join('')
                    }
                  </tbody>
                </table>
              </div>

              <!-- Paginação e Acções Pré-Confirmação (Desfazer vs Confirmar) -->
              <div class="p-3.5 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
                  <span>Página ${currentPage} de ${totalPages} (${filteredRows.length} linhas)</span>
                  ${
                    totalPages > 1
                      ? `<button
                          type="button"
                          data-action="product-import-prev-page"
                          ${currentPage <= 1 ? 'disabled' : ''}
                          class="h-8 px-2.5 rounded border border-slate-200 bg-white text-slate-700 disabled:opacity-40"
                        >Anterior</button>
                        <button
                          type="button"
                          data-action="product-import-next-page"
                          ${currentPage >= totalPages ? 'disabled' : ''}
                          class="h-8 px-2.5 rounded border border-slate-200 bg-white text-slate-700 disabled:opacity-40"
                        >Próxima</button>`
                      : ''
                  }
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-action="discard-product-import-stage"
                    class="h-10 px-3.5 rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${ICONS.reset}
                    <span>Desfazer carregamento</span>
                  </button>
                  <button
                    type="button"
                    data-action="confirm-product-import"
                    ${readyRowsCount === 0 || props.isCommittingProducts || !props.canManageProducts ? 'disabled' : ''}
                    class="h-10 px-4 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap tabular-nums"
                  >
                    ${ICONS.check}
                    <span>${
                      props.isCommittingProducts
                        ? 'A gravar artigos...'
                        : `Confirmar Importação (${readyRowsCount} artigos)`
                    }</span>
                  </button>
                </div>
              </div>
            </div>`
          : `<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-6 text-center text-xs text-slate-500">
              Catálogo actual: <strong class="text-slate-800 font-mono tabular-nums">${props.productsCount}</strong> artigo(s). Carregue uma folha Excel (.xlsx) ou CSV para pré-visualizar e validar antes de confirmar.
            </div>`
      }

      ${
        isWizard
          ? `<div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                data-action="quick-wizard-go-step"
                data-value="COMPANY"
                class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >← Empresa</button>
              <button
                type="button"
                data-action="quick-wizard-go-step"
                data-value="CUSTOMERS"
                class="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>Avançar para Clientes</span>
                ${ICONS.chevronRight}
              </button>
            </div>`
          : `<div class="flex justify-end pt-2 border-t border-slate-200">
              <button
                type="button"
                data-action="close-quick-onboarding-wizard"
                class="h-10 px-4 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >Fechar</button>
            </div>`
      }
    </div>
  `;
}

function renderCustomersImportStep(props: QuickOnboardingWizardProps, isWizard: boolean): string {
  const batch = props.customerBatch;
  const excludedSet = new Set(batch?.excludedRowNumbers || []);

  const readyRowsCount = batch
    ? batch.rows.filter(
        (r) => (r.status === 'NEW' || r.status === 'UPDATE') && !excludedSet.has(r.rowNumber)
      ).length
    : 0;

  const filteredRows = batch
    ? batch.rows.filter((r) => {
        if (props.customerPreviewFilter === 'ERRORS') return r.status === 'ERROR';
        if (props.customerPreviewFilter === 'VALID') {
          return (r.status === 'NEW' || r.status === 'UPDATE') && !excludedSet.has(r.rowNumber);
        }
        return true;
      })
    : [];

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PREVIEW_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, props.customerPreviewPage), totalPages);
  const startIdx = (currentPage - 1) * PREVIEW_PAGE_SIZE;
  const visibleRows = filteredRows.slice(startIdx, startIdx + PREVIEW_PAGE_SIZE);

  return `
    <div class="space-y-4">
      ${
        props.customerImportNotice
          ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900 flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2 font-medium">
                ${ICONS.check}
                <span>${escapeHtml(props.customerImportNotice)}</span>
              </div>
              ${
                props.lastUndoableCustomerImport
                  ? `<button
                      type="button"
                      data-action="undo-last-customer-import"
                      class="h-8 px-3 rounded-md border border-emerald-300 bg-white text-emerald-900 hover:bg-emerald-100 text-xs font-semibold whitespace-nowrap"
                    >Desfazer última importação</button>`
                  : ''
              }
            </div>`
          : ''
      }

      ${
        props.customerImportError
          ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
              props.customerImportError
            )}</div>`
          : ''
      }

      <div class="rounded-xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
        <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 class="text-sm font-bold text-slate-900">Importar Clientes por Excel (.xlsx) ou CSV</h3>
            <p class="text-xs text-slate-500 mt-0.5">
              Colunas aceites: <span class="font-mono text-slate-700">nome, tipo, nif, telefone, email, morada, localidade, provincia, municipio, limite_credito, prazo</span>.
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              data-action="download-customers-template-xlsx"
              class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap"
            >
              ${ICONS.download}
              <span>Modelo .XLSX</span>
            </button>
            <button
              type="button"
              data-action="download-customers-template-csv"
              class="h-9 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 whitespace-nowrap"
            >
              ${ICONS.download}
              <span>Modelo .CSV</span>
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-2 border-t border-slate-200/80">
          <label class="block">
            <span class="block text-[11px] font-medium text-slate-700 mb-1">Se o NIF/Cliente já existir</span>
            <select
              id="quick-import-customer-dup-mode"
              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
            >
              <option value="SKIP" ${props.customerDuplicateMode === 'SKIP' ? 'selected' : ''}>Ignorar duplicados</option>
              <option value="UPDATE" ${props.customerDuplicateMode === 'UPDATE' ? 'selected' : ''}>Actualizar dados existentes</option>
            </select>
          </label>

          <div class="flex items-end">
            <label class="w-full h-9 px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap">
              ${ICONS.upload}
              <span>${batch ? 'Carregar outro ficheiro' : 'Escolher Excel / CSV'}</span>
              <input
                type="file"
                accept=".xlsx,.csv,.tsv,.txt"
                data-action="upload-customers-spreadsheet"
                class="hidden"
              />
            </label>
          </div>
        </div>
      </div>

      ${
        batch
          ? `<div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div class="p-3.5 border-b border-slate-200 bg-slate-50/70 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div class="space-y-1">
                  <div class="text-xs font-bold text-slate-900">Pré-visualização: ${escapeHtml(batch.fileName)}</div>
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs tabular-nums">
                    <span class="text-slate-600">Lidas: <strong class="text-slate-900 font-mono">${batch.totalRows}</strong></span>
                    <span class="text-emerald-700">Novos: <strong class="font-mono">${batch.newCount}</strong></span>
                    ${
                      batch.updateCount > 0
                        ? `<span class="text-blue-700">Actualizar: <strong class="font-mono">${batch.updateCount}</strong></span>`
                        : ''
                    }
                    <span class="${batch.errorCount > 0 ? 'text-red-700' : 'text-slate-500'}">Erros: <strong class="font-mono">${batch.errorCount}</strong></span>
                    ${
                      batch.duplicateSkipCount > 0
                        ? `<span class="text-amber-700">Duplicados ignorados: <strong class="font-mono">${batch.duplicateSkipCount}</strong></span>`
                        : ''
                    }
                  </div>
                </div>

                <div class="flex items-center gap-1 bg-slate-200/70 p-0.5 rounded-lg shrink-0">
                  ${(
                    [
                      { id: 'ALL', label: `Todos (${batch.totalRows})` },
                      { id: 'VALID', label: `Prontos (${readyRowsCount})` },
                      { id: 'ERRORS', label: `Erros (${batch.errorCount})` },
                    ] as const
                  )
                    .map(
                      (tab) => `
                      <button
                        type="button"
                        data-action="set-customer-import-filter"
                        data-value="${tab.id}"
                        class="h-8 px-2.5 rounded-md text-xs font-medium tabular-nums whitespace-nowrap ${
                          props.customerPreviewFilter === tab.id
                            ? 'bg-white text-slate-900 shadow-xs font-semibold'
                            : 'text-slate-600 hover:text-slate-900'
                        }"
                      >${tab.label}</button>
                    `
                    )
                    .join('')}
                </div>
              </div>

              <div class="overflow-x-auto max-h-[300px] overflow-y-auto">
                <table class="w-full text-left border-collapse text-xs">
                  <thead class="sticky top-0 bg-slate-100 text-slate-600 border-b border-slate-200 z-10">
                    <tr>
                      <th class="py-2 px-2.5 font-semibold w-14">Incluir</th>
                      <th class="py-2 px-2.5 font-semibold w-14">Linha</th>
                      <th class="py-2 px-2.5 font-semibold w-24">Estado</th>
                      <th class="py-2 px-2.5 font-semibold">Cliente</th>
                      <th class="py-2 px-2.5 font-semibold">NIF</th>
                      <th class="py-2 px-2.5 font-semibold">Telefone</th>
                      <th class="py-2 px-2.5 font-semibold">Localidade</th>
                      <th class="py-2 px-2.5 font-semibold">Validação</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-slate-100 tabular-nums">
                    ${
                      visibleRows.length === 0
                        ? `<tr><td colspan="8" class="py-8 text-center text-slate-500">Nenhuma linha corresponde ao filtro seleccionado.</td></tr>`
                        : visibleRows
                            .map((r) => {
                              const isExcluded = excludedSet.has(r.rowNumber);
                              const canToggle = r.status === 'NEW' || r.status === 'UPDATE';
                              const statusLabel = isExcluded
                                ? 'Desmarcado'
                                : r.status === 'NEW'
                                  ? 'Novo'
                                  : r.status === 'UPDATE'
                                    ? 'Actualizar'
                                    : r.status === 'ERROR'
                                      ? 'Erro'
                                      : 'Ignorado';
                              const statusColor = isExcluded
                                ? 'text-slate-500'
                                : r.status === 'NEW'
                                  ? 'text-emerald-700 font-semibold'
                                  : r.status === 'UPDATE'
                                    ? 'text-blue-700 font-semibold'
                                    : r.status === 'ERROR'
                                      ? 'text-red-700 font-semibold'
                                      : 'text-amber-700';

                              const note =
                                r.errors.length > 0
                                  ? r.errors.join(' ')
                                  : r.warnings.length > 0
                                    ? r.warnings.join(' ')
                                    : 'Válido';

                              return `
                                <tr class="${r.status === 'ERROR' ? 'bg-red-50/40' : isExcluded ? 'opacity-50 bg-slate-50' : 'hover:bg-slate-50'}">
                                  <td class="py-2 px-2.5">
                                    ${
                                      canToggle
                                        ? `<button
                                            type="button"
                                            data-action="toggle-customer-import-row"
                                            data-id="${r.rowNumber}"
                                            class="h-7 px-2 rounded border text-[11px] font-medium whitespace-nowrap ${
                                              isExcluded
                                                ? 'border-slate-300 bg-white text-slate-700'
                                                : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                                            }"
                                          >${isExcluded ? 'Restaurar' : 'Excluir'}</button>`
                                        : '<span class="text-slate-300">—</span>'
                                    }
                                  </td>
                                  <td class="py-2 px-2.5 font-mono text-slate-500">#${r.rowNumber}</td>
                                  <td class="py-2 px-2.5 ${statusColor}">${statusLabel}</td>
                                  <td class="py-2 px-2.5 font-medium text-slate-900 max-w-[200px] truncate">${escapeHtml(r.rawName || '—')}</td>
                                  <td class="py-2 px-2.5 font-mono text-slate-700">${escapeHtml(r.rawNif || '—')}</td>
                                  <td class="py-2 px-2.5 font-mono text-slate-700">${escapeHtml(r.rawPhone || '—')}</td>
                                  <td class="py-2 px-2.5 text-slate-700">${escapeHtml(r.rawCity || '—')}</td>
                                  <td class="py-2 px-2.5 ${r.errors.length > 0 ? 'text-red-700 font-medium' : 'text-slate-500'}">${escapeHtml(note)}</td>
                                </tr>
                              `;
                            })
                            .join('')
                    }
                  </tbody>
                </table>
              </div>

              <div class="p-3.5 border-t border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
                  <span>Página ${currentPage} de ${totalPages} (${filteredRows.length} linhas)</span>
                  ${
                    totalPages > 1
                      ? `<button
                          type="button"
                          data-action="customer-import-prev-page"
                          ${currentPage <= 1 ? 'disabled' : ''}
                          class="h-8 px-2.5 rounded border border-slate-200 bg-white text-slate-700 disabled:opacity-40"
                        >Anterior</button>
                        <button
                          type="button"
                          data-action="customer-import-next-page"
                          ${currentPage >= totalPages ? 'disabled' : ''}
                          class="h-8 px-2.5 rounded border border-slate-200 bg-white text-slate-700 disabled:opacity-40"
                        >Próxima</button>`
                      : ''
                  }
                </div>

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-action="discard-customer-import-stage"
                    class="h-10 px-3.5 rounded-lg border border-red-200 bg-white text-red-700 hover:bg-red-50 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${ICONS.reset}
                    <span>Desfazer carregamento</span>
                  </button>
                  <button
                    type="button"
                    data-action="confirm-customer-import"
                    ${readyRowsCount === 0 || props.isCommittingCustomers || !props.canImportCustomers ? 'disabled' : ''}
                    class="h-10 px-4 rounded-lg bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap tabular-nums"
                  >
                    ${ICONS.check}
                    <span>${
                      props.isCommittingCustomers
                        ? 'A gravar clientes...'
                        : `Confirmar Importação (${readyRowsCount} clientes)`
                    }</span>
                  </button>
                </div>
              </div>
            </div>`
          : `<div class="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-6 text-center text-xs text-slate-500">
              Clientes registados: <strong class="text-slate-800 font-mono tabular-nums">${props.customersCount}</strong> (inclui Consumidor Final). Opcional para venda a balcão — pode carregar um ficheiro ou avançar directamente.
            </div>`
      }

      ${
        isWizard
          ? `<div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                data-action="quick-wizard-go-step"
                data-value="PRODUCTS"
                class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >← Produtos</button>
              <button
                type="button"
                data-action="quick-wizard-go-step"
                data-value="CASH_PRINTER"
                class="h-10 px-4 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 whitespace-nowrap"
              >
                <span>Avançar para Caixa e Impressora</span>
                ${ICONS.chevronRight}
              </button>
            </div>`
          : `<div class="flex justify-end pt-2 border-t border-slate-200">
              <button
                type="button"
                data-action="close-quick-onboarding-wizard"
                class="h-10 px-4 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >Fechar</button>
            </div>`
      }
    </div>
  `;
}

function renderCashPrinterStep(props: QuickOnboardingWizardProps): string {
  const { settings, openCashSession } = props;

  return `
    <form data-form="quick-wizard-cash-printer-form" class="space-y-4">
      ${
        props.cashPrinterNotice
          ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-900 flex items-center gap-2 font-medium">
              ${ICONS.check}
              <span>${escapeHtml(props.cashPrinterNotice)}</span>
            </div>`
          : ''
      }
      ${
        props.cashPrinterError
          ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
              props.cashPrinterError
            )}</div>`
          : ''
      }

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <!-- Bloco Impressora e Formato -->
        <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
            <div class="flex items-center gap-2 text-xs font-bold text-slate-900">
              ${ICONS.printer}
              <span>Configurar Impressora e Emissão</span>
            </div>
            <button
              type="button"
              data-action="quick-wizard-test-print"
              class="h-8 px-2.5 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap"
            >
              ${ICONS.printer}
              <span>Testar Impressão</span>
            </button>
          </div>

          <div>
            <label class="block text-xs font-medium text-slate-700 mb-1">Formato Padrão de Impressão</label>
            <select
              name="defaultFormat"
              class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 text-slate-900"
            >
              <option value="POS" ${settings.defaultFormat === 'POS' ? 'selected' : ''}>Talão Térmico POS 80mm</option>
              <option value="A4" ${settings.defaultFormat === 'A4' ? 'selected' : ''}>Factura Formal Folha A4</option>
            </select>
          </div>

          <div class="grid grid-cols-2 gap-2.5">
            <div>
              <label class="block text-xs font-medium text-slate-700 mb-1">Caixa Padrão</label>
              <input
                name="defaultCashier"
                type="text"
                maxlength="16"
                value="${escapeHtml(settings.defaultCashier || '01')}"
                class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div>
              <label class="block text-xs font-medium text-slate-700 mb-1">Operador Padrão</label>
              <input
                name="defaultOperator"
                type="text"
                maxlength="32"
                value="${escapeHtml(settings.defaultOperator || '001')}"
                class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <label class="flex items-center gap-2 pt-1 text-xs text-slate-700 cursor-pointer select-none">
            <input
              name="autoPrintOnEmit"
              type="checkbox"
              ${settings.autoPrintOnEmit ? 'checked' : ''}
              class="h-4 w-4 rounded border-slate-300 text-blue-600"
            />
            <span>Abrir diálogo de impressão automaticamente ao emitir</span>
          </label>
        </div>

        <!-- Bloco Abertura de Turno de Caixa -->
        <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <div class="flex items-center gap-2 pb-2 border-b border-slate-100 text-xs font-bold text-slate-900">
            ${ICONS.wallet}
            <span>Estado do Turno de Caixa</span>
          </div>

          ${
            openCashSession
              ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50/70 space-y-1 text-xs">
                  <div class="font-semibold text-emerald-900 flex items-center gap-1.5">
                    ${ICONS.check}
                    <span>Caixa ${escapeHtml(openCashSession.cashier)} já está aberta</span>
                  </div>
                  <div class="text-emerald-800 font-mono tabular-nums">
                    Operador: ${escapeHtml(openCashSession.operator)} · Fundo inicial: ${formatKzNumber(
                      openCashSession.openingFloat
                    )} Kz
                  </div>
                </div>`
              : `<div class="space-y-3">
                  <p class="text-xs text-slate-600">
                    Ainda não há turno de caixa aberto. Pode abrir já com o fundo de troco inicial para começar a receber pagamentos no balcão.
                  </p>
                  <label class="flex items-center gap-2 text-xs font-medium text-slate-800 cursor-pointer select-none">
                    <input
                      name="openCashNow"
                      type="checkbox"
                      checked
                      class="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span>Abrir turno de caixa agora ao guardar</span>
                  </label>
                  <div>
                    <label class="block text-xs font-medium text-slate-700 mb-1">Fundo Inicial de Caixa / Trocos (Kz)</label>
                    <input
                      name="openingFloat"
                      type="text"
                      inputmode="decimal"
                      value="0"
                      placeholder="Ex: 15000"
                      class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                    />
                  </div>
                </div>`
          }
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
        <button
          type="button"
          data-action="quick-wizard-go-step"
          data-value="CUSTOMERS"
          class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
        >← Clientes</button>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            ${!props.canManageSettings && !props.canOperateCash ? 'disabled' : ''}
            class="h-10 px-5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
          >
            <span>Guardar e Concluir</span>
            ${ICONS.chevronRight}
          </button>
        </div>
      </div>
    </form>
  `;
}

function renderReadyStep(props: QuickOnboardingWizardProps): string {
  const formatLabel =
    props.settings.defaultFormat === 'A4' ? 'Factura Formal A4' : 'Talão Térmico POS 80mm';

  return `
    <div class="space-y-4">
      <div class="rounded-xl border border-emerald-200 bg-emerald-50/50 p-5 space-y-4">
        <div class="flex items-start gap-3">
          <div class="h-10 w-10 rounded-lg bg-emerald-600 text-white flex items-center justify-center shrink-0">
            ${ICONS.check}
          </div>
          <div>
            <h3 class="text-base font-bold text-slate-900">Operação pronta para vender</h3>
            <p class="text-xs text-slate-600 mt-0.5">
              A sua empresa está configurada e pronta para emitir documentos imediatos no balcão.
            </p>
          </div>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs tabular-nums">
          <div class="rounded-lg border border-slate-200 bg-white p-3">
            <div class="text-slate-500">Empresa</div>
            <div class="font-bold text-slate-900 truncate mt-0.5">${escapeHtml(
              props.settings.company.shortName
            )}</div>
            <div class="font-mono text-[11px] text-slate-500 mt-0.5">NIF ${escapeHtml(
              props.settings.company.nif
            )}</div>
          </div>
          <div class="rounded-lg border border-slate-200 bg-white p-3">
            <div class="text-slate-500">Catálogo Activo</div>
            <div class="font-bold font-mono text-base text-slate-900 mt-0.5">${props.productsCount}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">artigos disponíveis</div>
          </div>
          <div class="rounded-lg border border-slate-200 bg-white p-3">
            <div class="text-slate-500">Clientes</div>
            <div class="font-bold font-mono text-base text-slate-900 mt-0.5">${props.customersCount}</div>
            <div class="text-[11px] text-slate-500 mt-0.5">registados na base</div>
          </div>
          <div class="rounded-lg border border-slate-200 bg-white p-3">
            <div class="text-slate-500">Impressora &amp; Caixa</div>
            <div class="font-bold text-slate-900 mt-0.5">${escapeHtml(formatLabel)}</div>
            <div class="text-[11px] ${
              props.openCashSession ? 'text-emerald-700 font-medium' : 'text-slate-500'
            } mt-0.5">${
              props.openCashSession
                ? `Caixa ${escapeHtml(props.openCashSession.cashier)} aberta`
                : `Caixa padrão ${escapeHtml(props.settings.defaultCashier || '01')}`
            }</div>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
        <button
          type="button"
          data-action="quick-wizard-go-step"
          data-value="CASH_PRINTER"
          class="h-10 px-3.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
        >← Caixa e Impressora</button>

        <button
          type="button"
          data-action="quick-wizard-start-selling"
          class="h-11 px-6 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-bold flex items-center gap-2 whitespace-nowrap shadow-xs"
        >
          ${ICONS.shoppingCart}
          <span>Começar a Vender Agora</span>
        </button>
      </div>
    </div>
  `;
}
