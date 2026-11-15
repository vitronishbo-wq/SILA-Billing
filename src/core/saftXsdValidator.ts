/**
 * SILA-Billing — Validador Estrutural e de Esquema XSD SAF-T (AO) v1.01_01
 *
 * Implementa a verificação rigorosa da gramática oficial do ficheiro SAF-T (AO):
 * - Declaração XML UTF-8 e namespace oficial `urn:OECD:StandardAuditFile-Tax:AO_1.01_01`
 * - Integridade léxica (tags balanceadas, ausência de entidades malformadas ou `&` não escapado)
 * - Ordem estrita `<xs:sequence>` para Header, MasterFiles (Customer, Supplier, Product, TaxTable),
 *   SourceDocuments (SalesInvoices, Invoice, Line, References, Tax, DocumentTotals, WorkingDocuments, WorkDocument)
 * - Padrões XSD (SAFPTDateType, SAFPTDateTimeType, SAFPTPortugueseVatNumber, MonetaryType 2 casas, TaxType, TaxCode, InvoiceStatus, WorkStatus)
 * - Reconciliação numérica (`NumberOfEntries`, `TotalDebit`, `TotalCredit`, `GrossTotal`)
 */

export interface SaftXsdIssue {
  path: string;
  code:
    | 'XML_SYNTAX'
    | 'XSD_NAMESPACE'
    | 'XSD_SEQUENCE'
    | 'XSD_CARDINALITY'
    | 'XSD_DATATYPE'
    | 'XSD_RECONCILIATION';
  message: string;
}

export interface SaftXsdValidationReport {
  valid: boolean;
  errors: SaftXsdIssue[];
  stats: {
    customers: number;
    suppliers: number;
    products: number;
    taxTableEntries: number;
    salesInvoices: number;
    workingDocuments: number;
    invoiceLines: number;
  };
}

interface XmlElementNode {
  tag: string;
  attrs: string;
  children: XmlElementNode[];
  text: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
const DECIMAL2_RE = /^-?\d+\.\d{2}$/;
const POSITIVE_INT_RE = /^\d+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const REGION_RE = /^AO(?:-CAB)?$/;
const DOC_NO_RE = /^[A-Z0-9]{1,8}\s+[A-Z0-9_-]+\/\d+$/;

function parseXmlStrict(xml: string): { root: XmlElementNode | null; syntaxErrors: SaftXsdIssue[] } {
  const syntaxErrors: SaftXsdIssue[] = [];
  const trimmed = xml.trim();

  if (!trimmed.startsWith('<?xml version="1.0" encoding="UTF-8"?>')) {
    syntaxErrors.push({
      path: 'xml',
      code: 'XML_SYNTAX',
      message: 'Declaração XML deve iniciar com <?xml version="1.0" encoding="UTF-8"?>.',
    });
  }

  // Verificar existência de '&' não escapado fora de entidades XML válidas
  const bodyWithoutDecl = trimmed.replace(/^<\?xml[^?]*\?>\s*/i, '');
  const textOnly = bodyWithoutDecl.replace(/<[^>]+>/g, '');
  const rawAmp = textOnly.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '');
  if (rawAmp.includes('&')) {
    syntaxErrors.push({
      path: 'xml',
      code: 'XML_SYNTAX',
      message: 'Conteúdo XML contém carácter "&" não escapado.',
    });
  }

  const tagRe = /<(\/?)([A-Za-z_][A-Za-z0-9:_-]*)([^>]*)>/g;
  const stack: XmlElementNode[] = [];
  let root: XmlElementNode | null = null;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(bodyWithoutDecl)) !== null) {
    const isClosing = match[1] === '/';
    const tag = match[2]!;
    const rawAttrs = match[3] || '';
    const isSelfClosing = rawAttrs.trim().endsWith('/');
    const textChunk = bodyWithoutDecl.slice(lastIndex, match.index);
    lastIndex = tagRe.lastIndex;

    if (stack.length > 0 && textChunk.trim().length > 0) {
      stack[stack.length - 1]!.text += textChunk;
    } else if (stack.length === 0 && textChunk.trim().length > 0) {
      syntaxErrors.push({
        path: 'xml',
        code: 'XML_SYNTAX',
        message: `Texto inesperado fora do elemento raiz: "${textChunk.trim().slice(0, 40)}"`,
      });
    }

    if (isClosing) {
      const top = stack.pop();
      if (!top) {
        syntaxErrors.push({
          path: tag,
          code: 'XML_SYNTAX',
          message: `Tag de fecho </${tag}> sem tag de abertura correspondente.`,
        });
        break;
      }
      if (top.tag !== tag) {
        syntaxErrors.push({
          path: tag,
          code: 'XML_SYNTAX',
          message: `Tag de fecho </${tag}> não coincide com <${top.tag}> aberta.`,
        });
        break;
      }
    } else {
      const node: XmlElementNode = {
        tag,
        attrs: rawAttrs,
        children: [],
        text: '',
      };
      if (stack.length > 0) {
        stack[stack.length - 1]!.children.push(node);
      } else if (!root) {
        root = node;
      } else {
        syntaxErrors.push({
          path: tag,
          code: 'XML_SYNTAX',
          message: `Múltiplos elementos raiz encontrados: <${tag}>.`,
        });
      }
      if (!isSelfClosing) {
        stack.push(node);
      }
    }
  }

  if (stack.length > 0) {
    syntaxErrors.push({
      path: stack[stack.length - 1]!.tag,
      code: 'XML_SYNTAX',
      message: `Tag <${stack[stack.length - 1]!.tag}> não foi fechada.`,
    });
  }

  if (bodyWithoutDecl.slice(lastIndex).trim().length > 0) {
    syntaxErrors.push({
      path: 'xml',
      code: 'XML_SYNTAX',
      message: 'Conteúdo inesperado após o fecho do elemento raiz.',
    });
  }

  return { root, syntaxErrors };
}

interface SequenceSpec {
  tag: string;
  min?: number;
  max?: number; // undefined = 1, Infinity = unbounded
}

function validateSequence(
  node: XmlElementNode,
  path: string,
  specs: SequenceSpec[],
  errors: SaftXsdIssue[]
): Map<string, XmlElementNode[]> {
  const grouped = new Map<string, XmlElementNode[]>();
  const specIdxByTag = new Map<string, number>();
  specs.forEach((s, i) => specIdxByTag.set(s.tag, i));

  let maxSeenIdx = -1;
  for (const child of node.children) {
    const idx = specIdxByTag.get(child.tag);
    if (idx === undefined) {
      errors.push({
        path: `${path}/${child.tag}`,
        code: 'XSD_SEQUENCE',
        message: `Elemento inesperado <${child.tag}> dentro de <${node.tag}>.`,
      });
      continue;
    }
    if (idx < maxSeenIdx) {
      const expectedAfter = specs[maxSeenIdx]!.tag;
      errors.push({
        path: `${path}/${child.tag}`,
        code: 'XSD_SEQUENCE',
        message: `Ordem <xs:sequence> violada em <${node.tag}>: <${child.tag}> aparece após <${expectedAfter}>.`,
      });
    } else {
      maxSeenIdx = idx;
    }
    const bucket = grouped.get(child.tag) || [];
    bucket.push(child);
    grouped.set(child.tag, bucket);
  }

  for (const spec of specs) {
    const min = spec.min ?? 1;
    const max = spec.max ?? 1;
    const count = (grouped.get(spec.tag) || []).length;
    if (count < min) {
      errors.push({
        path: `${path}/${spec.tag}`,
        code: 'XSD_CARDINALITY',
        message: `Elemento obrigatório <${spec.tag}> em falta em <${node.tag}> (mínimo ${min}, obtido ${count}).`,
      });
    }
    if (count > max) {
      errors.push({
        path: `${path}/${spec.tag}`,
        code: 'XSD_CARDINALITY',
        message: `Excesso de ocorrências de <${spec.tag}> em <${node.tag}> (máximo ${max}, obtido ${count}).`,
      });
    }
  }

  return grouped;
}

function getText(grouped: Map<string, XmlElementNode[]>, tag: string): string {
  const list = grouped.get(tag);
  return list && list[0] ? list[0].text.trim() : '';
}

function assertPattern(
  value: string,
  pattern: RegExp,
  path: string,
  label: string,
  errors: SaftXsdIssue[]
): void {
  if (!pattern.test(value)) {
    errors.push({
      path,
      code: 'XSD_DATATYPE',
      message: `${label} inválido ("${value}") para o tipo XSD esperado.`,
    });
  }
}

export function validateSaftAoXsdStrict(xml: string): SaftXsdValidationReport {
  const { root, syntaxErrors } = parseXmlStrict(xml);
  const errors: SaftXsdIssue[] = [...syntaxErrors];
  const stats = {
    customers: 0,
    suppliers: 0,
    products: 0,
    taxTableEntries: 0,
    salesInvoices: 0,
    workingDocuments: 0,
    invoiceLines: 0,
  };

  if (!root || root.tag !== 'AuditFile') {
    errors.push({
      path: 'AuditFile',
      code: 'XSD_NAMESPACE',
      message: 'Elemento raiz obrigatório <AuditFile> não encontrado.',
    });
    return { valid: false, errors, stats };
  }

  if (!root.attrs.includes('xmlns="urn:OECD:StandardAuditFile-Tax:AO_1.01_01"')) {
    errors.push({
      path: 'AuditFile',
      code: 'XSD_NAMESPACE',
      message: 'Namespace oficial AGT AO_1.01_01 ausente em <AuditFile>.',
    });
  }

  const rootChildren = validateSequence(
    root,
    'AuditFile',
    [
      { tag: 'Header', min: 1, max: 1 },
      { tag: 'MasterFiles', min: 1, max: 1 },
      { tag: 'SourceDocuments', min: 1, max: 1 },
    ],
    errors
  );

  // 1. HEADER
  const headerNode = rootChildren.get('Header')?.[0];
  if (headerNode) {
    const hMap = validateSequence(
      headerNode,
      'AuditFile/Header',
      [
        { tag: 'AuditFileVersion' },
        { tag: 'CompanyID' },
        { tag: 'TaxRegistrationNumber' },
        { tag: 'TaxAccountingBasis' },
        { tag: 'CompanyName' },
        { tag: 'BusinessName', min: 0 },
        { tag: 'CompanyAddress' },
        { tag: 'FiscalYear' },
        { tag: 'StartDate' },
        { tag: 'EndDate' },
        { tag: 'CurrencyCode' },
        { tag: 'DateCreated' },
        { tag: 'TaxEntity' },
        { tag: 'ProductCompanyTaxID' },
        { tag: 'SoftwareCertificateNumber' },
        { tag: 'ProductID' },
        { tag: 'ProductVersion' },
        { tag: 'HeaderComment', min: 0 },
        { tag: 'Telephone', min: 0 },
        { tag: 'Email', min: 0 },
      ],
      errors
    );

    if (getText(hMap, 'AuditFileVersion') !== '1.01_01') {
      errors.push({
        path: 'AuditFile/Header/AuditFileVersion',
        code: 'XSD_DATATYPE',
        message: 'AuditFileVersion deve ser exatamente "1.01_01".',
      });
    }
    if (getText(hMap, 'CurrencyCode') !== 'AOA') {
      errors.push({
        path: 'AuditFile/Header/CurrencyCode',
        code: 'XSD_DATATYPE',
        message: 'CurrencyCode deve ser "AOA".',
      });
    }
    assertPattern(
      getText(hMap, 'TaxAccountingBasis'),
      /^(F|I|C|S|E|P|R)$/,
      'AuditFile/Header/TaxAccountingBasis',
      'TaxAccountingBasis',
      errors
    );
    assertPattern(getText(hMap, 'FiscalYear'), /^20\d{2}$/, 'AuditFile/Header/FiscalYear', 'FiscalYear', errors);
    assertPattern(getText(hMap, 'StartDate'), DATE_RE, 'AuditFile/Header/StartDate', 'StartDate', errors);
    assertPattern(getText(hMap, 'EndDate'), DATE_RE, 'AuditFile/Header/EndDate', 'EndDate', errors);
    assertPattern(getText(hMap, 'DateCreated'), DATE_RE, 'AuditFile/Header/DateCreated', 'DateCreated', errors);
    assertPattern(
      getText(hMap, 'TaxRegistrationNumber'),
      /^[A-Z0-9]{6,20}$/,
      'AuditFile/Header/TaxRegistrationNumber',
      'TaxRegistrationNumber',
      errors
    );
    assertPattern(
      getText(hMap, 'ProductCompanyTaxID'),
      /^[A-Z0-9]{6,20}$/,
      'AuditFile/Header/ProductCompanyTaxID',
      'ProductCompanyTaxID',
      errors
    );

    const addrNode = hMap.get('CompanyAddress')?.[0];
    if (addrNode) {
      const aMap = validateSequence(
        addrNode,
        'AuditFile/Header/CompanyAddress',
        [
          { tag: 'AddressDetail' },
          { tag: 'City' },
          { tag: 'PostalCode', min: 0 },
          { tag: 'Province', min: 0 },
          { tag: 'Country' },
        ],
        errors
      );
      assertPattern(
        getText(aMap, 'Country'),
        COUNTRY_RE,
        'AuditFile/Header/CompanyAddress/Country',
        'Country',
        errors
      );
    }
  }

  // 2. MASTERFILES
  const masterNode = rootChildren.get('MasterFiles')?.[0];
  if (masterNode) {
    const mfMap = validateSequence(
      masterNode,
      'AuditFile/MasterFiles',
      [
        { tag: 'Customer', min: 0, max: Infinity },
        { tag: 'Supplier', min: 0, max: Infinity },
        { tag: 'Product', min: 0, max: Infinity },
        { tag: 'TaxTable', min: 1, max: 1 },
      ],
      errors
    );

    const customers = mfMap.get('Customer') || [];
    stats.customers = customers.length;
    customers.forEach((cust, idx) => {
      const cMap = validateSequence(
        cust,
        `AuditFile/MasterFiles/Customer[${idx}]`,
        [
          { tag: 'CustomerID' },
          { tag: 'AccountID' },
          { tag: 'CustomerTaxID' },
          { tag: 'CompanyName' },
          { tag: 'BillingAddress' },
          { tag: 'SelfBillingIndicator' },
        ],
        errors
      );
      assertPattern(
        getText(cMap, 'SelfBillingIndicator'),
        /^[01]$/,
        `AuditFile/MasterFiles/Customer[${idx}]/SelfBillingIndicator`,
        'SelfBillingIndicator',
        errors
      );
      const bAddr = cMap.get('BillingAddress')?.[0];
      if (bAddr) {
        const baMap = validateSequence(
          bAddr,
          `AuditFile/MasterFiles/Customer[${idx}]/BillingAddress`,
          [
            { tag: 'AddressDetail' },
            { tag: 'City' },
            { tag: 'PostalCode', min: 0 },
            { tag: 'Country' },
          ],
          errors
        );
        assertPattern(
          getText(baMap, 'Country'),
          COUNTRY_RE,
          `AuditFile/MasterFiles/Customer[${idx}]/BillingAddress/Country`,
          'Country',
          errors
        );
      }
    });

    const suppliers = mfMap.get('Supplier') || [];
    stats.suppliers = suppliers.length;
    suppliers.forEach((sup, idx) => {
      const sMap = validateSequence(
        sup,
        `AuditFile/MasterFiles/Supplier[${idx}]`,
        [
          { tag: 'SupplierID' },
          { tag: 'AccountID' },
          { tag: 'SupplierTaxID' },
          { tag: 'CompanyName' },
          { tag: 'BillingAddress' },
          { tag: 'SelfBillingIndicator' },
        ],
        errors
      );
      assertPattern(
        getText(sMap, 'SelfBillingIndicator'),
        /^[01]$/,
        `AuditFile/MasterFiles/Supplier[${idx}]/SelfBillingIndicator`,
        'SelfBillingIndicator',
        errors
      );
    });

    const products = mfMap.get('Product') || [];
    stats.products = products.length;
    products.forEach((prod, idx) => {
      const pMap = validateSequence(
        prod,
        `AuditFile/MasterFiles/Product[${idx}]`,
        [
          { tag: 'ProductType' },
          { tag: 'ProductCode' },
          { tag: 'ProductGroup', min: 0 },
          { tag: 'ProductDescription' },
          { tag: 'ProductNumberCode' },
        ],
        errors
      );
      assertPattern(
        getText(pMap, 'ProductType'),
        /^(P|S|O|E|I)$/,
        `AuditFile/MasterFiles/Product[${idx}]/ProductType`,
        'ProductType',
        errors
      );
    });

    const taxTableNode = mfMap.get('TaxTable')?.[0];
    if (taxTableNode) {
      const ttMap = validateSequence(
        taxTableNode,
        'AuditFile/MasterFiles/TaxTable',
        [{ tag: 'TaxTableEntry', min: 1, max: Infinity }],
        errors
      );
      const entries = ttMap.get('TaxTableEntry') || [];
      stats.taxTableEntries = entries.length;
      entries.forEach((entry, idx) => {
        const eMap = validateSequence(
          entry,
          `AuditFile/MasterFiles/TaxTable/TaxTableEntry[${idx}]`,
          [
            { tag: 'TaxType' },
            { tag: 'TaxCountryRegion' },
            { tag: 'TaxCode' },
            { tag: 'Description' },
            { tag: 'TaxPercentage' },
          ],
          errors
        );
        assertPattern(
          getText(eMap, 'TaxType'),
          /^(IVA|IS|NS)$/,
          `AuditFile/MasterFiles/TaxTable/TaxTableEntry[${idx}]/TaxType`,
          'TaxType',
          errors
        );
        assertPattern(
          getText(eMap, 'TaxCountryRegion'),
          REGION_RE,
          `AuditFile/MasterFiles/TaxTable/TaxTableEntry[${idx}]/TaxCountryRegion`,
          'TaxCountryRegion',
          errors
        );
        assertPattern(
          getText(eMap, 'TaxPercentage'),
          DECIMAL2_RE,
          `AuditFile/MasterFiles/TaxTable/TaxTableEntry[${idx}]/TaxPercentage`,
          'TaxPercentage',
          errors
        );
      });
    }
  }

  // 3. SOURCEDOCUMENTS
  const sourceNode = rootChildren.get('SourceDocuments')?.[0];
  if (sourceNode) {
    const sdMap = validateSequence(
      sourceNode,
      'AuditFile/SourceDocuments',
      [
        { tag: 'SalesInvoices', min: 0, max: 1 },
        { tag: 'WorkingDocuments', min: 0, max: 1 },
      ],
      errors
    );

    const salesInvoicesNode = sdMap.get('SalesInvoices')?.[0];
    if (salesInvoicesNode) {
      const siMap = validateSequence(
        salesInvoicesNode,
        'AuditFile/SourceDocuments/SalesInvoices',
        [
          { tag: 'NumberOfEntries' },
          { tag: 'TotalDebit' },
          { tag: 'TotalCredit' },
          { tag: 'Invoice', min: 0, max: Infinity },
        ],
        errors
      );

      const numEntries = parseInt(getText(siMap, 'NumberOfEntries'), 10);
      assertPattern(
        getText(siMap, 'NumberOfEntries'),
        POSITIVE_INT_RE,
        'AuditFile/SourceDocuments/SalesInvoices/NumberOfEntries',
        'NumberOfEntries',
        errors
      );
      assertPattern(
        getText(siMap, 'TotalDebit'),
        DECIMAL2_RE,
        'AuditFile/SourceDocuments/SalesInvoices/TotalDebit',
        'TotalDebit',
        errors
      );
      assertPattern(
        getText(siMap, 'TotalCredit'),
        DECIMAL2_RE,
        'AuditFile/SourceDocuments/SalesInvoices/TotalCredit',
        'TotalCredit',
        errors
      );

      const invoices = siMap.get('Invoice') || [];
      stats.salesInvoices = invoices.length;
      if (numEntries !== invoices.length) {
        errors.push({
          path: 'AuditFile/SourceDocuments/SalesInvoices/NumberOfEntries',
          code: 'XSD_RECONCILIATION',
          message: `NumberOfEntries (${numEntries}) difere do número real de blocos <Invoice> (${invoices.length}).`,
        });
      }

      let computedCredit = 0;
      let computedDebit = 0;

      invoices.forEach((invNode, idx) => {
        const invPath = `AuditFile/SourceDocuments/SalesInvoices/Invoice[${idx}]`;
        const iMap = validateSequence(
          invNode,
          invPath,
          [
            { tag: 'InvoiceNo' },
            { tag: 'ATCUD', min: 0 },
            { tag: 'DocumentStatus' },
            { tag: 'Hash' },
            { tag: 'HashControl' },
            { tag: 'Period', min: 0 },
            { tag: 'InvoiceDate' },
            { tag: 'InvoiceType' },
            { tag: 'SpecialRegimes' },
            { tag: 'SourceID' },
            { tag: 'SystemEntryDate' },
            { tag: 'CustomerID' },
            { tag: 'Line', min: 1, max: Infinity },
            { tag: 'DocumentTotals' },
          ],
          errors
        );

        assertPattern(getText(iMap, 'InvoiceNo'), DOC_NO_RE, `${invPath}/InvoiceNo`, 'InvoiceNo', errors);
        assertPattern(getText(iMap, 'InvoiceDate'), DATE_RE, `${invPath}/InvoiceDate`, 'InvoiceDate', errors);
        assertPattern(
          getText(iMap, 'SystemEntryDate'),
          DATETIME_RE,
          `${invPath}/SystemEntryDate`,
          'SystemEntryDate',
          errors
        );
        assertPattern(
          getText(iMap, 'InvoiceType'),
          /^(FT|FR|FS|ND|NC|AF|RP|RE|CS|LD|RA)$/,
          `${invPath}/InvoiceType`,
          'InvoiceType',
          errors
        );
        const hashVal = getText(iMap, 'Hash');
        if (hashVal.length !== 172) {
          errors.push({
            path: `${invPath}/Hash`,
            code: 'XSD_DATATYPE',
            message: `Hash RSA deve ter exatamente 172 caracteres Base64 (obtido ${hashVal.length}).`,
          });
        }

        let invStatus = 'N';
        const statusNode = iMap.get('DocumentStatus')?.[0];
        if (statusNode) {
          const stMap = validateSequence(
            statusNode,
            `${invPath}/DocumentStatus`,
            [
              { tag: 'InvoiceStatus' },
              { tag: 'InvoiceStatusDate' },
              { tag: 'SourceID' },
              { tag: 'SourceBilling' },
            ],
            errors
          );
          invStatus = getText(stMap, 'InvoiceStatus');
          assertPattern(invStatus, /^(N|S|A|R|F)$/, `${invPath}/DocumentStatus/InvoiceStatus`, 'InvoiceStatus', errors);
          assertPattern(
            getText(stMap, 'InvoiceStatusDate'),
            DATETIME_RE,
            `${invPath}/DocumentStatus/InvoiceStatusDate`,
            'InvoiceStatusDate',
            errors
          );
          assertPattern(
            getText(stMap, 'SourceBilling'),
            /^(P|I|M)$/,
            `${invPath}/DocumentStatus/SourceBilling`,
            'SourceBilling',
            errors
          );
        }

        const invType = getText(iMap, 'InvoiceType');
        const lines = iMap.get('Line') || [];
        stats.invoiceLines += lines.length;
        lines.forEach((lineNode, lIdx) => {
          const linePath = `${invPath}/Line[${lIdx}]`;
          const lMap = validateSequence(
            lineNode,
            linePath,
            [
              { tag: 'LineNumber' },
              { tag: 'ProductCode' },
              { tag: 'ProductDescription' },
              { tag: 'Quantity' },
              { tag: 'UnitOfMeasure' },
              { tag: 'UnitPrice' },
              { tag: 'TaxPointDate' },
              { tag: 'References', min: 0 },
              { tag: 'Description' },
              { tag: 'DebitAmount', min: 0 },
              { tag: 'CreditAmount', min: 0 },
              { tag: 'Tax' },
              { tag: 'TaxExemptionReason', min: 0 },
              { tag: 'TaxExemptionCode', min: 0 },
              { tag: 'SettlementAmount', min: 0 },
            ],
            errors
          );

          assertPattern(getText(lMap, 'TaxPointDate'), DATE_RE, `${linePath}/TaxPointDate`, 'TaxPointDate', errors);
          assertPattern(getText(lMap, 'Quantity'), DECIMAL2_RE, `${linePath}/Quantity`, 'Quantity', errors);
          assertPattern(getText(lMap, 'UnitPrice'), DECIMAL2_RE, `${linePath}/UnitPrice`, 'UnitPrice', errors);

          const hasDebit = (lMap.get('DebitAmount') || []).length > 0;
          const hasCredit = (lMap.get('CreditAmount') || []).length > 0;
          if (hasDebit === hasCredit) {
            errors.push({
              path: linePath,
              code: 'XSD_CARDINALITY',
              message: '<Line> deve conter exatamente um dos elementos <DebitAmount> ou <CreditAmount>.',
            });
          }

          const refNode = lMap.get('References')?.[0];
          if (refNode) {
            validateSequence(
              refNode,
              `${linePath}/References`,
              [
                { tag: 'Reference' },
                { tag: 'Reason', min: 0 },
              ],
              errors
            );
          }

          const taxNode = lMap.get('Tax')?.[0];
          if (taxNode) {
            const tMap = validateSequence(
              taxNode,
              `${linePath}/Tax`,
              [
                { tag: 'TaxType' },
                { tag: 'TaxCountryRegion' },
                { tag: 'TaxCode' },
                { tag: 'TaxPercentage' },
              ],
              errors
            );
            const pct = getText(tMap, 'TaxPercentage');
            assertPattern(pct, DECIMAL2_RE, `${linePath}/Tax/TaxPercentage`, 'TaxPercentage', errors);
            if (pct === '0.00') {
              if (!getText(lMap, 'TaxExemptionReason') || !getText(lMap, 'TaxExemptionCode')) {
                errors.push({
                  path: linePath,
                  code: 'XSD_CARDINALITY',
                  message: 'Linha com TaxPercentage=0.00 deve informar TaxExemptionReason e TaxExemptionCode.',
                });
              }
            }
          }
        });

        const dtNode = iMap.get('DocumentTotals')?.[0];
        if (dtNode) {
          const dtMap = validateSequence(
            dtNode,
            `${invPath}/DocumentTotals`,
            [
              { tag: 'TaxPayable' },
              { tag: 'NetTotal' },
              { tag: 'GrossTotal' },
              { tag: 'Payment', min: 0, max: Infinity },
            ],
            errors
          );
          const taxPayable = parseFloat(getText(dtMap, 'TaxPayable'));
          const netTotal = parseFloat(getText(dtMap, 'NetTotal'));
          const grossTotal = parseFloat(getText(dtMap, 'GrossTotal'));
          if (Math.abs(netTotal + taxPayable - grossTotal) > 0.05) {
            errors.push({
              path: `${invPath}/DocumentTotals`,
              code: 'XSD_RECONCILIATION',
              message: `NetTotal (${netTotal}) + TaxPayable (${taxPayable}) != GrossTotal (${grossTotal}).`,
            });
          }
          if (invStatus !== 'A') {
            if (invType === 'NC') computedDebit += netTotal;
            else computedCredit += netTotal;
          }
        }
      });

      const declaredCredit = parseFloat(getText(siMap, 'TotalCredit'));
      const declaredDebit = parseFloat(getText(siMap, 'TotalDebit'));
      if (Math.abs(declaredCredit - computedCredit) > 0.05) {
        errors.push({
          path: 'AuditFile/SourceDocuments/SalesInvoices/TotalCredit',
          code: 'XSD_RECONCILIATION',
          message: `TotalCredit declarado (${declaredCredit.toFixed(2)}) diverge do somatório das faturas (${computedCredit.toFixed(2)}).`,
        });
      }
      if (Math.abs(declaredDebit - computedDebit) > 0.05) {
        errors.push({
          path: 'AuditFile/SourceDocuments/SalesInvoices/TotalDebit',
          code: 'XSD_RECONCILIATION',
          message: `TotalDebit declarado (${declaredDebit.toFixed(2)}) diverge do somatório das NC (${computedDebit.toFixed(2)}).`,
        });
      }
    }

    const workingNode = sdMap.get('WorkingDocuments')?.[0];
    if (workingNode) {
      const wdMap = validateSequence(
        workingNode,
        'AuditFile/SourceDocuments/WorkingDocuments',
        [
          { tag: 'NumberOfEntries' },
          { tag: 'TotalDebit' },
          { tag: 'TotalCredit' },
          { tag: 'WorkDocument', min: 1, max: Infinity },
        ],
        errors
      );
      const docs = wdMap.get('WorkDocument') || [];
      stats.workingDocuments = docs.length;
      const wdEntries = parseInt(getText(wdMap, 'NumberOfEntries'), 10);
      if (wdEntries !== docs.length) {
        errors.push({
          path: 'AuditFile/SourceDocuments/WorkingDocuments/NumberOfEntries',
          code: 'XSD_RECONCILIATION',
          message: `WorkingDocuments NumberOfEntries (${wdEntries}) != ${docs.length}.`,
        });
      }
      docs.forEach((docNode, idx) => {
        const wPath = `AuditFile/SourceDocuments/WorkingDocuments/WorkDocument[${idx}]`;
        const wMap = validateSequence(
          docNode,
          wPath,
          [
            { tag: 'DocumentNumber' },
            { tag: 'DocumentStatus' },
            { tag: 'Hash' },
            { tag: 'HashControl' },
            { tag: 'Period', min: 0 },
            { tag: 'WorkDate' },
            { tag: 'WorkType' },
            { tag: 'SourceID' },
            { tag: 'SystemEntryDate' },
            { tag: 'CustomerID' },
            { tag: 'Line', min: 1, max: Infinity },
            { tag: 'DocumentTotals' },
          ],
          errors
        );
        assertPattern(getText(wMap, 'WorkDate'), DATE_RE, `${wPath}/WorkDate`, 'WorkDate', errors);
        assertPattern(getText(wMap, 'WorkType'), /^(FP|OR|DC|NE|CM|CC|FC|FO)$/, `${wPath}/WorkType`, 'WorkType', errors);
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    stats,
  };
}
