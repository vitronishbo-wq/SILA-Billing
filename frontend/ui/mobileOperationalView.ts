import {
  calculateInvoiceTotals,
  formatDateTimePt,
  formatKzNumber,
  roundKz,
} from '../../src/core/billingEngine';
import {
  resolveActiveEstablishment,
} from '../../src/core/companyValidator';
import type { AgtSeriesRecord } from '../../src/core/fiscalTypes';
import {
  AppSettings,
  CartDraftItem,
  CompanyProfile,
  CompanyRecord,
  Customer,
  DEFAULT_IVA_EXEMPTION_REASONS,
  DEFAULT_PRODUCT_CATEGORIES,
  DEFAULT_PRODUCT_UNITS,
  DocumentType,
  EstablishmentRecord,
  InvoiceRecord,
  PaymentMethod,
  Product,
  TaxRate,
  WarehouseRecord,
} from '../../src/core/types';
import {
  CompanyMasterSectionTab,
  renderCompanyMasterSection,
} from './companyMasterForm';
import { ICONS } from './icons';

export type MobileTab = 'HOME' | 'SALE' | 'DOCS' | 'CUSTOMERS' | 'MORE' | 'PRODUCTS';
export type MobileCheckoutStep = 'CART' | 'PAYMENT' | 'SUCCESS';

export interface MobileOperationalProps {
  activeCompany: CompanyRecord;
  settings: AppSettings;
  companyMasterDraftProfile: CompanyProfile | null;
  companyMasterDraftSettings: Partial<AppSettings> | null;
  companyMasterSection: CompanyMasterSectionTab;
  companySeries: AgtSeriesRecord[];
  canManageCompanySettings: boolean;
  companyFormError: string | null;
  companyFormSavedNotice: boolean;
  showRequestAgtSeriesForm: boolean;
  confirmFinalizeSeriesId: string | null;
  agtSeriesErrorMessage: string | null;
  agtSeriesSuccessMessage: string | null;
  showEstablishmentForm: boolean;
  editingEstablishment: Partial<EstablishmentRecord> | null;
  establishmentError: string | null;
  showWarehouseForm: boolean;
  editingWarehouse: Partial<WarehouseRecord> | null;
  warehouseError: string | null;
  isOnline: boolean;
  user: { email?: string | null } | null;
  mobileTab: MobileTab;
  mobileCheckoutStep: MobileCheckoutStep;
  cart: CartDraftItem[];
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  selectedCustomerId: string;
  docType: DocumentType;
  paymentMethod: PaymentMethod;
  amountReceivedInput: string;
  mobileSearchQuery: string;
  mobileProductSearchInput: string;
  lastEmittedInvoice: InvoiceRecord | null;
  showQuickProductModal: boolean;
  showQuickCustomerModal: boolean;
  showQuickCompanyModal: boolean;
  showCustomerPickerModal: boolean;
  editingMobileProduct: Product | null;
  operator: string;
}

function escapeHtml(raw: string): string {
  return (raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMobileOperationalView(props: MobileOperationalProps): string {
  const { mobileTab, cart } = props;
  const cartItemCount = cart.reduce((acc, c) => acc + c.qty, 0);

  let mainContent = '';
  switch (mobileTab) {
    case 'HOME':
      mainContent = renderMobileHome(props);
      break;
    case 'SALE':
      mainContent = renderMobileSaleWorkspace(props);
      break;
    case 'DOCS':
      mainContent = renderMobileDocs(props);
      break;
    case 'CUSTOMERS':
      mainContent = renderMobileCustomers(props);
      break;
    case 'PRODUCTS':
      mainContent = renderMobileProducts(props);
      break;
    case 'MORE':
      mainContent = renderMobileMore(props);
      break;
  }

  // Auto-geração de código sugerido para novo artigo
  const nextSku = `ART${String(props.products.length + 1).padStart(4, '0')}`;

  return `
    <div class="h-dvh w-screen flex flex-col bg-slate-950 text-slate-100 overflow-hidden select-none">
      <!-- Conteúdo com scroll independente -->
      <div class="flex-1 overflow-y-auto overscroll-contain pb-20">
        ${mainContent}
      </div>

      <!-- Barra de Navegação Inferior Fixa (Thumb Zone - 5 destinos) -->
      ${renderMobileBottomNav(mobileTab, cartItemCount)}

      <!-- Modais Operacionais Mobile -->
      ${
        props.showQuickProductModal
          ? renderMobileProductModal(props.editingMobileProduct, nextSku)
          : ''
      }
      ${props.showQuickCustomerModal ? renderMobileQuickCustomerModal() : ''}
      ${props.showQuickCompanyModal ? renderMobileQuickCompanyModal(props) : ''}
      ${props.showCustomerPickerModal ? renderMobileCustomerPickerModal(props) : ''}
    </div>
  `;
}

// ==================== 1. ECRÃ PRINCIPAL (HOME HUB) ====================
function renderMobileHome(props: MobileOperationalProps): string {
  const { activeCompany, settings, isOnline, invoices } = props;
  const profile = settings.company;
  const companyName =
    profile.shortName ||
    profile.legalName ||
    activeCompany.profile?.shortName ||
    activeCompany.profile?.legalName ||
    'Nova Empresa';
  const activeEst = resolveActiveEstablishment(profile);
  const locality =
    profile.municipality ||
    profile.cityCountry ||
    profile.address ||
    activeCompany.profile?.cityCountry ||
    'Angola';
  const nif =
    profile.nif ||
    activeCompany.profile?.nif ||
    activeCompany.normalizedNif ||
    '---';
  const envLabel = profile.agtEnvironment === 'PRODUCAO' ? 'Produção AGT' : 'Simulação';

  // Métricas rápidas do dia
  const todayPrefix = new Date().toISOString().slice(0, 10);
  const todayInvoices = invoices.filter(
    (inv) => inv.issuedAtIso.slice(0, 10) === todayPrefix && inv.status !== 'cancelled'
  );
  const todayTotal = todayInvoices.reduce((acc, inv) => acc + inv.grandTotal, 0);

  return `
    <div class="p-4 flex flex-col gap-4 max-w-lg mx-auto">
      <!-- Top Bar: SILA-Billing + Status Online / Offline -->
      <header class="flex items-center justify-between pt-1">
        <h1 class="text-xl font-bold tracking-tight text-white flex items-center gap-2">
          <span>SILA-Billing</span>
          <span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 font-normal">POS</span>
        </h1>
        <button
          type="button"
          data-action="mobile-open-sync"
          class="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border ${
            isOnline
              ? 'bg-emerald-950/70 border-emerald-800/80 text-emerald-400'
              : 'bg-amber-950/70 border-amber-800/80 text-amber-400'
          } active:scale-95 transition-transform"
        >
          <span class="h-2 w-2 rounded-full ${isOnline ? 'bg-emerald-400' : 'bg-amber-400'}"></span>
          <span>${isOnline ? 'Online' : 'Offline'}</span>
        </button>
      </header>

      <!-- Cartão da Empresa Activa -->
      <section class="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-sm flex items-center justify-between gap-2">
        <div class="min-w-0">
          <span class="text-xs text-slate-400 font-medium block">Empresa activa · ${escapeHtml(envLabel)}</span>
          <h2 class="text-lg font-bold text-white tracking-tight mt-0.5 truncate">${escapeHtml(companyName)}</h2>
          <p class="text-xs text-slate-400 mt-0.5 font-mono tabular-nums truncate">${escapeHtml(activeEst.code)} · ${escapeHtml(locality)} · NIF ${escapeHtml(nif)}</p>
        </div>
        <button
          type="button"
          data-action="mobile-open-quick-company"
          class="h-10 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 flex items-center gap-1.5 active:scale-95 transition-all shrink-0"
        >
          ${ICONS.building}
          <span>Ficha</span>
        </button>
      </section>

      <!-- Secção "O que pretende fazer?" -->
      <section class="flex flex-col gap-3">
        <h3 class="text-lg font-bold text-white tracking-tight">O que pretende fazer?</h3>

        <!-- Grelha 2x2 com os 4 Botões Grandes -->
        <div class="grid grid-cols-2 gap-3">
          <!-- VENDER (Azul Vibrante em Destaque) -->
          <button
            type="button"
            data-action="mobile-go-sale"
            class="bg-blue-600 hover:bg-blue-500 active:scale-[0.98] rounded-2xl p-4 flex flex-col justify-between min-h-[116px] text-left shadow-lg shadow-blue-600/20 transition-all border border-blue-500/40"
          >
            <div class="h-8 w-8 rounded-lg bg-white/20 flex items-center justify-center text-white">
              ${ICONS.shoppingCart}
            </div>
            <div>
              <span class="text-base font-bold text-white tracking-wide block">VENDER</span>
              <span class="text-xs text-blue-100/90 mt-0.5 block">Iniciar nova venda</span>
            </div>
          </button>

          <!-- PRODUTOS (Gestão Completa de Artigos e Stock) -->
          <button
            type="button"
            data-action="mobile-go-products"
            class="bg-slate-900 hover:bg-slate-850 active:scale-[0.98] rounded-2xl p-4 flex flex-col justify-between min-h-[116px] text-left border border-slate-800/90 transition-all"
          >
            <div class="h-8 w-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-200">
              ${ICONS.package}
            </div>
            <div>
              <span class="text-base font-bold text-white tracking-wide block">PRODUTOS</span>
              <span class="text-xs text-slate-400 mt-0.5 block">Catálogo & Artigos (${props.products.length})</span>
            </div>
          </button>

          <!-- CLIENTES -->
          <button
            type="button"
            data-action="mobile-tab-customers"
            class="bg-slate-900 hover:bg-slate-850 active:scale-[0.98] rounded-2xl p-4 flex flex-col justify-between min-h-[116px] text-left border border-slate-800/90 transition-all"
          >
            <div class="h-8 w-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-200">
              ${ICONS.users}
            </div>
            <div>
              <span class="text-base font-bold text-white tracking-wide block">CLIENTES</span>
              <span class="text-xs text-slate-400 mt-0.5 block">Novo cliente / Lista</span>
            </div>
          </button>

          <!-- EMPRESA -->
          <button
            type="button"
            data-action="mobile-open-quick-company"
            class="bg-slate-900 hover:bg-slate-850 active:scale-[0.98] rounded-2xl p-4 flex flex-col justify-between min-h-[116px] text-left border border-slate-800/90 transition-all"
          >
            <div class="h-8 w-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-200">
              ${ICONS.building}
            </div>
            <div>
              <span class="text-base font-bold text-white tracking-wide block">EMPRESA</span>
              <span class="text-xs text-slate-400 mt-0.5 block">Dados e configuração</span>
            </div>
          </button>
        </div>

        <!-- Documentos (Card Horizontal de Largura Total) -->
        <button
          type="button"
          data-action="mobile-go-docs"
          class="bg-slate-900 hover:bg-slate-850 active:scale-[0.98] rounded-2xl p-4 flex items-center justify-between border border-slate-800/90 transition-all text-left"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-slate-800 flex items-center justify-center text-slate-200 shrink-0">
              ${ICONS.receipt}
            </div>
            <div>
              <span class="text-base font-bold text-white block">Documentos</span>
              <span class="text-xs text-slate-400 block mt-0.5">Consultar facturas e talões</span>
            </div>
          </div>
          <span class="text-slate-400">${ICONS.chevronRight}</span>
        </button>
      </section>

      <!-- Resumo Rápido de Vendas do Dia -->
      <section class="bg-slate-900/60 border border-slate-800/80 rounded-2xl p-3.5 flex items-center justify-between text-xs">
        <div>
          <span class="text-slate-400 block">Vendas hoje:</span>
          <span class="text-sm font-semibold text-white tabular-nums">${todayInvoices.length} ${todayInvoices.length === 1 ? 'documento' : 'documentos'}</span>
        </div>
        <div class="text-right">
          <span class="text-slate-400 block">Total faturado:</span>
          <span class="text-sm font-bold text-emerald-400 tabular-nums">${formatKzNumber(todayTotal)} Kz</span>
        </div>
      </section>
    </div>
  `;
}

// ==================== 2. ECRÃ COMPLETO DE PRODUTOS & STOCK (NOVO) ====================
function renderMobileProducts(props: MobileOperationalProps): string {
  const { products, mobileProductSearchInput } = props;
  const query = (mobileProductSearchInput || '').trim().toLowerCase();

  const filtered = query
    ? products.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.code.toLowerCase().includes(query) ||
          (p.barcode && p.barcode.toLowerCase().includes(query)) ||
          (p.category && p.category.toLowerCase().includes(query))
      )
    : products;

  return `
    <div class="p-3.5 flex flex-col gap-3 max-w-lg mx-auto">
      <!-- Top Bar: Voltar + Título + Cadastrar Novo Artigo -->
      <div class="flex items-center justify-between pb-1 border-b border-slate-800">
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-action="mobile-tab-home"
            class="h-9 w-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white active:scale-95"
            title="Voltar ao início"
          >
            ${ICONS.home}
          </button>
          <div>
            <h2 class="text-base font-bold text-white leading-tight">Artigos & Stock</h2>
            <span class="text-xs text-slate-400 font-mono tabular-nums">${products.length} cadastrados</span>
          </div>
        </div>

        <button
          type="button"
          data-action="mobile-open-quick-product"
          class="h-9 px-3 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-md shadow-blue-600/30 active:scale-95"
        >
          ${ICONS.plus}
          <span>Novo Artigo</span>
        </button>
      </div>

      <!-- Barra de Pesquisa de Artigos -->
      <div class="relative">
        <input
          type="text"
          id="mobile-product-search-input"
          value="${escapeHtml(mobileProductSearchInput)}"
          placeholder="Pesquisar por SKU, barras ou nome..."
          class="w-full h-11 pl-10 pr-9 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <span class="absolute left-3 top-3 text-slate-500 pointer-events-none">${ICONS.search}</span>
        ${
          mobileProductSearchInput
            ? `<button
                type="button"
                data-action="mobile-clear-product-search"
                class="absolute right-3 top-3 text-slate-400 hover:text-white"
              >${ICONS.close}</button>`
            : ''
        }
      </div>

      <!-- Lista de Artigos com Dados Completos -->
      <div class="flex flex-col gap-2.5">
        ${
          filtered.length === 0
            ? `<div class="p-8 text-center text-xs text-slate-500 bg-slate-900/40 rounded-2xl border border-slate-800/80">
                Nenhum artigo encontrado. Clique em "+ Novo Artigo" para cadastrar.
              </div>`
            : filtered.map((p) => {
                const cost = p.costPrice || 0;
                const profit = cost > 0 ? roundKz(p.price - cost) : 0;
                const marginPct = cost > 0 && p.price > 0 ? roundKz((profit / p.price) * 100) : 0;
                const markupPct = cost > 0 ? roundKz((profit / cost) * 100) : 0;
                const isBelowCost = cost > 0 && p.price < cost;

                return `
                  <div class="bg-slate-900 border ${
                    p.active === false ? 'border-red-950/60 opacity-70' : 'border-slate-800'
                  } rounded-2xl p-3.5 flex flex-col gap-2.5 shadow-sm">
                    <!-- Linha 1: SKU, Código de Barras, Categoria e Estado Activo -->
                    <div class="flex items-center justify-between gap-2 text-xs">
                      <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                        <span class="font-mono font-bold text-white bg-slate-800 px-2 py-0.5 rounded text-[11px]">
                          ${escapeHtml(p.code)}
                        </span>
                        ${
                          p.barcode
                            ? `<span class="font-mono text-slate-400 text-[10px] bg-slate-800/60 px-1.5 py-0.5 rounded truncate max-w-[120px]">
                                ${escapeHtml(p.barcode)}
                              </span>`
                            : ''
                        }
                        <span class="text-slate-400 text-[11px] truncate">· ${escapeHtml(p.category || 'Geral')}</span>
                      </div>

                      <button
                        type="button"
                        data-action="mobile-toggle-product-active"
                        data-product-id="${escapeHtml(p.id)}"
                        class="text-[10px] font-semibold px-2 py-0.5 rounded transition-colors shrink-0 ${
                          p.active !== false
                            ? 'bg-emerald-950/70 border border-emerald-800/70 text-emerald-400'
                            : 'bg-red-950/70 border border-red-900/70 text-red-400'
                        }"
                      >
                        ${p.active !== false ? 'Activo' : 'Inactivo'}
                      </button>
                    </div>

                    <!-- Linha 2: Nome do Produto e Unidade -->
                    <div>
                      <h3 class="text-sm font-bold text-white leading-snug">${escapeHtml(p.name)}</h3>
                      <p class="text-[11px] text-slate-400 mt-0.5">
                        Unidade: <strong class="text-slate-300 font-mono">${escapeHtml(p.unit)}</strong> · Regime: <strong class="text-slate-300">${p.ivaRate}% ${p.ivaRate === 0 ? `(${escapeHtml(p.exemptionReason || 'Isento')})` : 'IVA'}</strong>
                      </p>
                    </div>

                    <!-- Linha 3: Preço de Venda, Preço de Custo e Margem de Lucro -->
                    <div class="bg-slate-950/80 rounded-xl p-2.5 flex items-center justify-between text-xs border border-slate-800/70">
                      <div>
                        <span class="text-[10px] text-slate-400 block uppercase tracking-wider">Venda (Kz)</span>
                        <span class="text-base font-extrabold text-blue-400 font-mono tabular-nums">
                          ${formatKzNumber(p.price)} Kz
                        </span>
                      </div>

                      ${
                        cost > 0
                          ? `
                          <div class="text-right">
                            <span class="text-[10px] text-slate-400 block uppercase tracking-wider">Custo: ${formatKzNumber(cost)} Kz</span>
                            <span class="text-xs font-bold font-mono tabular-nums ${
                              isBelowCost ? 'text-red-400' : 'text-emerald-400'
                            }">
                              ${profit >= 0 ? '+' : ''}${formatKzNumber(profit)} Kz (${marginPct.toFixed(1)}% margem)
                            </span>
                          </div>
                        `
                          : `
                          <div class="text-right text-[11px] text-slate-500">
                            Sem custo registado
                          </div>
                        `
                      }
                    </div>

                    <!-- Linha 4: Informação de Stock e Ações -->
                    <div class="flex items-center justify-between pt-1 border-t border-slate-800/80 text-xs">
                      <div>
                        ${
                          p.trackStock
                            ? `<span class="text-[11px] font-mono tabular-nums ${
                                (p.stockQty || 0) <= (p.minStockQty || 0)
                                  ? 'text-amber-400 font-semibold'
                                  : 'text-slate-300'
                              }">
                                Stock: <strong>${p.stockQty || 0}</strong> ${escapeHtml(p.unit)}
                                ${(p.stockQty || 0) <= (p.minStockQty || 0) ? ' · ⚠️ Baixo' : ''}
                              </span>`
                            : `<span class="text-[11px] text-slate-500">Sem controlo de stock</span>`
                        }
                      </div>

                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          data-action="mobile-edit-product"
                          data-product-id="${escapeHtml(p.id)}"
                          class="h-8 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium flex items-center gap-1 active:scale-95"
                        >
                          ${ICONS.edit}
                          <span>Editar</span>
                        </button>

                        <button
                          type="button"
                          data-action="mobile-add-product"
                          data-product-id="${escapeHtml(p.id)}"
                          class="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 active:scale-95"
                        >
                          ${ICONS.plus}
                          <span>Vender</span>
                        </button>
                      </div>
                    </div>
                  </div>
                `;
              }).join('')
        }
      </div>
    </div>
  `;
}

// ==================== 3. ECRÃ DE FATURAÇÃO OPERACIONAL (MOBILE POS) ====================
function renderMobileSaleWorkspace(props: MobileOperationalProps): string {
  const { mobileCheckoutStep } = props;
  if (mobileCheckoutStep === 'PAYMENT') {
    return renderMobilePaymentStep(props);
  }
  if (mobileCheckoutStep === 'SUCCESS') {
    return renderMobileSuccessStep(props);
  }
  return renderMobileCartStep(props);
}

function renderMobileCartStep(props: MobileOperationalProps): string {
  const {
    cart,
    products,
    customers,
    selectedCustomerId,
    mobileProductSearchInput,
  } = props;

  const totals = calculateInvoiceTotals(cart, 0);
  const activeCustomer =
    customers.find((c) => c.id === selectedCustomerId) ||
    customers[0] || {
      id: 'cust_direct',
      name: 'Consumidor final',
      nif: '999999999',
    };

  // Filtragem de produtos para pesquisa no telemóvel
  const query = (mobileProductSearchInput || '').trim().toLowerCase();
  const searchResults = query
    ? products
        .filter(
          (p) =>
            p.active !== false &&
            (p.name.toLowerCase().includes(query) ||
              p.code.toLowerCase().includes(query) ||
              (p.barcode && p.barcode.toLowerCase().includes(query)))
        )
        .slice(0, 10)
    : [];

  const popularProducts = !query ? products.filter((p) => p.active !== false).slice(0, 6) : [];

  return `
    <div class="p-3.5 flex flex-col gap-3.5 max-w-lg mx-auto">
      <!-- Top Bar da Venda: Voltar + Título + Offline First Badge -->
      <div class="flex items-center justify-between pb-1 border-b border-slate-800">
        <div class="flex items-center gap-2">
          <button
            type="button"
            data-action="mobile-tab-home"
            class="h-9 w-9 rounded-lg bg-slate-900 border border-slate-800 flex items-center justify-center text-slate-300 hover:text-white active:scale-95"
            title="Voltar ao início"
          >
            ${ICONS.home}
          </button>
          <div>
            <h2 class="text-base font-bold text-white leading-tight">Nova venda</h2>
            <span class="text-[10px] text-emerald-400 font-medium">Offline First</span>
          </div>
        </div>

        <div class="flex items-center gap-2">
          ${
            cart.length > 0
              ? `<button
                  type="button"
                  data-action="mobile-cart-clear"
                  class="h-8 px-2.5 rounded-lg bg-red-950/40 border border-red-900/60 text-red-300 text-xs font-medium flex items-center gap-1 active:scale-95"
                  title="Limpar talão"
                >
                  ${ICONS.trash}
                  <span>Limpar</span>
                </button>`
              : ''
          }
        </div>
      </div>

      <!-- Card do Cliente (Consumidor final + Alterar / Novo) -->
      <section class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">CLIENTE</span>
          <div class="flex items-center gap-1.5">
            <button
              type="button"
              data-action="mobile-open-customer-picker"
              class="text-xs text-blue-400 hover:text-blue-300 font-medium px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
            >
              Alterar cliente
            </button>
            <span class="text-slate-600">·</span>
            <button
              type="button"
              data-action="mobile-open-quick-customer"
              class="text-xs text-emerald-400 hover:text-emerald-300 font-medium px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
            >
              + Novo
            </button>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <div class="h-8 w-8 rounded-full bg-slate-800 flex items-center justify-center text-slate-300 shrink-0">
            ${ICONS.user}
          </div>
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-white truncate">${escapeHtml(activeCustomer.name)}</p>
            <p class="text-xs text-slate-400 font-mono tabular-nums">NIF ${escapeHtml(activeCustomer.nif || '999999999')}</p>
          </div>
        </div>
      </section>

      <!-- Barra de Pesquisa de Artigos -->
      <section class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Adicionar produtos</span>
          <button
            type="button"
            data-action="mobile-open-quick-product"
            class="text-xs text-emerald-400 hover:text-emerald-300 font-medium px-2 py-0.5 rounded hover:bg-slate-800 transition-colors"
          >
            + Cadastrar Artigo
          </button>
        </div>

        <div class="relative">
          <input
            type="text"
            id="mobile-product-search-input"
            value="${escapeHtml(mobileProductSearchInput)}"
            placeholder="Pesquisar produto ou código..."
            class="w-full h-11 pl-10 pr-9 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <span class="absolute left-3 top-3 text-slate-500 pointer-events-none">${ICONS.search}</span>
          ${
            mobileProductSearchInput
              ? `<button
                  type="button"
                  data-action="mobile-clear-product-search"
                  class="absolute right-3 top-3 text-slate-400 hover:text-white"
                >${ICONS.close}</button>`
              : ''
          }
        </div>

        <!-- Resultados da Pesquisa (se houver query) -->
        ${
          query
            ? `
            <div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden divide-y divide-slate-800/80 shadow-lg max-h-56 overflow-y-auto">
              ${
                searchResults.length === 0
                  ? `<div class="p-3 text-center text-xs text-slate-400">Nenhum artigo encontrado para "${escapeHtml(
                      query
                    )}".</div>`
                  : searchResults
                      .map(
                        (p) => `
                    <div class="p-2.5 flex items-center justify-between gap-2 hover:bg-slate-800/50">
                      <div class="min-w-0 flex-1">
                        <p class="text-xs font-semibold text-white truncate">${escapeHtml(p.name)}</p>
                        <p class="text-[11px] text-slate-400 font-mono tabular-nums">
                          ${formatKzNumber(p.price)} Kz / ${escapeHtml(p.unit)}
                          ${p.trackStock ? ` · Stock: ${p.stockQty || 0}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        data-action="mobile-add-product"
                        data-product-id="${escapeHtml(p.id)}"
                        class="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 active:scale-95 shrink-0"
                      >
                        ${ICONS.plus}
                        <span>Adicionar</span>
                      </button>
                    </div>
                  `
                      )
                      .join('')
              }
            </div>
          `
            : ''
        }

        <!-- Chips / Sugestões Rápidas de Artigos Populares (quando sem busca) -->
        ${
          !query && popularProducts.length > 0 && cart.length === 0
            ? `
            <div class="flex flex-col gap-1.5 mt-1">
              <span class="text-[11px] text-slate-400">Toque para adicionar rapidamente:</span>
              <div class="grid grid-cols-2 gap-2">
                ${popularProducts
                  .map(
                    (p) => `
                  <button
                    type="button"
                    data-action="mobile-add-product"
                    data-product-id="${escapeHtml(p.id)}"
                    class="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-left hover:border-slate-700 active:scale-[0.98] transition-all flex flex-col justify-between min-h-[58px]"
                  >
                    <span class="text-xs font-medium text-white truncate block">${escapeHtml(p.name)}</span>
                    <span class="text-xs font-bold text-blue-400 font-mono tabular-nums block mt-1">${formatKzNumber(p.price)} Kz</span>
                  </button>
                `
                  )
                  .join('')}
              </div>
            </div>
          `
            : ''
        }
      </section>

      <!-- Lista de Artigos no Carrinho -->
      <section class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Itens no Carrinho (${cart.length})
          </span>
          ${
            cart.length > 0
              ? `<span class="text-xs text-slate-400 font-mono tabular-nums">Subtotal: ${formatKzNumber(totals.merchandiseTotal)} Kz</span>`
              : ''
          }
        </div>

        ${
          cart.length === 0
            ? `
            <div class="p-6 rounded-2xl bg-slate-900/40 border border-slate-800/80 text-center flex flex-col items-center justify-center gap-2">
              <div class="h-10 w-10 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-500">
                ${ICONS.shoppingCart}
              </div>
              <p class="text-sm font-medium text-slate-300">O carrinho está vazio</p>
              <p class="text-xs text-slate-500 max-w-xs">Pesquise pelo nome ou código acima para adicionar artigos a esta venda.</p>
            </div>
          `
            : `
            <div class="flex flex-col gap-2">
              ${cart
                .map((item) => {
                  const lineTotal = roundKz(item.qty * item.unitPrice * (1 - (item.discountPct || 0) / 100));
                  return `
                    <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-2 shadow-sm">
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-semibold text-white truncate">${escapeHtml(item.description)}</p>
                        <p class="text-xs text-slate-400 font-mono tabular-nums">
                          ${formatKzNumber(item.unitPrice)} Kz / ${escapeHtml(item.unit)}
                        </p>
                        <p class="text-xs font-bold text-blue-400 font-mono tabular-nums mt-0.5">
                          Total: ${formatKzNumber(lineTotal)} Kz
                        </p>
                      </div>

                      <!-- Stepper Ergonómico (+/- 44px de toque mínimo) -->
                      <div class="flex items-center gap-1.5 shrink-0 bg-slate-800/90 rounded-lg p-1 border border-slate-700/60">
                        <button
                          type="button"
                          data-action="mobile-qty-decrement"
                          data-product-id="${escapeHtml(item.productId)}"
                          class="h-9 w-9 rounded-md bg-slate-700 hover:bg-slate-600 active:scale-95 flex items-center justify-center text-white font-bold"
                          title="Diminuir"
                        >
                          ${ICONS.minus}
                        </button>
                        <span class="w-8 text-center font-bold text-sm text-white font-mono tabular-nums">
                          ${item.qty}
                        </span>
                        <button
                          type="button"
                          data-action="mobile-qty-increment"
                          data-product-id="${escapeHtml(item.productId)}"
                          class="h-9 w-9 rounded-md bg-blue-600 hover:bg-blue-500 active:scale-95 flex items-center justify-center text-white font-bold"
                          title="Aumentar"
                        >
                          ${ICONS.plus}
                        </button>
                        <button
                          type="button"
                          data-action="mobile-cart-remove"
                          data-product-id="${escapeHtml(item.productId)}"
                          class="h-9 w-9 rounded-md text-red-400 hover:bg-red-950/50 active:scale-95 flex items-center justify-center ml-1"
                          title="Remover linha"
                        >
                          ${ICONS.trash}
                        </button>
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          `
        }
      </section>

      <!-- Totais Resumidos -->
      ${
        cart.length > 0
          ? `
          <section class="bg-slate-900/60 border border-slate-800 rounded-xl p-3 flex flex-col gap-1.5 text-xs">
            <div class="flex justify-between text-slate-400">
              <span>Subtotal Mercadorias:</span>
              <span class="font-mono tabular-nums">${formatKzNumber(totals.merchandiseTotal)} Kz</span>
            </div>
            ${
              totals.taxTotal > 0
                ? `<div class="flex justify-between text-slate-400">
                    <span>IVA Geral (14%):</span>
                    <span class="font-mono tabular-nums">${formatKzNumber(totals.taxTotal)} Kz</span>
                  </div>`
                : ''
            }
            <div class="flex justify-between text-base font-bold text-white pt-1 border-t border-slate-800">
              <span>TOTAL A PAGAR:</span>
              <span class="text-blue-400 font-mono tabular-nums">${formatKzNumber(totals.grandTotal)} Kz</span>
            </div>
          </section>
        `
          : ''
      }
    </div>

    <!-- BOTÃO FINALIZAR VENDA FIXO NA PARTE INFERIOR -->
    <div class="fixed bottom-16 left-0 right-0 p-3 bg-gradient-to-t from-slate-950 via-slate-950/95 to-transparent z-30">
      <div class="max-w-lg mx-auto flex items-center gap-3">
        <div class="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-3.5 py-2">
          <span class="text-[10px] text-slate-400 uppercase tracking-wider block">TOTAL</span>
          <span class="text-lg font-extrabold text-white font-mono tabular-nums leading-none block">
            ${formatKzNumber(totals.grandTotal)} Kz
          </span>
        </div>
        <button
          type="button"
          data-action="mobile-go-checkout"
          ${cart.length === 0 ? 'disabled' : ''}
          class="flex-[2] h-[52px] rounded-xl font-bold text-sm tracking-wide flex flex-col items-center justify-center shadow-lg transition-all ${
            cart.length > 0
              ? 'bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white shadow-blue-600/30'
              : 'bg-slate-800 text-slate-500 cursor-not-allowed'
          }"
        >
          <span class="text-sm font-bold uppercase tracking-wider">FINALIZAR VENDA</span>
          <span class="text-[10px] font-normal opacity-90">Pagamento · Emissão · Impressão</span>
        </button>
      </div>
    </div>
  `;
}

// ==================== 4. ETAPA DE PAGAMENTO (CHECKOUT FOCADO) ====================
function renderMobilePaymentStep(props: MobileOperationalProps): string {
  const { cart, paymentMethod, docType, amountReceivedInput } = props;
  const totals = calculateInvoiceTotals(cart, 0);
  const grandTotal = totals.grandTotal;

  const numericReceived = parseFloat(amountReceivedInput.replace(/\s/g, '').replace(',', '.')) || 0;
  const change = Math.max(0, roundKz(numericReceived - grandTotal));
  const missing = Math.max(0, roundKz(grandTotal - numericReceived));

  const methods: PaymentMethod[] = ['Dinheiro', 'Multicaixa', 'Transferência', 'Combinado'];

  return `
    <div class="p-3.5 flex flex-col gap-3.5 max-w-lg mx-auto">
      <!-- Top Bar: Voltar ao Carrinho -->
      <div class="flex items-center justify-between pb-1 border-b border-slate-800">
        <button
          type="button"
          data-action="mobile-back-to-cart"
          class="h-9 px-3 rounded-lg bg-slate-900 border border-slate-800 flex items-center gap-1.5 text-slate-300 hover:text-white text-xs font-semibold active:scale-95"
        >
          ${ICONS.chevronDown}
          <span>Voltar ao carrinho</span>
        </button>
        <span class="text-xs text-slate-400 font-mono tabular-nums">${cart.length} itens</span>
      </div>

      <!-- Resumo do Total em Destaque -->
      <section class="bg-gradient-to-r from-blue-900/40 to-slate-900 border border-blue-800/40 rounded-2xl p-4 text-center">
        <span class="text-xs text-blue-200 uppercase tracking-wider block font-medium">TOTAL A PAGAR</span>
        <h2 class="text-3xl font-extrabold text-white font-mono tabular-nums mt-1">${formatKzNumber(grandTotal)} Kz</h2>
      </section>

      <!-- 1. Método de Pagamento (Botões Grandes 48px) -->
      <section class="flex flex-col gap-2">
        <span class="text-xs font-semibold text-slate-300 uppercase tracking-wider">1. Seleccionar Método de Pagamento</span>
        <div class="grid grid-cols-2 gap-2">
          ${methods
            .map(
              (m) => `
            <button
              type="button"
              data-action="mobile-select-payment"
              data-value="${escapeHtml(m)}"
              class="h-12 rounded-xl border font-semibold text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.98] ${
                paymentMethod === m
                  ? 'bg-blue-600 border-blue-400 text-white shadow-md shadow-blue-600/30'
                  : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700'
              }"
            >
              <span>${
                m === 'Dinheiro'
                  ? '💵'
                  : m === 'Multicaixa'
                  ? '💳'
                  : m === 'Transferência'
                  ? '📱'
                  : '🔀'
              }</span>
              <span>${escapeHtml(m)}</span>
            </button>
          `
            )
            .join('')}
        </div>
      </section>

      <!-- 2. Valor Recebido e Troco (se Dinheiro) -->
      ${
        paymentMethod === 'Dinheiro'
          ? `
        <section class="bg-slate-900 border border-slate-800 rounded-2xl p-3.5 flex flex-col gap-3">
          <span class="text-xs font-semibold text-slate-300 uppercase tracking-wider">2. Confirmar Valor Recebido</span>

          <!-- Atalhos de Notas Rápidas -->
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-action="mobile-set-received"
              data-value="${grandTotal}"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-emerald-400 font-semibold"
            >
              Exacto (${formatKzNumber(grandTotal)})
            </button>
            <button
              type="button"
              data-action="mobile-add-received"
              data-value="1000"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
            >
              +1.000
            </button>
            <button
              type="button"
              data-action="mobile-add-received"
              data-value="2000"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
            >
              +2.000
            </button>
            <button
              type="button"
              data-action="mobile-add-received"
              data-value="5000"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
            >
              +5.000
            </button>
            <button
              type="button"
              data-action="mobile-add-received"
              data-value="10000"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-mono text-slate-200"
            >
              +10.000
            </button>
          </div>

          <!-- Input do Valor Recebido -->
          <div class="flex items-center gap-2">
            <div class="relative flex-1">
              <input
                type="text"
                inputmode="decimal"
                id="mobile-amount-received-input"
                value="${escapeHtml(amountReceivedInput || String(grandTotal))}"
                placeholder="Valor entregue pelo cliente..."
                class="w-full h-12 px-3.5 rounded-xl bg-slate-950 border border-slate-700 text-base font-bold text-white font-mono tabular-nums focus:outline-none focus:border-blue-500"
              />
              <span class="absolute right-3.5 top-3.5 text-xs text-slate-500 font-mono">Kz</span>
            </div>
          </div>

          <!-- Cálculo do Troco em Tempo Real -->
          <div class="p-2.5 rounded-xl ${
            numericReceived >= grandTotal ? 'bg-emerald-950/40 border border-emerald-900/60' : 'bg-amber-950/40 border border-amber-900/60'
          } flex items-center justify-between">
            <span class="text-xs ${numericReceived >= grandTotal ? 'text-emerald-300' : 'text-amber-300'} font-medium">
              ${numericReceived >= grandTotal ? 'Troco a devolver:' : 'Valor em falta:'}
            </span>
            <span class="text-base font-extrabold ${numericReceived >= grandTotal ? 'text-emerald-400' : 'text-amber-400'} font-mono tabular-nums">
              ${formatKzNumber(numericReceived >= grandTotal ? change : missing)} Kz
            </span>
          </div>
        </section>
      `
          : ''
      }

      <!-- 3. Tipo de Documento Fiscal -->
      <section class="flex flex-col gap-2">
        <span class="text-xs font-semibold text-slate-300 uppercase tracking-wider">3. Documento a Emitir</span>
        <div class="grid grid-cols-2 gap-2">
          ${(['FR', 'FP'] as DocumentType[])
            .map(
              (dt) => `
            <button
              type="button"
              data-action="mobile-select-doctype"
              data-value="${dt}"
              class="h-10 rounded-xl border text-xs font-bold transition-all active:scale-[0.98] ${
                docType === dt
                  ? 'bg-blue-600 border-blue-400 text-white'
                  : 'bg-slate-900 border-slate-800 text-slate-400'
              }"
            >
              ${dt === 'FR' ? 'Factura-Recibo' : 'Factura Pró-forma'}
            </button>
          `
            )
            .join('')}
        </div>
      </section>

      <!-- Botão de Confirmação da Venda (52px de altura mínima) -->
      <div class="pt-3 flex flex-col gap-2">
        <button
          type="button"
          data-action="mobile-confirm-emit"
          class="w-full h-[52px] rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-[0.98] text-white font-bold text-base uppercase tracking-wider shadow-lg shadow-emerald-600/30 flex items-center justify-center gap-2"
        >
          ${ICONS.shieldCheck}
          <span>CONFIRMAR E EMITIR</span>
        </button>

        <button
          type="button"
          data-action="mobile-back-to-cart"
          class="w-full h-11 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-300 text-xs font-medium"
        >
          Cancelar / Corrigir Artigos
        </button>
      </div>
    </div>
  `;
}

// ==================== 5. ETAPA DE SUCESSO DA VENDA ====================
function renderMobileSuccessStep(props: MobileOperationalProps): string {
  const { lastEmittedInvoice } = props;
  const invoice = lastEmittedInvoice;

  if (!invoice) {
    return `
      <div class="p-6 text-center text-slate-400">
        <p>Nenhuma venda recente.</p>
        <button type="button" data-action="mobile-go-sale" class="mt-4 px-4 py-2 bg-blue-600 text-white rounded-xl">Iniciar Venda</button>
      </div>
    `;
  }

  return `
    <div class="p-4 flex flex-col gap-4 max-w-lg mx-auto text-center">
      <!-- Ícone de Sucesso -->
      <div class="pt-4 flex flex-col items-center">
        <div class="h-16 w-16 rounded-full bg-emerald-950/60 border border-emerald-500/40 flex items-center justify-center text-emerald-400 mb-2">
          ${ICONS.checkCircle2}
        </div>
        <h2 class="text-xl font-extrabold text-white">VENDA CONCLUÍDA!</h2>
        <p class="text-xs text-slate-400 mt-0.5">Documento fiscal validado e assinado com sucesso</p>
      </div>

      <!-- Detalhes do Documento Emitido -->
      <section class="bg-slate-900 border border-slate-800 rounded-2xl p-4 text-left flex flex-col gap-2">
        <div class="flex justify-between items-center pb-2 border-b border-slate-800">
          <span class="text-xs text-slate-400">Documento:</span>
          <span class="text-sm font-bold text-white font-mono tabular-nums">${escapeHtml(invoice.number)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-xs text-slate-400">Cliente:</span>
          <span class="text-xs font-medium text-white truncate max-w-[180px]">${escapeHtml(invoice.customerName)}</span>
        </div>
        <div class="flex justify-between items-center">
          <span class="text-xs text-slate-400">Pagamento:</span>
          <span class="text-xs font-medium text-white">${escapeHtml(invoice.paymentMethod)}</span>
        </div>
        <div class="flex justify-between items-center pt-2 border-t border-slate-800">
          <span class="text-sm font-bold text-white">Total Pago:</span>
          <span class="text-lg font-extrabold text-emerald-400 font-mono tabular-nums">${formatKzNumber(invoice.grandTotal)} Kz</span>
        </div>
      </section>

      <!-- Ações de Impressão e Partilha (Botões 48-52px) -->
      <div class="flex flex-col gap-2.5 pt-2">
        <button
          type="button"
          data-action="mobile-print-receipt"
          data-invoice-id="${escapeHtml(invoice.id)}"
          class="w-full h-[50px] rounded-xl bg-blue-600 hover:bg-blue-500 active:scale-[0.98] text-white font-bold text-sm flex items-center justify-center gap-2 shadow-md shadow-blue-600/25"
        >
          ${ICONS.printer}
          <span>Imprimir Talão Térmico (80mm)</span>
        </button>

        <button
          type="button"
          data-action="mobile-print-a4"
          data-invoice-id="${escapeHtml(invoice.id)}"
          class="w-full h-[46px] rounded-xl bg-slate-800 hover:bg-slate-700 active:scale-[0.98] text-slate-200 font-semibold text-xs flex items-center justify-center gap-2 border border-slate-700"
        >
          ${ICONS.fileA4}
          <span>Ver / Partilhar Factura A4</span>
        </button>

        <button
          type="button"
          data-action="mobile-start-new-sale"
          class="w-full h-[50px] rounded-xl bg-emerald-700 hover:bg-emerald-600 active:scale-[0.98] text-white font-bold text-sm flex items-center justify-center gap-2 mt-2 shadow-md"
        >
          ${ICONS.plus}
          <span>Iniciar Nova Venda</span>
        </button>
      </div>
    </div>
  `;
}

// ==================== 6. ECRÃ DE DOCUMENTOS (HISTÓRICO) ====================
function renderMobileDocs(props: MobileOperationalProps): string {
  const { invoices, mobileSearchQuery } = props;
  const query = (mobileSearchQuery || '').trim().toLowerCase();

  const filtered = query
    ? invoices.filter(
        (i) =>
          i.number.toLowerCase().includes(query) ||
          i.customerName.toLowerCase().includes(query) ||
          (i.customerNif && i.customerNif.toLowerCase().includes(query))
      )
    : invoices;

  return `
    <div class="p-3.5 flex flex-col gap-3 max-w-lg mx-auto">
      <div class="flex items-center justify-between pb-1 border-b border-slate-800">
        <h2 class="text-base font-bold text-white">Documentos Emitidos</h2>
        <span class="text-xs text-slate-400 font-mono tabular-nums">${invoices.length} total</span>
      </div>

      <!-- Barra de Pesquisa de Documentos -->
      <div class="relative">
        <input
          type="text"
          id="mobile-docs-search-input"
          value="${escapeHtml(mobileSearchQuery)}"
          placeholder="Pesquisar por número ou cliente..."
          class="w-full h-11 pl-10 pr-9 rounded-xl bg-slate-900 border border-slate-800 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
        />
        <span class="absolute left-3 top-3 text-slate-500 pointer-events-none">${ICONS.search}</span>
        ${
          mobileSearchQuery
            ? `<button
                type="button"
                data-action="mobile-clear-docs-search"
                class="absolute right-3 top-3 text-slate-400 hover:text-white"
              >${ICONS.close}</button>`
            : ''
        }
      </div>

      <!-- Lista de Documentos -->
      <div class="flex flex-col gap-2">
        ${
          filtered.length === 0
            ? `<div class="p-8 text-center text-xs text-slate-500">Nenhum documento encontrado.</div>`
            : filtered
                .slice(0, 30)
                .map(
                  (inv) => `
              <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex flex-col gap-2 shadow-sm">
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold text-white font-mono tabular-nums">${escapeHtml(inv.number)}</span>
                  <span class="text-[10px] font-semibold px-2 py-0.5 rounded ${
                    inv.status === 'cancelled'
                      ? 'bg-red-950/60 text-red-400 border border-red-900/60'
                      : 'bg-emerald-950/60 text-emerald-400 border border-emerald-900/60'
                  }">
                    ${inv.status === 'cancelled' ? 'Anulado' : 'Emitido'}
                  </span>
                </div>
                <div class="flex items-center justify-between text-xs text-slate-400">
                  <span class="truncate max-w-[200px] text-slate-300 font-medium">${escapeHtml(inv.customerName)}</span>
                  <span class="font-bold text-white font-mono tabular-nums">${formatKzNumber(inv.grandTotal)} Kz</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-800/80">
                  <span>${formatDateTimePt(inv.issuedAtIso)}</span>
                  <div class="flex items-center gap-2">
                    <button
                      type="button"
                      data-action="mobile-print-receipt"
                      data-invoice-id="${escapeHtml(inv.id)}"
                      class="text-blue-400 hover:text-blue-300 text-xs font-medium"
                    >
                      Talão
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      data-action="mobile-print-a4"
                      data-invoice-id="${escapeHtml(inv.id)}"
                      class="text-slate-300 hover:text-white text-xs font-medium"
                    >
                      A4
                    </button>
                  </div>
                </div>
              </div>
            `
                )
                .join('')
        }
      </div>
    </div>
  `;
}

// ==================== 7. ECRÃ DE CLIENTES ====================
function renderMobileCustomers(props: MobileOperationalProps): string {
  const { customers } = props;

  return `
    <div class="p-3.5 flex flex-col gap-3 max-w-lg mx-auto">
      <div class="flex items-center justify-between pb-1 border-b border-slate-800">
        <h2 class="text-base font-bold text-white">Clientes Cadastrados</h2>
        <button
          type="button"
          data-action="mobile-open-quick-customer"
          class="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-1 active:scale-95"
        >
          ${ICONS.plus}
          <span>Novo Cliente</span>
        </button>
      </div>

      <div class="flex flex-col gap-2">
        ${customers.map(
          (c) => `
          <div class="bg-slate-900 border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-2 shadow-sm">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold text-white truncate">${escapeHtml(c.name)}</p>
              <p class="text-xs text-slate-400 font-mono tabular-nums">NIF: ${escapeHtml(c.nif || 'Consumidor Final')}</p>
              ${c.phone ? `<p class="text-xs text-slate-500">Tel: ${escapeHtml(c.phone)}</p>` : ''}
            </div>
            <button
              type="button"
              data-action="mobile-select-customer-and-sale"
              data-customer-id="${escapeHtml(c.id)}"
              class="h-8 px-2.5 rounded-lg bg-slate-800 hover:bg-blue-600 text-slate-300 hover:text-white text-xs font-medium active:scale-95 transition-colors shrink-0"
            >
              Vender
            </button>
          </div>
        `
        ).join('')}
      </div>
    </div>
  `;
}

// ==================== 8. MENU "MAIS" ====================
function renderMobileMore(props: MobileOperationalProps): string {
  const { operator, products } = props;

  return `
    <div class="p-3.5 flex flex-col gap-3 max-w-lg mx-auto">
      <div class="pb-1 border-b border-slate-800">
        <h2 class="text-base font-bold text-white">Mais Opções</h2>
        <p class="text-xs text-slate-400">Operador: Op. ${escapeHtml(operator)}</p>
      </div>

      <div class="flex flex-col gap-2">
        <!-- Catálogo de Artigos & Stock -->
        <button
          type="button"
          data-action="mobile-go-products"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-blue-900/60 text-blue-400 flex items-center justify-center shrink-0">
              ${ICONS.package}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Catálogo de Artigos & Stock (${products.length})</span>
              <span class="text-xs text-slate-400 block">Preços, SKU, margem e inventário completo</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- Cadastrar Artigo Rápido -->
        <button
          type="button"
          data-action="mobile-open-quick-product"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-emerald-900/60 text-emerald-400 flex items-center justify-center shrink-0">
              ${ICONS.plus}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Cadastrar Novo Artigo</span>
              <span class="text-xs text-slate-400 block">Ficha operacional completa</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- Dados da Empresa -->
        <button
          type="button"
          data-action="mobile-open-quick-company"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-indigo-900/60 text-indigo-400 flex items-center justify-center shrink-0">
              ${ICONS.building}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Ficha Mestre da Empresa</span>
              <span class="text-xs text-slate-400 block">Dados fiscais, logótipo, bancos, estabelecimentos e séries</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- SAF-T (AO) XML -->
        <button
          type="button"
          data-action="mobile-open-saft"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-amber-900/60 text-amber-400 flex items-center justify-center shrink-0">
              ${ICONS.shieldCheck}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">SAF-T (AO) Oficial XML</span>
              <span class="text-xs text-slate-400 block">Exportação mensal e conformidade AGT</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- Fecho de Caixa -->
        <button
          type="button"
          data-action="mobile-open-cash"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-purple-900/60 text-purple-400 flex items-center justify-center shrink-0">
              ${ICONS.wallet}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Caixa e Sessões</span>
              <span class="text-xs text-slate-400 block">Abertura, reforço e fecho de turno</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- Sincronização Cloud -->
        <button
          type="button"
          data-action="mobile-open-sync"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98]"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-teal-900/60 text-teal-400 flex items-center justify-center shrink-0">
              ${ICONS.cloud}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Sincronização Cloud</span>
              <span class="text-xs text-slate-400 block">Backup e sincronização offline-first</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>

        <!-- Alternar para Modo Desktop / Gestão Completa -->
        <button
          type="button"
          data-action="mobile-switch-to-desktop"
          class="bg-slate-900 hover:bg-slate-850 rounded-xl p-3.5 flex items-center justify-between border border-slate-800 text-left active:scale-[0.98] mt-2"
        >
          <div class="flex items-center gap-3">
            <div class="h-8 w-8 rounded-lg bg-slate-800 text-slate-300 flex items-center justify-center shrink-0">
              ${ICONS.panelOpen}
            </div>
            <div>
              <span class="text-sm font-bold text-white block">Mudar para Vista Desktop</span>
              <span class="text-xs text-slate-400 block">Aceder a relatórios avançados e gráficos</span>
            </div>
          </div>
          <span class="text-slate-500">${ICONS.chevronRight}</span>
        </button>
      </div>
    </div>
  `;
}

// ==================== 9. BARRA DE NAVEGAÇÃO INFERIOR FIXA ====================
function renderMobileBottomNav(activeTab: MobileTab, cartItemCount: number): string {
  const tabs: { id: MobileTab; label: string; icon: string; badge?: number }[] = [
    { id: 'HOME', label: 'Início', icon: ICONS.home },
    { id: 'SALE', label: 'Vender', icon: ICONS.shoppingCart, badge: cartItemCount },
    { id: 'DOCS', label: 'Docs.', icon: ICONS.receipt },
    { id: 'CUSTOMERS', label: 'Clientes', icon: ICONS.users },
    { id: 'MORE', label: 'Mais', icon: ICONS.menu },
  ];

  return `
    <nav class="fixed bottom-0 left-0 right-0 z-40 bg-slate-900/95 backdrop-blur-md border-t border-slate-800 flex items-center justify-around h-16 safe-area-bottom">
      ${tabs
        .map((t) => {
          const isActive = activeTab === t.id || (t.id === 'MORE' && activeTab === 'PRODUCTS');
          return `
            <button
              type="button"
              data-action="mobile-nav-tab"
              data-tab="${t.id}"
              class="flex-1 h-full flex flex-col items-center justify-center relative min-h-[48px] active:scale-95 transition-transform ${
                isActive ? 'text-blue-500 font-bold' : 'text-slate-400 font-normal hover:text-slate-200'
              }"
            >
              <div class="relative">
                <span class="w-5 h-5 flex items-center justify-center">${t.icon}</span>
                ${
                  t.badge && t.badge > 0
                    ? `<span class="absolute -top-1 -right-2 px-1.5 py-0.2 rounded-full bg-blue-600 text-white text-[9px] font-bold font-mono">
                        ${t.badge}
                      </span>`
                    : ''
                }
              </div>
              <span class="text-[10px] tracking-tight mt-1 leading-none">${t.label}</span>
              ${isActive ? `<span class="absolute bottom-1 w-1 h-1 rounded-full bg-blue-500"></span>` : ''}
            </button>
          `;
        })
        .join('')}
    </nav>
  `;
}

// ==================== 10. MODAL COMPLETO DE CADASTRAMENTO E EDIÇÃO DE PRODUTOS ====================
function renderMobileProductModal(editingProduct: Product | null, nextSku: string): string {
  const isEditing = Boolean(editingProduct);
  const p = editingProduct;

  const currentCode = p ? p.code : nextSku;
  const currentBarcode = p?.barcode || '';
  const currentName = p?.name || '';
  const currentCategory = p?.category || 'Geral';
  const currentUnit = p?.unit || 'un';
  const currentCost = p?.costPrice ? String(p.costPrice) : '';
  const currentPrice = p?.price ? String(p.price) : '';
  const currentIva = p ? p.ivaRate : 14;
  const currentExemption = p?.exemptionReason || DEFAULT_IVA_EXEMPTION_REASONS[0];
  const currentActive = p ? p.active !== false : true;
  const currentTrackStock = p?.trackStock || false;
  const currentStockQty = p?.stockQty ? String(p.stockQty) : '0';
  const currentMinStock = p?.minStockQty ? String(p.minStockQty) : '5';

  // Pré-cálculo da margem de lucro
  const numCost = parseFloat(currentCost.replace(',', '.')) || 0;
  const numPrice = parseFloat(currentPrice.replace(',', '.')) || 0;
  const profit = numCost > 0 ? roundKz(numPrice - numCost) : 0;
  const marginPct = numCost > 0 && numPrice > 0 ? roundKz((profit / numPrice) * 100) : 0;
  const markupPct = numCost > 0 ? roundKz((profit / numCost) * 100) : 0;
  const isBelowCost = numCost > 0 && numPrice < numCost;

  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in">
      <div class="bg-slate-900 border border-slate-800 w-full max-w-lg rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[92dvh] overflow-hidden shadow-2xl">
        <!-- Header do Modal com SKU e Botão Fechar -->
        <div class="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between shrink-0 bg-slate-900/95">
          <div class="flex items-center gap-2">
            <div class="h-8 w-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center">
              ${ICONS.package}
            </div>
            <div>
              <h3 class="text-sm font-bold text-white leading-tight">
                ${isEditing ? `Editar Artigo: ${escapeHtml(currentCode)}` : 'Cadastrar Novo Artigo'}
              </h3>
              <p class="text-[11px] text-slate-400">Ficha operacional completa (9 requisitos fiscais)</p>
            </div>
          </div>
          <button
            type="button"
            data-action="mobile-close-modals"
            class="h-8 w-8 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center active:scale-95"
          >
            ${ICONS.close}
          </button>
        </div>

        <!-- Formulário Scrollável com as 9 Áreas -->
        <form id="mobile-quick-product-form" class="flex-1 overflow-y-auto p-5 flex flex-col gap-4 text-xs">
          ${isEditing ? `<input type="hidden" name="productId" value="${escapeHtml(p!.id)}" />` : ''}

          <!-- SEÇÃO 1: Identificação (Nome, SKU, Código de Barras, Tipo/Categoria) -->
          <div class="flex flex-col gap-2.5">
            <span class="text-[11px] font-bold text-blue-400 uppercase tracking-wider">
              1. Identificação & Códigos (SKU / Barras)
            </span>

            <div>
              <label class="font-medium text-slate-300 block mb-1">Nome / Descrição do Artigo *</label>
              <input
                type="text"
                name="name"
                required
                value="${escapeHtml(currentName)}"
                placeholder="Ex.: Água Mineral Cuca 1.5L ou Consultoria Técnica"
                class="w-full h-11 px-3.5 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500 font-medium"
              />
            </div>

            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label class="font-medium text-slate-300 block mb-1">Código Interno / SKU *</label>
                <div class="relative">
                  <input
                    type="text"
                    name="code"
                    required
                    value="${escapeHtml(currentCode)}"
                    placeholder="Ex.: ART001"
                    class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono font-bold text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
              <div>
                <label class="font-medium text-slate-300 block mb-1">Código de Barras (EAN / Leitor)</label>
                <div class="relative">
                  <input
                    type="text"
                    name="barcode"
                    value="${escapeHtml(currentBarcode)}"
                    placeholder="Ex.: 5601234567890"
                    class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>
            </div>

            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label class="font-medium text-slate-300 block mb-1">Tipo de Artigo / Categoria</label>
                <select
                  name="category"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white focus:outline-none focus:border-blue-500"
                >
                  <option value="Mercadoria Física" ${currentCategory === 'Mercadoria Física' || currentCategory === 'Geral' ? 'selected' : ''}>Mercadoria Física</option>
                  <option value="Serviços" ${currentCategory === 'Serviços' ? 'selected' : ''}>Serviço (Mão de Obra)</option>
                  <option value="Kit / Produto Composto" ${currentCategory === 'Kit / Produto Composto' ? 'selected' : ''}>Produto Composto (Kit)</option>
                  ${DEFAULT_PRODUCT_CATEGORIES.filter((c) => c !== 'Geral' && c !== 'Serviços').map(
                    (cat) => `<option value="${escapeHtml(cat)}" ${currentCategory === cat ? 'selected' : ''}>${escapeHtml(cat)}</option>`
                  ).join('')}
                </select>
              </div>

              <div>
                <label class="font-medium text-slate-300 block mb-1">Unidade de Medida</label>
                <select
                  name="unit"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-mono focus:outline-none focus:border-blue-500"
                >
                  <option value="un" ${currentUnit === 'un' ? 'selected' : ''}>un (Unidade)</option>
                  <option value="kg" ${currentUnit === 'kg' ? 'selected' : ''}>kg (Quilograma)</option>
                  <option value="g" ${currentUnit === 'g' ? 'selected' : ''}>g (Grama)</option>
                  <option value="lt" ${currentUnit === 'lt' ? 'selected' : ''}>lt (Litro)</option>
                  <option value="cx" ${currentUnit === 'cx' ? 'selected' : ''}>cx (Caixa)</option>
                  <option value="pct" ${currentUnit === 'pct' ? 'selected' : ''}>pct (Pacote)</option>
                  <option value="hr" ${currentUnit === 'hr' ? 'selected' : ''}>hr (Hora de Serviço)</option>
                  <option value="serv" ${currentUnit === 'serv' ? 'selected' : ''}>serv (Serviço)</option>
                  <option value="mês" ${currentUnit === 'mês' ? 'selected' : ''}>mês (Mensalidade)</option>
                </select>
              </div>
            </div>
          </div>

          <!-- SEÇÃO 2: Preço, Custo & Margem de Lucro -->
          <div class="flex flex-col gap-2.5 pt-2 border-t border-slate-800">
            <span class="text-[11px] font-bold text-emerald-400 uppercase tracking-wider">
              2. Preço de Venda, Custo & Margem de Lucro
            </span>

            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label class="font-medium text-slate-300 block mb-1">Preço de Custo / Aquisição (Kz)</label>
                <input
                  type="text"
                  inputmode="decimal"
                  id="mobile-product-cost-input"
                  name="costPrice"
                  value="${escapeHtml(currentCost)}"
                  placeholder="Ex.: 1500"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono tabular-nums text-white focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label class="font-medium text-slate-300 block mb-1">Preço de Venda ao Público *</label>
                <input
                  type="text"
                  inputmode="decimal"
                  id="mobile-product-price-input"
                  name="price"
                  required
                  value="${escapeHtml(currentPrice)}"
                  placeholder="Ex.: 2500"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono tabular-nums font-bold text-blue-400 focus:outline-none focus:border-blue-500 text-sm"
                />
              </div>
            </div>

            <!-- Painel Dinâmico de Margem de Lucro em Tempo Real -->
            <div id="mobile-product-margin-readout" class="p-3 rounded-xl ${
              numCost > 0
                ? isBelowCost
                  ? 'bg-red-950/50 border border-red-900/60'
                  : 'bg-emerald-950/40 border border-emerald-900/60'
                : 'bg-slate-950/60 border border-slate-800'
            } flex items-center justify-between">
              <div>
                <span class="text-[10px] text-slate-400 block uppercase tracking-wider">Lucro Unitário Estimado</span>
                <span class="text-sm font-bold font-mono tabular-nums ${
                  numCost > 0
                    ? isBelowCost
                      ? 'text-red-400'
                      : 'text-emerald-400'
                    : 'text-slate-400'
                }">
                  ${
                    numCost > 0
                      ? `${profit >= 0 ? '+' : ''}${formatKzNumber(profit)} Kz`
                      : 'Indique custo para calcular lucro'
                  }
                </span>
              </div>
              ${
                numCost > 0
                  ? `<div class="text-right">
                      <span class="text-[10px] text-slate-400 block uppercase tracking-wider">Margem s/ Venda</span>
                      <span class="text-xs font-mono font-bold ${isBelowCost ? 'text-red-400' : 'text-emerald-300'}">
                        ${marginPct.toFixed(1)}% · Markup: ${markupPct.toFixed(1)}%
                      </span>
                    </div>`
                  : ''
              }
            </div>
          </div>

          <!-- SEÇÃO 3: Fiscalidade & Regime de IVA (Conformidade AGT) -->
          <div class="flex flex-col gap-2.5 pt-2 border-t border-slate-800">
            <span class="text-[11px] font-bold text-amber-400 uppercase tracking-wider">
              3. Fiscalidade, Regime de IVA & Isenção
            </span>

            <div class="grid grid-cols-2 gap-2.5">
              <div>
                <label class="font-medium text-slate-300 block mb-1">Taxa de IVA Aplicável</label>
                <select
                  id="mobile-product-ivarate-select"
                  name="ivaRate"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="14" ${currentIva === 14 ? 'selected' : ''}>14% - Taxa Geral (IVA)</option>
                  <option value="0" ${currentIva === 0 ? 'selected' : ''}>0% - Isento (Cesta Básica / CIVA)</option>
                  <option value="7" ${currentIva === 7 ? 'selected' : ''}>7% - Regime Especial</option>
                  <option value="5" ${currentIva === 5 ? 'selected' : ''}>5% - Taxa Reduzida</option>
                  <option value="1" ${currentIva === 1 ? 'selected' : ''}>1% - Cabinda (Lei n.º 14/23)</option>
                </select>
              </div>

              <div>
                <label class="font-medium text-slate-300 block mb-1">Estado do Registo</label>
                <select
                  name="active"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-white font-medium focus:outline-none focus:border-blue-500"
                >
                  <option value="true" ${currentActive ? 'selected' : ''}>✅ Activo (Visível nas vendas)</option>
                  <option value="false" ${!currentActive ? 'selected' : ''}>❌ Inactivo (Ocultar no POS)</option>
                </select>
              </div>
            </div>

            <!-- Campo de Motivo de Isenção (CIVA) -->
            <div id="mobile-product-exemption-container" class="${currentIva === 0 ? 'block' : 'hidden'}">
              <label class="font-medium text-amber-300 block mb-1">Motivo de Isenção Legal (CIVA) *</label>
              <select
                name="exemptionReason"
                class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-amber-900/80 text-white focus:outline-none focus:border-amber-500"
              >
                ${DEFAULT_IVA_EXEMPTION_REASONS.map(
                  (reason) => `<option value="${escapeHtml(reason)}" ${currentExemption === reason ? 'selected' : ''}>${escapeHtml(reason)}</option>`
                ).join('')}
              </select>
            </div>
          </div>

          <!-- SEÇÃO 4: Gestão de Inventário & Stock -->
          <div class="flex flex-col gap-2.5 pt-2 border-t border-slate-800">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-bold text-purple-400 uppercase tracking-wider">
                4. Controlo de Stock & Inventário
              </span>
              <label class="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  id="mobile-product-trackstock-checkbox"
                  name="trackStock"
                  ${currentTrackStock ? 'checked' : ''}
                  class="h-4 w-4 rounded border-slate-700 bg-slate-950 text-blue-600 focus:ring-0"
                />
                <span class="text-xs text-slate-300">Controlar Stock</span>
              </label>
            </div>

            <div id="mobile-product-stock-fields" class="grid grid-cols-2 gap-2.5 ${currentTrackStock ? 'block' : 'hidden'}">
              <div>
                <label class="font-medium text-slate-300 block mb-1">Qtd em Stock Atual</label>
                <input
                  type="text"
                  inputmode="numeric"
                  name="stockQty"
                  value="${escapeHtml(currentStockQty)}"
                  placeholder="0"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono text-white focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label class="font-medium text-slate-300 block mb-1">Stock Mínimo (Alerta)</label>
                <input
                  type="text"
                  inputmode="numeric"
                  name="minStockQty"
                  value="${escapeHtml(currentMinStock)}"
                  placeholder="5"
                  class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 font-mono text-white focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          </div>

          <!-- Botões Finais de Ação -->
          <div class="pt-4 border-t border-slate-800 flex gap-2.5">
            <button
              type="submit"
              class="flex-1 h-[52px] rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm tracking-wide shadow-lg shadow-blue-600/30 active:scale-[0.98] transition-all flex items-center justify-center gap-2"
            >
              ${ICONS.check}
              <span>${isEditing ? 'Actualizar Artigo' : 'Guardar Artigo'}</span>
            </button>
            <button
              type="button"
              data-action="mobile-close-modals"
              class="h-[52px] px-5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 font-semibold text-xs active:scale-95"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

// ==================== 11. MODAIS AUXILIARES (CLIENTE, EMPRESA, SELETOR) ====================

function renderMobileQuickCustomerModal(): string {
  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in">
      <div class="bg-slate-900 border border-slate-800 w-full max-w-md rounded-t-3xl sm:rounded-2xl p-5 flex flex-col gap-4 max-h-[90dvh] overflow-y-auto">
        <div class="flex items-center justify-between pb-2 border-b border-slate-800">
          <h3 class="text-base font-bold text-white flex items-center gap-2">
            ${ICONS.users}
            <span>Novo Cliente</span>
          </h3>
          <button type="button" data-action="mobile-close-modals" class="text-slate-400 hover:text-white p-1">
            ${ICONS.close}
          </button>
        </div>

        <form id="mobile-quick-customer-form" class="flex flex-col gap-3">
          <div>
            <label class="text-xs font-medium text-slate-300 block mb-1">Nome do Cliente *</label>
            <input
              type="text"
              name="name"
              required
              placeholder="Ex.: António Manuel ou Empresa XYZ"
              class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label class="text-xs font-medium text-slate-300 block mb-1">NIF (ou 999999999 para Consumidor Final)</label>
            <input
              type="text"
              name="nif"
              placeholder="Ex.: 5001234567"
              class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-blue-500"
            />
          </div>

          <div class="grid grid-cols-2 gap-2">
            <div>
              <label class="text-xs font-medium text-slate-300 block mb-1">Telefone</label>
              <input
                type="tel"
                name="phone"
                placeholder="Ex.: 923456789"
                class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white font-mono focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label class="text-xs font-medium text-slate-300 block mb-1">Localidade</label>
              <input
                type="text"
                name="locality"
                placeholder="Ex.: Luanda"
                class="w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <div class="pt-2 flex gap-2">
            <button
              type="submit"
              class="flex-1 h-12 rounded-xl bg-blue-600 hover:bg-blue-500 text-white font-bold text-sm shadow-md active:scale-[0.98]"
            >
              Guardar e Seleccionar
            </button>
            <button
              type="button"
              data-action="mobile-close-modals"
              class="h-12 px-4 rounded-xl bg-slate-800 text-slate-300 text-xs font-medium"
            >
              Cancelar
            </button>
          </div>
        </form>
      </div>
    </div>
  `;
}

function renderMobileQuickCompanyModal(props: MobileOperationalProps): string {
  const {
    activeCompany,
    settings,
    companyMasterDraftProfile,
    companyMasterDraftSettings,
    companyMasterSection,
    companySeries,
    canManageCompanySettings,
    companyFormError,
    companyFormSavedNotice,
    showRequestAgtSeriesForm,
    confirmFinalizeSeriesId,
    agtSeriesErrorMessage,
    agtSeriesSuccessMessage,
    showEstablishmentForm,
    editingEstablishment,
    establishmentError,
    showWarehouseForm,
    editingWarehouse,
    warehouseError,
    operator,
  } = props;

  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in">
      <div class="bg-slate-950 border border-slate-800 w-full max-w-lg rounded-t-3xl sm:rounded-2xl flex flex-col max-h-[94dvh] overflow-hidden shadow-2xl">
        <div class="px-4 py-3 border-b border-slate-800 bg-slate-900 flex items-center justify-between shrink-0">
          <div class="flex items-center gap-2 min-w-0">
            <div class="h-8 w-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center shrink-0">
              ${ICONS.building}
            </div>
            <div class="min-w-0">
              <h3 class="text-sm font-bold text-white truncate">Ficha Mestre da Empresa</h3>
              <p class="text-[11px] text-slate-400 truncate">9 secções fiscais e operacionais · Paridade total</p>
            </div>
          </div>
          <button
            type="button"
            data-action="mobile-close-modals"
            class="h-9 w-9 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center shrink-0"
          >
            ${ICONS.close}
          </button>
        </div>

        <div class="flex-1 overflow-y-auto overscroll-contain p-4">
          ${renderCompanyMasterSection({
            mode: 'MOBILE',
            company: activeCompany,
            settings,
            draftProfile: companyMasterDraftProfile,
            draftSettings: companyMasterDraftSettings,
            series: companySeries,
            canManage: canManageCompanySettings,
            activeSection: companyMasterSection,
            formId: 'mobile-quick-company-form',
            showRequestAgtSeriesForm,
            confirmFinalizeSeriesId,
            agtSeriesErrorMessage,
            agtSeriesSuccessMessage,
            showEstablishmentForm,
            editingEstablishment,
            establishmentError,
            showWarehouseForm,
            editingWarehouse,
            warehouseError,
            errorMessage: companyFormError,
            savedNotice: companyFormSavedNotice,
            operator,
          })}
        </div>

        <div class="px-4 py-3 border-t border-slate-800 bg-slate-900/95 flex items-center gap-2 shrink-0">
          <button
            type="submit"
            form="mobile-quick-company-form"
            ${!canManageCompanySettings ? 'disabled' : ''}
            class="flex-1 h-12 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-bold text-sm shadow-md active:scale-[0.98] flex items-center justify-center gap-2"
          >
            ${ICONS.check}
            <span>${companyFormSavedNotice ? 'Guardado' : 'Guardar Ficha'}</span>
          </button>
          <button
            type="button"
            data-action="mobile-close-modals"
            class="h-12 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderMobileCustomerPickerModal(props: MobileOperationalProps): string {
  const { customers } = props;

  return `
    <div class="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4 animate-in fade-in">
      <div class="bg-slate-900 border border-slate-800 w-full max-w-md rounded-t-3xl sm:rounded-2xl p-5 flex flex-col gap-3 max-h-[85dvh] overflow-hidden">
        <div class="flex items-center justify-between pb-2 border-b border-slate-800">
          <h3 class="text-base font-bold text-white flex items-center gap-2">
            ${ICONS.users}
            <span>Seleccionar Cliente</span>
          </h3>
          <button type="button" data-action="mobile-close-modals" class="text-slate-400 hover:text-white p-1">
            ${ICONS.close}
          </button>
        </div>

        <div class="overflow-y-auto divide-y divide-slate-800/80 pr-1 max-h-[60dvh]">
          ${customers
            .map(
              (c) => `
            <button
              type="button"
              data-action="mobile-choose-customer"
              data-customer-id="${escapeHtml(c.id)}"
              class="w-full p-3 text-left hover:bg-slate-800/60 flex items-center justify-between transition-colors"
            >
              <div>
                <p class="text-sm font-semibold text-white">${escapeHtml(c.name)}</p>
                <p class="text-xs text-slate-400 font-mono tabular-nums">NIF: ${escapeHtml(c.nif || 'Consumidor Final')}</p>
              </div>
              <span class="text-slate-500">${ICONS.chevronRight}</span>
            </button>
          `
            )
            .join('')}
        </div>

        <div class="pt-2">
          <button
            type="button"
            data-action="mobile-open-quick-customer"
            class="w-full h-11 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-bold text-xs flex items-center justify-center gap-1.5"
          >
            ${ICONS.plus}
            <span>Cadastrar Outro Cliente</span>
          </button>
        </div>
      </div>
    </div>
  `;
}
