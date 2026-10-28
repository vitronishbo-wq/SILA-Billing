import {
  Check,
  ChevronDown,
  ChevronUp,
  Minus,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
  calculateInvoiceTotals,
  formatKzNumber,
  generateNextInvoiceNumber,
  roundKz,
} from '../core/billingEngine';
import {
  AppSettings,
  CartDraftItem,
  Customer,
  DocumentFormat,
  DocumentType,
  InvoiceRecord,
  PaymentMethod,
  Product,
} from '../core/types';
import { UnifiedDocumentView } from './UnifiedDocumentView';

interface PosTerminalProps {
  initialFormat: DocumentFormat;
  settings: AppSettings;
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  onEmitInvoice: (invoice: InvoiceRecord) => Promise<void>;
  onPrintInvoice: (invoice: InvoiceRecord, format: DocumentFormat) => void;
}

export const PosTerminal: React.FC<PosTerminalProps> = ({
  initialFormat,
  settings,
  products,
  customers,
  invoices,
  onEmitInvoice,
  onPrintInvoice,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [taxFilter, setTaxFilter] = useState<'ALL' | 14 | 0>('ALL');
  const [cart, setCart] = useState<CartDraftItem[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>('cust_direct');
  const [docType, setDocType] = useState<DocumentType>(settings.defaultDocType || 'FR');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Dinheiro');
  const [amountReceivedInput, setAmountReceivedInput] = useState<string>('');
  const [notes, setNotes] = useState<string>(settings.defaultNotes || 'Venda directa a retalho.');
  const [cashier, setCashier] = useState<string>(settings.defaultCashier || '01');
  const [operator, setOperator] = useState<string>(settings.defaultOperator || '001');
  const [showOptionsDrawer, setShowOptionsDrawer] = useState<boolean>(false);
  const [mobilePane, setMobilePane] = useState<'CATALOG' | 'CART' | 'PREVIEW'>('CATALOG');
  const [previewFormat, setPreviewFormat] = useState<DocumentFormat>(initialFormat);
  const [lastEmitted, setLastEmitted] = useState<InvoiceRecord | null>(null);
  const [isEmitting, setIsEmitting] = useState(false);

  React.useEffect(() => {
    setPreviewFormat(initialFormat);
  }, [initialFormat]);

  const activeProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (!p.active) return false;
      if (taxFilter !== 'ALL' && p.ivaRate !== taxFilter) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q);
    });
  }, [products, searchQuery, taxFilter]);

  const selectedCustomer = useMemo(() => {
    return (
      customers.find((c) => c.id === selectedCustomerId) ||
      customers[0] || {
        id: 'cust_direct',
        name: 'Cliente de Venda Directa',
        nif: 'Consumidor Final',
        locality: 'Saurimo - Angola',
        phone: '',
        address: '',
        createdAtIso: '',
        updatedAtIso: '',
      }
    );
  }, [customers, selectedCustomerId]);

  const totals = useMemo(() => calculateInvoiceTotals(cart), [cart]);

  const numericReceived = useMemo(() => {
    if (paymentMethod !== 'Dinheiro') return totals.grandTotal;
    const parsed = parseFloat(amountReceivedInput.replace(',', '.'));
    if (Number.isNaN(parsed) || parsed <= 0) return totals.grandTotal;
    return roundKz(parsed);
  }, [amountReceivedInput, paymentMethod, totals.grandTotal]);

  const changeAmount = useMemo(() => {
    return Math.max(0, roundKz(numericReceived - totals.grandTotal));
  }, [numericReceived, totals.grandTotal]);

  const nextNumber = useMemo(
    () => generateNextInvoiceNumber(invoices.map((i) => i.number), docType),
    [invoices, docType]
  );

  // Documento vivo para pré-visualização instantânea (POS ou A4)
  const livePreviewInvoice: InvoiceRecord = useMemo(() => {
    if (lastEmitted && cart.length === 0) {
      return lastEmitted;
    }
    const now = new Date().toISOString();
    return {
      id: 'preview_draft',
      number: nextNumber,
      docType,
      issuedAtIso: now,
      cashier,
      operator,
      paymentMethod,
      customerId: selectedCustomer.id,
      customerName: selectedCustomer.name,
      customerNif: selectedCustomer.nif,
      customerLocality: selectedCustomer.locality,
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
      notes,
      status: 'issued',
      lines: totals.lines,
      createdAtIso: now,
      updatedAtIso: now,
    };
  }, [
    lastEmitted,
    cart.length,
    nextNumber,
    docType,
    cashier,
    operator,
    paymentMethod,
    selectedCustomer,
    totals,
    numericReceived,
    changeAmount,
    notes,
  ]);

  const addProductToCart = (product: Product) => {
    setLastEmitted(null);
    setCart((prev) => {
      const idx = prev.findIndex((item) => item.productId === product.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], qty: roundKz(updated[idx].qty + 1) };
        return updated;
      }
      return [
        ...prev,
        {
          productId: product.id,
          code: product.code,
          description: product.name,
          unit: product.unit,
          qty: 1,
          unitPrice: product.price,
          discountPct: 0,
          ivaRate: product.ivaRate,
        },
      ];
    });
  };

  const updateItemQty = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) => {
          if (item.productId !== productId) return item;
          const nextQty = roundKz(item.qty + delta);
          return nextQty <= 0 ? null : { ...item, qty: nextQty };
        })
        .filter((x): x is CartDraftItem => x !== null)
    );
  };

  const setExactQty = (productId: string, rawVal: string) => {
    const val = parseFloat(rawVal.replace(',', '.'));
    if (Number.isNaN(val) || val <= 0) return;
    setCart((prev) =>
      prev.map((item) => (item.productId === productId ? { ...item, qty: roundKz(val) } : item))
    );
  };

  const setItemDiscount = (productId: string, rawVal: string) => {
    const val = Math.min(100, Math.max(0, parseFloat(rawVal) || 0));
    setCart((prev) =>
      prev.map((item) =>
        item.productId === productId ? { ...item, discountPct: roundKz(val) } : item
      )
    );
  };

  const removeCartItem = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId));
  };

  const clearSale = () => {
    setCart([]);
    setAmountReceivedInput('');
    setLastEmitted(null);
  };

  const applyQuickCash = (val: number) => {
    setPaymentMethod('Dinheiro');
    setAmountReceivedInput(String(val));
  };

  const handleEmit = async (autoPrint: boolean) => {
    if (cart.length === 0 || isEmitting) return;
    setIsEmitting(true);
    try {
      const now = new Date().toISOString();
      const cleanId = `inv_${Date.now()}`;
      const newInvoice: InvoiceRecord = {
        id: cleanId,
        number: nextNumber,
        docType,
        issuedAtIso: now,
        cashier: cashier.trim() || '01',
        operator: operator.trim() || '001',
        paymentMethod,
        customerId: selectedCustomer.id,
        customerName: selectedCustomer.name,
        customerNif: selectedCustomer.nif,
        customerLocality: selectedCustomer.locality,
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
        notes: notes.trim(),
        status: 'issued',
        lines: totals.lines,
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };

      await onEmitInvoice(newInvoice);
      setLastEmitted(newInvoice);
      setCart([]);
      setAmountReceivedInput('');
      setMobilePane('PREVIEW');

      if (autoPrint) {
        onPrintInvoice(newInvoice, previewFormat);
      }
    } finally {
      setIsEmitting(false);
    }
  };

  const cartItemsCount = cart.reduce((acc, i) => acc + i.qty, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Seletor Compacto Mobile (Catálogo / Talão / Fatura) */}
      <div className="flex lg:hidden items-center gap-1 border-b border-slate-200 bg-white px-3 py-1.5 shrink-0">
        <button
          type="button"
          onClick={() => setMobilePane('CATALOG')}
          className={`flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
            mobilePane === 'CATALOG'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Artigos
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('CART')}
          className={`flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap tabular-nums ${
            mobilePane === 'CART'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          Caixa ({cartItemsCount})
        </button>
        <button
          type="button"
          onClick={() => setMobilePane('PREVIEW')}
          className={`flex-1 min-h-[40px] rounded-md text-xs font-semibold transition-colors whitespace-nowrap ${
            mobilePane === 'PREVIEW'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {previewFormat === 'A4' ? 'Fatura A4' : 'Talão POS'}
        </button>
      </div>

      {/* Grelha Principal Desktop (3 Colunas Adaptativas POS / A4) / Mobile (Painel Ativo) */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
        {/* COLUNA 1: Catálogo Rápido de Artigos */}
        <section
          className={`${
            previewFormat === 'A4' ? 'lg:col-span-4' : 'lg:col-span-5'
          } flex flex-col border-r border-slate-200 bg-slate-50/60 overflow-hidden ${
            mobilePane === 'CATALOG' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Barra Pesquisa + Filtro IVA */}
          <div className="p-3 border-b border-slate-200 bg-white flex items-center gap-2 shrink-0">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Pesquisar código ou artigo..."
                className="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
              />
            </div>
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg shrink-0">
              {(['ALL', 14, 0] as const).map((val) => (
                <button
                  key={String(val)}
                  type="button"
                  onClick={() => setTaxFilter(val)}
                  className={`h-9 px-2.5 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    taxFilter === val
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {val === 'ALL' ? 'Todos' : val === 14 ? 'IVA 14%' : 'Isento'}
                </button>
              ))}
            </div>
          </div>

          {/* Lista / Grelha Compacta de Toque Rápido */}
          <div className="flex-1 overflow-y-auto p-3">
            {activeProducts.length === 0 ? (
              <div className="h-40 flex items-center justify-center text-xs text-slate-500">
                Nenhum artigo encontrado.
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-2">
                {activeProducts.map((product) => {
                  const inCart = cart.find((c) => c.productId === product.id);
                  return (
                    <button
                      key={product.id}
                      type="button"
                      onClick={() => addProductToCart(product)}
                      className={`group text-left p-3 rounded-lg border transition-colors min-h-[84px] flex flex-col justify-between bg-white hover:border-blue-600 active:bg-slate-50 ${
                        inCart ? 'border-blue-600 ring-1 ring-blue-600/20' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-1.5 w-full">
                        <span className="text-[10px] font-mono text-slate-400 truncate">
                          {product.code}
                        </span>
                        <span className="text-[10px] text-slate-500 tabular-nums shrink-0">
                          {product.ivaRate === 14 ? '14%' : '0%'}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug my-1">
                        {product.name}
                      </div>
                      <div className="flex items-center justify-between gap-1 w-full pt-1 border-t border-slate-100">
                        <span className="text-xs font-bold text-slate-900 font-mono tabular-nums">
                          {formatKzNumber(product.price)} Kz
                        </span>
                        {inCart && (
                          <span className="text-[11px] font-mono font-bold text-blue-600 tabular-nums">
                            ×{inCart.qty}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* COLUNA 2: Operação de Caixa (Cliente, Linhas, Pagamento, Emissão) */}
        <section
          className={`lg:col-span-4 flex flex-col border-r border-slate-200 bg-white overflow-hidden ${
            mobilePane === 'CART' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          {/* Seletor de Cliente & Gaveta de Opções Secundárias */}
          <div className="p-3 border-b border-slate-200 space-y-2 shrink-0">
            <div className="flex items-center gap-2">
              <select
                aria-label="Selecionar Cliente"
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value)}
                className="flex-1 h-10 px-2.5 text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600 truncate"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} {c.nif && c.nif !== 'Consumidor Final' ? `· NIF ${c.nif}` : ''}
                  </option>
                ))}
              </select>

              <button
                type="button"
                title="Opções do documento"
                onClick={() => setShowOptionsDrawer((v) => !v)}
                className="h-10 w-10 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 shrink-0"
              >
                {showOptionsDrawer ? (
                  <ChevronUp className="w-4 h-4" />
                ) : (
                  <ChevronDown className="w-4 h-4" />
                )}
              </button>

              <button
                type="button"
                title="Limpar caixa"
                onClick={clearSale}
                disabled={cart.length === 0 && !lastEmitted}
                className="h-10 w-10 flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:text-red-600 hover:bg-red-50 disabled:opacity-40 shrink-0"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>

            {/* Painel Compacto Recolhível (Tipo Doc, Caixa, Operador, Observações) */}
            {showOptionsDrawer && (
              <div className="pt-2 border-t border-slate-100 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">Documento</label>
                  <select
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as DocumentType)}
                    className="w-full h-9 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs"
                  >
                    <option value="FR">Factura/Recibo</option>
                    <option value="FP">Proforma</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">Caixa</label>
                  <input
                    type="text"
                    maxLength={8}
                    value={cashier}
                    onChange={(e) => setCashier(e.target.value)}
                    className="w-full h-9 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500 mb-0.5">Operador</label>
                  <input
                    type="text"
                    maxLength={12}
                    value={operator}
                    onChange={(e) => setOperator(e.target.value)}
                    className="w-full h-9 px-2 bg-slate-50 border border-slate-200 rounded-md text-xs font-mono"
                  />
                </div>
                <div className="col-span-3">
                  <input
                    type="text"
                    maxLength={160}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Observações na fatura..."
                    className="w-full h-9 px-2.5 bg-slate-50 border border-slate-200 rounded-md text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Linhas de Artigos no Caixa */}
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center p-6 text-center">
                <p className="text-xs text-slate-500">
                  Selecione artigos para iniciar a emissão.
                </p>
                {lastEmitted && (
                  <div className="mt-3 text-xs text-emerald-700 font-medium flex items-center gap-1.5">
                    <Check className="w-4 h-4" />
                    Emitida {lastEmitted.number} ({formatKzNumber(lastEmitted.grandTotal)} Kz)
                  </div>
                )}
              </div>
            ) : (
              totals.lines.map((line) => (
                <div key={line.productId} className="p-2.5 hover:bg-slate-50/70 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 truncate">
                        {line.description}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                        {formatKzNumber(line.unitPrice)} Kz · IVA {line.ivaRate}%
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-bold text-slate-900 font-mono tabular-nums">
                        {formatKzNumber(line.lineTotal)} Kz
                      </div>
                      {line.ivaRate === 14 && (
                        <div className="text-[10px] text-slate-400 font-mono tabular-nums">
                          IVA {formatKzNumber(line.lineTax)}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-2 flex items-center justify-between gap-2">
                    {/* Controlo Compacto de Quantidade */}
                    <div className="flex items-center border border-slate-200 rounded-md bg-white">
                      <button
                        type="button"
                        aria-label="Diminuir"
                        onClick={() => updateItemQty(line.productId, -1)}
                        className="h-8 w-8 flex items-center justify-center text-slate-600 hover:bg-slate-100"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <input
                        type="number"
                        min="0.1"
                        step="1"
                        aria-label="Quantidade"
                        value={line.qty}
                        onChange={(e) => setExactQty(line.productId, e.target.value)}
                        className="w-11 h-8 text-center text-xs font-mono font-semibold tabular-nums focus:outline-none"
                      />
                      <button
                        type="button"
                        aria-label="Aumentar"
                        onClick={() => updateItemQty(line.productId, 1)}
                        className="h-8 w-8 flex items-center justify-center text-slate-600 hover:bg-slate-100"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {/* Desconto % Opcional Compacto */}
                    <div className="flex items-center gap-1 text-[11px] text-slate-500">
                      <span>Desc%</span>
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={line.discountPct || ''}
                        placeholder="0"
                        onChange={(e) => setItemDiscount(line.productId, e.target.value)}
                        className="w-12 h-8 px-1.5 text-right font-mono text-xs border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
                      />
                    </div>

                    <button
                      type="button"
                      aria-label="Remover linha"
                      onClick={() => removeCartItem(line.productId)}
                      className="h-8 w-8 flex items-center justify-center text-slate-400 hover:text-red-600 rounded-md hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Painel Fixo Inferior: Resumo Fiscal, Recebido, Troco e Botão Emitir */}
          <div className="border-t border-slate-200 bg-slate-50 p-3 space-y-2.5 shrink-0">
            <div className="space-y-1 text-xs tabular-nums">
              <div className="flex justify-between text-slate-600">
                <span>Mercadorias</span>
                <span className="font-mono">{formatKzNumber(totals.merchandiseTotal)} Kz</span>
              </div>
              <div className="flex justify-between text-slate-600">
                <span>IVA (14%)</span>
                <span className="font-mono">{formatKzNumber(totals.taxTotal)} Kz</span>
              </div>
              <div className="flex justify-between items-baseline pt-1 border-t border-slate-200">
                <span className="font-bold text-slate-900">TOTAL</span>
                <span className="text-lg font-bold text-slate-900 font-mono">
                  {formatKzNumber(totals.grandTotal)} Kz
                </span>
              </div>
            </div>

            {/* Meio de Pagamento */}
            <div className="grid grid-cols-3 gap-1 bg-slate-200/70 p-0.5 rounded-lg">
              {(['Dinheiro', 'Multicaixa', 'Transferência'] as PaymentMethod[]).map((method) => (
                <button
                  key={method}
                  type="button"
                  onClick={() => setPaymentMethod(method)}
                  className={`h-8 text-[11px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    paymentMethod === method
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {method}
                </button>
              ))}
            </div>

            {/* Valor Recebido e Troco (Dinheiro) */}
            {paymentMethod === 'Dinheiro' && (
              <div className="space-y-1.5">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      Valor recebido (Kz)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="50"
                      value={amountReceivedInput}
                      onChange={(e) => setAmountReceivedInput(e.target.value)}
                      placeholder={formatKzNumber(totals.grandTotal)}
                      className="w-full h-9 px-2.5 bg-white border border-slate-200 rounded-lg text-xs font-mono font-semibold tabular-nums focus:outline-none focus:border-blue-600"
                    />
                  </div>
                  <div className="flex flex-col justify-end text-right">
                    <span className="text-[10px] text-slate-500">Troco</span>
                    <span className="h-9 flex items-center justify-end text-sm font-bold font-mono text-emerald-700 tabular-nums">
                      {formatKzNumber(changeAmount)} Kz
                    </span>
                  </div>
                </div>

                {/* Atalhos Rápidos de Notas Angolanas */}
                {totals.grandTotal > 0 && (
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {[1000, 2000, 5000, 8000, 10000].map((noteVal) => (
                      <button
                        key={noteVal}
                        type="button"
                        onClick={() => applyQuickCash(noteVal)}
                        className="h-7 px-2 rounded border border-slate-200 bg-white text-[10.5px] font-mono text-slate-700 hover:border-blue-600 shrink-0 tabular-nums"
                      >
                        {noteVal.toLocaleString('pt-PT')}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Ações Finais Compactas */}
            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                disabled={cart.length === 0 || isEmitting}
                onClick={() => handleEmit(settings.autoPrintOnEmit)}
                className="flex-1 h-11 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Check className="w-4 h-4" />
                Emitir
              </button>
              <button
                type="button"
                disabled={cart.length === 0 || isEmitting}
                onClick={() => handleEmit(true)}
                title="Emitir e Imprimir"
                className="flex-1 h-11 rounded-lg bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap"
              >
                <Printer className="w-4 h-4" />
                {previewFormat === 'A4' ? 'Emitir + A4' : 'Emitir + POS'}
              </button>
            </div>
          </div>
        </section>

        {/* COLUNA 3: Pré-visualização Unificada (POS Térmico 80mm / A4 Comercial) */}
        <section
          className={`${
            previewFormat === 'A4' ? 'lg:col-span-4' : 'lg:col-span-3'
          } flex flex-col bg-slate-100 overflow-hidden ${
            mobilePane === 'PREVIEW' ? 'flex' : 'hidden lg:flex'
          }`}
        >
          <div className="p-2.5 border-b border-slate-200 bg-white flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center bg-slate-100 p-0.5 rounded-lg">
              <button
                type="button"
                onClick={() => setPreviewFormat('POS')}
                className={`h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                  previewFormat === 'POS'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                POS 80mm
              </button>
              <button
                type="button"
                onClick={() => setPreviewFormat('A4')}
                className={`h-8 px-3 text-[11px] font-semibold rounded-md transition-colors whitespace-nowrap ${
                  previewFormat === 'A4'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                A4
              </button>
            </div>

            <button
              type="button"
              disabled={livePreviewInvoice.lines.length === 0}
              onClick={() => onPrintInvoice(livePreviewInvoice, previewFormat)}
              title="Imprimir vista atual"
              className="h-8 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 flex items-center gap-1.5 whitespace-nowrap"
            >
              <Printer className="w-3.5 h-3.5" />
              Imprimir
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {livePreviewInvoice.lines.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-slate-400 text-center px-4">
                {previewFormat === 'A4'
                  ? 'A fatura A4 aparecerá aqui em tempo real ao adicionar artigos.'
                  : 'O talão térmico aparecerá aqui em tempo real ao adicionar artigos.'}
              </div>
            ) : (
              <UnifiedDocumentView
                invoice={livePreviewInvoice}
                format={previewFormat}
                company={settings.company}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
