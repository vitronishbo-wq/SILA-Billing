import { Ban, Printer, Search } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { formatDateTimePt, formatKzNumber } from '../core/billingEngine';
import { CompanyProfile, DocumentFormat, InvoiceRecord } from '../core/types';
import { UnifiedDocumentView } from './UnifiedDocumentView';

interface HistoryPanelProps {
  invoices: InvoiceRecord[];
  company: CompanyProfile;
  onPrintInvoice: (invoice: InvoiceRecord, format: DocumentFormat) => void;
  onCancelInvoice: (invoiceId: string) => Promise<void>;
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  invoices,
  company,
  onPrintInvoice,
  onCancelInvoice,
}) => {
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string>(invoices[0]?.id || '');
  const [viewFormat, setViewFormat] = useState<DocumentFormat>('POS');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return invoices;
    return invoices.filter(
      (inv) =>
        inv.number.toLowerCase().includes(q) || inv.customerName.toLowerCase().includes(q)
    );
  }, [invoices, query]);

  const activeInvoice = useMemo(() => {
    return filtered.find((i) => i.id === selectedId) || filtered[0] || null;
  }, [filtered, selectedId]);

  return (
    <div className="h-full grid grid-cols-1 lg:grid-cols-12 overflow-hidden bg-white">
      {/* Lista de Documentos Emitidos */}
      <div className="lg:col-span-6 flex flex-col border-r border-slate-200 overflow-hidden">
        <div className="p-3 border-b border-slate-200 shrink-0">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Pesquisar n.º de fatura ou cliente..."
              className="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-xs text-slate-500">
              Nenhuma fatura encontrada.
            </div>
          ) : (
            filtered.map((inv) => {
              const dt = formatDateTimePt(inv.issuedAtIso);
              const isSelected = activeInvoice?.id === inv.id;
              return (
                <button
                  key={inv.id}
                  type="button"
                  onClick={() => setSelectedId(inv.id)}
                  className={`w-full text-left p-3.5 transition-colors flex items-center justify-between gap-3 ${
                    isSelected ? 'bg-blue-50/60' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-bold font-mono text-slate-900 tabular-nums">
                        {inv.number}
                      </span>
                      <span className="text-slate-400">·</span>
                      <span className="text-slate-500 tabular-nums">
                        {dt.slashDate} {dt.time}
                      </span>
                      {inv.status === 'cancelled' && (
                        <>
                          <span className="text-slate-400">·</span>
                          <span className="text-red-600 font-semibold">Anulada</span>
                        </>
                      )}
                    </div>
                    <div className="text-xs text-slate-600 truncate mt-0.5">
                      {inv.customerName} · {inv.paymentMethod}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-xs font-bold font-mono text-slate-900 tabular-nums">
                      {formatKzNumber(inv.grandTotal)} Kz
                    </div>
                    <div className="text-[10.5px] text-slate-400 tabular-nums">
                      {inv.lines.length} art.
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Vista e Reimpressão Unificada (POS 80mm / A4) */}
      <div className="lg:col-span-6 flex flex-col bg-slate-100 overflow-hidden">
        {activeInvoice ? (
          <>
            <div className="p-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0">
              <div className="flex items-center bg-slate-100 p-0.5 rounded-lg">
                <button
                  type="button"
                  onClick={() => setViewFormat('POS')}
                  className={`h-8 px-3 text-[11px] font-semibold rounded-md transition-colors ${
                    viewFormat === 'POS'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  POS 80mm
                </button>
                <button
                  type="button"
                  onClick={() => setViewFormat('A4')}
                  className={`h-8 px-3 text-[11px] font-semibold rounded-md transition-colors ${
                    viewFormat === 'A4'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  A4
                </button>
              </div>

              <div className="flex items-center gap-1.5">
                {activeInvoice.status !== 'cancelled' && (
                  <button
                    type="button"
                    title="Anular documento"
                    onClick={() => onCancelInvoice(activeInvoice.id)}
                    className="h-8 px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-red-600 hover:bg-red-50 flex items-center gap-1 whitespace-nowrap"
                  >
                    <Ban className="w-3.5 h-3.5" />
                    Anular
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onPrintInvoice(activeInvoice, viewFormat)}
                  className="h-8 px-3 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Imprimir
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <UnifiedDocumentView
                invoice={activeInvoice}
                format={viewFormat}
                company={company}
              />
            </div>
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-slate-400">
            Selecione uma fatura para visualizar ou reimprimir.
          </div>
        )}
      </div>
    </div>
  );
};
