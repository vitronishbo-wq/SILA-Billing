/**
 * SILA-Billing — Motor Tributário Unificado Multimposto (AGT Angola)
 * Em estrita conformidade com o Decreto Executivo n.º 683/25 e Decreto Presidencial n.º 71/25.
 * 
 * Regras Centrais:
 * 1. Arredondamento de taxContribution por excesso ao cêntimo (roundUpToCent).
 * 2. Suporte multimposto: IVA (NOR, INT, RED, ISE, OUT), Imposto do Selo (S01-S07),
 *    Imposto Especial de Consumo (IEC) e Retenções na Fonte (II, IRT, IVA_RET).
 * 3. Separação explícita entre Preço com Imposto Incluído e Preço sem Imposto Incluído.
 * 4. Validação estrita de códigos oficiais de isenção e não sujeição (M10-M24, M30-M38, M80-M86, M90-M93, M00, M02, M04).
 * 5. Consolidação correta de bases e impostos no envelope canónico AgtDocumentTotals.
 */

import { kwanzaToWords } from './extenso.ts';
import {
  AGT_IVA_EXEMPTION_CODES,
  AGT_IVA_TAX_CODES,
  AGT_STAMP_TAX_CODES,
  DEFAULT_AGT_IEC_TABLE,
  type AgtDocumentLineItem,
  type AgtDocumentTotals,
  type AgtIecMetadata,
  type AgtIvaExemptionCode,
  type AgtIvaTaxCode,
  type AgtStampTaxCode,
  type AgtWithholdingTax,
  type AgtWithholdingTaxType,
} from './fiscalTypes.ts';
import type { CartDraftItem, TaxRate } from './types.ts';

/**
 * Arredondamento padrão a 2 casas decimais (meio para cima).
 */
export function roundKz(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.round((val + Number.EPSILON) * 100) / 100;
}

/**
 * Arredondamento por excesso ao cêntimo (Decreto Executivo n.º 683/25).
 * Obrigatório para o campo `taxContribution` na especificação técnica da AGT:
 * Qualquer fracção de cêntimo remanescente é arredondada para cima.
 * Exemplo: 14.1201 Kz -> 14.13 Kz; 14.1200 Kz -> 14.12 Kz
 */
export function roundUpToCent(val: number): number {
  if (!Number.isFinite(val) || val <= 0) return 0;
  // Multiplica por 100 com fixação a 6 decimais para contornar ruído binário do IEEE 754
  const scaled = Number((val * 100).toFixed(6));
  return Math.ceil(scaled) / 100;
}

export interface TaxLineInput {
  lineNumber?: number;
  productCode: string;
  productDescription: string;
  quantity: number;
  unitOfMeasure?: string;
  unitPrice: number;
  unitPriceIncludesTax?: boolean; // Padrão: true (PVP com IVA incluído comum no retalho angolano)
  discountPercentage?: number; // Desconto em percentagem (0 a 100)
  taxCode?: AgtIvaTaxCode; // Padrão: 'NOR' se taxa > 0, ou 'ISE' se taxa === 0
  taxPercentage?: number; // Padrão: 14 para NOR, 0 para ISE
  exemptionCode?: AgtIvaExemptionCode; // Obrigatório se taxa === 0 ou taxCode === 'ISE'
  stampTaxCode?: AgtStampTaxCode; // Opcional (S01 a S07)
  stampTaxRatePct?: number; // Taxa de imposto do selo
  stampTaxFixedAmount?: number; // Valor fixo de imposto do selo (ex: S06 cheques)
  iecCode?: string; // Código de IEC da tabela oficial
  iecRatePct?: number; // Taxa percentual de IEC
}

/**
 * Calcula uma linha de documento fiscal aplicando todas as regras tributárias da AGT.
 */
export function calculateAgtLineItem(input: TaxLineInput): AgtDocumentLineItem {
  const lineNumber = Math.max(1, Math.floor(input.lineNumber || 1));
  const productCode = String(input.productCode || 'PROD').trim();
  const productDescription = String(input.productDescription || 'Artigo').trim();
  const quantity = Math.max(0.001, roundKz(Number(input.quantity) || 1));
  const unitOfMeasure = String(input.unitOfMeasure || 'un').trim();
  const rawUnitPrice = Math.max(0, roundKz(Number(input.unitPrice) || 0));
  const unitPriceIncludesTax = input.unitPriceIncludesTax !== false; // Padrão é true
  const discountPct = Math.min(100, Math.max(0, roundKz(Number(input.discountPercentage) || 0)));

  // Determinação do Código e Taxa de IVA
  let taxCode: AgtIvaTaxCode = input.taxCode || (input.taxPercentage === 0 ? 'ISE' : 'NOR');
  let taxPercentage =
    typeof input.taxPercentage === 'number'
      ? Math.max(0, roundKz(input.taxPercentage))
      : AGT_IVA_TAX_CODES[taxCode]?.standardPercentage ?? 14;

  // Sincronização entre taxCode e taxPercentage
  if (taxPercentage === 0 && taxCode !== 'ISE' && taxCode !== 'OUT') {
    taxCode = 'ISE';
  } else if (taxPercentage === 14 && taxCode !== 'NOR') {
    taxCode = 'NOR';
  } else if (taxPercentage === 5 && taxCode !== 'RED' && taxCode !== 'INT') {
    taxCode = 'RED';
  } else if ((taxPercentage === 7 || taxPercentage === 1) && taxCode !== 'INT') {
    taxCode = 'INT';
  }

  // Desconto e Preço Bruto
  const lineGross = roundKz(quantity * rawUnitPrice);
  const discountAmount = roundKz(lineGross * (discountPct / 100));
  const lineAfterDiscount = Math.max(0, roundKz(lineGross - discountAmount));

  let taxableBase = 0;
  let taxContribution = 0;

  if (taxPercentage === 0 || taxCode === 'ISE') {
    // Isento de IVA: Base é o valor líquido comercial
    taxableBase = lineAfterDiscount;
    taxContribution = 0;
  } else if (unitPriceIncludesTax) {
    // PVP Com IVA incluído: Desconectar imposto para obter base
    const divisor = 1 + taxPercentage / 100;
    taxableBase = roundKz(lineAfterDiscount / divisor);
    // Arredondamento por excesso ao cêntimo exigido pelo Decreto Executivo 683/25
    taxContribution = roundUpToCent(taxableBase * (taxPercentage / 100));
  } else {
    // PVP Sem IVA: Base é o valor comercial da linha
    taxableBase = lineAfterDiscount;
    // Arredondamento por excesso ao cêntimo
    taxContribution = roundUpToCent(taxableBase * (taxPercentage / 100));
  }

  // Cálculo de Imposto do Selo (IS)
  let stampTaxCode: AgtStampTaxCode | undefined = input.stampTaxCode;
  let stampTaxAmount = 0;
  if (stampTaxCode) {
    const meta = AGT_STAMP_TAX_CODES[stampTaxCode];
    if (typeof input.stampTaxFixedAmount === 'number' && input.stampTaxFixedAmount > 0) {
      stampTaxAmount = roundKz(input.stampTaxFixedAmount);
    } else {
      const stampPct =
        typeof input.stampTaxRatePct === 'number'
          ? input.stampTaxRatePct
          : meta?.defaultRatePct || 0;
      if (stampPct > 0) {
        stampTaxAmount = roundUpToCent(taxableBase * (stampPct / 100));
      }
    }
  }

  // Cálculo de Imposto Especial de Consumo (IEC)
  let iecCode: string | undefined = input.iecCode;
  let iecAmount = 0;
  if (iecCode) {
    const iecMeta: AgtIecMetadata | undefined = DEFAULT_AGT_IEC_TABLE[iecCode];
    const iecPct =
      typeof input.iecRatePct === 'number'
        ? input.iecRatePct
        : iecMeta?.ratePct || 0;
    if (iecPct > 0) {
      iecAmount = roundUpToCent(taxableBase * (iecPct / 100));
    }
  }

  // Valor Total da Linha (Base + IVA + Selo + IEC)
  const lineTotal = roundKz(taxableBase + taxContribution + stampTaxAmount + iecAmount);

  // Validação e atribuição de código de isenção
  let exemptionCode: AgtIvaExemptionCode | undefined = input.exemptionCode;
  if ((taxCode === 'ISE' || taxPercentage === 0) && !exemptionCode) {
    // Atribuição de padrão legal seguro caso não especificado (M80 - Regime de Exclusão do CIVA)
    exemptionCode = 'M80';
  }

  return {
    lineNumber,
    productCode,
    productDescription,
    quantity,
    unitOfMeasure,
    unitPrice: rawUnitPrice,
    unitPriceIncludesTax,
    discountPercentage: discountPct,
    discountAmount,
    taxableBase,
    taxContribution,
    taxCode,
    taxPercentage,
    exemptionCode,
    stampTaxCode,
    stampTaxAmount: stampTaxAmount > 0 ? stampTaxAmount : undefined,
    iecCode,
    iecAmount: iecAmount > 0 ? iecAmount : undefined,
    lineTotal,
  };
}

export interface WithholdingTaxInput {
  type: AgtWithholdingTaxType;
  ratePct?: number; // Padrão: 6.5% para II, 10.5% para IRT, 50% ou 100% para IVA_RET
  baseAmount?: number; // Se não informado, aplica sobre a base tributável total
  reason?: string;
}

/**
 * Consolida os totais do documento fiscal AGT a partir das suas linhas e retenções.
 */
export function calculateAgtDocumentTotals(
  lines: ReadonlyArray<AgtDocumentLineItem>,
  options?: {
    globalDiscountPct?: number;
    withholdingTaxes?: ReadonlyArray<WithholdingTaxInput>;
  }
): {
  totals: AgtDocumentTotals;
  withholdingTaxList: AgtWithholdingTax[];
} {
  const globalPct = Math.min(100, Math.max(0, roundKz(Number(options?.globalDiscountPct) || 0)));
  const globalFactor = globalPct > 0 ? 1 - globalPct / 100 : 1;

  let merchandiseTotalNet = 0;
  let totalDiscounts = 0;
  let totalTaxBaseNOR = 0;
  let totalTaxAmountNOR = 0;
  let totalTaxBaseINT = 0;
  let totalTaxAmountINT = 0;
  let totalTaxBaseRED = 0;
  let totalTaxAmountRED = 0;
  let totalTaxBaseISE = 0;
  let totalStampTax = 0;
  let totalIecTax = 0;

  for (const line of lines) {
    totalDiscounts = roundKz(totalDiscounts + line.discountAmount);
    merchandiseTotalNet = roundKz(merchandiseTotalNet + line.taxableBase);

    if (line.stampTaxAmount) {
      totalStampTax = roundKz(totalStampTax + line.stampTaxAmount);
    }
    if (line.iecAmount) {
      totalIecTax = roundKz(totalIecTax + line.iecAmount);
    }

    if (line.taxCode === 'NOR') {
      totalTaxBaseNOR = roundKz(totalTaxBaseNOR + line.taxableBase);
      totalTaxAmountNOR = roundKz(totalTaxAmountNOR + line.taxContribution);
    } else if (line.taxCode === 'INT') {
      totalTaxBaseINT = roundKz(totalTaxBaseINT + line.taxableBase);
      totalTaxAmountINT = roundKz(totalTaxAmountINT + line.taxContribution);
    } else if (line.taxCode === 'RED') {
      totalTaxBaseRED = roundKz(totalTaxBaseRED + line.taxableBase);
      totalTaxAmountRED = roundKz(totalTaxAmountRED + line.taxContribution);
    } else {
      // ISE ou OUT com 0%
      totalTaxBaseISE = roundKz(totalTaxBaseISE + line.taxableBase);
    }
  }

  // Aplicação do desconto financeiro global (se houver) proporcionalmente mantendo a taxa efectiva de cada linha
  if (globalPct > 0) {
    const globalDiscountAmount = roundKz(merchandiseTotalNet * (globalPct / 100));
    totalDiscounts = roundKz(totalDiscounts + globalDiscountAmount);
    merchandiseTotalNet = roundKz(merchandiseTotalNet * globalFactor);

    totalTaxBaseNOR = roundKz(totalTaxBaseNOR * globalFactor);
    totalTaxAmountNOR = roundUpToCent(totalTaxBaseNOR * 0.14);

    totalTaxBaseINT = 0;
    totalTaxAmountINT = 0;
    totalTaxBaseRED = 0;
    totalTaxAmountRED = 0;
    for (const line of lines) {
      const discountedBase = roundKz(line.taxableBase * globalFactor);
      if (line.taxCode === 'INT') {
        totalTaxBaseINT = roundKz(totalTaxBaseINT + discountedBase);
        totalTaxAmountINT = roundKz(
          totalTaxAmountINT + roundUpToCent(discountedBase * (line.taxPercentage / 100))
        );
      } else if (line.taxCode === 'RED') {
        totalTaxBaseRED = roundKz(totalTaxBaseRED + discountedBase);
        totalTaxAmountRED = roundKz(
          totalTaxAmountRED + roundUpToCent(discountedBase * (line.taxPercentage / 100))
        );
      }
    }

    totalTaxBaseISE = roundKz(totalTaxBaseISE * globalFactor);
    totalStampTax = roundKz(totalStampTax * globalFactor);
    totalIecTax = roundKz(totalIecTax * globalFactor);
  }

  const totalIva = roundKz(totalTaxAmountNOR + totalTaxAmountINT + totalTaxAmountRED);
  const grossTotal = roundKz(merchandiseTotalNet + totalIva + totalStampTax + totalIecTax);

  // Cálculo das Retenções na Fonte
  const withholdingTaxList: AgtWithholdingTax[] = [];
  let totalWithholdingTax = 0;

  if (Array.isArray(options?.withholdingTaxes) && options!.withholdingTaxes.length > 0) {
    for (const wInput of options!.withholdingTaxes) {
      let defaultRate = 6.5;
      if (wInput.type === 'IRT') defaultRate = 10.5;
      if (wInput.type === 'IVA_RET') defaultRate = 50;

      const ratePct = typeof wInput.ratePct === 'number' ? wInput.ratePct : defaultRate;
      const baseAmount =
        typeof wInput.baseAmount === 'number' && wInput.baseAmount > 0
          ? roundKz(wInput.baseAmount)
          : wInput.type === 'IVA_RET'
            ? totalIva
            : merchandiseTotalNet;

      const withheldAmount = roundUpToCent(baseAmount * (ratePct / 100));
      totalWithholdingTax = roundKz(totalWithholdingTax + withheldAmount);

      withholdingTaxList.push({
        type: wInput.type,
        ratePct,
        baseAmount,
        withheldAmount,
        reason: wInput.reason,
      });
    }
  }

  const netPayableTotal = Math.max(0, roundKz(grossTotal - totalWithholdingTax));

  const totals: AgtDocumentTotals = {
    merchandiseTotalNet,
    totalDiscounts,
    totalTaxBaseNOR,
    totalTaxAmountNOR,
    totalTaxBaseINT,
    totalTaxAmountINT,
    totalTaxBaseRED,
    totalTaxAmountRED,
    totalTaxBaseISE,
    totalStampTax,
    totalIecTax,
    totalWithholdingTax,
    grossTotal,
    netPayableTotal,
    amountInWords: kwanzaToWords(netPayableTotal),
  };

  return { totals, withholdingTaxList };
}

/**
 * Validador estrito de conformidade fiscal AGT (Decreto Executivo 683/25).
 * Detecta incongruências antes da assinatura digital ou submissão.
 */
export function validateAgtTaxCompliance(lines: ReadonlyArray<AgtDocumentLineItem>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!lines || lines.length === 0) {
    errors.push('O documento fiscal deve conter pelo menos uma linha de artigo/serviço.');
    return { valid: false, errors };
  }

  lines.forEach((line, index) => {
    const lineLabel = `Linha ${line.lineNumber || index + 1} (${line.productCode || 'S/N'})`;

    if (line.quantity <= 0) {
      errors.push(`${lineLabel}: Quantidade deve ser estritamente superior a zero.`);
    }

    if (line.unitPrice < 0) {
      errors.push(`${lineLabel}: Preço unitário não pode ser negativo.`);
    }

    if (line.discountPercentage < 0 || line.discountPercentage > 100) {
      errors.push(`${lineLabel}: Desconto deve estar compreendido entre 0% e 100%.`);
    }

    // Regra da AGT: Isenção de IVA (0% ou taxa ISE) exige obrigatoriamente código oficial
    if (line.taxPercentage === 0 || line.taxCode === 'ISE') {
      if (!line.exemptionCode) {
        errors.push(
          `${lineLabel}: Artigo isento de IVA requer obrigatoriamente a indicação de um código de isenção oficial (ex: M10, M80, M12).`
        );
      } else if (!AGT_IVA_EXEMPTION_CODES[line.exemptionCode]) {
        errors.push(
          `${lineLabel}: Código de isenção '${line.exemptionCode}' não consta da tabela oficial da AGT (Decreto 683/25).`
        );
      }
    }

    // Regra da AGT: Artigos tributados (NOR, INT, RED) não podem ter código de isenção
    if (line.taxPercentage > 0 && line.taxCode !== 'ISE') {
      if (line.exemptionCode) {
        errors.push(
          `${lineLabel}: Artigo tributado a ${line.taxPercentage}% não pode ter código de isenção associado.`
        );
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Converte a lista de itens de carrinho legado (CartDraftItem)
 * para a estrutura canónica AGT (AgtDocumentLineItem[]).
 */
export function convertCartItemsToAgtLines(
  cartItems: ReadonlyArray<CartDraftItem>,
  defaultExemptionCode: AgtIvaExemptionCode = 'M80'
): AgtDocumentLineItem[] {
  return cartItems.map((item, idx) => {
    const rate = Number(item.ivaRate) || 0;
    let taxCode: AgtIvaTaxCode = 'NOR';
    if (rate === 0) taxCode = 'ISE';
    else if (rate === 5) taxCode = 'RED';
    else if (rate === 1 || rate === 7) taxCode = 'INT';
    else taxCode = 'NOR';

    const exemptionCode =
      rate === 0 ? item.exemptionCode || defaultExemptionCode : undefined;

    return calculateAgtLineItem({
      lineNumber: idx + 1,
      productCode: item.code || `P${idx + 1}`,
      productDescription: item.description,
      quantity: item.qty,
      unitOfMeasure: item.unit || 'un',
      unitPrice: item.unitPrice,
      unitPriceIncludesTax: true, // No POS retalhista da JAIMONA/SILA os preços de prateleira incluem IVA
      discountPercentage: item.discountPct,
      taxCode,
      taxPercentage: rate,
      exemptionCode,
    });
  });
}
