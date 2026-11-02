import { onAuthStateChanged, User } from 'firebase/auth';
import {
  calculateCashSessionSummary,
  calculateInvoiceTotals,
  doesInvoiceBelongToSession,
  extractInvoiceSaleReceipts,
  formatDateTimePt,
  formatKzNumber,
  generateNextInvoiceNumber,
  roundKz,
} from '../src/core/billingEngine';
import {
  AppSettings,
  canCompanyHideViralFooter,
  canCompanyManageMultiOperatorTeam,
  canCompanySyncCloudData,
  CartDraftItem,
  CashMovement,
  CashMovementType,
  CashSession,
  CashSessionSummary,
  CLOUD_PROTECTION_NUDGE_INVOICES,
  CLOUD_PROTECTION_NUDGE_RECORDS,
  CompanyMember,
  CompanyOperationalStatus,
  CompanyRecord,
  CompanyRole,
  Customer,
  DEFAULT_IVA_EXEMPTION_REASONS,
  DEFAULT_PRODUCT_CATEGORIES,
  DEFAULT_PRODUCT_UNITS,
  DEFAULT_SETTINGS,
  DirectPaymentMethod,
  DocumentFormat,
  DocumentType,
  FREE_COURTESY_BUFFER,
  FREE_MONTHLY_INVOICE_LIMIT,
  FREE_SOFT_NOTICE_THRESHOLD,
  getDirectCustomerIdForCompany,
  GrowthTriggerReason,
  hasPaidCommercialEntitlement,
  InvoiceRecord,
  isJaimonaOwnerEmail,
  isPlatformAdminEmail,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  PaymentMethod,
  PaymentSplit,
  PlanTier,
  Product,
  ProductPriceChange,
  shouldShowViralDocumentFooter,
  SuspendedSale,
  TaxRate,
  VITRONIS_INSTITUTIONAL,
} from '../src/core/types';
import {
  filterCustomersSmart,
  filterInvoicesSmart,
  searchProductsSmart,
  SmartProductSearchResult,
} from '../src/core/smartSearch';
import { UNASSIGNED_TENANT_RECORD } from '../src/core/seedData';
import {
  cancelInvoiceCloud,
  createCashMovementCloud,
  createInvoiceCloud,
  ensureCompanyRegisteredCloud,
  pullCompanyFromCloud,
  pullOwnedCompaniesFromCloud,
  removeCustomerCloud,
  removeProductCloud,
  updateProductStockCloud,
  upsertCashSessionCloud,
  upsertCompanyMemberCloud,
  upsertCustomerCloud,
  upsertProductCloud,
  upsertSettingsCloud,
} from '../src/services/cloudSync';
import {
  auth,
  formatFirebaseAuthErrorPt,
  isUnauthorizedDomainError,
  signInWithGoogle,
  signOutFirebase,
  validateFirestoreConnection,
} from '../src/services/firebaseClient';
import {
  bootstrapLocalStore,
  CompanyWorkspaceBundle,
  loadCompanyWorkspace,
  localDb,
  registerNewCompanyLocal,
  restorePreMulticompanySnapshot,
  WorkspaceViewerIdentity,
} from '../src/services/localStore';
import {
  AdminAuditEntry,
  AdminCompanySummary,
  BackendHealthStatus,
  cancelInvoiceBackend,
  downloadCloudBackupJson,
  fetchBackendHealth,
  fetchCompanyWorkspaceBackend,
  fetchPlatformAdminOverview,
  logPlatformSupportAccess,
  registerCompanyBackend,
  requestEnsureAuthDomains,
  submitInvoiceAudit,
  updatePlatformCompanyAdmin,
} from './services/backendApi';
import {
  generateInvoiceQrDataUrl,
  renderCashClosureReportHtml,
  renderDocumentHtml,
} from './ui/documentRenderer';
import { ICONS } from './ui/icons';
import {
  formatPlanLabelPt,
  formatRoleLabelPt,
  renderCancelInvoiceModal,
  renderCompanySwitcherDropdown,
  renderFriendlyGrowthModal,
  renderMasterAdminModal,
  renderNewCompanyModal,
  renderTenantOnboardingView,
} from './ui/multicompanyModals';

type ActiveModule =
  | 'NEW_POS'
  | 'NEW_A4'
  | 'CASH'
  | 'CUSTOMERS'
  | 'PRODUCTS'
  | 'HISTORY'
  | 'SETTINGS'
  | 'SYNC';

type SidebarState = 'EXPANDED' | 'ICONS' | 'HIDDEN';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseDecimalInput(raw: string): number {
  const cleaned = String(raw || '')
    .replace(/kz/gi, '')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) return 0;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;

  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? roundKz(parsed) : Number.NaN;
}

function formatStorageErrorPt(err: unknown, entityLabel: string): string {
  const detail = err instanceof Error ? err.message : String(err || '');
  if (/quota/i.test(detail)) {
    return `Espaço de armazenamento cheio no dispositivo ao guardar ${entityLabel}.`;
  }
  return detail
    ? `Não foi possível guardar ${entityLabel}: ${detail}`
    : `Não foi possível guardar ${entityLabel} na base de dados local.`;
}

export class SilaBillingApp {
  private root: HTMLElement;

  // Navegação e Layout
  private activeModule: ActiveModule = 'NEW_POS';
  private sidebarState: SidebarState =
    typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'EXPANDED' : 'ICONS';

  // Contexto Multiempresa e Dados Persistentes (IndexedDB v2 + Firestore)
  private activeCompany: CompanyRecord = UNASSIGNED_TENANT_RECORD;
  private companies: CompanyRecord[] = [];
  private requiresCompanyOnboarding = false;
  private members: CompanyMember[] = [];
  private hasPreMigrationBackup = false;
  private products: Product[] = [];
  private customers: Customer[] = [];
  private invoices: InvoiceRecord[] = [];
  private settings: AppSettings = DEFAULT_SETTINGS;
  private isBooting = true;

  // Estado POS / Emissão Unificada
  private posSearch = '';
  private posCategoryFilter = 'ALL';
  private posTaxFilter: 'ALL' | 14 | 0 = 'ALL';
  private posStockOnlyFilter = false;
  private cart: CartDraftItem[] = [];
  private globalDiscountPct = 0;
  private globalDiscountInput = '';
  private selectedCustomerId = 'cust_direct';
  private showCustomerPicker = false;
  private posCustomerSearch = '';
  private showQuickCustomerForm = false;
  private showQuickProductForm = false;
  private quickProductDraft = {
    code: '',
    barcode: '',
    name: '',
    category: 'Mercearia',
    costPrice: '',
    price: '',
    unit: 'un',
    ivaRate: 14 as TaxRate,
    trackStock: false,
    stockQty: '',
  };
  private quickProductError: string | null = null;
  private docType: DocumentType = 'FR';
  private paymentMethod: PaymentMethod = 'Dinheiro';
  private amountReceivedInput = '';
  private transferReference = '';
  private splitInputs: Record<DirectPaymentMethod, string> = {
    Dinheiro: '',
    Multicaixa: '',
    Transferência: '',
  };
  private notes = 'Venda directa a retalho.';
  private cashier = '01';
  private operator = '001';
  private showOptionsDrawer = false;
  private suspendedSales: SuspendedSale[] = [];
  private showSuspendedDrawer = false;
  private confirmRemoveCartProductId: string | null = null;
  private confirmClearCart = false;
  private returnOriginInvoice: {
    id: string;
    number: string;
    creditAmount: number;
  } | null = null;
  private mobilePane: 'CATALOG' | 'CART' | 'PREVIEW' = 'CATALOG';
  private previewFormat: DocumentFormat = 'POS';
  private lastEmitted: InvoiceRecord | null = null;
  private isEmitting = false;
  private isPrinting = false;
  private lastAuditHash = '';
  private draftSaveTimer: number | null = null;

  // Estado Produtos / Clientes / Histórico
  private productSearch = '';
  private productFilter: 'ALL' | 'ACTIVE' | 'INACTIVE' | 'LOW_STOCK' = 'ALL';
  private productCategoryFilter = 'ALL';
  private selectedProductDetailId = '';
  private editingProduct: Product | null = null;
  private editingProductCostInput = '';
  private editingProductMarkupInput = '';
  private editingProductPriceInput = '';
  private editingProductStockInput = '';
  private editingProductMinStockInput = '';
  private isNewProduct = false;
  private productFormError: string | null = null;
  private productSavedNotice: string | null = null;
  private quickStockProductId: string | null = null;
  private quickStockAdjustInput = '';
  private confirmDeleteProductId: string | null = null;

  private customerSearch = '';
  private customerFilter: 'ALL' | 'WITH_DEBT' | 'WITH_LIMIT' = 'ALL';
  private selectedCustomerDetailId = '';
  private editingCustomer: Customer | null = null;
  private editingCustomerCreditLimitInput = '';
  private isNewCustomer = false;
  private customerFormError: string | null = null;
  private customerSavedNotice: string | null = null;
  private quickCustomerDraft = { name: '', nif: '', phone: '', address: '', locality: '' };
  private quickCustomerError: string | null = null;
  private dbBootError: string | null = null;

  private historySearch = '';
  private historyDebtOnly = false;
  private selectedHistoryId = '';
  private historyViewFormat: DocumentFormat = 'POS';
  private settlingInvoiceId: string | null = null;
  private settlingCustomerAccountId: string | null = null;
  private settleAmountInput = '';
  private settleMethod: DirectPaymentMethod = 'Dinheiro';
  private settleReference = '';
  private settleError: string | null = null;

  // Estado Caixa e Pagamentos (Turnos, Fundo Inicial, Sangria, Reforço, Entradas/Saídas e Fecho)
  private cashSessions: CashSession[] = [];
  private cashMovements: CashMovement[] = [];
  private selectedCashSessionId = '';
  private activeCashActionPanel:
    | 'OPEN'
    | 'REFORCO'
    | 'SANGRIA'
    | 'ENTRADA'
    | 'SAIDA'
    | 'CLOSE'
    | null = null;
  private cashOpenDraft = { cashier: '01', operator: '001', openingFloat: '', notes: '' };
  private cashOpenError: string | null = null;
  private cashMovementDraft = {
    amount: '',
    paymentMethod: 'Dinheiro' as DirectPaymentMethod,
    reason: '',
    reference: '',
  };
  private cashMovementError: string | null = null;
  private cashWorkspaceNotice: string | null = null;
  private cashCloseCountedInput = '';
  private cashCloseOperator = '';
  private cashCloseNotes = '';
  private cashCloseError: string | null = null;
  private showDenominationHelper = false;
  private denomCounts: Record<number, string> = {
    5000: '',
    2000: '',
    1000: '',
    500: '',
    200: '',
    100: '',
    50: '',
  };
  private cashLedgerFilter: 'ALL' | 'DRAWER' | 'SALES' | 'INFLOWS' | 'OUTFLOWS' = 'ALL';
  private cashLedgerSearch = '';
  private posQuickCashPanel: 'OPEN' | 'REFORCO' | 'SANGRIA' | null = null;
  private posQuickCashAmount = '';
  private posQuickCashReason = '';
  private posQuickCashError: string | null = null;

  // Estado Multiempresa, Permissões (RBAC) e Painel Master SILA-Billing
  private showCompanyDropdown = false;
  private showNewCompanyModal = false;
  private newCompanyError: string | null = null;
  private isCreatingCompany = false;
  private cancellingInvoiceId: string | null = null;
  private cancelInvoiceError: string | null = null;
  private selectedTerminalRole: CompanyRole = 'owner';
  private memberFormError: string | null = null;

  private showMasterAdminModal = false;
  private isAuthenticatingAdmin = false;
  private masterAdminLoading = false;
  private masterAdminDenied = false;
  private masterAdminError: string | null = null;
  private masterAdminSearch = '';
  private adminCloudCompanies: AdminCompanySummary[] = [];
  private adminAuditLogs: AdminAuditEntry[] = [];
  private supportCompanyId: string | null = null;

  // Estado Configurações / Cloud / PWA
  private settingsSavedNotice = false;
  private settingsErrorMessage: string | null = null;
  private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private user: User | null = null;
  private isSyncing = false;
  private lastSyncedIso: string | null = null;
  private syncMessage: string | null = null;
  private backendHealth: BackendHealthStatus | null = null;

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private isInstalled = false;
  private isIOS = false;
  private isIOSInAppBrowser = false;
  private iosBannerDismissed = false;
  private showIOSGuide = false;

  // Crescimento Orgânico & Ativação Institucional VITRONIS
  private growthModalReason: GrowthTriggerReason | null = null;
  private copiedIbanFeedback = false;
  private isVerifyingPlan = false;
  private growthModalNotice: string | null = null;

  // Leitor de Código de Barras (USB/Bluetooth HID) & Feedback Rápido no POS
  private barcodeBuffer = '';
  private barcodeLastKeyTime = 0;
  private scannerNotice: string | null = null;
  private scannerNoticeIsError = false;
  private scannerNoticeTimer: number | null = null;

  // Cache de QR Codes para renderização fluida sem flicker
  private qrCache = new Map<string, string>();
  private printJob: { invoice: InvoiceRecord; format: DocumentFormat; qr: string } | null = null;
  private cashPrintJob: {
    session: CashSession;
    summary: CashSessionSummary;
    format: DocumentFormat;
  } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  private getViewerIdentity(): WorkspaceViewerIdentity | null {
    if (!this.user) return null;
    return {
      uid: this.user.uid,
      email: this.user.email,
      supportCompanyId: this.supportCompanyId,
    };
  }

  public async mount(): Promise<void> {
    this.setupGlobalListeners();
    this.render();

    validateFirestoreConnection();

    // Aguarda brevemente pela restauração da sessão Firebase Auth (com timeout curto de 600ms
    // para nunca atrasar terminais offline/Windows 7), evitando injetar empresas alheias no arranque.
    try {
      if (typeof auth.authStateReady === 'function') {
        await Promise.race([
          auth.authStateReady(),
          new Promise<void>((resolve) => window.setTimeout(resolve, 600)),
        ]);
      }
      this.user = auth.currentUser;
    } catch {
      // Prossegue normalmente em modo local caso Auth esteja indisponível
    }

    try {
      const data = await bootstrapLocalStore(undefined, this.getViewerIdentity());
      this.applyWorkspaceBundle(data);
      this.dbBootError = null;
    } catch (err) {
      this.dbBootError = formatStorageErrorPt(err, 'os dados iniciais do terminal');
    } finally {
      this.isBooting = false;
      this.render();
      this.refreshBackendHealth();
    }

    let lastAuthKey = '';

    onAuthStateChanged(auth, async (u) => {
      const nextAuthKey = u ? `${u.uid}|${u.email || ''}` : '';
      const authChanged = nextAuthKey !== lastAuthKey;
      lastAuthKey = nextAuthKey;
      this.user = u;

      if (!u) {
        this.masterAdminDenied = false;
        this.adminCloudCompanies = [];
        this.adminAuditLogs = [];
        this.supportCompanyId = null;
        if (authChanged) {
          try {
            const localBundle = await bootstrapLocalStore(undefined, null);
            this.applyWorkspaceBundle(localBundle);
          } catch {
            // Mantém estado atual
          }
        }
        this.render();
        return;
      }

      if (authChanged) {
        try {
          if (this.isOnline) {
            const ownedCloud = await pullOwnedCompaniesFromCloud();
            for (const cloudComp of ownedCloud) {
              await localDb.saveCompany(cloudComp);
            }
          }
          const scopedBundle = await loadCompanyWorkspace(
            this.activeCompany.id,
            this.getViewerIdentity()
          );
          this.applyWorkspaceBundle(scopedBundle);
        } catch {
          // Mantém workspace seguro
        }
      }

      this.render();
      if (this.isOnline) {
        if (this.showMasterAdminModal) {
          void this.refreshMasterAdminData();
        }
        if (
          !this.requiresCompanyOnboarding &&
          this.activeCompany.id &&
          (authChanged || this.hasUnsyncedLocalRecords())
        ) {
          void this.syncAllWithCloud();
        }
      }
    });
  }

  private applyWorkspaceBundle(data: CompanyWorkspaceBundle): void {
    this.activeCompany = data.activeCompany;
    this.companies = data.companies;
    this.requiresCompanyOnboarding = Boolean(
      data.requiresCompanyOnboarding || !data.activeCompany.id
    );
    this.members = data.members;
    this.hasPreMigrationBackup = data.hasPreMigrationBackup;
    this.products = data.products;
    this.customers = data.customers;
    this.invoices = data.invoices;
    this.settings = data.settings;

    const directCustId = getDirectCustomerIdForCompany(data.activeCompany.id);
    this.selectedCustomerId = directCustId;
    this.cart = [];
    this.globalDiscountPct = 0;
    this.globalDiscountInput = '';
    this.amountReceivedInput = '';
    this.transferReference = '';
    this.splitInputs = { Dinheiro: '', Multicaixa: '', Transferência: '' };
    this.docType = data.settings.defaultDocType || 'FR';
    this.cashier = data.settings.defaultCashier || '01';
    this.operator = data.settings.defaultOperator || '001';
    this.notes = data.settings.defaultNotes || 'Venda directa a retalho.';
    this.selectedHistoryId = data.invoices[0]?.id || '';
    this.lastEmitted = null;
    this.lastAuditHash = '';
    this.editingProduct = null;
    this.editingProductCostInput = '';
    this.editingProductMarkupInput = '';
    this.editingProductPriceInput = '';
    this.editingProductStockInput = '';
    this.editingProductMinStockInput = '';
    this.productFilter = 'ALL';
    this.productCategoryFilter = 'ALL';
    this.selectedProductDetailId = data.products[0]?.id || '';
    this.quickStockProductId = null;
    this.quickStockAdjustInput = '';
    this.confirmDeleteProductId = null;
    this.productFormError = null;
    this.productSavedNotice = null;
    this.showQuickProductForm = false;
    this.quickProductError = null;
    this.editingCustomer = null;
    this.editingCustomerCreditLimitInput = '';
    this.isNewCustomer = false;
    this.customerFormError = null;
    this.customerSavedNotice = null;
    this.customerFilter = 'ALL';
    this.selectedCustomerDetailId =
      data.customers.find((c) => c.id !== directCustId)?.id || data.customers[0]?.id || '';
    this.quickCustomerError = null;
    this.cancellingInvoiceId = null;
    this.cancelInvoiceError = null;
    this.settlingInvoiceId = null;
    this.settlingCustomerAccountId = null;
    this.settleError = null;
    this.confirmRemoveCartProductId = null;
    this.confirmClearCart = false;
    this.returnOriginInvoice = null;
    this.showSuspendedDrawer = false;
    this.suspendedSales = [];
    this.cashSessions = Array.isArray(data.cashSessions) ? data.cashSessions : [];
    this.cashMovements = Array.isArray(data.cashMovements) ? data.cashMovements : [];
    this.activeCashActionPanel = null;
    this.cashOpenError = null;
    this.cashMovementError = null;
    this.cashWorkspaceNotice = null;
    this.cashCloseCountedInput = '';
    this.cashCloseNotes = '';
    this.cashCloseError = null;
    this.showDenominationHelper = false;
    this.denomCounts = { 5000: '', 2000: '', 1000: '', 500: '', 200: '', 100: '', 50: '' };
    this.cashLedgerFilter = 'ALL';
    this.cashLedgerSearch = '';
    this.posQuickCashPanel = null;
    this.posQuickCashAmount = '';
    this.posQuickCashReason = '';
    this.posQuickCashError = null;
    this.settingsErrorMessage = null;
    this.memberFormError = null;
    this.growthModalReason = null;
    this.growthModalNotice = null;

    if (data.posDraft) {
      this.activeModule = data.posDraft.activeModule || 'NEW_POS';
      this.previewFormat = data.posDraft.previewFormat || 'POS';
      this.cart = Array.isArray(data.posDraft.cart) ? data.posDraft.cart : [];
      if (typeof data.posDraft.globalDiscountPct === 'number' && data.posDraft.globalDiscountPct > 0) {
        this.globalDiscountPct = Math.min(100, Math.max(0, data.posDraft.globalDiscountPct));
        this.globalDiscountInput = String(this.globalDiscountPct);
      }
      if (
        data.posDraft.selectedCustomerId &&
        this.customers.some((c) => c.id === data.posDraft!.selectedCustomerId)
      ) {
        this.selectedCustomerId = data.posDraft.selectedCustomerId;
      }
      if (data.posDraft.docType) this.docType = data.posDraft.docType;
      if (data.posDraft.paymentMethod) this.paymentMethod = data.posDraft.paymentMethod;
      if (typeof data.posDraft.amountReceivedInput === 'string') {
        this.amountReceivedInput = data.posDraft.amountReceivedInput;
      }
      if (typeof data.posDraft.transferReference === 'string') {
        this.transferReference = data.posDraft.transferReference;
      }
      if (Array.isArray(data.posDraft.paymentSplits)) {
        for (const sp of data.posDraft.paymentSplits) {
          if (sp && (sp.method === 'Dinheiro' || sp.method === 'Multicaixa' || sp.method === 'Transferência')) {
            this.splitInputs[sp.method] = sp.amount > 0 ? String(sp.amount) : '';
          }
        }
      }
      if (typeof data.posDraft.notes === 'string') this.notes = data.posDraft.notes;
      if (data.posDraft.cashier) this.cashier = data.posDraft.cashier;
      if (data.posDraft.operator) this.operator = data.posDraft.operator;
    }

    const activeOpenSession = this.getActiveOpenCashSession();
    if (activeOpenSession) {
      this.selectedCashSessionId = activeOpenSession.id;
      this.cashier = activeOpenSession.cashier;
      this.operator = activeOpenSession.operator;
    } else {
      this.selectedCashSessionId = this.cashSessions[0]?.id || '';
    }
    this.cashOpenDraft = {
      cashier: this.cashier || '01',
      operator: this.operator || '001',
      openingFloat: '',
      notes: '',
    };
    this.cashCloseOperator = this.operator || '001';

    if (data.activeCompany.id) {
      const targetCompId = data.activeCompany.id;
      void localDb.getSuspendedSales(targetCompId).then((sales) => {
        if (this.activeCompany.id === targetCompId) {
          this.suspendedSales = sales;
          if (sales.length > 0 && (this.activeModule === 'NEW_POS' || this.activeModule === 'NEW_A4')) {
            this.render();
          }
        }
      });
    }

    if (typeof document !== 'undefined') {
      document.title =
        this.requiresCompanyOnboarding || !this.activeCompany.id
          ? 'SILA-Billing'
          : `SILA-Billing — ${this.settings.company.shortName}`;
    }
  }

  private getVerifiedMaxRole(): CompanyRole {
    if (!this.user) {
      return 'owner';
    }
    const emailLower = (this.user.email || '').trim().toLowerCase();
    if (isPlatformAdminEmail(emailLower) && this.supportCompanyId === this.activeCompany.id) {
      return 'owner';
    }
    if (!this.activeCompany.ownerUid || this.activeCompany.ownerUid === this.user.uid) {
      return 'owner';
    }
    const compOwnerEmail = (this.activeCompany.ownerEmail || '').trim().toLowerCase();
    if (emailLower && compOwnerEmail && compOwnerEmail === emailLower) {
      return 'owner';
    }
    if (this.activeCompany.id === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(emailLower)) {
      return 'owner';
    }
    const matched = this.members.find(
      (m) =>
        m.active &&
        (m.uid === this.user!.uid || (emailLower && m.email.trim().toLowerCase() === emailLower))
    );
    if (matched) {
      return matched.role;
    }
    return this.members.length === 0 ? 'owner' : 'cashier';
  }

  private getEffectiveRole(): CompanyRole {
    const rank: Record<CompanyRole, number> = { owner: 3, manager: 2, cashier: 1 };
    const maxRole = this.getVerifiedMaxRole();
    return rank[this.selectedTerminalRole] <= rank[maxRole] ? this.selectedTerminalRole : maxRole;
  }

  private isCompanySuspended(): boolean {
    return this.activeCompany.status === 'suspended';
  }

  private canManageCatalog(): boolean {
    const role = this.getEffectiveRole();
    return !this.isCompanySuspended() && (role === 'owner' || role === 'manager');
  }

  private canEditCartUnitPrice(): boolean {
    if (this.isCompanySuspended()) return false;
    const role = this.getEffectiveRole();
    if (role === 'owner' || role === 'manager') return true;
    return Boolean(this.settings.allowCashierPriceEdit);
  }

  private getCustomerOpenDebt(customerId: string): number {
    if (!customerId) return 0;
    let total = 0;
    for (const inv of this.invoices) {
      if (
        inv.status === 'issued' &&
        inv.docType === 'FR' &&
        inv.customerId === customerId &&
        typeof inv.amountDue === 'number' &&
        inv.amountDue > 0
      ) {
        total += inv.amountDue;
      }
    }
    return roundKz(total);
  }

  private getCustomerStats(customerId: string): {
    openDebt: number;
    openInvoiceCount: number;
    totalSpent: number;
    purchaseCount: number;
    invoices: InvoiceRecord[];
  } {
    const custInvoices = this.invoices.filter((inv) => inv.customerId === customerId);
    let openDebt = 0;
    let openInvoiceCount = 0;
    let totalSpent = 0;
    let purchaseCount = 0;

    for (const inv of custInvoices) {
      if (inv.status === 'issued' && inv.docType === 'FR') {
        purchaseCount += 1;
        totalSpent += inv.grandTotal;
        if (typeof inv.amountDue === 'number' && inv.amountDue > 0) {
          openDebt += inv.amountDue;
          openInvoiceCount += 1;
        }
      }
    }

    return {
      openDebt: roundKz(openDebt),
      openInvoiceCount,
      totalSpent: roundKz(totalSpent),
      purchaseCount,
      invoices: custInvoices,
    };
  }

  private getInvoiceRenderOptions(invoice: InvoiceRecord, showViralFooter: boolean): {
    showViralFooter: boolean;
    customerAddress?: string;
    customerPhone?: string;
  } {
    const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
    if (!invoice.customerId || invoice.customerId === directCustId) {
      return { showViralFooter };
    }
    const cust = this.customers.find((c) => c.id === invoice.customerId);
    if (!cust) return { showViralFooter };
    return {
      showViralFooter,
      customerAddress: cust.address || undefined,
      customerPhone: cust.phone || undefined,
    };
  }

  private buildSettledInvoiceRecord(
    inv: InvoiceRecord,
    appliedAmount: number,
    extraChange: number,
    method: DirectPaymentMethod,
    refText: string
  ): InvoiceRecord {
    const currentDue = roundKz(inv.amountDue || 0);
    const applied = Math.min(currentDue, roundKz(appliedAmount));
    const nextDue = Math.max(0, roundKz(currentDue - applied));
    const nextReceived = roundKz(inv.amountReceived + applied);
    const dt = formatDateTimePt(new Date().toISOString());
    const shortDate = dt.slashDate.slice(0, 5);
    const prevSummary =
      inv.paymentSummary || `${inv.paymentMethod}: ${formatKzNumber(inv.amountReceived)} Kz`;
    const nextSummary = `${prevSummary} + Liq. ${shortDate} ${method}: ${formatKzNumber(applied)} Kz`.slice(
      0,
      160
    );

    return {
      ...inv,
      initialAmountReceived:
        typeof inv.initialAmountReceived === 'number'
          ? inv.initialAmountReceived
          : inv.amountReceived,
      initialChangeAmount:
        typeof inv.initialChangeAmount === 'number' ? inv.initialChangeAmount : inv.changeAmount,
      amountReceived: nextReceived,
      amountDue: nextDue,
      changeAmount: extraChange > 0 ? extraChange : inv.changeAmount,
      paymentSummary: nextSummary,
      ...(refText ? { transferReference: refText } : {}),
      syncState: 'pending',
      synced: false,
      updatedAtIso: new Date().toISOString(),
    };
  }

  private getActiveOpenCashSession(): CashSession | null {
    const targetCashier = (this.cashier || '01').trim().toLowerCase();
    return (
      this.cashSessions.find(
        (s) => s.status === 'open' && s.cashier.trim().toLowerCase() === targetCashier
      ) ||
      this.cashSessions.find((s) => s.status === 'open') ||
      null
    );
  }

  private getOperatorSuggestions(): string[] {
    const opts = new Set<string>();
    if (this.settings.defaultOperator) opts.add(this.settings.defaultOperator.trim());
    if (this.operator) opts.add(this.operator.trim());
    for (const m of this.members) {
      if (m.active && m.displayName) {
        opts.add(m.displayName.trim().slice(0, 32));
      }
    }
    for (const s of this.cashSessions) {
      if (s.operator) opts.add(s.operator.trim());
    }
    return Array.from(opts).filter(Boolean);
  }

  private computeDenominationSum(): number {
    const denoms = [5000, 2000, 1000, 500, 200, 100, 50];
    let total = 0;
    for (const d of denoms) {
      const raw = (this.denomCounts[d] || '').trim();
      if (!raw) continue;
      const qty = parseInt(raw, 10);
      if (Number.isFinite(qty) && qty > 0) {
        total += d * qty;
      }
    }
    return roundKz(total);
  }

  private showCashNotice(message: string): void {
    this.cashWorkspaceNotice = message;
    window.setTimeout(() => {
      if (this.cashWorkspaceNotice === message) {
        this.cashWorkspaceNotice = null;
        if (this.activeModule === 'CASH') this.render();
      }
    }, 3200);
  }

  private async persistAndSyncCashSession(session: CashSession): Promise<void> {
    if (!this.activeCompany.id) return;
    await localDb.saveCashSession(session, this.activeCompany.id);
    const exists = this.cashSessions.some((s) => s.id === session.id);
    this.cashSessions = exists
      ? this.cashSessions.map((s) => (s.id === session.id ? session : s))
      : [session, ...this.cashSessions];
    this.cashSessions.sort((a, b) => b.openedAtIso.localeCompare(a.openedAtIso));

    if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
      void ensureCompanyRegisteredCloud(this.activeCompany)
        .then(() => upsertCashSessionCloud(session, this.activeCompany))
        .then(async () => {
          const synced: CashSession = { ...session, syncState: 'synced', synced: true };
          await localDb.saveCashSession(synced, this.activeCompany.id);
          this.cashSessions = this.cashSessions.map((s) => (s.id === synced.id ? synced : s));
          if (this.activeModule === 'CASH' || this.activeModule === 'SYNC') this.render();
        })
        .catch(() => null);
    }
  }

  private async persistAndSyncCashMovement(mov: CashMovement): Promise<void> {
    if (!this.activeCompany.id) return;
    await localDb.saveCashMovement(mov, this.activeCompany.id);
    const exists = this.cashMovements.some((m) => m.id === mov.id);
    this.cashMovements = exists
      ? this.cashMovements.map((m) => (m.id === mov.id ? mov : m))
      : [mov, ...this.cashMovements];
    this.cashMovements.sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso));

    if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
      void ensureCompanyRegisteredCloud(this.activeCompany)
        .then(() => createCashMovementCloud(mov, this.activeCompany))
        .then(async () => {
          const synced: CashMovement = { ...mov, syncState: 'synced', synced: true };
          await localDb.saveCashMovement(synced, this.activeCompany.id);
          this.cashMovements = this.cashMovements.map((m) => (m.id === synced.id ? synced : m));
          if (this.activeModule === 'CASH' || this.activeModule === 'SYNC') this.render();
        })
        .catch(() => null);
    }
  }

  private async openNewCashSession(params: {
    cashier: string;
    operator: string;
    openingFloat: number;
    openingNotes?: string;
  }): Promise<{ ok: boolean; error?: string; session?: CashSession }> {
    if (this.isCompanySuspended() || !this.activeCompany.id) {
      return { ok: false, error: 'Empresa suspensa ou não selecionada.' };
    }
    const cleanCashier = (params.cashier || '').trim().slice(0, 16) || '01';
    const cleanOperator = (params.operator || '').trim().slice(0, 32) || '001';
    const floatVal = roundKz(params.openingFloat);

    if (Number.isNaN(floatVal) || floatVal < 0 || floatVal > 999999999) {
      return { ok: false, error: 'Indique um fundo inicial válido (0,00 Kz ou superior).' };
    }

    const duplicateOpen = this.cashSessions.find(
      (s) => s.status === 'open' && s.cashier.trim().toLowerCase() === cleanCashier.toLowerCase()
    );
    if (duplicateOpen) {
      this.selectedCashSessionId = duplicateOpen.id;
      return {
        ok: false,
        error: `A Caixa ${duplicateOpen.cashier} já possui um turno em aberto (Operador ${duplicateOpen.operator}). Efetue o fecho antes de abrir novo turno.`,
      };
    }

    const now = new Date().toISOString();
    const cleanNotes = (params.openingNotes || '').trim().slice(0, 240);
    const session: CashSession = {
      id: `cs_${Date.now()}`,
      companyId: this.activeCompany.id,
      cashier: cleanCashier,
      operator: cleanOperator,
      openedByUid: this.user?.uid,
      status: 'open',
      openingFloat: floatVal,
      ...(cleanNotes ? { openingNotes: cleanNotes } : {}),
      openedAtIso: now,
      syncState: 'pending',
      synced: false,
      createdAtIso: now,
      updatedAtIso: now,
    };

    await this.persistAndSyncCashSession(session);
    this.selectedCashSessionId = session.id;
    this.cashier = cleanCashier;
    this.operator = cleanOperator;
    this.cashCloseOperator = cleanOperator;
    this.scheduleDraftSave();
    return { ok: true, session };
  }

  private async recordCashDrawerMovement(params: {
    session: CashSession;
    type: Exclude<CashMovementType, 'LIQUIDACAO_DIVIDA'>;
    amount: number;
    paymentMethod: DirectPaymentMethod;
    reason: string;
    reference?: string;
  }): Promise<{ ok: boolean; error?: string; movement?: CashMovement }> {
    if (this.isCompanySuspended() || !this.activeCompany.id) {
      return { ok: false, error: 'Operação indisponível neste estado da empresa.' };
    }
    if (params.session.status !== 'open') {
      return { ok: false, error: 'Apenas é possível registar movimentos num turno de caixa aberto.' };
    }
    const amt = roundKz(params.amount);
    if (Number.isNaN(amt) || amt <= 0 || amt > 999999999) {
      return { ok: false, error: 'Indique um montante positivo válido em Kz.' };
    }
    const cleanReason = (params.reason || '').trim().slice(0, 240);
    if (cleanReason.length < 2) {
      return { ok: false, error: 'Descreva o motivo ou justificação do movimento (mín. 2 caracteres).' };
    }

    const method: DirectPaymentMethod =
      params.type === 'REFORCO' || params.type === 'SANGRIA'
        ? 'Dinheiro'
        : params.paymentMethod || 'Dinheiro';

    if (params.type === 'SANGRIA') {
      const liveSummary = calculateCashSessionSummary(
        params.session,
        this.invoices,
        this.cashMovements
      );
      if (amt > Math.max(0, liveSummary.expectedCash)) {
        return {
          ok: false,
          error: `O valor da sangria (${formatKzNumber(amt)} Kz) excede o saldo esperado em numerário na gaveta (${formatKzNumber(Math.max(0, liveSummary.expectedCash))} Kz).`,
        };
      }
    }

    const now = new Date().toISOString();
    const cleanRef = (params.reference || '').trim().slice(0, 80);
    const movement: CashMovement = {
      id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      companyId: this.activeCompany.id,
      sessionId: params.session.id,
      cashier: params.session.cashier,
      operator: this.operator || params.session.operator,
      createdByUid: this.user?.uid,
      type: params.type,
      amount: amt,
      paymentMethod: method,
      reason: cleanReason,
      ...(cleanRef ? { reference: cleanRef } : {}),
      syncState: 'pending',
      synced: false,
      createdAtIso: now,
    };

    await this.persistAndSyncCashMovement(movement);
    return { ok: true, movement };
  }

  private async closeCashSessionById(params: {
    sessionId: string;
    countedCash: number;
    closedByOperator: string;
    closingNotes?: string;
  }): Promise<{ ok: boolean; error?: string; closed?: CashSession; summary?: CashSessionSummary }> {
    const target = this.cashSessions.find((s) => s.id === params.sessionId);
    if (!target || target.status !== 'open') {
      return { ok: false, error: 'Este turno já se encontra encerrado ou não foi encontrado.' };
    }
    const counted = roundKz(params.countedCash);
    if (Number.isNaN(counted) || counted < 0 || counted > 999999999) {
      return { ok: false, error: 'Informe o valor físico contado na gaveta (0,00 Kz ou superior).' };
    }
    const cleanClosedBy = (params.closedByOperator || target.operator || '001').trim().slice(0, 32);
    if (!cleanClosedBy) {
      return { ok: false, error: 'Identifique o operador responsável pelo fecho de caixa.' };
    }

    const summary = calculateCashSessionSummary(
      target,
      this.invoices,
      this.cashMovements,
      counted
    );
    const diff = summary.differenceAmount ?? 0;
    const cleanNotes = (params.closingNotes || '').trim().slice(0, 240);

    if (Math.abs(diff) >= 0.01 && cleanNotes.length < 3) {
      const diffType = diff > 0 ? 'sobra' : 'quebra';
      return {
        ok: false,
        error: `Existe uma ${diffType} de caixa (${diff > 0 ? '+' : ''}${formatKzNumber(diff)} Kz). Registe a justificação nas observações do fecho.`,
      };
    }

    const now = new Date().toISOString();
    const closedSession: CashSession = {
      ...target,
      status: 'closed',
      closedAtIso: now,
      closedByOperator: cleanClosedBy,
      ...(this.user?.uid ? { closedByUid: this.user.uid } : {}),
      expectedCash: summary.expectedCash,
      countedCash: counted,
      differenceAmount: diff,
      salesCash: summary.salesCash,
      salesMulticaixa: summary.salesMulticaixa,
      salesTransfer: summary.salesTransfer,
      salesCredit: summary.salesCredit,
      debtCash: summary.debtCash,
      debtMulticaixa: summary.debtMulticaixa,
      debtTransfer: summary.debtTransfer,
      reforcosTotal: summary.reforcosTotal,
      entradasTotal: summary.entradasTotal,
      sangriasTotal: summary.sangriasTotal,
      saidasTotal: summary.saidasTotal,
      invoiceCount: summary.invoiceCount,
      ...(cleanNotes ? { closingNotes: cleanNotes } : {}),
      syncState: 'pending',
      synced: false,
      updatedAtIso: now,
    };

    await this.persistAndSyncCashSession(closedSession);
    return { ok: true, closed: closedSession, summary };
  }

  private triggerCashReportPrint(
    session: CashSession,
    summary: CashSessionSummary,
    format: DocumentFormat
  ): void {
    this.isPrinting = true;
    document.body.setAttribute('data-print-mode', format);
    this.printJob = null;
    this.cashPrintJob = { session, summary, format };
    this.render();
    window.setTimeout(() => {
      try {
        window.print();
      } finally {
        window.setTimeout(() => {
          this.isPrinting = false;
        }, 1200);
      }
    }, 100);
  }

  private async adjustCatalogStockForInvoiceLines(
    lines: ReadonlyArray<{ productId: string; code: string; qty: number }>,
    direction: 'DEDUCT' | 'RESTORE'
  ): Promise<void> {
    if (!this.activeCompany.id) return;
    const factor = direction === 'DEDUCT' ? -1 : 1;
    const updatedProducts: Product[] = [];

    for (const line of lines) {
      const idx = this.products.findIndex(
        (p) => p.id === line.productId || (p.code && p.code === line.code)
      );
      if (idx === -1) continue;
      const target = this.products[idx]!;
      if (!target.trackStock) continue;

      const currentStock = Number(target.stockQty) || 0;
      const nextStock = roundKz(currentStock + factor * line.qty);
      const nextProd: Product = {
        ...target,
        stockQty: nextStock,
        syncState: 'pending',
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };
      this.products[idx] = nextProd;
      updatedProducts.push(nextProd);
      await localDb.saveProduct(nextProd, this.activeCompany.id).catch(() => null);
    }

    if (updatedProducts.length > 0 && this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
      for (const up of updatedProducts) {
        void updateProductStockCloud(up.id, up.stockQty ?? 0, this.activeCompany.id, this.activeCompany)
          .then(async () => {
            const synced: Product = { ...up, syncState: 'synced', synced: true };
            await localDb.saveProduct(synced, this.activeCompany.id).catch(() => null);
            this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
          })
          .catch(() => null);
      }
    }
  }

  private canEditExistingCustomers(): boolean {
    const role = this.getEffectiveRole();
    return !this.isCompanySuspended() && (role === 'owner' || role === 'manager');
  }

  private canManageCompanySettings(): boolean {
    return !this.isCompanySuspended() && this.getEffectiveRole() === 'owner';
  }

  private canCancelInvoices(): boolean {
    if (this.isCompanySuspended()) return false;
    const role = this.getEffectiveRole();
    if (role === 'owner') return true;
    if (role === 'manager') {
      if (this.activeCompany.allowManagerCancel) return true;
      if (this.user) {
        const emailLower = (this.user.email || '').trim().toLowerCase();
        const m = this.members.find(
          (x) =>
            x.active &&
            (x.uid === this.user!.uid || (emailLower && x.email.trim().toLowerCase() === emailLower))
        );
        if (m?.allowInvoiceCancel) return true;
      }
    }
    return false;
  }

  private async switchActiveCompany(companyId: string): Promise<void> {
    if (!companyId) return;
    await this.flushDraftNow();
    const bundle = await loadCompanyWorkspace(companyId, this.getViewerIdentity());
    this.applyWorkspaceBundle(bundle);
    this.showCompanyDropdown = false;
    this.render();

    if (this.user && this.isOnline && this.hasUnsyncedLocalRecords()) {
      void this.syncAllWithCloud();
    }
  }

  private getMergedAdminCompanies(): AdminCompanySummary[] {
    const byId = new Map<string, AdminCompanySummary>();
    for (const cc of this.adminCloudCompanies) {
      if (cc.id) {
        byId.set(cc.id, cc);
      }
    }
    for (const lc of this.companies) {
      if (!lc.id) continue;
      const existing = byId.get(lc.id);
      const localInvCount = lc.id === this.activeCompany.id ? this.invoices.length : 0;
      const resolvedOwnerEmail =
        lc.id === JAIMONA_COMPANY_ID
          ? lc.ownerEmail || JAIMONA_OWNER_EMAIL
          : lc.ownerEmail || lc.profile.email || 'Local';
      if (!existing) {
        byId.set(lc.id, {
          id: lc.id,
          shortName: lc.profile.shortName,
          legalName: lc.profile.legalName,
          nif: lc.profile.nif,
          normalizedNif: lc.normalizedNif,
          cityCountry: lc.profile.cityCountry,
          ownerEmail: resolvedOwnerEmail,
          status: lc.status,
          planTier: lc.plan.planTier,
          commercialActive: lc.plan.commercialActive,
          invoiceCount: localInvCount,
          createdAtIso: lc.createdAtIso,
        });
      } else {
        byId.set(lc.id, {
          ...existing,
          invoiceCount: Math.max(existing.invoiceCount, localInvCount),
        });
      }
    }

    return Array.from(byId.values()).sort(
      (a, b) =>
        b.createdAtIso.localeCompare(a.createdAtIso) ||
        a.shortName.localeCompare(b.shortName, 'pt')
    );
  }

  private async refreshMasterAdminData(): Promise<void> {
    if (!this.user) return;
    this.masterAdminLoading = true;
    this.masterAdminDenied = false;
    this.masterAdminError = null;
    this.render();

    const res = await fetchPlatformAdminOverview();
    this.masterAdminLoading = false;

    if (res.statusCode === 403) {
      this.masterAdminDenied = true;
      this.render();
      return;
    }

    if (!res.ok) {
      this.masterAdminError =
        res.error || 'Vista administrativa local apresentada (API em atualização).';
    } else {
      this.adminCloudCompanies = res.companies || [];
      this.adminAuditLogs = res.recentLogs || [];
    }
    this.render();
  }

  public isBusyWithCriticalTask(): boolean {
    return (
      this.isEmitting ||
      this.isPrinting ||
      this.editingProduct !== null ||
      this.editingCustomer !== null ||
      this.showQuickCustomerForm ||
      this.showNewCompanyModal ||
      this.cart.length > 0
    );
  }

  private getActivePaymentSplits(): PaymentSplit[] {
    const methods: DirectPaymentMethod[] = ['Dinheiro', 'Multicaixa', 'Transferência'];
    const splits: PaymentSplit[] = [];
    for (const m of methods) {
      const val = parseDecimalInput(this.splitInputs[m] || '');
      if (!Number.isNaN(val) && val > 0) {
        splits.push({ method: m, amount: roundKz(val) });
      }
    }
    return splits;
  }

  public async flushDraftNow(): Promise<void> {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    if (this.isBooting || !this.activeCompany.id || this.requiresCompanyOnboarding) return;
    try {
      await localDb.savePosDraft(
        {
          companyId: this.activeCompany.id,
          activeModule: this.activeModule,
          previewFormat: this.previewFormat,
          cart: this.cart,
          globalDiscountPct: this.globalDiscountPct,
          selectedCustomerId: this.selectedCustomerId,
          docType: this.docType,
          paymentMethod: this.paymentMethod,
          amountReceivedInput: this.amountReceivedInput,
          transferReference: this.transferReference,
          paymentSplits: this.getActivePaymentSplits(),
          notes: this.notes,
          cashier: this.cashier,
          operator: this.operator,
          updatedAtIso: new Date().toISOString(),
        },
        this.activeCompany.id
      );
    } catch {
      // Ignora erro transitório de gravação de rascunho para não bloquear a interface
    }
  }

  private scheduleDraftSave(): void {
    if (this.isBooting || !this.activeCompany.id || this.requiresCompanyOnboarding) return;
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
    }
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.flushDraftNow();
    }, 120);
  }

  private getMonthlyInvoiceUsage(): {
    monthKey: string;
    effectiveNowIso: string;
    usedCount: number;
    courtesyActive: boolean;
    effectiveLimit: number;
  } {
    let effectiveNowIso = new Date().toISOString();
    if (this.activeCompany.maxObservedIso && this.activeCompany.maxObservedIso > effectiveNowIso) {
      effectiveNowIso = this.activeCompany.maxObservedIso;
    }
    for (const inv of this.invoices) {
      if (inv.issuedAtIso && inv.issuedAtIso > effectiveNowIso) {
        effectiveNowIso = inv.issuedAtIso;
      }
    }
    const monthKey = effectiveNowIso.slice(0, 7);
    const usedCount = this.invoices.filter(
      (inv) => inv.status !== 'cancelled' && (inv.issuedAtIso || '').slice(0, 7) === monthKey
    ).length;
    const courtesyActive = this.activeCompany.courtesyMonthKey === monthKey;
    const effectiveLimit =
      FREE_MONTHLY_INVOICE_LIMIT + (courtesyActive ? FREE_COURTESY_BUFFER : 0);

    return {
      monthKey,
      effectiveNowIso,
      usedCount,
      courtesyActive,
      effectiveLimit,
    };
  }

  private hasUnsyncedLocalRecords(): boolean {
    if (!this.activeCompany.id || this.requiresCompanyOnboarding) return false;
    if (!canCompanySyncCloudData(this.activeCompany)) {
      return !this.activeCompany.synced;
    }
    return (
      !this.activeCompany.synced ||
      this.invoices.some((i) => !i.synced) ||
      this.products.some((p) => !p.synced) ||
      this.customers.some((c) => !c.synced) ||
      this.cashSessions.some((s) => !s.synced) ||
      this.cashMovements.some((m) => !m.synced) ||
      this.settings.synced === false
    );
  }

  private setupGlobalListeners(): void {
    const standaloneMedia =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)')
        : null;
    const standalone =
      Boolean(standaloneMedia && standaloneMedia.matches) ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true ||
      Boolean(window.__SILA_PWA_INSTALLED__);
    this.isInstalled = standalone;

    const ua = window.navigator.userAgent || '';
    const isClassicIOS = /iPad|iPhone|iPod/i.test(ua) && !('MSStream' in window);
    const isModernIPadOS =
      window.navigator.platform === 'MacIntel' && (window.navigator.maxTouchPoints || 0) > 1;
    this.isIOS = isClassicIOS || isModernIPadOS;
    this.isIOSInAppBrowser =
      this.isIOS && /FBAN|FBAV|Instagram|WhatsApp|Line\/|Musical\.ly|Bytedance/i.test(ua);

    try {
      this.iosBannerDismissed = localStorage.getItem('sila_ios_install_dismissed_v1') === '1';
    } catch {
      this.iosBannerDismissed = false;
    }

    if (window.__SILA_DEFERRED_PROMPT__ && !this.isInstalled) {
      this.deferredPrompt = window.__SILA_DEFERRED_PROMPT__ as BeforeInstallPromptEvent;
    }

    if (standaloneMedia) {
      const onDisplayModeChange = (evt: MediaQueryListEvent) => {
        if (evt.matches) {
          this.isInstalled = true;
          this.deferredPrompt = null;
          window.__SILA_DEFERRED_PROMPT__ = null;
          this.render();
        }
      };
      if (typeof standaloneMedia.addEventListener === 'function') {
        standaloneMedia.addEventListener('change', onDisplayModeChange);
      }
    }

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      window.__SILA_DEFERRED_PROMPT__ = e;
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.render();
    });

    window.addEventListener('appinstalled', () => {
      window.__SILA_PWA_INSTALLED__ = true;
      window.__SILA_DEFERRED_PROMPT__ = null;
      this.isInstalled = true;
      this.deferredPrompt = null;
      this.render();
    });

    window.addEventListener('online', () => {
      this.isOnline = true;
      this.refreshBackendHealth();
      this.render();
      if (this.user && this.hasUnsyncedLocalRecords()) {
        void this.syncAllWithCloud();
      }
    });

    window.addEventListener('offline', () => {
      this.isOnline = false;
      this.render();
    });

    window.addEventListener('beforeprint', () => {
      this.isPrinting = true;
    });

    window.addEventListener('afterprint', () => {
      this.isPrinting = false;
    });

    window.addEventListener('pagehide', () => {
      void this.flushDraftNow();
    });

    // Event Delegation Centralizada + Atalhos Globais / Leitor de Código de Barras
    this.root.addEventListener('click', (e) => this.handleClick(e));
    this.root.addEventListener('input', (e) => this.handleInput(e));
    this.root.addEventListener('change', (e) => this.handleChange(e));
    this.root.addEventListener('submit', (e) => this.handleSubmit(e));
    window.addEventListener('keydown', (e) => this.handleKeyDown(e));
  }

  private showScannerFeedback(message: string, isError: boolean): void {
    this.scannerNotice = message;
    this.scannerNoticeIsError = isError;
    if (this.scannerNoticeTimer !== null) {
      window.clearTimeout(this.scannerNoticeTimer);
    }
    this.scannerNoticeTimer = window.setTimeout(() => {
      this.scannerNotice = null;
      this.scannerNoticeTimer = null;
      if (this.activeModule === 'NEW_POS' || this.activeModule === 'NEW_A4') {
        this.render();
      }
    }, 2800);
  }

  private getPosProductSearchResult(): SmartProductSearchResult {
    const baseProducts = this.products.filter((p) => {
      if (!p.active) return false;
      if (this.posCategoryFilter !== 'ALL' && (p.category || 'Geral') !== this.posCategoryFilter) {
        return false;
      }
      if (this.posTaxFilter !== 'ALL' && p.ivaRate !== this.posTaxFilter) return false;
      if (this.posStockOnlyFilter && p.trackStock && (Number(p.stockQty) || 0) <= 0) return false;
      return true;
    });
    return searchProductsSmart(baseProducts, this.posSearch);
  }

  private getFilteredPosProducts(): Product[] {
    return this.getPosProductSearchResult().matches;
  }

  private addProductToCart(prod: Product): void {
    this.lastEmitted = null;
    this.lastAuditHash = '';
    this.confirmRemoveCartProductId = null;
    this.confirmClearCart = false;
    const existing = this.cart.find((c) => c.productId === prod.id);
    const nextQty = existing ? roundKz(existing.qty + 1) : 1;
    if (existing) {
      existing.qty = nextQty;
    } else {
      this.cart.push({
        productId: prod.id,
        code: prod.code,
        description: prod.name,
        unit: prod.unit,
        qty: 1,
        unitPrice: prod.price,
        discountPct: 0,
        ivaRate: prod.ivaRate,
      });
    }
    if (prod.trackStock) {
      const avail = Number(prod.stockQty) || 0;
      if (avail <= 0) {
        this.showScannerFeedback(
          `Aviso: "${prod.name}" está sem stock registado (${avail} ${prod.unit}).`,
          true
        );
      } else if (nextQty > avail) {
        this.showScannerFeedback(
          `Aviso: Qtd no talão (${nextQty}) excede stock disponível (${avail} ${prod.unit}).`,
          true
        );
      }
    }
    this.scheduleDraftSave();
  }

  private async refreshBackendHealth(): Promise<void> {
    if (!this.isOnline) return;
    this.backendHealth = await fetchBackendHealth();
    if (this.activeModule === 'SYNC') {
      this.render();
    }
  }

  private async ensureQrForInvoice(inv: InvoiceRecord): Promise<string> {
    const cacheKey = `${inv.number}|${inv.grandTotal.toFixed(2)}|${this.settings.company.nif}`;
    const existing = this.qrCache.get(cacheKey);
    if (existing) return existing;

    const generated = await generateInvoiceQrDataUrl(inv, this.settings.company);
    if (generated) {
      this.qrCache.set(cacheKey, generated);
      // Atualiza imagem QR diretamente no DOM se visível
      const imgs = this.root.querySelectorAll<HTMLImageElement>(
        `img[data-qr-key="${CSS.escape(cacheKey)}"]`
      );
      imgs.forEach((img) => {
        img.src = generated;
      });
    }
    return generated;
  }

  private buildLivePreviewInvoice(): InvoiceRecord {
    if (this.lastEmitted && this.cart.length === 0) {
      return this.lastEmitted;
    }

    const totals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
    const nextNumber = generateNextInvoiceNumber(
      this.invoices.map((i) => i.number),
      this.docType,
      this.activeCompany.baseSequence
    );
    const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
    const customer =
      this.customers.find((c) => c.id === this.selectedCustomerId) ||
      this.customers[0] || {
        id: directCustId,
        name: 'Cliente de Venda Directa',
        nif: 'Consumidor Final',
        locality: this.activeCompany.profile.cityCountry || 'Angola',
      };

    const returnCreditApplied = this.returnOriginInvoice
      ? Math.min(totals.grandTotal, roundKz(this.returnOriginInvoice.creditAmount))
      : 0;
    const payableAfterCredit = Math.max(0, roundKz(totals.grandTotal - returnCreditApplied));

    const hasExplicitReceivedInput = this.amountReceivedInput.trim() !== '';
    const parsedRec = parseDecimalInput(this.amountReceivedInput);
    const validExplicitRec = hasExplicitReceivedInput && !Number.isNaN(parsedRec) && parsedRec >= 0;

    let numericReceived = payableAfterCredit;
    let paymentSplits: PaymentSplit[] | undefined;
    let paymentSummary: string | undefined;

    if (this.paymentMethod === 'Crédito') {
      numericReceived = validExplicitRec ? roundKz(parsedRec) : 0;
    } else if (this.paymentMethod === 'Combinado') {
      const splits = this.getActivePaymentSplits();
      paymentSplits = splits;
      numericReceived = roundKz(splits.reduce((acc, s) => acc + s.amount, 0));
      if (splits.length > 0) {
        paymentSummary = splits
          .map((s) => `${s.method}: ${formatKzNumber(s.amount)} Kz`)
          .join(' + ');
      }
    } else {
      numericReceived = validExplicitRec ? roundKz(parsedRec) : payableAfterCredit;
    }

    const changeAmount = Math.max(0, roundKz(numericReceived - payableAfterCredit));
    const amountDue =
      this.docType === 'FR' ? Math.max(0, roundKz(payableAfterCredit - numericReceived)) : 0;
    const cleanRef = this.transferReference.trim().slice(0, 80);
    const showRef =
      cleanRef &&
      (this.paymentMethod === 'Transferência' ||
        this.paymentMethod === 'Multicaixa' ||
        (this.paymentMethod === 'Combinado' &&
          Boolean(
            paymentSplits?.some(
              (s) => s.method === 'Transferência' || s.method === 'Multicaixa'
            )
          )));

    const now = new Date().toISOString();

    return {
      id: 'preview_draft',
      companyId: this.activeCompany.id,
      number: nextNumber,
      docType: this.docType,
      issuedAtIso: now,
      cashier: this.cashier || '01',
      operator: this.operator || '001',
      paymentMethod: this.paymentMethod,
      customerId: customer.id,
      customerName: customer.name,
      customerNif: customer.nif,
      customerLocality: customer.locality,
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: totals.discountTotal,
      ...(totals.globalDiscountPct > 0
        ? {
            globalDiscountPct: totals.globalDiscountPct,
            globalDiscountAmount: totals.globalDiscountAmount,
          }
        : {}),
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBase0: totals.taxBase0,
      taxAmount0: 0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: totals.amountInWords,
      amountReceived: numericReceived,
      changeAmount,
      ...(amountDue > 0 ? { amountDue } : {}),
      ...(showRef ? { transferReference: cleanRef } : {}),
      ...(paymentSplits && paymentSplits.length > 0 ? { paymentSplits } : {}),
      ...(paymentSummary ? { paymentSummary } : {}),
      ...(this.returnOriginInvoice
        ? {
            returnOriginInvoiceId: this.returnOriginInvoice.id,
            returnOriginNumber: this.returnOriginInvoice.number,
            returnCreditApplied,
          }
        : {}),
      notes: this.notes,
      status: 'issued',
      lines: totals.lines,
      createdAtIso: now,
      updatedAtIso: now,
    };
  }

  // ==================== HANDLERS DE INTERAÇÃO ====================

  private async handleClick(e: MouseEvent): Promise<void> {
    const rawEl = e.target as HTMLElement;
    const target = rawEl.closest<HTMLElement>('[data-action]');

    if (!target) {
      if (this.showCompanyDropdown && !rawEl.closest('[data-company-switcher-zone]')) {
        this.showCompanyDropdown = false;
        this.render();
      }
      return;
    }

    const action = target.dataset.action;
    const id = target.dataset.id || '';
    const value = target.dataset.value || '';

    switch (action) {
      case 'toggle-company-dropdown': {
        this.showCompanyDropdown = !this.showCompanyDropdown;
        this.render();
        break;
      }
      case 'switch-company': {
        if (id && id !== this.activeCompany.id) {
          if (this.supportCompanyId && id !== this.supportCompanyId) {
            this.supportCompanyId = null;
          }
          await this.switchActiveCompany(id);
        } else {
          this.showCompanyDropdown = false;
          this.render();
        }
        break;
      }
      case 'open-new-company-modal': {
        this.showCompanyDropdown = false;
        this.newCompanyError = null;
        this.showNewCompanyModal = true;
        this.render();
        break;
      }
      case 'close-new-company-modal': {
        this.showNewCompanyModal = false;
        this.newCompanyError = null;
        this.render();
        break;
      }
      case 'open-master-admin': {
        this.showCompanyDropdown = false;
        this.showMasterAdminModal = true;
        this.masterAdminError = null;
        this.render();
        if (this.user && this.isOnline) {
          await this.refreshMasterAdminData();
        }
        break;
      }
      case 'close-master-admin': {
        this.showMasterAdminModal = false;
        this.render();
        break;
      }
      case 'master-admin-signin': {
        if (!this.isOnline) {
          this.masterAdminError =
            'Terminal offline. Ligue à internet para autenticar o Administrador Google.';
          this.render();
          return;
        }
        if (this.isAuthenticatingAdmin) return;
        this.isAuthenticatingAdmin = true;
        this.masterAdminError = null;
        try {
          await signInWithGoogle();
          this.isAuthenticatingAdmin = false;
          await this.refreshMasterAdminData();
        } catch (err) {
          this.isAuthenticatingAdmin = false;
          let autoAuthorized = false;
          if (isUnauthorizedDomainError(err)) {
            const healRes = await requestEnsureAuthDomains();
            autoAuthorized = healRes.ok && (healRes.added.length > 0 || healRes.alreadyPresent);
          }
          this.masterAdminError = formatFirebaseAuthErrorPt(err, autoAuthorized);
          this.render();
        }
        break;
      }
      case 'refresh-master-admin': {
        await this.refreshMasterAdminData();
        break;
      }
      case 'admin-toggle-company-status': {
        const nextStatus = (value === 'suspended' ? 'suspended' : 'active') as CompanyOperationalStatus;
        if (this.user && this.isOnline) {
          const res = await updatePlatformCompanyAdmin(id, { status: nextStatus });
          if (!res.ok) {
            this.masterAdminError = res.error || 'Não foi possível alterar o estado da empresa.';
            this.render();
            return;
          }
        }
        const localComp = this.companies.find((c) => c.id === id);
        if (localComp) {
          const updatedComp: CompanyRecord = {
            ...localComp,
            status: nextStatus,
            updatedAtIso: new Date().toISOString(),
          };
          await localDb.saveCompany(updatedComp);
          this.companies = this.companies.map((c) => (c.id === id ? updatedComp : c));
          if (this.activeCompany.id === id) {
            this.activeCompany = updatedComp;
          }
        }
        await this.refreshMasterAdminData();
        break;
      }
      case 'admin-support-switch': {
        if (!id) break;
        const targetSummary = this.getMergedAdminCompanies().find((c) => c.id === id);
        if (this.user && this.isOnline && targetSummary) {
          void logPlatformSupportAccess(id, targetSummary.shortName);
        }

        this.supportCompanyId = id;

        // Se a empresa alvo ainda só existe na Cloud (e não é comp_jaimona, que já é tratada no workspace),
        // materializa o registo base localmente para inspeção de suporte e descarrega os dados do Firestore
        if (id !== JAIMONA_COMPANY_ID && targetSummary && !this.companies.some((c) => c.id === id)) {
          const now = new Date().toISOString();
          await localDb.saveCompany({
            id: targetSummary.id,
            normalizedNif:
              targetSummary.normalizedNif || normalizeCompanyNif(targetSummary.nif || ''),
            profile: {
              legalName: targetSummary.legalName || targetSummary.shortName,
              shortName: targetSummary.shortName,
              nif: targetSummary.nif,
              address: targetSummary.cityCountry || 'Angola',
              cityCountry: targetSummary.cityCountry || 'Angola',
              phone: '',
              email: targetSummary.ownerEmail === 'Local (não vinculado)' ? '' : targetSummary.ownerEmail,
              tagline: 'Obrigado pela preferência',
            },
            status: targetSummary.status,
            plan: {
              planTier: targetSummary.planTier,
              commercialActive: targetSummary.commercialActive,
              maxUsers: null,
              maxInvoicesPerMonth: null,
              updatedAtIso: now,
            },
            baseSequence: 0,
            allowManagerCancel: false,
            ownerEmail:
              targetSummary.ownerEmail === 'Local (não vinculado)'
                ? undefined
                : targetSummary.ownerEmail,
            syncState: 'synced',
            synced: true,
            createdAtIso: targetSummary.createdAtIso || now,
            updatedAtIso: now,
          });
        }

        this.showMasterAdminModal = false;
        await this.switchActiveCompany(id);

        if (this.user && this.isOnline) {
          try {
            const cloudData =
              (await fetchCompanyWorkspaceBackend(id)) || (await pullCompanyFromCloud(id));
            if (cloudData) {
              for (const cp of cloudData.products) {
                await localDb.saveProduct(cp, id);
              }
              for (const cc of cloudData.customers) {
                await localDb.saveCustomer(cc, id);
              }
              for (const ci of cloudData.invoices) {
                await localDb.saveInvoice(ci, id);
              }
              for (const cs of cloudData.cashSessions || []) {
                await localDb.saveCashSession(cs, id);
              }
              for (const cm of cloudData.cashMovements || []) {
                await localDb.saveCashMovement(cm, id);
              }
              if (cloudData.settings) {
                await localDb.saveSettings(cloudData.settings, id).catch(() => null);
              }
              const refreshed = await loadCompanyWorkspace(id, this.getViewerIdentity());
              this.applyWorkspaceBundle(refreshed);
              this.render();
            }
          } catch {
            // Mantém vista local disponível
          }
        }
        break;
      }
      case 'toggle-sidebar': {
        if (this.sidebarState === 'EXPANDED') this.sidebarState = 'ICONS';
        else if (this.sidebarState === 'ICONS') this.sidebarState = 'HIDDEN';
        else this.sidebarState = 'EXPANDED';
        this.render();
        break;
      }
      case 'compact-sidebar': {
        this.sidebarState = this.sidebarState === 'EXPANDED' ? 'ICONS' : 'EXPANDED';
        this.render();
        break;
      }
      case 'hide-sidebar': {
        this.sidebarState = 'HIDDEN';
        this.render();
        break;
      }
      case 'nav': {
        const mod = value as ActiveModule;
        this.activeModule = mod;
        this.showCompanyDropdown = false;
        if (mod === 'NEW_POS') this.previewFormat = 'POS';
        if (mod === 'NEW_A4') this.previewFormat = 'A4';
        if (mod === 'CASH') {
          const openSess = this.getActiveOpenCashSession();
          if (openSess && !this.selectedCashSessionId) {
            this.selectedCashSessionId = openSess.id;
          } else if (
            !this.cashSessions.some((s) => s.id === this.selectedCashSessionId) &&
            this.cashSessions[0]
          ) {
            this.selectedCashSessionId = this.cashSessions[0].id;
          }
        }
        if (mod === 'SYNC') this.refreshBackendHealth();
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'mobile-pane': {
        this.mobilePane = value as 'CATALOG' | 'CART' | 'PREVIEW';
        this.render();
        break;
      }
      case 'tax-filter': {
        this.posTaxFilter = value === 'ALL' ? 'ALL' : (Number(value) as 14 | 0);
        this.render();
        break;
      }
      case 'toggle-pos-stock-filter': {
        this.posStockOnlyFilter = !this.posStockOnlyFilter;
        this.render();
        break;
      }
      case 'toggle-quick-product': {
        if (!this.canManageCatalog()) return;
        this.showQuickProductForm = !this.showQuickProductForm;
        this.quickProductError = null;
        if (this.showQuickProductForm) {
          const maxNumericCode = this.products.reduce((max, p) => {
            const n = parseInt(p.code.replace(/\D/g, ''), 10);
            return Number.isFinite(n) && n > max ? n : max;
          }, this.products.length);
          const nextCode = String(maxNumericCode + 1).padStart(5, '0');
          const searchRaw = this.posSearch.trim();
          const looksLikeEanBarcode = /^\d{6,}$/.test(searchRaw);
          const looksLikeShortSku = !looksLikeEanBarcode && /^\d{3,5}$/.test(searchRaw);
          this.quickProductDraft = {
            code: looksLikeShortSku ? searchRaw.slice(0, 32) : nextCode,
            barcode: looksLikeEanBarcode ? searchRaw.slice(0, 48) : '',
            name:
              !looksLikeEanBarcode && !looksLikeShortSku && searchRaw
                ? searchRaw.slice(0, 160)
                : '',
            category:
              this.posCategoryFilter !== 'ALL' ? this.posCategoryFilter : 'Mercearia',
            costPrice: '',
            price: '',
            unit: 'un',
            ivaRate: this.posTaxFilter === 0 ? 0 : 14,
            trackStock: false,
            stockQty: '',
          };
        }
        this.render();
        if (this.showQuickProductForm) {
          const nameInput = document.getElementById(
            'quick-product-name-input'
          ) as HTMLInputElement | null;
          nameInput?.focus();
        }
        break;
      }
      case 'pos-category': {
        this.posCategoryFilter = value || 'ALL';
        this.render();
        break;
      }
      case 'clear-pos-search': {
        this.posSearch = '';
        this.renderPreservingFocus('pos-search-input', 0);
        break;
      }
      case 'add-to-cart': {
        if (this.isCompanySuspended()) return;
        const prod = this.products.find((p) => p.id === id);
        if (!prod) return;
        this.addProductToCart(prod);
        this.render();
        break;
      }
      case 'add-suggested-to-cart': {
        if (this.isCompanySuspended()) return;
        const prod = this.products.find((p) => p.id === id);
        if (!prod) return;
        this.addProductToCart(prod);
        this.posSearch = '';
        this.renderPreservingFocus('pos-search-input', 0);
        break;
      }
      case 'qty-delta': {
        const delta = Number(value);
        const currentItem = this.cart.find((c) => c.productId === id);
        if (currentItem && delta < 0 && roundKz(currentItem.qty + delta) <= 0) {
          this.confirmRemoveCartProductId = id;
          this.render();
          break;
        }
        this.confirmRemoveCartProductId = null;
        this.cart = this.cart
          .map((item) => {
            if (item.productId !== id) return item;
            const next = roundKz(item.qty + delta);
            return next <= 0 ? null : { ...item, qty: next };
          })
          .filter((x): x is CartDraftItem => x !== null);
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'locked-price-notice': {
        this.showScannerFeedback(
          'Alteração de preço unitário restrita a Gerente/Proprietário (ou autorize nas Configurações).',
          true
        );
        this.render();
        break;
      }
      case 'set-cart-iva': {
        const nextIva: TaxRate = Number(value) === 0 ? 0 : 14;
        this.cart = this.cart.map((item) =>
          item.productId === id ? { ...item, ivaRate: nextIva } : item
        );
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'request-remove-cart-item': {
        this.confirmRemoveCartProductId = id;
        this.render();
        break;
      }
      case 'cancel-remove-cart-item': {
        this.confirmRemoveCartProductId = null;
        this.render();
        break;
      }
      case 'remove-cart-item': {
        this.confirmRemoveCartProductId = null;
        this.cart = this.cart.filter((c) => c.productId !== id);
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'toggle-customer-picker': {
        this.showCustomerPicker = !this.showCustomerPicker;
        if (this.showCustomerPicker) {
          this.showQuickCustomerForm = false;
          this.posCustomerSearch = '';
        }
        this.render();
        if (this.showCustomerPicker) {
          const searchInput = document.getElementById('pos-customer-search-input') as HTMLInputElement | null;
          searchInput?.focus();
        }
        break;
      }
      case 'select-pos-customer': {
        if (id && this.customers.some((c) => c.id === id)) {
          const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
          this.selectedCustomerId = id;
          if (id === directCustId && this.paymentMethod === 'Crédito' && this.docType === 'FR') {
            this.paymentMethod = 'Dinheiro';
          }
          this.showCustomerPicker = false;
          this.posCustomerSearch = '';
          this.scheduleDraftSave();
          this.render();
        }
        break;
      }
      case 'select-final-consumer': {
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        this.selectedCustomerId = directCustId;
        if (this.paymentMethod === 'Crédito' && this.docType === 'FR') {
          this.paymentMethod = 'Dinheiro';
        }
        this.showCustomerPicker = false;
        this.showQuickCustomerForm = false;
        this.posCustomerSearch = '';
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'toggle-quick-customer': {
        if (this.isCompanySuspended()) return;
        this.showQuickCustomerForm = !this.showQuickCustomerForm;
        this.quickCustomerError = null;
        if (this.showQuickCustomerForm) {
          this.showCustomerPicker = false;
          this.quickCustomerDraft = {
            name: '',
            nif: '',
            phone: '',
            address: '',
            locality: this.activeCompany.profile.cityCountry || 'Angola',
          };
        }
        this.render();
        if (this.showQuickCustomerForm) {
          const nameInput = document.getElementById('quick-customer-name-input') as HTMLInputElement | null;
          nameInput?.focus();
        }
        break;
      }
      case 'retry-db-boot': {
        this.dbBootError = null;
        this.isBooting = true;
        this.render();
        try {
          const data = await bootstrapLocalStore(
            this.activeCompany.id || undefined,
            this.getViewerIdentity()
          );
          this.applyWorkspaceBundle(data);
        } catch (err) {
          this.dbBootError = formatStorageErrorPt(err, 'os dados locais');
        } finally {
          this.isBooting = false;
          this.render();
        }
        break;
      }
      case 'request-clear-pos': {
        this.confirmClearCart = true;
        this.render();
        break;
      }
      case 'cancel-clear-pos': {
        this.confirmClearCart = false;
        this.render();
        break;
      }
      case 'clear-pos': {
        this.cart = [];
        this.globalDiscountPct = 0;
        this.globalDiscountInput = '';
        this.amountReceivedInput = '';
        this.transferReference = '';
        this.splitInputs = { Dinheiro: '', Multicaixa: '', Transferência: '' };
        this.confirmClearCart = false;
        this.confirmRemoveCartProductId = null;
        this.returnOriginInvoice = null;
        this.lastEmitted = null;
        this.lastAuditHash = '';
        void this.flushDraftNow();
        this.render();
        break;
      }
      case 'suspend-sale': {
        if (this.cart.length === 0 || !this.activeCompany.id) break;
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        const cust = this.customers.find((c) => c.id === this.selectedCustomerId);
        const totals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
        const entry: SuspendedSale = {
          id: `susp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: this.activeCompany.id,
          label:
            cust && cust.id !== directCustId
              ? cust.name
              : `${this.cart.length} ${this.cart.length === 1 ? 'artigo' : 'artigos'} (${formatKzNumber(totals.grandTotal)} Kz)`,
          customerId: this.selectedCustomerId,
          customerName: cust?.name || 'Cliente de Venda Directa',
          docType: this.docType,
          paymentMethod: this.paymentMethod,
          cart: this.cart.map((c) => ({ ...c })),
          globalDiscountPct: this.globalDiscountPct,
          notes: this.notes,
          suspendedAtIso: new Date().toISOString(),
        };
        this.suspendedSales = [entry, ...this.suspendedSales].slice(0, 25);
        await localDb.saveSuspendedSales(this.suspendedSales, this.activeCompany.id);
        this.cart = [];
        this.globalDiscountPct = 0;
        this.globalDiscountInput = '';
        this.amountReceivedInput = '';
        this.transferReference = '';
        this.splitInputs = { Dinheiro: '', Multicaixa: '', Transferência: '' };
        this.selectedCustomerId = directCustId;
        this.confirmClearCart = false;
        this.confirmRemoveCartProductId = null;
        this.returnOriginInvoice = null;
        await this.flushDraftNow();
        this.showScannerFeedback('Venda colocada em espera. Caixa livre para próximo cliente.', false);
        this.render();
        break;
      }
      case 'toggle-suspended-drawer': {
        this.showSuspendedDrawer = !this.showSuspendedDrawer;
        this.render();
        break;
      }
      case 'resume-suspended-sale': {
        const targetSale = this.suspendedSales.find((s) => s.id === id);
        if (!targetSale || !this.activeCompany.id) break;
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        let remaining = this.suspendedSales.filter((s) => s.id !== id);
        // Se houver artigos na venda atual, guarda-os automaticamente em espera para não perder nada!
        if (this.cart.length > 0) {
          const curCust = this.customers.find((c) => c.id === this.selectedCustomerId);
          const curTotals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
          const autoParked: SuspendedSale = {
            id: `susp_${Date.now()}_swap`,
            companyId: this.activeCompany.id,
            label:
              curCust && curCust.id !== directCustId
                ? curCust.name
                : `${this.cart.length} art. (${formatKzNumber(curTotals.grandTotal)} Kz)`,
            customerId: this.selectedCustomerId,
            customerName: curCust?.name || 'Cliente de Venda Directa',
            docType: this.docType,
            paymentMethod: this.paymentMethod,
            cart: this.cart.map((c) => ({ ...c })),
            globalDiscountPct: this.globalDiscountPct,
            notes: this.notes,
            suspendedAtIso: new Date().toISOString(),
          };
          remaining = [autoParked, ...remaining].slice(0, 25);
        }
        this.suspendedSales = remaining;
        await localDb.saveSuspendedSales(this.suspendedSales, this.activeCompany.id);
        this.cart = targetSale.cart.map((c) => ({ ...c }));
        this.globalDiscountPct = targetSale.globalDiscountPct || 0;
        this.globalDiscountInput = this.globalDiscountPct > 0 ? String(this.globalDiscountPct) : '';
        this.selectedCustomerId = this.customers.some((c) => c.id === targetSale.customerId)
          ? targetSale.customerId
          : directCustId;
        this.docType = targetSale.docType;
        this.paymentMethod = targetSale.paymentMethod;
        this.notes = targetSale.notes;
        this.amountReceivedInput = '';
        this.showSuspendedDrawer = false;
        this.confirmClearCart = false;
        this.confirmRemoveCartProductId = null;
        await this.flushDraftNow();
        this.showScannerFeedback(`Venda recuperada: ${targetSale.label}`, false);
        this.render();
        break;
      }
      case 'delete-suspended-sale': {
        if (!this.activeCompany.id) break;
        this.suspendedSales = this.suspendedSales.filter((s) => s.id !== id);
        await localDb.saveSuspendedSales(this.suspendedSales, this.activeCompany.id);
        if (this.suspendedSales.length === 0) this.showSuspendedDrawer = false;
        this.render();
        break;
      }
      case 'cancel-return-exchange': {
        this.returnOriginInvoice = null;
        this.render();
        break;
      }
      case 'open-history-for-return': {
        this.activeModule = 'HISTORY';
        this.render();
        break;
      }
      case 'start-return-exchange': {
        if (this.isCompanySuspended()) return;
        const origin = this.invoices.find((i) => i.id === id);
        if (!origin || origin.status === 'cancelled') return;
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        this.returnOriginInvoice = {
          id: origin.id,
          number: origin.number,
          creditAmount: origin.grandTotal,
        };
        if (origin.customerId && this.customers.some((c) => c.id === origin.customerId)) {
          this.selectedCustomerId = origin.customerId;
        } else {
          this.selectedCustomerId = directCustId;
        }
        this.docType = 'FR';
        this.notes = `Troca / compensação ref. ${origin.number}.`;
        this.activeModule = 'NEW_POS';
        this.previewFormat = 'POS';
        this.mobilePane = 'CART';
        this.scheduleDraftSave();
        this.showScannerFeedback(
          `Troca iniciada sobre ${origin.number} (crédito de ${formatKzNumber(origin.grandTotal)} Kz). Adicione os novos artigos.`,
          false
        );
        this.render();
        break;
      }
      case 'toggle-pos-options': {
        this.showOptionsDrawer = !this.showOptionsDrawer;
        this.render();
        break;
      }
      case 'set-payment': {
        const nextMethod = value as PaymentMethod;
        this.paymentMethod = nextMethod;
        if (nextMethod === 'Combinado') {
          const totals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
          const credit = this.returnOriginInvoice
            ? Math.min(totals.grandTotal, roundKz(this.returnOriginInvoice.creditAmount))
            : 0;
          const net = Math.max(0, roundKz(totals.grandTotal - credit));
          const currentSplits = this.getActivePaymentSplits();
          if (currentSplits.length === 0 && net > 0) {
            const half = roundKz(Math.floor(net / 2));
            this.splitInputs = {
              Dinheiro: half > 0 ? String(half) : '',
              Multicaixa: roundKz(net - half) > 0 ? String(roundKz(net - half)) : '',
              Transferência: '',
            };
          }
        }
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'fill-split-remainder': {
        const method = value as DirectPaymentMethod;
        if (method !== 'Dinheiro' && method !== 'Multicaixa' && method !== 'Transferência') break;
        const totals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
        const credit = this.returnOriginInvoice
          ? Math.min(totals.grandTotal, roundKz(this.returnOriginInvoice.creditAmount))
          : 0;
        const net = Math.max(0, roundKz(totals.grandTotal - credit));
        const otherSum = (['Dinheiro', 'Multicaixa', 'Transferência'] as DirectPaymentMethod[])
          .filter((m) => m !== method)
          .reduce((acc, m) => {
            const v = parseDecimalInput(this.splitInputs[m] || '');
            return acc + (!Number.isNaN(v) && v > 0 ? v : 0);
          }, 0);
        const rem = Math.max(0, roundKz(net - otherSum));
        this.splitInputs[method] = rem > 0 ? String(rem) : '';
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'quick-cash': {
        this.paymentMethod = 'Dinheiro';
        this.amountReceivedInput = value;
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'set-preview-format': {
        this.previewFormat = value as DocumentFormat;
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'emit-invoice': {
        if (this.isCompanySuspended()) return;
        const autoPrint = value === 'print' || this.settings.autoPrintOnEmit;
        await this.emitCurrentInvoice(autoPrint);
        break;
      }
      case 'print-live': {
        const inv = this.buildLivePreviewInvoice();
        if (inv.lines.length > 0) {
          await this.triggerPrint(inv, this.previewFormat);
        }
        break;
      }
      case 'new-product': {
        if (!this.canManageCatalog()) return;
        const maxNumericCode = this.products.reduce((max, p) => {
          const n = parseInt(p.code.replace(/\D/g, ''), 10);
          return Number.isFinite(n) && n > max ? n : max;
        }, this.products.length);
        const nextCode = String(maxNumericCode + 1).padStart(5, '0');
        const now = new Date().toISOString();
        const rand = Math.random().toString(36).slice(2, 6);
        this.isNewProduct = true;
        this.productFormError = null;
        this.productSavedNotice = null;
        this.editingProductCostInput = '';
        this.editingProductMarkupInput = '';
        this.editingProductPriceInput = '';
        this.editingProductStockInput = '0';
        this.editingProductMinStockInput = '2';
        this.editingProduct = {
          id: `prod_${Date.now()}_${rand}`,
          companyId: this.activeCompany.id,
          code: nextCode,
          barcode: '',
          name: '',
          category:
            this.productCategoryFilter !== 'ALL' ? this.productCategoryFilter : 'Mercearia',
          unit: 'un',
          price: 0,
          ivaRate: 14,
          exemptionReason: DEFAULT_IVA_EXEMPTION_REASONS[0],
          active: true,
          trackStock: false,
          stockQty: 0,
          minStockQty: 2,
          syncState: 'pending',
          synced: false,
          createdAtIso: now,
          updatedAtIso: now,
        };
        this.render();
        const prodNameInput = document.getElementById('product-form-name-input') as HTMLInputElement | null;
        prodNameInput?.focus();
        break;
      }
      case 'edit-product': {
        if (!this.canManageCatalog()) return;
        const targetProd = this.products.find((p) => p.id === id);
        if (targetProd) {
          this.isNewProduct = false;
          this.productFormError = null;
          this.productSavedNotice = null;
          this.confirmDeleteProductId = null;
          this.editingProduct = {
            ...targetProd,
            barcode: targetProd.barcode || '',
            exemptionReason:
              targetProd.exemptionReason || DEFAULT_IVA_EXEMPTION_REASONS[0],
          };
          this.selectedProductDetailId = targetProd.id;
          this.editingProductPriceInput = String(targetProd.price);
          const hasCost =
            typeof targetProd.costPrice === 'number' &&
            Number.isFinite(targetProd.costPrice) &&
            targetProd.costPrice > 0;
          this.editingProductCostInput = hasCost ? String(targetProd.costPrice) : '';
          this.editingProductMarkupInput = hasCost
            ? String(roundKz(((targetProd.price - targetProd.costPrice!) / targetProd.costPrice!) * 100))
            : '';
          this.editingProductStockInput = String(targetProd.stockQty ?? 0);
          this.editingProductMinStockInput = String(targetProd.minStockQty ?? 0);
          this.render();
          const prodNameInput = document.getElementById('product-form-name-input') as HTMLInputElement | null;
          prodNameInput?.focus();
        }
        break;
      }
      case 'cancel-edit-product': {
        this.editingProduct = null;
        this.editingProductCostInput = '';
        this.editingProductMarkupInput = '';
        this.editingProductPriceInput = '';
        this.editingProductStockInput = '';
        this.editingProductMinStockInput = '';
        this.productFormError = null;
        this.render();
        break;
      }
      case 'select-product-detail': {
        if (id && this.products.some((p) => p.id === id)) {
          this.selectedProductDetailId = id;
          this.quickStockProductId = null;
          this.confirmDeleteProductId = null;
          this.render();
        }
        break;
      }
      case 'set-product-filter': {
        if (
          value === 'ALL' ||
          value === 'ACTIVE' ||
          value === 'INACTIVE' ||
          value === 'LOW_STOCK'
        ) {
          this.productFilter = value;
          this.render();
        }
        break;
      }
      case 'toggle-product-active': {
        if (!this.canManageCatalog()) return;
        const target = this.products.find((p) => p.id === id);
        if (!target) return;
        const now = new Date().toISOString();
        const toggled: Product = {
          ...target,
          active: !target.active,
          syncState: 'pending',
          synced: false,
          updatedAtIso: now,
        };
        try {
          await localDb.saveProduct(toggled, this.activeCompany.id);
          this.products = this.products.map((p) => (p.id === toggled.id ? toggled : p));
          if (this.editingProduct?.id === toggled.id) {
            this.editingProduct = { ...this.editingProduct, active: toggled.active };
          }
          this.productSavedNotice = toggled.active
            ? `Artigo "${toggled.name}" ativado e disponível no POS.`
            : `Artigo "${toggled.name}" marcado como inativo (oculto no POS).`;
          this.render();
          window.setTimeout(() => {
            if (this.productSavedNotice) {
              this.productSavedNotice = null;
              if (this.activeModule === 'PRODUCTS') this.render();
            }
          }, 2500);
          if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
            try {
              await ensureCompanyRegisteredCloud(this.activeCompany);
              await upsertProductCloud(toggled, false, this.activeCompany);
              const synced: Product = { ...toggled, syncState: 'synced', synced: true };
              await localDb.saveProduct(synced, this.activeCompany.id);
              this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
              this.render();
            } catch {
              // Fica pendente localmente
            }
          }
        } catch (err) {
          this.productFormError = formatStorageErrorPt(err, 'o estado do artigo');
          this.render();
        }
        break;
      }
      case 'open-quick-stock': {
        if (!this.canManageCatalog()) return;
        const prod = this.products.find((p) => p.id === id);
        if (!prod) return;
        this.quickStockProductId = prod.id;
        this.quickStockAdjustInput = String(prod.stockQty ?? 0);
        this.selectedProductDetailId = prod.id;
        this.render();
        const stockEl = document.getElementById('quick-stock-qty-input') as HTMLInputElement | null;
        stockEl?.focus();
        stockEl?.select();
        break;
      }
      case 'cancel-quick-stock': {
        this.quickStockProductId = null;
        this.quickStockAdjustInput = '';
        this.render();
        break;
      }
      case 'sell-product-in-pos': {
        if (this.isCompanySuspended()) return;
        const prod = this.products.find((p) => p.id === id);
        if (!prod || !prod.active) return;
        this.addProductToCart(prod);
        this.activeModule = 'NEW_POS';
        this.previewFormat = 'POS';
        this.render();
        break;
      }
      case 'request-delete-product': {
        if (!this.canManageCatalog()) return;
        this.confirmDeleteProductId = id;
        this.render();
        break;
      }
      case 'cancel-delete-product': {
        this.confirmDeleteProductId = null;
        this.render();
        break;
      }
      case 'delete-product': {
        if (!this.canManageCatalog()) return;
        this.confirmDeleteProductId = null;
        try {
          await localDb.deleteProduct(id);
          this.products = this.products.filter((p) => p.id !== id);
          if (this.selectedProductDetailId === id) {
            this.selectedProductDetailId = this.products[0]?.id || '';
          }
          if (this.editingProduct?.id === id) {
            this.editingProduct = null;
            this.editingProductPriceInput = '';
            this.editingProductCostInput = '';
            this.editingProductMarkupInput = '';
          }
          this.render();
          if (this.user && this.isOnline) {
            try {
              await ensureCompanyRegisteredCloud(this.activeCompany);
              await removeProductCloud(id, this.activeCompany.id, this.activeCompany);
            } catch {
              // Mantém estado local
            }
          }
        } catch (err) {
          this.productFormError = formatStorageErrorPt(err, 'a remoção do artigo');
          this.render();
        }
        break;
      }
      case 'new-customer': {
        if (this.isCompanySuspended()) return;
        const now = new Date().toISOString();
        const rand = Math.random().toString(36).slice(2, 6);
        this.isNewCustomer = true;
        this.customerFormError = null;
        this.customerSavedNotice = null;
        this.editingCustomerCreditLimitInput = '';
        this.editingCustomer = {
          id: `cust_${Date.now()}_${rand}`,
          companyId: this.activeCompany.id,
          name: '',
          nif: '',
          locality: this.activeCompany.profile.cityCountry || 'Angola',
          phone: '',
          address: '',
          syncState: 'pending',
          synced: false,
          createdAtIso: now,
          updatedAtIso: now,
        };
        this.render();
        const custNameInput = document.getElementById('customer-form-name-input') as HTMLInputElement | null;
        custNameInput?.focus();
        break;
      }
      case 'edit-customer': {
        if (!this.canEditExistingCustomers()) return;
        const cust = this.customers.find((c) => c.id === id);
        if (cust) {
          this.isNewCustomer = false;
          this.customerFormError = null;
          this.customerSavedNotice = null;
          this.editingCustomer = { ...cust };
          this.editingCustomerCreditLimitInput =
            cust.creditLimit && cust.creditLimit > 0 ? String(cust.creditLimit) : '';
          this.selectedCustomerDetailId = cust.id;
          this.render();
          const custNameInput = document.getElementById('customer-form-name-input') as HTMLInputElement | null;
          custNameInput?.focus();
        }
        break;
      }
      case 'cancel-edit-customer': {
        this.editingCustomer = null;
        this.editingCustomerCreditLimitInput = '';
        this.isNewCustomer = false;
        this.customerFormError = null;
        this.render();
        break;
      }
      case 'delete-customer': {
        if (!this.canEditExistingCustomers()) return;
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        if (id === directCustId) return;
        await localDb.deleteCustomer(id);
        this.customers = this.customers.filter((c) => c.id !== id);
        if (this.selectedCustomerDetailId === id) {
          this.selectedCustomerDetailId = this.customers[0]?.id || '';
        }
        if (this.editingCustomer?.id === id) {
          this.editingCustomer = null;
          this.editingCustomerCreditLimitInput = '';
        }
        this.render();
        if (this.user && this.isOnline) {
          try {
            await ensureCompanyRegisteredCloud(this.activeCompany);
            await removeCustomerCloud(id, this.activeCompany.id, this.activeCompany);
          } catch {
            // Removido localmente
          }
        }
        break;
      }
      case 'set-customer-filter': {
        if (value === 'ALL' || value === 'WITH_DEBT' || value === 'WITH_LIMIT') {
          this.customerFilter = value;
          this.render();
        }
        break;
      }
      case 'select-customer-detail': {
        if (id && this.customers.some((c) => c.id === id)) {
          this.selectedCustomerDetailId = id;
          this.settlingCustomerAccountId = null;
          this.settlingInvoiceId = null;
          this.settleError = null;
          this.render();
        }
        break;
      }
      case 'use-customer-in-pos': {
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        if (id && this.customers.some((c) => c.id === id)) {
          this.selectedCustomerId = id;
          if (id === directCustId && this.paymentMethod === 'Crédito' && this.docType === 'FR') {
            this.paymentMethod = 'Dinheiro';
          }
          this.showCustomerPicker = false;
          this.showQuickCustomerForm = false;
          this.activeModule = 'NEW_POS';
          this.previewFormat = 'POS';
          this.mobilePane = 'CART';
          this.scheduleDraftSave();
          this.render();
        }
        break;
      }
      case 'open-settle-customer-account': {
        if (this.isCompanySuspended()) return;
        const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
        if (!id || id === directCustId) return;
        const openDebt = this.getCustomerOpenDebt(id);
        if (openDebt <= 0) return;
        this.selectedCustomerDetailId = id;
        this.settlingInvoiceId = null;
        this.settlingCustomerAccountId = id;
        this.settleAmountInput = String(openDebt);
        this.settleMethod = 'Dinheiro';
        this.settleReference = '';
        this.settleError = null;
        this.render();
        break;
      }
      case 'close-settle-customer-account': {
        this.settlingCustomerAccountId = null;
        this.settleError = null;
        this.render();
        break;
      }
      case 'open-invoice-in-history': {
        const inv = this.invoices.find((i) => i.id === id);
        if (inv) {
          this.historySearch = '';
          this.historyDebtOnly = false;
          this.selectedHistoryId = inv.id;
          this.activeModule = 'HISTORY';
          this.render();
        }
        break;
      }
      case 'print-customer-invoice': {
        const inv = this.invoices.find((i) => i.id === id);
        if (inv) {
          const fmt: DocumentFormat = value === 'A4' ? 'A4' : 'POS';
          await this.triggerPrint(inv, fmt);
        }
        break;
      }
      case 'select-history': {
        this.selectedHistoryId = id;
        this.settlingInvoiceId = null;
        this.settleError = null;
        this.render();
        break;
      }
      case 'toggle-history-debt-filter': {
        this.historyDebtOnly = !this.historyDebtOnly;
        this.render();
        break;
      }
      case 'open-settle-debt': {
        if (this.isCompanySuspended()) return;
        const inv = this.invoices.find((i) => i.id === id);
        if (!inv || inv.status === 'cancelled' || !(inv.amountDue && inv.amountDue > 0)) return;
        this.settlingCustomerAccountId = null;
        this.settlingInvoiceId = inv.id;
        this.settleAmountInput = String(inv.amountDue);
        this.settleMethod = 'Dinheiro';
        this.settleReference = '';
        this.settleError = null;
        this.render();
        break;
      }
      case 'close-settle-debt': {
        this.settlingInvoiceId = null;
        this.settleError = null;
        this.render();
        break;
      }
      case 'filter-customer-debt-history': {
        const cust = this.customers.find((c) => c.id === id);
        this.historySearch = cust ? cust.name : '';
        this.historyDebtOnly = true;
        this.activeModule = 'HISTORY';
        this.render();
        break;
      }
      case 'set-history-format': {
        this.historyViewFormat = value as DocumentFormat;
        this.render();
        break;
      }
      case 'print-history': {
        const inv = this.invoices.find((i) => i.id === id);
        if (inv) {
          await this.triggerPrint(inv, this.historyViewFormat);
        }
        break;
      }
      case 'cancel-invoice': {
        if (!this.canCancelInvoices()) return;
        const inv = this.invoices.find((i) => i.id === id);
        if (!inv || inv.status === 'cancelled') return;
        this.cancellingInvoiceId = id;
        this.cancelInvoiceError = null;
        this.render();
        break;
      }
      case 'close-cancel-invoice-modal': {
        this.cancellingInvoiceId = null;
        this.cancelInvoiceError = null;
        this.render();
        break;
      }
      case 'remove-company-member': {
        if (!this.canManageCompanySettings()) return;
        const targetMember = this.members.find((m) => m.id === id);
        if (!targetMember || targetMember.role === 'owner') return;
        await localDb.deleteMember(id);
        this.members = this.members.filter((m) => m.id !== id);
        this.render();
        break;
      }
      case 'reset-settings': {
        if (!this.canManageCompanySettings() || !this.activeCompany.id) return;
        const resetVal: AppSettings = {
          companyId: this.activeCompany.id,
          company: { ...this.activeCompany.profile },
          defaultCashier: '01',
          defaultOperator: '001',
          defaultFormat: 'POS',
          defaultDocType: 'FR',
          defaultNotes: 'Venda directa a retalho.',
          autoPrintOnEmit: false,
          hidePromotionalFooter: canCompanyHideViralFooter(this.activeCompany),
          allowCashierPriceEdit: false,
          syncState: 'pending',
          synced: false,
          updatedAtIso: new Date().toISOString(),
        };
        await this.persistSettings(resetVal);
        break;
      }
      case 'restore-v1-snapshot': {
        if (this.activeCompany.id !== JAIMONA_COMPANY_ID) break;
        const restored = await restorePreMulticompanySnapshot();
        if (restored) {
          const refreshed = await bootstrapLocalStore(
            JAIMONA_COMPANY_ID,
            this.getViewerIdentity()
          );
          this.applyWorkspaceBundle(refreshed);
          this.syncMessage = 'Snapshot v1 pré-migração restaurado com sucesso na empresa JAIMONA.';
          this.render();
        }
        break;
      }
      case 'signin-google': {
        if (!this.isOnline) return;
        try {
          this.syncMessage = null;
          await signInWithGoogle();
        } catch (err) {
          let autoAuthorized = false;
          if (isUnauthorizedDomainError(err)) {
            const healRes = await requestEnsureAuthDomains();
            autoAuthorized = healRes.ok && (healRes.added.length > 0 || healRes.alreadyPresent);
          }
          this.syncMessage = formatFirebaseAuthErrorPt(err, autoAuthorized);
          this.render();
        }
        break;
      }
      case 'signout-google': {
        await signOutFirebase();
        this.render();
        break;
      }
      case 'sync-now': {
        await this.syncAllWithCloud(true);
        break;
      }
      case 'export-backup-local': {
        if (!this.activeCompany.id || this.requiresCompanyOnboarding) break;
        this.exportLocalJsonBackup();
        break;
      }
      case 'export-backup-cloud': {
        if (!this.activeCompany.id || this.requiresCompanyOnboarding) break;
        const isSupportInspection =
          Boolean(this.supportCompanyId && this.supportCompanyId === this.activeCompany.id) &&
          Boolean(this.user && isPlatformAdminEmail(this.user.email));
        if (!isSupportInspection && !canCompanySyncCloudData(this.activeCompany)) {
          this.growthModalNotice = null;
          this.growthModalReason = 'cloud_protection';
          this.render();
          break;
        }
        try {
          this.syncMessage = null;
          await downloadCloudBackupJson(this.activeCompany.id);
        } catch (err) {
          this.syncMessage =
            err instanceof Error ? err.message : 'Erro ao exportar backup da cloud.';
          this.render();
        }
        break;
      }
      case 'open-growth-modal': {
        const nextReason = (value || 'monthly_limit') as GrowthTriggerReason;
        this.growthModalNotice = null;
        this.growthModalReason = nextReason;
        this.render();
        break;
      }
      case 'close-growth-modal': {
        this.growthModalReason = null;
        this.growthModalNotice = null;
        this.render();
        break;
      }
      case 'activate-monthly-courtesy': {
        if (!this.activeCompany.id || this.requiresCompanyOnboarding) break;
        const usage = this.getMonthlyInvoiceUsage();
        if (usage.courtesyActive) break;
        const now = new Date().toISOString();
        const updatedComp: CompanyRecord = {
          ...this.activeCompany,
          courtesyMonthKey: usage.monthKey,
          maxObservedIso: usage.effectiveNowIso > now ? usage.effectiveNowIso : now,
          updatedAtIso: now,
        };
        await localDb.saveCompany(updatedComp);
        this.activeCompany = updatedComp;
        this.companies = this.companies.map((c) => (c.id === updatedComp.id ? updatedComp : c));
        this.growthModalReason = null;
        this.growthModalNotice = null;
        this.showScannerFeedback(
          'Cortesia mensal ativada: +10 documentos disponíveis para atendimento imediato.',
          false
        );
        this.render();
        break;
      }
      case 'copy-vitronis-iban': {
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(VITRONIS_INSTITUTIONAL.ibanBai);
            this.copiedIbanFeedback = true;
            this.render();
            window.setTimeout(() => {
              this.copiedIbanFeedback = false;
              if (this.growthModalReason) this.render();
            }, 2200);
          }
        } catch {
          // Seleção direta continua disponível no elemento font-mono select-all
        }
        break;
      }
      case 'verify-plan-activation': {
        if (!this.user || !this.isOnline || this.isVerifyingPlan) break;
        this.isVerifyingPlan = true;
        this.growthModalNotice = null;
        this.render();
        try {
          await this.syncAllWithCloud(false);
          if (hasPaidCommercialEntitlement(this.activeCompany)) {
            this.growthModalReason = null;
            this.growthModalNotice = null;
            this.showScannerFeedback(
              `Plano ${formatPlanLabelPt(this.activeCompany.plan.planTier)} confirmado com sucesso.`,
              false
            );
          } else {
            this.growthModalNotice =
              'Ainda não consta ativação comercial para este NIF na Cloud. Assim que a equipa VITRONIS validar o comprovativo, clique novamente neste botão.';
          }
        } finally {
          this.isVerifyingPlan = false;
          this.render();
        }
        break;
      }
      case 'install-pwa': {
        if (this.deferredPrompt) {
          const promptEvent = this.deferredPrompt;
          this.deferredPrompt = null;
          window.__SILA_DEFERRED_PROMPT__ = null;
          await promptEvent.prompt();
          const choice = await promptEvent.userChoice;
          if (choice.outcome === 'accepted') {
            this.isInstalled = true;
            window.__SILA_PWA_INSTALLED__ = true;
          }
          this.render();
        } else if (this.isIOS) {
          this.showIOSGuide = true;
          this.render();
        }
        break;
      }
      case 'open-ios-guide': {
        this.showIOSGuide = true;
        this.render();
        break;
      }
      case 'close-ios-guide': {
        this.showIOSGuide = false;
        this.render();
        break;
      }
      case 'dismiss-ios-banner': {
        this.iosBannerDismissed = true;
        try {
          localStorage.setItem('sila_ios_install_dismissed_v1', '1');
        } catch {
          // Ignora modo privado sem escrita no localStorage
        }
        this.render();
        break;
      }
      case 'select-cash-session': {
        if (!id) break;
        this.selectedCashSessionId = id;
        this.activeCashActionPanel = null;
        this.cashOpenError = null;
        this.cashMovementError = null;
        this.cashCloseError = null;
        const targetSess = this.cashSessions.find((s) => s.id === id);
        if (targetSess) {
          this.cashCloseOperator = targetSess.operator || this.operator || '001';
        }
        this.render();
        break;
      }
      case 'open-cash-panel': {
        const panel = value as
          | 'OPEN'
          | 'REFORCO'
          | 'SANGRIA'
          | 'ENTRADA'
          | 'SAIDA'
          | 'CLOSE';
        if (this.activeCashActionPanel === panel) {
          this.activeCashActionPanel = null;
          this.render();
          break;
        }
        this.activeCashActionPanel = panel;
        this.cashOpenError = null;
        this.cashMovementError = null;
        this.cashCloseError = null;
        if (panel === 'OPEN') {
          this.cashOpenDraft = {
            cashier: this.cashier || this.settings.defaultCashier || '01',
            operator: this.operator || this.settings.defaultOperator || '001',
            openingFloat: '',
            notes: '',
          };
        } else if (panel === 'CLOSE') {
          const sel =
            this.cashSessions.find((s) => s.id === this.selectedCashSessionId && s.status === 'open') ||
            this.getActiveOpenCashSession();
          if (sel) {
            this.selectedCashSessionId = sel.id;
            const liveSum = calculateCashSessionSummary(sel, this.invoices, this.cashMovements);
            this.cashCloseCountedInput = String(Math.max(0, liveSum.expectedCash));
            this.cashCloseOperator = this.operator || sel.operator || '001';
            this.cashCloseNotes = '';
            this.showDenominationHelper = false;
            this.denomCounts = { 5000: '', 2000: '', 1000: '', 500: '', 200: '', 100: '', 50: '' };
          }
        } else {
          const defaultReason =
            panel === 'REFORCO'
              ? 'Reforço de trocos na gaveta'
              : panel === 'SANGRIA'
                ? 'Sangria para cofre / depósito'
                : '';
          this.cashMovementDraft = {
            amount: '',
            paymentMethod: 'Dinheiro',
            reason: defaultReason,
            reference: '',
          };
        }
        this.render();
        break;
      }
      case 'close-cash-panel': {
        this.activeCashActionPanel = null;
        this.cashOpenError = null;
        this.cashMovementError = null;
        this.cashCloseError = null;
        this.render();
        break;
      }
      case 'toggle-denom-helper': {
        this.showDenominationHelper = !this.showDenominationHelper;
        this.render();
        break;
      }
      case 'clear-denom-helper': {
        this.denomCounts = { 5000: '', 2000: '', 1000: '', 500: '', 200: '', 100: '', 50: '' };
        this.cashCloseCountedInput = '0';
        this.render();
        break;
      }
      case 'cash-ledger-filter': {
        const f = value as 'ALL' | 'DRAWER' | 'SALES' | 'INFLOWS' | 'OUTFLOWS';
        this.cashLedgerFilter = f || 'ALL';
        this.render();
        break;
      }
      case 'clear-cash-ledger-search': {
        this.cashLedgerSearch = '';
        this.renderPreservingFocus('cash-ledger-search-input', 0);
        break;
      }
      case 'print-cash-report': {
        const targetSess =
          this.cashSessions.find((s) => s.id === id) ||
          this.cashSessions.find((s) => s.id === this.selectedCashSessionId);
        if (!targetSess) break;
        const fmt: DocumentFormat = value === 'A4' ? 'A4' : 'POS';
        const summary = calculateCashSessionSummary(
          targetSess,
          this.invoices,
          this.cashMovements
        );
        this.triggerCashReportPrint(targetSess, summary, fmt);
        break;
      }
      case 'toggle-pos-quick-cash': {
        const p = value as 'OPEN' | 'REFORCO' | 'SANGRIA';
        if (!p || this.posQuickCashPanel === p) {
          this.posQuickCashPanel = null;
          this.posQuickCashError = null;
          this.render();
          break;
        }
        this.posQuickCashPanel = p;
        this.posQuickCashError = null;
        this.posQuickCashAmount = '';
        this.posQuickCashReason =
          p === 'REFORCO'
            ? 'Reforço de trocos no POS'
            : p === 'SANGRIA'
              ? 'Sangria rápida para cofre'
              : '';
        if (p === 'OPEN') {
          this.cashOpenDraft = {
            cashier: this.cashier || this.settings.defaultCashier || '01',
            operator: this.operator || this.settings.defaultOperator || '001',
            openingFloat: '',
            notes: '',
          };
        }
        this.render();
        break;
      }
    }
  }

  private focusActiveModuleSearch(): void {
    let targetInputId = '';
    if (this.activeModule === 'NEW_POS' || this.activeModule === 'NEW_A4') {
      if (this.mobilePane !== 'CATALOG' && window.innerWidth < 1024) {
        this.mobilePane = 'CATALOG';
        this.render();
      }
      targetInputId = 'pos-search-input';
    } else if (this.activeModule === 'CASH') {
      targetInputId = 'cash-ledger-search-input';
    } else if (this.activeModule === 'CUSTOMERS') {
      targetInputId = 'customer-search-input';
    } else if (this.activeModule === 'PRODUCTS') {
      targetInputId = 'product-search-input';
    } else if (this.activeModule === 'HISTORY') {
      targetInputId = 'history-search-input';
    }

    if (!targetInputId) return;
    const input = document.getElementById(targetInputId) as HTMLInputElement | null;
    if (input) {
      input.focus();
      try {
        input.select();
      } catch {
        // Ignore on legacy inputs
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const rawTarget = e.target as HTMLElement | null;
    const inputTarget = rawTarget as HTMLInputElement | null;
    const tag = rawTarget?.tagName || '';
    const isEditableTarget =
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      Boolean(rawTarget?.isContentEditable);

    // 1. Enter rápido nos campos dedicados de pesquisa POS
    if (inputTarget?.dataset?.field === 'pos-search' && e.key === 'Enter') {
      e.preventDefault();
      if (this.isCompanySuspended()) return;
      const result = this.getPosProductSearchResult();
      const chosen = result.exactCodeMatch || result.matches[0] || null;
      if (chosen) {
        this.addProductToCart(chosen);
        this.posSearch = '';
        this.renderPreservingFocus('pos-search-input', 0);
      }
      return;
    }

    if (inputTarget?.dataset?.field === 'pos-customer-search' && e.key === 'Enter') {
      e.preventDefault();
      const matching = filterCustomersSmart(this.customers, this.posCustomerSearch);
      const match = matching[0] || null;
      if (match) {
        this.selectedCustomerId = match.id;
        this.showCustomerPicker = false;
        this.posCustomerSearch = '';
        this.scheduleDraftSave();
        this.render();
      }
      return;
    }

    const hasBlockingModal =
      this.showIOSGuide ||
      Boolean(this.growthModalReason) ||
      Boolean(this.cancellingInvoiceId) ||
      this.showNewCompanyModal ||
      this.showMasterAdminModal;

    // 2. Escape inteligente em cascata (Modais -> Painéis -> Limpeza de Pesquisa)
    if (e.key === 'Escape') {
      this.barcodeBuffer = '';
      if (this.showIOSGuide) {
        this.showIOSGuide = false;
        this.render();
        return;
      }
      if (this.growthModalReason) {
        this.growthModalReason = null;
        this.growthModalNotice = null;
        this.render();
        return;
      }
      if (this.cancellingInvoiceId) {
        this.cancellingInvoiceId = null;
        this.cancelInvoiceError = null;
        this.render();
        return;
      }
      if (this.showNewCompanyModal && !this.isCreatingCompany) {
        this.showNewCompanyModal = false;
        this.newCompanyError = null;
        this.render();
        return;
      }
      if (this.showMasterAdminModal) {
        this.showMasterAdminModal = false;
        this.render();
        return;
      }
      if (
        this.showCompanyDropdown ||
        this.showCustomerPicker ||
        this.showQuickCustomerForm ||
        this.showQuickProductForm ||
        this.showSuspendedDrawer ||
        this.showOptionsDrawer ||
        this.confirmRemoveCartProductId ||
        this.confirmClearCart ||
        this.settlingInvoiceId ||
        this.settlingCustomerAccountId ||
        this.quickStockProductId ||
        this.confirmDeleteProductId ||
        this.activeCashActionPanel ||
        this.posQuickCashPanel
      ) {
        this.showCompanyDropdown = false;
        this.showCustomerPicker = false;
        this.showQuickCustomerForm = false;
        this.showQuickProductForm = false;
        this.showSuspendedDrawer = false;
        this.showOptionsDrawer = false;
        this.confirmRemoveCartProductId = null;
        this.confirmClearCart = false;
        this.settlingInvoiceId = null;
        this.settlingCustomerAccountId = null;
        this.quickStockProductId = null;
        this.confirmDeleteProductId = null;
        this.activeCashActionPanel = null;
        this.posQuickCashPanel = null;
        this.render();
        return;
      }
      if (this.editingProduct || this.editingCustomer) {
        this.editingProduct = null;
        this.editingCustomer = null;
        this.render();
        return;
      }
      if ((this.activeModule === 'NEW_POS' || this.activeModule === 'NEW_A4') && this.posSearch) {
        this.posSearch = '';
        this.renderPreservingFocus('pos-search-input', 0);
        return;
      }
      if (this.activeModule === 'CASH' && this.cashLedgerSearch) {
        this.cashLedgerSearch = '';
        this.renderPreservingFocus('cash-ledger-search-input', 0);
        return;
      }
      if (this.activeModule === 'PRODUCTS' && this.productSearch) {
        this.productSearch = '';
        this.renderPreservingFocus('product-search-input', 0);
        return;
      }
      if (this.activeModule === 'CUSTOMERS' && this.customerSearch) {
        this.customerSearch = '';
        this.renderPreservingFocus('customer-search-input', 0);
        return;
      }
      if (this.activeModule === 'HISTORY' && this.historySearch) {
        this.historySearch = '';
        this.renderPreservingFocus('history-search-input', 0);
      }
      return;
    }

    if (hasBlockingModal || this.requiresCompanyOnboarding || !this.activeCompany.id) {
      return;
    }

    // 3. F2 (ou "/" fora de campos de texto) foca e seleciona a pesquisa do módulo ativo
    if (
      e.key === 'F2' ||
      (e.key === '/' &&
        !isEditableTarget &&
        this.barcodeBuffer.length === 0 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey)
    ) {
      e.preventDefault();
      this.focusActiveModuleSearch();
      return;
    }

    // 4. F4 ou Ctrl+Enter finaliza a emissão rápida da fatura no POS / A4
    const isPosModule = this.activeModule === 'NEW_POS' || this.activeModule === 'NEW_A4';
    const insideSubForm = Boolean(rawTarget?.closest('form[data-form]'));
    if (
      isPosModule &&
      !insideSubForm &&
      (e.key === 'F4' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter'))
    ) {
      if (this.cart.length > 0 && !this.isEmitting && !this.isCompanySuspended()) {
        e.preventDefault();
        void this.emitCurrentInvoice(this.settings.autoPrintOnEmit);
      }
      return;
    }

    // 5. Captura Global de Leitor de Código de Barras (USB / Bluetooth HID) sem foco no input
    if (
      isPosModule &&
      !isEditableTarget &&
      !this.isCompanySuspended() &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      const now = Date.now();
      if (e.key === 'Enter') {
        const scanned = this.barcodeBuffer.trim();
        const elapsed = now - this.barcodeLastKeyTime;
        this.barcodeBuffer = '';
        if (scanned.length >= 2 && elapsed <= 120) {
          e.preventDefault();
          const scannedLower = scanned.toLowerCase();
          const exactProd = this.products.find(
            (p) =>
              p.active &&
              (p.code.trim().toLowerCase() === scannedLower ||
                (p.barcode || '').trim().toLowerCase() === scannedLower)
          );
          if (exactProd) {
            this.addProductToCart(exactProd);
            this.showScannerFeedback(
              `${exactProd.barcode || exactProd.code} · ${exactProd.name}`,
              false
            );
            this.render();
          } else {
            this.posSearch = scanned;
            this.showScannerFeedback(`Código "${scanned}" não encontrado no catálogo`, true);
            this.renderPreservingFocus('pos-search-input', scanned.length);
          }
        }
        return;
      }

      if (e.key.length === 1) {
        if (now - this.barcodeLastKeyTime > 85) {
          this.barcodeBuffer = '';
        }
        this.barcodeBuffer += e.key;
        this.barcodeLastKeyTime = now;
      }
    }
  }

  private handleInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    if (!el) return;

    // Preserva em memória os campos em edição (sem re-renderizar o DOM a cada tecla)
    // para que eventos assíncronos de rede/auth nunca limpem o formulário do utilizador.
    const parentForm = el.closest<HTMLFormElement>('form[data-form]');
    if (parentForm) {
      const fName = parentForm.dataset.form;
      const inputName = el.name;
      if (fName === 'product-form' && this.editingProduct) {
        if (inputName === 'code') this.editingProduct.code = el.value;
        else if (inputName === 'barcode') this.editingProduct.barcode = el.value;
        else if (inputName === 'name') this.editingProduct.name = el.value;
        else if (inputName === 'category') this.editingProduct.category = el.value;
        else if (inputName === 'unit') this.editingProduct.unit = el.value;
        else if (inputName === 'exemptionReason') this.editingProduct.exemptionReason = el.value;
        else if (inputName === 'costPrice') {
          this.editingProductCostInput = el.value;
          const c = parseDecimalInput(el.value);
          if (!Number.isNaN(c) && c > 0) {
            this.editingProduct.costPrice = c;
            if (this.editingProduct.price >= 0) {
              const mk = roundKz(((this.editingProduct.price - c) / c) * 100);
              this.editingProductMarkupInput = String(mk);
              const mkEl = parentForm.querySelector<HTMLInputElement>('input[name="markupPct"]');
              if (mkEl && document.activeElement !== mkEl) mkEl.value = this.editingProductMarkupInput;
            }
          } else {
            this.editingProduct.costPrice = undefined;
            this.editingProductMarkupInput = '';
            const mkEl = parentForm.querySelector<HTMLInputElement>('input[name="markupPct"]');
            if (mkEl && document.activeElement !== mkEl) mkEl.value = '';
          }
          this.refreshProductFormMarginReadout();
        } else if (inputName === 'markupPct') {
          this.editingProductMarkupInput = el.value;
          const pct = parseDecimalInput(el.value);
          const cost = this.editingProduct.costPrice ?? 0;
          if (!Number.isNaN(pct) && pct >= -100 && cost > 0) {
            const nextPrice = Math.max(0, roundKz(cost * (1 + pct / 100)));
            this.editingProduct.price = nextPrice;
            this.editingProductPriceInput = String(nextPrice);
            const prEl = parentForm.querySelector<HTMLInputElement>('input[name="price"]');
            if (prEl && document.activeElement !== prEl) prEl.value = this.editingProductPriceInput;
            this.refreshProductFormMarginReadout();
          }
        } else if (inputName === 'price') {
          this.editingProductPriceInput = el.value;
          const p = parseDecimalInput(el.value);
          if (!Number.isNaN(p) && p >= 0) {
            this.editingProduct.price = p;
            const cost = this.editingProduct.costPrice ?? 0;
            if (cost > 0) {
              const mk = roundKz(((p - cost) / cost) * 100);
              this.editingProductMarkupInput = String(mk);
              const mkEl = parentForm.querySelector<HTMLInputElement>('input[name="markupPct"]');
              if (mkEl && document.activeElement !== mkEl) mkEl.value = this.editingProductMarkupInput;
            }
            this.refreshProductFormMarginReadout();
          }
        } else if (inputName === 'stockQty') {
          this.editingProductStockInput = el.value;
          const sq = parseDecimalInput(el.value);
          if (!Number.isNaN(sq)) this.editingProduct.stockQty = sq;
        } else if (inputName === 'minStockQty') {
          this.editingProductMinStockInput = el.value;
          const mq = parseDecimalInput(el.value);
          if (!Number.isNaN(mq) && mq >= 0) this.editingProduct.minStockQty = mq;
        }
      } else if (fName === 'pos-quick-product-form') {
        if (inputName === 'code') this.quickProductDraft.code = el.value;
        else if (inputName === 'barcode') this.quickProductDraft.barcode = el.value;
        else if (inputName === 'name') this.quickProductDraft.name = el.value;
        else if (inputName === 'category') this.quickProductDraft.category = el.value;
        else if (inputName === 'costPrice') this.quickProductDraft.costPrice = el.value;
        else if (inputName === 'price') this.quickProductDraft.price = el.value;
        else if (inputName === 'unit') this.quickProductDraft.unit = el.value;
        else if (inputName === 'stockQty') this.quickProductDraft.stockQty = el.value;
      } else if (fName === 'quick-stock-form') {
        if (inputName === 'stockQty') this.quickStockAdjustInput = el.value;
      } else if (fName === 'customer-form' && this.editingCustomer) {
        if (inputName === 'name') this.editingCustomer.name = el.value;
        else if (inputName === 'nif') this.editingCustomer.nif = el.value;
        else if (inputName === 'phone') this.editingCustomer.phone = el.value;
        else if (inputName === 'address') this.editingCustomer.address = el.value;
        else if (inputName === 'locality') this.editingCustomer.locality = el.value;
        else if (inputName === 'creditLimit') {
          this.editingCustomerCreditLimitInput = el.value;
          const lim = parseDecimalInput(el.value);
          this.editingCustomer.creditLimit = !Number.isNaN(lim) && lim > 0 ? lim : undefined;
        }
      } else if (fName === 'pos-quick-customer-form') {
        if (inputName === 'name') this.quickCustomerDraft.name = el.value;
        else if (inputName === 'nif') this.quickCustomerDraft.nif = el.value;
        else if (inputName === 'phone') this.quickCustomerDraft.phone = el.value;
        else if (inputName === 'address') this.quickCustomerDraft.address = el.value;
        else if (inputName === 'locality') this.quickCustomerDraft.locality = el.value;
      } else if (fName === 'settle-debt-form' || fName === 'settle-customer-debt-form') {
        if (inputName === 'settleAmount') this.settleAmountInput = el.value;
        else if (inputName === 'settleReference') this.settleReference = el.value;
      } else if (fName === 'open-cash-session-form' || fName === 'pos-quick-open-cash-form') {
        if (inputName === 'cashier') this.cashOpenDraft.cashier = el.value;
        else if (inputName === 'operator') this.cashOpenDraft.operator = el.value;
        else if (inputName === 'openingFloat') this.cashOpenDraft.openingFloat = el.value;
        else if (inputName === 'openingNotes') this.cashOpenDraft.notes = el.value;
      } else if (fName === 'cash-movement-form') {
        if (inputName === 'amount') this.cashMovementDraft.amount = el.value;
        else if (inputName === 'reason') this.cashMovementDraft.reason = el.value;
        else if (inputName === 'reference') this.cashMovementDraft.reference = el.value;
      } else if (fName === 'pos-quick-movement-form') {
        if (inputName === 'amount') this.posQuickCashAmount = el.value;
        else if (inputName === 'reason') this.posQuickCashReason = el.value;
      } else if (fName === 'close-cash-session-form') {
        if (inputName === 'closedByOperator') this.cashCloseOperator = el.value;
        else if (inputName === 'closingNotes') this.cashCloseNotes = el.value;
      }
    }

    const field = el.dataset.field;
    const id = el.dataset.id || '';
    if (!field) return;

    const activeId = el.id;
    const selStart = el.selectionStart;
    const rawVal = el.value;

    switch (field) {
      case 'pos-search':
        this.posSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'pos-customer-search':
        this.posCustomerSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'master-admin-search':
        this.masterAdminSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'cart-qty-live': {
        const parsed = parseFloat(rawVal.replace(',', '.'));
        if (!Number.isNaN(parsed) && parsed > 0) {
          this.cart = this.cart.map((c) =>
            c.productId === id ? { ...c, qty: roundKz(parsed) } : c
          );
          this.scheduleDraftSave();
          this.renderPreservingInputValue(activeId, rawVal, selStart);
        }
        break;
      }
      case 'cart-price-live': {
        if (!this.canEditCartUnitPrice()) break;
        const parsed = parseFloat(rawVal.replace(',', '.'));
        if (!Number.isNaN(parsed) && parsed >= 0) {
          this.cart = this.cart.map((c) =>
            c.productId === id ? { ...c, unitPrice: roundKz(parsed) } : c
          );
          this.scheduleDraftSave();
          this.renderPreservingInputValue(activeId, rawVal, selStart);
        }
        break;
      }
      case 'cart-discount-live': {
        const parsed = rawVal.trim() === '' ? 0 : parseFloat(rawVal.replace(',', '.'));
        if (!Number.isNaN(parsed)) {
          const disc = Math.min(100, Math.max(0, parsed));
          this.cart = this.cart.map((c) =>
            c.productId === id ? { ...c, discountPct: roundKz(disc) } : c
          );
          this.scheduleDraftSave();
          this.renderPreservingInputValue(activeId, rawVal, selStart);
        }
        break;
      }
      case 'global-discount-live': {
        this.globalDiscountInput = rawVal;
        const parsed = rawVal.trim() === '' ? 0 : parseFloat(rawVal.replace(',', '.'));
        if (!Number.isNaN(parsed)) {
          this.globalDiscountPct = roundKz(Math.min(100, Math.max(0, parsed)));
          this.scheduleDraftSave();
          this.renderPreservingInputValue(activeId, rawVal, selStart);
        }
        break;
      }
      case 'split-amount-live': {
        const method = id as DirectPaymentMethod;
        if (method === 'Dinheiro' || method === 'Multicaixa' || method === 'Transferência') {
          this.splitInputs[method] = rawVal;
          this.scheduleDraftSave();
          this.renderPreservingInputValue(activeId, rawVal, selStart);
        }
        break;
      }
      case 'transfer-ref-live':
        this.transferReference = rawVal;
        this.scheduleDraftSave();
        this.renderPreservingInputValue(activeId, rawVal, selStart);
        break;
      case 'amount-received':
        this.amountReceivedInput = rawVal;
        this.scheduleDraftSave();
        this.renderPreservingInputValue(activeId, rawVal, selStart);
        break;
      case 'pos-cashier':
        this.cashier = rawVal;
        this.scheduleDraftSave();
        break;
      case 'pos-operator':
        this.operator = rawVal;
        this.scheduleDraftSave();
        break;
      case 'pos-notes':
        this.notes = rawVal;
        this.scheduleDraftSave();
        this.renderPreservingInputValue(activeId, rawVal, selStart);
        break;
      case 'product-search':
        this.productSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'customer-search':
        this.customerSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'history-search':
        this.historySearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'cash-ledger-search':
        this.cashLedgerSearch = rawVal;
        this.renderPreservingFocus(activeId, selStart);
        break;
      case 'cash-counted-live':
        this.cashCloseCountedInput = rawVal;
        this.renderPreservingInputValue(activeId, rawVal, selStart);
        break;
      case 'cash-denom-live': {
        const denom = Number(id);
        if (denom > 0) {
          this.denomCounts[denom] = rawVal.replace(/[^\d]/g, '');
          const sum = this.computeDenominationSum();
          this.cashCloseCountedInput = String(sum);
          this.renderPreservingInputValue(activeId, this.denomCounts[denom] || '', selStart);
        }
        break;
      }
    }
  }

  private async handleChange(e: Event): Promise<void> {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    if (el && this.editingProduct && el.closest('form[data-form="product-form"]')) {
      if (el.name === 'ivaRate') {
        this.editingProduct.ivaRate = Number(el.value) === 0 ? 0 : 14;
        if (this.editingProduct.ivaRate === 0 && !this.editingProduct.exemptionReason) {
          this.editingProduct.exemptionReason = DEFAULT_IVA_EXEMPTION_REASONS[0];
        }
        this.render();
        return;
      } else if (el.name === 'trackStock') {
        this.editingProduct.trackStock = (el as HTMLInputElement).checked;
        this.render();
        return;
      } else if (el.name === 'active') {
        this.editingProduct.active = (el as HTMLInputElement).checked;
      }
    }
    if (el && el.closest('form[data-form="pos-quick-product-form"]')) {
      if (el.name === 'ivaRate') {
        this.quickProductDraft.ivaRate = Number(el.value) === 0 ? 0 : 14;
      } else if (el.name === 'trackStock') {
        this.quickProductDraft.trackStock = (el as HTMLInputElement).checked;
        this.render();
        return;
      }
    }
    if (
      el &&
      el.name === 'settleMethod' &&
      (el.closest('form[data-form="settle-debt-form"]') ||
        el.closest('form[data-form="settle-customer-debt-form"]'))
    ) {
      const m = el.value as DirectPaymentMethod;
      if (m === 'Dinheiro' || m === 'Multicaixa' || m === 'Transferência') {
        this.settleMethod = m;
        this.render();
        return;
      }
    }
    if (el && el.name === 'paymentMethod' && el.closest('form[data-form="cash-movement-form"]')) {
      const m = el.value as DirectPaymentMethod;
      if (m === 'Dinheiro' || m === 'Multicaixa' || m === 'Transferência') {
        this.cashMovementDraft.paymentMethod = m;
        this.render();
        return;
      }
    }
    const field = el.dataset.field;
    const id = el.dataset.id || '';
    if (!field) return;

    switch (field) {
      case 'product-category-filter': {
        this.productCategoryFilter = el.value || 'ALL';
        this.render();
        break;
      }
      case 'terminal-role-select': {
        const nextRole = el.value as CompanyRole;
        if (nextRole === 'owner' || nextRole === 'manager' || nextRole === 'cashier') {
          this.selectedTerminalRole = nextRole;
          this.editingProduct = null;
          this.editingCustomer = null;
          this.render();
        }
        break;
      }
      case 'company-allow-manager-cancel': {
        if (!this.canManageCompanySettings()) return;
        const checked = (el as HTMLInputElement).checked;
        const updatedComp: CompanyRecord = {
          ...this.activeCompany,
          allowManagerCancel: checked,
          syncState: 'pending',
          synced: false,
          updatedAtIso: new Date().toISOString(),
        };
        await localDb.saveCompany(updatedComp);
        this.activeCompany = updatedComp;
        this.companies = this.companies.map((c) => (c.id === updatedComp.id ? updatedComp : c));
        this.render();
        if (this.user && this.isOnline) {
          try {
            await ensureCompanyRegisteredCloud(updatedComp, true);
            const syncedComp: CompanyRecord = { ...updatedComp, syncState: 'synced', synced: true };
            await localDb.saveCompany(syncedComp);
            this.activeCompany = syncedComp;
            this.companies = this.companies.map((c) => (c.id === syncedComp.id ? syncedComp : c));
            this.render();
          } catch {
            // Mantém pendente localmente
          }
        }
        break;
      }
      case 'toggle-clean-footer': {
        const checkbox = el as HTMLInputElement;
        if (!canCompanyHideViralFooter(this.activeCompany)) {
          checkbox.checked = false;
          this.growthModalNotice = null;
          this.growthModalReason = 'clean_footer';
          this.render();
        }
        break;
      }
      case 'admin-company-plan': {
        const planTier = el.value as PlanTier;
        if (this.user && this.isOnline) {
          const res = await updatePlatformCompanyAdmin(id, { planTier });
          if (!res.ok) {
            this.masterAdminError = res.error || 'Erro ao atualizar plano comercial.';
            this.render();
            return;
          }
        }
        const localComp = this.companies.find((c) => c.id === id);
        if (localComp) {
          const now = new Date().toISOString();
          const updatedComp: CompanyRecord = {
            ...localComp,
            plan: {
              ...localComp.plan,
              planTier,
              commercialActive: planTier !== 'FREE',
              updatedAtIso: now,
            },
            updatedAtIso: now,
          };
          await localDb.saveCompany(updatedComp);
          this.companies = this.companies.map((c) => (c.id === id ? updatedComp : c));
          if (this.activeCompany.id === id) {
            this.activeCompany = updatedComp;
          }
        }
        await this.refreshMasterAdminData();
        break;
      }
      case 'pos-customer':
        this.selectedCustomerId = el.value;
        this.scheduleDraftSave();
        this.render();
        break;
      case 'pos-doctype':
        this.docType = el.value as DocumentType;
        this.scheduleDraftSave();
        this.render();
        break;
      case 'cart-qty-live': {
        const val = parseFloat(el.value.replace(',', '.'));
        if (!Number.isNaN(val) && val > 0) {
          this.cart = this.cart.map((c) =>
            c.productId === id ? { ...c, qty: roundKz(val) } : c
          );
          this.scheduleDraftSave();
        }
        this.render();
        break;
      }
      case 'cart-price-live': {
        if (!this.canEditCartUnitPrice()) break;
        const val = parseFloat(el.value.replace(',', '.'));
        if (!Number.isNaN(val) && val >= 0) {
          this.cart = this.cart.map((c) =>
            c.productId === id ? { ...c, unitPrice: roundKz(val) } : c
          );
          this.scheduleDraftSave();
        }
        this.render();
        break;
      }
      case 'cart-discount-live': {
        const disc = Math.min(100, Math.max(0, parseFloat(el.value.replace(',', '.')) || 0));
        this.cart = this.cart.map((c) =>
          c.productId === id ? { ...c, discountPct: roundKz(disc) } : c
        );
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'global-discount-live': {
        const disc = Math.min(100, Math.max(0, parseFloat(el.value.replace(',', '.')) || 0));
        this.globalDiscountPct = roundKz(disc);
        this.globalDiscountInput = this.globalDiscountPct > 0 ? String(this.globalDiscountPct) : '';
        this.scheduleDraftSave();
        this.render();
        break;
      }
    }
  }

  private async handleSubmit(e: SubmitEvent): Promise<void> {
    const form = e.target as HTMLFormElement;
    const formName = form.dataset.form;
    if (!formName) return;
    e.preventDefault();

    const fd = new FormData(form);

    if (formName === 'new-company-form') {
      if (this.isCreatingCompany) return;
      this.newCompanyError = null;
      this.isCreatingCompany = true;
      this.render();

      try {
        const legalName = String(fd.get('legalName') || '').trim();
        const shortName = String(fd.get('shortName') || '').trim();
        const nif = String(fd.get('nif') || '').trim();
        const cityCountry = String(fd.get('cityCountry') || 'Luanda - Angola').trim();
        const phone = String(fd.get('phone') || '').trim();
        const address = String(fd.get('address') || '').trim();
        const copyStarterCatalog = fd.get('copyStarterCatalog') === 'on';
        const termsAccepted = fd.get('acceptTerms') === 'on';

        const createdCompany = await registerNewCompanyLocal({
          legalName,
          shortName,
          nif,
          cityCountry,
          phone,
          address,
          copyStarterCatalog,
          termsAccepted,
          ownerUid: this.user?.uid,
          ownerEmail: this.user?.email || undefined,
          ownerDisplayName: this.user?.displayName || undefined,
        });

        if (this.user && this.isOnline) {
          const backendRes = await registerCompanyBackend(createdCompany);
          if (
            !backendRes.ok &&
            (backendRes.statusCode === 409 ||
              backendRes.statusCode === 429 ||
              backendRes.statusCode === 400)
          ) {
            await localDb.deleteCompanyRollback(createdCompany.id);
            throw new Error(
              backendRes.error || 'Este NIF já se encontra registado noutra empresa no sistema.'
            );
          }

          try {
            await ensureCompanyRegisteredCloud(createdCompany, true);
            const syncedComp: CompanyRecord = {
              ...createdCompany,
              syncState: 'synced',
              synced: true,
            };
            await localDb.saveCompany(syncedComp);
          } catch {
            // Se o backend Admin SDK já reservou o NIF, mantém operacional
          }
        }

        this.supportCompanyId = null;
        await this.flushDraftNow();
        const bundle = await loadCompanyWorkspace(createdCompany.id, this.getViewerIdentity());
        this.applyWorkspaceBundle(bundle);
        this.showNewCompanyModal = false;
        this.activeModule = 'NEW_POS';
        this.previewFormat = 'POS';
        this.render();

        if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
          void this.syncAllWithCloud();
        }
      } catch (err) {
        this.newCompanyError =
          err instanceof Error
            ? err.message
            : 'Não foi possível cadastrar a empresa. Verifique se o NIF é único.';
        this.render();
      } finally {
        this.isCreatingCompany = false;
        this.render();
      }
      return;
    }

    if (formName === 'cancel-invoice-form') {
      if (!this.canCancelInvoices()) {
        this.cancelInvoiceError = 'O seu perfil atual não tem permissão para anular faturas.';
        this.render();
        return;
      }
      const invoiceId = String(fd.get('invoiceId') || '').trim();
      const cancelReason = String(fd.get('cancelReason') || '').trim();
      if (cancelReason.length < 4) {
        this.cancelInvoiceError =
          'Indique o motivo de anulação (mínimo de 4 caracteres) para registo de auditoria.';
        this.render();
        return;
      }

      const inv = this.invoices.find((i) => i.id === invoiceId);
      if (!inv || inv.status === 'cancelled') {
        this.cancellingInvoiceId = null;
        this.render();
        return;
      }

      const actorLabel = this.user?.email || formatRoleLabelPt(this.getEffectiveRole());
      const cancelled: InvoiceRecord = {
        ...inv,
        companyId: this.activeCompany.id,
        status: 'cancelled',
        cancelReason,
        cancelledBy: actorLabel,
        syncState: 'pending',
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      await localDb.saveInvoice(cancelled, this.activeCompany.id);
      if (inv.docType === 'FR') {
        await this.adjustCatalogStockForInvoiceLines(inv.lines, 'RESTORE');
      }
      this.invoices = this.invoices.map((x) => (x.id === invoiceId ? cancelled : x));
      this.cancellingInvoiceId = null;
      this.cancelInvoiceError = null;
      this.render();

      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          if (canCompanySyncCloudData(this.activeCompany)) {
            await cancelInvoiceCloud(invoiceId, cancelReason, this.activeCompany.id, this.activeCompany);
            await cancelInvoiceBackend(this.activeCompany.id, invoiceId, cancelReason).catch(
              () => null
            );
            const synced: InvoiceRecord = { ...cancelled, syncState: 'synced', synced: true };
            await localDb.saveInvoice(synced, this.activeCompany.id);
            this.invoices = this.invoices.map((x) => (x.id === invoiceId ? synced : x));
            this.render();
          }
        } catch {
          // Mantém pendente localmente para reenvio
        }
      }
      return;
    }

    if (formName === 'settle-debt-form' && this.settlingInvoiceId) {
      if (this.isCompanySuspended()) return;
      this.settleError = null;
      const inv = this.invoices.find((i) => i.id === this.settlingInvoiceId);
      if (!inv || inv.status === 'cancelled' || !(inv.amountDue && inv.amountDue > 0)) {
        this.settlingInvoiceId = null;
        this.render();
        return;
      }

      const rawAmt = String(fd.get('settleAmount') ?? this.settleAmountInput ?? '').trim();
      const payAmt = parseDecimalInput(rawAmt);
      if (Number.isNaN(payAmt) || payAmt <= 0) {
        this.settleError = 'Indique um valor válido a liquidar.';
        this.render();
        return;
      }

      const method = (fd.get('settleMethod') as DirectPaymentMethod) || this.settleMethod;
      const refText = String(fd.get('settleReference') ?? this.settleReference ?? '').trim().slice(0, 80);
      const currentDue = roundKz(inv.amountDue);
      const applied = Math.min(currentDue, roundKz(payAmt));
      const extraChange = Math.max(0, roundKz(payAmt - currentDue));
      const updatedInv = this.buildSettledInvoiceRecord(inv, applied, extraChange, method, refText);

      await localDb.saveInvoice(updatedInv, this.activeCompany.id);
      this.invoices = this.invoices.map((x) => (x.id === updatedInv.id ? updatedInv : x));

      if (applied > 0) {
        const openSess = this.getActiveOpenCashSession();
        const nowMov = new Date().toISOString();
        const debtMov: CashMovement = {
          id: `cm_liq_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          companyId: this.activeCompany.id,
          sessionId: openSess ? openSess.id : 'sem_turno',
          cashier: openSess?.cashier || this.cashier || '01',
          operator: openSess?.operator || this.operator || '001',
          createdByUid: this.user?.uid,
          type: 'LIQUIDACAO_DIVIDA',
          amount: applied,
          paymentMethod: method,
          reason: `Liquidação de dívida ${inv.number}`.slice(0, 240),
          ...(refText ? { reference: refText } : {}),
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          customerName: inv.customerName.slice(0, 160),
          syncState: 'pending',
          synced: false,
          createdAtIso: nowMov,
        };
        await this.persistAndSyncCashMovement(debtMov);
      }

      this.settlingInvoiceId = null;
      this.settleError = null;
      if (this.activeModule === 'CUSTOMERS') {
        this.customerSavedNotice = `Pagamento de ${formatKzNumber(applied)} Kz registado na fatura ${inv.number}.`;
        window.setTimeout(() => {
          if (this.customerSavedNotice) {
            this.customerSavedNotice = null;
            if (this.activeModule === 'CUSTOMERS') this.render();
          }
        }, 2800);
      }
      this.render();

      if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          await createInvoiceCloud(updatedInv, this.activeCompany);
          const synced: InvoiceRecord = { ...updatedInv, syncState: 'synced', synced: true };
          await localDb.saveInvoice(synced, this.activeCompany.id);
          this.invoices = this.invoices.map((x) => (x.id === synced.id ? synced : x));
          this.render();
        } catch {
          // Mantém pendente localmente
        }
      }
      return;
    }

    if (formName === 'settle-customer-debt-form' && this.settlingCustomerAccountId) {
      if (this.isCompanySuspended()) return;
      this.settleError = null;
      const custId = this.settlingCustomerAccountId;
      const openInvoices = this.invoices
        .filter(
          (i) =>
            i.status === 'issued' &&
            i.docType === 'FR' &&
            i.customerId === custId &&
            typeof i.amountDue === 'number' &&
            i.amountDue > 0
        )
        .sort((a, b) => a.issuedAtIso.localeCompare(b.issuedAtIso));

      if (openInvoices.length === 0) {
        this.settlingCustomerAccountId = null;
        this.render();
        return;
      }

      const rawAmt = String(fd.get('settleAmount') ?? this.settleAmountInput ?? '').trim();
      const payAmt = parseDecimalInput(rawAmt);
      if (Number.isNaN(payAmt) || payAmt <= 0) {
        this.settleError = 'Indique um montante válido recebido do cliente.';
        this.render();
        return;
      }

      const method = (fd.get('settleMethod') as DirectPaymentMethod) || this.settleMethod;
      const refText = String(fd.get('settleReference') ?? this.settleReference ?? '').trim().slice(0, 80);

      let remaining = roundKz(payAmt);
      let totalApplied = 0;
      const updatedMap = new Map<string, InvoiceRecord>();
      const openSess = this.getActiveOpenCashSession();

      for (let idx = 0; idx < openInvoices.length; idx++) {
        if (remaining <= 0) break;
        const targetInv = openInvoices[idx]!;
        const invDue = roundKz(targetInv.amountDue || 0);
        const applied = Math.min(invDue, remaining);
        remaining = Math.max(0, roundKz(remaining - applied));
        totalApplied = roundKz(totalApplied + applied);
        const isLastOpen = idx === openInvoices.length - 1;
        const extraChange = isLastOpen && remaining > 0 ? remaining : 0;
        const updatedInv = this.buildSettledInvoiceRecord(
          targetInv,
          applied,
          extraChange,
          method,
          refText
        );
        updatedMap.set(updatedInv.id, updatedInv);
        await localDb.saveInvoice(updatedInv, this.activeCompany.id);

        if (applied > 0) {
          const nowMov = new Date().toISOString();
          const debtMov: CashMovement = {
            id: `cm_liq_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 5)}`,
            companyId: this.activeCompany.id,
            sessionId: openSess ? openSess.id : 'sem_turno',
            cashier: openSess?.cashier || this.cashier || '01',
            operator: openSess?.operator || this.operator || '001',
            createdByUid: this.user?.uid,
            type: 'LIQUIDACAO_DIVIDA',
            amount: applied,
            paymentMethod: method,
            reason: `Amortização conta corrente ${targetInv.number}`.slice(0, 240),
            ...(refText ? { reference: refText } : {}),
            invoiceId: targetInv.id,
            invoiceNumber: targetInv.number,
            customerName: targetInv.customerName.slice(0, 160),
            syncState: 'pending',
            synced: false,
            createdAtIso: nowMov,
          };
          await this.persistAndSyncCashMovement(debtMov);
        }
      }

      this.invoices = this.invoices.map((x) => updatedMap.get(x.id) || x);
      this.settlingCustomerAccountId = null;
      this.settleError = null;
      this.customerSavedNotice = `Pagamento de ${formatKzNumber(totalApplied)} Kz registado (${updatedMap.size} ${updatedMap.size === 1 ? 'fatura amortizada' : 'faturas amortizadas'}).`;
      this.render();

      window.setTimeout(() => {
        if (this.customerSavedNotice) {
          this.customerSavedNotice = null;
          if (this.activeModule === 'CUSTOMERS') this.render();
        }
      }, 3000);

      if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          for (const updatedInv of updatedMap.values()) {
            await createInvoiceCloud(updatedInv, this.activeCompany);
            const synced: InvoiceRecord = { ...updatedInv, syncState: 'synced', synced: true };
            await localDb.saveInvoice(synced, this.activeCompany.id);
            this.invoices = this.invoices.map((x) => (x.id === synced.id ? synced : x));
          }
          this.render();
        } catch {
          // Mantém pendente localmente
        }
      }
      return;
    }

    if (formName === 'open-cash-session-form' || formName === 'pos-quick-open-cash-form') {
      const isQuick = formName === 'pos-quick-open-cash-form';
      this.cashOpenError = null;
      this.posQuickCashError = null;
      const cashier = String(fd.get('cashier') ?? this.cashOpenDraft.cashier ?? '01').trim();
      const operator = String(fd.get('operator') ?? this.cashOpenDraft.operator ?? '001').trim();
      const rawFloat = String(fd.get('openingFloat') ?? this.cashOpenDraft.openingFloat ?? '').trim();
      const parsedFloat = rawFloat === '' ? 0 : parseDecimalInput(rawFloat);
      const openingNotes = String(fd.get('openingNotes') ?? this.cashOpenDraft.notes ?? '').trim();

      const res = await this.openNewCashSession({
        cashier,
        operator,
        openingFloat: parsedFloat,
        openingNotes,
      });

      if (!res.ok || !res.session) {
        if (isQuick) this.posQuickCashError = res.error || 'Erro ao abrir caixa.';
        else this.cashOpenError = res.error || 'Erro ao abrir caixa.';
        this.render();
        return;
      }

      this.activeCashActionPanel = null;
      this.posQuickCashPanel = null;
      this.cashOpenDraft = {
        cashier: res.session.cashier,
        operator: res.session.operator,
        openingFloat: '',
        notes: '',
      };
      if (isQuick) {
        this.showScannerFeedback(
          `Caixa ${res.session.cashier} aberta (Op. ${res.session.operator}) · Fundo: ${formatKzNumber(res.session.openingFloat)} Kz.`,
          false
        );
      } else {
        this.showCashNotice(
          `Turno de Caixa ${res.session.cashier} aberto por ${res.session.operator} com fundo inicial de ${formatKzNumber(res.session.openingFloat)} Kz.`
        );
      }
      this.render();
      return;
    }

    if (formName === 'cash-movement-form') {
      this.cashMovementError = null;
      const movTypeRaw = String(fd.get('movementType') || this.activeCashActionPanel || '');
      if (
        movTypeRaw !== 'REFORCO' &&
        movTypeRaw !== 'SANGRIA' &&
        movTypeRaw !== 'ENTRADA' &&
        movTypeRaw !== 'SAIDA'
      ) {
        return;
      }
      const targetSess =
        this.cashSessions.find(
          (s) => s.id === this.selectedCashSessionId && s.status === 'open'
        ) || this.getActiveOpenCashSession();
      if (!targetSess) {
        this.cashMovementError = 'Abra primeiro um turno de caixa antes de registar movimentos.';
        this.render();
        return;
      }

      const rawAmount = String(fd.get('amount') ?? this.cashMovementDraft.amount ?? '').trim();
      const parsedAmount = parseDecimalInput(rawAmount);
      const paymentMethod =
        (fd.get('paymentMethod') as DirectPaymentMethod) ||
        this.cashMovementDraft.paymentMethod ||
        'Dinheiro';
      const reason = String(fd.get('reason') ?? this.cashMovementDraft.reason ?? '').trim();
      const reference = String(fd.get('reference') ?? this.cashMovementDraft.reference ?? '').trim();

      const res = await this.recordCashDrawerMovement({
        session: targetSess,
        type: movTypeRaw,
        amount: parsedAmount,
        paymentMethod,
        reason,
        reference,
      });

      if (!res.ok || !res.movement) {
        this.cashMovementError = res.error || 'Não foi possível registar o movimento.';
        this.render();
        return;
      }

      const typeLabelMap: Record<typeof movTypeRaw, string> = {
        REFORCO: 'Reforço de caixa',
        SANGRIA: 'Sangria de caixa',
        ENTRADA: 'Entrada de caixa',
        SAIDA: 'Saída de caixa',
      };
      this.activeCashActionPanel = null;
      this.cashMovementDraft = { amount: '', paymentMethod: 'Dinheiro', reason: '', reference: '' };
      this.showCashNotice(
        `${typeLabelMap[movTypeRaw]} de ${formatKzNumber(res.movement.amount)} Kz registado com sucesso.`
      );
      this.render();
      return;
    }

    if (formName === 'pos-quick-movement-form') {
      this.posQuickCashError = null;
      const movTypeRaw = String(fd.get('movementType') || this.posQuickCashPanel || '');
      if (movTypeRaw !== 'REFORCO' && movTypeRaw !== 'SANGRIA') return;
      const openSess = this.getActiveOpenCashSession();
      if (!openSess) {
        this.posQuickCashError = 'Nenhum turno de caixa aberto.';
        this.render();
        return;
      }

      const rawAmount = String(fd.get('amount') ?? this.posQuickCashAmount ?? '').trim();
      const parsedAmount = parseDecimalInput(rawAmount);
      const reason = String(fd.get('reason') ?? this.posQuickCashReason ?? '').trim();

      const res = await this.recordCashDrawerMovement({
        session: openSess,
        type: movTypeRaw,
        amount: parsedAmount,
        paymentMethod: 'Dinheiro',
        reason,
      });

      if (!res.ok || !res.movement) {
        this.posQuickCashError = res.error || 'Erro ao registar movimento na gaveta.';
        this.render();
        return;
      }

      this.posQuickCashPanel = null;
      this.posQuickCashAmount = '';
      this.posQuickCashReason = '';
      this.showScannerFeedback(
        `${movTypeRaw === 'REFORCO' ? 'Reforço' : 'Sangria'} de ${formatKzNumber(res.movement.amount)} Kz registado na Caixa ${openSess.cashier}.`,
        false
      );
      this.render();
      return;
    }

    if (formName === 'close-cash-session-form') {
      this.cashCloseError = null;
      const sessionId = String(fd.get('sessionId') || this.selectedCashSessionId || '').trim();
      const rawCounted = String(fd.get('countedCash') ?? this.cashCloseCountedInput ?? '').trim();
      const parsedCounted = rawCounted === '' ? Number.NaN : parseDecimalInput(rawCounted);
      const closedByOperator = String(
        fd.get('closedByOperator') ?? this.cashCloseOperator ?? this.operator ?? '001'
      ).trim();
      const closingNotes = String(fd.get('closingNotes') ?? this.cashCloseNotes ?? '').trim();
      const shouldPrint = fd.get('autoPrintClosure') === 'on';

      const res = await this.closeCashSessionById({
        sessionId,
        countedCash: parsedCounted,
        closedByOperator,
        closingNotes,
      });

      if (!res.ok || !res.closed || !res.summary) {
        this.cashCloseError = res.error || 'Não foi possível concluir o fecho de caixa.';
        this.render();
        return;
      }

      this.activeCashActionPanel = null;
      this.selectedCashSessionId = res.closed.id;
      this.cashCloseCountedInput = '';
      this.cashCloseNotes = '';
      this.showDenominationHelper = false;
      this.denomCounts = { 5000: '', 2000: '', 1000: '', 500: '', 200: '', 100: '', 50: '' };
      const diff = res.summary.differenceAmount ?? 0;
      const diffSummary =
        Math.abs(diff) < 0.005
          ? 'Saldo conferido sem diferenças (0,00 Kz)'
          : diff > 0
            ? `Sobra apurada: +${formatKzNumber(diff)} Kz`
            : `Quebra apurada: ${formatKzNumber(diff)} Kz`;
      this.showCashNotice(
        `Caixa ${res.closed.cashier} encerrada por ${res.closed.closedByOperator}. ${diffSummary}.`
      );
      this.render();

      if (shouldPrint) {
        this.triggerCashReportPrint(res.closed, res.summary, 'POS');
      }
      return;
    }

    if (formName === 'pos-quick-product-form') {
      if (!this.canManageCatalog()) {
        this.quickProductError = 'Sem permissão para cadastrar artigos no catálogo.';
        this.render();
        return;
      }
      this.quickProductError = null;
      const code = String(fd.get('code') || this.quickProductDraft.code || '').trim().slice(0, 32);
      const barcode = String(fd.get('barcode') || this.quickProductDraft.barcode || '')
        .trim()
        .slice(0, 48);
      const name = String(fd.get('name') || this.quickProductDraft.name || '').trim().slice(0, 160);
      const category =
        String(fd.get('category') || this.quickProductDraft.category || 'Mercearia')
          .trim()
          .slice(0, 48) || 'Mercearia';
      const unit =
        String(fd.get('unit') || this.quickProductDraft.unit || 'un').trim().slice(0, 12) || 'un';
      const rawCost = String(fd.get('costPrice') ?? this.quickProductDraft.costPrice ?? '').trim();
      const parsedCost = rawCost ? parseDecimalInput(rawCost) : 0;
      const parsedPrice = parseDecimalInput(
        String(fd.get('price') ?? this.quickProductDraft.price ?? '')
      );
      const ivaRate: TaxRate =
        Number(fd.get('ivaRate') ?? this.quickProductDraft.ivaRate) === 0 ? 0 : 14;
      const trackStock = fd.get('trackStock') === 'on' || this.quickProductDraft.trackStock;
      const parsedStock = parseDecimalInput(
        String(fd.get('stockQty') ?? this.quickProductDraft.stockQty ?? '0')
      );

      if (!code || !name) {
        this.quickProductError = 'Preencha o código (SKU) e a descrição do artigo.';
        this.render();
        return;
      }
      if (this.products.some((p) => p.code.trim().toLowerCase() === code.toLowerCase())) {
        this.quickProductError = `O código interno / SKU "${code}" já pertence a outro artigo.`;
        this.render();
        return;
      }
      if (
        barcode &&
        this.products.some(
          (p) =>
            (p.barcode || '').trim().toLowerCase() === barcode.toLowerCase() ||
            p.code.trim().toLowerCase() === barcode.toLowerCase()
        )
      ) {
        this.quickProductError = `O código de barras "${barcode}" já está associado a outro artigo.`;
        this.render();
        return;
      }
      if (rawCost && (Number.isNaN(parsedCost) || parsedCost < 0)) {
        this.quickProductError = 'Indique um preço de aquisição válido em Kwanzas.';
        this.render();
        return;
      }
      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        this.quickProductError = 'Indique um preço de venda válido em Kwanzas.';
        this.render();
        return;
      }

      const now = new Date().toISOString();
      const validCost = rawCost && parsedCost > 0 ? roundKz(parsedCost) : undefined;
      const created: Product = {
        id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        companyId: this.activeCompany.id,
        code,
        ...(barcode ? { barcode } : {}),
        name,
        category,
        unit,
        ...(typeof validCost === 'number' ? { costPrice: validCost } : {}),
        price: roundKz(parsedPrice),
        ivaRate,
        exemptionReason: ivaRate === 0 ? DEFAULT_IVA_EXEMPTION_REASONS[0] : '',
        active: true,
        trackStock,
        stockQty: trackStock && !Number.isNaN(parsedStock) ? parsedStock : 0,
        minStockQty: trackStock ? 2 : 0,
        syncState: 'pending',
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      try {
        await localDb.saveProduct(created, this.activeCompany.id);
      } catch (err) {
        this.quickProductError = formatStorageErrorPt(err, 'o artigo');
        this.render();
        return;
      }

      this.products = [...this.products, created].sort((a, b) => a.code.localeCompare(b.code));
      this.selectedProductDetailId = created.id;
      this.showQuickProductForm = false;
      this.posSearch = '';
      this.addProductToCart(created);
      this.showScannerFeedback(`Artigo "${created.name}" criado e adicionado à venda.`, false);
      this.render();

      if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          await upsertProductCloud(created, true, this.activeCompany);
          const synced: Product = { ...created, syncState: 'synced', synced: true };
          await localDb.saveProduct(synced, this.activeCompany.id);
          this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
          this.render();
        } catch {
          // Mantém pendente
        }
      }
      return;
    }

    if (formName === 'quick-stock-form' && this.quickStockProductId) {
      if (!this.canManageCatalog()) return;
      const target = this.products.find((p) => p.id === this.quickStockProductId);
      if (!target) {
        this.quickStockProductId = null;
        this.render();
        return;
      }
      const rawStock = String(fd.get('stockQty') ?? this.quickStockAdjustInput ?? '0');
      const parsedStock = parseDecimalInput(rawStock);
      if (Number.isNaN(parsedStock)) {
        this.productFormError = 'Indique uma quantidade de stock válida.';
        this.render();
        return;
      }
      const now = new Date().toISOString();
      const updatedProd: Product = {
        ...target,
        trackStock: true,
        stockQty: roundKz(parsedStock),
        minStockQty: target.minStockQty ?? 2,
        syncState: 'pending',
        synced: false,
        updatedAtIso: now,
      };
      await localDb.saveProduct(updatedProd, this.activeCompany.id);
      this.products = this.products.map((p) => (p.id === updatedProd.id ? updatedProd : p));
      this.quickStockProductId = null;
      this.quickStockAdjustInput = '';
      this.productSavedNotice = `Stock de "${updatedProd.name}" atualizado para ${updatedProd.stockQty} ${updatedProd.unit}.`;
      this.render();

      window.setTimeout(() => {
        if (this.productSavedNotice) {
          this.productSavedNotice = null;
          if (this.activeModule === 'PRODUCTS') this.render();
        }
      }, 2500);

      if (this.user && this.isOnline && canCompanySyncCloudData(this.activeCompany)) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          await upsertProductCloud(updatedProd, false, this.activeCompany);
          const synced: Product = { ...updatedProd, syncState: 'synced', synced: true };
          await localDb.saveProduct(synced, this.activeCompany.id);
          this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
          this.render();
        } catch {
          // Mantém pendente localmente
        }
      }
      return;
    }

    if (formName === 'add-member-form') {
      if (!this.canManageCompanySettings()) return;
      if (!canCompanyManageMultiOperatorTeam(this.activeCompany)) {
        this.growthModalNotice = null;
        this.growthModalReason = 'team_access';
        this.render();
        return;
      }
      this.memberFormError = null;

      const displayName = String(fd.get('displayName') || '').trim();
      const email = String(fd.get('email') || '').trim().toLowerCase();
      const role = (fd.get('role') === 'manager' ? 'manager' : 'cashier') as CompanyRole;
      const allowInvoiceCancel = role === 'manager' && fd.get('allowInvoiceCancel') === 'on';

      if (!displayName || !email || !email.includes('@')) {
        this.memberFormError = 'Indique o nome e email válido do colaborador.';
        this.render();
        return;
      }

      if (this.members.some((m) => m.email.trim().toLowerCase() === email)) {
        this.memberFormError = 'Este email já faz parte da equipa desta empresa.';
        this.render();
        return;
      }

      const now = new Date().toISOString();
      const sanitizedEmailId = email.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      const member: CompanyMember = {
        id: `mem_${this.activeCompany.id}_${sanitizedEmailId}`,
        companyId: this.activeCompany.id,
        uid: `mem_${sanitizedEmailId}`,
        email,
        displayName,
        role,
        allowInvoiceCancel,
        active: true,
        createdAtIso: now,
        updatedAtIso: now,
      };

      await localDb.saveMember(member);
      this.members = [...this.members, member];
      form.reset();
      this.render();

      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          await upsertCompanyMemberCloud(this.activeCompany, member);
        } catch {
          // Mantém registado localmente
        }
      }
      return;
    }

    if (formName === 'pos-quick-customer-form') {
      if (this.isCompanySuspended()) {
        this.quickCustomerError = 'A empresa encontra-se suspensa.';
        this.render();
        return;
      }
      this.quickCustomerError = null;
      const name = String(fd.get('name') || this.quickCustomerDraft.name || '').trim();
      const nif = String(fd.get('nif') || this.quickCustomerDraft.nif || '').trim() || 'Consumidor Final';
      const phone = String(fd.get('phone') || this.quickCustomerDraft.phone || '').trim();
      const defaultLoc = this.activeCompany.profile.cityCountry || 'Angola';
      const locality =
        String(fd.get('locality') || this.quickCustomerDraft.locality || '').trim() || defaultLoc;
      const address =
        String(fd.get('address') || this.quickCustomerDraft.address || '').trim() || locality;

      if (!name) {
        this.quickCustomerError = 'Indique o nome completo ou designação da empresa.';
        this.render();
        return;
      }

      const now = new Date().toISOString();
      const rand = Math.random().toString(36).slice(2, 6);
      const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
      const created: Customer = {
        id: `cust_${Date.now()}_${rand}`,
        companyId: this.activeCompany.id,
        name,
        nif,
        phone,
        locality,
        address,
        syncState: 'pending',
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      try {
        await localDb.saveCustomer(created, this.activeCompany.id);
      } catch (err) {
        this.quickCustomerError = formatStorageErrorPt(err, 'o cliente');
        this.render();
        return;
      }

      this.customers = [created, ...this.customers.filter((c) => c.id !== created.id)].sort(
        (a, b) =>
          a.id === directCustId ? -1 : b.id === directCustId ? 1 : a.name.localeCompare(b.name, 'pt')
      );
      this.selectedCustomerId = created.id;
      this.selectedCustomerDetailId = created.id;
      this.quickCustomerDraft = { name: '', nif: '', phone: '', address: '', locality: defaultLoc };
      this.showQuickCustomerForm = false;
      this.showCustomerPicker = false;
      this.scheduleDraftSave();
      this.render();

      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          if (canCompanySyncCloudData(this.activeCompany)) {
            await upsertCustomerCloud(created, this.activeCompany);
            const synced: Customer = { ...created, syncState: 'synced', synced: true };
            await localDb.saveCustomer(synced, this.activeCompany.id);
            this.customers = this.customers.map((c) => (c.id === synced.id ? synced : c));
            this.render();
          }
        } catch {
          // Mantém pendente localmente
        }
      }
      return;
    }

    if (formName === 'product-form' && this.editingProduct) {
      if (!this.canManageCatalog()) {
        this.productFormError =
          'O seu perfil atual está em modo de consulta e não permite alterar o catálogo.';
        this.render();
        return;
      }
      this.productFormError = null;

      const editingId = this.editingProduct.id;
      const code = String(fd.get('code') || this.editingProduct.code || '').trim().slice(0, 32);
      const barcode = String(fd.get('barcode') ?? this.editingProduct.barcode ?? '')
        .trim()
        .slice(0, 48);
      const name = String(fd.get('name') || this.editingProduct.name || '').trim().slice(0, 160);
      const category =
        String(fd.get('category') || this.editingProduct.category || 'Mercearia')
          .trim()
          .slice(0, 48) || 'Mercearia';
      const unit =
        String(fd.get('unit') || this.editingProduct.unit || 'un').trim().slice(0, 12) || 'un';
      const rawCost = String(
        fd.get('costPrice') ?? this.editingProductCostInput ?? ''
      ).trim();
      const parsedCost = rawCost ? parseDecimalInput(rawCost) : 0;
      const rawPrice = String(fd.get('price') ?? this.editingProductPriceInput ?? '0');
      const parsedPrice = parseDecimalInput(rawPrice);
      const ivaRate: TaxRate = Number(fd.get('ivaRate')) === 0 ? 0 : 14;
      const rawExemptionReason = String(
        fd.get('exemptionReason') ?? this.editingProduct.exemptionReason ?? ''
      )
        .trim()
        .slice(0, 160);
      const active = fd.has('active') ? fd.get('active') === 'on' : this.editingProduct.active !== false;

      if (!code || !name) {
        this.productFormError = 'Preencha o código interno (SKU) e a descrição do artigo antes de guardar.';
        this.render();
        return;
      }

      if (
        this.products.some(
          (p) => p.id !== editingId && p.code.trim().toLowerCase() === code.toLowerCase()
        )
      ) {
        this.productFormError = `O código interno / SKU "${code}" já está atribuído a outro artigo.`;
        this.render();
        return;
      }

      if (
        barcode &&
        this.products.some(
          (p) =>
            p.id !== editingId &&
            ((p.barcode || '').trim().toLowerCase() === barcode.toLowerCase() ||
              p.code.trim().toLowerCase() === barcode.toLowerCase())
        )
      ) {
        this.productFormError = `O código de barras "${barcode}" já está registado noutro artigo.`;
        this.render();
        return;
      }

      if (rawCost && (Number.isNaN(parsedCost) || parsedCost < 0)) {
        this.productFormError = 'Indique um preço de aquisição válido em Kwanzas (ou deixe em branco).';
        this.render();
        return;
      }

      if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
        this.productFormError = 'Indique um preço de venda válido em Kwanzas (ex: 1500 ou 1500,50).';
        this.render();
        return;
      }

      const trackStock = fd.get('trackStock') === 'on';
      const rawStock = String(fd.get('stockQty') ?? this.editingProductStockInput ?? '0');
      const rawMinStock = String(fd.get('minStockQty') ?? this.editingProductMinStockInput ?? '0');
      const parsedStock = parseDecimalInput(rawStock);
      const parsedMinStock = parseDecimalInput(rawMinStock);

      const now = new Date().toISOString();
      const validCost = rawCost && parsedCost > 0 ? roundKz(parsedCost) : undefined;
      const finalPrice = roundKz(parsedPrice);

      const existingProd = this.products.find((p) => p.id === editingId);
      const actorLabel = (this.user?.email || formatRoleLabelPt(this.getEffectiveRole())).slice(
        0,
        120
      );
      let nextPriceHistory: ProductPriceChange[] | undefined = existingProd?.priceHistory
        ? [...existingProd.priceHistory]
        : this.editingProduct.priceHistory
          ? [...this.editingProduct.priceHistory]
          : undefined;

      if (existingProd && !this.isNewProduct) {
        const priceChanged = roundKz(existingProd.price) !== finalPrice;
        const prevCostVal =
          typeof existingProd.costPrice === 'number' && existingProd.costPrice > 0
            ? roundKz(existingProd.costPrice)
            : undefined;
        const costChanged = (prevCostVal ?? 0) !== (validCost ?? 0);

        if (priceChanged || costChanged) {
          const entry: ProductPriceChange = {
            changedAtIso: now,
            previousPrice: roundKz(existingProd.price),
            newPrice: finalPrice,
            ...(typeof prevCostVal === 'number' ? { previousCost: prevCostVal } : {}),
            ...(typeof validCost === 'number' ? { newCost: validCost } : {}),
            changedBy: actorLabel,
          };
          nextPriceHistory = [entry, ...(nextPriceHistory || [])].slice(0, 20);
        }
      }

      const {
        barcode: _oldBarcode,
        costPrice: _oldCost,
        priceHistory: _oldHistory,
        ...restEditingProduct
      } = this.editingProduct;
      void _oldBarcode;
      void _oldCost;
      void _oldHistory;

      const updated: Product = {
        ...restEditingProduct,
        companyId: this.activeCompany.id,
        code,
        ...(barcode ? { barcode } : {}),
        name,
        category,
        unit,
        ...(typeof validCost === 'number' ? { costPrice: validCost } : {}),
        price: finalPrice,
        ivaRate,
        exemptionReason:
          ivaRate === 0 ? rawExemptionReason || DEFAULT_IVA_EXEMPTION_REASONS[0] : '',
        active,
        trackStock,
        stockQty: trackStock && !Number.isNaN(parsedStock) ? roundKz(parsedStock) : 0,
        minStockQty:
          trackStock && !Number.isNaN(parsedMinStock) && parsedMinStock >= 0
            ? roundKz(parsedMinStock)
            : 0,
        ...(nextPriceHistory && nextPriceHistory.length > 0
          ? { priceHistory: nextPriceHistory }
          : {}),
        syncState: 'pending',
        synced: false,
        updatedAtIso: now,
      };

      const wasNew = this.isNewProduct;
      try {
        await localDb.saveProduct(updated, this.activeCompany.id);
      } catch (err) {
        this.productFormError = formatStorageErrorPt(err, 'o artigo');
        this.render();
        return;
      }

      this.products = [
        ...this.products.filter((p) => p.id !== updated.id),
        updated,
      ].sort((a, b) => a.code.localeCompare(b.code));
      this.selectedProductDetailId = updated.id;
      this.editingProduct = null;
      this.editingProductCostInput = '';
      this.editingProductMarkupInput = '';
      this.editingProductPriceInput = '';
      this.editingProductStockInput = '';
      this.editingProductMinStockInput = '';
      this.isNewProduct = false;
      this.productFormError = null;
      this.productSavedNotice = `Artigo "${updated.name}" guardado com sucesso.`;
      this.render();

      setTimeout(() => {
        if (this.productSavedNotice) {
          this.productSavedNotice = null;
          if (this.activeModule === 'PRODUCTS') this.render();
        }
      }, 2500);

      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          if (canCompanySyncCloudData(this.activeCompany)) {
            await upsertProductCloud(updated, wasNew, this.activeCompany);
            const synced: Product = { ...updated, syncState: 'synced', synced: true };
            await localDb.saveProduct(synced, this.activeCompany.id);
            this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
            this.render();
          }
        } catch {
          // Fica pendente para sync
        }
      }
      return;
    }

    if (formName === 'customer-form' && this.editingCustomer) {
      const isEditingExisting =
        !this.isNewCustomer && this.customers.some((c) => c.id === this.editingCustomer!.id);
      if (isEditingExisting && !this.canEditExistingCustomers()) {
        this.customerFormError =
          'O seu perfil atual não tem permissão para editar clientes existentes.';
        this.render();
        return;
      }
      if (this.isCompanySuspended()) {
        this.customerFormError = 'A empresa encontra-se suspensa.';
        this.render();
        return;
      }
      this.customerFormError = null;

      const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
      const isDirectCust = this.editingCustomer.id === directCustId;
      const name = String(fd.get('name') || this.editingCustomer.name || '').trim();
      const nif = isDirectCust
        ? 'Consumidor Final'
        : String(fd.get('nif') || this.editingCustomer.nif || '').trim() || 'Consumidor Final';
      const phone = String(fd.get('phone') || this.editingCustomer.phone || '').trim();
      const defaultLoc = this.activeCompany.profile.cityCountry || 'Angola';
      const locality =
        String(fd.get('locality') || this.editingCustomer.locality || '').trim() || defaultLoc;
      const address =
        String(fd.get('address') || this.editingCustomer.address || '').trim() || locality;
      const rawLimit = String(
        fd.get('creditLimit') ?? this.editingCustomerCreditLimitInput ?? ''
      ).trim();
      const parsedLimit = rawLimit ? parseDecimalInput(rawLimit) : 0;

      if (!name) {
        this.customerFormError = 'Indique o nome completo ou entidade do cliente.';
        this.render();
        return;
      }

      if (!isDirectCust && rawLimit && (Number.isNaN(parsedLimit) || parsedLimit < 0)) {
        this.customerFormError = 'Indique um limite de crédito válido em Kwanzas (ou deixe em branco).';
        this.render();
        return;
      }

      const creditLimit = !isDirectCust && parsedLimit > 0 ? roundKz(parsedLimit) : undefined;
      const { creditLimit: _prevLimit, ...restCustomer } = this.editingCustomer;
      void _prevLimit;

      const updated: Customer = {
        ...restCustomer,
        companyId: this.activeCompany.id,
        name,
        nif,
        phone,
        locality,
        address,
        ...(creditLimit ? { creditLimit } : {}),
        syncState: 'pending',
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      try {
        await localDb.saveCustomer(updated, this.activeCompany.id);
      } catch (err) {
        this.customerFormError = formatStorageErrorPt(err, 'o cliente');
        this.render();
        return;
      }

      this.customers = [
        ...this.customers.filter((c) => c.id !== updated.id),
        updated,
      ].sort((a, b) =>
        a.id === directCustId ? -1 : b.id === directCustId ? 1 : a.name.localeCompare(b.name, 'pt')
      );
      this.selectedCustomerDetailId = updated.id;
      this.editingCustomer = null;
      this.editingCustomerCreditLimitInput = '';
      this.isNewCustomer = false;
      this.customerFormError = null;
      this.customerSavedNotice = `Cliente "${updated.name}" guardado com sucesso.`;
      this.render();

      setTimeout(() => {
        if (this.customerSavedNotice) {
          this.customerSavedNotice = null;
          if (this.activeModule === 'CUSTOMERS') this.render();
        }
      }, 2500);

      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          if (canCompanySyncCloudData(this.activeCompany)) {
            await upsertCustomerCloud(updated, this.activeCompany);
            const synced: Customer = { ...updated, syncState: 'synced', synced: true };
            await localDb.saveCustomer(synced, this.activeCompany.id);
            this.customers = this.customers.map((c) => (c.id === synced.id ? synced : c));
            this.render();
          }
        } catch {
          // Fica pendente localmente
        }
      }
      return;
    }

    if (formName === 'settings-form') {
      if (!this.canManageCompanySettings()) return;
      const canCleanFooter = canCompanyHideViralFooter(this.activeCompany);
      const nextSettings: AppSettings = {
        companyId: this.activeCompany.id,
        company: {
          legalName: String(fd.get('legalName') || '').trim() || this.settings.company.legalName,
          shortName: String(fd.get('shortName') || '').trim() || this.settings.company.shortName,
          nif: String(fd.get('nif') || '').trim() || this.settings.company.nif,
          address: String(fd.get('address') || '').trim() || this.settings.company.address,
          cityCountry:
            String(fd.get('cityCountry') || '').trim() ||
            this.settings.company.cityCountry ||
            'Angola',
          phone: String(fd.get('phone') || '').trim(),
          email: String(fd.get('email') || '').trim(),
          tagline: String(fd.get('tagline') || '').trim(),
        },
        defaultCashier: String(fd.get('defaultCashier') || '01').trim() || '01',
        defaultOperator: String(fd.get('defaultOperator') || '001').trim() || '001',
        defaultDocType: fd.get('defaultDocType') === 'FP' ? 'FP' : 'FR',
        defaultFormat: fd.get('defaultFormat') === 'A4' ? 'A4' : 'POS',
        defaultNotes: String(fd.get('defaultNotes') || '').trim(),
        autoPrintOnEmit: fd.get('autoPrintOnEmit') === 'on',
        hidePromotionalFooter: canCleanFooter ? fd.get('hidePromotionalFooter') === 'on' : false,
        allowCashierPriceEdit: fd.get('allowCashierPriceEdit') === 'on',
        syncState: 'pending',
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      await this.persistSettings(nextSettings);
    }
  }

  private async persistSettings(nextSettings: AppSettings): Promise<void> {
    this.settingsErrorMessage = null;
    try {
      const updatedCompany = await localDb.saveSettings(nextSettings, this.activeCompany.id);
      this.activeCompany = updatedCompany;
      this.companies = this.companies.map((c) =>
        c.id === updatedCompany.id ? updatedCompany : c
      );
      this.settings = nextSettings;
      this.cashier = nextSettings.defaultCashier;
      this.operator = nextSettings.defaultOperator;
      this.docType = nextSettings.defaultDocType;
      this.notes = nextSettings.defaultNotes;
      this.settingsSavedNotice = true;
      if (typeof document !== 'undefined') {
        document.title = `SILA-Billing — ${nextSettings.company.shortName}`;
      }
      this.render();
    } catch (err) {
      this.settingsErrorMessage =
        err instanceof Error ? err.message : 'Erro ao validar o NIF da empresa.';
      this.render();
      return;
    }

    setTimeout(() => {
      this.settingsSavedNotice = false;
      if (this.activeModule === 'SETTINGS') this.render();
    }, 2000);

    if (this.user && this.isOnline) {
      try {
        await ensureCompanyRegisteredCloud(this.activeCompany, true);
        if (canCompanySyncCloudData(this.activeCompany)) {
          await upsertSettingsCloud(nextSettings, this.activeCompany);
          const synced: AppSettings = { ...nextSettings, syncState: 'synced', synced: true };
          const syncedCompany = await localDb.saveSettings(synced, this.activeCompany.id);
          this.activeCompany = syncedCompany;
          this.companies = this.companies.map((c) =>
            c.id === syncedCompany.id ? syncedCompany : c
          );
          this.settings = synced;
          this.render();
        }
      } catch {
        // Mantém pendente
      }
    }
  }

  private async emitCurrentInvoice(autoPrint: boolean): Promise<void> {
    if (this.cart.length === 0 || this.isEmitting || this.isCompanySuspended()) return;

    const previewDraft = this.buildLivePreviewInvoice();
    const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
    if (
      this.docType === 'FR' &&
      (previewDraft.amountDue || 0) > 0 &&
      this.selectedCustomerId === directCustId
    ) {
      this.showCustomerPicker = true;
      this.mobilePane = 'CART';
      this.showScannerFeedback(
        'Identifique ou cadastre o cliente para registar venda a crédito ou com pagamento parcial.',
        true
      );
      this.render();
      const searchInput = document.getElementById('pos-customer-search-input') as HTMLInputElement | null;
      searchInput?.focus();
      return;
    }

    const newDue = this.docType === 'FR' ? roundKz(previewDraft.amountDue || 0) : 0;
    if (newDue > 0 && this.selectedCustomerId !== directCustId) {
      const custObj = this.customers.find((c) => c.id === this.selectedCustomerId);
      const limit =
        custObj?.creditLimit && custObj.creditLimit > 0 ? roundKz(custObj.creditLimit) : 0;
      if (limit > 0) {
        const currentDebt = this.getCustomerOpenDebt(this.selectedCustomerId);
        const projectedDebt = roundKz(currentDebt + newDue);
        if (projectedDebt > limit) {
          const available = Math.max(0, roundKz(limit - currentDebt));
          this.mobilePane = 'CART';
          this.showScannerFeedback(
            `Limite de crédito excedido (${formatKzNumber(limit)} Kz). Plafond disponível: ${formatKzNumber(available)} Kz.`,
            true
          );
          this.render();
          return;
        }
      }
    }

    if (!hasPaidCommercialEntitlement(this.activeCompany)) {
      const usage = this.getMonthlyInvoiceUsage();
      if (usage.usedCount >= usage.effectiveLimit) {
        this.growthModalNotice = null;
        this.growthModalReason = 'monthly_limit';
        this.render();
        return;
      }
    }

    this.isEmitting = true;
    this.render();

    try {
      const draft = previewDraft;
      const now = new Date().toISOString();
      const originReturnId = this.returnOriginInvoice?.id || null;
      const openSession = this.getActiveOpenCashSession();
      const invoice: InvoiceRecord = {
        ...draft,
        id: `inv_${Date.now()}`,
        companyId: this.activeCompany.id,
        cashier: openSession ? openSession.cashier : draft.cashier,
        operator: openSession ? openSession.operator : draft.operator,
        ...(draft.docType === 'FR'
          ? {
              ...(openSession ? { sessionId: openSession.id } : {}),
              initialAmountReceived: draft.amountReceived,
              initialChangeAmount: draft.changeAmount,
            }
          : {}),
        issuedAtIso: now,
        syncState: 'pending',
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      await localDb.saveInvoice(invoice, this.activeCompany.id);
      if (invoice.docType === 'FR') {
        if (originReturnId) {
          const originInv = this.invoices.find((i) => i.id === originReturnId);
          if (originInv && originInv.docType === 'FR') {
            await this.adjustCatalogStockForInvoiceLines(originInv.lines, 'RESTORE');
          }
        }
        await this.adjustCatalogStockForInvoiceLines(invoice.lines, 'DEDUCT');
      }

      if (!this.activeCompany.maxObservedIso || now > this.activeCompany.maxObservedIso) {
        const trackedCompany: CompanyRecord = {
          ...this.activeCompany,
          maxObservedIso: now,
          updatedAtIso: now,
        };
        await localDb.saveCompany(trackedCompany);
        this.activeCompany = trackedCompany;
        this.companies = this.companies.map((c) =>
          c.id === trackedCompany.id ? trackedCompany : c
        );
      }

      this.invoices = [invoice, ...this.invoices];
      this.selectedHistoryId = invoice.id;
      this.lastEmitted = invoice;
      this.cart = [];
      this.globalDiscountPct = 0;
      this.globalDiscountInput = '';
      this.amountReceivedInput = '';
      this.transferReference = '';
      this.splitInputs = { Dinheiro: '', Multicaixa: '', Transferência: '' };
      this.returnOriginInvoice = null;
      this.confirmClearCart = false;
      this.confirmRemoveCartProductId = null;
      this.notes = this.settings.defaultNotes || 'Venda directa a retalho.';
      this.mobilePane = 'PREVIEW';
      await this.flushDraftNow();
      this.render();

      // Sincronização Cloud + Auditoria Backend (/api/audit/invoices) quando online e autenticado
      if (this.user && this.isOnline) {
        try {
          await ensureCompanyRegisteredCloud(this.activeCompany);
          if (canCompanySyncCloudData(this.activeCompany)) {
            await createInvoiceCloud(invoice, this.activeCompany);
            const syncedInv: InvoiceRecord = { ...invoice, syncState: 'synced', synced: true };
            await localDb.saveInvoice(syncedInv, this.activeCompany.id);
            this.invoices = this.invoices.map((i) => (i.id === syncedInv.id ? syncedInv : i));
            this.lastEmitted = syncedInv;

            const auditRes = await submitInvoiceAudit(syncedInv, this.activeCompany.id);
            if (auditRes.ok && auditRes.auditHash) {
              this.lastAuditHash = auditRes.auditHash.slice(0, 12);
            }
            this.render();
          }
        } catch {
          // Guardada localmente para sincronização posterior
        }
      }

      if (autoPrint) {
        await this.triggerPrint(invoice, this.previewFormat);
      }
    } finally {
      this.isEmitting = false;
      this.render();
    }
  }

  private async syncAllWithCloud(manualTrigger = false): Promise<void> {
    if (!this.user || !this.isOnline || this.isSyncing) return;
    this.isSyncing = true;
    this.syncMessage = null;
    this.render();

    try {
      // 1. Descobre empresas da conta autenticada na Cloud e sincroniza eventuais ativações de planos comerciais
      const ownedCloudCompanies = await pullOwnedCompaniesFromCloud();
      for (const cloudComp of ownedCloudCompanies) {
        const localExisting = this.companies.find(
          (c) => c.id === cloudComp.id || c.normalizedNif === cloudComp.normalizedNif
        );
        if (!localExisting) {
          await localDb.saveCompany(cloudComp);
        } else {
          const mergedComp: CompanyRecord = {
            ...localExisting,
            status: cloudComp.status,
            plan: cloudComp.plan,
            allowManagerCancel: cloudComp.allowManagerCancel,
            ownerUid: cloudComp.ownerUid,
            ownerEmail: cloudComp.ownerEmail,
            syncState: 'synced',
            synced: true,
          };
          await localDb.saveCompany(mergedComp);
          if (this.activeCompany.id === mergedComp.id) {
            this.activeCompany = mergedComp;
          }
        }
      }

      if (!this.activeCompany.id || this.requiresCompanyOnboarding) {
        if (ownedCloudCompanies.length > 0) {
          const recovered = await loadCompanyWorkspace(
            ownedCloudCompanies[0]!.id,
            this.getViewerIdentity()
          );
          this.applyWorkspaceBundle(recovered);
        } else {
          this.syncMessage =
            'Nenhuma empresa registada na Cloud para esta conta. Cadastre a sua empresa para iniciar.';
          return;
        }
      }

      const isSupportInspection =
        Boolean(this.supportCompanyId && this.supportCompanyId === this.activeCompany.id) &&
        isPlatformAdminEmail(this.user.email) &&
        this.activeCompany.ownerUid !== this.user.uid;

      if (!isSupportInspection) {
        // 2. Regista/atualiza sempre a identidade leve da empresa e NIF único no Firestore
        await ensureCompanyRegisteredCloud(this.activeCompany, !this.activeCompany.synced);
        const canClaimCompanyOwnership =
          this.activeCompany.id !== JAIMONA_COMPANY_ID || isJaimonaOwnerEmail(this.user.email);
        if (!this.activeCompany.synced && canClaimCompanyOwnership) {
          const markedComp: CompanyRecord = {
            ...this.activeCompany,
            ownerUid: this.activeCompany.ownerUid || this.user.uid,
            ownerEmail:
              this.activeCompany.id === JAIMONA_COMPANY_ID
                ? JAIMONA_OWNER_EMAIL
                : this.activeCompany.ownerEmail || this.user.email || undefined,
            syncState: 'synced',
            synced: true,
          };
          await localDb.saveCompany(markedComp);
          this.activeCompany = markedComp;
        }
      }

      // Empresas em plano Base Orgânico (FREE) ou Essencial (1.000 Kz) operam com base de dados 100% local (custo zero de subcoleções Cloud)
      if (!isSupportInspection && !canCompanySyncCloudData(this.activeCompany)) {
        const refreshedLocal = await loadCompanyWorkspace(
          this.activeCompany.id,
          this.getViewerIdentity()
        );
        this.activeCompany = refreshedLocal.activeCompany;
        this.companies = refreshedLocal.companies;
        this.members = refreshedLocal.members;
        this.lastSyncedIso = new Date().toISOString();
        await this.refreshBackendHealth();

        if (manualTrigger) {
          if (this.activeCompany.plan.planTier === 'ESSENCIAL') {
            this.syncMessage =
              'Licença Essencial verificada — faturação local ilimitada ativa neste dispositivo. Para backup automático na Cloud, conheça o Plano Cloud Profissional.';
          } else {
            this.growthModalNotice = null;
            this.growthModalReason = 'cloud_protection';
          }
        }
        return;
      }

      if (!isSupportInspection) {
        // 3. Envia registos pendentes da empresa ativa (apenas planos Cloud Profissional / Enterprise / JAIMONA)
        const unsyncedProducts = this.products.filter((p) => !p.synced);
        for (const prod of unsyncedProducts) {
          try {
            await upsertProductCloud(prod, true, this.activeCompany);
            await localDb.saveProduct(
              { ...prod, syncState: 'synced', synced: true, syncError: undefined },
              this.activeCompany.id
            );
          } catch (itemErr) {
            await localDb.saveProduct(
              {
                ...prod,
                syncState: 'error',
                synced: false,
                syncError: itemErr instanceof Error ? itemErr.message : 'Erro de sincronização',
              },
              this.activeCompany.id
            );
          }
        }

        const unsyncedCustomers = this.customers.filter((c) => !c.synced);
        for (const cust of unsyncedCustomers) {
          try {
            await upsertCustomerCloud(cust, this.activeCompany);
            await localDb.saveCustomer(
              { ...cust, syncState: 'synced', synced: true, syncError: undefined },
              this.activeCompany.id
            );
          } catch (itemErr) {
            await localDb.saveCustomer(
              {
                ...cust,
                syncState: 'error',
                synced: false,
                syncError: itemErr instanceof Error ? itemErr.message : 'Erro de sincronização',
              },
              this.activeCompany.id
            );
          }
        }

        const unsyncedInvoices = this.invoices.filter((i) => !i.synced);
        for (const inv of unsyncedInvoices) {
          try {
            await createInvoiceCloud(inv, this.activeCompany);
            if (inv.status === 'cancelled' && inv.cancelReason) {
              await cancelInvoiceCloud(inv.id, inv.cancelReason, this.activeCompany.id, this.activeCompany);
            }
            await submitInvoiceAudit(inv, this.activeCompany.id).catch(() => null);
            await localDb.saveInvoice(
              { ...inv, syncState: 'synced', synced: true, syncError: undefined },
              this.activeCompany.id
            );
          } catch (itemErr) {
            await localDb.saveInvoice(
              {
                ...inv,
                syncState: 'error',
                synced: false,
                syncError: itemErr instanceof Error ? itemErr.message : 'Erro de sincronização',
              },
              this.activeCompany.id
            );
          }
        }

        const unsyncedCashSessions = this.cashSessions.filter((s) => !s.synced);
        for (const sess of unsyncedCashSessions) {
          try {
            await upsertCashSessionCloud(sess, this.activeCompany);
            await localDb.saveCashSession(
              { ...sess, syncState: 'synced', synced: true, syncError: undefined },
              this.activeCompany.id
            );
          } catch (itemErr) {
            await localDb.saveCashSession(
              {
                ...sess,
                syncState: 'error',
                synced: false,
                syncError: itemErr instanceof Error ? itemErr.message : 'Erro de sincronização',
              },
              this.activeCompany.id
            );
          }
        }

        const unsyncedCashMovements = this.cashMovements.filter((m) => !m.synced);
        for (const mov of unsyncedCashMovements) {
          try {
            await createCashMovementCloud(mov, this.activeCompany);
            await localDb.saveCashMovement(
              { ...mov, syncState: 'synced', synced: true, syncError: undefined },
              this.activeCompany.id
            );
          } catch (itemErr) {
            await localDb.saveCashMovement(
              {
                ...mov,
                syncState: 'error',
                synced: false,
                syncError: itemErr instanceof Error ? itemErr.message : 'Erro de sincronização',
              },
              this.activeCompany.id
            );
          }
        }

        if (!this.settings.synced && this.canManageCompanySettings()) {
          await upsertSettingsCloud(this.settings, this.activeCompany);
          const syncedSettings: AppSettings = {
            ...this.settings,
            syncState: 'synced',
            synced: true,
          };
          await localDb.saveSettings(syncedSettings, this.activeCompany.id);
        }
      }

      // 4. Descarrega dados atualizados da empresa ativa (Admin SDK em modo suporte/membro ou Firestore direto para proprietário)
      const cloudData = isSupportInspection
        ? await fetchCompanyWorkspaceBackend(this.activeCompany.id)
        : (await pullCompanyFromCloud(this.activeCompany.id)) ||
          (await fetchCompanyWorkspaceBackend(this.activeCompany.id));
      if (cloudData) {
        // Proteção estrita: nunca sobrescrever registos locais ainda pendentes de sincronização
        const preMergeLocal = await loadCompanyWorkspace(
          this.activeCompany.id,
          this.getViewerIdentity()
        );
        const pendingProdIds = new Set(
          preMergeLocal.products.filter((p) => !p.synced).map((p) => p.id)
        );
        const pendingCustIds = new Set(
          preMergeLocal.customers.filter((c) => !c.synced).map((c) => c.id)
        );
        const pendingInvIds = new Set(
          preMergeLocal.invoices.filter((i) => !i.synced).map((i) => i.id)
        );
        const pendingSessIds = new Set(
          preMergeLocal.cashSessions.filter((s) => !s.synced).map((s) => s.id)
        );
        const pendingMovIds = new Set(
          preMergeLocal.cashMovements.filter((m) => !m.synced).map((m) => m.id)
        );

        for (const cp of cloudData.products) {
          if (!pendingProdIds.has(cp.id)) {
            await localDb.saveProduct(cp, this.activeCompany.id);
          }
        }
        for (const cc of cloudData.customers) {
          if (!pendingCustIds.has(cc.id)) {
            await localDb.saveCustomer(cc, this.activeCompany.id);
          }
        }
        for (const ci of cloudData.invoices) {
          if (!pendingInvIds.has(ci.id)) {
            await localDb.saveInvoice(ci, this.activeCompany.id);
          }
        }
        for (const cs of cloudData.cashSessions || []) {
          if (!pendingSessIds.has(cs.id)) {
            await localDb.saveCashSession(cs, this.activeCompany.id);
          }
        }
        for (const cm of cloudData.cashMovements || []) {
          if (!pendingMovIds.has(cm.id)) {
            await localDb.saveCashMovement(cm, this.activeCompany.id);
          }
        }
        if (cloudData.settings && preMergeLocal.settings.synced !== false) {
          await localDb.saveSettings(cloudData.settings, this.activeCompany.id).catch(() => null);
        }
      }

      const refreshed = await loadCompanyWorkspace(
        this.activeCompany.id,
        this.getViewerIdentity()
      );
      this.products = refreshed.products;
      this.customers = refreshed.customers;
      this.invoices = refreshed.invoices;
      this.cashSessions = refreshed.cashSessions;
      this.cashMovements = refreshed.cashMovements;
      this.settings = refreshed.settings;
      this.activeCompany = refreshed.activeCompany;
      this.companies = refreshed.companies;
      this.requiresCompanyOnboarding = Boolean(
        refreshed.requiresCompanyOnboarding || !refreshed.activeCompany.id
      );
      this.members = refreshed.members;

      this.lastSyncedIso = new Date().toISOString();
      await this.refreshBackendHealth();
    } catch (err) {
      this.syncMessage =
        err instanceof Error ? err.message : 'Erro ao sincronizar com o Firestore.';
    } finally {
      this.isSyncing = false;
      this.render();
    }
  }

  private exportLocalJsonBackup(): void {
    const bundle = {
      schemaVersion: '2.0.0-multicompany',
      source: 'indexeddb-local',
      exportedAtIso: new Date().toISOString(),
      companyId: this.activeCompany.id,
      company: this.settings.company,
      counts: {
        products: this.products.length,
        customers: this.customers.length,
        invoices: this.invoices.length,
        cashSessions: this.cashSessions.length,
        cashMovements: this.cashMovements.length,
      },
      data: {
        companyRecord: this.activeCompany,
        members: this.members,
        settings: this.settings,
        products: this.products,
        customers: this.customers,
        invoices: this.invoices,
        cashSessions: this.cashSessions,
        cashMovements: this.cashMovements,
      },
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sila-billing-${this.activeCompany.id}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private async triggerPrint(invoice: InvoiceRecord, format: DocumentFormat): Promise<void> {
    this.isPrinting = true;
    const qr = await this.ensureQrForInvoice(invoice);
    document.body.setAttribute('data-print-mode', format);
    this.cashPrintJob = null;
    this.printJob = { invoice, format, qr };
    this.render();
    setTimeout(() => {
      try {
        window.print();
      } finally {
        setTimeout(() => {
          this.isPrinting = false;
        }, 1200);
      }
    }, 100);
  }

  private renderPreservingFocus(elementId: string, selectionStart: number | null): void {
    this.render();
    if (!elementId) return;
    const nextEl = document.getElementById(elementId) as HTMLInputElement | null;
    if (nextEl) {
      nextEl.focus();
      if (selectionStart !== null && nextEl.type === 'text') {
        try {
          nextEl.setSelectionRange(selectionStart, selectionStart);
        } catch {
          // Ignore selection range on unsupported inputs
        }
      }
    }
  }

  private renderPreservingInputValue(
    elementId: string,
    rawValue: string,
    selectionStart: number | null
  ): void {
    this.render();
    if (!elementId) return;
    const nextEl = document.getElementById(elementId) as HTMLInputElement | null;
    if (nextEl) {
      nextEl.value = rawValue;
      nextEl.focus();
      if (selectionStart !== null) {
        try {
          nextEl.setSelectionRange(selectionStart, selectionStart);
        } catch {
          // Ignore selection range on unsupported inputs
        }
      }
    }
  }

  // ==================== RENDERIZAÇÃO MODULAR VANILLA JS ====================

  private render(): void {
    const isUnassigned = this.requiresCompanyOnboarding || !this.activeCompany.id;
    const cloudSyncEntitled = !isUnassigned && canCompanySyncCloudData(this.activeCompany);
    const pendingCount = !cloudSyncEntitled
      ? 0
      : this.products.filter((p) => !p.synced).length +
        this.customers.filter((c) => !c.synced).length +
        this.invoices.filter((i) => !i.synced).length +
        this.cashSessions.filter((s) => !s.synced).length +
        this.cashMovements.filter((m) => !m.synced).length +
        (this.settings.synced ? 0 : 1);

    const canInstall = !this.isInstalled && (Boolean(this.deferredPrompt) || this.isIOS);
    const effectiveRole = this.getEffectiveRole();
    const cancellingInvoice = this.cancellingInvoiceId
      ? this.invoices.find((i) => i.id === this.cancellingInvoiceId) || null
      : null;
    const showViralFooter = shouldShowViralDocumentFooter(this.activeCompany, this.settings);
    const monthlyUsage = isUnassigned ? null : this.getMonthlyInvoiceUsage();

    this.root.innerHTML = `
      <div class="no-print h-dvh w-screen flex flex-col overflow-hidden bg-slate-50 text-slate-900">
        <!-- Top Bar Limpa (3 Zonas) com suporte a Safe Area em iPhone / iPad Standalone -->
        <header class="min-h-12 py-1.5 px-3 safe-area-top bg-slate-900 text-white border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-action="toggle-sidebar"
              title="Alternar aba esquerda (Expandida / Ícones / 100% Oculta)"
              class="h-9 w-9 flex items-center justify-center rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            >
              ${this.sidebarState === 'HIDDEN' ? ICONS.panelOpen : ICONS.panelClose}
            </button>
            <span class="text-sm font-bold tracking-tight whitespace-nowrap">SILA-Billing</span>
            <button
              type="button"
              data-action="open-master-admin"
              aria-label="Administração SILA-Billing"
              class="h-2.5 w-2.5 rounded-sm bg-emerald-600 hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 transition-colors shrink-0 ml-0.5"
            ></button>
          </div>

          <div data-company-switcher-zone class="relative flex items-center min-w-0">
            ${
              isUnassigned
                ? `<button
                    type="button"
                    data-action="open-new-company-modal"
                    class="h-8 px-3 rounded-md bg-blue-600 hover:bg-blue-700 text-xs font-semibold text-white flex items-center gap-1.5 transition-colors whitespace-nowrap"
                  >
                    ${ICONS.plus}
                    <span>Cadastrar Empresa</span>
                  </button>`
                : `<button
                    type="button"
                    data-action="toggle-company-dropdown"
                    class="h-8 px-2.5 rounded-md hover:bg-slate-800 text-xs text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors max-w-[240px] sm:max-w-xs md:max-w-md"
                  >
                    <span class="font-medium text-white truncate">${escapeHtml(this.settings.company.shortName)}</span>
                    <span aria-hidden="true" class="text-slate-500 hidden sm:inline">·</span>
                    <span class="font-mono tabular-nums text-slate-400 hidden sm:inline shrink-0">NIF ${escapeHtml(this.settings.company.nif)}</span>
                    ${
                      this.isCompanySuspended()
                        ? `<span class="text-[10px] text-red-400 font-medium shrink-0">· Suspensa</span>`
                        : ''
                    }
                    <span class="text-slate-400 shrink-0">${this.showCompanyDropdown ? ICONS.chevronUp : ICONS.chevronDown}</span>
                  </button>`
            }

            ${
              this.showCompanyDropdown
                ? renderCompanySwitcherDropdown({
                    activeCompany: this.activeCompany,
                    companies: this.companies,
                    effectiveRole,
                  })
                : ''
            }
          </div>

          <div class="flex items-center gap-2 shrink-0">
            ${
              canInstall
                ? `<button
                    type="button"
                    data-action="install-pwa"
                    class="h-8 px-2.5 rounded-md bg-blue-600 hover:bg-blue-700 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${this.isIOS && !this.deferredPrompt ? ICONS.iosShare : ICONS.download}
                    <span>Instalar</span>
                  </button>`
                : `<button
                    type="button"
                    data-action="nav"
                    data-value="SYNC"
                    class="h-8 px-2.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap tabular-nums"
                  >
                    <span class="${this.isOnline ? 'text-emerald-400' : 'text-amber-400'}">
                      ${this.isOnline ? ICONS.cloud : ICONS.cloudOff}
                    </span>
                    <span>${this.isOnline ? (this.user ? 'Cloud' : 'Local') : 'Offline'}</span>
                  </button>`
            }
          </div>
        </header>
        ${this.renderIOSInstallBanner()}

        <!-- Área Principal com Aba Esquerda 100% Recolhível -->
        <div class="flex-1 flex overflow-hidden">
          ${this.renderSidebar(pendingCount)}

          <main class="flex-1 overflow-hidden flex flex-col">
            ${
              this.dbBootError
                ? `<div class="px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 flex items-center justify-between gap-2 shrink-0">
                    <span>${escapeHtml(this.dbBootError)}</span>
                    <button
                      type="button"
                      data-action="retry-db-boot"
                      class="h-7 px-2.5 rounded bg-red-600 text-white font-semibold hover:bg-red-700 whitespace-nowrap shrink-0"
                    >Tentar novamente</button>
                  </div>`
                : ''
            }
            <div class="flex-1 overflow-hidden">
              ${this.isBooting ? this.renderBooting() : this.renderActiveWorkspace()}
            </div>
          </main>
        </div>

        ${this.showIOSGuide ? this.renderIOSModal() : ''}
        ${
          this.showNewCompanyModal
            ? renderNewCompanyModal({
                errorMessage: this.newCompanyError,
                isSubmitting: this.isCreatingCompany,
                isSignedIn: Boolean(this.user),
              })
            : ''
        }
        ${
          cancellingInvoice
            ? renderCancelInvoiceModal({
                invoice: cancellingInvoice,
                errorMessage: this.cancelInvoiceError,
              })
            : ''
        }
        ${
          this.growthModalReason && !isUnassigned && monthlyUsage
            ? renderFriendlyGrowthModal({
                reason: this.growthModalReason,
                company: this.activeCompany,
                monthlyUsed: monthlyUsage.usedCount,
                monthlyLimit: monthlyUsage.effectiveLimit,
                canActivateCourtesy: !monthlyUsage.courtesyActive,
                isSignedIn: Boolean(this.user),
                isOnline: this.isOnline,
                isVerifyingPlan: this.isVerifyingPlan,
                copiedIbanFeedback: this.copiedIbanFeedback,
                noticeMessage: this.growthModalNotice,
              })
            : ''
        }
        ${
          this.showMasterAdminModal
            ? renderMasterAdminModal({
                isSignedIn: Boolean(this.user),
                isAuthenticating: this.isAuthenticatingAdmin,
                userEmail: this.user?.email || '',
                isLoading: this.masterAdminLoading,
                accessDenied: this.masterAdminDenied,
                errorMessage: this.masterAdminError,
                searchQuery: this.masterAdminSearch,
                mergedCompanies: this.getMergedAdminCompanies(),
                recentLogs: this.adminAuditLogs,
                activeCompanyId: this.activeCompany.id,
              })
            : ''
        }
      </div>

      ${
        this.printJob
          ? `<div class="hidden print-only-container">
              ${renderDocumentHtml(
                this.printJob.invoice,
                this.printJob.format,
                this.settings.company,
                this.printJob.qr,
                this.getInvoiceRenderOptions(this.printJob.invoice, showViralFooter)
              )}
            </div>`
          : this.cashPrintJob
            ? `<div class="hidden print-only-container">
                ${renderCashClosureReportHtml(
                  this.cashPrintJob.session,
                  this.cashPrintJob.summary,
                  this.cashMovements,
                  this.settings.company,
                  this.cashPrintJob.format,
                  showViralFooter
                )}
              </div>`
            : ''
      }
    `;
  }

  private renderBooting(): string {
    return `
      <div class="h-full flex items-center justify-center text-xs text-slate-500">
        A inicializar base local IndexedDB...
      </div>
    `;
  }

  private renderSidebar(pendingCount: number): string {
    if (this.sidebarState === 'HIDDEN') return '';

    const expanded = this.sidebarState === 'EXPANDED';

    const primaryItems: Array<{ id: ActiveModule; label: string; icon: string }> = [
      { id: 'NEW_POS', label: 'Nova fatura POS', icon: ICONS.receipt },
      { id: 'NEW_A4', label: 'Nova fatura A4', icon: ICONS.fileA4 },
      { id: 'CASH', label: 'Caixa e pagamentos', icon: ICONS.wallet },
      { id: 'CUSTOMERS', label: 'Clientes', icon: ICONS.users },
      { id: 'PRODUCTS', label: 'Produtos e serviços', icon: ICONS.package },
      { id: 'HISTORY', label: 'Histórico de faturas', icon: ICONS.history },
    ];

    const bottomItems: Array<{ id: ActiveModule; label: string; icon: string; badge?: number }> = [
      { id: 'SETTINGS', label: 'Configurações', icon: ICONS.settings },
      {
        id: 'SYNC',
        label: this.isOnline ? 'Sincronização / estado offline' : 'Modo offline ativo',
        icon: this.isOnline ? ICONS.cloud : ICONS.cloudOff,
        badge: pendingCount > 0 ? pendingCount : undefined,
      },
    ];

    return `
      <aside
        aria-label="Navegação principal"
        class="bg-slate-900 text-slate-300 border-r border-slate-800 flex flex-col justify-between shrink-0 select-none ${
          expanded ? 'w-56' : 'w-14'
        }"
      >
        <nav class="p-1.5 space-y-1 overflow-y-auto">
          ${primaryItems
            .map((item) => {
              const active = this.activeModule === item.id;
              return `
                <button
                  type="button"
                  data-action="nav"
                  data-value="${item.id}"
                  title="${escapeHtml(item.label)}"
                  class="w-full min-h-[42px] px-2.5 rounded-md flex items-center gap-3 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  } ${expanded ? 'justify-start' : 'justify-center'}"
                >
                  ${item.icon}
                  ${expanded ? `<span class="truncate">${escapeHtml(item.label)}</span>` : ''}
                </button>
              `;
            })
            .join('')}
        </nav>

        <div class="p-1.5 border-t border-slate-800 space-y-1">
          ${bottomItems
            .map((item) => {
              const active = this.activeModule === item.id;
              return `
                <button
                  type="button"
                  data-action="nav"
                  data-value="${item.id}"
                  title="${escapeHtml(item.label)}"
                  class="w-full min-h-[42px] px-2.5 rounded-md flex items-center justify-between gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-600 text-white'
                      : 'text-slate-400 hover:text-white hover:bg-slate-800'
                  } ${expanded ? '' : 'justify-center'}"
                >
                  <span class="flex items-center gap-3 min-w-0">
                    ${item.icon}
                    ${expanded ? `<span class="truncate">${escapeHtml(item.label)}</span>` : ''}
                  </span>
                  ${
                    expanded && item.badge
                      ? `<span class="text-[10px] font-mono tabular-nums text-slate-400 shrink-0">${item.badge}</span>`
                      : ''
                  }
                </button>
              `;
            })
            .join('')}

          <div class="pt-1 border-t border-slate-800/80 flex items-center gap-1">
            <button
              type="button"
              data-action="compact-sidebar"
              title="${expanded ? 'Apenas ícones' : 'Expandir legendas'}"
              class="flex-1 h-8 rounded-md text-[11px] text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center whitespace-nowrap"
            >
              ${expanded ? '« Compactar' : '»'}
            </button>
            ${
              expanded
                ? `<button
                    type="button"
                    data-action="hide-sidebar"
                    title="Ocultar 100% a aba esquerda"
                    class="h-8 w-8 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center shrink-0"
                  >
                    ${ICONS.close}
                  </button>`
                : ''
            }
          </div>
        </div>
      </aside>
    `;
  }

  private renderActiveWorkspace(): string {
    if (
      (this.requiresCompanyOnboarding || !this.activeCompany.id) &&
      this.activeModule !== 'SYNC'
    ) {
      return renderTenantOnboardingView({
        userEmail: this.user?.email || '',
        isSignedIn: Boolean(this.user),
        isOnline: this.isOnline,
        isSyncing: this.isSyncing,
        syncMessage: this.syncMessage,
      });
    }

    switch (this.activeModule) {
      case 'NEW_POS':
      case 'NEW_A4':
        return this.renderPosWorkspace();
      case 'CASH':
        return this.renderCashWorkspace();
      case 'CUSTOMERS':
        return this.renderCustomersWorkspace();
      case 'PRODUCTS':
        return this.renderProductsWorkspace();
      case 'HISTORY':
        return this.renderHistoryWorkspace();
      case 'SETTINGS':
        return this.renderSettingsWorkspace();
      case 'SYNC':
        return this.renderSyncWorkspace();
    }
  }

  // ==================== 1, 2 & 3. ÁREA DE FATURAÇÃO UNIFICADA POS & A4 ====================

  private renderPosWorkspace(): string {
    const activeProducts = this.products.filter((p) => p.active);

    // Contagem por categoria para os seletores compactos
    const categoryCounts = new Map<string, number>();
    for (const p of activeProducts) {
      const cat = (p.category || 'Geral').trim() || 'Geral';
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }
    const orderedCategories = Array.from(categoryCounts.keys()).sort((a, b) =>
      a.localeCompare(b, 'pt')
    );

    const posSearchResult = this.getPosProductSearchResult();
    const visibleProducts = posSearchResult.matches;
    const posSuggestions = posSearchResult.suggestions;

    const totals = calculateInvoiceTotals(this.cart, this.globalDiscountPct);
    const liveInvoice = this.buildLivePreviewInvoice();
    const cartCount = roundKz(this.cart.reduce((acc, c) => c.qty + acc, 0));

    const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
    const defaultLocality = this.activeCompany.profile.cityCountry || 'Angola';
    const isSuspended = this.isCompanySuspended();
    const canManageCat = this.canManageCatalog();
    const canEditPrice = this.canEditCartUnitPrice();

    const selectedCustomer =
      this.customers.find((c) => c.id === this.selectedCustomerId) ||
      this.customers[0] || {
        id: directCustId,
        name: 'Cliente de Venda Directa',
        nif: 'Consumidor Final',
        locality: defaultLocality,
      };
    const selectedCustomerOpenDebt =
      selectedCustomer.id !== directCustId ? this.getCustomerOpenDebt(selectedCustomer.id) : 0;

    const matchingCustomers = filterCustomersSmart(this.customers, this.posCustomerSearch);

    const cacheKey = `${liveInvoice.number}|${liveInvoice.grandTotal.toFixed(2)}|${this.settings.company.nif}`;
    const cachedQr = this.qrCache.get(cacheKey) || '';
    if (liveInvoice.lines.length > 0 && !cachedQr) {
      this.ensureQrForInvoice(liveInvoice);
    }

    const isA4 = this.previewFormat === 'A4';
    const returnCreditApplied = liveInvoice.returnCreditApplied || 0;
    const netPayable = Math.max(0, roundKz(totals.grandTotal - returnCreditApplied));
    const renderProductStockMeta = (prod: Product): string => {
      if (!prod.trackStock) return '';
      const qty = prod.stockQty ?? 0;
      const minQty = prod.minStockQty ?? 0;
      if (qty <= 0) {
        return `<span class="text-[10px] font-mono tabular-nums text-red-600 font-semibold shrink-0">Sem stock (0)</span>`;
      }
      if (qty <= minQty) {
        return `<span class="text-[10px] font-mono tabular-nums text-amber-700 font-medium shrink-0">Baixo · ${qty} ${escapeHtml(prod.unit)}</span>`;
      }
      return `<span class="text-[10px] font-mono tabular-nums text-slate-500 shrink-0">Stock: ${qty} ${escapeHtml(prod.unit)}</span>`;
    };

    return `
      <div class="flex h-full flex-col overflow-hidden">
        <!-- Seletor Mobile -->
        <div class="flex lg:hidden items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5 shrink-0">
          <button
            type="button"
            data-action="mobile-pane"
            data-value="CATALOG"
            class="flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              this.mobilePane === 'CATALOG' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }"
          >
            Artigos
          </button>
          <button
            type="button"
            data-action="mobile-pane"
            data-value="CART"
            class="flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap tabular-nums ${
              this.mobilePane === 'CART' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }"
          >
            Fatura (${this.cart.length})
          </button>
          <button
            type="button"
            data-action="mobile-pane"
            data-value="PREVIEW"
            class="flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
              this.mobilePane === 'PREVIEW' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
            }"
          >
            ${isA4 ? 'Fatura A4' : 'Talão POS'}
          </button>
        </div>

        <div class="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          <!-- COLUNA 1: Pesquisa Rápida, Stock & Cadastro Rápido de Artigo -->
          <section class="${isA4 ? 'lg:col-span-4' : 'lg:col-span-5'} flex flex-col border-r border-slate-200 bg-slate-50/60 overflow-hidden ${
            this.mobilePane === 'CATALOG' ? 'flex' : 'hidden lg:flex'
          }">
            <div class="p-3 border-b border-slate-200 bg-white space-y-2 shrink-0">
              <!-- Pesquisa rápida + filtro fiscal + stock + cadastro rápido -->
              <div class="flex items-center gap-1.5">
                <div class="relative flex-1 min-w-0">
                  <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                  <input
                    id="pos-search-input"
                    type="text"
                    autocomplete="off"
                    data-field="pos-search"
                    value="${escapeHtml(this.posSearch)}"
                    placeholder="Código, artigo ou leitor de barras (F2)..."
                    class="w-full h-10 pl-9 ${this.posSearch ? 'pr-8' : 'pr-3'} text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                  ${
                    this.posSearch
                      ? `<button
                          type="button"
                          data-action="clear-pos-search"
                          title="Limpar pesquisa (Esc)"
                          class="h-7 w-7 absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60"
                        >${ICONS.close}</button>`
                      : ''
                  }
                </div>
                <div class="hidden sm:flex items-center bg-slate-100 p-0.5 rounded-lg shrink-0">
                  ${(['ALL', '14', '0'] as const)
                    .map((f) => {
                      const active = String(this.posTaxFilter) === f;
                      const label = f === 'ALL' ? 'Todos' : f === '14' ? '14%' : 'Isento';
                      return `
                        <button
                          type="button"
                          data-action="tax-filter"
                          data-value="${f}"
                          class="h-9 px-2 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                            active ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                          }"
                        >${label}</button>
                      `;
                    })
                    .join('')}
                </div>
                <button
                  type="button"
                  data-action="toggle-pos-stock-filter"
                  title="Filtrar apenas artigos disponíveis em stock"
                  class="h-10 px-2.5 rounded-lg border text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                    this.posStockOnlyFilter
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }"
                >Em stock</button>
                ${
                  canManageCat
                    ? `<button
                        type="button"
                        data-action="toggle-quick-product"
                        ${isSuspended ? 'disabled' : ''}
                        title="Cadastro rápido de artigo diretamente no POS"
                        class="h-10 px-2.5 rounded-lg border text-xs font-medium flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                          this.showQuickProductForm
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                        }"
                      >
                        ${ICONS.plus}
                        <span class="hidden xl:inline">Artigo</span>
                      </button>`
                    : ''
                }
              </div>

              ${
                this.showQuickProductForm && canManageCat
                  ? `<form
                      data-form="pos-quick-product-form"
                      class="border border-slate-200 rounded-lg bg-slate-50 p-2.5 space-y-2"
                    >
                      <div class="flex items-center justify-between">
                        <span class="text-[11px] font-semibold text-slate-800">Cadastro rápido de artigo</span>
                        <button
                          type="button"
                          data-action="toggle-quick-product"
                          class="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                        >${ICONS.close}</button>
                      </div>
                      ${
                        this.quickProductError
                          ? `<div class="p-2 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(
                              this.quickProductError
                            )}</div>`
                          : ''
                      }
                      <div class="grid grid-cols-6 gap-1.5">
                        <div class="col-span-2">
                          <input
                            name="code"
                            type="text"
                            required
                            maxlength="32"
                            value="${escapeHtml(this.quickProductDraft.code)}"
                            placeholder="SKU / Código *"
                            class="w-full h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-2">
                          <input
                            name="barcode"
                            type="text"
                            maxlength="48"
                            value="${escapeHtml(this.quickProductDraft.barcode)}"
                            placeholder="Cód. Barras (opc.)"
                            class="w-full h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-2">
                          <input
                            name="category"
                            type="text"
                            maxlength="48"
                            value="${escapeHtml(this.quickProductDraft.category)}"
                            placeholder="Categoria"
                            class="w-full h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-4">
                          <input
                            id="quick-product-name-input"
                            name="name"
                            type="text"
                            required
                            maxlength="160"
                            value="${escapeHtml(this.quickProductDraft.name)}"
                            placeholder="Descrição do artigo ou serviço *"
                            class="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-1">
                          <input
                            name="unit"
                            type="text"
                            list="pos-quick-units-datalist"
                            maxlength="12"
                            value="${escapeHtml(this.quickProductDraft.unit)}"
                            placeholder="un"
                            class="w-full h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                          <datalist id="pos-quick-units-datalist">
                            ${DEFAULT_PRODUCT_UNITS.map((u) => `<option value="${escapeHtml(u)}"></option>`).join('')}
                          </datalist>
                        </div>
                        <div class="col-span-1">
                          <select
                            name="ivaRate"
                            class="w-full h-8 px-1.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          >
                            <option value="14" ${this.quickProductDraft.ivaRate === 14 ? 'selected' : ''}>14%</option>
                            <option value="0" ${this.quickProductDraft.ivaRate === 0 ? 'selected' : ''}>Isento</option>
                          </select>
                        </div>
                        <div class="col-span-3">
                          <input
                            name="costPrice"
                            type="text"
                            inputmode="decimal"
                            value="${escapeHtml(this.quickProductDraft.costPrice)}"
                            placeholder="Aquisição Kz (opc.)"
                            class="w-full h-8 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-3">
                          <input
                            name="price"
                            type="text"
                            inputmode="decimal"
                            required
                            value="${escapeHtml(this.quickProductDraft.price)}"
                            placeholder="Preço Venda (Kz) *"
                            class="w-full h-8 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="col-span-6 flex items-center justify-between gap-2 pt-0.5">
                          <div class="flex items-center gap-2">
                            <label class="inline-flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                name="trackStock"
                                ${this.quickProductDraft.trackStock ? 'checked' : ''}
                                class="h-3.5 w-3.5 rounded border-slate-300 text-blue-600"
                              />
                              <span>Controlar stock</span>
                            </label>
                            ${
                              this.quickProductDraft.trackStock
                                ? `<input
                                    name="stockQty"
                                    type="text"
                                    inputmode="decimal"
                                    value="${escapeHtml(this.quickProductDraft.stockQty)}"
                                    placeholder="Qtd. inicial"
                                    class="w-24 h-7 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  />`
                                : ''
                            }
                          </div>
                          <button
                            type="submit"
                            class="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap shrink-0"
                          >Guardar e adicionar</button>
                        </div>
                      </div>
                    </form>`
                  : ''
              }

              ${
                this.scannerNotice
                  ? `<div class="px-2.5 py-1.5 rounded-md border text-[11px] flex items-center gap-1.5 ${
                      this.scannerNoticeIsError
                        ? 'bg-amber-50 border-amber-200 text-amber-800'
                        : 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    }">
                      ${ICONS.barcode}
                      <span class="truncate">${escapeHtml(this.scannerNotice)}</span>
                    </div>`
                  : ''
              }

              <!-- Categorias de produtos em seletores compactos -->
              <div class="flex items-center gap-1 overflow-x-auto pb-0.5 no-scrollbar">
                <button
                  type="button"
                  data-action="pos-category"
                  data-value="ALL"
                  class="h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                    this.posCategoryFilter === 'ALL'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-900'
                  }"
                >Todas · ${activeProducts.length}</button>
                ${orderedCategories
                  .map((cat) => {
                    const active = this.posCategoryFilter === cat;
                    const count = categoryCounts.get(cat) || 0;
                    return `
                      <button
                        type="button"
                        data-action="pos-category"
                        data-value="${escapeHtml(cat)}"
                        class="h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                          active
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-900'
                        }"
                      >${escapeHtml(cat)} · ${count}</button>
                    `;
                  })
                  .join('')}
              </div>
            </div>

            <div class="flex-1 overflow-y-auto p-3">
              ${
                visibleProducts.length === 0
                  ? posSuggestions.length > 0
                    ? `<div class="space-y-2.5">
                        <div class="flex items-center justify-between gap-2 text-xs text-slate-600 px-0.5">
                          <span>Sem resultado exato para <strong>${escapeHtml(this.posSearch)}</strong>. Sugestões próximas:</span>
                          <div class="flex items-center gap-2 shrink-0">
                            ${
                              canManageCat
                                ? `<button
                                    type="button"
                                    data-action="toggle-quick-product"
                                    class="text-[11px] text-blue-600 hover:underline font-semibold whitespace-nowrap"
                                  >+ Cadastrar artigo</button>`
                                : ''
                            }
                            <button
                              type="button"
                              data-action="clear-pos-search"
                              class="text-[11px] text-slate-500 hover:underline font-medium whitespace-nowrap"
                            >Limpar</button>
                          </div>
                        </div>
                        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-2">
                          ${posSuggestions
                            .map((prod) => {
                              const outOfStock = Boolean(prod.trackStock && (prod.stockQty ?? 0) <= 0);
                              return `
                                <button
                                  type="button"
                                  data-action="add-suggested-to-cart"
                                  data-id="${escapeHtml(prod.id)}"
                                  ${isSuspended ? 'disabled' : ''}
                                  class="text-left p-2.5 rounded-lg border transition-colors min-h-[88px] flex flex-col justify-between disabled:opacity-50 ${
                                    outOfStock
                                      ? 'border-amber-200 bg-amber-50/30 hover:border-amber-400'
                                      : 'border-slate-200 bg-white hover:border-blue-600 active:bg-slate-50'
                                  }"
                                >
                                  <div class="flex items-center justify-between gap-1 text-[10px] font-mono text-slate-400">
                                    <span class="truncate">${escapeHtml(prod.code)} · ${escapeHtml(prod.category || 'Geral')}</span>
                                    ${renderProductStockMeta(prod)}
                                  </div>
                                  <div class="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug my-1">${escapeHtml(prod.name)}</div>
                                  <div class="text-xs font-bold text-slate-900 font-mono tabular-nums pt-1 border-t border-slate-100">${formatKzNumber(prod.price)} Kz</div>
                                </button>
                              `;
                            })
                            .join('')}
                        </div>
                      </div>`
                    : `<div class="h-44 flex flex-col items-center justify-center gap-2 text-xs text-slate-500 text-center px-4">
                        <span>${
                          this.products.length === 0
                            ? 'Catálogo vazio nesta empresa.'
                            : 'Nenhum artigo encontrado para o filtro atual.'
                        }</span>
                        <div class="flex flex-wrap items-center justify-center gap-3">
                          ${
                            canManageCat
                              ? `<button
                                  type="button"
                                  data-action="toggle-quick-product"
                                  class="text-blue-600 hover:underline font-semibold whitespace-nowrap"
                                >+ Cadastrar artigo rápido</button>`
                              : ''
                          }
                          ${
                            this.posStockOnlyFilter
                              ? `<button
                                  type="button"
                                  data-action="toggle-pos-stock-filter"
                                  class="text-slate-600 hover:underline font-medium whitespace-nowrap"
                                >Mostrar também sem stock</button>`
                              : this.posSearch ||
                                  this.posCategoryFilter !== 'ALL' ||
                                  this.posTaxFilter !== 'ALL'
                                ? `<button
                                    type="button"
                                    data-action="pos-category"
                                    data-value="ALL"
                                    class="text-slate-600 hover:underline font-medium whitespace-nowrap"
                                  >Mostrar todas as categorias</button>`
                                : ''
                          }
                        </div>
                      </div>`
                  : `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-2">
                      ${visibleProducts
                        .map((prod) => {
                          const inCart = this.cart.find((c) => c.productId === prod.id);
                          const outOfStock = Boolean(prod.trackStock && (prod.stockQty ?? 0) <= 0);
                          return `
                            <button
                              type="button"
                              data-action="add-to-cart"
                              data-id="${escapeHtml(prod.id)}"
                              ${isSuspended ? 'disabled' : ''}
                              class="text-left p-2.5 rounded-lg border transition-colors min-h-[92px] flex flex-col justify-between active:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none ${
                                inCart
                                  ? 'bg-white border-blue-600 ring-1 ring-blue-600/20'
                                  : outOfStock
                                    ? 'bg-amber-50/25 border-amber-200 hover:border-amber-400'
                                    : 'bg-white border-slate-200 hover:border-blue-600'
                              }"
                            >
                              <div class="flex items-center justify-between gap-1.5 w-full text-[10px] text-slate-400">
                                <span class="font-mono truncate">${escapeHtml(prod.code)} · ${escapeHtml(prod.category || 'Geral')}</span>
                                <span class="tabular-nums shrink-0 text-slate-500">${prod.ivaRate === 14 ? '14%' : 'Isento'}</span>
                              </div>
                              <div class="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug my-1">${escapeHtml(prod.name)}</div>
                              <div class="space-y-1 w-full pt-1 border-t border-slate-100">
                                <div class="flex items-center justify-between gap-1 w-full">
                                  <span class="text-xs font-bold text-slate-900 font-mono tabular-nums">${formatKzNumber(prod.price)} Kz</span>
                                  ${
                                    inCart
                                      ? `<span class="text-[11px] font-mono font-bold text-blue-600 tabular-nums">×${inCart.qty}</span>`
                                      : ''
                                  }
                                </div>
                                ${prod.trackStock ? `<div class="flex items-center justify-between">${renderProductStockMeta(prod)}</div>` : ''}
                              </div>
                            </button>
                          `;
                        })
                        .join('')}
                    </div>`
              }
            </div>
          </section>

          <!-- COLUNA 2: Área de Faturação (Cliente, Em Espera, Troca, Artigos, Pagamentos & Totais) -->
          <section class="lg:col-span-4 flex flex-col border-r border-slate-200 bg-white overflow-hidden ${
            this.mobilePane === 'CART' ? 'flex' : 'hidden lg:flex'
          }">
            ${this.renderPosQuickCashBar(isSuspended)}
            <!-- Barra de Seleção Rápida, Conta Corrente, Vendas Suspensas e Troca -->
            <div class="p-3 border-b border-slate-200 space-y-2 shrink-0">
              <div class="flex items-center gap-1.5">
                <div class="flex-1 min-w-0 flex items-center bg-slate-50 border border-slate-200 rounded-lg h-10 focus-within:border-blue-600">
                  <button
                    type="button"
                    data-action="toggle-customer-picker"
                    title="Pesquisar e selecionar cliente rapidamente"
                    class="flex-1 h-full px-2.5 text-left flex items-center justify-between gap-2 min-w-0"
                  >
                    <div class="min-w-0">
                      <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(selectedCustomer.name)}</div>
                      <div class="text-[10px] text-slate-500 font-mono truncate tabular-nums">
                        ${escapeHtml(selectedCustomer.nif || 'Consumidor Final')} · ${escapeHtml(selectedCustomer.locality || defaultLocality)}${
                          selectedCustomerOpenDebt > 0
                            ? ` · <span class="text-amber-700 font-semibold">Dívida: ${formatKzNumber(selectedCustomerOpenDebt)} Kz</span>`
                            : ''
                        }${
                          'creditLimit' in selectedCustomer &&
                          selectedCustomer.creditLimit &&
                          selectedCustomer.creditLimit > 0
                            ? ` · <span class="text-slate-600">Lim: ${formatKzNumber(selectedCustomer.creditLimit)} Kz</span>`
                            : ''
                        }
                      </div>
                    </div>
                    <span class="text-slate-400 shrink-0">${this.showCustomerPicker ? ICONS.chevronUp : ICONS.chevronDown}</span>
                  </button>
                </div>

                ${
                  this.selectedCustomerId !== directCustId
                    ? `<button
                        type="button"
                        data-action="select-final-consumer"
                        title="Seleção rápida de Consumidor Final (Venda Directa)"
                        class="h-10 px-2.5 flex items-center justify-center rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
                      >Consumidor Final</button>`
                    : ''
                }

                <button
                  type="button"
                  data-action="toggle-quick-customer"
                  ${isSuspended ? 'disabled' : ''}
                  title="Cadastro rápido de cliente sem sair da fatura"
                  class="h-10 px-2.5 flex items-center justify-center gap-1 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-40 ${
                    this.showQuickCustomerForm
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                  }"
                >
                  ${ICONS.userPlus}
                  <span class="hidden xl:inline">Novo</span>
                </button>

                <button
                  type="button"
                  data-action="toggle-pos-options"
                  title="Opções do documento (Tipo, Caixa, Operador, Notas)"
                  class="h-10 w-10 flex items-center justify-center rounded-lg border transition-colors shrink-0 ${
                    this.showOptionsDrawer
                      ? 'bg-slate-100 border-slate-300 text-slate-900'
                      : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }"
                >
                  ${ICONS.settings}
                </button>
              </div>

              <!-- Atalhos operacionais rápidos: Em espera (Suspensas) & Troca / Devolução -->
              ${
                this.suspendedSales.length > 0 || this.invoices.length > 0
                  ? `<div class="flex items-center justify-between gap-2 text-[11px]">
                      <div class="flex items-center gap-2 min-w-0">
                        ${
                          this.suspendedSales.length > 0
                            ? `<button
                                type="button"
                                data-action="toggle-suspended-drawer"
                                class="h-7 px-2 rounded-md border text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap tabular-nums ${
                                  this.showSuspendedDrawer
                                    ? 'bg-slate-900 text-white border-slate-900'
                                    : 'border-amber-200 bg-amber-50 text-amber-900 hover:bg-amber-100/70'
                                }"
                              >
                                ${ICONS.play}
                                <span>Em espera · ${this.suspendedSales.length}</span>
                              </button>`
                            : `<span class="text-slate-400 truncate">${escapeHtml(this.docType === 'FR' ? 'Factura / Recibo' : 'Proforma')} · Caixa ${escapeHtml(this.cashier)}</span>`
                        }
                      </div>
                      ${
                        this.invoices.length > 0 && !this.returnOriginInvoice
                          ? `<button
                              type="button"
                              data-action="open-history-for-return"
                              title="Selecionar fatura emitida no histórico para devolução ou troca"
                              class="h-7 px-2 rounded-md border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 flex items-center gap-1 whitespace-nowrap shrink-0"
                            >
                              ${ICONS.exchange}
                              <span>Troca / Devolução</span>
                            </button>`
                          : ''
                      }
                    </div>`
                  : ''
              }

              ${
                this.returnOriginInvoice
                  ? `<div class="px-2.5 py-1.5 rounded-md border border-blue-200 bg-blue-50/70 text-[11px] text-slate-800 flex items-center justify-between gap-2">
                      <span class="truncate tabular-nums">
                        Troca ref. <strong>${escapeHtml(this.returnOriginInvoice.number)}</strong> · Crédito: <strong>${formatKzNumber(this.returnOriginInvoice.creditAmount)} Kz</strong>
                      </span>
                      <button
                        type="button"
                        data-action="cancel-return-exchange"
                        class="text-blue-700 hover:underline font-semibold whitespace-nowrap shrink-0"
                      >Cancelar</button>
                    </div>`
                  : ''
              }

              ${
                this.showSuspendedDrawer && this.suspendedSales.length > 0
                  ? `<div class="border border-slate-200 rounded-lg bg-slate-50 p-2 space-y-1.5">
                      <div class="flex items-center justify-between text-[11px] font-semibold text-slate-700 px-0.5">
                        <span>Vendas suspensas em espera</span>
                        <button
                          type="button"
                          data-action="toggle-suspended-drawer"
                          class="text-slate-400 hover:text-slate-700"
                        >${ICONS.close}</button>
                      </div>
                      <div class="max-h-36 overflow-y-auto divide-y divide-slate-100 bg-white border border-slate-200 rounded-md">
                        ${this.suspendedSales
                          .map((s) => {
                            const dt = formatDateTimePt(s.suspendedAtIso);
                            return `
                              <div class="px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs">
                                <div class="min-w-0">
                                  <div class="font-medium text-slate-900 truncate">${escapeHtml(s.label)}</div>
                                  <div class="text-[10px] text-slate-500 font-mono tabular-nums">${dt.time} · ${s.cart.length} art. · ${escapeHtml(s.customerName)}</div>
                                </div>
                                <div class="flex items-center gap-1 shrink-0">
                                  <button
                                    type="button"
                                    data-action="resume-suspended-sale"
                                    data-id="${escapeHtml(s.id)}"
                                    class="h-7 px-2 rounded bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 whitespace-nowrap"
                                  >Recuperar</button>
                                  <button
                                    type="button"
                                    data-action="delete-suspended-sale"
                                    data-id="${escapeHtml(s.id)}"
                                    title="Descartar venda suspensa"
                                    class="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                                  >${ICONS.trash}</button>
                                </div>
                              </div>
                            `;
                          })
                          .join('')}
                      </div>
                    </div>`
                  : ''
              }

              <!-- Painel de Seleção Rápida de Cliente com Pesquisa Instantânea -->
              ${
                this.showCustomerPicker
                  ? `
                  <div class="border border-slate-200 rounded-lg bg-slate-50 p-2 space-y-1.5">
                    <div class="flex items-center gap-1.5">
                      <div class="relative flex-1 min-w-0">
                        <span class="text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                        <input
                          id="pos-customer-search-input"
                          type="text"
                          autocomplete="off"
                          data-field="pos-customer-search"
                          value="${escapeHtml(this.posCustomerSearch)}"
                          placeholder="Filtrar por nome, NIF, telefone ou endereço..."
                          class="w-full h-8 pl-8 pr-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <button
                        type="button"
                        data-action="select-final-consumer"
                        title="Selecionar Consumidor Final num clique"
                        class="h-8 px-2.5 rounded-md border text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                          this.selectedCustomerId === directCustId
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                        }"
                      >Consumidor Final</button>
                    </div>
                    <div class="max-h-40 overflow-y-auto divide-y divide-slate-100 bg-white border border-slate-200 rounded-md">
                      ${
                        matchingCustomers.length === 0
                          ? `<div class="p-2.5 text-[11px] text-slate-500 flex items-center justify-between gap-2">
                              <span>Nenhum cliente encontrado.</span>
                              <button
                                type="button"
                                data-action="toggle-quick-customer"
                                class="text-blue-600 font-semibold hover:underline whitespace-nowrap"
                              >+ Cadastrar agora</button>
                            </div>`
                          : matchingCustomers
                              .map((c) => {
                                const isSel = c.id === this.selectedCustomerId;
                                const custDebt =
                                  c.id !== directCustId ? this.getCustomerOpenDebt(c.id) : 0;
                                return `
                                  <button
                                    type="button"
                                    data-action="select-pos-customer"
                                    data-id="${escapeHtml(c.id)}"
                                    class="w-full px-2.5 py-2 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                                      isSel ? 'bg-blue-50/80 text-blue-900 font-semibold' : 'hover:bg-slate-50 text-slate-800'
                                    }"
                                  >
                                    <div class="min-w-0">
                                      <div class="truncate">${escapeHtml(c.name)}</div>
                                      ${
                                        c.phone || (c.address && c.address !== c.locality)
                                          ? `<div class="text-[10px] text-slate-400 truncate">${escapeHtml(
                                              [c.phone, c.address && c.address !== c.locality ? c.address : '']
                                                .filter(Boolean)
                                                .join(' · ')
                                            )}</div>`
                                          : ''
                                      }
                                    </div>
                                    <span class="text-[10px] font-mono text-slate-500 shrink-0 tabular-nums">
                                      ${escapeHtml(c.nif || 'Consumidor Final')}${
                                        custDebt > 0
                                          ? ` · <span class="text-amber-700 font-semibold">${formatKzNumber(custDebt)} Kz</span>`
                                          : ''
                                      }
                                    </span>
                                  </button>
                                `;
                              })
                              .join('')
                      }
                    </div>
                  </div>
                `
                  : ''
              }

              <!-- Cadastro Rápido de Cliente Sem Sair da Fatura -->
              ${
                this.showQuickCustomerForm
                  ? `
                  <form
                    data-form="pos-quick-customer-form"
                    class="border border-slate-200 rounded-lg bg-slate-50 p-2.5 space-y-2"
                  >
                    <div class="flex items-center justify-between">
                      <span class="text-[11px] font-semibold text-slate-800">Novo cliente na fatura</span>
                      <button
                        type="button"
                        data-action="toggle-quick-customer"
                        class="h-6 w-6 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                      >${ICONS.close}</button>
                    </div>
                    ${
                      this.quickCustomerError
                        ? `<div class="p-2 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(
                            this.quickCustomerError
                          )}</div>`
                        : ''
                    }
                    <div class="grid grid-cols-2 gap-1.5">
                      <div class="col-span-2">
                        <input
                          id="quick-customer-name-input"
                          name="name"
                          type="text"
                          required
                          maxlength="160"
                          value="${escapeHtml(this.quickCustomerDraft.name)}"
                          placeholder="Nome completo ou empresa *"
                          class="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div>
                        <input
                          name="nif"
                          type="text"
                          maxlength="32"
                          value="${escapeHtml(this.quickCustomerDraft.nif)}"
                          placeholder="NIF (ou Consumidor Final)"
                          class="w-full h-8 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div>
                        <input
                          name="phone"
                          type="text"
                          maxlength="40"
                          value="${escapeHtml(this.quickCustomerDraft.phone)}"
                          placeholder="Telefone (+244...)"
                          class="w-full h-8 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div class="col-span-2">
                        <input
                          name="address"
                          type="text"
                          maxlength="200"
                          value="${escapeHtml(this.quickCustomerDraft.address)}"
                          placeholder="Endereço (rua, bairro, n.º — opcional)"
                          class="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div class="col-span-2 flex items-center gap-1.5">
                        <input
                          name="locality"
                          type="text"
                          maxlength="160"
                          value="${escapeHtml(this.quickCustomerDraft.locality || defaultLocality)}"
                          placeholder="Localidade / Município"
                          class="flex-1 h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                        <button
                          type="submit"
                          class="h-8 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap shrink-0"
                        >Guardar e usar</button>
                      </div>
                    </div>
                  </form>
                `
                  : ''
              }

              ${
                this.showOptionsDrawer
                  ? `
                  <div class="pt-2 border-t border-slate-100 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <label class="block text-[10px] text-slate-500 mb-0.5">Documento</label>
                      <select
                        data-field="pos-doctype"
                        class="w-full h-8 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs"
                      >
                        <option value="FR" ${this.docType === 'FR' ? 'selected' : ''}>Factura/Recibo</option>
                        <option value="FP" ${this.docType === 'FP' ? 'selected' : ''}>Proforma</option>
                      </select>
                    </div>
                    <div>
                      <label class="block text-[10px] text-slate-500 mb-0.5">Caixa</label>
                      <input
                        type="text"
                        maxlength="8"
                        data-field="pos-cashier"
                        value="${escapeHtml(this.cashier)}"
                        class="w-full h-8 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono"
                      />
                    </div>
                    <div>
                      <label class="block text-[10px] text-slate-500 mb-0.5">Operador</label>
                      <input
                        type="text"
                        maxlength="12"
                        data-field="pos-operator"
                        value="${escapeHtml(this.operator)}"
                        class="w-full h-8 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono"
                      />
                    </div>
                  </div>
                `
                  : ''
              }
            </div>

            <!-- Cabeçalho compacto da lista de artigos adicionados -->
            ${
              this.cart.length > 0
                ? `<div class="px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between gap-2 text-[11px] text-slate-500 shrink-0 tabular-nums">
                    <span>${this.cart.length} ${this.cart.length === 1 ? 'artigo' : 'artigos'} · ${cartCount} un</span>
                    <div class="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        data-action="suspend-sale"
                        title="Colocar esta venda em espera para atender outro cliente"
                        class="text-slate-600 hover:text-blue-600 font-medium inline-flex items-center gap-1 transition-colors whitespace-nowrap"
                      >${ICONS.pause}<span>Suspender</span></button>
                      <span aria-hidden="true" class="text-slate-300">·</span>
                      ${
                        this.confirmClearCart
                          ? `<span class="inline-flex items-center gap-1">
                              <button
                                type="button"
                                data-action="clear-pos"
                                class="px-2 py-0.5 rounded bg-red-600 text-white text-[10.5px] font-semibold hover:bg-red-700 whitespace-nowrap"
                              >Confirmar limpar</button>
                              <button
                                type="button"
                                data-action="cancel-clear-pos"
                                class="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                              >Não</button>
                            </span>`
                          : `<button
                              type="button"
                              data-action="request-clear-pos"
                              class="text-slate-500 hover:text-red-600 font-medium transition-colors whitespace-nowrap"
                            >Limpar tudo</button>`
                      }
                    </div>
                  </div>`
                : ''
            }

            <!-- Lista de Artigos Adicionados com Edição Direta de Qtd, Preço Autorizado, Desconto % e IVA -->
            <div class="flex-1 overflow-y-auto divide-y divide-slate-100">
              ${
                this.cart.length === 0
                  ? `
                  <div class="h-full flex flex-col items-center justify-center p-6 text-center">
                    <p class="text-xs text-slate-500">Adicione artigos do catálogo para iniciar a fatura.</p>
                    ${
                      this.lastEmitted
                        ? `<div class="mt-3 text-xs text-emerald-700 font-medium flex flex-col items-center gap-1">
                            <span class="flex items-center gap-1.5">${ICONS.check} Emitida ${escapeHtml(this.lastEmitted.number)} (${formatKzNumber(this.lastEmitted.grandTotal)} Kz)</span>
                            ${
                              this.lastAuditHash
                                ? `<span class="text-[10px] font-mono text-slate-500">SHA256: ${escapeHtml(this.lastAuditHash)}</span>`
                                : ''
                            }
                          </div>`
                        : ''
                    }
                  </div>
                `
                  : totals.lines
                      .map((line) => {
                        const domKey = line.productId.replace(/[^a-zA-Z0-9_-]/g, '_');
                        const catalogProd = this.products.find((p) => p.id === line.productId);
                        const stockWarn =
                          catalogProd && catalogProd.trackStock
                            ? (catalogProd.stockQty ?? 0) <= 0
                              ? `<span class="text-red-600 font-semibold">· Sem stock (0)</span>`
                              : line.qty > (catalogProd.stockQty ?? 0)
                                ? `<span class="text-amber-700 font-semibold">· Acima do stock (${catalogProd.stockQty})</span>`
                                : ''
                            : '';
                        const isConfirmingRemove = this.confirmRemoveCartProductId === line.productId;

                        return `
                        <div class="p-2.5 hover:bg-slate-50/60 transition-colors space-y-2">
                          <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 flex-1">
                              <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(line.description)}</div>
                              <div class="text-[10.5px] text-slate-400 font-mono tabular-nums">
                                ${escapeHtml(line.code)} · ${escapeHtml(line.unit)}${
                                  line.discountPct > 0 ? ` · Desc. ${line.discountPct}%` : ''
                                } · ${
                                  line.ivaRate === 14
                                    ? `IVA ${formatKzNumber(line.lineTax)} Kz`
                                    : 'Isento 0%'
                                } ${stockWarn}
                              </div>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0">
                              <div class="text-right">
                                <div class="text-xs font-bold text-slate-900 font-mono tabular-nums">${formatKzNumber(line.lineTotal)} Kz</div>
                              </div>
                              ${
                                isConfirmingRemove
                                  ? `<div class="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        data-action="remove-cart-item"
                                        data-id="${escapeHtml(line.productId)}"
                                        class="h-7 px-2 rounded bg-red-600 text-white text-[10.5px] font-semibold hover:bg-red-700 whitespace-nowrap"
                                      >Remover</button>
                                      <button
                                        type="button"
                                        data-action="cancel-remove-cart-item"
                                        title="Manter artigo"
                                        class="h-7 w-7 flex items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-100"
                                      >${ICONS.close}</button>
                                    </div>`
                                  : `<button
                                      type="button"
                                      data-action="request-remove-cart-item"
                                      data-id="${escapeHtml(line.productId)}"
                                      title="Remover artigo"
                                      class="h-7 w-7 flex items-center justify-center text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"
                                    >${ICONS.trash}</button>`
                              }
                            </div>
                          </div>

                          <!-- Controlos diretos: Quantidade | Preço Unit. (Autorizado) | Desc.% | IVA -->
                          <div class="flex items-center justify-between gap-1.5 flex-wrap sm:flex-nowrap">
                            <!-- Quantidade -->
                            <div class="flex items-center border border-slate-200 rounded-md bg-white h-8 shrink-0">
                              <button
                                type="button"
                                data-action="qty-delta"
                                data-id="${escapeHtml(line.productId)}"
                                data-value="-1"
                                title="Diminuir quantidade"
                                class="h-full w-7 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-l-md"
                              >${ICONS.minus}</button>
                              <input
                                id="cart-qty-${domKey}"
                                type="text"
                                inputmode="decimal"
                                aria-label="Quantidade"
                                data-field="cart-qty-live"
                                data-id="${escapeHtml(line.productId)}"
                                value="${line.qty}"
                                class="w-10 h-full text-center text-xs font-mono font-semibold tabular-nums focus:outline-none focus:bg-blue-50/40"
                              />
                              <button
                                type="button"
                                data-action="qty-delta"
                                data-id="${escapeHtml(line.productId)}"
                                data-value="1"
                                title="Aumentar quantidade"
                                class="h-full w-7 flex items-center justify-center text-slate-600 hover:bg-slate-100 rounded-r-md"
                              >${ICONS.plus}</button>
                            </div>

                            <!-- Preço Unitário (Kz) — Editável se autorizado, bloqueado caso contrário -->
                            ${
                              canEditPrice
                                ? `<div class="flex items-center gap-1 flex-1 min-w-[92px] h-8 px-2 border border-slate-200 rounded-md bg-white focus-within:border-blue-600">
                                    <span class="text-[10px] text-slate-400 shrink-0">Kz</span>
                                    <input
                                      id="cart-price-${domKey}"
                                      type="text"
                                      inputmode="decimal"
                                      aria-label="Preço unitário em Kwanzas"
                                      data-field="cart-price-live"
                                      data-id="${escapeHtml(line.productId)}"
                                      value="${line.unitPrice}"
                                      class="w-full h-full text-right text-xs font-mono font-semibold text-slate-900 tabular-nums focus:outline-none bg-transparent"
                                    />
                                  </div>`
                                : `<button
                                    type="button"
                                    data-action="locked-price-notice"
                                    title="Preço bloqueado para Operador de Caixa"
                                    class="flex items-center justify-between gap-1 flex-1 min-w-[92px] h-8 px-2 border border-slate-200 rounded-md bg-slate-50 text-slate-600 hover:border-slate-300"
                                  >
                                    <span class="text-slate-400 shrink-0">${ICONS.lock}</span>
                                    <span class="text-xs font-mono font-semibold tabular-nums truncate">${formatKzNumber(line.unitPrice)}</span>
                                  </button>`
                            }

                            <!-- Desconto por artigo (%) -->
                            <div
                              title="Desconto percentual neste artigo"
                              class="flex items-center gap-0.5 w-[64px] h-8 px-1.5 border border-slate-200 rounded-md bg-white focus-within:border-blue-600 shrink-0"
                            >
                              <input
                                id="cart-disc-${domKey}"
                                type="text"
                                inputmode="decimal"
                                aria-label="Desconto percentual do artigo"
                                data-field="cart-discount-live"
                                data-id="${escapeHtml(line.productId)}"
                                value="${line.discountPct > 0 ? line.discountPct : ''}"
                                placeholder="Desc"
                                class="w-full h-full text-right text-xs font-mono font-semibold text-slate-900 tabular-nums focus:outline-none bg-transparent"
                              />
                              <span class="text-[10px] text-slate-400 shrink-0">%</span>
                            </div>

                            <!-- Seletor compacto de IVA 14% ou Isenção por artigo -->
                            <div class="flex items-center bg-slate-100 p-0.5 rounded-md h-8 shrink-0">
                              <button
                                type="button"
                                data-action="set-cart-iva"
                                data-id="${escapeHtml(line.productId)}"
                                data-value="14"
                                title="Aplicar IVA de 14% neste artigo"
                                class="h-7 px-1.5 rounded text-[10.5px] font-medium transition-colors whitespace-nowrap tabular-nums ${
                                  line.ivaRate === 14
                                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                                    : 'text-slate-500 hover:text-slate-900'
                                }"
                              >14%</button>
                              <button
                                type="button"
                                data-action="set-cart-iva"
                                data-id="${escapeHtml(line.productId)}"
                                data-value="0"
                                title="Isentar este artigo de IVA (0%)"
                                class="h-7 px-1.5 rounded text-[10.5px] font-medium transition-colors whitespace-nowrap ${
                                  line.ivaRate === 0
                                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                                    : 'text-slate-500 hover:text-slate-900'
                                }"
                              >0%</button>
                            </div>
                          </div>
                        </div>
                      `;
                      })
                      .join('')
              }
            </div>

            <!-- Rodapé Faturação: Desconto Global, Observações, Impostos, Pagamentos & Emissão -->
            <div class="border-t border-slate-200 bg-slate-50 p-3 space-y-2 shrink-0">
              <!-- Linha rápida: Desconto global (%) + Observações da venda -->
              <div class="grid grid-cols-12 gap-1.5">
                <div class="col-span-4 flex items-center gap-1 h-8 px-2 bg-white border border-slate-200 rounded-md focus-within:border-blue-600">
                  <span class="text-[10px] text-slate-500 shrink-0">Desc.</span>
                  <input
                    id="global-discount-input"
                    type="text"
                    inputmode="decimal"
                    data-field="global-discount-live"
                    value="${escapeHtml(this.globalDiscountInput)}"
                    placeholder="0"
                    class="w-full h-full text-right text-xs font-mono font-semibold text-slate-900 tabular-nums focus:outline-none bg-transparent"
                  />
                  <span class="text-[10px] text-slate-400 shrink-0">%</span>
                </div>
                <div class="col-span-8 flex items-center gap-1.5 h-8 px-2 bg-white border border-slate-200 rounded-md focus-within:border-blue-600">
                  <span class="text-slate-400 shrink-0">${ICONS.note}</span>
                  <input
                    id="pos-notes-inline"
                    type="text"
                    maxlength="160"
                    data-field="pos-notes"
                    value="${escapeHtml(this.notes)}"
                    placeholder="Observações da venda..."
                    class="w-full h-full text-xs text-slate-800 focus:outline-none bg-transparent"
                  />
                </div>
              </div>

              <div class="space-y-1 text-xs tabular-nums">
                <div class="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span class="font-mono">${formatKzNumber(totals.merchandiseTotal)} Kz</span>
                </div>
                ${
                  totals.lineDiscountTotal > 0
                    ? `<div class="flex justify-between text-slate-500 text-[11px]">
                        <span>Desconto artigos</span>
                        <span class="font-mono">-${formatKzNumber(totals.lineDiscountTotal)} Kz</span>
                      </div>`
                    : ''
                }
                ${
                  totals.globalDiscountAmount > 0
                    ? `<div class="flex justify-between text-slate-500 text-[11px]">
                        <span>Desconto global (${totals.globalDiscountPct}%)</span>
                        <span class="font-mono">-${formatKzNumber(totals.globalDiscountAmount)} Kz</span>
                      </div>`
                    : ''
                }
                <div class="flex justify-between text-slate-600">
                  <span>Impostos (IVA 14%)</span>
                  <span class="font-mono">${formatKzNumber(totals.taxTotal)} Kz</span>
                </div>
                ${
                  totals.taxBase0 > 0
                    ? `<div class="flex justify-between text-[10.5px] text-slate-400">
                        <span>Incidência isenta (0%)</span>
                        <span class="font-mono">${formatKzNumber(totals.taxBase0)} Kz</span>
                      </div>`
                    : ''
                }
                <div class="flex justify-between items-baseline pt-1 border-t border-slate-200">
                  <span class="font-bold text-slate-900">${returnCreditApplied > 0 ? 'Total da fatura' : 'Total a pagar'}</span>
                  <span class="${returnCreditApplied > 0 ? 'text-sm' : 'text-lg'} font-bold text-slate-900 font-mono">${formatKzNumber(totals.grandTotal)} Kz</span>
                </div>
                ${
                  returnCreditApplied > 0
                    ? `<div class="flex justify-between text-[11px] text-blue-700 font-medium">
                        <span>Crédito devolução (${escapeHtml(this.returnOriginInvoice?.number || '')})</span>
                        <span class="font-mono">-${formatKzNumber(returnCreditApplied)} Kz</span>
                      </div>
                      <div class="flex justify-between items-baseline pt-1 border-t border-slate-200">
                        <span class="font-bold text-slate-900">Líquido a pagar</span>
                        <span class="text-lg font-bold text-slate-900 font-mono">${formatKzNumber(netPayable)} Kz</span>
                      </div>`
                    : ''
                }
              </div>

              <!-- Seleção de modalidade de pagamento (Dinheiro, TPA, Transf., Crédito, Combinado) -->
              <div class="grid grid-cols-5 gap-1 bg-slate-200/70 p-0.5 rounded-lg">
                ${(['Dinheiro', 'Multicaixa', 'Transferência', 'Crédito', 'Combinado'] as PaymentMethod[])
                  .map((m) => {
                    const shortLabel =
                      m === 'Multicaixa'
                        ? 'TPA'
                        : m === 'Transferência'
                          ? 'Transf.'
                          : m;
                    return `
                      <button
                        type="button"
                        data-action="set-payment"
                        data-value="${m}"
                        title="Pagamento: ${m}"
                        class="h-8 px-1 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap truncate ${
                          this.paymentMethod === m ? 'bg-white text-slate-900 shadow-xs font-semibold' : 'text-slate-600 hover:text-slate-900'
                        }"
                      >${shortLabel}</button>
                    `;
                  })
                  .join('')}
              </div>

              ${
                this.paymentMethod === 'Dinheiro'
                  ? `
                  <div class="space-y-1.5">
                    <div class="grid grid-cols-2 gap-2">
                      <div>
                        <label class="block text-[10px] text-slate-500 mb-0.5">Valor recebido — total ou parcial (Kz)</label>
                        <input
                          id="amount-received-input"
                          type="text"
                          inputmode="decimal"
                          data-field="amount-received"
                          value="${escapeHtml(this.amountReceivedInput)}"
                          placeholder="${formatKzNumber(netPayable)}"
                          class="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold tabular-nums focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div class="flex flex-col justify-end text-right">
                        ${
                          (liveInvoice.amountDue || 0) > 0
                            ? `<span class="text-[10px] text-amber-700 font-medium">Em dívida (parcial)</span>
                               <span class="h-9 flex items-center justify-end text-sm font-bold font-mono text-amber-700 tabular-nums">
                                 ${formatKzNumber(liveInvoice.amountDue!)} Kz
                               </span>`
                            : `<span class="text-[10px] text-slate-500">Troco</span>
                               <span class="h-9 flex items-center justify-end text-sm font-bold font-mono text-emerald-700 tabular-nums">
                                 ${formatKzNumber(liveInvoice.changeAmount)} Kz
                               </span>`
                        }
                      </div>
                    </div>

                    ${
                      netPayable > 0
                        ? `<div class="flex items-center gap-1 overflow-x-auto">
                            ${[1000, 2000, 5000, 8000, 10000]
                              .map(
                                (val) => `
                                <button
                                  type="button"
                                  data-action="quick-cash"
                                  data-value="${val}"
                                  class="h-7 px-2 rounded border border-slate-200 bg-white text-[10.5px] font-mono text-slate-700 hover:border-blue-600 shrink-0 tabular-nums"
                                >${val.toLocaleString('pt-PT')}</button>
                              `
                              )
                              .join('')}
                          </div>`
                        : ''
                    }
                  </div>
                `
                  : this.paymentMethod === 'Multicaixa' || this.paymentMethod === 'Transferência'
                    ? `
                    <div class="space-y-1.5">
                      <div class="grid grid-cols-2 gap-2">
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-0.5">${
                            this.paymentMethod === 'Transferência'
                              ? 'N.º Referência da transferência'
                              : 'N.º Comprovativo TPA (opcional)'
                          }</label>
                          <input
                            id="transfer-ref-input"
                            type="text"
                            maxlength="80"
                            data-field="transfer-ref-live"
                            value="${escapeHtml(this.transferReference)}"
                            placeholder="${this.paymentMethod === 'Transferência' ? 'Ex: TRF-984210 / BAI' : 'Ex: TPA-00419'}"
                            class="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div>
                          <label class="block text-[10px] text-slate-500 mb-0.5">Valor pago agora (Kz)</label>
                          <input
                            id="amount-received-input"
                            type="text"
                            inputmode="decimal"
                            data-field="amount-received"
                            value="${escapeHtml(this.amountReceivedInput)}"
                            placeholder="${formatKzNumber(netPayable)}"
                            class="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold tabular-nums focus:outline-none focus:border-blue-600"
                          />
                        </div>
                      </div>
                      ${
                        (liveInvoice.amountDue || 0) > 0
                          ? `<div class="flex items-center justify-between text-[11px] text-amber-800 tabular-nums">
                              <span>Restante em conta corrente:</span>
                              <span class="font-mono font-bold">${formatKzNumber(liveInvoice.amountDue!)} Kz</span>
                            </div>`
                          : ''
                      }
                    </div>
                  `
                    : this.paymentMethod === 'Crédito'
                      ? `
                      <div class="space-y-1">
                        <div class="grid grid-cols-2 gap-2">
                          <div>
                            <label class="block text-[10px] text-slate-500 mb-0.5">Entrada inicial opcional (Kz)</label>
                            <input
                              id="amount-received-input"
                              type="text"
                              inputmode="decimal"
                              data-field="amount-received"
                              value="${escapeHtml(this.amountReceivedInput)}"
                              placeholder="0,00"
                              class="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold tabular-nums focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div class="flex flex-col justify-end text-right">
                            <span class="text-[10px] text-amber-700 font-medium">Conta corrente</span>
                            <span class="h-9 flex items-center justify-end text-sm font-bold font-mono text-amber-700 tabular-nums">
                              ${formatKzNumber(liveInvoice.amountDue || 0)} Kz
                            </span>
                          </div>
                        </div>
                        ${
                          this.selectedCustomerId === directCustId && this.docType === 'FR'
                            ? `<div class="text-[10.5px] text-amber-800">Selecione ou cadastre o cliente acima para registar venda a crédito.</div>`
                            : ''
                        }
                      </div>
                    `
                      : `
                      <!-- Pagamento Combinado (Dinheiro + Multicaixa + Transferência) -->
                      <div class="space-y-1.5 bg-white border border-slate-200 rounded-lg p-2">
                        ${(['Dinheiro', 'Multicaixa', 'Transferência'] as DirectPaymentMethod[])
                          .map(
                            (m) => `
                            <div class="flex items-center gap-1.5">
                              <span class="w-24 text-[11px] text-slate-600 shrink-0">${m}</span>
                              <input
                                id="split-amt-${m}"
                                type="text"
                                inputmode="decimal"
                                data-field="split-amount-live"
                                data-id="${m}"
                                value="${escapeHtml(this.splitInputs[m])}"
                                placeholder="0,00"
                                class="flex-1 h-7 px-2 bg-slate-50 border border-slate-200 rounded text-xs font-mono font-semibold text-right tabular-nums focus:outline-none focus:border-blue-600"
                              />
                              <button
                                type="button"
                                data-action="fill-split-remainder"
                                data-value="${m}"
                                class="h-7 px-2 rounded border border-slate-200 text-[10px] font-medium text-slate-600 hover:bg-slate-100 whitespace-nowrap shrink-0"
                              >Restante</button>
                            </div>
                          `
                          )
                          .join('')}
                        <div class="pt-1">
                          <input
                            id="transfer-ref-input"
                            type="text"
                            maxlength="80"
                            data-field="transfer-ref-live"
                            value="${escapeHtml(this.transferReference)}"
                            placeholder="N.º referência transferência / comprovativo TPA (se aplicável)"
                            class="w-full h-7 px-2 bg-slate-50 border border-slate-200 rounded text-[11px] font-mono focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="flex items-center justify-between text-[11px] pt-1 border-t border-slate-100 tabular-nums">
                          <span class="text-slate-500">Soma: <strong class="font-mono text-slate-800">${formatKzNumber(liveInvoice.amountReceived)} Kz</strong></span>
                          ${
                            (liveInvoice.amountDue || 0) > 0
                              ? `<span class="text-amber-700 font-semibold font-mono">Em dívida: ${formatKzNumber(liveInvoice.amountDue!)} Kz</span>`
                              : `<span class="text-emerald-700 font-semibold font-mono">Troco: ${formatKzNumber(liveInvoice.changeAmount)} Kz</span>`
                          }
                        </div>
                      </div>
                    `
              }

              ${(() => {
                if (this.docType !== 'FR' || this.selectedCustomerId === directCustId) return '';
                const newDue = roundKz(liveInvoice.amountDue || 0);
                const limit =
                  'creditLimit' in selectedCustomer &&
                  selectedCustomer.creditLimit &&
                  selectedCustomer.creditLimit > 0
                    ? roundKz(selectedCustomer.creditLimit)
                    : 0;
                if (limit <= 0) return '';
                const available = Math.max(0, roundKz(limit - selectedCustomerOpenDebt));
                const projected = roundKz(selectedCustomerOpenDebt + newDue);
                if (newDue > 0 && projected > limit) {
                  return `
                    <div class="p-2 rounded-md border border-red-200 bg-red-50 text-[11px] text-red-700 tabular-nums">
                      Limite de crédito excedido (${formatKzNumber(limit)} Kz) · Plafond disponível: <strong>${formatKzNumber(available)} Kz</strong>
                    </div>
                  `;
                }
                if (this.paymentMethod === 'Crédito' || newDue > 0) {
                  return `
                    <div class="flex items-center justify-between text-[11px] text-slate-600 tabular-nums">
                      <span>Plafond disponível (Lim. ${formatKzNumber(limit)} Kz):</span>
                      <span class="font-mono font-semibold text-emerald-700">${formatKzNumber(Math.max(0, roundKz(limit - projected)))} Kz</span>
                    </div>
                  `;
                }
                return '';
              })()}

              ${
                isSuspended
                  ? `<div class="p-2 rounded-md border border-red-200 bg-red-50 text-[11px] text-red-700">
                      Empresa suspensa — novas emissões estão bloqueadas; consulta e reimpressão continuam disponíveis.
                    </div>`
                  : ''
              }

              ${(() => {
                if (hasPaidCommercialEntitlement(this.activeCompany)) return '';
                const usage = this.getMonthlyInvoiceUsage();
                if (usage.usedCount < FREE_SOFT_NOTICE_THRESHOLD) return '';
                return `
                  <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500 pt-0.5 tabular-nums">
                    <span>Movimento mensal: ${usage.usedCount}/${usage.effectiveLimit} documentos</span>
                    <button
                      type="button"
                      data-action="open-growth-modal"
                      data-value="monthly_limit"
                      class="text-blue-600 hover:underline font-medium whitespace-nowrap"
                    >Ativar ilimitado</button>
                  </div>
                `;
              })()}

              <div class="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  data-action="emit-invoice"
                  data-value="save"
                  title="Atalho rápido: F4 ou Ctrl+Enter"
                  ${this.cart.length === 0 || this.isEmitting || isSuspended ? 'disabled' : ''}
                  class="flex-1 h-11 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.check}
                  <span>Emitir</span>
                </button>
                <button
                  type="button"
                  data-action="emit-invoice"
                  data-value="print"
                  ${this.cart.length === 0 || this.isEmitting || isSuspended ? 'disabled' : ''}
                  class="flex-1 h-11 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.printer}
                  <span>${isA4 ? 'Emitir + A4' : 'Emitir + POS'}</span>
                </button>
              </div>
            </div>
          </section>

          <!-- COLUNA 3: Pré-visualização Térmica 80mm / A4 -->
          <section class="${isA4 ? 'lg:col-span-4' : 'lg:col-span-3'} flex flex-col bg-slate-100 overflow-hidden ${
            this.mobilePane === 'PREVIEW' ? 'flex' : 'hidden lg:flex'
          }">
            <div class="p-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0">
              <div class="flex items-center bg-slate-100 p-0.5 rounded-lg">
                <button
                  type="button"
                  data-action="set-preview-format"
                  data-value="POS"
                  class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                    !isA4 ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }"
                >POS 80mm</button>
                <button
                  type="button"
                  data-action="set-preview-format"
                  data-value="A4"
                  class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                    isA4 ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                  }"
                >A4</button>
              </div>

              <button
                type="button"
                data-action="print-live"
                ${liveInvoice.lines.length === 0 ? 'disabled' : ''}
                class="h-8 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.printer}
                <span>Imprimir</span>
              </button>
            </div>

            <div class="flex-1 overflow-y-auto p-3">
              ${
                liveInvoice.lines.length === 0
                  ? `<div class="h-full flex items-center justify-center text-xs text-slate-400 text-center px-4">
                      ${isA4 ? 'A fatura A4 aparecerá aqui em tempo real ao adicionar artigos.' : 'O talão térmico aparecerá aqui em tempo real ao adicionar artigos.'}
                    </div>`
                  : renderDocumentHtml(
                      liveInvoice,
                      this.previewFormat,
                      this.settings.company,
                      cachedQr,
                      this.getInvoiceRenderOptions(
                        liveInvoice,
                        shouldShowViralDocumentFooter(this.activeCompany, this.settings)
                      )
                    )
              }
            </div>
          </section>
        </div>
      </div>
    `;
  }

  // ==================== 3. CLIENTES ====================

  private renderCustomersWorkspace(): string {
    const directCustId = getDirectCustomerIdForCompany(this.activeCompany.id);
    const canEditCust = this.canEditExistingCustomers();
    const isSuspended = this.isCompanySuspended();

    const statsByCustomer = new Map<string, ReturnType<typeof this.getCustomerStats>>();
    let totalCompanyReceivable = 0;
    let customersWithDebtCount = 0;
    let customersWithLimitCount = 0;

    for (const c of this.customers) {
      const st = this.getCustomerStats(c.id);
      statsByCustomer.set(c.id, st);
      if (c.id !== directCustId && st.openDebt > 0) {
        totalCompanyReceivable = roundKz(totalCompanyReceivable + st.openDebt);
        customersWithDebtCount += 1;
      }
      if (c.id !== directCustId && c.creditLimit && c.creditLimit > 0) {
        customersWithLimitCount += 1;
      }
    }

    const searchMatches = filterCustomersSmart(this.customers, this.customerSearch);
    const filtered = searchMatches.filter((c) => {
      if (this.customerFilter === 'WITH_DEBT') {
        return c.id !== directCustId && (statsByCustomer.get(c.id)?.openDebt || 0) > 0;
      }
      if (this.customerFilter === 'WITH_LIMIT') {
        return c.id !== directCustId && Boolean(c.creditLimit && c.creditLimit > 0);
      }
      return true;
    });

    const activeDetailCust =
      filtered.find((c) => c.id === this.selectedCustomerDetailId) ||
      this.customers.find((c) => c.id === this.selectedCustomerDetailId) ||
      filtered.find((c) => c.id !== directCustId) ||
      filtered[0] ||
      null;

    const activeDetailStats = activeDetailCust
      ? statsByCustomer.get(activeDetailCust.id) || this.getCustomerStats(activeDetailCust.id)
      : null;

    const isEditingDirect = this.editingCustomer?.id === directCustId;

    return `
      <div class="h-full flex flex-col bg-white overflow-hidden">
        <!-- Barra superior: Pesquisa inteligente, Filtros de Conta Corrente, Consumidor Final e Novo Cliente -->
        <div class="p-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div class="flex items-center gap-2 flex-1 min-w-[260px]">
            <div class="relative flex-1 max-w-md">
              <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
              <input
                id="customer-search-input"
                type="text"
                data-field="customer-search"
                value="${escapeHtml(this.customerSearch)}"
                placeholder="Pesquisar por nome, NIF, telefone, endereço ou localidade (F2)..."
                class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <div class="hidden md:flex items-center bg-slate-100 p-0.5 rounded-lg shrink-0 tabular-nums">
              ${(
                [
                  { id: 'ALL', label: `Todos · ${this.customers.length}` },
                  { id: 'WITH_DEBT', label: `Com dívida · ${customersWithDebtCount}` },
                  { id: 'WITH_LIMIT', label: `Com limite · ${customersWithLimitCount}` },
                ] as const
              )
                .map(
                  (tab) => `
                  <button
                    type="button"
                    data-action="set-customer-filter"
                    data-value="${tab.id}"
                    class="h-9 px-2.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                      this.customerFilter === tab.id
                        ? 'bg-white text-slate-900 shadow-xs font-semibold'
                        : 'text-slate-600 hover:text-slate-900'
                    }"
                  >${tab.label}</button>
                `
                )
                .join('')}
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            ${
              totalCompanyReceivable > 0
                ? `<div class="hidden xl:flex items-center gap-1.5 text-xs text-slate-600 mr-1 tabular-nums">
                    <span>Total a receber:</span>
                    <strong class="font-mono text-amber-800">${formatKzNumber(totalCompanyReceivable)} Kz</strong>
                  </div>`
                : ''
            }
            <button
              type="button"
              data-action="use-customer-in-pos"
              data-id="${escapeHtml(directCustId)}"
              title="Iniciar venda rápida no POS para Consumidor Final"
              class="h-10 px-3 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-900 transition-colors whitespace-nowrap shrink-0"
            >Consumidor Final (POS)</button>
            <button
              type="button"
              data-action="new-customer"
              ${isSuspended ? 'disabled' : ''}
              class="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              ${ICONS.plus}
              <span>Novo Cliente</span>
            </button>
          </div>
        </div>

        ${
          this.customerSavedNotice
            ? `<div class="px-3.5 py-2 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5 shrink-0">${ICONS.check}<span>${escapeHtml(
                this.customerSavedNotice
              )}</span></div>`
            : ''
        }

        ${
          this.editingCustomer
            ? `
            <form
              data-form="customer-form"
              class="p-3.5 border-b border-slate-200 bg-slate-50 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end shrink-0"
            >
              ${
                this.customerFormError
                  ? `<div class="sm:col-span-12 p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-700">${escapeHtml(
                      this.customerFormError
                    )}</div>`
                  : ''
              }
              <div class="sm:col-span-4">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Nome / Identificação Fiscal *</label>
                <input
                  id="customer-form-name-input"
                  name="name"
                  type="text"
                  required
                  maxlength="160"
                  value="${escapeHtml(this.editingCustomer.name)}"
                  placeholder="Nome completo ou designação social"
                  class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-3">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">NIF / Contribuinte</label>
                <input
                  name="nif"
                  type="text"
                  maxlength="32"
                  ${isEditingDirect ? 'readonly' : ''}
                  value="${escapeHtml(this.editingCustomer.nif)}"
                  placeholder="Ex: 5001234567 ou Consumidor Final"
                  class="w-full h-9 px-2.5 text-xs font-mono ${isEditingDirect ? 'bg-slate-100 text-slate-500' : 'bg-white'} border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Contacto Telefónico</label>
                <input
                  name="phone"
                  type="text"
                  maxlength="40"
                  value="${escapeHtml(this.editingCustomer.phone)}"
                  placeholder="(+244) 9..."
                  class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-3">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Limite de Crédito (Kz, opcional)</label>
                <input
                  name="creditLimit"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  ${isEditingDirect ? 'disabled' : ''}
                  value="${escapeHtml(isEditingDirect ? '' : this.editingCustomerCreditLimitInput)}"
                  placeholder="${isEditingDirect ? 'Não aplicável' : 'Sem limite fixo'}"
                  class="w-full h-9 px-2.5 text-xs font-mono tabular-nums ${isEditingDirect ? 'bg-slate-100 text-slate-400' : 'bg-white'} border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-6">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Endereço (Rua, Bairro, Edifício)</label>
                <input
                  name="address"
                  type="text"
                  maxlength="200"
                  value="${escapeHtml(this.editingCustomer.address)}"
                  placeholder="Ex: Rua Rainha Ginga, Bairro Cidade-Alta"
                  class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-4">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Localidade / Município</label>
                <input
                  name="locality"
                  type="text"
                  maxlength="160"
                  value="${escapeHtml(this.editingCustomer.locality)}"
                  placeholder="Ex: Huambo - Angola"
                  class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-2 flex items-center gap-1.5">
                <button
                  type="submit"
                  class="flex-1 h-9 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
                >Guardar</button>
                <button
                  type="button"
                  data-action="cancel-edit-customer"
                  class="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                >${ICONS.close}</button>
              </div>
            </form>
          `
            : ''
        }

        <!-- Vista Master-Detail: Lista de Clientes (Esquerda) + Ficha, Conta Corrente, Compras & Pagamentos (Direita) -->
        <div class="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          <div class="lg:col-span-7 flex flex-col border-r border-slate-200 overflow-hidden">
            <div class="flex-1 overflow-y-auto">
              <table class="w-full text-left border-collapse">
                <thead class="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                  <tr>
                    <th class="py-2.5 px-3 font-medium">Cliente / Endereço</th>
                    <th class="py-2.5 px-3 font-medium">NIF / Contacto</th>
                    <th class="py-2.5 px-3 font-medium text-right hidden sm:table-cell">Limite Crédito</th>
                    <th class="py-2.5 px-3 font-medium text-right">Saldo em Dívida</th>
                    <th class="py-2.5 px-3 font-medium text-right w-28">Ações</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 text-xs">
                  ${
                    filtered.length === 0
                      ? `<tr><td colspan="5" class="py-10 px-3 text-center text-xs text-slate-500">Nenhum cliente encontrado para o filtro atual.</td></tr>`
                      : filtered
                          .map((c) => {
                            const isDirect = c.id === directCustId;
                            const st = statsByCustomer.get(c.id);
                            const openDebt = !isDirect ? st?.openDebt || 0 : 0;
                            const limit = !isDirect && c.creditLimit && c.creditLimit > 0 ? c.creditLimit : 0;
                            const overLimit = limit > 0 && openDebt > limit;
                            const isSelected = activeDetailCust?.id === c.id;
                            const addrLine = [
                              c.address && c.address.toLowerCase() !== (c.locality || '').toLowerCase()
                                ? c.address
                                : '',
                              c.locality || '',
                            ]
                              .filter(Boolean)
                              .join(' · ');

                            return `
                            <tr
                              data-action="select-customer-detail"
                              data-id="${escapeHtml(c.id)}"
                              class="cursor-pointer transition-colors ${
                                isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50/80'
                              }"
                            >
                              <td class="py-2.5 px-3">
                                <div class="font-medium text-slate-900">${escapeHtml(c.name)}</div>
                                <div class="text-[11px] text-slate-500 truncate max-w-[230px]">${escapeHtml(addrLine || '—')}</div>
                              </td>
                              <td class="py-2.5 px-3 font-mono tabular-nums">
                                <div class="text-slate-700">${escapeHtml(c.nif || 'Consumidor Final')}</div>
                                <div class="text-[11px] text-slate-400">${escapeHtml(c.phone || 'Sem telefone')}</div>
                              </td>
                              <td class="py-2.5 px-3 text-right font-mono tabular-nums hidden sm:table-cell">
                                ${
                                  limit > 0
                                    ? `<span class="text-slate-700">${formatKzNumber(limit)} Kz</span>`
                                    : `<span class="text-slate-400">—</span>`
                                }
                              </td>
                              <td class="py-2.5 px-3 text-right font-mono tabular-nums">
                                ${
                                  openDebt > 0
                                    ? `<span class="${overLimit ? 'text-red-600' : 'text-amber-700'} font-semibold">${formatKzNumber(openDebt)} Kz</span>`
                                    : `<span class="text-slate-400">0,00 Kz</span>`
                                }
                              </td>
                              <td class="py-2 px-3 text-right">
                                <div class="inline-flex items-center gap-0.5">
                                  <button
                                    type="button"
                                    data-action="use-customer-in-pos"
                                    data-id="${escapeHtml(c.id)}"
                                    title="Faturar para este cliente no POS"
                                    class="h-8 px-2 inline-flex items-center justify-center rounded-md text-[11px] font-medium text-blue-700 hover:bg-blue-50 whitespace-nowrap"
                                  >POS</button>
                                  ${
                                    canEditCust
                                      ? `<button
                                          type="button"
                                          data-action="edit-customer"
                                          data-id="${escapeHtml(c.id)}"
                                          title="Editar dados do cliente"
                                          class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                                        >${ICONS.edit}</button>
                                        ${
                                          !isDirect
                                            ? `<button
                                                type="button"
                                                data-action="delete-customer"
                                                data-id="${escapeHtml(c.id)}"
                                                title="Remover cliente"
                                                class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                                              >${ICONS.trash}</button>`
                                            : ''
                                        }`
                                      : ''
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

          <!-- Painel Direito: Ficha Fiscal, Limite de Crédito, Registo de Pagamentos & Histórico de Compras -->
          <div class="lg:col-span-5 flex flex-col bg-slate-50/60 overflow-hidden border-t lg:border-t-0 border-slate-200">
            ${
              activeDetailCust && activeDetailStats
                ? (() => {
                    const isDirect = activeDetailCust.id === directCustId;
                    const limit =
                      !isDirect && activeDetailCust.creditLimit && activeDetailCust.creditLimit > 0
                        ? roundKz(activeDetailCust.creditLimit)
                        : 0;
                    const availableCredit =
                      limit > 0 ? Math.max(0, roundKz(limit - activeDetailStats.openDebt)) : 0;
                    const overLimit = limit > 0 && activeDetailStats.openDebt > limit;
                    const settlingSpecificInv = this.settlingInvoiceId
                      ? activeDetailStats.invoices.find((i) => i.id === this.settlingInvoiceId) || null
                      : null;

                    return `
                      <div class="p-3.5 bg-white border-b border-slate-200 space-y-2 shrink-0">
                        <div class="flex items-start justify-between gap-2">
                          <div class="min-w-0">
                            <div class="text-sm font-bold text-slate-900 truncate">${escapeHtml(activeDetailCust.name)}</div>
                            <div class="text-[11px] text-slate-600 font-mono tabular-nums mt-0.5">
                              NIF: ${escapeHtml(activeDetailCust.nif || 'Consumidor Final')}${
                                activeDetailCust.phone ? ` · Tel: ${escapeHtml(activeDetailCust.phone)}` : ''
                              }
                            </div>
                            <div class="text-[11px] text-slate-500 mt-0.5">
                              ${
                                activeDetailCust.address &&
                                activeDetailCust.address.toLowerCase() !==
                                  (activeDetailCust.locality || '').toLowerCase()
                                  ? `${escapeHtml(activeDetailCust.address)} · `
                                  : ''
                              }${escapeHtml(activeDetailCust.locality || 'Angola')}
                            </div>
                          </div>

                          <div class="flex items-center gap-1.5 shrink-0">
                            ${
                              !isDirect && activeDetailStats.openDebt > 0
                                ? `<button
                                    type="button"
                                    data-action="open-settle-customer-account"
                                    data-id="${escapeHtml(activeDetailCust.id)}"
                                    ${isSuspended ? 'disabled' : ''}
                                    class="h-8 px-2.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-700 disabled:opacity-40 whitespace-nowrap"
                                  >Registar Pagamento</button>`
                                : ''
                            }
                            <button
                              type="button"
                              data-action="use-customer-in-pos"
                              data-id="${escapeHtml(activeDetailCust.id)}"
                              class="h-8 px-2.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 whitespace-nowrap"
                            >Nova Venda</button>
                          </div>
                        </div>
                      </div>

                      <!-- Métricas Financeiras Descomplicadas (Tabular-Nums) -->
                      <div class="grid grid-cols-3 divide-x divide-slate-200 border-b border-slate-200 bg-white text-xs tabular-nums shrink-0">
                        <div class="p-2.5">
                          <div class="text-[10.5px] text-slate-500">Total Comprado</div>
                          <div class="font-mono font-bold text-slate-900 mt-0.5">${formatKzNumber(activeDetailStats.totalSpent)} Kz</div>
                          <div class="text-[10px] text-slate-400">${activeDetailStats.purchaseCount} ${activeDetailStats.purchaseCount === 1 ? 'fatura FR' : 'faturas FR'}</div>
                        </div>
                        <div class="p-2.5">
                          <div class="text-[10.5px] text-slate-500">Saldo em Dívida</div>
                          <div class="font-mono font-bold ${
                            overLimit
                              ? 'text-red-600'
                              : activeDetailStats.openDebt > 0
                                ? 'text-amber-700'
                                : 'text-slate-900'
                          } mt-0.5">${formatKzNumber(activeDetailStats.openDebt)} Kz</div>
                          <div class="text-[10px] text-slate-400">${
                            isDirect
                              ? 'Venda a pronto'
                              : `${activeDetailStats.openInvoiceCount} pendente(s)`
                          }</div>
                        </div>
                        <div class="p-2.5">
                          <div class="text-[10.5px] text-slate-500">Limite de Crédito</div>
                          <div class="font-mono font-bold text-slate-900 mt-0.5">${
                            isDirect
                              ? 'Não aplicável'
                              : limit > 0
                                ? `${formatKzNumber(limit)} Kz`
                                : 'Sem limite'
                          }</div>
                          <div class="text-[10px] ${overLimit ? 'text-red-600 font-semibold' : 'text-slate-400'}">${
                            isDirect
                              ? 'Consumidor Final'
                              : limit > 0
                                ? overLimit
                                  ? 'Limite excedido'
                                  : `Disp.: ${formatKzNumber(availableCredit)} Kz`
                                : 'Plafond livre'
                          }</div>
                        </div>
                      </div>

                      <!-- Formulário de Registo de Pagamento na Conta Corrente (FIFO) -->
                      ${
                        this.settlingCustomerAccountId === activeDetailCust.id &&
                        activeDetailStats.openDebt > 0
                          ? `<form
                              data-form="settle-customer-debt-form"
                              class="p-3 border-b border-slate-200 bg-amber-50/80 space-y-2 shrink-0"
                            >
                              <div class="flex items-center justify-between text-xs">
                                <span class="font-semibold text-slate-900">Registar pagamento de conta corrente</span>
                                <span class="font-mono text-amber-800 font-semibold tabular-nums">Dívida: ${formatKzNumber(activeDetailStats.openDebt)} Kz</span>
                              </div>
                              ${
                                this.settleError
                                  ? `<div class="p-2 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(this.settleError)}</div>`
                                  : ''
                              }
                              <div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                                <div class="sm:col-span-4">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Valor pago (Kz)</label>
                                  <input
                                    name="settleAmount"
                                    type="text"
                                    inputmode="decimal"
                                    required
                                    value="${escapeHtml(this.settleAmountInput)}"
                                    class="w-full h-8 px-2 text-xs font-mono font-semibold tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  />
                                </div>
                                <div class="sm:col-span-4">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Meio de pagamento</label>
                                  <select
                                    name="settleMethod"
                                    class="w-full h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  >
                                    <option value="Dinheiro" ${this.settleMethod === 'Dinheiro' ? 'selected' : ''}>Dinheiro</option>
                                    <option value="Multicaixa" ${this.settleMethod === 'Multicaixa' ? 'selected' : ''}>Multicaixa</option>
                                    <option value="Transferência" ${this.settleMethod === 'Transferência' ? 'selected' : ''}>Transferência</option>
                                  </select>
                                </div>
                                <div class="sm:col-span-4">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Referência (opcional)</label>
                                  <input
                                    name="settleReference"
                                    type="text"
                                    maxlength="80"
                                    value="${escapeHtml(this.settleReference)}"
                                    placeholder="Ref. TPA / IBAN"
                                    class="w-full h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  />
                                </div>
                                <div class="sm:col-span-12 flex items-center justify-between gap-2 pt-0.5">
                                  <span class="text-[10.5px] text-slate-600">Amortiza automaticamente as faturas pendentes mais antigas.</span>
                                  <div class="flex items-center gap-1.5 shrink-0">
                                    <button
                                      type="submit"
                                      class="h-8 px-3 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 whitespace-nowrap"
                                    >Confirmar pagamento</button>
                                    <button
                                      type="button"
                                      data-action="close-settle-customer-account"
                                      class="h-8 w-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                                    >${ICONS.close}</button>
                                  </div>
                                </div>
                              </div>
                            </form>`
                          : ''
                      }

                      <!-- Formulário de Liquidação de Fatura Específica na Ficha do Cliente -->
                      ${
                        settlingSpecificInv &&
                        settlingSpecificInv.status !== 'cancelled' &&
                        (settlingSpecificInv.amountDue || 0) > 0
                          ? `<form
                              data-form="settle-debt-form"
                              class="p-3 border-b border-slate-200 bg-amber-50/80 space-y-2 shrink-0"
                            >
                              <div class="flex items-center justify-between text-xs">
                                <span class="font-semibold text-slate-900">Liquidar fatura · ${escapeHtml(settlingSpecificInv.number)}</span>
                                <span class="font-mono text-amber-800 font-semibold tabular-nums">Saldo: ${formatKzNumber(settlingSpecificInv.amountDue!)} Kz</span>
                              </div>
                              ${
                                this.settleError
                                  ? `<div class="p-2 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(this.settleError)}</div>`
                                  : ''
                              }
                              <div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                                <div class="sm:col-span-3">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Valor (Kz)</label>
                                  <input
                                    name="settleAmount"
                                    type="text"
                                    inputmode="decimal"
                                    required
                                    value="${escapeHtml(this.settleAmountInput)}"
                                    class="w-full h-8 px-2 text-xs font-mono font-semibold tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  />
                                </div>
                                <div class="sm:col-span-3">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Meio</label>
                                  <select
                                    name="settleMethod"
                                    class="w-full h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  >
                                    <option value="Dinheiro" ${this.settleMethod === 'Dinheiro' ? 'selected' : ''}>Dinheiro</option>
                                    <option value="Multicaixa" ${this.settleMethod === 'Multicaixa' ? 'selected' : ''}>Multicaixa</option>
                                    <option value="Transferência" ${this.settleMethod === 'Transferência' ? 'selected' : ''}>Transferência</option>
                                  </select>
                                </div>
                                <div class="sm:col-span-3">
                                  <label class="block text-[10px] text-slate-600 mb-0.5">Referência</label>
                                  <input
                                    name="settleReference"
                                    type="text"
                                    maxlength="80"
                                    value="${escapeHtml(this.settleReference)}"
                                    placeholder="Opcional"
                                    class="w-full h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  />
                                </div>
                                <div class="sm:col-span-3 flex items-center gap-1.5">
                                  <button
                                    type="submit"
                                    class="flex-1 h-8 px-2.5 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 whitespace-nowrap"
                                  >Confirmar</button>
                                  <button
                                    type="button"
                                    data-action="close-settle-debt"
                                    class="h-8 w-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                                  >${ICONS.close}</button>
                                </div>
                              </div>
                            </form>`
                          : ''
                      }

                      <!-- Histórico de Compras e Registos de Pagamento do Cliente -->
                      <div class="px-3.5 py-2 border-b border-slate-200 bg-slate-100/70 flex items-center justify-between text-[11px] font-semibold text-slate-700 shrink-0 tabular-nums">
                        <span>Histórico de compras e pagamentos</span>
                        <span class="font-mono text-slate-500">${activeDetailStats.invoices.length} doc.</span>
                      </div>

                      <div class="flex-1 overflow-y-auto divide-y divide-slate-200/80 bg-white">
                        ${
                          activeDetailStats.invoices.length === 0
                            ? `<div class="p-8 text-center text-xs text-slate-500">Ainda não existem compras registadas para este cliente.</div>`
                            : activeDetailStats.invoices
                                .map((inv) => {
                                  const dt = formatDateTimePt(inv.issuedAtIso);
                                  const due = inv.status === 'issued' ? inv.amountDue || 0 : 0;
                                  return `
                                    <div class="p-3 hover:bg-slate-50/70 transition-colors space-y-1.5">
                                      <div class="flex items-center justify-between gap-2 text-xs tabular-nums">
                                        <div class="flex items-center gap-1.5 min-w-0">
                                          <span class="font-bold font-mono text-slate-900">${escapeHtml(inv.number)}</span>
                                          <span class="text-slate-400">·</span>
                                          <span class="text-slate-500">${dt.slashDate} ${dt.time}</span>
                                          ${
                                            inv.status === 'cancelled'
                                              ? `<span class="text-slate-400">·</span><span class="text-red-600 font-semibold">Anulada</span>`
                                              : due > 0
                                                ? `<span class="text-slate-400">·</span><span class="text-amber-700 font-semibold">Em dívida</span>`
                                                : inv.docType === 'FP'
                                                  ? `<span class="text-slate-400">·</span><span class="text-slate-500">Proforma</span>`
                                                  : `<span class="text-slate-400">·</span><span class="text-emerald-700 font-medium">Liquidada</span>`
                                          }
                                        </div>
                                        <span class="font-mono font-bold text-slate-900 shrink-0">${formatKzNumber(inv.grandTotal)} Kz</span>
                                      </div>

                                      <div class="text-[11px] text-slate-600 tabular-nums">
                                        ${inv.lines.length} art. · Pago: <span class="font-mono font-medium text-slate-800">${formatKzNumber(inv.amountReceived)} Kz</span>${
                                          due > 0
                                            ? ` · Saldo: <span class="font-mono font-semibold text-amber-700">${formatKzNumber(due)} Kz</span>`
                                            : ''
                                        }
                                      </div>

                                      ${
                                        inv.paymentSummary || inv.transferReference
                                          ? `<div class="text-[10.5px] font-mono text-slate-500 tabular-nums">
                                              ${escapeHtml(inv.paymentSummary || inv.paymentMethod)}${
                                                inv.transferReference ? ` · Ref: ${escapeHtml(inv.transferReference)}` : ''
                                              }
                                            </div>`
                                          : ''
                                      }

                                      <div class="flex items-center justify-end gap-1.5 pt-0.5">
                                        ${
                                          inv.status !== 'cancelled' && due > 0
                                            ? `<button
                                                type="button"
                                                data-action="open-settle-debt"
                                                data-id="${escapeHtml(inv.id)}"
                                                ${isSuspended ? 'disabled' : ''}
                                                class="h-7 px-2 rounded border border-amber-300 bg-amber-50 text-[11px] font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-40 whitespace-nowrap"
                                              >Liquidar</button>`
                                            : ''
                                        }
                                        <button
                                          type="button"
                                          data-action="open-invoice-in-history"
                                          data-id="${escapeHtml(inv.id)}"
                                          class="h-7 px-2 rounded border border-slate-200 text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                                        >Ver documento</button>
                                        <button
                                          type="button"
                                          data-action="print-customer-invoice"
                                          data-id="${escapeHtml(inv.id)}"
                                          data-value="POS"
                                          title="Imprimir talão POS 80mm"
                                          class="h-7 px-2 rounded border border-slate-200 text-[11px] font-medium text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                                        >POS</button>
                                        <button
                                          type="button"
                                          data-action="print-customer-invoice"
                                          data-id="${escapeHtml(inv.id)}"
                                          data-value="A4"
                                          title="Imprimir fatura A4"
                                          class="h-7 px-2 rounded border border-slate-200 text-[11px] font-medium text-slate-600 hover:bg-slate-100 whitespace-nowrap"
                                        >A4</button>
                                      </div>
                                    </div>
                                  `;
                                })
                                .join('')
                        }
                      </div>
                    `;
                  })()
                : `<div class="h-full flex items-center justify-center p-6 text-center text-xs text-slate-400">Selecione um cliente na lista para consultar ficha fiscal, limite de crédito, saldo em dívida, pagamentos e histórico de compras.</div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  // ==================== 4. PRODUTOS E SERVIÇOS ====================

  private getProductMarginStats(price: number, costPrice?: number): {
    hasCost: boolean;
    cost: number;
    profit: number;
    marginPct: number;
    markupPct: number;
    belowCost: boolean;
  } {
    const hasCost =
      typeof costPrice === 'number' && Number.isFinite(costPrice) && costPrice > 0;
    const cost = hasCost ? roundKz(costPrice!) : 0;
    const profit = hasCost ? roundKz(price - cost) : 0;
    const marginPct =
      hasCost && price > 0 ? roundKz((profit / price) * 100) : hasCost ? -100 : 0;
    const markupPct = hasCost && cost > 0 ? roundKz((profit / cost) * 100) : 0;
    const belowCost = hasCost && price < cost;
    return { hasCost, cost, profit, marginPct, markupPct, belowCost };
  }

  private renderProductMarginSummaryText(price: number, costPrice?: number): string {
    const stats = this.getProductMarginStats(price, costPrice);
    if (!stats.hasCost) {
      return '<span class="text-slate-400">Indique o preço de aquisição para calcular lucro e margem</span>';
    }
    const sign = stats.profit >= 0 ? '+' : '';
    const tone = stats.belowCost
      ? 'text-red-600 font-semibold'
      : stats.profit === 0
        ? 'text-slate-600'
        : 'text-emerald-700 font-semibold';
    return `<span class="font-mono tabular-nums ${tone}">Lucro: ${sign}${formatKzNumber(stats.profit)} Kz · Margem s/ venda: ${sign}${stats.marginPct.toFixed(1).replace('.', ',')}% · Markup s/ custo: ${sign}${stats.markupPct.toFixed(1).replace('.', ',')}%</span>`;
  }

  private refreshProductFormMarginReadout(): void {
    if (!this.editingProduct) return;
    const readout = document.getElementById('product-form-margin-readout');
    if (readout) {
      readout.innerHTML = this.renderProductMarginSummaryText(
        this.editingProduct.price,
        this.editingProduct.costPrice
      );
    }
  }

  private renderProductsWorkspace(): string {
    const canManageCat = this.canManageCatalog();
    const isSuspended = this.isCompanySuspended();

    const activeCount = this.products.filter((p) => p.active !== false).length;
    const inactiveCount = this.products.length - activeCount;
    const lowStockCount = this.products.filter(
      (p) => p.active !== false && p.trackStock && (p.stockQty ?? 0) <= (p.minStockQty ?? 0)
    ).length;

    const prodResult = searchProductsSmart(this.products, this.productSearch);
    const showingSuggestionsOnly =
      prodResult.matches.length === 0 && prodResult.suggestions.length > 0;
    const searchCandidates = showingSuggestionsOnly
      ? prodResult.suggestions
      : prodResult.matches;

    const filtered = searchCandidates.filter((p) => {
      if (this.productCategoryFilter !== 'ALL') {
        const cat = (p.category || 'Geral').trim();
        if (cat !== this.productCategoryFilter) return false;
      }
      if (this.productFilter === 'ACTIVE' && p.active === false) return false;
      if (this.productFilter === 'INACTIVE' && p.active !== false) return false;
      if (this.productFilter === 'LOW_STOCK') {
        if (!p.trackStock) return false;
        if ((p.stockQty ?? 0) > (p.minStockQty ?? 0)) return false;
      }
      return true;
    });

    const allCategories = Array.from(
      new Set([
        ...DEFAULT_PRODUCT_CATEGORIES,
        ...this.products.map((p) => (p.category || '').trim()).filter(Boolean),
      ])
    ).sort((a, b) => a.localeCompare(b, 'pt'));

    const usedCategories = Array.from(
      new Set(this.products.map((p) => (p.category || 'Geral').trim()).filter(Boolean))
    ).sort((a, b) => a.localeCompare(b, 'pt'));

    const selectedProd =
      filtered.find((p) => p.id === this.selectedProductDetailId) ||
      this.products.find((p) => p.id === this.selectedProductDetailId) ||
      filtered[0] ||
      this.products[0] ||
      null;

    if (selectedProd && this.selectedProductDetailId !== selectedProd.id) {
      this.selectedProductDetailId = selectedProd.id;
    }

    const detailMargin = selectedProd
      ? this.getProductMarginStats(selectedProd.price, selectedProd.costPrice)
      : null;
    const detailHistory = selectedProd?.priceHistory || [];

    return `
      <div class="h-full flex flex-col bg-white overflow-hidden">
        <!-- Barra de Pesquisa, Filtros de Estado/Stock, Categoria e Novo Artigo -->
        <div class="p-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div class="flex flex-wrap items-center gap-2 flex-1 min-w-[260px]">
            <div class="relative flex-1 min-w-[220px] max-w-md">
              <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
              <input
                id="product-search-input"
                type="text"
                data-field="product-search"
                value="${escapeHtml(this.productSearch)}"
                placeholder="Pesquisar SKU, código de barras, descrição ou categoria (F2)..."
                class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>

            <div class="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg">
              <button
                type="button"
                data-action="set-product-filter"
                data-value="ALL"
                class="h-9 px-2.5 rounded-md text-xs font-medium transition-colors tabular-nums whitespace-nowrap ${
                  this.productFilter === 'ALL'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }"
              >Todos · ${this.products.length}</button>
              <button
                type="button"
                data-action="set-product-filter"
                data-value="ACTIVE"
                class="h-9 px-2.5 rounded-md text-xs font-medium transition-colors tabular-nums whitespace-nowrap ${
                  this.productFilter === 'ACTIVE'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }"
              >Ativos · ${activeCount}</button>
              <button
                type="button"
                data-action="set-product-filter"
                data-value="INACTIVE"
                class="h-9 px-2.5 rounded-md text-xs font-medium transition-colors tabular-nums whitespace-nowrap ${
                  this.productFilter === 'INACTIVE'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }"
              >Inativos · ${inactiveCount}</button>
              <button
                type="button"
                data-action="set-product-filter"
                data-value="LOW_STOCK"
                class="h-9 px-2.5 rounded-md text-xs font-medium transition-colors tabular-nums whitespace-nowrap ${
                  this.productFilter === 'LOW_STOCK'
                    ? 'bg-white text-amber-800 shadow-xs'
                    : lowStockCount > 0
                      ? 'text-amber-800 hover:text-amber-950'
                      : 'text-slate-600 hover:text-slate-900'
                }"
              >Stock baixo · ${lowStockCount}</button>
            </div>

            <select
              data-field="product-category-filter"
              aria-label="Filtrar por categoria"
              class="h-10 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-700 focus:outline-none focus:border-blue-600"
            >
              <option value="ALL" ${this.productCategoryFilter === 'ALL' ? 'selected' : ''}>Todas as categorias</option>
              ${usedCategories
                .map(
                  (cat) =>
                    `<option value="${escapeHtml(cat)}" ${
                      this.productCategoryFilter === cat ? 'selected' : ''
                    }>${escapeHtml(cat)}</option>`
                )
                .join('')}
            </select>
          </div>

          ${
            canManageCat
              ? `<button
                  type="button"
                  data-action="new-product"
                  class="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  ${ICONS.plus}
                  <span>Novo Artigo</span>
                </button>`
              : `<span class="text-xs text-slate-500 whitespace-nowrap shrink-0">Modo consulta · ${escapeHtml(
                  formatRoleLabelPt(this.getEffectiveRole())
                )}</span>`
          }
        </div>

        ${
          this.productSavedNotice
            ? `<div class="px-3.5 py-2 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800 flex items-center gap-1.5 shrink-0">${ICONS.check}<span>${escapeHtml(
                this.productSavedNotice
              )}</span></div>`
            : ''
        }

        ${
          this.editingProduct && canManageCat
            ? `
            <form
              data-form="product-form"
              class="p-3.5 border-b border-slate-200 bg-slate-50 space-y-2.5 shrink-0"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-xs font-semibold text-slate-800">
                  ${this.isNewProduct ? 'Novo artigo ou serviço' : `Editar artigo · ${escapeHtml(this.editingProduct.code)}`}
                </span>
                <div id="product-form-margin-readout" class="text-[11px] truncate">
                  ${this.renderProductMarginSummaryText(
                    this.editingProduct.price,
                    this.editingProduct.costPrice
                  )}
                </div>
              </div>

              ${
                this.productFormError
                  ? `<div class="p-2 rounded-md bg-red-50 border border-red-200 text-xs text-red-700">${escapeHtml(
                      this.productFormError
                    )}</div>`
                  : ''
              }

              <div class="grid grid-cols-2 sm:grid-cols-12 gap-2.5 items-end">
                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Código Interno / SKU *</label>
                  <input
                    name="code"
                    type="text"
                    required
                    maxlength="32"
                    value="${escapeHtml(this.editingProduct.code)}"
                    placeholder="Ex: 00012"
                    class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Código de Barras</label>
                  <input
                    name="barcode"
                    type="text"
                    maxlength="48"
                    value="${escapeHtml(this.editingProduct.barcode || '')}"
                    placeholder="EAN / leitor USB"
                    class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-2 sm:col-span-4">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Descrição do Produto / Serviço *</label>
                  <input
                    id="product-form-name-input"
                    name="name"
                    type="text"
                    required
                    maxlength="160"
                    value="${escapeHtml(this.editingProduct.name)}"
                    placeholder="Ex: Água Mineral 1,5L"
                    class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-1 sm:col-span-3">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Categoria</label>
                  <input
                    name="category"
                    type="text"
                    list="product-categories-datalist"
                    maxlength="48"
                    value="${escapeHtml(this.editingProduct.category || 'Mercearia')}"
                    placeholder="Ex: Bebidas"
                    class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                  <datalist id="product-categories-datalist">
                    ${allCategories.map((cat) => `<option value="${escapeHtml(cat)}"></option>`).join('')}
                  </datalist>
                </div>
                <div class="col-span-1 sm:col-span-1">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Unidade</label>
                  <input
                    name="unit"
                    type="text"
                    list="product-units-datalist"
                    maxlength="12"
                    value="${escapeHtml(this.editingProduct.unit)}"
                    placeholder="un"
                    class="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                  <datalist id="product-units-datalist">
                    ${DEFAULT_PRODUCT_UNITS.map((u) => `<option value="${escapeHtml(u)}"></option>`).join('')}
                  </datalist>
                </div>

                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Preço Aquisição (Kz)</label>
                  <input
                    name="costPrice"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="0,00"
                    value="${escapeHtml(this.editingProductCostInput)}"
                    class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Markup s/ Custo (%)</label>
                  <input
                    name="markupPct"
                    type="text"
                    inputmode="decimal"
                    autocomplete="off"
                    placeholder="Ex: 30"
                    value="${escapeHtml(this.editingProductMarkupInput)}"
                    class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Preço Venda (Kz) *</label>
                  <input
                    name="price"
                    type="text"
                    inputmode="decimal"
                    required
                    autocomplete="off"
                    placeholder="0,00"
                    value="${escapeHtml(this.editingProductPriceInput)}"
                    class="w-full h-9 px-2.5 text-xs font-mono tabular-nums font-semibold bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                </div>
                <div class="col-span-1 sm:col-span-2">
                  <label class="block text-[10px] font-medium text-slate-600 mb-1">Regime de IVA</label>
                  <select
                    name="ivaRate"
                    class="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  >
                    <option value="14" ${this.editingProduct.ivaRate === 14 ? 'selected' : ''}>IVA 14% (Geral)</option>
                    <option value="0" ${this.editingProduct.ivaRate === 0 ? 'selected' : ''}>Isento (0%)</option>
                  </select>
                </div>

                ${
                  this.editingProduct.ivaRate === 0
                    ? `<div class="col-span-2 sm:col-span-3">
                        <label class="block text-[10px] font-medium text-slate-600 mb-1">Motivo de Isenção (CIVA)</label>
                        <input
                          name="exemptionReason"
                          type="text"
                          list="iva-exemption-reasons-datalist"
                          maxlength="160"
                          value="${escapeHtml(
                            this.editingProduct.exemptionReason || DEFAULT_IVA_EXEMPTION_REASONS[0]
                          )}"
                          placeholder="Selecione ou escreva a menção legal"
                          class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                        <datalist id="iva-exemption-reasons-datalist">
                          ${DEFAULT_IVA_EXEMPTION_REASONS.map(
                            (r) => `<option value="${escapeHtml(r)}"></option>`
                          ).join('')}
                        </datalist>
                      </div>`
                    : `<div class="hidden sm:block sm:col-span-3 text-[11px] text-slate-500 pb-2">
                        Taxa normal de 14% aplicada automaticamente na emissão.
                      </div>`
                }

                <div class="col-span-2 sm:col-span-1 flex items-center gap-1.5">
                  <button
                    type="submit"
                    class="flex-1 h-9 px-2.5 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
                  >Guardar</button>
                  <button
                    type="button"
                    data-action="cancel-edit-product"
                    title="Fechar formulário"
                    class="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                  >${ICONS.close}</button>
                </div>
              </div>

              <div class="pt-2 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-4">
                <div class="flex flex-wrap items-center gap-5">
                  <label class="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      name="active"
                      type="checkbox"
                      ${this.editingProduct.active !== false ? 'checked' : ''}
                      class="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span>Artigo ativo (visível no POS)</span>
                  </label>

                  <label class="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      name="trackStock"
                      type="checkbox"
                      ${this.editingProduct.trackStock ? 'checked' : ''}
                      class="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span>Controlar disponibilidade em stock</span>
                  </label>

                  ${
                    this.editingProduct.trackStock
                      ? `<div class="flex flex-wrap items-center gap-3">
                          <div class="flex items-center gap-1.5">
                            <label class="text-[11px] text-slate-600 whitespace-nowrap">Quantidade disponível:</label>
                            <input
                              name="stockQty"
                              type="text"
                              inputmode="decimal"
                              value="${escapeHtml(this.editingProductStockInput)}"
                              class="w-24 h-8 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div class="flex items-center gap-1.5">
                            <label class="text-[11px] text-slate-600 whitespace-nowrap">Stock mínimo:</label>
                            <input
                              name="minStockQty"
                              type="text"
                              inputmode="decimal"
                              value="${escapeHtml(this.editingProductMinStockInput)}"
                              class="w-20 h-8 px-2 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                        </div>`
                      : ''
                  }
                </div>
              </div>
            </form>
          `
            : ''
        }

        <!-- Vista Master-Detail: Catálogo de Artigos (8 cols) + Ficha Técnica & Histórico de Preços (4 cols) -->
        <div class="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
          <div class="lg:col-span-8 overflow-y-auto border-b lg:border-b-0 lg:border-r border-slate-200">
            <table class="w-full text-left border-collapse">
              <thead class="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500 z-10">
                <tr>
                  <th class="py-2.5 px-3 font-medium">SKU / Barras</th>
                  <th class="py-2.5 px-3 font-medium">Descrição</th>
                  <th class="py-2.5 px-3 font-medium text-right">Stock / Mín.</th>
                  <th class="py-2.5 px-3 font-medium text-right hidden md:table-cell">IVA</th>
                  <th class="py-2.5 px-3 font-medium text-right hidden xl:table-cell">Aquisição</th>
                  <th class="py-2.5 px-3 font-medium text-right">Venda / Margem</th>
                  <th class="py-2.5 px-3 font-medium text-right hidden sm:table-cell">Estado</th>
                  <th class="py-2.5 px-3 font-medium text-right w-28">Ações</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-slate-100 text-xs">
                ${
                  showingSuggestionsOnly
                    ? `<tr class="bg-slate-50/90">
                        <td colspan="8" class="py-2 px-3 text-[11px] text-slate-600">
                          Sem correspondência exata para <strong>${escapeHtml(this.productSearch)}</strong> — sugestões próximas encontradas:
                        </td>
                      </tr>`
                    : ''
                }
                ${
                  filtered.length === 0
                    ? `<tr>
                        <td colspan="8" class="py-10 px-3 text-center text-xs text-slate-500">
                          ${
                            this.products.length === 0
                              ? 'Nenhum artigo ou serviço registado no catálogo desta empresa.'
                              : 'Nenhum artigo corresponde aos filtros atuais.'
                          }
                        </td>
                      </tr>`
                    : filtered
                        .map((p) => {
                          const isSelected = selectedProd?.id === p.id;
                          const isActive = p.active !== false;
                          const qty = p.stockQty ?? 0;
                          const minQty = p.minStockQty ?? 0;
                          const stockCell = !p.trackStock
                            ? `<span class="text-slate-400">Serviço / Livre</span>`
                            : qty <= 0
                              ? `<span class="text-red-600 font-semibold">Sem stock · 0</span>`
                              : qty <= minQty
                                ? `<span class="text-amber-700 font-medium">Baixo · ${qty} / ${minQty}</span>`
                                : `<span class="text-slate-700">${qty}${minQty > 0 ? ` <span class="text-slate-400">/ mín. ${minQty}</span>` : ''}</span>`;

                          const mStats = this.getProductMarginStats(p.price, p.costPrice);
                          const marginSign = mStats.profit >= 0 ? '+' : '';
                          const marginSubline = mStats.hasCost
                            ? `<div class="text-[10px] font-mono tabular-nums ${
                                mStats.belowCost ? 'text-red-600 font-semibold' : 'text-emerald-700'
                              }">${marginSign}${mStats.marginPct.toFixed(1).replace('.', ',')}% (${marginSign}${formatKzNumber(mStats.profit)} Kz)</div>`
                            : '';

                          return `
                          <tr
                            data-action="select-product-detail"
                            data-id="${escapeHtml(p.id)}"
                            class="cursor-pointer transition-colors ${
                              isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50/80'
                            } ${!isActive ? 'opacity-65' : ''}"
                          >
                            <td class="py-2.5 px-3 font-mono tabular-nums">
                              <div class="text-slate-800 font-medium">${escapeHtml(p.code)}</div>
                              ${
                                p.barcode
                                  ? `<div class="text-[10px] text-slate-400 truncate max-w-[130px]" title="Código de barras: ${escapeHtml(p.barcode)}">${escapeHtml(p.barcode)}</div>`
                                  : ''
                              }
                            </td>
                            <td class="py-2.5 px-3">
                              <div class="font-medium text-slate-900">${escapeHtml(p.name)}</div>
                              <div class="text-[11px] text-slate-500">
                                ${escapeHtml(p.category || 'Geral')} · ${escapeHtml(p.unit)}${
                                  p.priceHistory && p.priceHistory.length > 0
                                    ? ` · ${p.priceHistory.length} alt. preço`
                                    : ''
                                }
                              </div>
                            </td>
                            <td class="py-2.5 px-3 text-right font-mono tabular-nums text-[11px]">${stockCell}</td>
                            <td class="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 hidden md:table-cell">
                              ${p.ivaRate === 14 ? '14%' : 'Isento 0%'}
                            </td>
                            <td class="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 hidden xl:table-cell">
                              ${mStats.hasCost ? `${formatKzNumber(mStats.cost)} Kz` : '—'}
                            </td>
                            <td class="py-2.5 px-3 text-right">
                              <div class="font-mono font-semibold tabular-nums text-slate-900">${formatKzNumber(p.price)} Kz</div>
                              ${marginSubline}
                            </td>
                            <td class="py-2.5 px-3 text-right hidden sm:table-cell">
                              <span class="text-[11px] font-medium ${
                                isActive ? 'text-emerald-700' : 'text-slate-400'
                              }">${isActive ? 'Ativo' : 'Inativo'}</span>
                            </td>
                            <td class="py-2 px-3 text-right">
                              ${
                                canManageCat
                                  ? `<div class="inline-flex items-center gap-1">
                                      <button
                                        type="button"
                                        data-action="toggle-product-active"
                                        data-id="${escapeHtml(p.id)}"
                                        title="${isActive ? 'Desativar artigo no POS' : 'Reativar artigo no POS'}"
                                        class="h-8 px-2 inline-flex items-center justify-center rounded-md text-[11px] font-medium border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                                      >${isActive ? 'Inativar' : 'Ativar'}</button>
                                      <button
                                        type="button"
                                        data-action="edit-product"
                                        data-id="${escapeHtml(p.id)}"
                                        title="Editar artigo"
                                        class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                                      >${ICONS.edit}</button>
                                    </div>`
                                  : `<span class="text-[11px] text-slate-400">Consulta</span>`
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

          <!-- Painel Lateral Direito: Ficha Técnica, Rentabilidade, Stock e Histórico de Preços -->
          <div class="lg:col-span-4 bg-slate-50/50 overflow-y-auto">
            ${
              selectedProd && detailMargin
                ? `
                <div class="p-4 space-y-4">
                  <div class="flex items-start justify-between gap-2 pb-3 border-b border-slate-200">
                    <div class="min-w-0">
                      <div class="text-[11px] font-mono text-slate-500 tabular-nums">
                        SKU ${escapeHtml(selectedProd.code)}${
                          selectedProd.barcode ? ` · EAN ${escapeHtml(selectedProd.barcode)}` : ''
                        } · ${selectedProd.active !== false ? 'Ativo no POS' : 'Inativo'}
                      </div>
                      <h3 class="text-sm font-bold text-slate-900 leading-snug mt-0.5">${escapeHtml(
                        selectedProd.name
                      )}</h3>
                      <div class="text-xs text-slate-500 mt-0.5">
                        ${escapeHtml(selectedProd.category || 'Geral')} · Unidade: ${escapeHtml(selectedProd.unit)}
                      </div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0">
                      ${
                        selectedProd.active !== false && !isSuspended
                          ? `<button
                              type="button"
                              data-action="sell-product-in-pos"
                              data-id="${escapeHtml(selectedProd.id)}"
                              class="h-8 px-2.5 rounded-md bg-slate-900 text-white text-[11px] font-semibold hover:bg-slate-800 whitespace-nowrap"
                            >+ Vender</button>`
                          : ''
                      }
                      ${
                        canManageCat
                          ? `<button
                              type="button"
                              data-action="edit-product"
                              data-id="${escapeHtml(selectedProd.id)}"
                              title="Editar ficha completa"
                              class="h-8 w-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                            >${ICONS.edit}</button>`
                          : ''
                      }
                    </div>
                  </div>

                  <!-- Resumo de Preços e Margem de Lucro -->
                  <div class="grid grid-cols-3 gap-2 py-2.5 px-3 bg-white border border-slate-200 rounded-lg">
                    <div>
                      <div class="text-[10px] text-slate-500">Aquisição</div>
                      <div class="text-xs font-mono font-semibold tabular-nums text-slate-800 mt-0.5">
                        ${detailMargin.hasCost ? `${formatKzNumber(detailMargin.cost)} Kz` : 'Não def.'}
                      </div>
                    </div>
                    <div>
                      <div class="text-[10px] text-slate-500">Preço Venda</div>
                      <div class="text-xs font-mono font-bold tabular-nums text-slate-900 mt-0.5">
                        ${formatKzNumber(selectedProd.price)} Kz
                      </div>
                    </div>
                    <div>
                      <div class="text-[10px] text-slate-500">Margem Lucro</div>
                      <div class="text-xs font-mono font-semibold tabular-nums mt-0.5 ${
                        !detailMargin.hasCost
                          ? 'text-slate-400'
                          : detailMargin.belowCost
                            ? 'text-red-600'
                            : 'text-emerald-700'
                      }">
                        ${
                          detailMargin.hasCost
                            ? `${detailMargin.profit >= 0 ? '+' : ''}${detailMargin.marginPct
                                .toFixed(1)
                                .replace('.', ',')}%`
                            : '—'
                        }
                      </div>
                    </div>
                    ${
                      detailMargin.hasCost
                        ? `<div class="col-span-3 pt-2 border-t border-slate-100 flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-600">
                            <span>Lucro unitário: <strong class="${
                              detailMargin.belowCost ? 'text-red-600' : 'text-slate-900'
                            }">${detailMargin.profit >= 0 ? '+' : ''}${formatKzNumber(
                              detailMargin.profit
                            )} Kz/${escapeHtml(selectedProd.unit)}</strong></span>
                            <span>Markup: ${detailMargin.markupPct >= 0 ? '+' : ''}${detailMargin.markupPct
                              .toFixed(1)
                              .replace('.', ',')}%</span>
                          </div>`
                        : ''
                    }
                  </div>

                  <!-- Enquadramento Fiscal (IVA / Isenção) & Stock -->
                  <div class="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs">
                    <div class="p-3 flex items-start justify-between gap-2">
                      <div>
                        <div class="text-[10px] text-slate-500">Enquadramento IVA</div>
                        <div class="font-medium text-slate-900 mt-0.5">
                          ${
                            selectedProd.ivaRate === 14
                              ? 'Taxa Geral · 14%'
                              : 'Isento de IVA · 0%'
                          }
                        </div>
                        ${
                          selectedProd.ivaRate === 0 && selectedProd.exemptionReason
                            ? `<div class="text-[11px] text-slate-500 mt-0.5">${escapeHtml(
                                selectedProd.exemptionReason
                              )}</div>`
                            : ''
                        }
                      </div>
                    </div>

                    <div class="p-3 space-y-2">
                      <div class="flex items-center justify-between gap-2">
                        <div>
                          <div class="text-[10px] text-slate-500">Disponibilidade em Stock</div>
                          <div class="font-mono tabular-nums font-semibold text-slate-900 mt-0.5">
                            ${
                              selectedProd.trackStock
                                ? `${selectedProd.stockQty ?? 0} ${escapeHtml(selectedProd.unit)} · Mínimo: ${
                                    selectedProd.minStockQty ?? 0
                                  } ${escapeHtml(selectedProd.unit)}`
                                : 'Sem controlo de stock (venda livre / serviço)'
                            }
                          </div>
                        </div>
                        ${
                          canManageCat && this.quickStockProductId !== selectedProd.id
                            ? `<button
                                type="button"
                                data-action="open-quick-stock"
                                data-id="${escapeHtml(selectedProd.id)}"
                                class="h-7 px-2.5 rounded border border-slate-200 text-[11px] font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0"
                              >Ajustar stock</button>`
                            : ''
                        }
                      </div>

                      ${
                        this.quickStockProductId === selectedProd.id && canManageCat
                          ? `<form data-form="quick-stock-form" class="pt-1 flex items-center gap-1.5">
                              <input
                                id="quick-stock-qty-input"
                                name="stockQty"
                                type="text"
                                inputmode="decimal"
                                value="${escapeHtml(this.quickStockAdjustInput)}"
                                placeholder="Nova qtd."
                                class="flex-1 h-8 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                              />
                              <button
                                type="submit"
                                class="h-8 px-2.5 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
                              >Guardar</button>
                              <button
                                type="button"
                                data-action="cancel-quick-stock"
                                class="h-8 px-2 rounded-md border border-slate-200 text-xs text-slate-600 hover:bg-slate-100"
                              >Cancelar</button>
                            </form>`
                          : ''
                      }
                    </div>
                  </div>

                  <!-- Histórico de Alterações de Preço -->
                  <div class="space-y-2">
                    <div class="flex items-center justify-between text-xs">
                      <span class="font-semibold text-slate-800">Histórico de alterações de preço</span>
                      <span class="text-[11px] text-slate-400 font-mono tabular-nums">${detailHistory.length} reg.</span>
                    </div>

                    ${
                      detailHistory.length === 0
                        ? `<div class="p-3 bg-white border border-slate-200 rounded-lg text-[11px] text-slate-500">
                            Sem alterações registadas desde o cadastro inicial (${formatKzNumber(
                              selectedProd.price
                            )} Kz).
                          </div>`
                        : `<div class="bg-white border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                            ${detailHistory
                              .map((h) => {
                                const dt = formatDateTimePt(h.changedAtIso);
                                const diff = roundKz(h.newPrice - h.previousPrice);
                                const diffSign = diff >= 0 ? '+' : '';
                                return `
                                  <div class="p-2.5 text-xs space-y-0.5">
                                    <div class="flex items-center justify-between gap-2 font-mono tabular-nums">
                                      <span class="text-slate-500 line-through">${formatKzNumber(h.previousPrice)} Kz</span>
                                      <span class="font-semibold text-slate-900">→ ${formatKzNumber(h.newPrice)} Kz <span class="text-[10px] ${
                                        diff > 0
                                          ? 'text-blue-700'
                                          : diff < 0
                                            ? 'text-amber-700'
                                            : 'text-slate-500'
                                      }">(${diffSign}${formatKzNumber(diff)} Kz)</span></span>
                                    </div>
                                    ${
                                      typeof h.newCost === 'number' || typeof h.previousCost === 'number'
                                        ? `<div class="text-[10px] font-mono tabular-nums text-slate-500">
                                            Aquisição: ${
                                              typeof h.previousCost === 'number'
                                                ? `${formatKzNumber(h.previousCost)} Kz`
                                                : '—'
                                            } → ${
                                              typeof h.newCost === 'number'
                                                ? `${formatKzNumber(h.newCost)} Kz`
                                                : '—'
                                            }
                                          </div>`
                                        : ''
                                    }
                                    <div class="text-[10px] text-slate-400 flex items-center justify-between gap-2 tabular-nums">
                                      <span>${dt.date} ${dt.time}</span>
                                      <span class="truncate">${escapeHtml(h.changedBy || '')}</span>
                                    </div>
                                  </div>
                                `;
                              })
                              .join('')}
                          </div>`
                    }
                  </div>

                  <!-- Ações Administrativas da Ficha -->
                  ${
                    canManageCat
                      ? `<div class="pt-2 border-t border-slate-200 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            data-action="toggle-product-active"
                            data-id="${escapeHtml(selectedProd.id)}"
                            class="h-8 px-2.5 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >${
                            selectedProd.active !== false
                              ? 'Marcar como inativo'
                              : 'Reativar artigo no POS'
                          }</button>

                          ${
                            this.confirmDeleteProductId === selectedProd.id
                              ? `<div class="flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    data-action="delete-product"
                                    data-id="${escapeHtml(selectedProd.id)}"
                                    class="h-8 px-2.5 rounded-md bg-red-600 text-white text-xs font-semibold hover:bg-red-700"
                                  >Confirmar remoção</button>
                                  <button
                                    type="button"
                                    data-action="cancel-delete-product"
                                    class="h-8 px-2 rounded-md border border-slate-200 bg-white text-xs text-slate-600 hover:bg-slate-100"
                                  >Cancelar</button>
                                </div>`
                              : `<button
                                  type="button"
                                  data-action="request-delete-product"
                                  data-id="${escapeHtml(selectedProd.id)}"
                                  class="h-8 px-2.5 rounded-md text-xs text-red-600 hover:bg-red-50 flex items-center gap-1"
                                >
                                  ${ICONS.trash}
                                  <span>Eliminar</span>
                                </button>`
                          }
                        </div>`
                      : ''
                  }
                </div>
              `
                : `<div class="h-full flex items-center justify-center p-6 text-center text-xs text-slate-400">
                    Selecione um artigo na lista para consultar a ficha técnica, margem de lucro, enquadramento de IVA, disponibilidade em stock e histórico de alterações de preço.
                  </div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  // ==================== 5. HISTÓRICO DE FATURAS ====================

  private renderHistoryWorkspace(): string {
    const canCancel = this.canCancelInvoices();
    const isSuspended = this.isCompanySuspended();

    const baseFiltered = filterInvoicesSmart(this.invoices, this.historySearch);
    const openDebtCount = this.invoices.filter(
      (i) => i.status === 'issued' && (i.amountDue || 0) > 0
    ).length;
    const filtered = this.historyDebtOnly
      ? baseFiltered.filter((i) => i.status === 'issued' && (i.amountDue || 0) > 0)
      : baseFiltered;

    const active = filtered.find((i) => i.id === this.selectedHistoryId) || filtered[0] || null;
    let cachedQr = '';
    if (active) {
      const key = `${active.number}|${active.grandTotal.toFixed(2)}|${this.settings.company.nif}`;
      cachedQr = this.qrCache.get(key) || '';
      if (!cachedQr) this.ensureQrForInvoice(active);
    }

    return `
      <div class="h-full grid grid-cols-1 lg:grid-cols-12 overflow-hidden bg-white">
        <div class="lg:col-span-6 flex flex-col border-r border-slate-200 overflow-hidden">
          <div class="p-3 border-b border-slate-200 flex items-center gap-2 shrink-0">
            <div class="relative flex-1 min-w-0">
              <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
              <input
                id="history-search-input"
                type="text"
                data-field="history-search"
                value="${escapeHtml(this.historySearch)}"
                placeholder="Pesquisar n.º de fatura, cliente ou NIF (F2)..."
                class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <button
              type="button"
              data-action="toggle-history-debt-filter"
              class="h-10 px-3 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums ${
                this.historyDebtOnly
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'
              }"
            >Em dívida · ${openDebtCount}</button>
          </div>

          <div class="flex-1 overflow-y-auto divide-y divide-slate-100">
            ${
              filtered.length === 0
                ? `<div class="p-8 text-center text-xs text-slate-500">${
                    this.historyDebtOnly
                      ? 'Nenhuma fatura com saldo em dívida para o filtro atual.'
                      : 'Nenhuma fatura encontrada nesta empresa.'
                  }</div>`
                : filtered
                    .map((inv) => {
                      const dt = formatDateTimePt(inv.issuedAtIso);
                      const isSel = active?.id === inv.id;
                      const due = inv.status === 'issued' ? inv.amountDue || 0 : 0;
                      return `
                        <button
                          type="button"
                          data-action="select-history"
                          data-id="${escapeHtml(inv.id)}"
                          class="w-full text-left p-3.5 transition-colors flex items-center justify-between gap-3 ${
                            isSel ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                          }"
                        >
                          <div class="min-w-0">
                            <div class="flex items-center gap-2 text-xs">
                              <span class="font-bold font-mono text-slate-900 tabular-nums">${escapeHtml(inv.number)}</span>
                              <span class="text-slate-400">·</span>
                              <span class="text-slate-500 tabular-nums">${dt.slashDate} ${dt.time}</span>
                              ${
                                inv.status === 'cancelled'
                                  ? `<span class="text-slate-400">·</span><span class="text-red-600 font-semibold">Anulada</span>`
                                  : due > 0
                                    ? `<span class="text-slate-400">·</span><span class="text-amber-700 font-semibold font-mono tabular-nums">Dívida: ${formatKzNumber(due)} Kz</span>`
                                    : ''
                              }
                            </div>
                            <div class="text-xs text-slate-600 truncate mt-0.5">
                              ${escapeHtml(inv.customerName)} · ${escapeHtml(inv.paymentMethod)}${
                                inv.transferReference ? ` · Ref. ${escapeHtml(inv.transferReference)}` : ''
                              }
                            </div>
                            ${
                              inv.status === 'cancelled' && inv.cancelReason
                                ? `<div class="text-[11px] text-red-600/90 truncate mt-0.5">Motivo: ${escapeHtml(inv.cancelReason)}</div>`
                                : ''
                            }
                          </div>
                          <div class="text-right shrink-0">
                            <div class="text-xs font-bold font-mono text-slate-900 tabular-nums">${formatKzNumber(inv.grandTotal)} Kz</div>
                            <div class="text-[10.5px] text-slate-400 tabular-nums">${inv.lines.length} art.</div>
                          </div>
                        </button>
                      `;
                    })
                    .join('')
            }
          </div>
        </div>

        <div class="lg:col-span-6 flex flex-col bg-slate-100 overflow-hidden">
          ${
            active
              ? `
              <div class="p-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-2 flex-wrap shrink-0">
                <div class="flex items-center bg-slate-100 p-0.5 rounded-lg">
                  <button
                    type="button"
                    data-action="set-history-format"
                    data-value="POS"
                    class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                      this.historyViewFormat === 'POS' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }"
                  >POS 80mm</button>
                  <button
                    type="button"
                    data-action="set-history-format"
                    data-value="A4"
                    class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                      this.historyViewFormat === 'A4' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }"
                  >A4</button>
                </div>

                <div class="flex items-center gap-1.5 flex-wrap">
                  ${
                    active.status !== 'cancelled' && (active.amountDue || 0) > 0
                      ? `<button
                          type="button"
                          data-action="open-settle-debt"
                          data-id="${escapeHtml(active.id)}"
                          ${isSuspended ? 'disabled' : ''}
                          class="h-8 px-2.5 rounded-lg border border-amber-300 bg-amber-50 text-xs font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-40 flex items-center gap-1 whitespace-nowrap"
                        >Liquidar</button>`
                      : ''
                  }
                  ${
                    active.status !== 'cancelled' && active.docType === 'FR'
                      ? `<button
                          type="button"
                          data-action="start-return-exchange"
                          data-id="${escapeHtml(active.id)}"
                          ${isSuspended ? 'disabled' : ''}
                          title="Repor artigos desta fatura em stock e usar crédito numa nova venda"
                          class="h-8 px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1 whitespace-nowrap"
                        >${ICONS.exchange}<span>Troca / Devolução</span></button>`
                      : ''
                  }
                  ${
                    active.status !== 'cancelled' && canCancel
                      ? `<button
                          type="button"
                          data-action="cancel-invoice"
                          data-id="${escapeHtml(active.id)}"
                          class="h-8 px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-red-600 hover:bg-red-50 flex items-center gap-1 whitespace-nowrap"
                        >${ICONS.ban}<span>Anular</span></button>`
                      : ''
                  }
                  <button
                    type="button"
                    data-action="print-history"
                    data-id="${escapeHtml(active.id)}"
                    class="h-8 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                  >${ICONS.printer}<span>Imprimir</span></button>
                </div>
              </div>

              ${
                this.settlingInvoiceId === active.id &&
                active.status !== 'cancelled' &&
                (active.amountDue || 0) > 0
                  ? `<form
                      data-form="settle-debt-form"
                      class="p-3 border-b border-slate-200 bg-amber-50/70 space-y-2 shrink-0"
                    >
                      <div class="flex items-center justify-between text-xs">
                        <span class="font-semibold text-slate-900">Liquidar conta corrente · ${escapeHtml(active.number)}</span>
                        <span class="font-mono text-amber-800 font-semibold tabular-nums">Saldo: ${formatKzNumber(active.amountDue!)} Kz</span>
                      </div>
                      ${
                        this.settleError
                          ? `<div class="p-2 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(this.settleError)}</div>`
                          : ''
                      }
                      <div class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                        <div class="sm:col-span-3">
                          <label class="block text-[10px] text-slate-600 mb-0.5">Valor recebido (Kz)</label>
                          <input
                            name="settleAmount"
                            type="text"
                            inputmode="decimal"
                            required
                            value="${escapeHtml(this.settleAmountInput)}"
                            class="w-full h-8 px-2 text-xs font-mono font-semibold tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="sm:col-span-3">
                          <label class="block text-[10px] text-slate-600 mb-0.5">Meio</label>
                          <select
                            name="settleMethod"
                            class="w-full h-8 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          >
                            <option value="Dinheiro" ${this.settleMethod === 'Dinheiro' ? 'selected' : ''}>Dinheiro</option>
                            <option value="Multicaixa" ${this.settleMethod === 'Multicaixa' ? 'selected' : ''}>Multicaixa</option>
                            <option value="Transferência" ${this.settleMethod === 'Transferência' ? 'selected' : ''}>Transferência</option>
                          </select>
                        </div>
                        <div class="sm:col-span-3">
                          <label class="block text-[10px] text-slate-600 mb-0.5">Referência (opcional)</label>
                          <input
                            name="settleReference"
                            type="text"
                            maxlength="80"
                            value="${escapeHtml(this.settleReference)}"
                            placeholder="Ref. TPA / IBAN"
                            class="w-full h-8 px-2 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                          />
                        </div>
                        <div class="sm:col-span-3 flex items-center gap-1.5">
                          <button
                            type="submit"
                            class="flex-1 h-8 px-2.5 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 whitespace-nowrap"
                          >Confirmar</button>
                          <button
                            type="button"
                            data-action="close-settle-debt"
                            class="h-8 w-8 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                          >${ICONS.close}</button>
                        </div>
                      </div>
                    </form>`
                  : ''
              }

              <div class="flex-1 overflow-y-auto p-4">
                ${renderDocumentHtml(
                  active,
                  this.historyViewFormat,
                  this.settings.company,
                  cachedQr,
                  this.getInvoiceRenderOptions(
                    active,
                    shouldShowViralDocumentFooter(this.activeCompany, this.settings)
                  )
                )}
              </div>
            `
              : `<div class="h-full flex items-center justify-center text-xs text-slate-400">Selecione uma fatura para visualizar ou reimprimir.</div>`
          }
        </div>
      </div>
    `;
  }

  // ==================== 6. CONFIGURAÇÕES, EQUIPA (RBAC) & PLANO COMERCIAL ====================

  private renderSettingsWorkspace(): string {
    const c = this.settings.company;
    const canManage = this.canManageCompanySettings();
    const maxRole = this.getVerifiedMaxRole();
    const effectiveRole = this.getEffectiveRole();
    const roleOptions: CompanyRole[] =
      maxRole === 'owner'
        ? ['owner', 'manager', 'cashier']
        : maxRole === 'manager'
          ? ['manager', 'cashier']
          : ['cashier'];

    return `
      <div class="h-full overflow-y-auto bg-white p-4 sm:p-6">
        <div class="max-w-3xl space-y-8">
          <form data-form="settings-form" class="space-y-6">
            <div class="flex items-center justify-between gap-3 pb-3 border-b border-slate-200">
              <div>
                <h1 class="text-sm font-bold text-slate-900">Configurações da Empresa</h1>
                <p class="text-xs text-slate-500">Identidade fiscal, série documental e predefinições POS / A4.</p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-action="reset-settings"
                  ${!canManage ? 'disabled' : ''}
                  class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.reset}
                  <span>Repor padrão</span>
                </button>
                <button
                  type="submit"
                  ${!canManage ? 'disabled' : ''}
                  class="h-9 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.check}
                  <span>${this.settingsSavedNotice ? 'Guardado' : 'Guardar'}</span>
                </button>
              </div>
            </div>

            ${
              this.settingsErrorMessage
                ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
                    this.settingsErrorMessage
                  )}</div>`
                : ''
            }

            ${
              !canManage
                ? `<div class="p-3 rounded-lg border border-slate-200 bg-slate-50 text-xs text-slate-600">
                    Modo de leitura para o perfil <strong>${escapeHtml(
                      formatRoleLabelPt(effectiveRole)
                    )}</strong>. Apenas o Proprietário pode alterar os dados fiscais da empresa.
                  </div>`
                : ''
            }

            <section class="space-y-3">
              <h2 class="text-xs font-semibold text-slate-900">Identidade Empresarial (1 NIF = 1 Empresa)</h2>
              <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                <div class="sm:col-span-8">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Designação Social</label>
                  <input name="legalName" type="text" required maxlength="160" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalName)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-4">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Nome Curto / Marca</label>
                  <input name="shortName" type="text" required maxlength="64" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.shortName)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-4">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">NIF (Contribuinte Único)</label>
                  <input name="nif" type="text" required maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.nif)}" class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-4">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Telefone</label>
                  <input name="phone" type="text" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.phone)}" class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-4">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Email</label>
                  <input name="email" type="email" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.email)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-5">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Endereço Fiscal</label>
                  <input name="address" type="text" required maxlength="160" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.address)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-3">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Localidade / País</label>
                  <input name="cityCountry" type="text" required maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.cityCountry || 'Angola')}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="sm:col-span-4">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Assinatura / Rodapé</label>
                  <input name="tagline" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.tagline)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
              </div>
            </section>

            <section class="space-y-3 pt-4 border-t border-slate-200">
              <h2 class="text-xs font-semibold text-slate-900">Caixa e Emissão</h2>
              <div class="grid grid-cols-2 sm:grid-cols-12 gap-3">
                <div class="col-span-1 sm:col-span-3">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Caixa Padrão</label>
                  <input name="defaultCashier" type="text" required maxlength="16" ${!canManage ? 'disabled' : ''} value="${escapeHtml(this.settings.defaultCashier)}" class="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="col-span-1 sm:col-span-3">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Operador(a) Padrão</label>
                  <input name="defaultOperator" type="text" required maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(this.settings.defaultOperator)}" class="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="col-span-1 sm:col-span-3">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Tipo de Documento</label>
                  <select name="defaultDocType" ${!canManage ? 'disabled' : ''} class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60">
                    <option value="FR" ${this.settings.defaultDocType === 'FR' ? 'selected' : ''}>Factura / Recibo</option>
                    <option value="FP" ${this.settings.defaultDocType === 'FP' ? 'selected' : ''}>Factura Proforma</option>
                  </select>
                </div>
                <div class="col-span-1 sm:col-span-3">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Formato Preferencial</label>
                  <select name="defaultFormat" ${!canManage ? 'disabled' : ''} class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60">
                    <option value="POS" ${this.settings.defaultFormat === 'POS' ? 'selected' : ''}>POS Térmico 80mm</option>
                    <option value="A4" ${this.settings.defaultFormat === 'A4' ? 'selected' : ''}>Fatura A4</option>
                  </select>
                </div>
                <div class="col-span-2 sm:col-span-8">
                  <label class="block text-[11px] font-medium text-slate-600 mb-1">Observação Padrão</label>
                  <input name="defaultNotes" type="text" maxlength="300" ${!canManage ? 'disabled' : ''} value="${escapeHtml(this.settings.defaultNotes)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600 disabled:opacity-60" />
                </div>
                <div class="col-span-2 sm:col-span-4 flex items-end">
                  <label class="flex items-center gap-2 h-9 text-xs text-slate-700 cursor-pointer select-none">
                    <input name="autoPrintOnEmit" type="checkbox" ${!canManage ? 'disabled' : ''} ${this.settings.autoPrintOnEmit ? 'checked' : ''} class="h-4 w-4 rounded border-slate-300 text-blue-600" />
                    <span>Imprimir ao clicar em Emitir</span>
                  </label>
                </div>
                <div class="col-span-2 sm:col-span-12 pt-1 space-y-2">
                  <label class="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      name="allowCashierPriceEdit"
                      type="checkbox"
                      ${!canManage ? 'disabled' : ''}
                      ${this.settings.allowCashierPriceEdit ? 'checked' : ''}
                      class="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span>Autorizar Operadores de Caixa a alterar o preço unitário no POS (por defeito apenas Proprietário e Gerente)</span>
                  </label>
                  <label class="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                    <input
                      name="hidePromotionalFooter"
                      type="checkbox"
                      data-field="toggle-clean-footer"
                      ${!canManage ? 'disabled' : ''}
                      ${!shouldShowViralDocumentFooter(this.activeCompany, this.settings) ? 'checked' : ''}
                      class="h-4 w-4 rounded border-slate-300 text-blue-600"
                    />
                    <span>Emitir talões POS 80mm e faturas A4 sem a linha institucional "Processado por SILA-Billing · VITRONIS"</span>
                  </label>
                </div>
              </div>
            </section>
          </form>

          <!-- Permissões por Empresa e Perfil Operacional no Terminal -->
          <section class="space-y-4 pt-6 border-t border-slate-200">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 class="text-xs font-semibold text-slate-900">Permissões e Equipa da Empresa</h2>
                <p class="text-xs text-slate-500">
                  Emissão POS/A4 ativa · ${this.canManageCatalog() ? 'Gestão de catálogo autorizada' : 'Catálogo em leitura'} · ${
                    this.canCancelInvoices() ? 'Anulação com justificação autorizada' : 'Anulação bloqueada'
                  }
                </p>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <label class="text-[11px] text-slate-600 whitespace-nowrap" for="terminal-role-select">Modo no terminal:</label>
                <select
                  id="terminal-role-select"
                  data-field="terminal-role-select"
                  class="h-8 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                >
                  ${roleOptions
                    .map(
                      (r) =>
                        `<option value="${r}" ${effectiveRole === r ? 'selected' : ''}>${escapeHtml(
                          formatRoleLabelPt(r)
                        )}</option>`
                    )
                    .join('')}
                </select>
              </div>
            </div>

            <label class="flex items-center gap-2 text-xs text-slate-700 select-none ${canManage ? 'cursor-pointer' : 'opacity-60'}">
              <input
                type="checkbox"
                data-field="company-allow-manager-cancel"
                ${!canManage ? 'disabled' : ''}
                ${this.activeCompany.allowManagerCancel ? 'checked' : ''}
                class="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              <span>Permitir que Gerentes anulem faturas emitidas mediante justificação obrigatória</span>
            </label>

            ${
              this.memberFormError
                ? `<div class="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(
                    this.memberFormError
                  )}</div>`
                : ''
            }

            <div class="border border-slate-200 rounded-lg overflow-hidden">
              <table class="w-full text-left border-collapse text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                  <tr>
                    <th class="py-2 px-3 font-medium">Colaborador</th>
                    <th class="py-2 px-3 font-medium">Email</th>
                    <th class="py-2 px-3 font-medium">Perfil</th>
                    <th class="py-2 px-3 font-medium">Anulação</th>
                    <th class="py-2 px-3 font-medium text-right w-16">Ação</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100">
                  ${
                    this.members.length === 0
                      ? `<tr><td colspan="5" class="py-4 px-3 text-xs text-slate-500">Proprietário local ativo nesta empresa. Adicione gerentes ou operadores abaixo quando necessário.</td></tr>`
                      : this.members
                          .map(
                            (m) => `
                            <tr>
                              <td class="py-2 px-3 font-medium text-slate-900">${escapeHtml(m.displayName)}</td>
                              <td class="py-2 px-3 font-mono text-slate-600">${escapeHtml(m.email)}</td>
                              <td class="py-2 px-3 text-slate-700">${escapeHtml(formatRoleLabelPt(m.role))}</td>
                              <td class="py-2 px-3 text-slate-500">${
                                m.role === 'owner' ||
                                (m.role === 'manager' &&
                                  (this.activeCompany.allowManagerCancel || m.allowInvoiceCancel))
                                  ? 'Autorizada'
                                  : 'Não'
                              }</td>
                              <td class="py-2 px-3 text-right">
                                ${
                                  canManage && m.role !== 'owner'
                                    ? `<button
                                        type="button"
                                        data-action="remove-company-member"
                                        data-id="${escapeHtml(m.id)}"
                                        title="Remover colaborador"
                                        class="h-7 w-7 inline-flex items-center justify-center rounded text-slate-400 hover:text-red-600 hover:bg-red-50"
                                      >${ICONS.trash}</button>`
                                    : `<span class="text-[11px] text-slate-400">—</span>`
                                }
                              </td>
                            </tr>
                          `
                          )
                          .join('')
                  }
                </tbody>
              </table>
            </div>

            ${
              canManage
                ? `<form data-form="add-member-form" class="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
                    <div class="sm:col-span-4">
                      <label class="block text-[10px] font-medium text-slate-600 mb-1">Nome do colaborador</label>
                      <input name="displayName" type="text" required maxlength="120" placeholder="Ex: Maria Manuel" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
                    </div>
                    <div class="sm:col-span-4">
                      <label class="block text-[10px] font-medium text-slate-600 mb-1">Email autenticado</label>
                      <input name="email" type="email" required maxlength="120" placeholder="operador@empresa.ao" class="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
                    </div>
                    <div class="sm:col-span-2">
                      <label class="block text-[10px] font-medium text-slate-600 mb-1">Perfil</label>
                      <select name="role" class="w-full h-9 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600">
                        <option value="cashier">Caixa</option>
                        <option value="manager">Gerente</option>
                      </select>
                    </div>
                    <div class="sm:col-span-2">
                      <button type="submit" class="w-full h-9 px-3 rounded-md bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 whitespace-nowrap">Adicionar</button>
                    </div>
                    <div class="sm:col-span-12">
                      <label class="inline-flex items-center gap-2 text-[11px] text-slate-600 cursor-pointer select-none">
                        <input name="allowInvoiceCancel" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-300 text-blue-600" />
                        <span>Autorizar este Gerente individualmente a anular faturas</span>
                      </label>
                    </div>
                  </form>`
                : ''
            }
          </section>

          <!-- Entidade Institucional & Recursos Empresariais -->
          <section class="space-y-3 pt-6 border-t border-slate-200">
            <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 class="text-xs font-semibold text-slate-900">Informação Institucional e Suporte Oficial</h2>
                <p class="text-xs text-slate-500">O SILA-Billing é dependência institucional da VITRONIS para efeitos comerciais e de relações públicas.</p>
              </div>
              <button
                type="button"
                data-action="open-growth-modal"
                data-value="cloud_protection"
                class="h-8 px-3 rounded-md border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap self-start sm:self-auto"
              >Recursos empresariais e Cloud</button>
            </div>
            <div class="p-4 rounded-lg border border-slate-200 bg-slate-50/70 space-y-2 text-xs">
              <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <span class="font-bold text-slate-900">${escapeHtml(VITRONIS_INSTITUTIONAL.legalName)}</span>
                <span class="font-mono text-slate-600 tabular-nums">Contribuinte: ${escapeHtml(VITRONIS_INSTITUTIONAL.nif)}</span>
              </div>
              <div class="text-[11px] text-slate-600">
                ${escapeHtml(VITRONIS_INSTITUTIONAL.address)} · ${escapeHtml(VITRONIS_INSTITUTIONAL.city)}
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 tabular-nums">
                <span>Tel: ${escapeHtml(VITRONIS_INSTITUTIONAL.phone)}</span>
                <span aria-hidden="true">·</span>
                <span>E-mail: ${escapeHtml(VITRONIS_INSTITUTIONAL.email)}</span>
                <span aria-hidden="true">·</span>
                <a href="${escapeHtml(VITRONIS_INSTITUTIONAL.websiteUrl)}" target="_blank" rel="noopener noreferrer" class="text-blue-600 hover:underline">${escapeHtml(VITRONIS_INSTITUTIONAL.website)}</a>
              </div>
              ${
                hasPaidCommercialEntitlement(this.activeCompany)
                  ? `<div class="pt-2 border-t border-slate-200/80 text-[11px] text-emerald-700 font-medium">
                      Licença ativa nesta empresa: ${escapeHtml(formatPlanLabelPt(this.activeCompany.plan.planTier))}
                    </div>`
                  : ''
              }
            </div>
          </section>
        </div>
      </div>
    `;
  }

  // ==================== 4. CAIXA E PAGAMENTOS (TURNOS, GAVETA, SANGRIA, REFORÇO E FECHO) ====================

  private renderPosQuickCashBar(isSuspended: boolean): string {
    const openSession = this.getActiveOpenCashSession();
    const liveSummary = openSession
      ? calculateCashSessionSummary(openSession, this.invoices, this.cashMovements)
      : null;
    const opSuggestions = this.getOperatorSuggestions();

    return `
      <div class="px-3 py-2 border-b border-slate-200 bg-slate-50/80 space-y-2 shrink-0">
        <div class="flex items-center justify-between gap-2 text-[11px]">
          ${
            openSession && liveSummary
              ? `<div class="min-w-0 flex items-center gap-1.5 text-slate-700 font-mono tabular-nums truncate">
                  <span class="font-semibold text-emerald-700">Caixa ${escapeHtml(openSession.cashier)}</span>
                  <span aria-hidden="true" class="text-slate-300">·</span>
                  <span class="truncate">Op. ${escapeHtml(openSession.operator)}</span>
                  <span aria-hidden="true" class="text-slate-300">·</span>
                  <span class="font-semibold text-slate-900">Gaveta: ${formatKzNumber(liveSummary.expectedCash)} Kz</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-action="toggle-pos-quick-cash"
                    data-value="REFORCO"
                    ${isSuspended ? 'disabled' : ''}
                    title="Registar reforço de trocos na gaveta"
                    class="h-7 px-2 rounded border text-[11px] font-medium transition-colors whitespace-nowrap ${
                      this.posQuickCashPanel === 'REFORCO'
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                    }"
                  >+ Reforço</button>
                  <button
                    type="button"
                    data-action="toggle-pos-quick-cash"
                    data-value="SANGRIA"
                    ${isSuspended ? 'disabled' : ''}
                    title="Registar sangria (retirada para cofre)"
                    class="h-7 px-2 rounded border text-[11px] font-medium transition-colors whitespace-nowrap ${
                      this.posQuickCashPanel === 'SANGRIA'
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                    }"
                  >- Sangria</button>
                  <button
                    type="button"
                    data-action="nav"
                    data-value="CASH"
                    title="Abrir módulo completo de Caixa e Pagamentos"
                    class="h-7 px-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 text-[11px] font-medium whitespace-nowrap"
                  >Fecho / Caixa</button>
                </div>`
              : `<div class="min-w-0 flex items-center gap-1.5 text-slate-600 truncate">
                  <span class="font-medium text-amber-800">Sem turno aberto</span>
                  <span aria-hidden="true" class="text-slate-300">·</span>
                  <span class="font-mono tabular-nums truncate">Caixa ${escapeHtml(this.cashier)} · Op. ${escapeHtml(this.operator)}</span>
                </div>
                <div class="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    data-action="toggle-pos-quick-cash"
                    data-value="OPEN"
                    ${isSuspended ? 'disabled' : ''}
                    class="h-7 px-2.5 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold transition-colors whitespace-nowrap disabled:opacity-40"
                  >Abrir Caixa</button>
                  <button
                    type="button"
                    data-action="nav"
                    data-value="CASH"
                    class="h-7 px-2 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-100 text-[11px] font-medium whitespace-nowrap"
                  >Ver Caixa</button>
                </div>`
          }
        </div>

        ${
          this.posQuickCashPanel === 'OPEN'
            ? `<form data-form="pos-quick-open-cash-form" class="p-2 rounded-lg border border-slate-200 bg-white space-y-2">
                <div class="flex items-center justify-between text-[11px] font-semibold text-slate-800">
                  <span>Abertura rápida de caixa com fundo inicial</span>
                  <button type="button" data-action="toggle-pos-quick-cash" data-value="OPEN" class="text-slate-400 hover:text-slate-700">${ICONS.close}</button>
                </div>
                ${
                  this.posQuickCashError
                    ? `<div class="p-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(this.posQuickCashError)}</div>`
                    : ''
                }
                <div class="grid grid-cols-12 gap-1.5">
                  <div class="col-span-3">
                    <input
                      name="cashier"
                      type="text"
                      maxlength="16"
                      required
                      value="${escapeHtml(this.cashOpenDraft.cashier)}"
                      placeholder="Caixa (01)"
                      class="w-full h-8 px-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div class="col-span-4">
                    <input
                      name="operator"
                      type="text"
                      list="pos-operator-datalist"
                      maxlength="32"
                      required
                      value="${escapeHtml(this.cashOpenDraft.operator)}"
                      placeholder="Operador *"
                      class="w-full h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                    />
                    <datalist id="pos-operator-datalist">
                      ${opSuggestions.map((op) => `<option value="${escapeHtml(op)}"></option>`).join('')}
                    </datalist>
                  </div>
                  <div class="col-span-5 flex items-center gap-1.5">
                    <input
                      name="openingFloat"
                      type="text"
                      inputmode="decimal"
                      value="${escapeHtml(this.cashOpenDraft.openingFloat)}"
                      placeholder="Fundo inicial (Kz)"
                      class="flex-1 min-w-0 h-8 px-2 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                    />
                    <button
                      type="submit"
                      class="h-8 px-2.5 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                    >Confirmar</button>
                  </div>
                </div>
              </form>`
            : ''
        }

        ${
          (this.posQuickCashPanel === 'REFORCO' || this.posQuickCashPanel === 'SANGRIA') && openSession
            ? `<form data-form="pos-quick-movement-form" class="p-2 rounded-lg border border-slate-200 bg-white space-y-2">
                <input type="hidden" name="movementType" value="${this.posQuickCashPanel}" />
                <div class="flex items-center justify-between text-[11px] font-semibold text-slate-800">
                  <span>${this.posQuickCashPanel === 'REFORCO' ? 'Reforço rápido de caixa (entrada de trocos)' : 'Sangria rápida de caixa (retirada para cofre)'}</span>
                  <button type="button" data-action="toggle-pos-quick-cash" data-value="${this.posQuickCashPanel}" class="text-slate-400 hover:text-slate-700">${ICONS.close}</button>
                </div>
                ${
                  this.posQuickCashError
                    ? `<div class="p-1.5 rounded bg-red-50 border border-red-200 text-[11px] text-red-700">${escapeHtml(this.posQuickCashError)}</div>`
                    : ''
                }
                <div class="grid grid-cols-12 gap-1.5">
                  <div class="col-span-4">
                    <input
                      name="amount"
                      type="text"
                      inputmode="decimal"
                      required
                      value="${escapeHtml(this.posQuickCashAmount)}"
                      placeholder="Valor Kz *"
                      class="w-full h-8 px-2 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div class="col-span-8 flex items-center gap-1.5">
                    <input
                      name="reason"
                      type="text"
                      maxlength="240"
                      required
                      value="${escapeHtml(this.posQuickCashReason)}"
                      placeholder="Motivo / destino *"
                      class="flex-1 min-w-0 h-8 px-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                    />
                    <button
                      type="submit"
                      class="h-8 px-2.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                    >Registar</button>
                  </div>
                </div>
              </form>`
            : ''
        }
      </div>
    `;
  }

  private renderCashWorkspace(): string {
    const isSuspended = this.isCompanySuspended();
    const openSession = this.getActiveOpenCashSession();
    const selectedSession =
      this.cashSessions.find((s) => s.id === this.selectedCashSessionId) ||
      openSession ||
      this.cashSessions[0] ||
      null;

    const parsedLiveCounted =
      selectedSession &&
      selectedSession.status === 'open' &&
      this.activeCashActionPanel === 'CLOSE' &&
      this.cashCloseCountedInput.trim() !== ''
        ? parseDecimalInput(this.cashCloseCountedInput)
        : null;
    const validLiveCounted =
      parsedLiveCounted !== null && !Number.isNaN(parsedLiveCounted) && parsedLiveCounted >= 0
        ? parsedLiveCounted
        : null;

    const summary = selectedSession
      ? calculateCashSessionSummary(
          selectedSession,
          this.invoices,
          this.cashMovements,
          validLiveCounted
        )
      : null;

    // Controlo acumulado de diferenças de caixa nos turnos encerrados
    const closedSessions = this.cashSessions.filter((s) => s.status === 'closed');
    let exactClosures = 0;
    let totalOverage = 0;
    let totalShortage = 0;
    for (const cs of closedSessions) {
      const d = roundKz(Number(cs.differenceAmount) || 0);
      if (Math.abs(d) < 0.005) exactClosures += 1;
      else if (d > 0) totalOverage = roundKz(totalOverage + d);
      else totalShortage = roundKz(totalShortage + Math.abs(d));
    }
    const netDiscrepancy = roundKz(totalOverage - totalShortage);

    // Construção do Histórico Cronológico Unificado de Movimentos do turno selecionado (ou global se sem turno)
    interface UnifiedLedgerRow {
      id: string;
      iso: string;
      kind: 'ABERTURA' | 'VENDA' | 'LIQUIDACAO' | 'REFORCO' | 'SANGRIA' | 'ENTRADA' | 'SAIDA' | 'FECHO';
      label: string;
      method: string;
      operatorInfo: string;
      detail: string;
      amount: number;
      direction: 'IN' | 'OUT' | 'NEUTRAL';
      affectsDrawer: boolean;
      cancelled?: boolean;
    }

    const ledgerRows: UnifiedLedgerRow[] = [];

    if (selectedSession) {
      ledgerRows.push({
        id: `open_${selectedSession.id}`,
        iso: selectedSession.openedAtIso,
        kind: 'ABERTURA',
        label: 'Abertura de caixa (Fundo inicial)',
        method: 'Dinheiro',
        operatorInfo: `Cx ${selectedSession.cashier} · Op. ${selectedSession.operator}`,
        detail: selectedSession.openingNotes || 'Início de turno com fundo de maneio em gaveta',
        amount: selectedSession.openingFloat,
        direction: 'IN',
        affectsDrawer: true,
      });

      for (const inv of this.invoices) {
        if (!doesInvoiceBelongToSession(inv, selectedSession)) continue;
        const br = extractInvoiceSaleReceipts(inv);
        const isCancelled = inv.status === 'cancelled';
        const methodDisplay =
          inv.paymentMethod === 'Combinado' && inv.paymentSummary
            ? `Combinado (${inv.paymentSummary.split('+ Liq.')[0]?.trim() || ''})`
            : inv.paymentMethod;
        ledgerRows.push({
          id: `inv_${inv.id}`,
          iso: inv.issuedAtIso,
          kind: 'VENDA',
          label: `${inv.number}${isCancelled ? ' · Anulada' : ''}`,
          method: methodDisplay,
          operatorInfo: `Cx ${inv.cashier} · Op. ${inv.operator}`,
          detail: `${inv.customerName}${br.credit > 0 && !isCancelled ? ` · Em dívida: ${formatKzNumber(br.credit)} Kz` : ''}${inv.transferReference ? ` · Ref: ${inv.transferReference}` : ''}`,
          amount: inv.paymentMethod === 'Crédito' && br.netReceived === 0 ? br.credit : br.netReceived,
          direction: isCancelled || (inv.paymentMethod === 'Crédito' && br.netReceived === 0) ? 'NEUTRAL' : 'IN',
          affectsDrawer: !isCancelled && br.cash > 0,
          cancelled: isCancelled,
        });
      }

      for (const mov of this.cashMovements) {
        if (mov.sessionId !== selectedSession.id) continue;
        const isOut = mov.type === 'SANGRIA' || mov.type === 'SAIDA';
        const kindMap: Record<CashMovementType, UnifiedLedgerRow['kind']> = {
          REFORCO: 'REFORCO',
          SANGRIA: 'SANGRIA',
          ENTRADA: 'ENTRADA',
          SAIDA: 'SAIDA',
          LIQUIDACAO_DIVIDA: 'LIQUIDACAO',
        };
        const titleMap: Record<CashMovementType, string> = {
          REFORCO: 'Reforço de caixa',
          SANGRIA: 'Sangria de caixa',
          ENTRADA: 'Entrada de dinheiro',
          SAIDA: 'Saída / Despesa',
          LIQUIDACAO_DIVIDA: `Liquidação de dívida${mov.invoiceNumber ? ` · ${mov.invoiceNumber}` : ''}`,
        };
        ledgerRows.push({
          id: mov.id,
          iso: mov.createdAtIso,
          kind: kindMap[mov.type],
          label: titleMap[mov.type],
          method: mov.paymentMethod,
          operatorInfo: `Cx ${mov.cashier} · Op. ${mov.operator}`,
          detail: `${mov.reason}${mov.customerName ? ` · ${mov.customerName}` : ''}${mov.reference ? ` · Ref: ${mov.reference}` : ''}`,
          amount: mov.amount,
          direction: isOut ? 'OUT' : 'IN',
          affectsDrawer: mov.paymentMethod === 'Dinheiro' || mov.type === 'SANGRIA' || mov.type === 'SAIDA',
        });
      }

      if (selectedSession.status === 'closed' && selectedSession.closedAtIso) {
        const closedDiff = selectedSession.differenceAmount ?? 0;
        const closedNote =
          Math.abs(closedDiff) < 0.005
            ? 'Conferido sem diferenças (0,00 Kz)'
            : closedDiff > 0
              ? `Sobra: +${formatKzNumber(closedDiff)} Kz`
              : `Quebra: ${formatKzNumber(closedDiff)} Kz`;
        ledgerRows.push({
          id: `close_${selectedSession.id}`,
          iso: selectedSession.closedAtIso,
          kind: 'FECHO',
          label: 'Fecho de caixa por operador',
          method: 'Conferência',
          operatorInfo: `Cx ${selectedSession.cashier} · Conf. ${selectedSession.closedByOperator || selectedSession.operator}`,
          detail: `${closedNote}${selectedSession.closingNotes ? ` · ${selectedSession.closingNotes}` : ''}`,
          amount: selectedSession.countedCash ?? 0,
          direction: 'NEUTRAL',
          affectsDrawer: true,
        });
      }
    } else {
      // Movimentos avulsos (ex: liquidações de dívida registadas sem turno aberto)
      for (const mov of this.cashMovements) {
        const isOut = mov.type === 'SANGRIA' || mov.type === 'SAIDA';
        ledgerRows.push({
          id: mov.id,
          iso: mov.createdAtIso,
          kind: mov.type === 'LIQUIDACAO_DIVIDA' ? 'LIQUIDACAO' : mov.type,
          label: mov.type === 'LIQUIDACAO_DIVIDA' ? 'Liquidação de dívida' : mov.type,
          method: mov.paymentMethod,
          operatorInfo: `Cx ${mov.cashier} · Op. ${mov.operator}`,
          detail: `${mov.reason}${mov.reference ? ` · Ref: ${mov.reference}` : ''}`,
          amount: mov.amount,
          direction: isOut ? 'OUT' : 'IN',
          affectsDrawer: mov.paymentMethod === 'Dinheiro',
        });
      }
    }

    ledgerRows.sort((a, b) => b.iso.localeCompare(a.iso));

    const queryLower = this.cashLedgerSearch.trim().toLowerCase();
    const filteredLedger = ledgerRows.filter((row) => {
      if (this.cashLedgerFilter === 'DRAWER') {
        if (row.kind === 'VENDA') return false;
      } else if (this.cashLedgerFilter === 'SALES') {
        if (row.kind !== 'VENDA' && row.kind !== 'LIQUIDACAO') return false;
      } else if (this.cashLedgerFilter === 'INFLOWS') {
        if (row.direction !== 'IN' || row.cancelled) return false;
      } else if (this.cashLedgerFilter === 'OUTFLOWS') {
        if (row.direction !== 'OUT') return false;
      }
      if (!queryLower) return true;
      return (
        row.label.toLowerCase().includes(queryLower) ||
        row.detail.toLowerCase().includes(queryLower) ||
        row.method.toLowerCase().includes(queryLower) ||
        row.operatorInfo.toLowerCase().includes(queryLower)
      );
    });

    const opSuggestions = this.getOperatorSuggestions();
    const denoms = [5000, 2000, 1000, 500, 200, 100, 50];

    const renderDiffStatusText = (diff: number | null): string => {
      if (diff === null) return `<span class="text-slate-500">Contagem pendente</span>`;
      if (Math.abs(diff) < 0.005) {
        return `<span class="text-emerald-700 font-semibold">Conferido · 0,00 Kz</span>`;
      }
      if (diff > 0) {
        return `<span class="text-amber-700 font-semibold">Sobra · +${formatKzNumber(diff)} Kz</span>`;
      }
      return `<span class="text-red-700 font-semibold">Quebra · ${formatKzNumber(diff)} Kz</span>`;
    };

    return `
      <div class="h-full grid grid-cols-1 lg:grid-cols-12 overflow-hidden bg-slate-50/50">
        <!-- COLUNA ESQUERDA: Turnos por Operador + Controlo Acumulado de Diferenças -->
        <aside class="lg:col-span-4 xl:col-span-3 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white flex flex-col overflow-hidden max-h-[38dvh] lg:max-h-none">
          <div class="p-3.5 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
            <div class="min-w-0">
              <h1 class="text-sm font-bold text-slate-900 truncate">Caixa e Pagamentos</h1>
              <p class="text-[11px] text-slate-500 truncate">Turnos, fundo, sangria e fecho por operador</p>
            </div>
            <button
              type="button"
              data-action="open-cash-panel"
              data-value="OPEN"
              ${isSuspended ? 'disabled' : ''}
              class="h-9 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
            >
              ${ICONS.plus}
              <span>Abrir Caixa</span>
            </button>
          </div>

          <!-- Resumo acumulado de controlo de diferenças -->
          <div class="px-3.5 py-2.5 border-b border-slate-200 bg-slate-50/70 space-y-1 text-[11px] tabular-nums shrink-0">
            <div class="flex items-center justify-between text-slate-600">
              <span>Controlo de diferenças (${closedSessions.length} ${closedSessions.length === 1 ? 'fecho' : 'fechos'})</span>
              <span class="font-mono font-semibold ${
                Math.abs(netDiscrepancy) < 0.005
                  ? 'text-emerald-700'
                  : netDiscrepancy > 0
                    ? 'text-amber-700'
                    : 'text-red-700'
              }">${netDiscrepancy > 0 ? '+' : ''}${formatKzNumber(netDiscrepancy)} Kz</span>
            </div>
            <div class="flex items-center justify-between text-[10.5px] text-slate-500 font-mono">
              <span>Certos: ${exactClosures}</span>
              <span>·</span>
              <span class="text-amber-700">Sobras: +${formatKzNumber(totalOverage)}</span>
              <span>·</span>
              <span class="text-red-700">Quebras: -${formatKzNumber(totalShortage)}</span>
            </div>
          </div>

          <div class="flex-1 overflow-y-auto divide-y divide-slate-100">
            ${
              this.cashSessions.length === 0
                ? `<div class="p-6 text-center space-y-2">
                    <p class="text-xs text-slate-600 font-medium">Nenhum turno de caixa aberto ou encerrado.</p>
                    <p class="text-[11px] text-slate-500">Abra o turno com o fundo inicial para controlar entradas, saídas, sangrias, reforços e fecho por operador.</p>
                  </div>`
                : this.cashSessions
                    .map((sess) => {
                      const isSel = selectedSession?.id === sess.id;
                      const dtOpen = formatDateTimePt(sess.openedAtIso);
                      const sessSum =
                        sess.status === 'open'
                          ? calculateCashSessionSummary(sess, this.invoices, this.cashMovements)
                          : null;
                      const displayCash =
                        sess.status === 'open'
                          ? sessSum?.expectedCash ?? sess.openingFloat
                          : sess.countedCash ?? sess.expectedCash ?? 0;
                      const diff = sess.status === 'closed' ? sess.differenceAmount ?? 0 : null;

                      return `
                        <button
                          type="button"
                          data-action="select-cash-session"
                          data-id="${escapeHtml(sess.id)}"
                          class="w-full p-3 text-left transition-colors space-y-1 ${
                            isSel ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                          }"
                        >
                          <div class="flex items-center justify-between gap-2 text-xs">
                            <span class="font-semibold text-slate-900 truncate">
                              Caixa ${escapeHtml(sess.cashier)} · Op. ${escapeHtml(sess.operator)}
                            </span>
                            <span class="text-[11px] font-medium shrink-0 ${
                              sess.status === 'open' ? 'text-emerald-700' : 'text-slate-500'
                            }">
                              ${sess.status === 'open' ? 'Em aberto' : 'Fechado'}
                            </span>
                          </div>
                          <div class="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-500">
                            <span>${dtOpen.slashDate} ${dtOpen.time}</span>
                            <span class="font-semibold text-slate-800">${formatKzNumber(displayCash)} Kz</span>
                          </div>
                          ${
                            diff !== null
                              ? `<div class="text-[10.5px] font-mono tabular-nums">
                                  ${
                                    Math.abs(diff) < 0.005
                                      ? `<span class="text-emerald-700">Conferido (0,00 Kz)</span>`
                                      : diff > 0
                                        ? `<span class="text-amber-700">Sobra: +${formatKzNumber(diff)} Kz</span>`
                                        : `<span class="text-red-700">Quebra: ${formatKzNumber(diff)} Kz</span>`
                                  }
                                </div>`
                              : `<div class="text-[10.5px] text-slate-500 font-mono tabular-nums">Fundo inicial: ${formatKzNumber(sess.openingFloat)} Kz</div>`
                          }
                        </button>
                      `;
                    })
                    .join('')
            }
          </div>
        </aside>

        <!-- COLUNA PRINCIPAL: Operações de Gaveta, Separação por Método, Conferência e Histórico -->
        <section class="lg:col-span-8 xl:col-span-9 flex flex-col overflow-y-auto p-4 sm:p-5 space-y-5">
          ${
            this.cashWorkspaceNotice
              ? `<div class="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-xs text-emerald-800 font-medium flex items-center justify-between gap-2">
                  <span>${escapeHtml(this.cashWorkspaceNotice)}</span>
                </div>`
              : ''
          }

          <!-- Formulário de Abertura de Caixa (quando acionado ou quando não há turnos) -->
          ${
            this.activeCashActionPanel === 'OPEN' || (!selectedSession && this.cashSessions.length === 0)
              ? `<form
                  data-form="open-cash-session-form"
                  class="rounded-xl border border-slate-200 bg-white p-4 space-y-3.5"
                >
                  <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-100">
                    <div>
                      <h2 class="text-xs font-bold text-slate-900">Abertura de Caixa com Fundo Inicial</h2>
                      <p class="text-[11px] text-slate-500">Identifique o terminal de caixa, o operador responsável e o numerário inicial para trocos.</p>
                    </div>
                    ${
                      selectedSession
                        ? `<button
                            type="button"
                            data-action="close-cash-panel"
                            class="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                          >${ICONS.close}</button>`
                        : ''
                    }
                  </div>
                  ${
                    this.cashOpenError
                      ? `<div class="p-2.5 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(this.cashOpenError)}</div>`
                      : ''
                  }
                  <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                    <div class="sm:col-span-3">
                      <label class="block text-[11px] font-medium text-slate-700 mb-1">N.º / Código da Caixa *</label>
                      <input
                        name="cashier"
                        type="text"
                        required
                        maxlength="16"
                        value="${escapeHtml(this.cashOpenDraft.cashier)}"
                        placeholder="01"
                        class="w-full h-10 px-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                    </div>
                    <div class="sm:col-span-4">
                      <label class="block text-[11px] font-medium text-slate-700 mb-1">Operador Responsável *</label>
                      <input
                        name="operator"
                        type="text"
                        list="cash-operators-datalist"
                        required
                        maxlength="32"
                        value="${escapeHtml(this.cashOpenDraft.operator)}"
                        placeholder="Código ou nome do operador"
                        class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                      <datalist id="cash-operators-datalist">
                        ${opSuggestions.map((op) => `<option value="${escapeHtml(op)}"></option>`).join('')}
                      </datalist>
                    </div>
                    <div class="sm:col-span-5">
                      <label class="block text-[11px] font-medium text-slate-700 mb-1">Fundo Inicial de Maneio (Kz) *</label>
                      <input
                        name="openingFloat"
                        type="text"
                        inputmode="decimal"
                        value="${escapeHtml(this.cashOpenDraft.openingFloat)}"
                        placeholder="0,00"
                        class="w-full h-10 px-3 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                    </div>
                    <div class="sm:col-span-9">
                      <label class="block text-[11px] font-medium text-slate-700 mb-1">Observação de abertura (opcional)</label>
                      <input
                        name="openingNotes"
                        type="text"
                        maxlength="240"
                        value="${escapeHtml(this.cashOpenDraft.notes)}"
                        placeholder="Ex.: Trocos conferidos no início do turno da manhã"
                        class="w-full h-10 px-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                      />
                    </div>
                    <div class="sm:col-span-3 flex items-end">
                      <button
                        type="submit"
                        ${isSuspended ? 'disabled' : ''}
                        class="w-full h-10 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap disabled:opacity-40"
                      >Confirmar Abertura</button>
                    </div>
                  </div>
                </form>`
              : ''
          }

          ${
            selectedSession && summary
              ? `
              <!-- Cabeçalho do Turno Selecionado + Ações Operacionais Rápidas -->
              <div class="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
                <div class="flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-slate-100">
                  <div class="space-y-0.5">
                    <div class="flex flex-wrap items-center gap-2 text-sm font-bold text-slate-900">
                      <span>Caixa ${escapeHtml(selectedSession.cashier)}</span>
                      <span aria-hidden="true" class="text-slate-300">·</span>
                      <span>Operador: ${escapeHtml(selectedSession.operator)}</span>
                      <span aria-hidden="true" class="text-slate-300">·</span>
                      <span class="text-xs font-semibold ${
                        selectedSession.status === 'open' ? 'text-emerald-700' : 'text-slate-600'
                      }">${selectedSession.status === 'open' ? 'Turno em aberto' : 'Turno encerrado'}</span>
                    </div>
                    <div class="text-[11px] text-slate-500 font-mono tabular-nums">
                      Abertura: ${formatDateTimePt(selectedSession.openedAtIso).slashDate} ${formatDateTimePt(selectedSession.openedAtIso).time}${
                        selectedSession.closedAtIso
                          ? ` · Fecho: ${formatDateTimePt(selectedSession.closedAtIso).slashDate} ${formatDateTimePt(selectedSession.closedAtIso).time} por ${escapeHtml(selectedSession.closedByOperator || selectedSession.operator)}`
                          : ''
                      } · Faturas FR válidas: ${summary.invoiceCount}${summary.cancelledCount > 0 ? ` (Anuladas: ${summary.cancelledCount})` : ''}
                    </div>
                  </div>

                  <div class="flex flex-wrap items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      data-action="print-cash-report"
                      data-id="${escapeHtml(selectedSession.id)}"
                      data-value="POS"
                      class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                    >
                      ${ICONS.printer}
                      <span>Talão 80mm</span>
                    </button>
                    <button
                      type="button"
                      data-action="print-cash-report"
                      data-id="${escapeHtml(selectedSession.id)}"
                      data-value="A4"
                      class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                    >
                      ${ICONS.fileA4}
                      <span>Mapa A4</span>
                    </button>
                    ${
                      selectedSession.status === 'open'
                        ? `<button
                            type="button"
                            data-action="open-cash-panel"
                            data-value="CLOSE"
                            ${isSuspended ? 'disabled' : ''}
                            class="h-9 px-3.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40"
                          >
                            ${ICONS.lock}
                            <span>Fechar Caixa</span>
                          </button>`
                        : ''
                    }
                  </div>
                </div>

                <!-- Botões de Movimentos de Gaveta (apenas para turno aberto) -->
                ${
                  selectedSession.status === 'open'
                    ? `<div class="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          data-action="open-cash-panel"
                          data-value="REFORCO"
                          ${isSuspended ? 'disabled' : ''}
                          class="h-9 px-3 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                            this.activeCashActionPanel === 'REFORCO'
                              ? 'bg-emerald-700 text-white border-emerald-700'
                              : 'border-slate-200 text-slate-800 hover:bg-slate-50'
                          }"
                        >
                          ${ICONS.arrowDownLeft}
                          <span>Reforço de Caixa</span>
                        </button>
                        <button
                          type="button"
                          data-action="open-cash-panel"
                          data-value="SANGRIA"
                          ${isSuspended ? 'disabled' : ''}
                          class="h-9 px-3 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                            this.activeCashActionPanel === 'SANGRIA'
                              ? 'bg-amber-700 text-white border-amber-700'
                              : 'border-slate-200 text-slate-800 hover:bg-slate-50'
                          }"
                        >
                          ${ICONS.arrowUpRight}
                          <span>Sangria de Caixa</span>
                        </button>
                        <button
                          type="button"
                          data-action="open-cash-panel"
                          data-value="ENTRADA"
                          ${isSuspended ? 'disabled' : ''}
                          class="h-9 px-3 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                            this.activeCashActionPanel === 'ENTRADA'
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                          }"
                        >
                          ${ICONS.plus}
                          <span>Entrada de Dinheiro</span>
                        </button>
                        <button
                          type="button"
                          data-action="open-cash-panel"
                          data-value="SAIDA"
                          ${isSuspended ? 'disabled' : ''}
                          class="h-9 px-3 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                            this.activeCashActionPanel === 'SAIDA'
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'border-slate-200 text-slate-700 hover:bg-slate-50'
                          }"
                        >
                          ${ICONS.minus}
                          <span>Saída / Despesa</span>
                        </button>
                      </div>`
                    : ''
                }

                <!-- Formulário Inline para Reforço / Sangria / Entrada / Saída -->
                ${
                  selectedSession.status === 'open' &&
                  (this.activeCashActionPanel === 'REFORCO' ||
                    this.activeCashActionPanel === 'SANGRIA' ||
                    this.activeCashActionPanel === 'ENTRADA' ||
                    this.activeCashActionPanel === 'SAIDA')
                    ? `<form
                        data-form="cash-movement-form"
                        class="rounded-lg border border-slate-200 bg-slate-50 p-3.5 space-y-3"
                      >
                        <input type="hidden" name="movementType" value="${this.activeCashActionPanel}" />
                        <div class="flex items-center justify-between gap-2">
                          <div class="text-xs font-bold text-slate-900">
                            ${
                              this.activeCashActionPanel === 'REFORCO'
                                ? 'Registar Reforço de Caixa (Adição de Trocos na Gaveta)'
                                : this.activeCashActionPanel === 'SANGRIA'
                                  ? `Registar Sangria de Caixa (Disponível na gaveta: ${formatKzNumber(Math.max(0, summary.expectedCash))} Kz)`
                                  : this.activeCashActionPanel === 'ENTRADA'
                                    ? 'Registar Entrada Avulsa de Caixa'
                                    : 'Registar Saída / Despesa Operacional de Caixa'
                            }
                          </div>
                          <button
                            type="button"
                            data-action="close-cash-panel"
                            class="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                          >${ICONS.close}</button>
                        </div>
                        ${
                          this.cashMovementError
                            ? `<div class="p-2.5 rounded border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(this.cashMovementError)}</div>`
                            : ''
                        }
                        <div class="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
                          <div class="sm:col-span-3">
                            <label class="block text-[11px] font-medium text-slate-700 mb-1">Montante (Kz) *</label>
                            <input
                              name="amount"
                              type="text"
                              inputmode="decimal"
                              required
                              value="${escapeHtml(this.cashMovementDraft.amount)}"
                              placeholder="0,00"
                              class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          ${
                            this.activeCashActionPanel === 'ENTRADA' ||
                            this.activeCashActionPanel === 'SAIDA'
                              ? `<div class="sm:col-span-3">
                                  <label class="block text-[11px] font-medium text-slate-700 mb-1">Meio</label>
                                  <select
                                    name="paymentMethod"
                                    class="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                                  >
                                    <option value="Dinheiro" ${this.cashMovementDraft.paymentMethod === 'Dinheiro' ? 'selected' : ''}>Dinheiro (Gaveta)</option>
                                    <option value="Multicaixa" ${this.cashMovementDraft.paymentMethod === 'Multicaixa' ? 'selected' : ''}>Multicaixa</option>
                                    <option value="Transferência" ${this.cashMovementDraft.paymentMethod === 'Transferência' ? 'selected' : ''}>Transferência</option>
                                  </select>
                                </div>`
                              : ''
                          }
                          <div class="${
                            this.activeCashActionPanel === 'ENTRADA' ||
                            this.activeCashActionPanel === 'SAIDA'
                              ? 'sm:col-span-4'
                              : 'sm:col-span-6'
                          }">
                            <label class="block text-[11px] font-medium text-slate-700 mb-1">Motivo / Descrição *</label>
                            <input
                              name="reason"
                              type="text"
                              required
                              maxlength="240"
                              value="${escapeHtml(this.cashMovementDraft.reason)}"
                              placeholder="Descreva o motivo do movimento"
                              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div class="${
                            this.activeCashActionPanel === 'ENTRADA' ||
                            this.activeCashActionPanel === 'SAIDA'
                              ? 'sm:col-span-2'
                              : 'sm:col-span-3'
                          }">
                            <label class="block text-[11px] font-medium text-slate-700 mb-1">Ref. / Doc (opc.)</label>
                            <input
                              name="reference"
                              type="text"
                              maxlength="80"
                              value="${escapeHtml(this.cashMovementDraft.reference)}"
                              placeholder="Talão / Guia"
                              class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                        </div>
                        <div class="flex items-center justify-end gap-2 pt-1">
                          <button
                            type="button"
                            data-action="close-cash-panel"
                            class="h-9 px-3 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                          >Cancelar</button>
                          <button
                            type="submit"
                            class="h-9 px-4 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold whitespace-nowrap"
                          >Guardar Movimento</button>
                        </div>
                      </form>`
                    : ''
                }

                <!-- Painel de Fecho de Caixa por Operador + Contagem e Controlo de Diferenças -->
                ${
                  selectedSession.status === 'open' && this.activeCashActionPanel === 'CLOSE'
                    ? `<form
                        data-form="close-cash-session-form"
                        class="rounded-lg border border-slate-300 bg-slate-50 p-4 space-y-3.5"
                      >
                        <input type="hidden" name="sessionId" value="${escapeHtml(selectedSession.id)}" />
                        <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-200">
                          <div>
                            <h3 class="text-xs font-bold text-slate-900">Fecho de Caixa por Operador e Conferência Física</h3>
                            <p class="text-[11px] text-slate-500">Informe o dinheiro físico contado na gaveta para apurar automaticamente sobras ou quebras.</p>
                          </div>
                          <div class="flex items-center gap-2 shrink-0">
                            <button
                              type="button"
                              data-action="toggle-denom-helper"
                              class="h-8 px-2.5 rounded-md border border-slate-200 bg-white text-[11px] font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
                            >${this.showDenominationHelper ? 'Ocultar notas Kz' : 'Contar notas Kz'}</button>
                            <button
                              type="button"
                              data-action="close-cash-panel"
                              class="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                            >${ICONS.close}</button>
                          </div>
                        </div>

                        ${
                          this.cashCloseError
                            ? `<div class="p-2.5 rounded border border-red-200 bg-red-50 text-xs text-red-700">${escapeHtml(this.cashCloseError)}</div>`
                            : ''
                        }

                        ${
                          this.showDenominationHelper
                            ? `<div class="p-3 rounded-lg border border-slate-200 bg-white space-y-2">
                                <div class="flex items-center justify-between text-[11px]">
                                  <span class="font-semibold text-slate-800">Auxiliar de contagem por notas / moedas de Kwanza</span>
                                  <button
                                    type="button"
                                    data-action="clear-denom-helper"
                                    class="text-slate-500 hover:text-slate-900 underline"
                                  >Limpar contagem</button>
                                </div>
                                <div class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
                                  ${denoms
                                    .map(
                                      (d) => `
                                      <div>
                                        <label class="block text-[10px] font-mono text-slate-500 mb-0.5">${formatKzNumber(d).replace(',00', '')} Kz</label>
                                        <input
                                          id="cash-denom-${d}"
                                          type="text"
                                          inputmode="numeric"
                                          data-field="cash-denom-live"
                                          data-id="${d}"
                                          value="${escapeHtml(this.denomCounts[d] || '')}"
                                          placeholder="Qtd"
                                          class="w-full h-8 px-2 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded focus:outline-none focus:border-blue-600"
                                        />
                                      </div>
                                    `
                                    )
                                    .join('')}
                                </div>
                              </div>`
                            : ''
                        }

                        <!-- Comparação em tempo real: Saldo Esperado vs Dinheiro Contado vs Diferença -->
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 tabular-nums">
                          <div class="p-3 rounded-lg border border-slate-200 bg-white">
                            <div class="text-[11px] text-slate-500">Saldo Esperado em Dinheiro</div>
                            <div class="text-sm font-bold font-mono text-slate-900 mt-0.5">${formatKzNumber(summary.expectedCash)} Kz</div>
                          </div>
                          <div class="p-3 rounded-lg border border-slate-200 bg-white">
                            <label for="cash-counted-live-input" class="block text-[11px] font-medium text-slate-700">Dinheiro Contado na Gaveta (Kz) *</label>
                            <input
                              id="cash-counted-live-input"
                              name="countedCash"
                              type="text"
                              inputmode="decimal"
                              required
                              data-field="cash-counted-live"
                              value="${escapeHtml(this.cashCloseCountedInput)}"
                              placeholder="0,00"
                              class="w-full h-8 px-2 mt-1 text-sm font-bold font-mono tabular-nums bg-slate-50 border border-slate-300 rounded focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div class="p-3 rounded-lg border border-slate-200 bg-white">
                            <div class="text-[11px] text-slate-500">Diferença Apurada</div>
                            <div class="text-sm font-mono mt-0.5">${renderDiffStatusText(summary.differenceAmount)}</div>
                          </div>
                        </div>

                        <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                          <div class="sm:col-span-4">
                            <label class="block text-[11px] font-medium text-slate-700 mb-1">Operador que confere o fecho *</label>
                            <input
                              name="closedByOperator"
                              type="text"
                              list="cash-operators-datalist"
                              required
                              maxlength="32"
                              value="${escapeHtml(this.cashCloseOperator)}"
                              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                          <div class="sm:col-span-8">
                            <label class="block text-[11px] font-medium text-slate-700 mb-1">
                              Observações / Justificação de diferença ${
                                summary.differenceAmount !== null && Math.abs(summary.differenceAmount) >= 0.01
                                  ? '<span class="text-red-600 font-semibold">(Obrigatória)</span>'
                                  : '(opcional)'
                              }
                            </label>
                            <input
                              name="closingNotes"
                              type="text"
                              maxlength="240"
                              value="${escapeHtml(this.cashCloseNotes)}"
                              placeholder="Justifique eventuais quebras/sobras ou registe notas de passagem de turno"
                              class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                            />
                          </div>
                        </div>

                        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                          <label class="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              name="autoPrintClosure"
                              ${this.settings.autoPrintOnEmit ? 'checked' : ''}
                              class="h-4 w-4 rounded border-slate-300 text-blue-600"
                            />
                            <span>Imprimir mapa de fecho 80mm ao encerrar turno</span>
                          </label>
                          <div class="flex items-center gap-2 justify-end">
                            <button
                              type="button"
                              data-action="close-cash-panel"
                              class="h-9 px-3 rounded-md border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100"
                            >Cancelar</button>
                            <button
                              type="submit"
                              class="h-9 px-4 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold whitespace-nowrap"
                            >Confirmar Fecho Definitivo</button>
                          </div>
                        </div>
                      </form>`
                    : ''
                }

                <!-- Grelha Principal: Conferência de Gaveta vs Separação por Método de Pagamento -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                  <!-- Bloco 1: Conferência de Gaveta (Saldo Esperado vs Dinheiro Contado) -->
                  <div class="rounded-lg border border-slate-200 p-3.5 space-y-2 tabular-nums text-xs">
                    <div class="font-bold text-slate-900 pb-1.5 border-b border-slate-100 flex items-center justify-between">
                      <span>Conferência de Gaveta (Numerário Físico)</span>
                      <span class="text-[11px] font-mono text-slate-500">Dinheiro</span>
                    </div>
                    <div class="flex justify-between text-slate-600">
                      <span>(+) Fundo inicial de abertura</span>
                      <span class="font-mono font-medium text-slate-900">${formatKzNumber(summary.openingFloat)} Kz</span>
                    </div>
                    <div class="flex justify-between text-slate-600">
                      <span>(+) Vendas recebidas em Dinheiro</span>
                      <span class="font-mono font-medium text-emerald-700">+${formatKzNumber(summary.salesCash)} Kz</span>
                    </div>
                    ${
                      summary.debtCash > 0
                        ? `<div class="flex justify-between text-slate-600">
                            <span>(+) Liquidações de dívida em Dinheiro</span>
                            <span class="font-mono font-medium text-emerald-700">+${formatKzNumber(summary.debtCash)} Kz</span>
                          </div>`
                        : ''
                    }
                    <div class="flex justify-between text-slate-600">
                      <span>(+) Reforços de caixa</span>
                      <span class="font-mono font-medium text-emerald-700">+${formatKzNumber(summary.reforcosTotal)} Kz</span>
                    </div>
                    <div class="flex justify-between text-slate-600">
                      <span>(+) Outras entradas em numerário</span>
                      <span class="font-mono font-medium text-emerald-700">+${formatKzNumber(summary.entradasTotal)} Kz</span>
                    </div>
                    <div class="flex justify-between text-slate-600">
                      <span>(-) Sangrias de caixa</span>
                      <span class="font-mono font-medium text-red-700">-${formatKzNumber(summary.sangriasTotal)} Kz</span>
                    </div>
                    <div class="flex justify-between text-slate-600">
                      <span>(-) Saídas / despesas pagas</span>
                      <span class="font-mono font-medium text-red-700">-${formatKzNumber(summary.saidasTotal)} Kz</span>
                    </div>
                    <div class="pt-2 border-t border-slate-200 space-y-1">
                      <div class="flex justify-between font-bold text-slate-900 text-sm">
                        <span>Saldo Esperado na Gaveta</span>
                        <span class="font-mono">${formatKzNumber(summary.expectedCash)} Kz</span>
                      </div>
                      <div class="flex justify-between font-semibold text-slate-800">
                        <span>Dinheiro Contado</span>
                        <span class="font-mono">${
                          summary.countedCash !== null
                            ? `${formatKzNumber(summary.countedCash)} Kz`
                            : 'Em aberto'
                        }</span>
                      </div>
                      <div class="flex justify-between items-center pt-0.5">
                        <span class="text-slate-600 font-medium">Diferença de Caixa</span>
                        <span class="font-mono">${renderDiffStatusText(summary.differenceAmount)}</span>
                      </div>
                    </div>
                    ${
                      selectedSession.closingNotes
                        ? `<div class="pt-2 border-t border-slate-100 text-[11px] text-slate-600">
                            <span class="font-semibold text-slate-800">Justificação / Notas de fecho:</span> ${escapeHtml(selectedSession.closingNotes)}
                          </div>`
                        : ''
                    }
                  </div>

                  <!-- Bloco 2: Separação dos Recebimentos por Método de Pagamento -->
                  <div class="rounded-lg border border-slate-200 p-3.5 space-y-2.5 tabular-nums text-xs flex flex-col justify-between">
                    <div class="space-y-2">
                      <div class="font-bold text-slate-900 pb-1.5 border-b border-slate-100 flex items-center justify-between">
                        <span>Recebimentos por Método de Pagamento</span>
                        <span class="text-[11px] font-mono text-slate-500">Vendas + Liquidações</span>
                      </div>
                      <div class="flex items-center justify-between py-1">
                        <div>
                          <div class="font-semibold text-slate-900">Dinheiro (Numerário líquido)</div>
                          <div class="text-[10.5px] text-slate-500 font-mono">Vendas: ${formatKzNumber(summary.salesCash)} Kz · Dívidas: ${formatKzNumber(summary.debtCash)} Kz</div>
                        </div>
                        <span class="font-mono font-bold text-slate-900">${formatKzNumber(summary.totalByMethod.Dinheiro)} Kz</span>
                      </div>
                      <div class="flex items-center justify-between py-1 border-t border-slate-100">
                        <div>
                          <div class="font-semibold text-slate-900">Multicaixa / TPA</div>
                          <div class="text-[10.5px] text-slate-500 font-mono">Vendas: ${formatKzNumber(summary.salesMulticaixa)} Kz · Dívidas: ${formatKzNumber(summary.debtMulticaixa)} Kz</div>
                        </div>
                        <span class="font-mono font-bold text-slate-900">${formatKzNumber(summary.totalByMethod.Multicaixa)} Kz</span>
                      </div>
                      <div class="flex items-center justify-between py-1 border-t border-slate-100">
                        <div>
                          <div class="font-semibold text-slate-900">Transferência Bancária</div>
                          <div class="text-[10.5px] text-slate-500 font-mono">Vendas: ${formatKzNumber(summary.salesTransfer)} Kz · Dívidas: ${formatKzNumber(summary.debtTransfer)} Kz</div>
                        </div>
                        <span class="font-mono font-bold text-slate-900">${formatKzNumber(summary.totalByMethod.Transferência)} Kz</span>
                      </div>
                    </div>

                    <div class="pt-2 border-t border-slate-200 space-y-1.5">
                      <div class="flex justify-between font-bold text-sm text-slate-900">
                        <span>Total Efetivamente Recebido</span>
                        <span class="font-mono text-blue-700">${formatKzNumber(summary.totalReceivedAllMethods)} Kz</span>
                      </div>
                      <div class="flex justify-between text-amber-800 font-medium">
                        <span>Vendas a Crédito / Conta Corrente</span>
                        <span class="font-mono">${formatKzNumber(summary.salesCredit)} Kz</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              `
              : ''
          }

          <!-- Histórico Cronológico de Movimentos de Caixa e Pagamentos -->
          <div class="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div class="p-3.5 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div>
                <h2 class="text-xs font-bold text-slate-900">Histórico de Movimentos${
                  selectedSession ? ` · Caixa ${escapeHtml(selectedSession.cashier)}` : ''
                }</h2>
                <p class="text-[11px] text-slate-500">Registo auditável de abertura, vendas, liquidações, reforços, sangrias, entradas, saídas e fecho.</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <div class="relative min-w-[200px] flex-1 sm:flex-initial">
                  <span class="text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                  <input
                    id="cash-ledger-search-input"
                    type="text"
                    autocomplete="off"
                    data-field="cash-ledger-search"
                    value="${escapeHtml(this.cashLedgerSearch)}"
                    placeholder="Filtrar movimento, doc. ou operador..."
                    class="w-full h-8 pl-8 ${this.cashLedgerSearch ? 'pr-7' : 'pr-2.5'} text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                  />
                  ${
                    this.cashLedgerSearch
                      ? `<button
                          type="button"
                          data-action="clear-cash-ledger-search"
                          class="h-6 w-6 absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-slate-400 hover:text-slate-700"
                        >${ICONS.close}</button>`
                      : ''
                  }
                </div>
                <div class="flex items-center gap-0.5 bg-slate-100 p-0.5 rounded-lg">
                  ${(
                    [
                      ['ALL', 'Todos'],
                      ['DRAWER', 'Gaveta'],
                      ['SALES', 'Vendas/Liq.'],
                      ['INFLOWS', 'Entradas'],
                      ['OUTFLOWS', 'Saídas'],
                    ] as const
                  )
                    .map(([val, label]) => {
                      const active = this.cashLedgerFilter === val;
                      return `
                        <button
                          type="button"
                          data-action="cash-ledger-filter"
                          data-value="${val}"
                          class="h-7 px-2.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap ${
                            active
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }"
                        >${label}</button>
                      `;
                    })
                    .join('')}
                </div>
              </div>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-left border-collapse text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                  <tr>
                    <th class="py-2.5 px-3 font-medium">Hora / Data</th>
                    <th class="py-2.5 px-3 font-medium">Movimento</th>
                    <th class="py-2.5 px-3 font-medium">Método</th>
                    <th class="py-2.5 px-3 font-medium">Caixa / Operador</th>
                    <th class="py-2.5 px-3 font-medium">Detalhe / Justificação</th>
                    <th class="py-2.5 px-3 font-medium text-right">Montante</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 tabular-nums">
                  ${
                    filteredLedger.length === 0
                      ? `<tr>
                          <td colspan="6" class="py-8 px-4 text-center text-xs text-slate-500">
                            Nenhum movimento encontrado para o filtro selecionado neste turno.
                          </td>
                        </tr>`
                      : filteredLedger
                          .map((row) => {
                            const dt = formatDateTimePt(row.iso);
                            const amtClass = row.cancelled
                              ? 'text-slate-400 line-through'
                              : row.direction === 'OUT'
                                ? 'text-red-700 font-semibold'
                                : row.direction === 'IN'
                                  ? 'text-emerald-700 font-semibold'
                                  : 'text-slate-700 font-semibold';
                            const sign =
                              row.cancelled || row.direction === 'NEUTRAL'
                                ? ''
                                : row.direction === 'OUT'
                                  ? '-'
                                  : '+';
                            return `
                              <tr class="hover:bg-slate-50/70 transition-colors">
                                <td class="py-2.5 px-3 font-mono text-[11px] text-slate-500 whitespace-nowrap">${dt.slashDate} ${dt.time}</td>
                                <td class="py-2.5 px-3 font-semibold text-slate-900 whitespace-nowrap">${escapeHtml(row.label)}</td>
                                <td class="py-2.5 px-3 text-slate-700 whitespace-nowrap">${escapeHtml(row.method)}</td>
                                <td class="py-2.5 px-3 font-mono text-[11px] text-slate-600 whitespace-nowrap">${escapeHtml(row.operatorInfo)}</td>
                                <td class="py-2.5 px-3 text-slate-600 max-w-xs truncate" title="${escapeHtml(row.detail)}">${escapeHtml(row.detail)}</td>
                                <td class="py-2.5 px-3 text-right font-mono whitespace-nowrap ${amtClass}">${sign}${formatKzNumber(row.amount)} Kz</td>
                              </tr>
                            `;
                          })
                          .join('')
                  }
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  // ==================== 7. SINCRONIZAÇÃO / ESTADO OFFLINE & BACKUP ====================

  private renderSyncWorkspace(): string {
    const isUnassigned = this.requiresCompanyOnboarding || !this.activeCompany.id;
    const cloudSyncEntitled = !isUnassigned && canCompanySyncCloudData(this.activeCompany);
    const pProd = !cloudSyncEntitled ? 0 : this.products.filter((p) => !p.synced).length;
    const pCust = !cloudSyncEntitled ? 0 : this.customers.filter((c) => !c.synced).length;
    const pInv = !cloudSyncEntitled ? 0 : this.invoices.filter((i) => !i.synced).length;
    const pSess = !cloudSyncEntitled ? 0 : this.cashSessions.filter((s) => !s.synced).length;
    const pMov = !cloudSyncEntitled ? 0 : this.cashMovements.filter((m) => !m.synced).length;
    const pSet = !cloudSyncEntitled ? 0 : this.settings.synced ? 0 : 1;
    const totalPending = pProd + pCust + pInv + pSess + pMov + pSet;

    const errCount = !cloudSyncEntitled
      ? 0
      : this.products.filter((p) => p.syncState === 'error').length +
        this.customers.filter((c) => c.syncState === 'error').length +
        this.invoices.filter((i) => i.syncState === 'error').length +
        this.cashSessions.filter((s) => s.syncState === 'error').length +
        this.cashMovements.filter((m) => m.syncState === 'error').length +
        (this.settings.syncState === 'error' ? 1 : 0);

    const showCloudProtectionNudge =
      !isUnassigned &&
      !cloudSyncEntitled &&
      (this.invoices.length >= CLOUD_PROTECTION_NUDGE_INVOICES ||
        this.products.length + this.customers.length >= CLOUD_PROTECTION_NUDGE_RECORDS);

    const lastSync = this.lastSyncedIso ? formatDateTimePt(this.lastSyncedIso) : null;
    const bh = this.backendHealth;

    return `
      <div class="h-full overflow-y-auto bg-white p-4 sm:p-6">
        <div class="max-w-3xl space-y-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
            <div>
              <h1 class="text-sm font-bold text-slate-900">Sincronização, Backend e Backup</h1>
              <p class="text-xs text-slate-500">${
                isUnassigned
                  ? 'Sessão multiempresa pronta · Selecione ou cadastre uma empresa para sincronizar dados.'
                  : `Persistência isolada por empresa (${escapeHtml(
                      this.settings.company.shortName
                    )} · NIF ${escapeHtml(this.settings.company.nif)}).`
              }</p>
            </div>

            <div class="flex items-center gap-2 shrink-0">
              ${
                this.user
                  ? `
                  <button
                    type="button"
                    data-action="sync-now"
                    ${!this.isOnline || this.isSyncing ? 'disabled' : ''}
                    class="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${ICONS.refresh}
                    <span>${this.isSyncing ? 'A sincronizar...' : 'Sincronizar agora'}</span>
                  </button>
                  <button
                    type="button"
                    data-action="signout-google"
                    class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                  >Sair</button>
                `
                  : `
                  <button
                    type="button"
                    data-action="signin-google"
                    ${!this.isOnline ? 'disabled' : ''}
                    class="h-9 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap"
                  >Autenticar com Google</button>
                `
              }
            </div>
          </div>

          ${
            this.syncMessage
              ? `<div class="p-3 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">${escapeHtml(this.syncMessage)}</div>`
              : ''
          }

          ${
            showCloudProtectionNudge
              ? `<div class="p-3.5 rounded-lg border border-blue-200 bg-blue-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                  <div class="text-slate-700 leading-relaxed">
                    <span class="font-semibold text-slate-900">Histórico relevante neste dispositivo:</span>
                    existem ${this.invoices.length} faturas e ${this.products.length + this.customers.length} registos guardados localmente. Exporte cópia em JSON ou ative o backup automático na Cloud.
                  </div>
                  <button
                    type="button"
                    data-action="open-growth-modal"
                    data-value="cloud_protection"
                    class="h-8 px-3 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                  >Proteger na Cloud</button>
                </div>`
              : ''
          }

          ${
            errCount > 0
              ? `<div class="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700 tabular-nums">
                  ${errCount} registo(s) aguardam nova tentativa após erro de sincronização. Os dados permanecem seguros localmente no IndexedDB.
                </div>`
              : ''
          }

          <section class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="p-3.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1">
              <div class="text-[11px] text-slate-500">Rede Cliente</div>
              <div class="flex items-center gap-2 text-xs font-bold text-slate-900">
                <span class="${this.isOnline ? 'text-emerald-600' : 'text-amber-600'}">${this.isOnline ? ICONS.cloud : ICONS.cloudOff}</span>
                <span>${this.isOnline ? 'Online' : 'Offline (IndexedDB)'}</span>
              </div>
              <p class="text-[11px] text-slate-500">
                ${lastSync ? `Último sync: ${lastSync.slashDate} ${lastSync.time}` : 'Operação local imediata.'}
              </p>
            </div>

            <div class="p-3.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1">
              <div class="text-[11px] text-slate-500">Sessão Firebase Auth</div>
              <div class="text-xs font-bold text-slate-900 truncate">
                ${this.user ? escapeHtml(this.user.email || 'Autenticado') : 'Modo Local'}
              </div>
              <p class="text-[11px] text-slate-500 font-mono tabular-nums">${
                cloudSyncEntitled ? `${totalPending} registo(s) pendente(s)` : 'Armazenamento autónomo local'
              }</p>
            </div>

            <div class="p-3.5 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1">
              <div class="text-[11px] text-slate-500">API Backend (/api/health)</div>
              <div class="flex items-center gap-1.5 text-xs font-bold text-slate-900">
                ${ICONS.shieldCheck}
                <span>${bh?.ok ? 'Ativo' : 'Indisponível'}</span>
              </div>
              <p class="text-[11px] text-slate-500 font-mono truncate" title="${escapeHtml(bh?.firestoreDatabaseId || '')}">
                ${bh ? `DB: ${escapeHtml(bh.firestoreDatabaseId.slice(0, 22))}…` : 'Sem resposta /api/health'}
              </p>
            </div>
          </section>

          <section class="space-y-2.5">
            <h2 class="text-xs font-semibold text-slate-900">Registos Guardados no Dispositivo${cloudSyncEntitled ? ' vs Cloud Firestore' : ''}</h2>
            <div class="border border-slate-200 rounded-lg overflow-hidden">
              <table class="w-full text-left border-collapse text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                  <tr>
                    <th class="py-2.5 px-3 font-medium">Entidade</th>
                    <th class="py-2.5 px-3 font-medium text-right">Local (IndexedDB)</th>
                    <th class="py-2.5 px-3 font-medium text-right">${cloudSyncEntitled ? 'Sincronizados' : 'Modo de Persistência'}</th>
                    ${cloudSyncEntitled ? '<th class="py-2.5 px-3 font-medium text-right">Pendentes</th>' : ''}
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 tabular-nums">
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Faturas emitidas</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.invoices.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono ${cloudSyncEntitled ? 'text-emerald-700' : 'text-slate-600'}">${cloudSyncEntitled ? this.invoices.length - pInv : 'Local seguro'}</td>
                    ${cloudSyncEntitled ? `<td class="py-2.5 px-3 text-right font-mono text-amber-700">${pInv}</td>` : ''}
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Turnos e movimentos de caixa</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.cashSessions.length + this.cashMovements.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono ${cloudSyncEntitled ? 'text-emerald-700' : 'text-slate-600'}">${cloudSyncEntitled ? this.cashSessions.length + this.cashMovements.length - (pSess + pMov) : 'Local seguro'}</td>
                    ${cloudSyncEntitled ? `<td class="py-2.5 px-3 text-right font-mono text-amber-700">${pSess + pMov}</td>` : ''}
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Produtos e serviços</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.products.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono ${cloudSyncEntitled ? 'text-emerald-700' : 'text-slate-600'}">${cloudSyncEntitled ? this.products.length - pProd : 'Local seguro'}</td>
                    ${cloudSyncEntitled ? `<td class="py-2.5 px-3 text-right font-mono text-amber-700">${pProd}</td>` : ''}
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Clientes</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.customers.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono ${cloudSyncEntitled ? 'text-emerald-700' : 'text-slate-600'}">${cloudSyncEntitled ? this.customers.length - pCust : 'Local seguro'}</td>
                    ${cloudSyncEntitled ? `<td class="py-2.5 px-3 text-right font-mono text-amber-700">${pCust}</td>` : ''}
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Configurações</td>
                    <td class="py-2.5 px-3 text-right font-mono">1</td>
                    <td class="py-2.5 px-3 text-right font-mono ${cloudSyncEntitled ? 'text-emerald-700' : 'text-slate-600'}">${cloudSyncEntitled ? (this.settings.synced ? 1 : 0) : 'Local seguro'}</td>
                    ${cloudSyncEntitled ? `<td class="py-2.5 px-3 text-right font-mono text-amber-700">${pSet}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Instalação Universal no Dispositivo (Android, Windows 7/10/11, iPhone/iPad) -->
          <section class="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="space-y-0.5">
              <h2 class="text-xs font-semibold text-slate-900">Instalação neste Terminal / Telemóvel (PWA Offline)</h2>
              <p class="text-xs text-slate-500">${
                this.isInstalled
                  ? 'Aplicativo já instalado e em execução em modo autónomo neste dispositivo.'
                  : this.deferredPrompt
                    ? 'Pronto para instalar com 1 clique no ecrã principal ou área de trabalho.'
                    : this.isIOS
                      ? 'Em iPhone e iPad, a Apple exige confirmação manual através do menu Partilhar do Safari.'
                      : 'Pode instalar pelo menu do navegador (⋮ → Instalar SILA-Billing / Guardar atalho) para abertura direta offline.'
              }</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              ${
                this.isInstalled
                  ? `<span class="text-xs font-semibold text-emerald-700 flex items-center gap-1.5">${ICONS.check}<span>Instalado</span></span>`
                  : this.deferredPrompt
                    ? `<button
                        type="button"
                        data-action="install-pwa"
                        class="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 flex items-center gap-1.5 whitespace-nowrap"
                      >
                        ${ICONS.download}
                        <span>Instalar Aplicativo</span>
                      </button>`
                    : this.isIOS
                      ? `<button
                          type="button"
                          data-action="open-ios-guide"
                          class="h-9 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                        >
                          ${ICONS.iosShare}
                          <span>Como instalar no iPhone / iPad</span>
                        </button>`
                      : ''
              }
            </div>
          </section>

          <!-- Exportação de Backup JSON e Snapshot de Segurança -->
          <section class="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 class="text-xs font-semibold text-slate-900">Exportação Segura de Dados (JSON)</h2>
              <p class="text-xs text-slate-500">Exporte cópia integral da empresa ativa ou acione reposição de segurança.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2 shrink-0">
              ${
                this.hasPreMigrationBackup && this.activeCompany.id === JAIMONA_COMPANY_ID
                  ? `<button
                      type="button"
                      data-action="restore-v1-snapshot"
                      title="Restaurar cópia intacta pré-migração da empresa JAIMONA"
                      class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                    >
                      ${ICONS.reset}
                      <span>Restaurar snapshot v1</span>
                    </button>`
                  : ''
              }
              <button
                type="button"
                data-action="export-backup-local"
                ${isUnassigned ? 'disabled' : ''}
                class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.download}
                <span>Backup Local</span>
              </button>
              <button
                type="button"
                data-action="export-backup-cloud"
                ${!this.user || !this.isOnline || isUnassigned ? 'disabled' : ''}
                class="h-9 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.download}
                <span>Backup Cloud (/api/backup)</span>
              </button>
            </div>
          </section>
        </div>
      </div>
    `;
  }

  private renderIOSInstallBanner(): string {
    if (!this.isIOS || this.isInstalled || this.iosBannerDismissed) {
      return '';
    }

    return `
      <div class="bg-slate-800 border-b border-slate-700 text-slate-100 px-3 py-2 text-xs flex items-center justify-between gap-2 shrink-0">
        <div class="flex items-center gap-2 min-w-0 leading-snug">
          <span class="text-blue-400 shrink-0">${ICONS.iosShare}</span>
          <div class="min-w-0">
            ${
              this.isIOSInAppBrowser
                ? `<span class="font-semibold text-white">Instalar no iPhone:</span> abra primeiro no <strong>Safari</strong> e toque em <strong>Partilhar</strong> → <strong>Adicionar ao Ecrã Principal</strong>.`
                : `<span class="font-semibold text-white">Instalar no iPhone / iPad:</span> toque em <strong class="text-white">Partilhar</strong> na barra do navegador e escolha <strong class="text-white">Adicionar ao Ecrã Principal</strong>.`
            }
          </div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            data-action="open-ios-guide"
            class="h-7 px-2.5 rounded bg-slate-700 hover:bg-slate-600 text-[11px] font-semibold text-white whitespace-nowrap transition-colors"
          >Passos</button>
          <button
            type="button"
            data-action="dismiss-ios-banner"
            aria-label="Ocultar aviso de instalação"
            class="h-7 w-7 flex items-center justify-center rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >${ICONS.close}</button>
        </div>
      </div>
    `;
  }

  private renderIOSModal(): string {
    return `
      <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div class="bg-white rounded-xl p-5 max-w-sm w-full space-y-4 border border-slate-200 shadow-lg">
          <div class="flex items-center justify-between gap-2">
            <h2 class="text-sm font-bold text-slate-900">Instalar SILA-Billing no iPhone / iPad</h2>
            <button
              type="button"
              data-action="close-ios-guide"
              aria-label="Fechar guia"
              class="h-7 w-7 flex items-center justify-center rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            >${ICONS.close}</button>
          </div>
          ${
            this.isIOSInAppBrowser
              ? `<div class="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 leading-relaxed">
                  Está a visualizar dentro de uma aplicação externa. Toque nos três pontos ou no ícone do navegador para <strong>Abrir no Safari</strong> antes de instalar.
                </div>`
              : ''
          }
          <ol class="space-y-2.5 text-xs text-slate-600 leading-relaxed">
            <li class="flex items-start gap-2.5">
              <span class="h-6 w-6 rounded-md bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">${ICONS.iosShare}</span>
              <span><strong>1.</strong> Toque no botão <strong>Partilhar</strong> na barra inferior ou superior do Safari.</span>
            </li>
            <li class="flex items-start gap-2.5">
              <span class="h-6 w-6 rounded-md bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">${ICONS.plusSquare}</span>
              <span><strong>2.</strong> Deslize a lista de opções e selecione <strong>Adicionar ao Ecrã Principal</strong>.</span>
            </li>
            <li class="flex items-start gap-2.5">
              <span class="h-6 w-6 rounded-md bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">${ICONS.check}</span>
              <span><strong>3.</strong> Confirme em <strong>Adicionar</strong> no canto superior direito para abrir o SILA-Billing em ecrã inteiro, inclusive sem internet.</span>
            </li>
          </ol>
          <button
            type="button"
            data-action="close-ios-guide"
            class="w-full h-10 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors"
          >Entendido</button>
        </div>
      </div>
    `;
  }
}
