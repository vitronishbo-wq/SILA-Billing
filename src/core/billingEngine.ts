import { kwanzaToWords } from './extenso.ts';
import type { CalculatedLineItem, CartDraftItem, InvoiceTotals } from './types.ts';

export function roundKz(val: number): number {
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Formata valores monetários no padrão angolano: 7.802,40
 */
export function formatKzNumber(val: number): string {
  const fixed = roundKz(val).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withDots = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${withDots},${decPart}`;
}

export function formatKz(val: number): string {
  return `${formatKzNumber(val)} Kz`;
}

export function formatDateTimePt(iso: string): { date: string; time: string; slashDate: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { date: '2026-10-27', time: '00:00', slashDate: '27/10/2026' };
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: `${hh}:${min}`,
    slashDate: `${dd}/${mm}/${yyyy}`,
  };
}

/**
 * Motor unificado de cálculo fiscal (IVA Angolano 14% ou Isento 0%).
 * Segue rigorosamente o modelo JAIMONA-COMÉRCIO E SERVIÇOS:
 * - Cada linha apresenta Total Bruto da Linha = Qtd × Preço Unit. (ex: 2×700 = 1.400,00)
 * - Para artigos sujeitos a IVA 14%, extrai-se a Base Tributável (Líquido / 1,14) e aplica-se 14% de IVA
 *   (ex: 5.350,00 / 1,14 ≈ 4.695,65 Base; IVA 14% ≈ 657,40)
 * - Para artigos Isentos (0%), Base 0% = valor líquido da linha, IVA = 0,00
 * - Total de mercadorias + Total de impostos - Desconto comercial = TOTAL A PAGAR em Kwanzas (Kz)
 */
export function calculateInvoiceTotals(draftItems: CartDraftItem[]): InvoiceTotals {
  const lines: CalculatedLineItem[] = draftItems.map((item, idx) => {
    const qty = Math.max(0.01, roundKz(item.qty));
    const unitPrice = Math.max(0, roundKz(item.unitPrice));
    const discountPct = Math.min(100, Math.max(0, roundKz(item.discountPct || 0)));

    const lineGross = roundKz(qty * unitPrice);
    const lineDiscount = roundKz(lineGross * (discountPct / 100));
    const afterDiscount = roundKz(lineGross - lineDiscount);

    // Base de cálculo para resumo de impostos (extração de IVA 14% sobre PVP comercial)
    const lineBase = item.ivaRate === 14 ? roundKz(afterDiscount / 1.14) : afterDiscount;
    const lineTax = item.ivaRate === 14 ? roundKz(lineBase * 0.14) : 0;
    const lineNet = afterDiscount;

    return {
      ...item,
      id: `item_${idx + 1}_${item.productId.replace(/[^a-zA-Z0-9_-]/g, '')}`.slice(0, 64),
      qty,
      unitPrice,
      discountPct,
      lineGross,
      lineDiscount,
      lineBase,
      lineTax,
      lineNet,
      lineTotal: afterDiscount,
    };
  });

  const grossItemsTotal = roundKz(lines.reduce((acc, l) => acc + l.lineGross, 0));
  const discountTotal = roundKz(lines.reduce((acc, l) => acc + l.lineDiscount, 0));

  const net14Sum = roundKz(
    lines.filter((l) => l.ivaRate === 14).reduce((acc, l) => acc + l.lineNet, 0)
  );
  const taxBase14 = net14Sum > 0 ? roundKz(net14Sum / 1.14) : 0;
  const taxAmount14 = taxBase14 > 0 ? roundKz(taxBase14 * 0.14) : 0;

  const taxBase0 = roundKz(
    lines.filter((l) => l.ivaRate === 0).reduce((acc, l) => acc + l.lineNet, 0)
  );
  const taxAmount0 = 0;

  const merchandiseTotal = roundKz(grossItemsTotal - discountTotal);
  const taxTotal = taxAmount14;
  const grandTotal = roundKz(merchandiseTotal + taxTotal);

  return {
    lines,
    merchandiseTotal,
    grossItemsTotal,
    discountTotal,
    taxBase14,
    taxAmount14,
    taxBase0,
    taxAmount0,
    taxTotal,
    grandTotal,
    amountInWords: kwanzaToWords(grandTotal),
  };
}

export function generateNextInvoiceNumber(existingNumbers: string[], docType: 'FR' | 'FP'): string {
  const year = new Date().getFullYear();
  const prefix = docType === 'FP' ? `FP ${year}/` : `FV ${year}/`;
  let maxSeq = 15678;

  for (const num of existingNumbers) {
    const match = num.match(/\/(\d+)$/);
    if (match) {
      const parsed = parseInt(match[1], 10);
      if (!Number.isNaN(parsed) && parsed > maxSeq) {
        maxSeq = parsed;
      }
    }
  }

  const nextSeq = String(maxSeq + 1).padStart(6, '0');
  return `${prefix}${nextSeq}`;
}
