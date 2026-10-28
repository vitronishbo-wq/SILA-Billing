import { onAuthStateChanged, User } from 'firebase/auth';
import {
  Cloud,
  CloudOff,
  Download,
  FileSpreadsheet,
  History,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Settings,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { CustomersPanel } from './components/CustomersPanel';
import { HistoryPanel } from './components/HistoryPanel';
import { PosTerminal } from './components/PosTerminal';
import { ProductsPanel } from './components/ProductsPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { SyncPanel } from './components/SyncPanel';
import { UnifiedDocumentView } from './components/UnifiedDocumentView';
import {
  AppSettings,
  Customer,
  DEFAULT_SETTINGS,
  DocumentFormat,
  InvoiceRecord,
  Product,
} from './core/types';
import { useOnlineStatus, usePWAInstall } from './hooks/usePWA';
import {
  cancelInvoiceCloud,
  createInvoiceCloud,
  pullAllFromCloud,
  removeCustomerCloud,
  removeProductCloud,
  upsertCustomerCloud,
  upsertProductCloud,
  upsertSettingsCloud,
} from './services/cloudSync';
import {
  auth,
  signInWithGoogle,
  signOutFirebase,
  validateFirestoreConnection,
} from './services/firebaseClient';
import { bootstrapLocalStore, localDb } from './services/localStore';

type ActiveModule =
  | 'NEW_POS'
  | 'NEW_A4'
  | 'CUSTOMERS'
  | 'PRODUCTS'
  | 'HISTORY'
  | 'SETTINGS'
  | 'SYNC';

export default function App() {
  const [activeModule, setActiveModule] = useState<ActiveModule>('NEW_POS');
  const [sidebarState, setSidebarState] = useState<'EXPANDED' | 'ICONS' | 'HIDDEN'>(() =>
    typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'EXPANDED' : 'ICONS'
  );

  const [products, setProducts] = useState<Product[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isBooting, setIsBooting] = useState<boolean>(true);

  const [user, setUser] = useState<User | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncedIso, setLastSyncedIso] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showIOSPrompt, setShowIOSPrompt] = useState<boolean>(false);

  const [printJob, setPrintJob] = useState<{
    invoice: InvoiceRecord;
    format: DocumentFormat;
  } | null>(null);

  const isOnline = useOnlineStatus();
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();

  useEffect(() => {
    validateFirestoreConnection();
    bootstrapLocalStore()
      .then((data) => {
        setProducts(data.products);
        setCustomers(data.customers);
        setInvoices(data.invoices);
        setSettings(data.settings);
      })
      .finally(() => setIsBooting(false));

    const unsub = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
    });
    return () => unsub();
  }, []);

  const syncWithFirestore = useCallback(async () => {
    if (!user || !isOnline || isSyncing) return;
    setIsSyncing(true);
    setSyncError(null);
    try {
      const unsyncedProducts: Product[] = products.filter((item) => !item.synced);
      for (const prod of unsyncedProducts) {
        await upsertProductCloud(prod, true);
        await localDb.saveProduct({ ...prod, synced: true });
      }
      const unsyncedCustomers: Customer[] = customers.filter((item) => !item.synced);
      for (const cust of unsyncedCustomers) {
        await upsertCustomerCloud(cust);
        await localDb.saveCustomer({ ...cust, synced: true });
      }
      const unsyncedInvoices: InvoiceRecord[] = invoices.filter((item) => !item.synced);
      for (const inv of unsyncedInvoices) {
        await createInvoiceCloud(inv);
        await localDb.saveInvoice({ ...inv, synced: true });
      }
      if (!settings.synced) {
        await upsertSettingsCloud(settings);
        const syncedSettings = { ...settings, synced: true };
        await localDb.saveSettings(syncedSettings);
        setSettings(syncedSettings);
      }

      const cloudData = await pullAllFromCloud();
      if (cloudData) {
        for (const cp of cloudData.products) await localDb.saveProduct(cp);
        for (const cc of cloudData.customers) await localDb.saveCustomer(cc);
        for (const ci of cloudData.invoices) await localDb.saveInvoice(ci);
        if (cloudData.settings) {
          await localDb.saveSettings(cloudData.settings);
        }

        const refreshed = await bootstrapLocalStore();
        setProducts(refreshed.products);
        setCustomers(refreshed.customers);
        setInvoices(refreshed.invoices);
        setSettings(refreshed.settings);
      }
      setLastSyncedIso(new Date().toISOString());
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : 'Não foi possível concluir a sincronização.');
    } finally {
      setIsSyncing(false);
    }
  }, [user, isOnline, isSyncing, products, customers, invoices, settings]);

  const handleSaveProduct = async (product: Product, isNew: boolean) => {
    const saved: Product = { ...product, synced: false };
    await localDb.saveProduct(saved);
    setProducts((prev) => {
      const others = prev.filter((p) => p.id !== saved.id);
      return [...others, saved].sort((a, b) => a.code.localeCompare(b.code));
    });

    if (user && isOnline) {
      try {
        await upsertProductCloud(saved, isNew);
        const syncedProd = { ...saved, synced: true };
        await localDb.saveProduct(syncedProd);
        setProducts((prev) => prev.map((p) => (p.id === syncedProd.id ? syncedProd : p)));
      } catch {
        // Mantém pendente localmente
      }
    }
  };

  const handleDeleteProduct = async (id: string) => {
    await localDb.deleteProduct(id);
    setProducts((prev) => prev.filter((p) => p.id !== id));
    if (user && isOnline) {
      try {
        await removeProductCloud(id);
      } catch {
        // Removido localmente
      }
    }
  };

  const handleSaveCustomer = async (customer: Customer) => {
    const saved: Customer = { ...customer, synced: false };
    await localDb.saveCustomer(saved);
    setCustomers((prev) => {
      const others = prev.filter((c) => c.id !== saved.id);
      return [...others, saved].sort((a, b) =>
        a.id === 'cust_direct' ? -1 : b.id === 'cust_direct' ? 1 : a.name.localeCompare(b.name)
      );
    });

    if (user && isOnline) {
      try {
        await upsertCustomerCloud(saved);
        const syncedCust = { ...saved, synced: true };
        await localDb.saveCustomer(syncedCust);
        setCustomers((prev) => prev.map((c) => (c.id === syncedCust.id ? syncedCust : c)));
      } catch {
        // Mantém pendente localmente
      }
    }
  };

  const handleDeleteCustomer = async (id: string) => {
    if (id === 'cust_direct') return;
    await localDb.deleteCustomer(id);
    setCustomers((prev) => prev.filter((c) => c.id !== id));
    if (user && isOnline) {
      try {
        await removeCustomerCloud(id);
      } catch {
        // Removido localmente
      }
    }
  };

  const handleEmitInvoice = async (invoice: InvoiceRecord) => {
    await localDb.saveInvoice(invoice);
    setInvoices((prev) => [invoice, ...prev]);

    if (user && isOnline) {
      try {
        await createInvoiceCloud(invoice);
        const syncedInv = { ...invoice, synced: true };
        await localDb.saveInvoice(syncedInv);
        setInvoices((prev) => prev.map((inv) => (inv.id === syncedInv.id ? syncedInv : inv)));
      } catch {
        // Guardado offline para sincronização posterior
      }
    }
  };

  const handleCancelInvoice = async (invoiceId: string) => {
    const target = invoices.find((i) => i.id === invoiceId);
    if (!target || target.status === 'cancelled') return;

    const cancelled: InvoiceRecord = {
      ...target,
      status: 'cancelled',
      synced: false,
      updatedAtIso: new Date().toISOString(),
    };

    await localDb.saveInvoice(cancelled);
    setInvoices((prev) => prev.map((i) => (i.id === invoiceId ? cancelled : i)));

    if (user && isOnline) {
      try {
        await cancelInvoiceCloud(invoiceId);
        const syncedCancelled = { ...cancelled, synced: true };
        await localDb.saveInvoice(syncedCancelled);
        setInvoices((prev) =>
          prev.map((i) => (i.id === invoiceId ? syncedCancelled : i))
        );
      } catch {
        // Sincronizará quando online
      }
    }
  };

  const handleSaveSettings = async (next: AppSettings) => {
    const saved: AppSettings = { ...next, synced: false };
    await localDb.saveSettings(saved);
    setSettings(saved);

    if (user && isOnline) {
      try {
        await upsertSettingsCloud(saved);
        const syncedSettings = { ...saved, synced: true };
        await localDb.saveSettings(syncedSettings);
        setSettings(syncedSettings);
      } catch {
        // Mantém pendente localmente
      }
    }
  };

  const handlePrintInvoice = (invoice: InvoiceRecord, format: DocumentFormat) => {
    document.body.setAttribute('data-print-mode', format);
    setPrintJob({ invoice, format });
    setTimeout(() => {
      window.print();
    }, 120);
  };

  const toggleSidebar = () => {
    setSidebarState((prev) => {
      if (prev === 'EXPANDED') return 'ICONS';
      if (prev === 'ICONS') return 'HIDDEN';
      return 'EXPANDED';
    });
  };

  const primaryNavItems: { id: ActiveModule; label: string; icon: typeof Receipt }[] = [
    { id: 'NEW_POS', label: 'Nova fatura POS', icon: Receipt },
    { id: 'NEW_A4', label: 'Nova fatura A4', icon: FileSpreadsheet },
    { id: 'CUSTOMERS', label: 'Clientes', icon: Users },
    { id: 'PRODUCTS', label: 'Produtos e serviços', icon: Package },
    { id: 'HISTORY', label: 'Histórico de faturas', icon: History },
  ];

  const utilityNavItems: { id: ActiveModule; label: string; icon: typeof Settings }[] = [
    { id: 'SETTINGS', label: 'Configurações', icon: Settings },
    {
      id: 'SYNC',
      label: isOnline ? 'Sincronização / estado offline' : 'Modo offline ativo',
      icon: isOnline ? Cloud : CloudOff,
    },
  ];

  const pendingCount =
    products.filter((p) => !p.synced).length +
    customers.filter((c) => !c.synced).length +
    invoices.filter((i) => !i.synced).length +
    (settings.synced ? 0 : 1);

  return (
    <>
      <div className="no-print h-dvh w-screen flex flex-col overflow-hidden bg-slate-50 text-slate-900">
        {/* Top Bar Compacta — 3 Zonas Limpas */}
        <header className="h-12 px-3 bg-slate-900 text-white border-b border-slate-800 flex items-center justify-between gap-4 shrink-0">
          {/* Zona 1: Botão Recolher/Mostrar Aba Esquerda + Marca */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={toggleSidebar}
              title={
                sidebarState === 'HIDDEN'
                  ? 'Mostrar aba esquerda'
                  : sidebarState === 'EXPANDED'
                    ? 'Compactar para ícones'
                    : 'Recolher 100% aba esquerda'
              }
              className="h-9 w-9 flex items-center justify-center rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
            >
              {sidebarState === 'HIDDEN' ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
            <span className="text-sm font-bold tracking-tight whitespace-nowrap">
              SILA-Billing
            </span>
          </div>

          {/* Zona 2: Identidade da Empresa */}
          <div className="hidden md:flex items-center gap-2 text-xs text-slate-400 truncate">
            <span className="truncate">{settings.company.shortName}</span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">NIF {settings.company.nif}</span>
          </div>

          {/* Zona 3: Ação Rápida contextual (Instalar PWA ou Atalho Estado Offline/Sync) */}
          <div className="flex items-center gap-2 shrink-0">
            {!isInstalled && (isInstallable || isIOS) ? (
              <button
                type="button"
                onClick={() => (isInstallable ? install() : setShowIOSPrompt(true))}
                className="h-8 px-2.5 rounded-md bg-blue-600 hover:bg-blue-700 text-xs font-medium text-white flex items-center gap-1.5 whitespace-nowrap"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Instalar</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setActiveModule('SYNC')}
                className="h-8 px-2.5 rounded-md bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap tabular-nums"
              >
                {isOnline ? (
                  <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <CloudOff className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>{isOnline ? (user ? 'Cloud' : 'Local') : 'Offline'}</span>
              </button>
            )}
          </div>
        </header>

        {/* Corpo com Aba Esquerda 100% Recolhível (Estilo VS Code) */}
        <div className="flex-1 flex overflow-hidden">
          {sidebarState !== 'HIDDEN' && (
            <aside
              aria-label="Navegação principal"
              className={`bg-slate-900 text-slate-300 border-r border-slate-800 flex flex-col justify-between shrink-0 select-none ${
                sidebarState === 'EXPANDED' ? 'w-56' : 'w-14'
              }`}
            >
              {/* Topo: Operações Principais (1 a 5) */}
              <nav className="p-1.5 space-y-1 overflow-y-auto">
                {primaryNavItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeModule === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      title={item.label}
                      onClick={() => setActiveModule(item.id)}
                      className={`w-full min-h-[42px] px-2.5 rounded-md flex items-center gap-3 text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      } ${sidebarState === 'EXPANDED' ? 'justify-start' : 'justify-center'}`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      {sidebarState === 'EXPANDED' && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </nav>

              {/* Base da Aba Esquerda: Configurações + Sincronização / Estado Offline + Controlo Recolher */}
              <div className="p-1.5 border-t border-slate-800 space-y-1">
                {utilityNavItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeModule === item.id;
                  const isSyncItem = item.id === 'SYNC';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      title={item.label}
                      onClick={() => setActiveModule(item.id)}
                      className={`w-full min-h-[42px] px-2.5 rounded-md flex items-center justify-between gap-2 text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-blue-600 text-white'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800'
                      } ${sidebarState === 'EXPANDED' ? '' : 'justify-center'}`}
                    >
                      <span className="flex items-center gap-3 min-w-0">
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            isSyncItem && !active
                              ? isOnline
                                ? 'text-slate-400'
                                : 'text-amber-400'
                              : ''
                          }`}
                        />
                        {sidebarState === 'EXPANDED' && (
                          <span className="truncate">{item.label}</span>
                        )}
                      </span>
                      {sidebarState === 'EXPANDED' && isSyncItem && pendingCount > 0 && (
                        <span className="text-[10px] font-mono tabular-nums text-slate-400 shrink-0">
                          {pendingCount}
                        </span>
                      )}
                    </button>
                  );
                })}

                <div className="pt-1 border-t border-slate-800/80 flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setSidebarState((prev) => (prev === 'EXPANDED' ? 'ICONS' : 'EXPANDED'))
                    }
                    title={sidebarState === 'EXPANDED' ? 'Apenas ícones' : 'Expandir aba'}
                    className="flex-1 h-8 rounded-md text-[11px] text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center whitespace-nowrap"
                  >
                    {sidebarState === 'EXPANDED' ? '« Compactar' : '»'}
                  </button>
                  {sidebarState === 'EXPANDED' && (
                    <button
                      type="button"
                      onClick={() => setSidebarState('HIDDEN')}
                      title="Ocultar 100% a aba esquerda"
                      className="h-8 w-8 rounded-md text-slate-400 hover:text-white hover:bg-slate-800 flex items-center justify-center shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </aside>
          )}

          {/* Área de Trabalho Unificada */}
          <main className="flex-1 overflow-hidden">
            {isBooting ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-500">
                A carregar base local...
              </div>
            ) : (
              <>
                {(activeModule === 'NEW_POS' || activeModule === 'NEW_A4') && (
                  <PosTerminal
                    initialFormat={activeModule === 'NEW_A4' ? 'A4' : 'POS'}
                    settings={settings}
                    products={products}
                    customers={customers}
                    invoices={invoices}
                    onEmitInvoice={handleEmitInvoice}
                    onPrintInvoice={handlePrintInvoice}
                  />
                )}
                {activeModule === 'CUSTOMERS' && (
                  <CustomersPanel
                    customers={customers}
                    onSaveCustomer={handleSaveCustomer}
                    onDeleteCustomer={handleDeleteCustomer}
                  />
                )}
                {activeModule === 'PRODUCTS' && (
                  <ProductsPanel
                    products={products}
                    onSaveProduct={handleSaveProduct}
                    onDeleteProduct={handleDeleteProduct}
                  />
                )}
                {activeModule === 'HISTORY' && (
                  <HistoryPanel
                    invoices={invoices}
                    company={settings.company}
                    onPrintInvoice={handlePrintInvoice}
                    onCancelInvoice={handleCancelInvoice}
                  />
                )}
                {activeModule === 'SETTINGS' && (
                  <SettingsPanel
                    settings={settings}
                    onSaveSettings={handleSaveSettings}
                  />
                )}
                {activeModule === 'SYNC' && (
                  <SyncPanel
                    isOnline={isOnline}
                    user={user}
                    isSyncing={isSyncing}
                    lastSyncedIso={lastSyncedIso}
                    syncError={syncError}
                    products={products}
                    customers={customers}
                    invoices={invoices}
                    settings={settings}
                    isInstallable={isInstallable}
                    isInstalled={isInstalled}
                    isIOS={isIOS}
                    onSignIn={signInWithGoogle}
                    onSignOut={signOutFirebase}
                    onSyncNow={syncWithFirestore}
                    onInstallPWA={() => (isInstallable ? install() : setShowIOSPrompt(true))}
                  />
                )}
              </>
            )}
          </main>
        </div>

        {/* Guia de Instalação iOS Safari */}
        {showIOSPrompt && (
          <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
            <div className="bg-white rounded-xl p-5 max-w-xs w-full space-y-3 border border-slate-200">
              <div className="text-sm font-bold text-slate-900">Instalar no iPhone / iPad</div>
              <p className="text-xs text-slate-600 leading-relaxed">
                1. Toque em <strong>Partilhar</strong> na barra do Safari.
                <br />
                2. Selecione <strong>Adicionar ao Ecrã Principal</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSPrompt(false)}
                className="w-full h-9 rounded-lg bg-slate-900 text-white text-xs font-semibold"
              >
                Fechar
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Contentor Exclusivo de Impressão Limpa (80mm POS ou A4) */}
      {printJob && (
        <div className="hidden print-only-container">
          <UnifiedDocumentView
            invoice={printJob.invoice}
            format={printJob.format}
            company={settings.company}
          />
        </div>
      )}
    </>
  );
}
