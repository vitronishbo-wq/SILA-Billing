import QRCode from 'qrcode';
import { formatDateTimePt, formatKzNumber } from '../../src/core/billingEngine';
import {
  CompanyProfile,
  deriveCompanyInitials,
  DocumentFormat,
  InvoiceRecord,
  JAIMONA_COMPANY,
  normalizeCompanyNif,
} from '../../src/core/types';

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function generateInvoiceQrDataUrl(
  invoice: InvoiceRecord,
  company: CompanyProfile = JAIMONA_COMPANY
): Promise<string> {
  const dt = formatDateTimePt(invoice.issuedAtIso);
  const payload = [
    `EMISSOR:${company.legalName}`,
    `NIF:${company.nif}`,
    `DOC:${invoice.number}`,
    `DATA:${dt.date} ${dt.time}`,
    `TOTAL:${invoice.grandTotal.toFixed(2)} AOA`,
  ].join('|');

  try {
    return await QRCode.toDataURL(payload, {
      width: 140,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
    });
  } catch {
    return '';
  }
}

export function renderDocumentHtml(
  invoice: InvoiceRecord,
  format: DocumentFormat,
  company: CompanyProfile = JAIMONA_COMPANY,
  qrDataUrl = ''
): string {
  const dt = formatDateTimePt(invoice.issuedAtIso);
  const titleLabel = invoice.docType === 'FP' ? 'FACTURA PROFORMA' : 'FACTURA / RECIBO';

  if (format === 'POS') {
    const itemsHtml = invoice.lines
      .map((line) => {
        const qtyStr = Number.isInteger(line.qty) ? String(line.qty) : formatKzNumber(line.qty);
        const discStr = line.discountPct > 0 ? ` (-${line.discountPct}%)` : '';
        return `
          <div class="text-[11.5px]">
            <div class="font-bold leading-tight">${escapeHtml(line.description)}</div>
            <div class="flex justify-between tabular-nums pl-1.5">
              <span>${qtyStr} x ${formatKzNumber(line.unitPrice)}${discStr}</span>
              <span>${formatKzNumber(line.lineTotal)}</span>
            </div>
          </div>
        `;
      })
      .join('');

    return `
      <div class="print-target mx-auto w-full max-w-[330px] bg-white p-4 text-[12px] leading-snug text-black font-sans border border-slate-200">
        <div class="text-center space-y-0.5">
          <div class="font-bold text-[11px] tracking-tight">MODELO — SEM VALIDADE FISCAL</div>
          <div class="font-bold text-[13px] leading-tight">${escapeHtml(company.legalName)}</div>
          <div class="text-[11px]">${escapeHtml(company.address)}</div>
          <div class="text-[11px]">Tel.: ${escapeHtml(company.phone)}</div>
          <div class="text-[11px]">${escapeHtml(company.email)}</div>
          <div class="text-[11px]">Contribuinte: ${escapeHtml(company.nif)}</div>
        </div>

        ${
          qrDataUrl
            ? `<div class="my-2.5 flex justify-center">
                <img src="${qrDataUrl}" alt="QR Fatura" referrerpolicy="no-referrer" class="h-24 w-24 object-contain" />
              </div>`
            : ''
        }

        <div class="border-y border-black py-1.5 text-center my-2">
          <div class="font-bold text-[13px] tabular-nums">${titleLabel} N.º ${escapeHtml(invoice.number)}</div>
          <div class="text-[11px]">Venda Directa a Retalho</div>
          ${
            invoice.status === 'cancelled'
              ? '<div class="mt-0.5 font-bold text-red-700 text-[11px]">DOCUMENTO ANULADO</div>'
              : ''
          }
        </div>

        <div class="space-y-0.5 text-[11px] pb-2 border-b border-black">
          <div class="font-bold tabular-nums">Data: ${dt.date} &nbsp; ${dt.time}</div>
          <div class="flex justify-between tabular-nums">
            <span>Caixa: ${escapeHtml(invoice.cashier)}</span>
            <span>Operador(a): ${escapeHtml(invoice.operator)}</span>
          </div>
          <div>Pagamento: ${escapeHtml(invoice.paymentMethod)}</div>
          <div>Cliente: ${escapeHtml(invoice.customerName)}</div>
          ${
            invoice.customerNif && invoice.customerNif !== 'Consumidor Final'
              ? `<div class="tabular-nums">NIF Cliente: ${escapeHtml(invoice.customerNif)}</div>`
              : ''
          }
          <div>Localidade: ${escapeHtml(invoice.customerLocality || company.cityCountry || 'Angola')}</div>
        </div>

        <div class="py-2 border-b border-dashed border-black">
          <div class="font-bold text-[12px] mb-1">ARTIGOS</div>
          <div class="space-y-1.5">${itemsHtml}</div>
        </div>

        <div class="py-2 border-b border-black text-[11px] space-y-1">
          <div class="font-bold text-[12px]">RESUMO DE IMPOSTOS</div>
          <div class="tabular-nums">IVA 14% — Base: ${formatKzNumber(invoice.taxBase14)} — IVA: ${formatKzNumber(invoice.taxAmount14)}</div>
          <div class="tabular-nums">IVA 0% — Base: ${formatKzNumber(invoice.taxBase0)} — IVA: 0,00</div>
          <div class="pt-1 space-y-0.5 tabular-nums">
            <div class="flex justify-between">
              <span>Total de mercadorias</span>
              <span class="font-bold">${formatKzNumber(invoice.merchandiseTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span>Desconto comercial</span>
              <span>${formatKzNumber(invoice.discountTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span>Total de impostos</span>
              <span>${formatKzNumber(invoice.taxTotal)}</span>
            </div>
          </div>
        </div>

        <div class="py-2 border-b border-dashed border-black">
          <div class="font-bold text-[13px]">TOTAL A PAGAR</div>
          <div class="text-right font-bold text-[16px] tabular-nums">${formatKzNumber(invoice.grandTotal)} Kz</div>
          <div class="mt-1.5 text-[10.5px] font-bold leading-snug">Por extenso: ${escapeHtml(invoice.amountInWords)}</div>
        </div>

        <div class="py-2 border-b border-black text-[11px] space-y-0.5 tabular-nums">
          <div class="font-bold">Meio de pagamento: ${escapeHtml(invoice.paymentMethod)}</div>
          <div>Valor recebido: ${formatKzNumber(invoice.amountReceived)} Kz</div>
          <div>Troco: ${formatKzNumber(invoice.changeAmount)} Kz</div>
        </div>

        ${
          invoice.notes
            ? `<div class="py-2 border-b border-dashed border-black text-[11px]">
                <div class="font-bold">Observações</div>
                <div>${escapeHtml(invoice.notes)}</div>
              </div>`
            : ''
        }

        <div class="pt-2.5 text-center space-y-1">
          <div class="font-bold text-[11.5px]">OBRIGADO PELA SUA PREFERÊNCIA!</div>
          <div class="text-[11px]">${escapeHtml(company.tagline)}</div>
          <div class="border-t border-black mt-2 pt-1.5 text-[10px] space-y-0.5">
            <div class="font-bold">Documento de demonstração</div>
            <div class="tabular-nums">NIF: ${escapeHtml(company.nif)} | Caixa: ${escapeHtml(invoice.cashier)}</div>
            <div>Não substitui factura fiscal</div>
          </div>
        </div>
      </div>
    `;
  }

  // Formato Comercial A4 Unificado
  const rowsA4 = invoice.lines
    .map(
      (line) => `
        <tr>
          <td class="py-2 px-2.5 font-mono text-slate-600">${escapeHtml(line.code)}</td>
          <td class="py-2 px-2.5 font-medium text-slate-900">${escapeHtml(line.description)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.qty)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.unitPrice)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.ivaRate)}</td>
          <td class="py-2 px-2.5 text-right">${formatKzNumber(line.discountPct)}</td>
          <td class="py-2 px-2.5 text-right font-semibold text-slate-900">${formatKzNumber(line.lineTotal)}</td>
        </tr>
      `
    )
    .join('');

  return `
    <div class="print-target mx-auto w-full max-w-[794px] bg-white p-6 sm:p-8 text-slate-900 border border-slate-200 text-xs">
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-5 border-b border-slate-200">
        <div class="flex items-center gap-3.5">
          <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-blue-600 bg-slate-900 text-white font-bold text-lg tracking-tight">${escapeHtml(deriveCompanyInitials(company))}</div>
          <div>
            <div class="text-base font-bold tracking-tight text-slate-900">${escapeHtml(company.shortName)}</div>
            <div class="text-[11px] font-medium text-slate-600">${escapeHtml(company.legalName)}</div>
            <div class="text-[10px] text-blue-700 mt-0.5">${
              normalizeCompanyNif(company.nif) === '5003069940'
                ? 'Qualidade · Confiança · Soluções'
                : escapeHtml(company.tagline || company.cityCountry || 'Comércio & Serviços')
            }</div>
          </div>
        </div>
        <div class="text-[11px] text-slate-600 space-y-0.5 sm:text-right tabular-nums">
          <div>${escapeHtml(company.address)}</div>
          <div>Tel.: ${escapeHtml(company.phone)}</div>
          <div>${escapeHtml(company.email)}</div>
          <div class="font-semibold text-slate-900">Contribuinte: ${escapeHtml(company.nif)}</div>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 py-5">
        <div class="sm:col-span-7 space-y-3">
          <div>
            <div class="text-lg font-bold text-blue-700 tracking-tight">${titleLabel}</div>
            <div class="text-sm font-semibold text-slate-800 tabular-nums">N.º ${escapeHtml(invoice.number)}</div>
            ${
              invoice.status === 'cancelled'
                ? '<div class="mt-1 text-xs font-bold text-red-600">DOCUMENTO ANULADO</div>'
                : ''
            }
          </div>
          <div class="rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 space-y-0.5">
            <div class="text-[10px] font-semibold text-blue-700">Cliente</div>
            <div class="text-[11px] text-slate-500">Exmo.(s) Sr.(s)</div>
            <div class="text-xs font-bold text-slate-900">${escapeHtml(invoice.customerName)}</div>
            ${
              invoice.customerNif
                ? `<div class="text-[11px] text-slate-600 tabular-nums">NIF: ${escapeHtml(invoice.customerNif)}</div>`
                : ''
            }
            <div class="text-[11px] text-slate-600">${escapeHtml(invoice.customerLocality || company.cityCountry || 'Angola')}</div>
          </div>
        </div>

        <div class="sm:col-span-5 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 flex flex-col justify-between space-y-2 tabular-nums">
          <div>
            <div class="text-[10px] text-slate-500">Data de emissão</div>
            <div class="font-semibold text-slate-900">${dt.slashDate} &nbsp; ${dt.time}</div>
          </div>
          <div class="flex justify-between">
            <div>
              <div class="text-[10px] text-slate-500">Operador(a)</div>
              <div class="font-semibold text-slate-900">${escapeHtml(invoice.operator)}</div>
            </div>
            <div>
              <div class="text-[10px] text-slate-500">Caixa</div>
              <div class="font-semibold text-slate-900">${escapeHtml(invoice.cashier)}</div>
            </div>
          </div>
          <div>
            <div class="text-[10px] text-slate-500">Modo de pagamento</div>
            <div class="font-semibold text-slate-900">${escapeHtml(invoice.paymentMethod)}</div>
          </div>
        </div>
      </div>

      <div class="overflow-x-auto border border-slate-200 rounded-lg">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-900 text-white text-[10.5px]">
              <th class="py-2 px-2.5 font-semibold">Código</th>
              <th class="py-2 px-2.5 font-semibold">Descrição</th>
              <th class="py-2 px-2.5 font-semibold text-right">Qtd.</th>
              <th class="py-2 px-2.5 font-semibold text-right">Preço Unit.</th>
              <th class="py-2 px-2.5 font-semibold text-right">IVA %</th>
              <th class="py-2 px-2.5 font-semibold text-right">Desc. %</th>
              <th class="py-2 px-2.5 font-semibold text-right">Total</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-200 text-[11px] tabular-nums">${rowsA4}</tbody>
        </table>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-12 gap-4 mt-5">
        <div class="sm:col-span-6 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80">
          <div class="text-[11px] font-bold text-slate-900 mb-2">Resumo de Impostos</div>
          <table class="w-full text-[11px] tabular-nums">
            <thead>
              <tr class="text-slate-500 border-b border-slate-200">
                <th class="pb-1 text-left font-medium">IVA %</th>
                <th class="pb-1 text-right font-medium">Base de Cálculo</th>
                <th class="pb-1 text-right font-medium">Valor de IVA</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-200/70">
              <tr>
                <td class="py-1.5">14,00%</td>
                <td class="py-1.5 text-right">${formatKzNumber(invoice.taxBase14)}</td>
                <td class="py-1.5 text-right">${formatKzNumber(invoice.taxAmount14)}</td>
              </tr>
              <tr>
                <td class="py-1.5">0,00%</td>
                <td class="py-1.5 text-right">${formatKzNumber(invoice.taxBase0)}</td>
                <td class="py-1.5 text-right">0,00</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="sm:col-span-6 flex flex-col justify-between rounded-lg bg-slate-50 border border-slate-200/80 overflow-hidden tabular-nums">
          <div class="p-3.5 space-y-1.5 text-[11px]">
            <div class="flex justify-between">
              <span class="text-slate-600">Total de mercadorias</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.merchandiseTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-600">Desconto comercial</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.discountTotal)}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-slate-600">Total de impostos</span>
              <span class="font-semibold text-slate-900">${formatKzNumber(invoice.taxTotal)}</span>
            </div>
          </div>
          <div class="bg-blue-600 px-4 py-3 text-white flex items-center justify-between">
            <span class="font-bold text-xs">TOTAL A PAGAR</span>
            <span class="font-bold text-base">${formatKzNumber(invoice.grandTotal)} Kz</span>
          </div>
        </div>
      </div>

      <div class="mt-4 space-y-3">
        <div class="text-[11px]">
          <span class="font-semibold text-slate-700">Valor por extenso: </span>
          <span class="text-slate-600">${escapeHtml(invoice.amountInWords)}</span>
        </div>

        <div class="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 border border-slate-200/80 text-[11px] tabular-nums">
          <div>
            <div class="text-[10px] text-slate-500">Meio de pagamento</div>
            <div class="font-bold text-slate-900">${escapeHtml(invoice.paymentMethod)}</div>
          </div>
          <div>
            <div class="text-[10px] text-slate-500">Valor recebido</div>
            <div class="font-bold text-slate-900">${formatKzNumber(invoice.amountReceived)} Kz</div>
          </div>
          <div>
            <div class="text-[10px] text-slate-500">Troco</div>
            <div class="font-bold text-slate-900">${formatKzNumber(invoice.changeAmount)} Kz</div>
          </div>
        </div>

        ${
          invoice.notes
            ? `<div class="text-[11px] text-slate-600">
                <span class="font-semibold text-slate-800">Observações: </span>
                ${escapeHtml(invoice.notes)}
              </div>`
            : ''
        }
      </div>

      <div class="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
        <div class="flex items-center gap-3">
          ${
            qrDataUrl
              ? `<img src="${qrDataUrl}" alt="QR Verificação" referrerpolicy="no-referrer" class="h-16 w-16 border border-slate-200 p-0.5" />`
              : ''
          }
          <div class="text-[10.5px] text-slate-600 space-y-0.5">
            <div class="font-bold text-slate-900">OBRIGADO PELA SUA PREFERÊNCIA!</div>
            <div>${escapeHtml(company.legalName)}</div>
            <div class="text-slate-500">Modelo — Sem validade fiscal · Não substitui factura fiscal</div>
          </div>
        </div>
        <div class="text-right text-xs font-semibold text-slate-700">${escapeHtml(company.tagline)}</div>
      </div>
    </div>
  `;
}
