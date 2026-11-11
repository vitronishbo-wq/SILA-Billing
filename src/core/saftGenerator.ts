/**
 * SILA-Billing — Gerador Oficial do Ficheiro SAF-T (AO) XML
 * 
 * Em estrita conformidade com:
 * 1. Decreto Executivo n.º 312/18 (Regulamento do Ficheiro de Auditoria Tributária SAF-T AO)
 * 2. Esquema XSD Oficial da AGT (Versão 1.01_01 - urn:OECD:StandardAuditFile-Tax:AO_1.01_01)
 * 3. Decreto Executivo n.º 683/25 e RGFA (Regime Geral das Facturas e Documentos Equivalentes)
 * 4. Decreto Presidencial n.º 71/25 (Pauta Aduaneira e Harmonização das Taxas do IVA)
 * 5. Portaria n.º 321-A/2013 (Algoritmo de Assinatura RSA-SHA1 em Chave de 1024-bits)
 */

import {
  AGT_IVA_EXEMPTION_CODES,
  type AgtIvaExemptionCode,
} from './fiscalTypes.ts';
import {
  buildSaftCanonicalString,
  signSaftDocumentHash,
  verifySaftDocumentHash,
  DEFAULT_SAFT_PUBLIC_KEY,
} from './saftCrypto.ts';
import {
  VITRONIS_INSTITUTIONAL,
  type CompanyProfile,
  type Customer,
  type InvoiceRecord,
  type PaymentMethod,
  type Product,
  type Supplier,
} from './types.ts';

export interface SaftExportOptions {
  fiscalYear?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  periodMonth?: number; // 1 a 12
  productCompanyTaxId?: string; // NIF do Produtor do Software (VITRONIS: 5002571293)
  softwareCertificateNumber?: string; // Número de Validação/Certificação AGT (ex: 000/AGT/2026)
  productId?: string;
  productVersion?: string;
  headerComment?: string;
  privateKeyPem?: string; // Chave privada RSA opcional específica da empresa
}

export interface SaftValidationIssue {
  level: 'error' | 'warning';
  message: string;
  invoiceNumber?: string;
}

export interface SaftValidationResult {
  valid: boolean;
  issues: SaftValidationIssue[];
  totalInvoices: number;
  totalProformas: number;
  totalCredit: number;
  totalDebit: number;
  taxAuditDifference: number;
  submissionDeadline: string; // Ex.: "15 de Fevereiro de 2026"
  seriesContinuityAudit: Array<{
    series: string;
    docType: string;
    missingNumbers: number[];
    isContinuous: boolean;
  }>;
}

export interface SaftExportResult {
  xml: string;
  filename: string;
  summary: {
    fiscalYear: number;
    period: number;
    startDate: string;
    endDate: string;
    submissionDeadline: string;
    totalSalesInvoices: number;
    totalWorkingDocuments: number;
    totalCredit: number;
    totalDebit: number;
    customersCount: number;
    suppliersCount: number;
    productsCount: number;
    issuerTaxId: string;
    producerTaxId: string;
  };
  validation: SaftValidationResult;
}

export function escapeXml(raw: unknown): string {
  return String(raw ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Converte data ISO para formato estrito SAF-T (AO) Date: YYYY-MM-DD
 */
export function formatSaftDate(isoOrDate: string): string {
  if (!isoOrDate) return new Date().toISOString().slice(0, 10);
  try {
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return isoOrDate.slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return isoOrDate.slice(0, 10);
  }
}

/**
 * Converte data ISO para formato estrito SAF-T (AO) DateTime: YYYY-MM-DDTHH:MM:SS
 */
export function formatSaftDateTime(isoOrDate: string): string {
  if (!isoOrDate) return new Date().toISOString().slice(0, 19);
  try {
    const d = new Date(isoOrDate);
    if (isNaN(d.getTime())) return isoOrDate.slice(0, 19);
    return d.toISOString().slice(0, 19);
  } catch {
    return isoOrDate.slice(0, 19);
  }
}

/**
 * Mapeia métodos de pagamento SILA para a tabela oficial de mecanismos de pagamento SAF-T (AO):
 * NU = Numerário
 * MB = Multicaixa / Cartão de Débito/Crédito
 * TB = Transferência Bancária
 * PR = A Prazo / Conta Corrente
 * OU = Outros Meios / Combinado
 */
export function mapPaymentMethodToSaft(method?: PaymentMethod | string): string {
  switch (method) {
    case 'Dinheiro':
      return 'NU';
    case 'Multicaixa':
      return 'MB';
    case 'Transferência':
      return 'TB';
    case 'Crédito':
      return 'PR';
    case 'Combinado':
      return 'OU';
    default:
      return 'NU';
  }
}

/**
 * Normaliza o NIF para formato SAF-T (AO):
 * Consumidor final deve ser 999999999.
 */
export function normalizeTaxIdForSaft(rawNif?: string | null): string {
  const clean = String(rawNif || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-/]+/g, '');
  if (!clean || clean === 'CONSUMIDORFINAL' || clean === '---' || clean === '999999999' || clean === '000000000') {
    return '999999999';
  }
  return clean;
}

/**
 * Calcula o prazo legal oficial de submissão do ficheiro SAF-T (AO) mensal à AGT
 * Regra Geral do Decreto Presidencial / Decreto Executivo n.º 312/18:
 * Submissão até ao último dia do mês seguinte ao período de tributação/faturação a que os dados respeitam.
 */
export function calculateLegalSubmissionDeadline(year: number, month: number): string {
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  // O dia 0 do mês seguinte ao nextMonth calcula o último dia desse mês
  const lastDayOfNextMonth = new Date(nextYear, nextMonth, 0).getDate();
  const monthNames = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];
  return `${lastDayOfNextMonth} de ${monthNames[nextMonth - 1]} de ${nextYear}`;
}

/**
 * Recupera o motivo legal oficial de isenção de IVA para a taxa 0%.
 */
export function getIvaExemptionReason(code?: string): string {
  if (!code) {
    return 'Isento nos termos da alínea a) do n.º 1 do artigo 12.º do Código do IVA';
  }
  const cleanCode = code.toUpperCase() as AgtIvaExemptionCode;
  const meta = AGT_IVA_EXEMPTION_CODES[cleanCode];
  if (meta && meta.legalBasis) {
    return `${meta.descriptionPt} — ${meta.legalBasis}`;
  }
  return meta?.descriptionPt || 'Isento nos termos do Código do IVA';
}

/**
 * Gera assinatura RSA autêntica e encadeada com a chave privada de 1024-bits
 * Formato padrão oficial: 172 caracteres em Base64 gerados a partir da cadeia canónica.
 */
export function generateChainedDocumentHash(
  inv: InvoiceRecord,
  previousHash: string,
  customPrivateKeyPem?: string
): string {
  const invDate = formatSaftDate(inv.issuedAtIso);
  const systemEntry = formatSaftDateTime(inv.issuedAtIso);
  const docNo = inv.number;
  const gross = inv.grandTotal;

  // Cadeia canónica oficial: Data;DataHoraGravacao;NumeroDocumento;TotalIliquido;HashAnterior
  const canonicalString = buildSaftCanonicalString({
    invoiceDate: invDate,
    systemEntryDate: systemEntry,
    invoiceNo: docNo,
    grossTotal: gross,
    previousHash,
  });

  // Assinatura RSA-SHA1 autêntica
  return signSaftDocumentHash(canonicalString, customPrivateKeyPem);
}

/**
 * Validador pré-exportação de integridade fiscal e auditoria de continuidade sequencial de séries
 */
export function validateSaftDataset(
  company: CompanyProfile,
  invoices: InvoiceRecord[],
  startDate: string,
  endDate: string,
  periodMonth: number,
  fiscalYear: number
): SaftValidationResult {
  const issues: SaftValidationIssue[] = [];
  let totalCredit = 0;
  let totalDebit = 0;
  let taxDifference = 0;

  if (!company.nif || company.nif === '---') {
    issues.push({
      level: 'error',
      message: 'O NIF da empresa emitente (contribuinte utilizador) não está configurado ou é inválido.',
    });
  }

  if (!company.legalName) {
    issues.push({
      level: 'error',
      message: 'A Razão Social legal da empresa emitente é obrigatória.',
    });
  }

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const fiscalInvoices = invoices.filter((i) => i.docType !== 'FP');
  const proformaInvoices = invoices.filter((i) => i.docType === 'FP');

  // Mapeamento para auditoria de continuidade sequencial por série e tipo documental
  const seriesSequences = new Map<string, number[]>();

  for (const inv of fiscalInvoices) {
    const invDate = new Date(inv.issuedAtIso).getTime();

    // Verificação de período
    if (invDate < start || invDate > end + 86400000) {
      issues.push({
        level: 'warning',
        message: `Documento fora do intervalo de datas do período: ${inv.issuedAtIso.slice(0, 10)}`,
        invoiceNumber: inv.number,
      });
    }

    // Totais de débito e crédito
    if (inv.status !== 'cancelled') {
      const netAmount = Math.max(0, inv.taxBase14 + inv.taxBase0);
      if (inv.docType === 'NC') {
        totalDebit += netAmount;
      } else {
        totalCredit += netAmount;
      }
    }

    // Conferência matemática: NetTotal + TaxPayable == GrossTotal
    const calculatedGross = Math.round((inv.taxBase14 + inv.taxBase0 + inv.taxTotal) * 100) / 100;
    const diff = Math.abs(calculatedGross - inv.grandTotal);
    if (diff > 0.05) {
      taxDifference += diff;
      issues.push({
        level: 'error',
        message: `Divergência matemática na fatura: Base (${inv.taxBase14 + inv.taxBase0}) + IVA (${inv.taxTotal}) != Total (${inv.grandTotal})`,
        invoiceNumber: inv.number,
      });
    }

    // Extração do número sequencial para teste de continuidade
    // Ex: "FR A2026/1" ou "FR 2026/1" -> 1
    const match = inv.number.match(/^(?:([A-Z]{2})\s+)?([A-Za-z0-9_-]+)\/(\d+)$/);
    if (match) {
      const docType = match[1] || inv.docType;
      const serie = match[2];
      const seq = parseInt(match[3], 10);
      const key = `${docType}#${serie}`;
      if (!seriesSequences.has(key)) {
        seriesSequences.set(key, []);
      }
      seriesSequences.get(key)!.push(seq);
    }

    // Validação de linhas
    for (const [idx, line] of inv.lines.entries()) {
      if (line.qty <= 0) {
        issues.push({
          level: 'error',
          message: `Linha ${idx + 1} com quantidade inválida (${line.qty}).`,
          invoiceNumber: inv.number,
        });
      }
      if (line.ivaRate === 0 && !(line as any).exemptionCode) {
        issues.push({
          level: 'warning',
          message: `Linha ${idx + 1} isenta de IVA sem menção explícita ao código legal de isenção (M10..M16).`,
          invoiceNumber: inv.number,
        });
      }
    }

    // Notas de crédito exigem menção ao documento de origem
    if (inv.docType === 'NC' && !inv.returnOriginNumber && !inv.notes) {
      issues.push({
        level: 'warning',
        message: 'Nota de Crédito sem indicação explícita da fatura original retificada.',
        invoiceNumber: inv.number,
      });
    }
  }

  // Análise de continuidade de séries
  const continuityAudit: SaftValidationResult['seriesContinuityAudit'] = [];
  for (const [key, seqs] of seriesSequences.entries()) {
    const [docType, serie] = key.split('#');
    seqs.sort((a, b) => a - b);
    const missing: number[] = [];
    for (let i = 0; i < seqs.length - 1; i++) {
      const cur = seqs[i];
      const next = seqs[i + 1];
      if (next > cur + 1) {
        for (let m = cur + 1; m < next; m++) {
          missing.push(m);
        }
      }
    }
    const isContinuous = missing.length === 0;
    continuityAudit.push({
      series: serie,
      docType,
      missingNumbers: missing,
      isContinuous,
    });
    if (!isContinuous) {
      issues.push({
        level: 'warning',
        message: `Quebra na continuidade sequencial da série ${serie} (${docType}): faltam os números ${missing.join(', ')}.`,
      });
    }
  }

  const submissionDeadline = calculateLegalSubmissionDeadline(fiscalYear, periodMonth);

  return {
    valid: issues.filter((i) => i.level === 'error').length === 0,
    issues,
    totalInvoices: fiscalInvoices.length,
    totalProformas: proformaInvoices.length,
    totalCredit: Math.round(totalCredit * 100) / 100,
    totalDebit: Math.round(totalDebit * 100) / 100,
    taxAuditDifference: Math.round(taxDifference * 100) / 100,
    submissionDeadline,
    seriesContinuityAudit: continuityAudit,
  };
}

export interface GenerateSaftParams {
  company: CompanyProfile;
  invoices: InvoiceRecord[];
  products?: Product[];
  customers?: Customer[];
  suppliers?: Supplier[];
  options?: SaftExportOptions;
}

/**
 * Gera o documento XML oficial SAF-T (AO) em conformidade estrita com o Decreto Executivo n.º 312/18.
 * Respeita a ordem estrita (<xs:sequence>), hierarquia de MasterFiles, separação de SourceDocuments e quadro completo de taxas.
 */
export function generateSaftAoXml(params: GenerateSaftParams): SaftExportResult {
  const { company, invoices, products = [], customers = [], suppliers = [], options = {} } = params;

  // 1. Separação Estrita dos Documentos:
  // - SalesInvoices: Documentos fiscais com eficácia tributária (FT, FR, NC, ND)
  // - WorkingDocuments: Proformas (FP) e orçamentos (DC, NE, OR)
  const fiscalInvoices = invoices.filter((i) => i.docType === 'FR' || i.docType === 'NC' || i.docType === ('FT' as any) || i.docType === ('ND' as any));
  const workingInvoices = invoices.filter((i) => i.docType === 'FP');

  // 2. Definição do Período Fiscal
  const now = new Date();
  const defaultYear = now.getFullYear();
  const fiscalYear = options.fiscalYear || defaultYear;

  let minDate = fiscalInvoices.length > 0 ? fiscalInvoices[0].issuedAtIso.slice(0, 10) : `${fiscalYear}-01-01`;
  let maxDate = fiscalInvoices.length > 0 ? fiscalInvoices[fiscalInvoices.length - 1].issuedAtIso.slice(0, 10) : `${fiscalYear}-12-31`;

  for (const inv of [...fiscalInvoices, ...workingInvoices]) {
    const d = inv.issuedAtIso.slice(0, 10);
    if (d < minDate) minDate = d;
    if (d > maxDate) maxDate = d;
  }

  const startDate = options.startDate || minDate;
  const endDate = options.endDate || maxDate;

  // Mês fiscal do ficheiro (1..12)
  const periodMonth =
    options.periodMonth ||
    parseInt(startDate.slice(5, 7), 10) ||
    now.getMonth() + 1;

  // 3. Validação prévia de conformidade e reconciliação legal
  const validation = validateSaftDataset(company, invoices, startDate, endDate, periodMonth, fiscalYear);

  // 4. Mapeamento de Clientes (<Customer>)
  const customersMap = new Map<string, { id: string; name: string; nif: string; address: string; city: string; postalCode: string }>();

  // Consumidor final padrão obrigatório no SAF-T
  customersMap.set('999999999', {
    id: '999999999',
    name: 'Consumidor Final',
    nif: '999999999',
    address: 'Desconhecido',
    city: 'Desconhecido',
    postalCode: 'Desconhecido',
  });

  for (const c of customers) {
    const safeTaxId = normalizeTaxIdForSaft(c.nif);
    const cid = c.id || safeTaxId;
    customersMap.set(cid, {
      id: cid,
      name: c.name || 'Cliente Sem Nome',
      nif: safeTaxId,
      address: c.address || 'Angola',
      city: c.locality || 'Luanda',
      postalCode: 'Desconhecido',
    });
  }

  for (const inv of [...fiscalInvoices, ...workingInvoices]) {
    const cid = inv.customerId || normalizeTaxIdForSaft(inv.customerNif);
    if (!customersMap.has(cid)) {
      const safeTaxId = normalizeTaxIdForSaft(inv.customerNif);
      customersMap.set(cid, {
        id: cid,
        name: inv.customerName || 'Consumidor Final',
        nif: safeTaxId,
        address: 'Angola',
        city: inv.customerLocality || 'Luanda',
        postalCode: 'Desconhecido',
      });
    }
  }

  // 5. Mapeamento de Fornecedores (<Supplier>) quando aplicável
  const suppliersMap = new Map<string, { id: string; name: string; nif: string; address: string; city: string; postalCode: string }>();
  for (const s of suppliers) {
    const safeTaxId = normalizeTaxIdForSaft(s.nif);
    const sid = s.id || safeTaxId;
    suppliersMap.set(sid, {
      id: sid,
      name: s.name || 'Fornecedor Registado',
      nif: safeTaxId,
      address: s.address || 'Angola',
      city: s.locality || 'Luanda',
      postalCode: 'Desconhecido',
    });
  }

  // 6. Mapeamento de Artigos e Serviços (<Product>)
  const productsMap = new Map<string, { code: string; description: string; group: string; type: 'P' | 'S' }>();

  for (const p of products) {
    const code = p.code || p.id;
    productsMap.set(code, {
      code,
      description: p.name || 'Artigo Comercial',
      group: p.category || 'Geral',
      type: 'P',
    });
  }

  for (const inv of [...fiscalInvoices, ...workingInvoices]) {
    for (const l of inv.lines) {
      const code = l.code || l.productId || 'PROD';
      if (!productsMap.has(code)) {
        productsMap.set(code, {
          code,
          description: l.description || 'Artigo Comercial',
          group: 'Geral',
          type: 'P',
        });
      }
    }
  }

  // 7. Distinção Rigorosa de NIFs:
  // - Contribuinte utilizador (empresa emitente): CompanyID e TaxRegistrationNumber
  // - Produtor do software (SILA-Billing / VITRONIS): ProductCompanyTaxID (5002571293)
  const cleanCompanyNif = normalizeTaxIdForSaft(company.nif);
  const productCompanyTaxId = options.productCompanyTaxId || VITRONIS_INSTITUTIONAL.nif;
  const softwareCertificateNumber = options.softwareCertificateNumber || '000/AGT/2026';
  const productId = options.productId || 'SILA-Billing';
  const productVersion = options.productVersion || '1.01_01';
  const headerComment = options.headerComment || 'Ficheiro de Auditoria Tributária SAF-T (AO) gerado conforme Decreto Executivo n.º 312/18';

  // 8. Processamento de Faturas com Encadeamento Real RSA (<SalesInvoices>)
  let totalDebit = 0;
  let totalCredit = 0;
  let runningPreviousHash = '';

  const invoicesXmlChunks: string[] = [];

  for (const inv of fiscalInvoices) {
    const invDate = formatSaftDate(inv.issuedAtIso);
    const systemEntryDate = formatSaftDateTime(inv.issuedAtIso);
    const isCancelled = inv.status === 'cancelled';
    const invoiceStatus = isCancelled ? 'A' : 'N';
    const invoiceStatusDate = formatSaftDateTime(
      isCancelled ? inv.cancelledAtIso || inv.issuedAtIso : inv.issuedAtIso
    );

    const invoiceType = inv.docType === 'NC' ? 'NC' : (inv.docType as any) === 'FT' ? 'FT' : 'FR';
    const netAmount = Math.max(0, inv.taxBase14 + inv.taxBase0);

    if (!isCancelled) {
      if (invoiceType === 'NC') {
        totalDebit += netAmount;
      } else {
        totalCredit += netAmount;
      }
    }

    const customerId = inv.customerId || normalizeTaxIdForSaft(inv.customerNif);

    // Encadeamento Criptográfico de Assinatura RSA autêntica
    const currentHash = generateChainedDocumentHash(inv, runningPreviousHash, options.privateKeyPem);
    runningPreviousHash = currentHash;

    // Montagem das Linhas respeitando estritamente a sequência do XSD
    const linesXmlChunks: string[] = [];
    for (const [idx, l] of inv.lines.entries()) {
      const lineNumber = idx + 1;
      const productCode = l.code || l.productId || 'PROD';
      const pDesc = l.description || 'Artigo Comercial';
      const qty = Math.max(0.001, Number(l.qty) || 1);
      const unitPrice = Math.max(0, Number(l.unitPrice) || 0);
      const lineGross = Math.round(qty * unitPrice * 100) / 100;
      const lineDiscount = Math.round((Number(l.lineDiscount) || 0) * 100) / 100;
      const lineBase = Math.round((l.lineBase || Math.max(0, lineGross - lineDiscount)) * 100) / 100;

      const rateNum = Number(l.ivaRate) || 0;
      const isZeroRate = rateNum === 0;
      const taxCode = isZeroRate ? 'ISE' : rateNum === 5 ? 'RED' : (rateNum === 1 || rateNum === 7) ? 'INT' : 'NOR';
      const taxPercentage = rateNum.toFixed(2);
      const exemptionCode = (l as any).exemptionCode || 'M10';
      const exemptionReason = getIvaExemptionReason(exemptionCode);

      // Débito para Notas de Crédito, Crédito para Faturas/Recibo e Faturas
      const amountTag = invoiceType === 'NC'
        ? `<DebitAmount>${lineBase.toFixed(2)}</DebitAmount>`
        : `<CreditAmount>${lineBase.toFixed(2)}</CreditAmount>`;

      const taxSection = `
          <Tax>
            <TaxType>IVA</TaxType>
            <TaxCountryRegion>AO</TaxCountryRegion>
            <TaxCode>${taxCode}</TaxCode>
            <TaxPercentage>${taxPercentage}</TaxPercentage>
          </Tax>
          ${
            isZeroRate
              ? `
          <TaxExemptionReason>${escapeXml(exemptionReason)}</TaxExemptionReason>
          <TaxExemptionCode>${escapeXml(exemptionCode)}</TaxExemptionCode>`
              : ''
          }
      `.trim();

      // Bloco <References> no XSD é filho de <Line>, colocado entre <TaxPointDate> e <Description>
      const lineReferences =
        invoiceType === 'NC'
          ? `
          <References>
            <Reference>${escapeXml(inv.returnOriginNumber || 'FR 2026/1')}</Reference>
            <Reason>${escapeXml(inv.cancelReason || 'Rectificação / Anulação de documento anterior')}</Reason>
          </References>`
          : '';

      linesXmlChunks.push(`
        <Line>
          <LineNumber>${lineNumber}</LineNumber>
          <ProductCode>${escapeXml(productCode)}</ProductCode>
          <ProductDescription>${escapeXml(pDesc)}</ProductDescription>
          <Quantity>${qty.toFixed(2)}</Quantity>
          <UnitOfMeasure>${escapeXml(l.unit || 'UN')}</UnitOfMeasure>
          <UnitPrice>${unitPrice.toFixed(2)}</UnitPrice>
          <TaxPointDate>${invDate}</TaxPointDate>${lineReferences}
          <Description>${escapeXml(pDesc)}</Description>
          ${amountTag}
          ${taxSection}
          <SettlementAmount>${lineDiscount.toFixed(2)}</SettlementAmount>
        </Line>
      `.trim());
    }

    invoicesXmlChunks.push(`
      <Invoice>
        <InvoiceNo>${escapeXml(inv.number)}</InvoiceNo>
        <ATCUD>0</ATCUD>
        <DocumentStatus>
          <InvoiceStatus>${invoiceStatus}</InvoiceStatus>
          <InvoiceStatusDate>${invoiceStatusDate}</InvoiceStatusDate>
          <SourceID>${escapeXml(inv.operator || inv.cashier || 'SILA-POS')}</SourceID>
          <SourceBilling>P</SourceBilling>
        </DocumentStatus>
        <Hash>${escapeXml(currentHash)}</Hash>
        <HashControl>1</HashControl>
        <Period>${periodMonth}</Period>
        <InvoiceDate>${invDate}</InvoiceDate>
        <InvoiceType>${invoiceType}</InvoiceType>
        <SpecialRegimes>
          <SelfBillingIndicator>0</SelfBillingIndicator>
          <CashVATSchemeIndicator>0</CashVATSchemeIndicator>
          <ThirdPartiesBillingIndicator>0</ThirdPartiesBillingIndicator>
        </SpecialRegimes>
        <SourceID>${escapeXml(inv.operator || inv.cashier || 'SILA-POS')}</SourceID>
        <SystemEntryDate>${systemEntryDate}</SystemEntryDate>
        <CustomerID>${escapeXml(customerId)}</CustomerID>
        ${linesXmlChunks.join('\n        ')}
        <DocumentTotals>
          <TaxPayable>${inv.taxTotal.toFixed(2)}</TaxPayable>
          <NetTotal>${netAmount.toFixed(2)}</NetTotal>
          <GrossTotal>${inv.grandTotal.toFixed(2)}</GrossTotal>
          <Payment>
            <PaymentMechanism>${mapPaymentMethodToSaft(inv.paymentMethod)}</PaymentMechanism>
            <PaymentAmount>${inv.grandTotal.toFixed(2)}</PaymentAmount>
            <PaymentDate>${invDate}</PaymentDate>
          </Payment>
        </DocumentTotals>
      </Invoice>
    `.trim());
  }

  // 9. Processamento de Proformas (<WorkingDocuments>) quando presentes
  const workingDocsXmlChunks: string[] = [];
  let totalWorkingCredit = 0;
  let runningWorkingHash = '';

  for (const fp of workingInvoices) {
    const fpDate = formatSaftDate(fp.issuedAtIso);
    const systemEntryDate = formatSaftDateTime(fp.issuedAtIso);
    const isCancelled = fp.status === 'cancelled';
    const netAmount = Math.max(0, fp.taxBase14 + fp.taxBase0);
    if (!isCancelled) totalWorkingCredit += netAmount;

    const customerId = fp.customerId || normalizeTaxIdForSaft(fp.customerNif);
    const fpHash = generateChainedDocumentHash(fp, runningWorkingHash, options.privateKeyPem);
    runningWorkingHash = fpHash;

    const fpLinesXml: string[] = [];
    for (const [idx, l] of fp.lines.entries()) {
      const lineNumber = idx + 1;
      const productCode = l.code || l.productId || 'PROD';
      const pDesc = l.description || 'Artigo Comercial';
      const qty = Math.max(0.001, Number(l.qty) || 1);
      const unitPrice = Math.max(0, Number(l.unitPrice) || 0);
      const lineBase = Math.round((l.lineBase || qty * unitPrice) * 100) / 100;
      const isZeroRate = l.ivaRate === 0;
      const taxCode = isZeroRate ? 'ISE' : 'NOR';
      const taxPercentage = (l.ivaRate || 14).toFixed(2);

      fpLinesXml.push(`
          <Line>
            <LineNumber>${lineNumber}</LineNumber>
            <ProductCode>${escapeXml(productCode)}</ProductCode>
            <ProductDescription>${escapeXml(pDesc)}</ProductDescription>
            <Quantity>${qty.toFixed(2)}</Quantity>
            <UnitOfMeasure>${escapeXml(l.unit || 'UN')}</UnitOfMeasure>
            <UnitPrice>${unitPrice.toFixed(2)}</UnitPrice>
            <TaxPointDate>${fpDate}</TaxPointDate>
            <Description>${escapeXml(pDesc)}</Description>
            <CreditAmount>${lineBase.toFixed(2)}</CreditAmount>
            <Tax>
              <TaxType>IVA</TaxType>
              <TaxCountryRegion>AO</TaxCountryRegion>
              <TaxCode>${taxCode}</TaxCode>
              <TaxPercentage>${taxPercentage}</TaxPercentage>
            </Tax>
          </Line>
      `.trim());
    }

    workingDocsXmlChunks.push(`
        <WorkDocument>
          <DocumentNumber>${escapeXml(fp.number)}</DocumentNumber>
          <DocumentStatus>
            <WorkStatus>${isCancelled ? 'A' : 'N'}</WorkStatus>
            <WorkStatusDate>${systemEntryDate}</WorkStatusDate>
            <SourceID>${escapeXml(fp.operator || 'SILA-POS')}</SourceID>
            <SourceBilling>P</SourceBilling>
          </DocumentStatus>
          <Hash>${escapeXml(fpHash)}</Hash>
          <HashControl>1</HashControl>
          <Period>${periodMonth}</Period>
          <WorkDate>${fpDate}</WorkDate>
          <WorkType>FP</WorkType>
          <SourceID>${escapeXml(fp.operator || 'SILA-POS')}</SourceID>
          <SystemEntryDate>${systemEntryDate}</SystemEntryDate>
          <CustomerID>${escapeXml(customerId)}</CustomerID>
          ${fpLinesXml.join('\n          ')}
          <DocumentTotals>
            <TaxPayable>${fp.taxTotal.toFixed(2)}</TaxPayable>
            <NetTotal>${netAmount.toFixed(2)}</NetTotal>
            <GrossTotal>${fp.grandTotal.toFixed(2)}</GrossTotal>
          </DocumentTotals>
        </WorkDocument>
    `.trim());
  }

  // 10. Montagem dos Clientes XML (Filhos directos de <MasterFiles>)
  const customersXml = Array.from(customersMap.values())
    .map((c) => {
      return `
    <Customer>
      <CustomerID>${escapeXml(c.id)}</CustomerID>
      <AccountID>Desconhecido</AccountID>
      <CustomerTaxID>${escapeXml(c.nif)}</CustomerTaxID>
      <CompanyName>${escapeXml(c.name)}</CompanyName>
      <BillingAddress>
        <AddressDetail>${escapeXml(c.address)}</AddressDetail>
        <City>${escapeXml(c.city)}</City>
        <PostalCode>${escapeXml(c.postalCode)}</PostalCode>
        <Country>AO</Country>
      </BillingAddress>
      <SelfBillingIndicator>0</SelfBillingIndicator>
    </Customer>
    `.trim();
    })
    .join('\n    ');

  // 11. Montagem dos Fornecedores XML (<Supplier> - minOccurs="0")
  const suppliersXml = suppliersMap.size > 0
    ? Array.from(suppliersMap.values())
        .map((s) => {
          return `
    <Supplier>
      <SupplierID>${escapeXml(s.id)}</SupplierID>
      <AccountID>Desconhecido</AccountID>
      <SupplierTaxID>${escapeXml(s.nif)}</SupplierTaxID>
      <CompanyName>${escapeXml(s.name)}</CompanyName>
      <BillingAddress>
        <AddressDetail>${escapeXml(s.address)}</AddressDetail>
        <City>${escapeXml(s.city)}</City>
        <PostalCode>${escapeXml(s.postalCode)}</PostalCode>
        <Country>AO</Country>
      </BillingAddress>
      <SelfBillingIndicator>0</SelfBillingIndicator>
    </Supplier>
          `.trim();
        })
        .join('\n    ')
    : '';

  // 12. Montagem dos Artigos XML (Filhos directos de <MasterFiles>)
  const productsXml = Array.from(productsMap.values())
    .map((p) => {
      return `
    <Product>
      <ProductType>${p.type}</ProductType>
      <ProductCode>${escapeXml(p.code)}</ProductCode>
      <ProductGroup>${escapeXml(p.group)}</ProductGroup>
      <ProductDescription>${escapeXml(p.description)}</ProductDescription>
      <ProductNumberCode>${escapeXml(p.code)}</ProductNumberCode>
    </Product>
    `.trim();
    })
    .join('\n    ');

  // 13. Tabela de Impostos Completa (Todas as Taxas e Regimes Oficiais de Angola)
  const taxTableXml = `
    <TaxTable>
      <TaxTableEntry>
        <TaxType>IVA</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>NOR</TaxCode>
        <Description>Taxa Normal (14%) - Artigo 15.º do CIVA</Description>
        <TaxPercentage>14.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IVA</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>RED</TaxCode>
        <Description>Taxa Reduzida (5%) - Cesta Básica e Insumos Agrícolas (Dec. Presidencial 71/25)</Description>
        <TaxPercentage>5.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IVA</TaxType>
        <TaxCountryRegion>AO-CAB</TaxCountryRegion>
        <TaxCode>INT</TaxCode>
        <Description>Taxa Especial para a Província de Cabinda (1%) - Artigo 15.º do CIVA / Lei n.º 14/23</Description>
        <TaxPercentage>1.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IVA</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>ISE</TaxCode>
        <Description>Isento de IVA nos termos do Artigo 12.º e 15.º do CIVA</Description>
        <TaxPercentage>0.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IVA</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>OUT</TaxCode>
        <Description>Outras Operações / Não Sujeição ao IVA</Description>
        <TaxPercentage>0.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IS</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>S01</TaxCode>
        <Description>Imposto do Selo - Recibos de Quitação (1% - Verba 23.3 da TGIS)</Description>
        <TaxPercentage>1.00</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IS</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>S02</TaxCode>
        <Description>Imposto do Selo - Operações de Crédito e Financiamento (Verba 17 da TGIS)</Description>
        <TaxPercentage>0.50</TaxPercentage>
      </TaxTableEntry>
      <TaxTableEntry>
        <TaxType>IS</TaxType>
        <TaxCountryRegion>AO</TaxCountryRegion>
        <TaxCode>S00</TaxCode>
        <Description>Operações Isentas de Imposto do Selo</Description>
        <TaxPercentage>0.00</TaxPercentage>
      </TaxTableEntry>
    </TaxTable>
  `.trim();

  // 14. Contactos da Empresa Utilizadora (NUNCA misturados com a software house VITRONIS)
  const companyCity = company.cityCountry
    ? company.cityCountry.split('-')[0].trim()
    : 'Luanda';
  const companyAddress = company.address || 'Angola';
  const companyPhone = company.phone ? escapeXml(company.phone) : 'Desconhecido';
  const companyEmail = company.email ? escapeXml(company.email) : 'Desconhecido';

  // 15. Bloco <WorkingDocuments> condicional
  const workingDocumentsSection = workingDocsXmlChunks.length > 0
    ? `
    <WorkingDocuments>
      <NumberOfEntries>${workingDocsXmlChunks.length}</NumberOfEntries>
      <TotalDebit>0.00</TotalDebit>
      <TotalCredit>${totalWorkingCredit.toFixed(2)}</TotalCredit>
      ${workingDocsXmlChunks.join('\n      ')}
    </WorkingDocuments>`
    : '';

  // 16. Montagem Final do Documento XML SAF-T (AO) respeitando xs:sequence
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<AuditFile xmlns="urn:OECD:StandardAuditFile-Tax:AO_1.01_01" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:OECD:StandardAuditFile-Tax:AO_1.01_01 https://www.agt.minfin.gov.ao/saf-t/AO_1.01_01.xsd">
  <Header>
    <AuditFileVersion>1.01_01</AuditFileVersion>
    <CompanyID>${escapeXml(cleanCompanyNif)}</CompanyID>
    <TaxRegistrationNumber>${escapeXml(cleanCompanyNif)}</TaxRegistrationNumber>
    <TaxAccountingBasis>F</TaxAccountingBasis>
    <CompanyName>${escapeXml(company.legalName)}</CompanyName>
    <BusinessName>${escapeXml(company.shortName || company.legalName)}</BusinessName>
    <CompanyAddress>
      <AddressDetail>${escapeXml(companyAddress)}</AddressDetail>
      <City>${escapeXml(companyCity)}</City>
      <PostalCode>Desconhecido</PostalCode>
      <Province>${escapeXml(companyCity)}</Province>
      <Country>AO</Country>
    </CompanyAddress>
    <FiscalYear>${fiscalYear}</FiscalYear>
    <StartDate>${startDate}</StartDate>
    <EndDate>${endDate}</EndDate>
    <CurrencyCode>AOA</CurrencyCode>
    <DateCreated>${formatSaftDate(now.toISOString())}</DateCreated>
    <TaxEntity>Global</TaxEntity>
    <ProductCompanyTaxID>${escapeXml(productCompanyTaxId)}</ProductCompanyTaxID>
    <SoftwareCertificateNumber>${escapeXml(softwareCertificateNumber)}</SoftwareCertificateNumber>
    <ProductID>${escapeXml(productId)}</ProductID>
    <ProductVersion>${escapeXml(productVersion)}</ProductVersion>
    <HeaderComment>${escapeXml(headerComment)}</HeaderComment>
    <Telephone>${companyPhone}</Telephone>
    <Email>${companyEmail}</Email>
  </Header>
  <MasterFiles>
    ${customersXml}
    ${suppliersXml ? suppliersXml + '\n    ' : ''}${productsXml}
    ${taxTableXml}
  </MasterFiles>
  <SourceDocuments>
    <SalesInvoices>
      <NumberOfEntries>${fiscalInvoices.length}</NumberOfEntries>
      <TotalDebit>${totalDebit.toFixed(2)}</TotalDebit>
      <TotalCredit>${totalCredit.toFixed(2)}</TotalCredit>
      ${invoicesXmlChunks.join('\n      ')}
    </SalesInvoices>${workingDocumentsSection}
  </SourceDocuments>
</AuditFile>`;

  // Nomenclatura oficial: SAF-T_AO_<NIF>_<ANO>_<MES>.xml
  const monthPad = String(periodMonth).padStart(2, '0');
  const filename = `SAF-T_AO_${cleanCompanyNif}_${fiscalYear}_${monthPad}.xml`;

  return {
    xml,
    filename,
    summary: {
      fiscalYear,
      period: periodMonth,
      startDate,
      endDate,
      submissionDeadline: validation.submissionDeadline,
      totalSalesInvoices: fiscalInvoices.length,
      totalWorkingDocuments: workingInvoices.length,
      totalCredit: Math.round(totalCredit * 100) / 100,
      totalDebit: Math.round(totalDebit * 100) / 100,
      customersCount: customersMap.size,
      suppliersCount: suppliersMap.size,
      productsCount: productsMap.size,
      issuerTaxId: cleanCompanyNif,
      producerTaxId: productCompanyTaxId,
    },
    validation,
  };
}

/**
 * Função utilitária para gerar e validar o ficheiro SAF-T de um mês específico
 */
export function generateMonthlySaftAoXml(params: {
  company: CompanyProfile;
  invoices: InvoiceRecord[];
  products?: Product[];
  customers?: Customer[];
  suppliers?: Supplier[];
  year: number;
  month: number; // 1 a 12
}): SaftExportResult {
  const { company, invoices, products = [], customers = [], suppliers = [], year, month } = params;

  const monthPad = String(month).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  const startDate = `${year}-${monthPad}-01`;
  const endDate = `${year}-${monthPad}-${String(lastDay).padStart(2, '0')}`;

  // Filtra faturas emitidas rigorosamente dentro do mês civil
  const monthlyInvoices = invoices.filter((i) => {
    const d = i.issuedAtIso.slice(0, 10);
    return d >= startDate && d <= endDate;
  });

  return generateSaftAoXml({
    company,
    invoices: monthlyInvoices,
    products,
    customers,
    suppliers,
    options: {
      fiscalYear: year,
      startDate,
      endDate,
      periodMonth: month,
    },
  });
}
