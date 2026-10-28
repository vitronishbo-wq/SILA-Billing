import { Edit2, Plus, Search, Trash2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { formatKzNumber } from '../core/billingEngine';
import { Product, TaxRate } from '../core/types';

interface ProductsPanelProps {
  products: Product[];
  onSaveProduct: (product: Product, isNew: boolean) => Promise<void>;
  onDeleteProduct: (id: string) => Promise<void>;
}

export const ProductsPanel: React.FC<ProductsPanelProps> = ({
  products,
  onSaveProduct,
  onDeleteProduct,
}) => {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [isNewRecord, setIsNewRecord] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)
    );
  }, [products, query]);

  const startCreate = () => {
    const nextNum = String(products.length + 1).padStart(5, '0');
    const now = new Date().toISOString();
    setIsNewRecord(true);
    setEditing({
      id: `prod_${Date.now()}`,
      code: nextNum,
      name: '',
      unit: 'un',
      price: 0,
      ivaRate: 14,
      exemptionReason: '',
      active: true,
      synced: false,
      createdAtIso: now,
      updatedAtIso: now,
    });
  };

  const startEdit = (product: Product) => {
    setIsNewRecord(false);
    setEditing({ ...product });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || !editing.name.trim() || !editing.code.trim()) return;
    const now = new Date().toISOString();
    await onSaveProduct(
      {
        ...editing,
        code: editing.code.trim(),
        name: editing.name.trim(),
        unit: editing.unit.trim() || 'un',
        price: Math.max(0, Number(editing.price) || 0),
        exemptionReason:
          editing.ivaRate === 0
            ? editing.exemptionReason.trim() || 'Isento nos termos da Lei do IVA'
            : '',
        updatedAtIso: now,
      },
      isNewRecord
    );
    setEditing(null);
  };

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* Barra de Topo Compacta */}
      <div className="p-3 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar artigos por código ou descrição..."
            className="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          />
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Novo Artigo
        </button>
      </div>

      {/* Formulário Inline Compacto (Zero Modais Desnecessários) */}
      {editing && (
        <form
          onSubmit={handleSubmit}
          className="p-3.5 border-b border-slate-200 bg-slate-50 grid grid-cols-2 sm:grid-cols-12 gap-2.5 items-end shrink-0"
        >
          <div className="col-span-1 sm:col-span-2">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Código</label>
            <input
              type="text"
              required
              maxLength={32}
              value={editing.code}
              onChange={(e) => setEditing({ ...editing, code: e.target.value })}
              className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="col-span-2 sm:col-span-4">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Descrição</label>
            <input
              type="text"
              required
              maxLength={160}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Ex: Água Mineral 1,5L"
              className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="col-span-1 sm:col-span-2">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">
              Preço Unit. (Kz)
            </label>
            <input
              type="number"
              required
              min="0"
              step="0.01"
              value={editing.price}
              onChange={(e) => setEditing({ ...editing, price: parseFloat(e.target.value) || 0 })}
              className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="col-span-1 sm:col-span-1">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Unid.</label>
            <input
              type="text"
              maxLength={12}
              value={editing.unit}
              onChange={(e) => setEditing({ ...editing, unit: e.target.value })}
              className="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="col-span-1 sm:col-span-1">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">IVA</label>
            <select
              value={editing.ivaRate}
              onChange={(e) =>
                setEditing({ ...editing, ivaRate: Number(e.target.value) as TaxRate })
              }
              className="w-full h-9 px-2 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            >
              <option value={14}>14%</option>
              <option value={0}>Isento</option>
            </select>
          </div>
          <div className="col-span-1 sm:col-span-2 flex items-center gap-1.5">
            <button
              type="submit"
              className="flex-1 h-9 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
            >
              Guardar
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              title="Cancelar"
              className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </form>
      )}

      {/* Tabela de Artigos de Alta Densidade */}
      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
            <tr>
              <th className="py-2.5 px-3 font-medium">Código</th>
              <th className="py-2.5 px-3 font-medium">Descrição</th>
              <th className="py-2.5 px-3 font-medium">Unid.</th>
              <th className="py-2.5 px-3 font-medium text-right">IVA</th>
              <th className="py-2.5 px-3 font-medium text-right">Preço Unit.</th>
              <th className="py-2.5 px-3 font-medium text-right w-24">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs">
            {filtered.map((p) => (
              <tr key={p.id} className="hover:bg-slate-50/80">
                <td className="py-2.5 px-3 font-mono text-slate-600">{p.code}</td>
                <td className="py-2.5 px-3 font-medium text-slate-900">{p.name}</td>
                <td className="py-2.5 px-3 text-slate-500">{p.unit}</td>
                <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                  {p.ivaRate === 14 ? '14%' : '0%'}
                </td>
                <td className="py-2.5 px-3 text-right font-mono font-semibold tabular-nums text-slate-900">
                  {formatKzNumber(p.price)} Kz
                </td>
                <td className="py-2 px-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      title="Editar"
                      onClick={() => startEdit(p)}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      title="Eliminar"
                      onClick={() => onDeleteProduct(p.id)}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
