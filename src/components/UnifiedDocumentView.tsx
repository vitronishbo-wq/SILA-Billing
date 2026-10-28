import QRCode from 'qrcode';
import React, { useEffect, useState } from 'react';
import { formatDateTimePt, formatKzNumber } from '../core/billingEngine';
import { CompanyProfile, DocumentFormat, InvoiceRecord, JAIMONA_COMPANY } from '../core/types';

interface UnifiedDocumentViewProps {
  invoice: InvoiceRecord;
  format: DocumentFormat;
  company?: CompanyProfile;
}

export const UnifiedDocumentView: React.FC<UnifiedDocumentViewProps> = ({
  invoice,
  format,
  company = JAIMONA_COMPANY,
}) => {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const dt = formatDateTimePt(invoice.issuedAtIso);

  useEffect(() => {
    const qrPayload = [
      `EMISSOR:${company.legalName}`,
      `NIF:${company.nif}`,
      `DOC:${invoice.number}`,
      `DATA:${dt.date} ${dt.time}`,
      `TOTAL:${invoice.grandTotal.toFixed(2)} AOA`,
    ].join('|');

    QRCode.toDataURL(qrPayload, {
      width: 140,
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then((url) => setQrDataUrl(url))
      .catch(() => setQrDataUrl(''));
  }, [company.legalName, company.nif, invoice.number, invoice.grandTotal, dt.date, dt.time]);

  if (format === 'POS') {
    return (
      <div className="print-target mx-auto w-full max-w-[330px] bg-white p-4 text-[12px] leading-snug text-black font-sans border border-slate-200">
        {/* Cabeçalho Fiscal Térmico */}
        <div className="text-center space-y-0.5">
          <div className="font-bold text-[11px] tracking-tight">MODELO — SEM VALIDADE FISCAL</div>
          <div className="font-bold text-[13px] leading-tight">{company.legalName}</div>
          <div className="text-[11px]">{company.address}</div>
          <div className="text-[11px]">Tel.: {company.phone}</div>
          <div className="text-[11px]">{company.email}</div>
          <div className="text-[11px]">Contribuinte: {company.nif}</div>
        </div>

        {/* QR Code Centralizado */}
        {qrDataUrl && (
          <div className="my-2.5 flex justify-center">
            <div className="relative inline-block">
              <img
                src={qrDataUrl}
                alt="QR Fatura"
                referrerPolicy="no-referrer"
                className="h-24 w-24 object-contain"
              />
            </div>
          </div>
        )}

        {/* Título Documento */}
        <div className="border-y border-black py-1.5 text-center my-2">
          <div className="font-bold text-[13px] tabular-nums">
            {invoice.docType === 'FP' ? 'FACTURA PROFORMA' : 'FACTURA / RECIBO'} N.º {invoice.number}
          </div>
          <div className="text-[11px]">Venda Directa a Retalho</div>
          {invoice.status === 'cancelled' && (
            <div className="mt-0.5 font-bold text-red-700 text-[11px]">DOCUMENTO ANULADO</div>
          )}
        </div>

        {/* Metadados Operacionais */}
        <div className="space-y-0.5 text-[11px] pb-2 border-b border-black">
          <div className="font-bold tabular-nums">
            Data: {dt.date} &nbsp; {dt.time}
          </div>
          <div className="flex justify-between tabular-nums">
            <span>Caixa: {invoice.cashier}</span>
            <span>Operador(a): {invoice.operator}</span>
          </div>
          <div>Pagamento: {invoice.paymentMethod}</div>
          <div>Cliente: {invoice.customerName}</div>
          {invoice.customerNif && invoice.customerNif !== 'Consumidor Final' && (
            <div className="tabular-nums">NIF Cliente: {invoice.customerNif}</div>
          )}
          <div>Localidade: {invoice.customerLocality || 'Saurimo - Angola'}</div>
        </div>

        {/* Lista de Artigos */}
        <div className="py-2 border-b border-dashed border-black">
          <div className="font-bold text-[12px] mb-1">ARTIGOS</div>
          <div className="space-y-1.5">
            {invoice.lines.map((line) => (
              <div key={line.id} className="text-[11.5px]">
                <div className="font-bold leading-tight">{line.description}</div>
                <div className="flex justify-between tabular-nums pl-1.5">
                  <span>
                    {Number.isInteger(line.qty) ? line.qty : formatKzNumber(line.qty)} x{' '}
                    {formatKzNumber(line.unitPrice)}
                    {line.discountPct > 0 ? ` (-${line.discountPct}%)` : ''}
                  </span>
                  <span>{formatKzNumber(line.lineTotal)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Resumo de Impostos */}
        <div className="py-2 border-b border-black text-[11px] space-y-1">
          <div className="font-bold text-[12px]">RESUMO DE IMPOSTOS</div>
          <div className="tabular-nums">
            IVA 14% — Base: {formatKzNumber(invoice.taxBase14)} — IVA:{' '}
            {formatKzNumber(invoice.taxAmount14)}
          </div>
          <div className="tabular-nums">
            IVA 0% — Base: {formatKzNumber(invoice.taxBase0)} — IVA: 0,00
          </div>

          <div className="pt-1 space-y-0.5 tabular-nums">
            <div className="flex justify-between">
              <span>Total de mercadorias</span>
              <span className="font-bold">{formatKzNumber(invoice.merchandiseTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Desconto comercial</span>
              <span>{formatKzNumber(invoice.discountTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span>Total de impostos</span>
              <span>{formatKzNumber(invoice.taxTotal)}</span>
            </div>
          </div>
        </div>

        {/* Total a Pagar */}
        <div className="py-2 border-b border-dashed border-black">
          <div className="font-bold text-[13px]">TOTAL A PAGAR</div>
          <div className="text-right font-bold text-[16px] tabular-nums">
            {formatKzNumber(invoice.grandTotal)} Kz
          </div>
          <div className="mt-1.5 text-[10.5px] font-bold leading-snug">
            Por extenso: {invoice.amountInWords}
          </div>
        </div>

        {/* Pagamento e Troco */}
        <div className="py-2 border-b border-black text-[11px] space-y-0.5 tabular-nums">
          <div className="font-bold">Meio de pagamento: {invoice.paymentMethod}</div>
          <div>Valor recebido: {formatKzNumber(invoice.amountReceived)} Kz</div>
          <div>Troco: {formatKzNumber(invoice.changeAmount)} Kz</div>
        </div>

        {/* Observações */}
        {invoice.notes && (
          <div className="py-2 border-b border-dashed border-black text-[11px]">
            <div className="font-bold">Observações</div>
            <div>{invoice.notes}</div>
          </div>
        )}

        {/* Rodapé */}
        <div className="pt-2.5 text-center space-y-1">
          <div className="font-bold text-[11.5px]">OBRIGADO PELA SUA PREFERÊNCIA!</div>
          <div className="text-[11px]">{company.tagline}</div>
          <div className="border-t border-black mt-2 pt-1.5 text-[10px] space-y-0.5">
            <div className="font-bold">Documento de demonstração</div>
            <div className="tabular-nums">
              NIF: {company.nif} | Caixa: {invoice.cashier}
            </div>
            <div>Não substitui factura fiscal</div>
          </div>
        </div>
      </div>
    );
  }

  // Formato A4 Comercial (Reutilizando os mesmos dados e motor de cálculo)
  return (
    <div className="print-target mx-auto w-full max-w-[794px] bg-white p-6 sm:p-8 text-slate-900 border border-slate-200 text-xs">
      {/* Cabeçalho A4 JAIMONA */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-3.5">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 border-blue-600 bg-slate-900 text-white font-bold text-lg tracking-tight">
            JM
          </div>
          <div>
            <div className="text-base font-bold tracking-tight text-slate-900">
              {company.shortName}
            </div>
            <div className="text-[11px] font-medium text-slate-600">
              {company.legalName}
            </div>
            <div className="text-[10px] text-blue-700 mt-0.5">
              Qualidade · Confiança · Soluções
            </div>
          </div>
        </div>

        <div className="text-[11px] text-slate-600 space-y-0.5 sm:text-right tabular-nums">
          <div>{company.address}</div>
          <div>Tel.: {company.phone}</div>
          <div>{company.email}</div>
          <div className="font-semibold text-slate-900">Contribuinte: {company.nif}</div>
        </div>
      </div>

      {/* Identificação do Documento & Cliente */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 py-5">
        <div className="sm:col-span-7 space-y-3">
          <div>
            <div className="text-lg font-bold text-blue-700 tracking-tight">
              {invoice.docType === 'FP' ? 'FACTURA PROFORMA' : 'FACTURA / RECIBO'}
            </div>
            <div className="text-sm font-semibold text-slate-800 tabular-nums">
              N.º {invoice.number}
            </div>
            {invoice.status === 'cancelled' && (
              <div className="mt-1 text-xs font-bold text-red-600">DOCUMENTO ANULADO</div>
            )}
          </div>

          <div className="rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 space-y-0.5">
            <div className="text-[10px] font-semibold text-blue-700">Cliente</div>
            <div className="text-[11px] text-slate-500">Exmo.(s) Sr.(s)</div>
            <div className="text-xs font-bold text-slate-900">{invoice.customerName}</div>
            {invoice.customerNif && (
              <div className="text-[11px] text-slate-600 tabular-nums">
                NIF: {invoice.customerNif}
              </div>
            )}
            <div className="text-[11px] text-slate-600">
              {invoice.customerLocality || 'Saurimo - Angola'}
            </div>
          </div>
        </div>

        <div className="sm:col-span-5 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80 flex flex-col justify-between space-y-2 tabular-nums">
          <div>
            <div className="text-[10px] text-slate-500">Data de emissão</div>
            <div className="font-semibold text-slate-900">
              {dt.slashDate} &nbsp; {dt.time}
            </div>
          </div>
          <div className="flex justify-between">
            <div>
              <div className="text-[10px] text-slate-500">Operador(a)</div>
              <div className="font-semibold text-slate-900">{invoice.operator}</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-500">Caixa</div>
              <div className="font-semibold text-slate-900">{invoice.cashier}</div>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">Modo de pagamento</div>
            <div className="font-semibold text-slate-900">{invoice.paymentMethod}</div>
          </div>
        </div>
      </div>

      {/* Tabela de Artigos A4 */}
      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-900 text-white text-[10.5px]">
              <th className="py-2 px-2.5 font-semibold">Código</th>
              <th className="py-2 px-2.5 font-semibold">Descrição</th>
              <th className="py-2 px-2.5 font-semibold text-right">Qtd.</th>
              <th className="py-2 px-2.5 font-semibold text-right">Preço Unit.</th>
              <th className="py-2 px-2.5 font-semibold text-right">IVA %</th>
              <th className="py-2 px-2.5 font-semibold text-right">Desc. %</th>
              <th className="py-2 px-2.5 font-semibold text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 text-[11px] tabular-nums">
            {invoice.lines.map((line) => (
              <tr key={line.id}>
                <td className="py-2 px-2.5 font-mono text-slate-600">{line.code}</td>
                <td className="py-2 px-2.5 font-medium text-slate-900">{line.description}</td>
                <td className="py-2 px-2.5 text-right">{formatKzNumber(line.qty)}</td>
                <td className="py-2 px-2.5 text-right">{formatKzNumber(line.unitPrice)}</td>
                <td className="py-2 px-2.5 text-right">{formatKzNumber(line.ivaRate)}</td>
                <td className="py-2 px-2.5 text-right">{formatKzNumber(line.discountPct)}</td>
                <td className="py-2 px-2.5 text-right font-semibold text-slate-900">
                  {formatKzNumber(line.lineTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Resumo de Impostos e Totais */}
      <div className="grid grid-cols-1 sm:grid-cols-12 gap-4 mt-5">
        <div className="sm:col-span-6 rounded-lg bg-slate-50 p-3.5 border border-slate-200/80">
          <div className="text-[11px] font-bold text-slate-900 mb-2">Resumo de Impostos</div>
          <table className="w-full text-[11px] tabular-nums">
            <thead>
              <tr className="text-slate-500 border-b border-slate-200">
                <th className="pb-1 text-left font-medium">IVA %</th>
                <th className="pb-1 text-right font-medium">Base de Cálculo</th>
                <th className="pb-1 text-right font-medium">Valor de IVA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/70">
              <tr>
                <td className="py-1.5">14,00%</td>
                <td className="py-1.5 text-right">{formatKzNumber(invoice.taxBase14)}</td>
                <td className="py-1.5 text-right">{formatKzNumber(invoice.taxAmount14)}</td>
              </tr>
              <tr>
                <td className="py-1.5">0,00%</td>
                <td className="py-1.5 text-right">{formatKzNumber(invoice.taxBase0)}</td>
                <td className="py-1.5 text-right">0,00</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div className="sm:col-span-6 flex flex-col justify-between rounded-lg bg-slate-50 border border-slate-200/80 overflow-hidden tabular-nums">
          <div className="p-3.5 space-y-1.5 text-[11px]">
            <div className="flex justify-between">
              <span className="text-slate-600">Total de mercadorias</span>
              <span className="font-semibold text-slate-900">
                {formatKzNumber(invoice.merchandiseTotal)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Desconto comercial</span>
              <span className="font-semibold text-slate-900">
                {formatKzNumber(invoice.discountTotal)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Total de impostos</span>
              <span className="font-semibold text-slate-900">
                {formatKzNumber(invoice.taxTotal)}
              </span>
            </div>
          </div>
          <div className="bg-blue-600 px-4 py-3 text-white flex items-center justify-between">
            <span className="font-bold text-xs">TOTAL A PAGAR</span>
            <span className="font-bold text-base">{formatKzNumber(invoice.grandTotal)} Kz</span>
          </div>
        </div>
      </div>

      {/* Extenso & Pagamento */}
      <div className="mt-4 space-y-3">
        <div className="text-[11px]">
          <span className="font-semibold text-slate-700">Valor por extenso: </span>
          <span className="text-slate-600">{invoice.amountInWords}</span>
        </div>

        <div className="grid grid-cols-3 gap-3 rounded-lg bg-slate-50 p-3 border border-slate-200/80 text-[11px] tabular-nums">
          <div>
            <div className="text-[10px] text-slate-500">Meio de pagamento</div>
            <div className="font-bold text-slate-900">{invoice.paymentMethod}</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">Valor recebido</div>
            <div className="font-bold text-slate-900">{formatKzNumber(invoice.amountReceived)} Kz</div>
          </div>
          <div>
            <div className="text-[10px] text-slate-500">Troco</div>
            <div className="font-bold text-slate-900">{formatKzNumber(invoice.changeAmount)} Kz</div>
          </div>
        </div>

        {invoice.notes && (
          <div className="text-[11px] text-slate-600">
            <span className="font-semibold text-slate-800">Observações: </span>
            {invoice.notes}
          </div>
        )}
      </div>

      {/* Rodapé A4 com QR */}
      <div className="mt-6 pt-4 border-t border-slate-200 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="QR Verificação"
              referrerPolicy="no-referrer"
              className="h-16 w-16 border border-slate-200 p-0.5"
            />
          )}
          <div className="text-[10.5px] text-slate-600 space-y-0.5">
            <div className="font-bold text-slate-900">OBRIGADO PELA SUA PREFERÊNCIA!</div>
            <div>{company.legalName}</div>
            <div className="text-slate-500">
              Modelo — Sem validade fiscal · Não substitui factura fiscal
            </div>
          </div>
        </div>
        <div className="text-right text-xs font-semibold text-slate-700">
          {company.tagline}
        </div>
      </div>
    </div>
  );
};
