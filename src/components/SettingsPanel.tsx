import { Check, RotateCcw } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { AppSettings, DEFAULT_SETTINGS, DocumentFormat, DocumentType } from '../core/types';

interface SettingsPanelProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => Promise<void>;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ settings, onSaveSettings }) => {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveSettings({
      ...draft,
      updatedAtIso: new Date().toISOString(),
    });
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  const handleResetDefaults = async () => {
    const resetVal: AppSettings = {
      ...DEFAULT_SETTINGS,
      updatedAtIso: new Date().toISOString(),
    };
    setDraft(resetVal);
    await onSaveSettings(resetVal);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 2000);
  };

  return (
    <div className="h-full overflow-y-auto bg-white p-4 sm:p-6">
      <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-200">
          <div>
            <h1 className="text-sm font-bold text-slate-900">Configurações</h1>
            <p className="text-xs text-slate-500">
              Identidade empresarial e predefinições de emissão POS / A4.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleResetDefaults}
              title="Repor valores originais JAIMONA"
              className="h-9 px-3 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:bg-slate-50 flex items-center gap-1.5 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Repor padrão
            </button>
            <button
              type="submit"
              className="h-9 px-4 rounded-lg bg-slate-900 text-white text-xs font-semibold hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
            >
              <Check className="w-3.5 h-3.5" />
              {savedNotice ? 'Guardado' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* Secção 1: Identidade Empresarial */}
        <section className="space-y-3">
          <h2 className="text-xs font-semibold text-slate-900">Identidade Empresarial</h2>
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div className="sm:col-span-8">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Designação Social
              </label>
              <input
                type="text"
                required
                maxLength={160}
                value={draft.company.legalName}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, legalName: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-4">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Nome Curto / Marca
              </label>
              <input
                type="text"
                required
                maxLength={64}
                value={draft.company.shortName}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, shortName: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-4">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                NIF (Contribuinte)
              </label>
              <input
                type="text"
                required
                maxLength={32}
                value={draft.company.nif}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, nif: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-4">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Telefone</label>
              <input
                type="text"
                maxLength={40}
                value={draft.company.phone}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, phone: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-4">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">Email</label>
              <input
                type="email"
                maxLength={120}
                value={draft.company.email}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, email: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-7">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Endereço Fiscal
              </label>
              <input
                type="text"
                required
                maxLength={160}
                value={draft.company.address}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, address: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="sm:col-span-5">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Assinatura / Rodapé
              </label>
              <input
                type="text"
                maxLength={120}
                value={draft.company.tagline}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    company: { ...draft.company, tagline: e.target.value },
                  })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>
          </div>
        </section>

        {/* Secção 2: Predefinições de Caixa e Impressão */}
        <section className="space-y-3 pt-4 border-t border-slate-200">
          <h2 className="text-xs font-semibold text-slate-900">Caixa e Emissão</h2>
          <div className="grid grid-cols-2 sm:grid-cols-12 gap-3">
            <div className="col-span-1 sm:col-span-3">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Caixa Padrão
              </label>
              <input
                type="text"
                required
                maxLength={16}
                value={draft.defaultCashier}
                onChange={(e) => setDraft({ ...draft, defaultCashier: e.target.value })}
                className="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="col-span-1 sm:col-span-3">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Operador(a) Padrão
              </label>
              <input
                type="text"
                required
                maxLength={32}
                value={draft.defaultOperator}
                onChange={(e) => setDraft({ ...draft, defaultOperator: e.target.value })}
                className="w-full h-9 px-2.5 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="col-span-1 sm:col-span-3">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Tipo de Documento
              </label>
              <select
                value={draft.defaultDocType}
                onChange={(e) =>
                  setDraft({ ...draft, defaultDocType: e.target.value as DocumentType })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              >
                <option value="FR">Factura / Recibo</option>
                <option value="FP">Factura Proforma</option>
              </select>
            </div>

            <div className="col-span-1 sm:col-span-3">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Formato Preferencial
              </label>
              <select
                value={draft.defaultFormat}
                onChange={(e) =>
                  setDraft({ ...draft, defaultFormat: e.target.value as DocumentFormat })
                }
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              >
                <option value="POS">POS Térmico 80mm</option>
                <option value="A4">Fatura A4</option>
              </select>
            </div>

            <div className="col-span-2 sm:col-span-8">
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Observação Padrão
              </label>
              <input
                type="text"
                maxLength={300}
                value={draft.defaultNotes}
                onChange={(e) => setDraft({ ...draft, defaultNotes: e.target.value })}
                className="w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-blue-600"
              />
            </div>

            <div className="col-span-2 sm:col-span-4 flex items-end">
              <label className="flex items-center gap-2 h-9 text-xs text-slate-700 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={draft.autoPrintOnEmit}
                  onChange={(e) => setDraft({ ...draft, autoPrintOnEmit: e.target.checked })}
                  className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                <span>Imprimir ao clicar em Emitir</span>
              </label>
            </div>
          </div>
        </section>
      </form>
    </div>
  );
};
