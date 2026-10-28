import { onAuthStateChanged, User } from 'firebase/auth';
import {
  calculateInvoiceTotals,
  formatDateTimePt,
  formatKzNumber,
  generateNextInvoiceNumber,
  roundKz,
} from '../src/core/billingEngine';
import {
  AppSettings,
  CartDraftItem,
  Customer,
  DEFAULT_PRODUCT_CATEGORIES,
  DEFAULT_SETTINGS,
  DocumentFormat,
  DocumentType,
  InvoiceRecord,
  PaymentMethod,
  Product,
  TaxRate,
} from '../src/core/types';
import {
  cancelInvoiceCloud,
  createInvoiceCloud,
  pullAllFromCloud,
  removeCustomerCloud,
  removeProductCloud,
  upsertCustomerCloud,
  upsertProductCloud,
  upsertSettingsCloud,
} from '../src/services/cloudSync';
import {
  auth,
  signInWithGoogle,
  signOutFirebase,
  validateFirestoreConnection,
} from '../src/services/firebaseClient';
import { bootstrapLocalStore, localDb } from '../src/services/localStore';
import {
  BackendHealthStatus,
  downloadCloudBackupJson,
  fetchBackendHealth,
  submitInvoiceAudit,
} from './services/backendApi';
import { generateInvoiceQrDataUrl, renderDocumentHtml } from './ui/documentRenderer';
import { ICONS } from './ui/icons';

type ActiveModule =
  | 'NEW_POS'
  | 'NEW_A4'
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

export class SilaBillingApp {
  private root: HTMLElement;

  // Navegação e Layout
  private activeModule: ActiveModule = 'NEW_POS';
  private sidebarState: SidebarState =
    typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'EXPANDED' : 'ICONS';

  // Dados Persistentes (IndexedDB + Firestore)
  private products: Product[] = [];
  private customers: Customer[] = [];
  private invoices: InvoiceRecord[] = [];
  private settings: AppSettings = DEFAULT_SETTINGS;
  private isBooting = true;

  // Estado POS / Emissão Unificada
  private posSearch = '';
  private posCategoryFilter = 'ALL';
  private posTaxFilter: 'ALL' | 14 | 0 = 'ALL';
  private cart: CartDraftItem[] = [];
  private selectedCustomerId = 'cust_direct';
  private showCustomerPicker = false;
  private posCustomerSearch = '';
  private showQuickCustomerForm = false;
  private docType: DocumentType = 'FR';
  private paymentMethod: PaymentMethod = 'Dinheiro';
  private amountReceivedInput = '';
  private notes = 'Venda directa a retalho.';
  private cashier = '01';
  private operator = '001';
  private showOptionsDrawer = false;
  private mobilePane: 'CATALOG' | 'CART' | 'PREVIEW' = 'CATALOG';
  private previewFormat: DocumentFormat = 'POS';
  private lastEmitted: InvoiceRecord | null = null;
  private isEmitting = false;
  private isPrinting = false;
  private lastAuditHash = '';
  private draftSaveTimer: number | null = null;

  // Estado Produtos / Clientes / Histórico
  private productSearch = '';
  private editingProduct: Product | null = null;
  private isNewProduct = false;

  private customerSearch = '';
  private editingCustomer: Customer | null = null;

  private historySearch = '';
  private selectedHistoryId = '';
  private historyViewFormat: DocumentFormat = 'POS';

  // Estado Configurações / Cloud / PWA
  private settingsSavedNotice = false;
  private isOnline: boolean = typeof navigator !== 'undefined' ? navigator.onLine : true;
  private user: User | null = null;
  private isSyncing = false;
  private lastSyncedIso: string | null = null;
  private syncMessage: string | null = null;
  private backendHealth: BackendHealthStatus | null = null;

  private deferredPrompt: BeforeInstallPromptEvent | null = null;
  private isInstalled = false;
  private isIOS = false;
  private showIOSGuide = false;

  // Cache de QR Codes para renderização fluida sem flicker
  private qrCache = new Map<string, string>();
  private printJob: { invoice: InvoiceRecord; format: DocumentFormat; qr: string } | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  public async mount(): Promise<void> {
    this.setupGlobalListeners();
    this.render();

    validateFirestoreConnection();

    try {
      const data = await bootstrapLocalStore();
      this.products = data.products;
      this.customers = data.customers;
      this.invoices = data.invoices;
      this.settings = data.settings;
      this.docType = data.settings.defaultDocType || 'FR';
      this.cashier = data.settings.defaultCashier || '01';
      this.operator = data.settings.defaultOperator || '001';
      this.notes = data.settings.defaultNotes || 'Venda directa a retalho.';
      this.selectedHistoryId = data.invoices[0]?.id || '';

      if (data.posDraft) {
        this.activeModule = data.posDraft.activeModule || 'NEW_POS';
        this.previewFormat = data.posDraft.previewFormat || 'POS';
        this.cart = Array.isArray(data.posDraft.cart) ? data.posDraft.cart : [];
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
        if (typeof data.posDraft.notes === 'string') this.notes = data.posDraft.notes;
        if (data.posDraft.cashier) this.cashier = data.posDraft.cashier;
        if (data.posDraft.operator) this.operator = data.posDraft.operator;
      }
    } finally {
      this.isBooting = false;
      this.render();
      this.refreshBackendHealth();
    }

    onAuthStateChanged(auth, (u) => {
      this.user = u;
      this.render();
      if (u && this.isOnline && this.hasUnsyncedLocalRecords()) {
        void this.syncAllWithCloud();
      }
    });
  }

  public isBusyWithCriticalTask(): boolean {
    return this.isEmitting || this.isPrinting;
  }

  public async flushDraftNow(): Promise<void> {
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
      this.draftSaveTimer = null;
    }
    if (this.isBooting) return;
    await localDb.savePosDraft({
      activeModule: this.activeModule,
      previewFormat: this.previewFormat,
      cart: this.cart,
      selectedCustomerId: this.selectedCustomerId,
      docType: this.docType,
      paymentMethod: this.paymentMethod,
      amountReceivedInput: this.amountReceivedInput,
      notes: this.notes,
      cashier: this.cashier,
      operator: this.operator,
      updatedAtIso: new Date().toISOString(),
    });
  }

  private scheduleDraftSave(): void {
    if (this.isBooting) return;
    if (this.draftSaveTimer !== null) {
      window.clearTimeout(this.draftSaveTimer);
    }
    this.draftSaveTimer = window.setTimeout(() => {
      this.draftSaveTimer = null;
      void this.flushDraftNow();
    }, 120);
  }

  private hasUnsyncedLocalRecords(): boolean {
    return (
      this.invoices.some((i) => !i.synced) ||
      this.products.some((p) => !p.synced) ||
      this.customers.some((c) => !c.synced) ||
      this.settings.synced === false
    );
  }

  private setupGlobalListeners(): void {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    this.isInstalled = standalone;
    this.isIOS = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.render();
    });

    window.addEventListener('appinstalled', () => {
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

    // Event Delegation Centralizada (Zero listeners duplicados)
    this.root.addEventListener('click', (e) => this.handleClick(e));
    this.root.addEventListener('input', (e) => this.handleInput(e));
    this.root.addEventListener('change', (e) => this.handleChange(e));
    this.root.addEventListener('keydown', (e) => this.handleKeyDown(e));
    this.root.addEventListener('submit', (e) => this.handleSubmit(e));
  }

  private getFilteredPosProducts(): Product[] {
    const q = this.posSearch.trim().toLowerCase();
    return this.products.filter((p) => {
      if (!p.active) return false;
      if (this.posCategoryFilter !== 'ALL' && (p.category || 'Geral') !== this.posCategoryFilter) {
        return false;
      }
      if (this.posTaxFilter !== 'ALL' && p.ivaRate !== this.posTaxFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
      );
    });
  }

  private addProductToCart(prod: Product): void {
    this.lastEmitted = null;
    this.lastAuditHash = '';
    const existing = this.cart.find((c) => c.productId === prod.id);
    if (existing) {
      existing.qty = roundKz(existing.qty + 1);
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

    const totals = calculateInvoiceTotals(this.cart);
    const nextNumber = generateNextInvoiceNumber(
      this.invoices.map((i) => i.number),
      this.docType
    );
    const customer =
      this.customers.find((c) => c.id === this.selectedCustomerId) ||
      this.customers[0] || {
        id: 'cust_direct',
        name: 'Cliente de Venda Directa',
        nif: 'Consumidor Final',
        locality: 'Saurimo - Angola',
      };

    const parsedRec = parseFloat(this.amountReceivedInput.replace(',', '.'));
    const numericReceived =
      this.paymentMethod !== 'Dinheiro'
        ? totals.grandTotal
        : !Number.isNaN(parsedRec) && parsedRec > 0
          ? roundKz(parsedRec)
          : totals.grandTotal;

    const changeAmount = Math.max(0, roundKz(numericReceived - totals.grandTotal));
    const now = new Date().toISOString();

    return {
      id: 'preview_draft',
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
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBase0: totals.taxBase0,
      taxAmount0: 0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: totals.amountInWords,
      amountReceived: numericReceived,
      changeAmount,
      notes: this.notes,
      status: 'issued',
      lines: totals.lines,
      createdAtIso: now,
      updatedAtIso: now,
    };
  }

  // ==================== HANDLERS DE INTERAÇÃO ====================

  private async handleClick(e: MouseEvent): Promise<void> {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id || '';
    const value = target.dataset.value || '';

    switch (action) {
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
        if (mod === 'NEW_POS') this.previewFormat = 'POS';
        if (mod === 'NEW_A4') this.previewFormat = 'A4';
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
        const prod = this.products.find((p) => p.id === id);
        if (!prod) return;
        this.addProductToCart(prod);
        this.render();
        break;
      }
      case 'qty-delta': {
        const delta = Number(value);
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
      case 'set-cart-iva': {
        const nextIva: TaxRate = Number(value) === 0 ? 0 : 14;
        this.cart = this.cart.map((item) =>
          item.productId === id ? { ...item, ivaRate: nextIva } : item
        );
        this.scheduleDraftSave();
        this.render();
        break;
      }
      case 'remove-cart-item': {
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
          this.selectedCustomerId = id;
          this.showCustomerPicker = false;
          this.posCustomerSearch = '';
          this.scheduleDraftSave();
          this.render();
        }
        break;
      }
      case 'toggle-quick-customer': {
        this.showQuickCustomerForm = !this.showQuickCustomerForm;
        if (this.showQuickCustomerForm) {
          this.showCustomerPicker = false;
        }
        this.render();
        if (this.showQuickCustomerForm) {
          const nameInput = document.getElementById('quick-customer-name-input') as HTMLInputElement | null;
          nameInput?.focus();
        }
        break;
      }
      case 'clear-pos': {
        this.cart = [];
        this.amountReceivedInput = '';
        this.lastEmitted = null;
        this.lastAuditHash = '';
        void this.flushDraftNow();
        this.render();
        break;
      }
      case 'toggle-pos-options': {
        this.showOptionsDrawer = !this.showOptionsDrawer;
        this.render();
        break;
      }
      case 'set-payment': {
        this.paymentMethod = value as PaymentMethod;
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
        const nextCode = String(this.products.length + 1).padStart(5, '0');
        const now = new Date().toISOString();
        this.isNewProduct = true;
        this.editingProduct = {
          id: `prod_${Date.now()}`,
          code: nextCode,
          name: '',
          category: 'Mercearia',
          unit: 'un',
          price: 0,
          ivaRate: 14,
          exemptionReason: '',
          active: true,
          synced: false,
          createdAtIso: now,
          updatedAtIso: now,
        };
        this.render();
        break;
      }
      case 'edit-product': {
        const targetProd = this.products.find((p) => p.id === id);
        if (targetProd) {
          this.isNewProduct = false;
          this.editingProduct = { ...targetProd };
          this.render();
        }
        break;
      }
      case 'cancel-edit-product': {
        this.editingProduct = null;
        this.render();
        break;
      }
      case 'delete-product': {
        await localDb.deleteProduct(id);
        this.products = this.products.filter((p) => p.id !== id);
        this.render();
        if (this.user && this.isOnline) {
          try {
            await removeProductCloud(id);
          } catch {
            // Mantém estado local
          }
        }
        break;
      }
      case 'new-customer': {
        const now = new Date().toISOString();
        this.editingCustomer = {
          id: `cust_${Date.now()}`,
          name: '',
          nif: '',
          locality: 'Saurimo - Angola',
          phone: '',
          address: '',
          synced: false,
          createdAtIso: now,
          updatedAtIso: now,
        };
        this.render();
        break;
      }
      case 'edit-customer': {
        const cust = this.customers.find((c) => c.id === id);
        if (cust) {
          this.editingCustomer = { ...cust };
          this.render();
        }
        break;
      }
      case 'cancel-edit-customer': {
        this.editingCustomer = null;
        this.render();
        break;
      }
      case 'delete-customer': {
        if (id === 'cust_direct') return;
        await localDb.deleteCustomer(id);
        this.customers = this.customers.filter((c) => c.id !== id);
        this.render();
        if (this.user && this.isOnline) {
          try {
            await removeCustomerCloud(id);
          } catch {
            // Removido localmente
          }
        }
        break;
      }
      case 'select-history': {
        this.selectedHistoryId = id;
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
        const inv = this.invoices.find((i) => i.id === id);
        if (!inv || inv.status === 'cancelled') return;
        const cancelled: InvoiceRecord = {
          ...inv,
          status: 'cancelled',
          synced: false,
          updatedAtIso: new Date().toISOString(),
        };
        await localDb.saveInvoice(cancelled);
        this.invoices = this.invoices.map((x) => (x.id === id ? cancelled : x));
        this.render();

        if (this.user && this.isOnline) {
          try {
            await cancelInvoiceCloud(id);
            const synced = { ...cancelled, synced: true };
            await localDb.saveInvoice(synced);
            this.invoices = this.invoices.map((x) => (x.id === id ? synced : x));
            this.render();
          } catch {
            // Pendente de sync
          }
        }
        break;
      }
      case 'reset-settings': {
        const resetVal: AppSettings = {
          ...DEFAULT_SETTINGS,
          synced: false,
          updatedAtIso: new Date().toISOString(),
        };
        await this.persistSettings(resetVal);
        break;
      }
      case 'signin-google': {
        if (!this.isOnline) return;
        try {
          await signInWithGoogle();
        } catch (err) {
          this.syncMessage =
            err instanceof Error ? err.message : 'Autenticação cancelada.';
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
        await this.syncAllWithCloud();
        break;
      }
      case 'export-backup-local': {
        this.exportLocalJsonBackup();
        break;
      }
      case 'export-backup-cloud': {
        try {
          this.syncMessage = null;
          await downloadCloudBackupJson();
        } catch (err) {
          this.syncMessage =
            err instanceof Error ? err.message : 'Erro ao exportar backup da cloud.';
          this.render();
        }
        break;
      }
      case 'install-pwa': {
        if (this.deferredPrompt) {
          await this.deferredPrompt.prompt();
          const choice = await this.deferredPrompt.userChoice;
          if (choice.outcome === 'accepted') {
            this.isInstalled = true;
            this.deferredPrompt = null;
          }
          this.render();
        } else if (this.isIOS) {
          this.showIOSGuide = true;
          this.render();
        }
        break;
      }
      case 'close-ios-guide': {
        this.showIOSGuide = false;
        this.render();
        break;
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent): void {
    const el = e.target as HTMLInputElement;
    if (!el || !el.dataset) return;

    if (el.dataset.field === 'pos-search' && e.key === 'Enter') {
      e.preventDefault();
      const matches = this.getFilteredPosProducts();
      if (matches.length > 0) {
        this.addProductToCart(matches[0]!);
        this.posSearch = '';
        this.renderPreservingFocus('pos-search-input', 0);
      }
      return;
    }

    if (el.dataset.field === 'pos-customer-search' && e.key === 'Enter') {
      e.preventDefault();
      const cq = this.posCustomerSearch.trim().toLowerCase();
      const match = this.customers.find(
        (c) =>
          !cq ||
          c.name.toLowerCase().includes(cq) ||
          c.nif.toLowerCase().includes(cq) ||
          c.locality.toLowerCase().includes(cq)
      );
      if (match) {
        this.selectedCustomerId = match.id;
        this.showCustomerPicker = false;
        this.posCustomerSearch = '';
        this.scheduleDraftSave();
        this.render();
      }
      return;
    }

    if (e.key === 'Escape' && (this.showCustomerPicker || this.showQuickCustomerForm)) {
      this.showCustomerPicker = false;
      this.showQuickCustomerForm = false;
      this.render();
    }
  }

  private handleInput(e: Event): void {
    const el = e.target as HTMLInputElement;
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
    }
  }

  private handleChange(e: Event): void {
    const el = e.target as HTMLInputElement | HTMLSelectElement;
    const field = el.dataset.field;
    const id = el.dataset.id || '';
    if (!field) return;

    switch (field) {
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
    }
  }

  private async handleSubmit(e: SubmitEvent): Promise<void> {
    const form = e.target as HTMLFormElement;
    const formName = form.dataset.form;
    if (!formName) return;
    e.preventDefault();

    const fd = new FormData(form);

    if (formName === 'pos-quick-customer-form') {
      const name = String(fd.get('name') || '').trim();
      const nif = String(fd.get('nif') || '').trim() || 'Consumidor Final';
      const phone = String(fd.get('phone') || '').trim();
      const locality = String(fd.get('locality') || '').trim() || 'Saurimo - Angola';

      if (!name) return;

      const now = new Date().toISOString();
      const created: Customer = {
        id: `cust_${Date.now()}`,
        name,
        nif,
        phone,
        locality,
        address: locality,
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      await localDb.saveCustomer(created);
      this.customers = [created, ...this.customers].sort((a, b) =>
        a.id === 'cust_direct' ? -1 : b.id === 'cust_direct' ? 1 : a.name.localeCompare(b.name)
      );
      this.selectedCustomerId = created.id;
      this.showQuickCustomerForm = false;
      this.showCustomerPicker = false;
      this.scheduleDraftSave();
      this.render();

      if (this.user && this.isOnline) {
        try {
          await upsertCustomerCloud(created);
          const synced = { ...created, synced: true };
          await localDb.saveCustomer(synced);
          this.customers = this.customers.map((c) => (c.id === synced.id ? synced : c));
          this.render();
        } catch {
          // Mantém pendente localmente
        }
      }
      return;
    }

    if (formName === 'product-form' && this.editingProduct) {
      const code = String(fd.get('code') || '').trim();
      const name = String(fd.get('name') || '').trim();
      const category = String(fd.get('category') || 'Mercearia').trim() || 'Mercearia';
      const unit = String(fd.get('unit') || 'un').trim() || 'un';
      const price = Math.max(0, parseFloat(String(fd.get('price') || '0')) || 0);
      const ivaRate: TaxRate = Number(fd.get('ivaRate')) === 0 ? 0 : 14;

      if (!code || !name) return;

      const updated: Product = {
        ...this.editingProduct,
        code,
        name,
        category,
        unit,
        price,
        ivaRate,
        exemptionReason:
          ivaRate === 0 ? 'Isento nos termos da Lei do IVA (Cesta Básica)' : '',
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      const wasNew = this.isNewProduct;
      await localDb.saveProduct(updated);
      this.products = [
        ...this.products.filter((p) => p.id !== updated.id),
        updated,
      ].sort((a, b) => a.code.localeCompare(b.code));
      this.editingProduct = null;
      this.render();

      if (this.user && this.isOnline) {
        try {
          await upsertProductCloud(updated, wasNew);
          const synced = { ...updated, synced: true };
          await localDb.saveProduct(synced);
          this.products = this.products.map((p) => (p.id === synced.id ? synced : p));
          this.render();
        } catch {
          // Fica pendente para sync
        }
      }
    }

    if (formName === 'customer-form' && this.editingCustomer) {
      const name = String(fd.get('name') || '').trim();
      const nif = String(fd.get('nif') || '').trim() || 'Consumidor Final';
      const phone = String(fd.get('phone') || '').trim();
      const locality = String(fd.get('locality') || '').trim() || 'Saurimo - Angola';

      if (!name) return;

      const updated: Customer = {
        ...this.editingCustomer,
        name,
        nif,
        phone,
        locality,
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      await localDb.saveCustomer(updated);
      this.customers = [
        ...this.customers.filter((c) => c.id !== updated.id),
        updated,
      ].sort((a, b) =>
        a.id === 'cust_direct' ? -1 : b.id === 'cust_direct' ? 1 : a.name.localeCompare(b.name)
      );
      this.editingCustomer = null;
      this.render();

      if (this.user && this.isOnline) {
        try {
          await upsertCustomerCloud(updated);
          const synced = { ...updated, synced: true };
          await localDb.saveCustomer(synced);
          this.customers = this.customers.map((c) => (c.id === synced.id ? synced : c));
          this.render();
        } catch {
          // Fica pendente localmente
        }
      }
    }

    if (formName === 'settings-form') {
      const nextSettings: AppSettings = {
        company: {
          legalName: String(fd.get('legalName') || '').trim() || DEFAULT_SETTINGS.company.legalName,
          shortName: String(fd.get('shortName') || '').trim() || DEFAULT_SETTINGS.company.shortName,
          nif: String(fd.get('nif') || '').trim() || DEFAULT_SETTINGS.company.nif,
          address: String(fd.get('address') || '').trim() || DEFAULT_SETTINGS.company.address,
          cityCountry: this.settings.company.cityCountry || 'Saurimo - Angola',
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
        synced: false,
        updatedAtIso: new Date().toISOString(),
      };

      await this.persistSettings(nextSettings);
    }
  }

  private async persistSettings(nextSettings: AppSettings): Promise<void> {
    await localDb.saveSettings(nextSettings);
    this.settings = nextSettings;
    this.cashier = nextSettings.defaultCashier;
    this.operator = nextSettings.defaultOperator;
    this.docType = nextSettings.defaultDocType;
    this.notes = nextSettings.defaultNotes;
    this.settingsSavedNotice = true;
    this.render();

    setTimeout(() => {
      this.settingsSavedNotice = false;
      if (this.activeModule === 'SETTINGS') this.render();
    }, 2000);

    if (this.user && this.isOnline) {
      try {
        await upsertSettingsCloud(nextSettings);
        const synced = { ...nextSettings, synced: true };
        await localDb.saveSettings(synced);
        this.settings = synced;
        this.render();
      } catch {
        // Mantém pendente
      }
    }
  }

  private async emitCurrentInvoice(autoPrint: boolean): Promise<void> {
    if (this.cart.length === 0 || this.isEmitting) return;
    this.isEmitting = true;
    this.render();

    try {
      const draft = this.buildLivePreviewInvoice();
      const now = new Date().toISOString();
      const invoice: InvoiceRecord = {
        ...draft,
        id: `inv_${Date.now()}`,
        issuedAtIso: now,
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      await localDb.saveInvoice(invoice);
      this.invoices = [invoice, ...this.invoices];
      this.selectedHistoryId = invoice.id;
      this.lastEmitted = invoice;
      this.cart = [];
      this.amountReceivedInput = '';
      this.mobilePane = 'PREVIEW';
      await this.flushDraftNow();
      this.render();

      // Sincronização Cloud + Auditoria Backend (/api/audit/invoices) quando online e autenticado
      if (this.user && this.isOnline) {
        try {
          await createInvoiceCloud(invoice);
          const syncedInv = { ...invoice, synced: true };
          await localDb.saveInvoice(syncedInv);
          this.invoices = this.invoices.map((i) => (i.id === syncedInv.id ? syncedInv : i));
          this.lastEmitted = syncedInv;

          const auditRes = await submitInvoiceAudit(syncedInv);
          if (auditRes.ok && auditRes.auditHash) {
            this.lastAuditHash = auditRes.auditHash.slice(0, 12);
          }
          this.render();
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

  private async syncAllWithCloud(): Promise<void> {
    if (!this.user || !this.isOnline || this.isSyncing) return;
    this.isSyncing = true;
    this.syncMessage = null;
    this.render();

    try {
      const unsyncedProducts = this.products.filter((p) => !p.synced);
      for (const prod of unsyncedProducts) {
        await upsertProductCloud(prod, true);
        await localDb.saveProduct({ ...prod, synced: true });
      }

      const unsyncedCustomers = this.customers.filter((c) => !c.synced);
      for (const cust of unsyncedCustomers) {
        await upsertCustomerCloud(cust);
        await localDb.saveCustomer({ ...cust, synced: true });
      }

      const unsyncedInvoices = this.invoices.filter((i) => !i.synced);
      for (const inv of unsyncedInvoices) {
        await createInvoiceCloud(inv);
        await submitInvoiceAudit(inv).catch(() => null);
        await localDb.saveInvoice({ ...inv, synced: true });
      }

      if (!this.settings.synced) {
        await upsertSettingsCloud(this.settings);
        const syncedSettings = { ...this.settings, synced: true };
        await localDb.saveSettings(syncedSettings);
      }

      const cloudData = await pullAllFromCloud();
      if (cloudData) {
        for (const cp of cloudData.products) await localDb.saveProduct(cp);
        for (const cc of cloudData.customers) await localDb.saveCustomer(cc);
        for (const ci of cloudData.invoices) await localDb.saveInvoice(ci);
        if (cloudData.settings) await localDb.saveSettings(cloudData.settings);

        const refreshed = await bootstrapLocalStore();
        this.products = refreshed.products;
        this.customers = refreshed.customers;
        this.invoices = refreshed.invoices;
        this.settings = refreshed.settings;
      }

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
      schemaVersion: '1.0.0',
      source: 'indexeddb-local',
      exportedAtIso: new Date().toISOString(),
      company: this.settings.company,
      counts: {
        products: this.products.length,
        customers: this.customers.length,
        invoices: this.invoices.length,
      },
      data: {
        settings: this.settings,
        products: this.products,
        customers: this.customers,
        invoices: this.invoices,
      },
    };

    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sila-billing-local-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  private async triggerPrint(invoice: InvoiceRecord, format: DocumentFormat): Promise<void> {
    this.isPrinting = true;
    const qr = await this.ensureQrForInvoice(invoice);
    document.body.setAttribute('data-print-mode', format);
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
    const pendingCount =
      this.products.filter((p) => !p.synced).length +
      this.customers.filter((c) => !c.synced).length +
      this.invoices.filter((i) => !i.synced).length +
      (this.settings.synced ? 0 : 1);

    const canInstall = !this.isInstalled && (Boolean(this.deferredPrompt) || this.isIOS);

    this.root.innerHTML = `
      <div class="no-print h-dvh w-screen flex flex-col overflow-hidden bg-slate-50 text-slate-900">
        <!-- Top Bar Limpa (3 Zonas) -->
        <header class="h-12 px-3 bg-slate-900 text-white border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
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
          </div>

          <div class="hidden md:flex items-center gap-2 text-xs text-slate-400 truncate">
            <span class="truncate">${escapeHtml(this.settings.company.shortName)}</span>
            <span aria-hidden="true">·</span>
            <span class="font-mono tabular-nums">NIF ${escapeHtml(this.settings.company.nif)}</span>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            ${
              canInstall
                ? `<button
                    type="button"
                    data-action="install-pwa"
                    class="h-8 px-2.5 rounded-md bg-blue-600 hover:bg-blue-700 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${ICONS.download}
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

        <!-- Área Principal com Aba Esquerda 100% Recolhível -->
        <div class="flex-1 flex overflow-hidden">
          ${this.renderSidebar(pendingCount)}

          <main class="flex-1 overflow-hidden">
            ${this.isBooting ? this.renderBooting() : this.renderActiveWorkspace()}
          </main>
        </div>

        ${this.showIOSGuide ? this.renderIOSModal() : ''}
      </div>

      ${
        this.printJob
          ? `<div class="hidden print-only-container">
              ${renderDocumentHtml(
                this.printJob.invoice,
                this.printJob.format,
                this.settings.company,
                this.printJob.qr
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
    switch (this.activeModule) {
      case 'NEW_POS':
      case 'NEW_A4':
        return this.renderPosWorkspace();
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

    const visibleProducts = this.getFilteredPosProducts();

    const totals = calculateInvoiceTotals(this.cart);
    const liveInvoice = this.buildLivePreviewInvoice();
    const cartCount = roundKz(this.cart.reduce((acc, c) => acc + c.qty, 0));

    const selectedCustomer =
      this.customers.find((c) => c.id === this.selectedCustomerId) ||
      this.customers[0] || {
        id: 'cust_direct',
        name: 'Cliente de Venda Directa',
        nif: 'Consumidor Final',
        locality: 'Saurimo - Angola',
      };

    const cq = this.posCustomerSearch.trim().toLowerCase();
    const matchingCustomers = this.customers.filter(
      (c) =>
        !cq ||
        c.name.toLowerCase().includes(cq) ||
        c.nif.toLowerCase().includes(cq) ||
        c.locality.toLowerCase().includes(cq)
    );

    const cacheKey = `${liveInvoice.number}|${liveInvoice.grandTotal.toFixed(2)}|${this.settings.company.nif}`;
    const cachedQr = this.qrCache.get(cacheKey) || '';
    if (liveInvoice.lines.length > 0 && !cachedQr) {
      this.ensureQrForInvoice(liveInvoice);
    }

    const isA4 = this.previewFormat === 'A4';

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
          <!-- COLUNA 1: Pesquisa Rápida & Categorias Compactas -->
          <section class="${isA4 ? 'lg:col-span-4' : 'lg:col-span-5'} flex flex-col border-r border-slate-200 bg-slate-50/60 overflow-hidden ${
            this.mobilePane === 'CATALOG' ? 'flex' : 'hidden lg:flex'
          }">
            <div class="p-3 border-b border-slate-200 bg-white space-y-2 shrink-0">
              <!-- Pesquisa rápida + filtro de regime fiscal -->
              <div class="flex items-center gap-2">
                <div class="relative flex-1 min-w-0">
                  <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                  <input
                    id="pos-search-input"
                    type="text"
                    autocomplete="off"
                    data-field="pos-search"
                    value="${escapeHtml(this.posSearch)}"
                    placeholder="Pesquisar código, artigo ou Enter p/ adicionar..."
                    class="w-full h-10 pl-9 ${this.posSearch ? 'pr-8' : 'pr-3'} text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
                  />
                  ${
                    this.posSearch
                      ? `<button
                          type="button"
                          data-action="clear-pos-search"
                          title="Limpar pesquisa"
                          class="h-7 w-7 absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60"
                        >${ICONS.close}</button>`
                      : ''
                  }
                </div>
                <div class="flex items-center bg-slate-100 p-0.5 rounded-lg shrink-0">
                  ${(['ALL', '14', '0'] as const)
                    .map((f) => {
                      const active = String(this.posTaxFilter) === f;
                      const label = f === 'ALL' ? 'Todos' : f === '14' ? '14%' : 'Isento';
                      return `
                        <button
                          type="button"
                          data-action="tax-filter"
                          data-value="${f}"
                          class="h-9 px-2.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                            active ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                          }"
                        >${label}</button>
                      `;
                    })
                    .join('')}
                </div>
              </div>

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
                  ? `<div class="h-40 flex flex-col items-center justify-center gap-2 text-xs text-slate-500">
                      <span>Nenhum artigo encontrado para o filtro atual.</span>
                      ${
                        this.posSearch || this.posCategoryFilter !== 'ALL' || this.posTaxFilter !== 'ALL'
                          ? `<button
                              type="button"
                              data-action="pos-category"
                              data-value="ALL"
                              class="text-blue-600 hover:underline font-medium"
                            >Mostrar todas as categorias</button>`
                          : ''
                      }
                    </div>`
                  : `<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-2">
                      ${visibleProducts
                        .map((prod) => {
                          const inCart = this.cart.find((c) => c.productId === prod.id);
                          return `
                            <button
                              type="button"
                              data-action="add-to-cart"
                              data-id="${escapeHtml(prod.id)}"
                              class="text-left p-2.5 rounded-lg border transition-colors min-h-[88px] flex flex-col justify-between bg-white hover:border-blue-600 active:bg-slate-50 ${
                                inCart ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-200'
                              }"
                            >
                              <div class="flex items-center justify-between gap-1.5 w-full text-[10px] text-slate-400">
                                <span class="font-mono truncate">${escapeHtml(prod.code)} · ${escapeHtml(prod.category || 'Geral')}</span>
                                <span class="tabular-nums shrink-0 text-slate-500">${prod.ivaRate === 14 ? '14%' : 'Isento'}</span>
                              </div>
                              <div class="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug my-1">${escapeHtml(prod.name)}</div>
                              <div class="flex items-center justify-between gap-1 w-full pt-1 border-t border-slate-100">
                                <span class="text-xs font-bold text-slate-900 font-mono tabular-nums">${formatKzNumber(prod.price)} Kz</span>
                                ${
                                  inCart
                                    ? `<span class="text-[11px] font-mono font-bold text-blue-600 tabular-nums">×${inCart.qty}</span>`
                                    : ''
                                }
                              </div>
                            </button>
                          `;
                        })
                        .join('')}
                    </div>`
              }
            </div>
          </section>

          <!-- COLUNA 2: Área de Faturação (Cliente, Artigos Adicionados, Edição Direta & Totais) -->
          <section class="lg:col-span-4 flex flex-col border-r border-slate-200 bg-white overflow-hidden ${
            this.mobilePane === 'CART' ? 'flex' : 'hidden lg:flex'
          }">
            <!-- Barra de Seleção Rápida e Cadastro Rápido de Cliente -->
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
                        ${escapeHtml(selectedCustomer.nif || 'Consumidor Final')} · ${escapeHtml(selectedCustomer.locality || 'Saurimo')}
                      </div>
                    </div>
                    <span class="text-slate-400 shrink-0">${this.showCustomerPicker ? ICONS.chevronUp : ICONS.chevronDown}</span>
                  </button>
                  ${
                    this.selectedCustomerId !== 'cust_direct'
                      ? `<button
                          type="button"
                          data-action="select-pos-customer"
                          data-id="cust_direct"
                          title="Repor Cliente de Venda Directa"
                          class="h-8 w-8 mr-1 flex items-center justify-center rounded text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 shrink-0"
                        >${ICONS.close}</button>`
                      : ''
                  }
                </div>

                <button
                  type="button"
                  data-action="toggle-quick-customer"
                  title="Cadastro rápido de cliente sem sair da fatura"
                  class="h-10 px-2.5 flex items-center justify-center gap-1 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
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

              <!-- Painel de Seleção Rápida de Cliente com Pesquisa Instantânea -->
              ${
                this.showCustomerPicker
                  ? `
                  <div class="border border-slate-200 rounded-lg bg-slate-50 p-2 space-y-1.5">
                    <div class="relative">
                      <span class="text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
                      <input
                        id="pos-customer-search-input"
                        type="text"
                        autocomplete="off"
                        data-field="pos-customer-search"
                        value="${escapeHtml(this.posCustomerSearch)}"
                        placeholder="Filtrar cliente por nome ou NIF..."
                        class="w-full h-8 pl-8 pr-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                      />
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
                                return `
                                  <button
                                    type="button"
                                    data-action="select-pos-customer"
                                    data-id="${escapeHtml(c.id)}"
                                    class="w-full px-2.5 py-2 text-left flex items-center justify-between gap-2 text-xs transition-colors ${
                                      isSel ? 'bg-blue-50/80 text-blue-900 font-semibold' : 'hover:bg-slate-50 text-slate-800'
                                    }"
                                  >
                                    <span class="truncate">${escapeHtml(c.name)}</span>
                                    <span class="text-[10px] font-mono text-slate-500 shrink-0 tabular-nums">${escapeHtml(c.nif || 'Consumidor Final')}</span>
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
                    <div class="grid grid-cols-2 gap-1.5">
                      <div class="col-span-2">
                        <input
                          id="quick-customer-name-input"
                          name="name"
                          type="text"
                          required
                          maxlength="160"
                          placeholder="Nome completo ou empresa *"
                          class="w-full h-8 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div>
                        <input
                          name="nif"
                          type="text"
                          maxlength="32"
                          placeholder="NIF (ou Consumidor Final)"
                          class="w-full h-8 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div>
                        <input
                          name="phone"
                          type="text"
                          maxlength="40"
                          placeholder="Telefone (+244...)"
                          class="w-full h-8 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div class="col-span-2 flex items-center gap-1.5">
                        <input
                          name="locality"
                          type="text"
                          maxlength="160"
                          value="Saurimo - Angola"
                          placeholder="Localidade"
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
                    <div class="col-span-3">
                      <input
                        type="text"
                        maxlength="160"
                        data-field="pos-notes"
                        value="${escapeHtml(this.notes)}"
                        placeholder="Observações na fatura..."
                        class="w-full h-8 px-2.5 bg-slate-50 border border-slate-200 rounded-md text-xs"
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
                ? `<div class="px-3 py-1.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-[11px] text-slate-500 shrink-0 tabular-nums">
                    <span>${this.cart.length} ${this.cart.length === 1 ? 'artigo' : 'artigos'} · ${cartCount} un</span>
                    <button
                      type="button"
                      data-action="clear-pos"
                      class="text-slate-500 hover:text-red-600 font-medium transition-colors"
                    >Limpar tudo</button>
                  </div>`
                : ''
            }

            <!-- Lista de Artigos Adicionados com Edição Direta de Qtd, Preço e IVA 14% / Isento -->
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
                        return `
                        <div class="p-2.5 hover:bg-slate-50/60 transition-colors space-y-2">
                          <div class="flex items-start justify-between gap-2">
                            <div class="min-w-0 flex-1">
                              <div class="text-xs font-semibold text-slate-900 truncate">${escapeHtml(line.description)}</div>
                              <div class="text-[10.5px] text-slate-400 font-mono tabular-nums">
                                ${escapeHtml(line.code)} · ${escapeHtml(line.unit)} ${
                                  line.ivaRate === 14
                                    ? `· IVA ${formatKzNumber(line.lineTax)} Kz`
                                    : '· Isento 0%'
                                }
                              </div>
                            </div>
                            <div class="flex items-center gap-1.5 shrink-0">
                              <div class="text-right">
                                <div class="text-xs font-bold text-slate-900 font-mono tabular-nums">${formatKzNumber(line.lineTotal)} Kz</div>
                              </div>
                              <button
                                type="button"
                                data-action="remove-cart-item"
                                data-id="${escapeHtml(line.productId)}"
                                title="Remover artigo"
                                class="h-7 w-7 flex items-center justify-center text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50 transition-colors"
                              >${ICONS.trash}</button>
                            </div>
                          </div>

                          <!-- Controlos diretos: Quantidade | Preço Unit. | IVA 14% / Isento -->
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

                            <!-- Edição direta de Preço Unitário (Kz) -->
                            <div class="flex items-center gap-1 flex-1 min-w-[108px] h-8 px-2 border border-slate-200 rounded-md bg-white focus-within:border-blue-600">
                              <span class="text-[10px] text-slate-400 shrink-0">Preço</span>
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
                            </div>

                            <!-- Seletor compacto de IVA 14% ou Isenção por artigo -->
                            <div class="flex items-center bg-slate-100 p-0.5 rounded-md h-8 shrink-0">
                              <button
                                type="button"
                                data-action="set-cart-iva"
                                data-id="${escapeHtml(line.productId)}"
                                data-value="14"
                                title="Aplicar IVA de 14% neste artigo"
                                class="h-7 px-2 rounded text-[10.5px] font-medium transition-colors whitespace-nowrap tabular-nums ${
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
                                class="h-7 px-2 rounded text-[10.5px] font-medium transition-colors whitespace-nowrap ${
                                  line.ivaRate === 0
                                    ? 'bg-white text-slate-900 shadow-xs font-semibold'
                                    : 'text-slate-500 hover:text-slate-900'
                                }"
                              >Isento</button>
                            </div>
                          </div>
                        </div>
                      `;
                      })
                      .join('')
              }
            </div>

            <!-- Rodapé Faturação: Subtotal, Impostos (IVA 14% / Isento) e Total Automático -->
            <div class="border-t border-slate-200 bg-slate-50 p-3 space-y-2.5 shrink-0">
              <div class="space-y-1 text-xs tabular-nums">
                <div class="flex justify-between text-slate-600">
                  <span>Subtotal</span>
                  <span class="font-mono">${formatKzNumber(totals.merchandiseTotal)} Kz</span>
                </div>
                ${
                  totals.discountTotal > 0
                    ? `<div class="flex justify-between text-slate-500 text-[11px]">
                        <span>Desconto comercial</span>
                        <span class="font-mono">-${formatKzNumber(totals.discountTotal)} Kz</span>
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
                <div class="flex justify-between items-baseline pt-1.5 border-t border-slate-200">
                  <span class="font-bold text-slate-900">Total a pagar</span>
                  <span class="text-lg font-bold text-slate-900 font-mono">${formatKzNumber(totals.grandTotal)} Kz</span>
                </div>
              </div>

              <div class="grid grid-cols-3 gap-1 bg-slate-200/70 p-0.5 rounded-lg">
                ${(['Dinheiro', 'Multicaixa', 'Transferência'] as PaymentMethod[])
                  .map(
                    (m) => `
                    <button
                      type="button"
                      data-action="set-payment"
                      data-value="${m}"
                      class="h-8 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                        this.paymentMethod === m ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                      }"
                    >${m}</button>
                  `
                  )
                  .join('')}
              </div>

              ${
                this.paymentMethod === 'Dinheiro'
                  ? `
                  <div class="space-y-1.5">
                    <div class="grid grid-cols-2 gap-2">
                      <div>
                        <label class="block text-[10px] text-slate-500 mb-0.5">Valor recebido (Kz)</label>
                        <input
                          id="amount-received-input"
                          type="text"
                          inputmode="decimal"
                          data-field="amount-received"
                          value="${escapeHtml(this.amountReceivedInput)}"
                          placeholder="${formatKzNumber(totals.grandTotal)}"
                          class="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold tabular-nums focus:outline-none focus:border-blue-600"
                        />
                      </div>
                      <div class="flex flex-col justify-end text-right">
                        <span class="text-[10px] text-slate-500">Troco</span>
                        <span class="h-9 flex items-center justify-end text-sm font-bold font-mono text-emerald-700 tabular-nums">
                          ${formatKzNumber(liveInvoice.changeAmount)} Kz
                        </span>
                      </div>
                    </div>

                    ${
                      totals.grandTotal > 0
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
                  : ''
              }

              <div class="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  data-action="emit-invoice"
                  data-value="save"
                  ${this.cart.length === 0 || this.isEmitting ? 'disabled' : ''}
                  class="flex-1 h-11 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
                >
                  ${ICONS.check}
                  <span>Emitir</span>
                </button>
                <button
                  type="button"
                  data-action="emit-invoice"
                  data-value="print"
                  ${this.cart.length === 0 || this.isEmitting ? 'disabled' : ''}
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
                  : renderDocumentHtml(liveInvoice, this.previewFormat, this.settings.company, cachedQr)
              }
            </div>
          </section>
        </div>
      </div>
    `;
  }

  // ==================== 3. CLIENTES ====================

  private renderCustomersWorkspace(): string {
    const q = this.customerSearch.trim().toLowerCase();
    const filtered = this.customers.filter(
      (c) =>
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.nif.toLowerCase().includes(q) ||
        c.locality.toLowerCase().includes(q)
    );

    return `
      <div class="h-full flex flex-col bg-white overflow-hidden">
        <div class="p-3 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
          <div class="relative flex-1 max-w-md">
            <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
            <input
              id="customer-search-input"
              type="text"
              data-field="customer-search"
              value="${escapeHtml(this.customerSearch)}"
              placeholder="Filtrar clientes por nome, NIF ou localidade..."
              class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
            />
          </div>
          <button
            type="button"
            data-action="new-customer"
            class="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            ${ICONS.plus}
            <span>Novo Cliente</span>
          </button>
        </div>

        ${
          this.editingCustomer
            ? `
            <form
              data-form="customer-form"
              class="p-3.5 border-b border-slate-200 bg-slate-50 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end shrink-0"
            >
              <div class="sm:col-span-4">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Nome / Entidade</label>
                <input
                  name="name"
                  type="text"
                  required
                  maxlength="160"
                  value="${escapeHtml(this.editingCustomer.name)}"
                  placeholder="Nome completo ou empresa"
                  class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">NIF</label>
                <input
                  name="nif"
                  type="text"
                  maxlength="32"
                  value="${escapeHtml(this.editingCustomer.nif)}"
                  placeholder="500..."
                  class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Telefone</label>
                <input
                  name="phone"
                  type="text"
                  maxlength="40"
                  value="${escapeHtml(this.editingCustomer.phone)}"
                  placeholder="(+244) 9..."
                  class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Localidade</label>
                <input
                  name="locality"
                  type="text"
                  maxlength="160"
                  value="${escapeHtml(this.editingCustomer.locality)}"
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

        <div class="flex-1 overflow-y-auto">
          <table class="w-full text-left border-collapse">
            <thead class="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
              <tr>
                <th class="py-2.5 px-3 font-medium">Cliente</th>
                <th class="py-2.5 px-3 font-medium">NIF</th>
                <th class="py-2.5 px-3 font-medium hidden sm:table-cell">Localidade</th>
                <th class="py-2.5 px-3 font-medium hidden md:table-cell">Telefone</th>
                <th class="py-2.5 px-3 font-medium text-right w-24">Ações</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-xs">
              ${filtered
                .map(
                  (c) => `
                  <tr class="hover:bg-slate-50/80">
                    <td class="py-2.5 px-3 font-medium text-slate-900">${escapeHtml(c.name)}</td>
                    <td class="py-2.5 px-3 font-mono text-slate-600 tabular-nums">${escapeHtml(c.nif)}</td>
                    <td class="py-2.5 px-3 text-slate-600 hidden sm:table-cell">${escapeHtml(c.locality)}</td>
                    <td class="py-2.5 px-3 font-mono text-slate-500 hidden md:table-cell">${escapeHtml(c.phone || '—')}</td>
                    <td class="py-2 px-3 text-right">
                      <div class="inline-flex items-center gap-1">
                        <button
                          type="button"
                          data-action="edit-customer"
                          data-id="${escapeHtml(c.id)}"
                          class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                        >${ICONS.edit}</button>
                        ${
                          c.id !== 'cust_direct'
                            ? `<button
                                type="button"
                                data-action="delete-customer"
                                data-id="${escapeHtml(c.id)}"
                                class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                              >${ICONS.trash}</button>`
                            : ''
                        }
                      </div>
                    </td>
                  </tr>
                `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==================== 4. PRODUTOS E SERVIÇOS ====================

  private renderProductsWorkspace(): string {
    const q = this.productSearch.trim().toLowerCase();
    const filtered = this.products.filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q)
    );

    const allCategories = Array.from(
      new Set([
        ...DEFAULT_PRODUCT_CATEGORIES,
        ...this.products.map((p) => (p.category || '').trim()).filter(Boolean),
      ])
    ).sort((a, b) => a.localeCompare(b, 'pt'));

    return `
      <div class="h-full flex flex-col bg-white overflow-hidden">
        <div class="p-3 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
          <div class="relative flex-1 max-w-md">
            <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
            <input
              id="product-search-input"
              type="text"
              data-field="product-search"
              value="${escapeHtml(this.productSearch)}"
              placeholder="Filtrar artigos por código, descrição ou categoria..."
              class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
            />
          </div>
          <button
            type="button"
            data-action="new-product"
            class="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            ${ICONS.plus}
            <span>Novo Artigo</span>
          </button>
        </div>

        ${
          this.editingProduct
            ? `
            <form
              data-form="product-form"
              class="p-3.5 border-b border-slate-200 bg-slate-50 grid grid-cols-2 sm:grid-cols-12 gap-2.5 items-end shrink-0"
            >
              <div class="col-span-1 sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Código</label>
                <input
                  name="code"
                  type="text"
                  required
                  maxlength="32"
                  value="${escapeHtml(this.editingProduct.code)}"
                  class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="col-span-2 sm:col-span-3">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Descrição</label>
                <input
                  name="name"
                  type="text"
                  required
                  maxlength="160"
                  value="${escapeHtml(this.editingProduct.name)}"
                  placeholder="Ex: Água Mineral 1,5L"
                  class="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="col-span-1 sm:col-span-2">
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
              <div class="col-span-1 sm:col-span-2">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Preço Unit. (Kz)</label>
                <input
                  name="price"
                  type="number"
                  required
                  min="0"
                  step="0.01"
                  value="${this.editingProduct.price}"
                  class="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="col-span-1 sm:col-span-1">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">Unid.</label>
                <input
                  name="unit"
                  type="text"
                  maxlength="12"
                  value="${escapeHtml(this.editingProduct.unit)}"
                  class="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                />
              </div>
              <div class="col-span-1 sm:col-span-1">
                <label class="block text-[10px] font-medium text-slate-600 mb-1">IVA</label>
                <select
                  name="ivaRate"
                  class="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                >
                  <option value="14" ${this.editingProduct.ivaRate === 14 ? 'selected' : ''}>14%</option>
                  <option value="0" ${this.editingProduct.ivaRate === 0 ? 'selected' : ''}>Isento</option>
                </select>
              </div>
              <div class="col-span-2 sm:col-span-1 flex items-center gap-1.5">
                <button
                  type="submit"
                  class="flex-1 h-9 px-2.5 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
                >Guardar</button>
                <button
                  type="button"
                  data-action="cancel-edit-product"
                  class="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
                >${ICONS.close}</button>
              </div>
            </form>
          `
            : ''
        }

        <div class="flex-1 overflow-y-auto">
          <table class="w-full text-left border-collapse">
            <thead class="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
              <tr>
                <th class="py-2.5 px-3 font-medium">Código</th>
                <th class="py-2.5 px-3 font-medium">Descrição</th>
                <th class="py-2.5 px-3 font-medium hidden sm:table-cell">Categoria</th>
                <th class="py-2.5 px-3 font-medium">Unid.</th>
                <th class="py-2.5 px-3 font-medium text-right">IVA</th>
                <th class="py-2.5 px-3 font-medium text-right">Preço Unit.</th>
                <th class="py-2.5 px-3 font-medium text-right w-24">Ações</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 text-xs">
              ${filtered
                .map(
                  (p) => `
                  <tr class="hover:bg-slate-50/80">
                    <td class="py-2.5 px-3 font-mono text-slate-600">${escapeHtml(p.code)}</td>
                    <td class="py-2.5 px-3 font-medium text-slate-900">${escapeHtml(p.name)}</td>
                    <td class="py-2.5 px-3 text-slate-500 hidden sm:table-cell">${escapeHtml(p.category || 'Geral')}</td>
                    <td class="py-2.5 px-3 text-slate-500">${escapeHtml(p.unit)}</td>
                    <td class="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">${p.ivaRate}%</td>
                    <td class="py-2.5 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">${formatKzNumber(p.price)} Kz</td>
                    <td class="py-2 px-3 text-right">
                      <div class="inline-flex items-center gap-1">
                        <button
                          type="button"
                          data-action="edit-product"
                          data-id="${escapeHtml(p.id)}"
                          class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                        >${ICONS.edit}</button>
                        <button
                          type="button"
                          data-action="delete-product"
                          data-id="${escapeHtml(p.id)}"
                          class="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                        >${ICONS.trash}</button>
                      </div>
                    </td>
                  </tr>
                `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // ==================== 5. HISTÓRICO DE FATURAS ====================

  private renderHistoryWorkspace(): string {
    const q = this.historySearch.trim().toLowerCase();
    const filtered = this.invoices.filter(
      (inv) =>
        !q ||
        inv.number.toLowerCase().includes(q) ||
        inv.customerName.toLowerCase().includes(q)
    );

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
          <div class="p-3 border-b border-slate-200 shrink-0">
            <div class="relative">
              <span class="text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">${ICONS.search}</span>
              <input
                id="history-search-input"
                type="text"
                data-field="history-search"
                value="${escapeHtml(this.historySearch)}"
                placeholder="Pesquisar n.º de fatura ou cliente..."
                class="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>

          <div class="flex-1 overflow-y-auto divide-y divide-slate-100">
            ${
              filtered.length === 0
                ? `<div class="p-8 text-center text-xs text-slate-500">Nenhuma fatura encontrada.</div>`
                : filtered
                    .map((inv) => {
                      const dt = formatDateTimePt(inv.issuedAtIso);
                      const isSel = active?.id === inv.id;
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
                                  : ''
                              }
                            </div>
                            <div class="text-xs text-slate-600 truncate mt-0.5">
                              ${escapeHtml(inv.customerName)} · ${escapeHtml(inv.paymentMethod)}
                            </div>
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
              <div class="p-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0">
                <div class="flex items-center bg-slate-100 p-0.5 rounded-lg">
                  <button
                    type="button"
                    data-action="set-history-format"
                    data-value="POS"
                    class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors ${
                      this.historyViewFormat === 'POS' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }"
                  >POS 80mm</button>
                  <button
                    type="button"
                    data-action="set-history-format"
                    data-value="A4"
                    class="h-8 px-3 text-[11px] font-semibold rounded-md transition-colors ${
                      this.historyViewFormat === 'A4' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
                    }"
                  >A4</button>
                </div>

                <div class="flex items-center gap-1.5">
                  ${
                    active.status !== 'cancelled'
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

              <div class="flex-1 overflow-y-auto p-4">
                ${renderDocumentHtml(active, this.historyViewFormat, this.settings.company, cachedQr)}
              </div>
            `
              : `<div class="h-full flex items-center justify-center text-xs text-slate-400">Selecione uma fatura para visualizar ou reimprimir.</div>`
          }
        </div>
      </div>
    `;
  }

  // ==================== 6. CONFIGURAÇÕES ====================

  private renderSettingsWorkspace(): string {
    const c = this.settings.company;
    return `
      <div class="h-full overflow-y-auto bg-white p-4 sm:p-6">
        <form data-form="settings-form" class="max-w-3xl space-y-6">
          <div class="flex items-center justify-between gap-3 pb-3 border-b border-slate-200">
            <div>
              <h1 class="text-sm font-bold text-slate-900">Configurações</h1>
              <p class="text-xs text-slate-500">Identidade empresarial e predefinições de emissão POS / A4.</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                data-action="reset-settings"
                class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.reset}
                <span>Repor padrão</span>
              </button>
              <button
                type="submit"
                class="h-9 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.check}
                <span>${this.settingsSavedNotice ? 'Guardado' : 'Guardar'}</span>
              </button>
            </div>
          </div>

          <section class="space-y-3">
            <h2 class="text-xs font-semibold text-slate-900">Identidade Empresarial</h2>
            <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
              <div class="sm:col-span-8">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Designação Social</label>
                <input name="legalName" type="text" required maxlength="160" value="${escapeHtml(c.legalName)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-4">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Nome Curto / Marca</label>
                <input name="shortName" type="text" required maxlength="64" value="${escapeHtml(c.shortName)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-4">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">NIF (Contribuinte)</label>
                <input name="nif" type="text" required maxlength="32" value="${escapeHtml(c.nif)}" class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-4">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Telefone</label>
                <input name="phone" type="text" maxlength="40" value="${escapeHtml(c.phone)}" class="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-4">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Email</label>
                <input name="email" type="email" maxlength="120" value="${escapeHtml(c.email)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-7">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Endereço Fiscal</label>
                <input name="address" type="text" required maxlength="160" value="${escapeHtml(c.address)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="sm:col-span-5">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Assinatura / Rodapé</label>
                <input name="tagline" type="text" maxlength="120" value="${escapeHtml(c.tagline)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
            </div>
          </section>

          <section class="space-y-3 pt-4 border-t border-slate-200">
            <h2 class="text-xs font-semibold text-slate-900">Caixa e Emissão</h2>
            <div class="grid grid-cols-2 sm:grid-cols-12 gap-3">
              <div class="col-span-1 sm:col-span-3">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Caixa Padrão</label>
                <input name="defaultCashier" type="text" required maxlength="16" value="${escapeHtml(this.settings.defaultCashier)}" class="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Operador(a) Padrão</label>
                <input name="defaultOperator" type="text" required maxlength="32" value="${escapeHtml(this.settings.defaultOperator)}" class="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Tipo de Documento</label>
                <select name="defaultDocType" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600">
                  <option value="FR" ${this.settings.defaultDocType === 'FR' ? 'selected' : ''}>Factura / Recibo</option>
                  <option value="FP" ${this.settings.defaultDocType === 'FP' ? 'selected' : ''}>Factura Proforma</option>
                </select>
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Formato Preferencial</label>
                <select name="defaultFormat" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600">
                  <option value="POS" ${this.settings.defaultFormat === 'POS' ? 'selected' : ''}>POS Térmico 80mm</option>
                  <option value="A4" ${this.settings.defaultFormat === 'A4' ? 'selected' : ''}>Fatura A4</option>
                </select>
              </div>
              <div class="col-span-2 sm:col-span-8">
                <label class="block text-[11px] font-medium text-slate-600 mb-1">Observação Padrão</label>
                <input name="defaultNotes" type="text" maxlength="300" value="${escapeHtml(this.settings.defaultNotes)}" class="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600" />
              </div>
              <div class="col-span-2 sm:col-span-4 flex items-end">
                <label class="flex items-center gap-2 h-9 text-xs text-slate-700 cursor-pointer select-none">
                  <input name="autoPrintOnEmit" type="checkbox" ${this.settings.autoPrintOnEmit ? 'checked' : ''} class="h-4 w-4 rounded border-slate-300 text-blue-600" />
                  <span>Imprimir ao clicar em Emitir</span>
                </label>
              </div>
            </div>
          </section>
        </form>
      </div>
    `;
  }

  // ==================== 7. SINCRONIZAÇÃO / ESTADO OFFLINE & BACKUP ====================

  private renderSyncWorkspace(): string {
    const pProd = this.products.filter((p) => !p.synced).length;
    const pCust = this.customers.filter((c) => !c.synced).length;
    const pInv = this.invoices.filter((i) => !i.synced).length;
    const pSet = this.settings.synced ? 0 : 1;
    const totalPending = pProd + pCust + pInv + pSet;

    const lastSync = this.lastSyncedIso ? formatDateTimePt(this.lastSyncedIso) : null;
    const bh = this.backendHealth;

    return `
      <div class="h-full overflow-y-auto bg-white p-4 sm:p-6">
        <div class="max-w-3xl space-y-6">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
            <div>
              <h1 class="text-sm font-bold text-slate-900">Sincronização, Backend e Backup</h1>
              <p class="text-xs text-slate-500">Persistência local IndexedDB, Cloud Firestore e API de auditoria.</p>
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
              <p class="text-[11px] text-slate-500 font-mono tabular-nums">${totalPending} registo(s) pendente(s)</p>
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
            <h2 class="text-xs font-semibold text-slate-900">Registos Locais vs Cloud Firestore</h2>
            <div class="border border-slate-200 rounded-lg overflow-hidden">
              <table class="w-full text-left border-collapse text-xs">
                <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                  <tr>
                    <th class="py-2.5 px-3 font-medium">Entidade</th>
                    <th class="py-2.5 px-3 font-medium text-right">Local (IndexedDB)</th>
                    <th class="py-2.5 px-3 font-medium text-right">Sincronizados</th>
                    <th class="py-2.5 px-3 font-medium text-right">Pendentes</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-100 tabular-nums">
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Faturas emitidas</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.invoices.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-emerald-700">${this.invoices.length - pInv}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-amber-700">${pInv}</td>
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Produtos e serviços</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.products.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-emerald-700">${this.products.length - pProd}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-amber-700">${pProd}</td>
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Clientes</td>
                    <td class="py-2.5 px-3 text-right font-mono">${this.customers.length}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-emerald-700">${this.customers.length - pCust}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-amber-700">${pCust}</td>
                  </tr>
                  <tr>
                    <td class="py-2.5 px-3 font-medium text-slate-900">Configurações</td>
                    <td class="py-2.5 px-3 text-right font-mono">1</td>
                    <td class="py-2.5 px-3 text-right font-mono text-emerald-700">${this.settings.synced ? 1 : 0}</td>
                    <td class="py-2.5 px-3 text-right font-mono text-amber-700">${pSet}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <!-- Exportação de Backup JSON (Local ou Endpoint Administrativo /api/backup) -->
          <section class="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 class="text-xs font-semibold text-slate-900">Exportação Segura de Dados (JSON)</h2>
              <p class="text-xs text-slate-500">Exporte cópia integral local ou a partir do endpoint administrativo <code>/api/backup</code>.</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                type="button"
                data-action="export-backup-local"
                class="h-9 px-3 rounded-lg border border-slate-200 text-xs font-semibold text-slate-800 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
              >
                ${ICONS.download}
                <span>Backup Local</span>
              </button>
              <button
                type="button"
                data-action="export-backup-cloud"
                ${!this.user || !this.isOnline ? 'disabled' : ''}
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

  private renderIOSModal(): string {
    return `
      <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
        <div class="bg-white rounded-xl p-5 max-w-xs w-full space-y-3 border border-slate-200">
          <div class="text-sm font-bold text-slate-900">Instalar no iPhone / iPad</div>
          <p class="text-xs text-slate-600 leading-relaxed">
            1. Toque em <strong>Partilhar</strong> na barra do Safari.<br />
            2. Selecione <strong>Adicionar ao Ecrã Principal</strong>.
          </p>
          <button
            type="button"
            data-action="close-ios-guide"
            class="w-full h-9 rounded-lg bg-slate-900 text-white text-xs font-semibold"
          >Fechar</button>
        </div>
      </div>
    `;
  }
}
