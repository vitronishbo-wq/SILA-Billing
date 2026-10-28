import { Edit2, Plus, Search, Trash2, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { Customer } from '../core/types';

interface CustomersPanelProps {
  customers: Customer[];
  onSaveCustomer: (customer: Customer) => Promise<void>;
  onDeleteCustomer: (id: string) => Promise<void>;
}

export const CustomersPanel: React.FC<CustomersPanelProps> = ({
  customers,
  onSaveCustomer,
  onDeleteCustomer,
}) => {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Customer | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.nif.toLowerCase().includes(q) ||
        c.locality.toLowerCase().includes(q)
    );
  }, [customers, query]);

  const startCreate = () => {
    const now = new Date().toISOString();
    setEditing({
      id: `cust_${Date.now()}`,
      name: '',
      nif: '',
      locality: 'Saurimo - Angola',
      phone: '',
      address: '',
      synced: false,
      createdAtIso: now,
      updatedAtIso: now,
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing || !editing.name.trim()) return;
    await onSaveCustomer({
      ...editing,
      name: editing.name.trim(),
      nif: editing.nif.trim() || 'Consumidor Final',
      locality: editing.locality.trim() || 'Saurimo - Angola',
      phone: editing.phone.trim(),
      address: editing.address.trim(),
      updatedAtIso: new Date().toISOString(),
    });
    setEditing(null);
  };

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      <div className="p-3 border-b border-slate-200 flex items-center justify-between gap-2 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrar clientes por nome, NIF ou localidade..."
            className="w-full h-10 pl-9 pr-3 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:border-blue-600"
          />
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="h-10 px-3.5 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          Novo Cliente
        </button>
      </div>

      {editing && (
        <form
          onSubmit={handleSubmit}
          className="p-3.5 border-b border-slate-200 bg-slate-50 grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end shrink-0"
        >
          <div className="sm:col-span-4">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Nome / Entidade</label>
            <input
              type="text"
              required
              maxLength={160}
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Nome completo ou empresa"
              className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">NIF</label>
            <input
              type="text"
              maxLength={32}
              value={editing.nif}
              onChange={(e) => setEditing({ ...editing, nif: e.target.value })}
              placeholder="500..."
              className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Telefone</label>
            <input
              type="text"
              maxLength={40}
              value={editing.phone}
              onChange={(e) => setEditing({ ...editing, phone: e.target.value })}
              placeholder="(+244) 9..."
              className="w-full h-9 px-2.5 text-xs font-mono bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-[10px] font-medium text-slate-600 mb-1">Localidade</label>
            <input
              type="text"
              maxLength={160}
              value={editing.locality}
              onChange={(e) => setEditing({ ...editing, locality: e.target.value })}
              className="w-full h-9 px-2.5 text-xs bg-white border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
            />
          </div>
          <div className="sm:col-span-2 flex items-center gap-1.5">
            <button
              type="submit"
              className="flex-1 h-9 px-3 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 whitespace-nowrap"
            >
              Guardar
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="h-9 w-9 flex items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-y-auto">
        <table className="w-full text-left border-collapse">
          <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
            <tr>
              <th className="py-2.5 px-3 font-medium">Cliente</th>
              <th className="py-2.5 px-3 font-medium">NIF</th>
              <th className="py-2.5 px-3 font-medium hidden sm:table-cell">Localidade</th>
              <th className="py-2.5 px-3 font-medium hidden md:table-cell">Telefone</th>
              <th className="py-2.5 px-3 font-medium text-right w-24">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs">
            {filtered.map((c) => (
              <tr key={c.id} className="hover:bg-slate-50/80">
                <td className="py-2.5 px-3 font-medium text-slate-900">{c.name}</td>
                <td className="py-2.5 px-3 font-mono text-slate-600 tabular-nums">{c.nif}</td>
                <td className="py-2.5 px-3 text-slate-600 hidden sm:table-cell">{c.locality}</td>
                <td className="py-2.5 px-3 font-mono text-slate-500 hidden md:table-cell">
                  {c.phone || '—'}
                </td>
                <td className="py-2 px-3 text-right">
                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      title="Editar"
                      onClick={() => setEditing({ ...c })}
                      className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-500 hover:text-slate-900 hover:bg-slate-100"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {c.id !== 'cust_direct' && (
                      <button
                        type="button"
                        title="Eliminar"
                        onClick={() => onDeleteCustomer(c.id)}
                        className="h-8 w-8 inline-flex items-center justify-center rounded-md text-slate-400 hover:text-red-600 hover:bg-red-50"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
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
