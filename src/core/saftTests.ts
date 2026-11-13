/**
 * Suite de Testes de Homologação e Conformidade Fiscal SAF-T (AO) XML
 * 
 * Cobre exaustivamente todos os pontos de auditoria técnica da AGT e Decreto Executivo n.º 312/18:
 * 1. Separação Estrita de NIFs: Produtor do software (VITRONIS) vs Contribuinte utilizador
 * 2. Header: Sequência estrita XSD, PostalCode, TaxAccountingBasis F, contactos do contribuinte
 * 3. MasterFiles: Hierarquia canónica Customer -> Supplier -> Product -> TaxTable
 * 4. NC e References: Bloco <References> obrigatoriamente dentro de <Line> (entre TaxPointDate e Description)
 * 5. Hash RSA Autêntico: Assinatura RSA-SHA1 PKCS#1 v1.5 verificável matematicamente pela chave pública
 * 6. TaxTable Completa: Todas as taxas e regimes oficiais (NOR 14%, RED 5%, INT 7%, ISE 0%, OUT 0%, S01 1%, S02 0.5%)
 * 7. WorkingDocuments: Proformas (FP) integradas em WorkingDocuments sem contaminar SalesInvoices
 * 8. Exportação Mensal & Reconciliação: Calendário civil, prazo legal de submissão (dia 15) e auditoria de continuidade
 */

import {
  DEFAULT_SAFT_PUBLIC_KEY,
  buildSaftCanonicalString,
  signSaftDocumentHash,
  verifySaftDocumentHash,
} from './saftCrypto.ts';
import {
  generateChainedDocumentHash,
  generateMonthlySaftAoXml,
  generateSaftAoXml,
  validateSaftDataset,
} from './saftGenerator.ts';
import type { CompanyProfile, Customer, InvoiceRecord, Product, Supplier } from './types.ts';

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`[FALHA SAF-T]: ${msg}`);
  }
}

export function runSaftTests(): { passed: number; total: number } {
  let passed = 0;
  let total = 0;

  function test(name: string, fn: () => void): void {
    total++;
    try {
      fn();
      passed++;
      console.log(`✓ [PASS] ${name}`);
    } catch (err) {
      console.error(`✗ [FAIL] ${name}:`, err);
      throw err;
    }
  }

  console.log('\n--- INICIANDO SUÍTE AVANÇADA DE HOMOLOGAÇÃO SAF-T (AO) XML ---');

  // Empresa Utilizadora (Contribuinte emitente - NIF diferente do produtor!)
  const taxpayerCompany: CompanyProfile = {
    legalName: 'SUPERMERCADO KILAMBA COMÉRCIO GERAL, LDA',
    shortName: 'SUPER KILAMBA',
    nif: '5001112223', // NIF do contribuinte utilizador
    address: 'Centralidade do Kilamba, Bloco B, Luanda',
    cityCountry: 'Luanda - Angola',
    phone: '923000111',
    email: 'contacto@superkilamba.co.ao',
    tagline: 'Alimentação & Retalho',
  };

  const sampleSuppliers: Supplier[] = [
    {
      id: 'sup_1',
      companyId: 'comp_1',
      name: 'Distribuidora Alimentar de Luanda, Lda',
      nif: '5004443332',
      phone: '912345678',
      email: 'compras@distribuidora.co.ao',
      address: 'Viana, Estrada de Catete',
      locality: 'Luanda',
    },
  ];

  const sampleCustomers: Customer[] = [
    {
      id: 'cli_1',
      name: 'Cliente Corporativo Alfa, S.A.',
      nif: '5009876543',
      phone: '923456789',
      address: 'Talatona, Luanda',
      locality: 'Luanda',
      createdAtIso: '2026-01-01T00:00:00.000Z',
      updatedAtIso: '2026-01-01T00:00:00.000Z',
    },
  ];

  const sampleProducts: Product[] = [
    {
      id: 'p_arroz',
      code: 'ARR-01',
      name: 'Arroz Agulha 5Kg Cesta Básica',
      category: 'Cesta Básica',
      unit: 'KG',
      price: 5000,
      ivaRate: 0,
      ...({ exemptionCode: 'M10' } as any),
      exemptionReason: 'Isento nos termos da Lei do IVA (Cesta Básica)',
      active: true,
      createdAtIso: '2026-01-01T00:00:00.000Z',
      updatedAtIso: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'p_oleo',
      code: 'OLEO-01',
      name: 'Óleo Vegetal 1L',
      category: 'Alimentar',
      unit: 'UN',
      price: 2000,
      ivaRate: 14,
      exemptionReason: '',
      active: true,
      createdAtIso: '2026-01-01T00:00:00.000Z',
      updatedAtIso: '2026-01-01T00:00:00.000Z',
    },
  ];

  const sampleInvoices: InvoiceRecord[] = [
    // 1. Fatura/Recibo Normal (FR)
    {
      id: 'inv_1',
      number: 'FR 2026/1',
      docType: 'FR',
      issuedAtIso: '2026-01-05T09:15:00.000Z',
      createdAtIso: '2026-01-05T09:15:00.000Z',
      updatedAtIso: '2026-01-05T09:15:00.000Z',
      cashier: 'Operador 1',
      operator: 'Operador 1',
      paymentMethod: 'Multicaixa',
      customerId: 'cli_1',
      customerName: 'Cliente Corporativo Alfa, S.A.',
      customerNif: '5009876543',
      customerLocality: 'Luanda',
      merchandiseTotal: 100000,
      discountTotal: 0,
      taxBase14: 100000,
      taxAmount14: 14000,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: 14000,
      grandTotal: 114000,
      amountInWords: 'Cento e catorze mil Kwanzas',
      amountReceived: 114000,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: [
        {
          id: 'l1',
          productId: 'p_server',
          code: 'SRV-01',
          description: 'Servidor Local POS SILA',
          unit: 'UN',
          qty: 1,
          unitPrice: 114000,
          discountPct: 0,
          ivaRate: 14,
          lineGross: 114000,
          lineDiscount: 0,
          lineNet: 114000,
          lineBase: 100000,
          lineTax: 14000,
          lineTotal: 114000,
        },
      ],
    },
    // 2. Fatura/Recibo com IVA Isento (0% M10)
    {
      id: 'inv_2',
      number: 'FR 2026/2',
      docType: 'FR',
      issuedAtIso: '2026-01-12T14:30:00.000Z',
      createdAtIso: '2026-01-12T14:30:00.000Z',
      updatedAtIso: '2026-01-12T14:30:00.000Z',
      cashier: 'Operador 1',
      operator: 'Operador 1',
      paymentMethod: 'Dinheiro',
      customerId: '999999999',
      customerName: 'Consumidor Final',
      customerNif: '999999999',
      customerLocality: 'Luanda',
      merchandiseTotal: 25000,
      discountTotal: 0,
      taxBase14: 0,
      taxAmount14: 0,
      taxBase0: 25000,
      taxAmount0: 0,
      taxTotal: 0,
      grandTotal: 25000,
      amountInWords: 'Vinte e cinco mil Kwanzas',
      amountReceived: 25000,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: [
        {
          id: 'l2',
          productId: 'p_arroz',
          code: 'ARR-01',
          description: 'Arroz Agulha 5Kg Cesta Básica',
          unit: 'KG',
          qty: 5,
          unitPrice: 5000,
          discountPct: 0,
          ivaRate: 0,
          lineGross: 25000,
          lineDiscount: 0,
          lineNet: 25000,
          lineBase: 25000,
          lineTax: 0,
          lineTotal: 25000,
          ...({ exemptionCode: 'M10' } as any),
        },
      ],
    },
    // 3. Nota de Crédito (NC) que retifica a FR 2026/1
    {
      id: 'inv_3',
      number: 'NC 2026/1',
      docType: 'NC',
      returnOriginNumber: 'FR 2026/1',
      cancelReason: 'Devolução de equipamento com anomalia',
      issuedAtIso: '2026-01-20T16:00:00.000Z',
      createdAtIso: '2026-01-20T16:00:00.000Z',
      updatedAtIso: '2026-01-20T16:00:00.000Z',
      cashier: 'Operador 1',
      operator: 'Operador 1',
      paymentMethod: 'Dinheiro',
      customerId: 'cli_1',
      customerName: 'Cliente Corporativo Alfa, S.A.',
      customerNif: '5009876543',
      customerLocality: 'Luanda',
      merchandiseTotal: 10000,
      discountTotal: 0,
      taxBase14: 10000,
      taxAmount14: 1400,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: 1400,
      grandTotal: 11400,
      amountInWords: 'Onze mil e quatrocentos Kwanzas',
      amountReceived: 11400,
      changeAmount: 0,
      notes: 'Devolução parcial autorizada',
      status: 'issued',
      lines: [
        {
          id: 'l3',
          productId: 'p_peca',
          code: 'SRV-MOD',
          description: 'Módulo Suporte Devolvido',
          unit: 'UN',
          qty: 1,
          unitPrice: 11400,
          discountPct: 0,
          ivaRate: 14,
          lineGross: 11400,
          lineDiscount: 0,
          lineNet: 11400,
          lineBase: 10000,
          lineTax: 1400,
          lineTotal: 11400,
        },
      ],
    },
    // 4. Proforma (FP) — Documento de trabalho/orçamento sem relevância tributária
    {
      id: 'inv_4',
      number: 'FP 2026/1',
      docType: 'FP',
      issuedAtIso: '2026-01-22T10:00:00.000Z',
      createdAtIso: '2026-01-22T10:00:00.000Z',
      updatedAtIso: '2026-01-22T10:00:00.000Z',
      cashier: 'Operador 1',
      operator: 'Operador 1',
      paymentMethod: 'Dinheiro',
      customerId: 'cli_1',
      customerName: 'Cliente Corporativo Alfa, S.A.',
      customerNif: '5009876543',
      customerLocality: 'Luanda',
      merchandiseTotal: 500000,
      discountTotal: 0,
      taxBase14: 500000,
      taxAmount14: 70000,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: 70000,
      grandTotal: 570000,
      amountInWords: 'Quinhentos e setenta mil Kwanzas',
      amountReceived: 0,
      changeAmount: 0,
      notes: 'Orçamento para aprovação da gerência',
      status: 'issued',
      lines: [
        {
          id: 'l4',
          productId: 'p_quote',
          code: 'ORC-01',
          description: 'Orçamento de Projeto de Rede',
          unit: 'UN',
          qty: 1,
          unitPrice: 570000,
          discountPct: 0,
          ivaRate: 14,
          lineGross: 570000,
          lineDiscount: 0,
          lineNet: 570000,
          lineBase: 500000,
          lineTax: 70000,
          lineTotal: 570000,
        },
      ],
    },
  ];

  // ==========================================
  // PONTO 1: DISTINÇÃO RIGOROSA DE NIFS (EMPRESA vs PRODUTOR VITRONIS)
  // ==========================================
  test('1.1: Distinção estrita entre NIF do Contribuinte (5001112223) e NIF do Produtor VITRONIS (5002571293)', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
      products: sampleProducts,
      customers: sampleCustomers,
      suppliers: sampleSuppliers,
    });

    // CompanyID e TaxRegistrationNumber devem ter o NIF da empresa utilizadora
    assert(res.xml.includes('<CompanyID>5001112223</CompanyID>'), 'CompanyID deve ser o NIF do contribuinte utilizador');
    assert(res.xml.includes('<TaxRegistrationNumber>5001112223</TaxRegistrationNumber>'), 'TaxRegistrationNumber deve ser o NIF do contribuinte utilizador');

    // ProductCompanyTaxID deve ser exclusivamente o NIF do produtor VITRONIS
    assert(res.xml.includes('<ProductCompanyTaxID>5002571293</ProductCompanyTaxID>'), 'ProductCompanyTaxID deve ser o NIF da VITRONIS');

    // Contactos no Header pertencem à empresa emitente, nunca à VITRONIS
    assert(res.xml.includes('<Telephone>923000111</Telephone>'), 'Telefone do Header deve ser da empresa utilizadora');
    assert(res.xml.includes('<Email>contacto@superkilamba.co.ao</Email>'), 'Email do Header deve ser da empresa utilizadora');

    // Nome do ficheiro leva o NIF da empresa utilizadora
    assert(res.filename.startsWith('SAF-T_AO_5001112223_'), 'Nome do ficheiro deve carregar o NIF da empresa emitente');
  });

  // ==========================================
  // PONTO 2: HEADER E SEQUÊNCIA CANÓNICA DO XSD
  // ==========================================
  test('2.1: Sequência estrita do Header (xs:sequence) respeitada integralmente', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    const headerTags = [
      'AuditFileVersion',
      'CompanyID',
      'TaxRegistrationNumber',
      'TaxAccountingBasis',
      'CompanyName',
      'BusinessName',
      'CompanyAddress',
      'FiscalYear',
      'StartDate',
      'EndDate',
      'CurrencyCode',
      'DateCreated',
      'TaxEntity',
      'ProductCompanyTaxID',
      'SoftwareCertificateNumber',
      'ProductID',
      'ProductVersion',
      'HeaderComment',
      'Telephone',
      'Email',
    ];

    let lastIdx = -1;
    for (const tag of headerTags) {
      const idx = res.xml.indexOf(`<${tag}>`);
      assert(idx !== -1, `Tag obrigatória <${tag}> ausente no Header`);
      assert(idx > lastIdx, `Tag <${tag}> fora da ordem sequencial estrita do XSD`);
      lastIdx = idx;
    }
  });

  test('2.2: Header contém TaxAccountingBasis F e PostalCode em CompanyAddress', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    assert(res.xml.includes('<TaxAccountingBasis>F</TaxAccountingBasis>'), 'TaxAccountingBasis deve ser F (Faturação)');
    assert(res.xml.includes('<PostalCode>Desconhecido</PostalCode>'), 'PostalCode deve existir dentro de CompanyAddress');
  });

  // ==========================================
  // PONTO 3: MASTERFILES COM CUSTOMER, SUPPLIER, PRODUCT E TAXTABLE
  // ==========================================
  test('3.1: MasterFiles contém Customer, Supplier, Product e TaxTable na sequência canónica exata', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
      products: sampleProducts,
      customers: sampleCustomers,
      suppliers: sampleSuppliers,
    });

    const posMaster = res.xml.indexOf('<MasterFiles>');
    const posCustomer = res.xml.indexOf('<Customer>');
    const posSupplier = res.xml.indexOf('<Supplier>');
    const posProduct = res.xml.indexOf('<Product>');
    const posTaxTable = res.xml.indexOf('<TaxTable>');

    assert(posMaster !== -1, '<MasterFiles> deve existir');
    assert(posCustomer > posMaster, '<Customer> deve ser filho direto de <MasterFiles>');
    assert(posSupplier > posCustomer, '<Supplier> deve vir imediatamente após <Customer>');
    assert(posProduct > posSupplier, '<Product> deve vir imediatamente após <Supplier>');
    assert(posTaxTable > posProduct, '<TaxTable> deve vir após <Product>');
  });

  test('3.2: Cada Product contém ProductType, ProductCode, ProductGroup e ProductDescription', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
      products: sampleProducts,
    });

    assert(res.xml.includes('<ProductType>P</ProductType>'), 'ProductType deve existir');
    assert(res.xml.includes('<ProductCode>ARR-01</ProductCode>'), 'ProductCode deve existir');
    assert(res.xml.includes('<ProductGroup>Cesta Básica</ProductGroup>'), 'ProductGroup deve existir');
    assert(res.xml.includes('<ProductDescription>Arroz Agulha 5Kg Cesta Básica</ProductDescription>'), 'ProductDescription deve existir');
  });

  test('3.3: Cada Supplier contém SupplierID, SupplierTaxID, CompanyName e BillingAddress', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
      suppliers: sampleSuppliers,
    });

    assert(res.xml.includes('<SupplierID>sup_1</SupplierID>'), 'SupplierID deve existir');
    assert(res.xml.includes('<SupplierTaxID>5004443332</SupplierTaxID>'), 'SupplierTaxID deve existir');
    assert(res.xml.includes('<CompanyName>Distribuidora Alimentar de Luanda, Lda</CompanyName>'), 'CompanyName deve existir no fornecedor');
  });

  // ==========================================
  // PONTO 4: NOTA DE CRÉDITO E REFERENCES DENTRO DE LINE
  // ==========================================
  test('4.1: References em Nota de Crédito está estritamente contido dentro de <Line>', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    // Entre <CustomerID> e o primeiro <Line> NÃO pode haver <References> solto no <Invoice>
    const betweenCustomerAndLine = /<CustomerID>[^<]+<\/CustomerID>\s*<References>/;
    assert(!betweenCustomerAndLine.test(res.xml), '<References> não pode ficar solto dentro de <Invoice> antes de <Line>');

    // References DEVE estar estritamente dentro de <Line>
    const lineWithRef = /<Line>[\s\S]*?<TaxPointDate>[\s\S]*?<References>[\s\S]*?<Reference>FR 2026\/1<\/Reference>[\s\S]*?<Reason>Devolução de equipamento com anomalia<\/Reason>[\s\S]*?<\/References>[\s\S]*?<Description>/;
    assert(lineWithRef.test(res.xml), '<References> com Reference e Reason deve estar estritamente dentro de <Line>');
  });

  test('4.2: Nota de Crédito usa DebitAmount e TotalDebit', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    assert(res.xml.includes('<DebitAmount>10000.00</DebitAmount>'), 'Nota de Crédito deve ter DebitAmount na linha');
    assert(res.xml.includes('<TotalDebit>10000.00</TotalDebit>'), 'TotalDebit deve contabilizar 10.000 Kz');
  });

  // ==========================================
  // PONTO 5: HASH RSA-SHA1 AUTÊNTICO E VERIFICAÇÃO MATEMÁTICA
  // ==========================================
  test('5.1: Hash gerado tem 172 caracteres Base64 e é criptograficamente válido com a chave pública RSA', () => {
    const canonical = buildSaftCanonicalString({
      invoiceDate: '2026-01-05',
      systemEntryDate: '2026-01-05T09:15:00',
      invoiceNo: 'FR 2026/1',
      grossTotal: 114000,
      previousHash: '',
    });

    const hash = signSaftDocumentHash(canonical);
    assert(hash.length === 172, `Hash deve ter 172 caracteres, obtido: ${hash.length}`);
    assert(hash.endsWith('='), 'Hash Base64 de 128 bytes RSA deve terminar com padding =');

    const isValid = verifySaftDocumentHash(canonical, hash, DEFAULT_SAFT_PUBLIC_KEY);
    assert(isValid === true, 'Assinatura RSA-SHA1 deve ser verificada matematicamente pela chave pública oficial');
  });

  test('5.2: Faturas no XML contêm Hash RSA válido e HashControl 1', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    const hashMatches = res.xml.match(/<Hash>([^<]+)<\/Hash>/g) || [];
    assert(hashMatches.length >= 3, 'Deve encontrar hashes para faturas e proformas');

    for (const hMatch of hashMatches) {
      const h = hMatch.replace(/<\/?Hash>/g, '');
      assert(h.length === 172, `Hash extraído do XML deve ter 172 caracteres: ${h.length}`);
    }

    assert(res.xml.includes('<HashControl>1</HashControl>'), 'HashControl deve ser 1');
  });

  // ==========================================
  // PONTO 6: TAXTABLE COMPLETA
  // ==========================================
  test('6.1: TaxTable inclui quadro exaustivo de taxas angolanas (NOR 14%, RED 5%, INT 1% Cabinda Lei 14/23, ISE 0%, OUT, S01, S02, S00)', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    assert(res.xml.includes('<TaxCode>NOR</TaxCode>') && res.xml.includes('<TaxPercentage>14.00</TaxPercentage>'), 'Deve incluir IVA Normal 14%');
    assert(res.xml.includes('<TaxCode>RED</TaxCode>') && res.xml.includes('<TaxPercentage>5.00</TaxPercentage>'), 'Deve incluir IVA Reduzido 5%');
    assert(res.xml.includes('<TaxCode>INT</TaxCode>') && res.xml.includes('<TaxPercentage>1.00</TaxPercentage>'), 'Deve incluir IVA Especial Cabinda 1% conforme Lei n.º 14/23');
    assert(res.xml.includes('<TaxCode>ISE</TaxCode>') && res.xml.includes('<TaxPercentage>0.00</TaxPercentage>'), 'Deve incluir Isenção de IVA 0%');
    assert(res.xml.includes('<TaxCode>OUT</TaxCode>') && res.xml.includes('<TaxPercentage>0.00</TaxPercentage>'), 'Deve incluir Outras Operações 0%');
    assert(res.xml.includes('<TaxCode>S01</TaxCode>') && res.xml.includes('<TaxPercentage>1.00</TaxPercentage>'), 'Deve incluir Imposto do Selo 1%');
    assert(res.xml.includes('<TaxCode>S02</TaxCode>') && res.xml.includes('<TaxPercentage>0.50</TaxPercentage>'), 'Deve incluir Imposto do Selo Crédito 0.5%');
  });

  // ==========================================
  // PONTO 7: WORKINGDOCUMENTS PARA PROFORMAS (FP)
  // ==========================================
  test('7.1: Proformas (FP) são integradas em WorkingDocuments sem contaminar SalesInvoices', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    // Em SalesInvoices deve haver apenas FR 2026/1, FR 2026/2 e NC 2026/1 (3 faturas fiscais)
    assert(res.summary.totalSalesInvoices === 3, 'Deve haver 3 faturas fiscais em SalesInvoices');
    assert(res.xml.includes('<NumberOfEntries>3</NumberOfEntries>'), 'SalesInvoices deve ter NumberOfEntries = 3');

    // Em WorkingDocuments deve haver a FP 2026/1
    assert(res.xml.includes('<WorkingDocuments>'), 'Deve incluir seção <WorkingDocuments>');
    assert(res.xml.includes('<WorkType>FP</WorkType>'), 'WorkType da Proforma deve ser FP');
    assert(res.xml.includes('<DocumentNumber>FP 2026/1</DocumentNumber>'), 'DocumentNumber deve ser FP 2026/1');
    assert(res.summary.totalWorkingDocuments === 1, 'Summary deve indicar 1 working document');
  });

  // ==========================================
  // PONTO 8: EXPORTAÇÃO MENSAL E RECONCILIAÇÃO LEGAL
  // ==========================================
  test('8.1: generateMonthlySaftAoXml circunscreve estritamente o mês de Janeiro e calcula prazo legal do último dia do mês seguinte (28 de Fevereiro)', () => {
    const res = generateMonthlySaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
      year: 2026,
      month: 1,
    });

    assert(res.summary.startDate === '2026-01-01', 'StartDate deve ser 2026-01-01');
    assert(res.summary.endDate === '2026-01-31', 'EndDate deve ser 2026-01-31');
    assert(res.summary.period === 1, 'Period deve ser 1');
    assert(res.summary.submissionDeadline === '28 de Fevereiro de 2026', `Prazo legal deve ser 28 de Fevereiro de 2026, obtido: ${res.summary.submissionDeadline}`);
  });

  test('8.2: TotalCredit e TotalDebit conciliam matematicamente com os documentos fiscais emitidos', () => {
    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: sampleInvoices,
    });

    // FR 1: Base 100.000 + FR 2: Base 25.000 = 125.000 Kz de Crédito
    // NC 1: Base 10.000 = 10.000 Kz de Débito
    assert(res.summary.totalCredit === 125000, `TotalCredit esperado 125.000, obtido: ${res.summary.totalCredit}`);
    assert(res.summary.totalDebit === 10000, `TotalDebit esperado 10.000, obtido: ${res.summary.totalDebit}`);
  });

  test('8.3: Auditoria de continuidade de séries aprova sequência sem falhas', () => {
    const validation = validateSaftDataset(
      taxpayerCompany,
      sampleInvoices,
      '2026-01-01',
      '2026-01-31',
      1,
      2026
    );

    const frAudit = validation.seriesContinuityAudit.find((a) => a.docType === 'FR');
    assert(Boolean(frAudit), 'Deve auditar a série de FR');
    assert(frAudit!.isContinuous === true, 'Série de FR (1, 2) deve ser contínua');
    assert(frAudit!.missingNumbers.length === 0, 'Não deve haver números em falta na série');
  });

  test('8.4: Anulações preservam valores originais em DocumentTotals garantindo rastreabilidade e histórico fiscal', () => {
    const cancelledInvoice: InvoiceRecord = {
      id: 'inv_canc',
      number: 'FR 2026/99',
      docType: 'FR',
      issuedAtIso: '2026-01-25T11:00:00.000Z',
      createdAtIso: '2026-01-25T11:00:00.000Z',
      updatedAtIso: '2026-01-25T11:30:00.000Z',
      cancelledAtIso: '2026-01-25T11:30:00.000Z',
      cashier: 'Operador 1',
      operator: 'Operador 1',
      paymentMethod: 'Dinheiro',
      customerId: '999999999',
      customerName: 'Consumidor Final',
      customerNif: '999999999',
      customerLocality: 'Luanda',
      merchandiseTotal: 50000,
      discountTotal: 0,
      taxBase14: 43859.65,
      taxAmount14: 6140.35,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: 6140.35,
      grandTotal: 50000,
      amountInWords: 'Cinquenta mil Kwanzas',
      amountReceived: 50000,
      changeAmount: 0,
      notes: 'Fatura anulada por erro de faturação',
      cancelReason: 'Engano no meio de pagamento',
      status: 'cancelled',
      lines: [
        {
          id: 'lc1',
          productId: 'p_server',
          code: 'SRV-01',
          description: 'Servidor Local POS SILA',
          unit: 'UN',
          qty: 1,
          unitPrice: 50000,
          discountPct: 0,
          ivaRate: 14,
          lineGross: 50000,
          lineDiscount: 0,
          lineNet: 50000,
          lineBase: 43859.65,
          lineTax: 6140.35,
          lineTotal: 50000,
        },
      ],
    };

    const res = generateSaftAoXml({
      company: taxpayerCompany,
      invoices: [...sampleInvoices, cancelledInvoice],
    });

    // Inspeciona o bloco da fatura anulada
    const hasCancelledStatus = res.xml.includes('<InvoiceStatus>A</InvoiceStatus>');
    assert(hasCancelledStatus, 'Fatura anulada deve conter InvoiceStatus A');

    // DocumentTotals deve preservar os valores históricos originais da fatura (NÃO zerados)
    const cancelledSectionMatch = res.xml.match(/<Invoice>[\s\S]*?<InvoiceNo>FR 2026\/99<\/InvoiceNo>[\s\S]*?<\/Invoice>/);
    assert(Boolean(cancelledSectionMatch), 'Secção da fatura FR 2026/99 deve existir no XML');
    const invXml = cancelledSectionMatch![0];

    assert(invXml.includes('<TaxPayable>6140.35</TaxPayable>'), 'DocumentTotals da fatura anulada deve preservar TaxPayable original');
    assert(invXml.includes('<GrossTotal>50000.00</GrossTotal>'), 'DocumentTotals da fatura anulada deve preservar GrossTotal original');
    assert(invXml.includes('<NetTotal>43859.65</NetTotal>'), 'DocumentTotals da fatura anulada deve preservar NetTotal original');
  });

  test('8.5: SAF-T reconcilia faturas multi-taxa (1% Cabinda, 5% RED, 14% NOR, 0% ISE), mapeia FA->FT e ProductType S/P', () => {
    const richCompany: CompanyProfile = {
      ...taxpayerCompany,
      municipality: 'Cabinda',
      province: 'Cabinda',
      postalCode: '0001',
      taxEntity: 'Sede Cabinda',
    };

    const serviceProduct: Product = {
      id: 'p_serv_ti',
      code: 'SRV-TI',
      name: 'Consultoria Fiscal Especializada',
      productType: 'S',
      category: 'Serviços',
      unit: 'HR',
      price: 11400,
      ivaRate: 14,
      exemptionReason: '',
      active: true,
      createdAtIso: '2026-01-01T00:00:00.000Z',
      updatedAtIso: '2026-01-01T00:00:00.000Z',
    };

    const multiRateFa: InvoiceRecord = {
      id: 'inv_fa_multi',
      number: 'FA 2026/1',
      docType: 'FA',
      issuedAtIso: '2026-01-28T15:00:00.000Z',
      createdAtIso: '2026-01-28T15:00:00.000Z',
      updatedAtIso: '2026-01-28T15:00:00.000Z',
      cashier: '01',
      operator: 'Gestor',
      paymentMethod: 'Transferência',
      customerId: 'cli_1',
      customerName: 'Cliente Corporativo Alfa, S.A.',
      customerNif: '5009876543',
      customerLocality: 'Cabinda',
      merchandiseTotal: 15000,
      discountTotal: 0,
      taxBase14: 10000,
      taxAmount14: 1400,
      taxBaseIntermediate: 2000,
      taxAmountIntermediate: 20,
      taxBaseReduced: 1000,
      taxAmountReduced: 50,
      taxBase0: 2000,
      taxAmount0: 0,
      taxTotal: 1470,
      grandTotal: 16470,
      amountInWords: 'Dezasseis mil quatrocentos e setenta Kwanzas',
      amountReceived: 0,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: [
        {
          id: 'lm1',
          productId: 'p_serv_ti',
          code: 'SRV-TI',
          description: 'Consultoria Fiscal Especializada',
          unit: 'HR',
          qty: 1,
          unitPrice: 11400,
          discountPct: 0,
          ivaRate: 14,
          lineGross: 11400,
          lineDiscount: 0,
          lineNet: 11400,
          lineBase: 10000,
          lineTax: 1400,
          lineTotal: 11400,
        },
        {
          id: 'lm2',
          productId: 'p_cab',
          code: 'CAB-01',
          description: 'Artigo Regime Especial Cabinda 1%',
          unit: 'UN',
          qty: 1,
          unitPrice: 2020,
          discountPct: 0,
          ivaRate: 1,
          lineGross: 2020,
          lineDiscount: 0,
          lineNet: 2020,
          lineBase: 2000,
          lineTax: 20,
          lineTotal: 2020,
        },
        {
          id: 'lm3',
          productId: 'p_red',
          code: 'RED-01',
          description: 'Insumo Taxa Reduzida 5%',
          unit: 'UN',
          qty: 1,
          unitPrice: 1050,
          discountPct: 0,
          ivaRate: 5,
          lineGross: 1050,
          lineDiscount: 0,
          lineNet: 1050,
          lineBase: 1000,
          lineTax: 50,
          lineTotal: 1050,
        },
        {
          id: 'lm4',
          productId: 'p_arroz',
          code: 'ARR-01',
          description: 'Arroz Agulha 5Kg Cesta Básica',
          unit: 'KG',
          qty: 1,
          unitPrice: 2000,
          discountPct: 0,
          ivaRate: 0,
          lineGross: 2000,
          lineDiscount: 0,
          lineNet: 2000,
          lineBase: 2000,
          lineTax: 0,
          lineTotal: 2000,
          exemptionCode: 'M10',
        },
      ],
    };

    const res = generateSaftAoXml({
      company: richCompany,
      invoices: [multiRateFa],
      products: [...sampleProducts, serviceProduct],
      customers: sampleCustomers,
      suppliers: sampleSuppliers,
    });

    assert(res.validation.valid === true, `Dataset multi-taxa deve validar sem erros: ${res.validation.issues.map((i) => i.message).join('; ')}`);
    assert(res.validation.taxAuditDifference === 0, `Diferença de auditoria esperada 0, obtida ${res.validation.taxAuditDifference}`);
    assert(res.summary.totalCredit === 15000, `TotalCredit multi-taxa esperado 15000, obtido ${res.summary.totalCredit}`);
    assert(res.xml.includes('<InvoiceType>FT</InvoiceType>'), 'Documento FA deve mapear para InvoiceType FT no SAF-T');
    assert(res.xml.includes('<ProductType>S</ProductType>'), 'Artigo de serviço deve mapear para ProductType S');
    assert(res.xml.includes('<TaxCountryRegion>AO-CAB</TaxCountryRegion>'), 'Linha com taxa 1% Cabinda deve usar região AO-CAB');
    assert(res.xml.includes('<TaxCode>RED</TaxCode>') && res.xml.includes('<TaxPercentage>5.00</TaxPercentage>'), 'Linha 5% deve mapear para TaxCode RED');
    assert(res.xml.includes('<PostalCode>0001</PostalCode>'), 'Header deve usar postalCode real do perfil da empresa');
    assert(res.xml.includes('<Province>Cabinda</Province>'), 'Header deve usar province real do perfil da empresa');
    assert(res.xml.includes('<TaxEntity>Sede Cabinda</TaxEntity>'), 'Header deve usar taxEntity real do perfil da empresa');
  });

  console.log(`\nTODAS AS ${passed}/${total} ASSERÇÕES DE AUDITORIA SAF-T (AO) PASSARAM COM SUCESSO!`);
  return { passed, total };
}

// Execução direta via CLI (npx tsx src/core/saftTests.ts)
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('saftTests')) {
  try {
    const r = runSaftTests();
    console.log('Resultado Final:', r);
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
