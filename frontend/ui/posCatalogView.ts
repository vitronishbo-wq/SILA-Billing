import { formatKzNumber } from '../../src/core/billingEngine';
import type { CartDraftItem, Product } from '../../src/core/types';
import { ICONS } from './icons';

export type CatalogViewMode = 'list' | 'touch';

export const CATALOG_VIEW_MODE_STORAGE_KEY = 'sila_billing_catalog_view_mode_v1';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type MatchMediaLike = (query: string) => { matches: boolean };

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDefaultStorage(): StorageLike | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore storage access errors in restricted frames/private mode
  }
  return null;
}

function getDefaultMatchMedia(): MatchMediaLike | null {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return (query: string) => window.matchMedia(query);
    }
  } catch {
    // Ignore
  }
  return null;
}

/**
 * Detecção inicial do modo do catálogo apenas quando o utilizador ainda não
 * guardou preferência manual neste dispositivo.
 */
export function resolveInitialCatalogViewMode(matchMediaFn?: MatchMediaLike | null): CatalogViewMode {
  const mm = matchMediaFn !== undefined ? matchMediaFn : getDefaultMatchMedia();
  try {
    if (mm && mm('(pointer: fine)').matches) {
      return 'list';
    }
  } catch {
    // Fallback seguro
  }
  return 'touch';
}

export function readCatalogViewModePreference(
  storage?: StorageLike | null,
  matchMediaFn?: MatchMediaLike | null
): CatalogViewMode {
  const store = storage !== undefined ? storage : getDefaultStorage();
  try {
    const saved = store?.getItem(CATALOG_VIEW_MODE_STORAGE_KEY);
    if (saved === 'list' || saved === 'touch') {
      return saved;
    }
  } catch {
    // Ignore storage read errors
  }
  return resolveInitialCatalogViewMode(matchMediaFn);
}

export function writeCatalogViewModePreference(
  mode: CatalogViewMode,
  storage?: StorageLike | null
): void {
  if (mode !== 'list' && mode !== 'touch') return;
  const store = storage !== undefined ? storage : getDefaultStorage();
  try {
    store?.setItem(CATALOG_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage write errors
  }
}

export function renderCatalogViewModeSelector(mode: CatalogViewMode): string {
  return `
    <div
      class="inline-flex items-center bg-slate-100 p-0.5 rounded-md border border-slate-200/80 shrink-0"
      role="group"
      aria-label="Modo de visualização do catálogo"
    >
      <button
        type="button"
        data-action="set-catalog-view-mode"
        data-value="list"
        aria-pressed="${mode === 'list' ? 'true' : 'false'}"
        title="Lista compacta (rato / estilo Excel)"
        class="h-6 px-2 rounded text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
          mode === 'list'
            ? 'bg-white text-slate-900 shadow-xs'
            : 'text-slate-500 hover:text-slate-900'
        }"
      >${ICONS.listRows}<span class="hidden sm:inline">Lista</span></button>
      <button
        type="button"
        data-action="set-catalog-view-mode"
        data-value="touch"
        aria-pressed="${mode === 'touch' ? 'true' : 'false'}"
        title="Grelha tátil (Touch)"
        class="h-6 px-2 rounded text-[11px] font-medium flex items-center gap-1 transition-colors whitespace-nowrap ${
          mode === 'touch'
            ? 'bg-white text-slate-900 shadow-xs'
            : 'text-slate-500 hover:text-slate-900'
        }"
      >${ICONS.gridCards}<span class="hidden sm:inline">Touch</span></button>
    </div>
  `;
}

function formatCatalogIvaLabel(ivaRate: number): string {
  return ivaRate > 0 ? `${ivaRate}%` : 'Isento';
}

function renderCardStockMeta(prod: Product): string {
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
}

function renderListStockCell(prod: Product): string {
  if (!prod.trackStock) {
    return `<span class="text-[11px] font-mono text-slate-300">—</span>`;
  }
  const qty = prod.stockQty ?? 0;
  const minQty = prod.minStockQty ?? 0;
  if (qty <= 0) {
    return `<span class="text-[11px] font-mono tabular-nums text-red-600 font-semibold">0 ${escapeHtml(prod.unit)}</span>`;
  }
  if (qty <= minQty) {
    return `<span class="text-[11px] font-mono tabular-nums text-amber-700 font-medium">${qty} ${escapeHtml(prod.unit)}</span>`;
  }
  return `<span class="text-[11px] font-mono tabular-nums text-slate-600">${qty} ${escapeHtml(prod.unit)}</span>`;
}

export function renderCatalogProductCollection(params: {
  products: Product[];
  cart: CartDraftItem[];
  mode: CatalogViewMode;
  action: 'add-to-cart' | 'add-suggested-to-cart';
  isSuspended: boolean;
  isSuggestion?: boolean;
}): string {
  const { products, cart, mode, action, isSuspended, isSuggestion = false } = params;

  if (mode === 'touch') {
    const minCardHeightClass = isSuggestion ? 'min-h-[88px]' : 'min-h-[92px]';
    return `
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3 gap-2">
        ${products
          .map((prod) => {
            const inCart = cart.find((c) => c.productId === prod.id);
            const outOfStock = Boolean(prod.trackStock && (prod.stockQty ?? 0) <= 0);
            return `
              <button
                type="button"
                data-action="${action}"
                data-id="${escapeHtml(prod.id)}"
                ${isSuspended ? 'disabled' : ''}
                class="text-left p-2.5 rounded-lg border transition-colors ${minCardHeightClass} flex flex-col justify-between active:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none ${
                  inCart
                    ? 'bg-white border-blue-600 ring-1 ring-blue-600/20'
                    : outOfStock
                      ? 'bg-amber-50/25 border-amber-200 hover:border-amber-400'
                      : 'bg-white border-slate-200 hover:border-blue-600'
                }"
              >
                <div class="flex items-center justify-between gap-1.5 w-full text-[10px] text-slate-400">
                  <span class="font-mono truncate">${escapeHtml(prod.code)} · ${escapeHtml(prod.category || 'Geral')}</span>
                  ${isSuggestion ? renderCardStockMeta(prod) : `<span class="tabular-nums shrink-0 text-slate-500">${formatCatalogIvaLabel(prod.ivaRate)}</span>`}
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
                  ${!isSuggestion && prod.trackStock ? `<div class="flex items-center justify-between">${renderCardStockMeta(prod)}</div>` : ''}
                </div>
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  // Modo Lista (rato / estilo Excel responsivo: nunca comprime colunas críticas em ecrãs estreitos)
  const showStockColumn = products.some((p) => p.trackStock);

  return `
    <div class="@container border border-slate-200 rounded-lg bg-white divide-y divide-slate-200/80 overflow-hidden">
      <div class="bg-slate-50 px-2.5 py-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 select-none">
        <span class="hidden @md:block w-20 shrink-0">Código</span>
        <span class="flex-1 min-w-0">Artigo</span>
        ${showStockColumn ? `<span class="hidden @sm:block w-20 text-right shrink-0">Stock</span>` : ''}
        <span class="hidden @lg:block w-12 text-center shrink-0">IVA</span>
        <span class="w-24 @sm:w-28 text-right shrink-0">Preço</span>
      </div>
      ${products
        .map((prod) => {
          const inCart = cart.find((c) => c.productId === prod.id);
          const outOfStock = Boolean(prod.trackStock && (prod.stockQty ?? 0) <= 0);
          const ivaLabel = formatCatalogIvaLabel(prod.ivaRate);
          const rowTone = inCart
            ? 'bg-blue-50/75 hover:bg-blue-50'
            : outOfStock
              ? 'bg-amber-50/35 hover:bg-amber-50/60'
              : 'odd:bg-white even:bg-slate-50/45 hover:bg-slate-100/75';
          const titleText = `${prod.code} · ${prod.name}`;

          return `
            <button
              type="button"
              data-action="${action}"
              data-id="${escapeHtml(prod.id)}"
              title="${escapeHtml(titleText)}"
              ${isSuspended ? 'disabled' : ''}
              class="w-full text-left px-2.5 py-1.5 min-h-[30px] flex items-center gap-2 transition-colors active:bg-blue-100/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-600 disabled:opacity-50 disabled:pointer-events-none ${rowTone}"
            >
              <span class="hidden @md:block w-20 shrink-0 font-mono text-[11px] text-slate-400 tabular-nums truncate">${escapeHtml(prod.code)}</span>
              <span class="flex-1 min-w-0">
                <span class="block text-xs font-medium text-slate-900 leading-snug line-clamp-2 @sm:line-clamp-1">${escapeHtml(prod.name)}</span>
                <span class="flex flex-wrap items-center gap-x-1.5 text-[10px] text-slate-400 font-mono @md:hidden mt-0.5 leading-tight">
                  <span class="truncate">${escapeHtml(prod.code)}</span>
                  <span aria-hidden="true">·</span>
                  <span>${ivaLabel}</span>
                  ${
                    prod.trackStock
                      ? `<span class="@sm:hidden inline-flex items-center gap-1"><span aria-hidden="true">·</span>${renderCardStockMeta(prod)}</span>`
                      : ''
                  }
                </span>
              </span>
              ${
                showStockColumn
                  ? `<span class="hidden @sm:block w-20 text-right shrink-0 truncate">${renderListStockCell(prod)}</span>`
                  : ''
              }
              <span class="hidden @lg:block w-12 text-center shrink-0 text-[11px] font-mono tabular-nums text-slate-500">${ivaLabel}</span>
              <span class="w-24 @sm:w-28 text-right shrink-0 font-mono tabular-nums whitespace-nowrap flex items-center justify-end gap-1">
                <span class="text-xs font-semibold text-slate-900">${formatKzNumber(prod.price)} Kz</span>
                ${
                  inCart
                    ? `<span class="text-[11px] font-bold text-blue-600">×${inCart.qty}</span>`
                    : ''
                }
              </span>
            </button>
          `;
        })
        .join('')}
    </div>
  `;
}
