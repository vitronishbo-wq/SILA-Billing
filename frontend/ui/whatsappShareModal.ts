import { buildWhatsAppUrl, normalizeWhatsAppPhone } from '../../src/core/whatsappChannel';
import type { WhatsAppCommercialKind } from '../../src/core/whatsappChannel';
import { ICONS } from './icons';

export interface WhatsAppShareDraftState {
  kind: WhatsAppCommercialKind;
  title: string;
  subtitle: string;
  recipientLabel: string;
  phoneInput: string;
  messageText: string;
  pdfFileName: string;
  pdfBytes: Uint8Array;
  pdfDownloaded: boolean;
  copiedFeedback: boolean;
  shareError: string | null;
  canNativeShareFiles: boolean;
}

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderWhatsAppShareModal(draft: WhatsAppShareDraftState): string {
  const norm = normalizeWhatsAppPhone(draft.phoneInput);
  const waHref = buildWhatsAppUrl(norm.digits, draft.messageText);
  const kbSize = Math.max(1, Math.round(draft.pdfBytes.byteLength / 1024));

  return `
    <div class="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-[1px] flex items-end sm:items-center justify-center p-0 sm:p-4 no-print">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whatsapp-share-title"
        class="w-full max-w-xl bg-white border border-slate-200 rounded-t-2xl sm:rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[92dvh]"
      >
        <div class="px-5 py-3.5 border-b border-slate-200 flex items-start justify-between gap-3 shrink-0">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-emerald-700 text-xs font-semibold">
              ${ICONS.whatsapp}
              <span>Canal Comercial WhatsApp</span>
            </div>
            <h2 id="whatsapp-share-title" class="text-sm font-bold text-slate-900 mt-0.5 truncate">
              ${escapeHtml(draft.title)}
            </h2>
            <p class="text-[11px] text-slate-500 truncate">${escapeHtml(draft.subtitle)}</p>
          </div>
          <button
            type="button"
            data-action="close-whatsapp-share-modal"
            aria-label="Fechar"
            class="h-9 w-9 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center shrink-0"
          >${ICONS.close}</button>
        </div>

        <div class="p-5 space-y-4 overflow-y-auto flex-1">
          <!-- Ficheiro PDF pronto sem instalação -->
          <div class="flex items-center justify-between gap-3 py-2.5 px-3 rounded-lg bg-slate-50 border border-slate-200">
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="h-8 w-8 rounded-md bg-white border border-slate-200 text-slate-700 flex items-center justify-center shrink-0">
                ${ICONS.fileA4}
              </div>
              <div class="min-w-0">
                <div class="text-xs font-semibold text-slate-900 font-mono truncate">${escapeHtml(draft.pdfFileName)}</div>
                <div class="text-[11px] text-slate-500 tabular-nums">${kbSize} KB · PDF padrão (sem instalação para quem recebe)</div>
              </div>
            </div>
            <button
              type="button"
              data-action="whatsapp-download-pdf"
              class="h-9 px-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              ${ICONS.download}
              <span>${draft.pdfDownloaded ? 'PDF guardado' : 'Descarregar PDF'}</span>
            </button>
          </div>

          <!-- Destinatário WhatsApp -->
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2 text-xs">
              <label for="whatsapp-phone-input" class="font-semibold text-slate-700">
                Telemóvel / WhatsApp (${escapeHtml(draft.recipientLabel)})
              </label>
              <span class="text-[11px] font-mono tabular-nums ${
                !draft.phoneInput.trim()
                  ? 'text-slate-400'
                  : norm.valid
                    ? 'text-emerald-700'
                    : 'text-amber-700'
              }">
                ${
                  !draft.phoneInput.trim()
                    ? 'Opcional (pode escolher no WhatsApp)'
                    : norm.valid
                      ? `Destino: ${escapeHtml(norm.display)}`
                      : 'Formato inválido (ex: 943671515 ou +244...)'
                }
              </span>
            </div>
            <input
              id="whatsapp-phone-input"
              type="tel"
              data-field="whatsapp-phone-input"
              value="${escapeHtml(draft.phoneInput)}"
              placeholder="Ex: 943 671 515 ou +244 943 671 515"
              class="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono text-slate-900 focus:outline-none focus:border-blue-600"
            />
          </div>

          <!-- Mensagem comercial formatada -->
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2 text-xs">
              <label for="whatsapp-message-input" class="font-semibold text-slate-700">Mensagem comercial</label>
              <button
                type="button"
                data-action="whatsapp-copy-text"
                class="text-[11px] font-semibold text-blue-700 hover:underline inline-flex items-center gap-1"
              >
                ${ICONS.copy}
                <span>${draft.copiedFeedback ? 'Copiado!' : 'Copiar texto'}</span>
              </button>
            </div>
            <textarea
              id="whatsapp-message-input"
              rows="6"
              data-field="whatsapp-message-input"
              class="w-full p-3 rounded-lg border border-slate-300 bg-slate-50/70 text-xs text-slate-800 leading-relaxed focus:outline-none focus:border-blue-600 focus:bg-white"
            >${escapeHtml(draft.messageText)}</textarea>
          </div>

          ${
            draft.shareError
              ? `<div class="p-2.5 rounded-lg border border-amber-200 bg-amber-50 text-xs text-amber-800">${escapeHtml(draft.shareError)}</div>`
              : ''
          }
        </div>

        <!-- Rodapé com Acções Imediatas -->
        <div class="px-5 py-3.5 border-t border-slate-200 bg-slate-50 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <button
            type="button"
            data-action="close-whatsapp-share-modal"
            class="h-10 px-3.5 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
          >Fechar</button>

          <div class="flex flex-wrap items-center gap-2">
            ${
              draft.canNativeShareFiles
                ? `<button
                    type="button"
                    data-action="whatsapp-native-share"
                    class="h-10 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
                  >
                    ${ICONS.share2}
                    <span>Enviar PDF + Mensagem</span>
                  </button>`
                : ''
            }
            <a
              id="whatsapp-open-link"
              href="${escapeHtml(waHref)}"
              target="_blank"
              rel="noopener noreferrer"
              data-action="whatsapp-open-link"
              class="h-10 px-4 rounded-lg ${
                draft.canNativeShareFiles
                  ? 'border border-emerald-600 bg-white text-emerald-700 hover:bg-emerald-50'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white'
              } text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap"
            >
              ${ICONS.whatsapp}
              <span>${draft.canNativeShareFiles ? 'Abrir WhatsApp Web' : 'Descarregar PDF e Abrir WhatsApp'}</span>
              ${ICONS.externalLink}
            </a>
          </div>
        </div>
      </div>
    </div>
  `;
}
