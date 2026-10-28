import { User } from 'firebase/auth';
import { Cloud, CloudOff, Download, LogIn, LogOut, RefreshCw } from 'lucide-react';
import React from 'react';
import { formatDateTimePt } from '../core/billingEngine';
import { AppSettings, Customer, InvoiceRecord, Product } from '../core/types';

interface SyncPanelProps {
  isOnline: boolean;
  user: User | null;
  isSyncing: boolean;
  lastSyncedIso: string | null;
  syncError: string | null;
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  settings: AppSettings;
  isInstallable: boolean;
  isInstalled: boolean;
  isIOS: boolean;
  onSignIn: () => Promise<unknown>;
  onSignOut: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onInstallPWA: () => void;
}

export const SyncPanel: React.FC<SyncPanelProps> = ({
  isOnline,
  user,
  isSyncing,
  lastSyncedIso,
  syncError,
  products,
  customers,
  invoices,
  settings,
  isInstallable,
  isInstalled,
  isIOS,
  onSignIn,
  onSignOut,
  onSyncNow,
  onInstallPWA,
}) => {
  const pendingProducts = products.filter((p) => !p.synced).length;
  const pendingCustomers = customers.filter((c) => !c.synced).length;
  const pendingInvoices = invoices.filter((i) => !i.synced).length;
  const pendingSettings = settings.synced ? 0 : 1;
  const totalPending = pendingProducts + pendingCustomers + pendingInvoices + pendingSettings;

  const lastSyncFormatted = lastSyncedIso ? formatDateTimePt(lastSyncedIso) : null;

  return (
    <div className="h-full overflow-y-auto bg-white p-4 sm:p-6">
      <div className="max-w-3xl space-y-6">
        {/* Cabeçalho */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <h1 className="text-sm font-bold text-slate-900">Sincronização e Estado Offline</h1>
            <p className="text-xs text-slate-500">
              Armazenamento local persistente (IndexedDB) e sincronização real com Firebase Firestore.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {user ? (
              <>
                <button
                  type="button"
                  disabled={!isOnline || isSyncing}
                  onClick={onSyncNow}
                  className="h-9 px-3.5 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin' : ''}`} />
                  {isSyncing ? 'A sincronizar...' : 'Sincronizar agora'}
                </button>
                <button
                  type="button"
                  onClick={onSignOut}
                  className="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Sair
                </button>
              </>
            ) : (
              <button
                type="button"
                disabled={!isOnline}
                onClick={onSignIn}
                className="h-9 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
              >
                <LogIn className="w-3.5 h-3.5" />
                Autenticar com Google
              </button>
            )}
          </div>
        </div>

        {/* Estado de Rede e Conta Cloud */}
        <section className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1">
            <div className="text-[11px] text-slate-500">Ligação de Rede</div>
            <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
              {isOnline ? (
                <>
                  <Cloud className="w-4 h-4 text-emerald-600 shrink-0" />
                  <span>Online</span>
                </>
              ) : (
                <>
                  <CloudOff className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>Offline — Operação Local Ativa</span>
                </>
              )}
            </div>
            <p className="text-xs text-slate-500 pt-1">
              {isOnline
                ? 'Pronto para sincronizar registos locais com o Firestore.'
                : 'Todas as emissões são gravadas em IndexedDB sem interrupção.'}
            </p>
          </div>

          <div className="p-4 rounded-lg border border-slate-200 bg-slate-50/70 space-y-1">
            <div className="text-[11px] text-slate-500">Conta Cloud (Firebase Auth)</div>
            <div className="text-sm font-bold text-slate-900 truncate">
              {user ? user.email || 'Utilizador autenticado' : 'Não autenticado (Apenas Local)'}
            </div>
            <p className="text-xs text-slate-500 pt-1 tabular-nums">
              {lastSyncFormatted
                ? `Última sincronização real: ${lastSyncFormatted.slashDate} às ${lastSyncFormatted.time}`
                : 'Nenhuma sincronização efetuada nesta sessão.'}
            </p>
          </div>
        </section>

        {syncError && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50 text-xs text-red-700">
            Falha na sincronização: {syncError}
          </div>
        )}

        {/* Tabela Real de Registos Locais vs Pendentes */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between text-xs">
            <h2 className="font-semibold text-slate-900">Estado da Base de Dados Local</h2>
            <span className="text-slate-500 font-mono tabular-nums">
              {totalPending} pendente(s) de envio
            </span>
          </div>

          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <table className="w-full text-left border-collapse text-xs">
              <thead className="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
                <tr>
                  <th className="py-2.5 px-3 font-medium">Entidade</th>
                  <th className="py-2.5 px-3 font-medium text-right">Guardados Localmente</th>
                  <th className="py-2.5 px-3 font-medium text-right">Sincronizados Cloud</th>
                  <th className="py-2.5 px-3 font-medium text-right">Pendentes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 tabular-nums">
                <tr>
                  <td className="py-2.5 px-3 font-medium text-slate-900">Faturas emitidas</td>
                  <td className="py-2.5 px-3 text-right font-mono">{invoices.length}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-700">
                    {invoices.length - pendingInvoices}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-amber-700">
                    {pendingInvoices}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-medium text-slate-900">Produtos e serviços</td>
                  <td className="py-2.5 px-3 text-right font-mono">{products.length}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-700">
                    {products.length - pendingProducts}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-amber-700">
                    {pendingProducts}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-medium text-slate-900">Clientes</td>
                  <td className="py-2.5 px-3 text-right font-mono">{customers.length}</td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-700">
                    {customers.length - pendingCustomers}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-amber-700">
                    {pendingCustomers}
                  </td>
                </tr>
                <tr>
                  <td className="py-2.5 px-3 font-medium text-slate-900">Configurações</td>
                  <td className="py-2.5 px-3 text-right font-mono">1</td>
                  <td className="py-2.5 px-3 text-right font-mono text-emerald-700">
                    {settings.synced ? 1 : 0}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono text-amber-700">
                    {pendingSettings}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        {/* Instalação PWA Offline-First */}
        <section className="pt-4 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xs font-semibold text-slate-900">Aplicação Instalável (PWA)</h2>
            <p className="text-xs text-slate-500">
              {isInstalled
                ? 'O SILA-Billing já está instalado neste dispositivo para acesso direto offline.'
                : 'Instale o SILA-Billing no telemóvel ou computador para abrir sem navegador.'}
            </p>
          </div>
          {!isInstalled && (isInstallable || isIOS) && (
            <button
              type="button"
              onClick={onInstallPWA}
              className="h-9 px-3.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-900 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5" />
              Instalar Aplicação
            </button>
          )}
        </section>
      </div>
    </div>
  );
};
