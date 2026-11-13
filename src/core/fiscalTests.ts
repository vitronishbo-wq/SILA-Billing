/**
 * Suite de Verificação e Auditoria Fiscal Automatizada
 * Validação ponta-a-ponta do Motor Tributário (Fase 2) e Gestão de Séries AGT (Fase 3).
 */

import {
  calculateInvoiceTotals,
  generateNextInvoiceNumber,
} from './billingEngine.ts';
import {
  COMPANY_MASTER_FIELD_REGISTRY,
  evaluateCompanyMasterCompleteness,
  resolveActiveEstablishment,
  resolveDefaultExemptionCodeForCompany,
  validateAngolaIban,
  validateLogoDataUrl,
} from './companyValidator.ts';
import {
  AGT_DOCUMENT_TYPES,
  isSeriesCreationAllowedForYear,
} from './fiscalTypes.ts';
import {
  finalizarSerie,
  getSeriesSummaryByEnvironment,
  inicializarSeriesPadraoSeNecessario,
  listarSeries,
  mergeSeriesFromCloud,
  normalizeSeriesEnvironment,
  obterSerieAtiva,
  reservarProximoNumeroFiscal,
  seriesStorage,
  solicitarSerie,
  validarPermissaoEmissaoFiscal,
} from './seriesManager.ts';
import {
  calculateAgtDocumentTotals,
  calculateAgtLineItem,
  convertCartItemsToAgtLines,
  roundUpToCent,
  validateAgtTaxCompliance,
} from './taxEngine.ts';
import {
  buildInvoiceIssuerSnapshot,
  createDefaultEstablishmentForCompany,
  DEFAULT_SETTINGS,
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  resolveCompanyProfileFromSnapshot,
  VITRONIS_INSTITUTIONAL,
  type CompanyRecord,
  type InvoiceRecord,
} from './types.ts';
import {
  buildAgtQrCanonicalString,
  generateAgtQrDataUrl,
  generateAgtQrSvg,
  parseAgtQrString,
} from './fiscalQrGenerator.ts';
import type { AgtDocumentPayload } from './fiscalTypes.ts';
import { computeDocumentSaftHash4 } from './saftGenerator.ts';
import {
  generateInvoiceQrDataUrl,
  renderDocumentHtml,
} from '../../frontend/ui/documentRenderer.ts';
import {
  extractSettingsFromFormData,
  renderCompanyMasterSection,
} from '../../frontend/ui/companyMasterForm.ts';
import { agtClient } from '../../backend/services/agtClient.ts';
import {
  cryptoSignerStore,
  signAgtDocument,
  verifyJwsCompact,
} from '../../backend/services/cryptoSigner.ts';

function assert(condition: boolean, msg: string): void {
  if (!condition) {
    throw new Error(`FALHA NA ASSERÇÃO: ${msg}`);
  }
}

export async function runFiscalTests(): Promise<{ passed: number; total: number }> {
  let passed = 0;
  let total = 0;

  async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
    total++;
    try {
      await fn();
      passed++;
      console.log(`✓ [PASS] ${name}`);
    } catch (err) {
      console.error(`✗ [FAIL] ${name}:`, err);
      throw err;
    }
  }

  console.log('\n--- INICIANDO TESTES DO MOTOR TRIBUTÁRIO (FASE 2) ---');

  await test('Arredondamento por excesso ao cêntimo (roundUpToCent)', () => {
    assert(roundUpToCent(10.0001) === 10.01, '10.0001 deve arredondar para 10.01');
    assert(roundUpToCent(10.00) === 10.00, '10.00 deve manter 10.00');
    assert(roundUpToCent(14.120001) === 14.13, '14.120001 deve arredondar para 14.13');
    assert(roundUpToCent(0.001) === 0.01, '0.001 deve arredondar para 0.01');
    assert(roundUpToCent(0) === 0, '0 deve retornar 0');
  });

  await test('Cálculo de linha com IVA 14% (preço com imposto incluído)', () => {
    const line = calculateAgtLineItem({
      lineNumber: 1,
      productCode: 'PROD_TEST',
      productDescription: 'Artigo Geral 14%',
      quantity: 2,
      unitPrice: 5700, // 2 * 5700 = 11.400 Kz com IVA incluído
      unitPriceIncludesTax: true,
      taxCode: 'NOR',
      taxPercentage: 14,
    });

    // 11400 / 1.14 = 10000.00
    assert(line.taxableBase === 10000, `Base esperada 10000, obtida ${line.taxableBase}`);
    // 10000 * 0.14 = 1400.00
    assert(line.taxContribution === 1400, `IVA esperado 1400, obtido ${line.taxContribution}`);
    assert(line.lineTotal === 11400, `Total esperado 11400, obtido ${line.lineTotal}`);
    assert(line.taxCode === 'NOR', 'Código deve ser NOR');
  });

  await test('Cálculo de linha isenta (0%) exige e valida código de isenção', () => {
    const line = calculateAgtLineItem({
      lineNumber: 2,
      productCode: 'CESTA_BASICA',
      productDescription: 'Arroz Nacional',
      quantity: 5,
      unitPrice: 1000,
      taxCode: 'ISE',
      taxPercentage: 0,
      exemptionCode: 'M10', // Cesta Básica
    });

    assert(line.taxableBase === 5000, 'Base de artigo isento deve ser o valor líquido total');
    assert(line.taxContribution === 0, 'IVA de artigo isento deve ser 0');
    assert(line.exemptionCode === 'M10', 'Código de isenção M10 deve estar presente');

    const compliance = validateAgtTaxCompliance([line]);
    assert(compliance.valid, 'Conformidade de artigo isento com M10 deve ser válida');
  });

  await test('Validação de conformidade deteta falta de código de isenção', () => {
    // Linha com 0% mas sem código de isenção válido
    const invalidLine = calculateAgtLineItem({
      lineNumber: 3,
      productCode: 'INVALID_ISE',
      productDescription: 'Serviço Isento Sem Fundamento',
      quantity: 1,
      unitPrice: 2000,
      taxCode: 'ISE',
      taxPercentage: 0,
    });
    // Forçar ausência de código de isenção para testar validador
    invalidLine.exemptionCode = undefined;

    const compliance = validateAgtTaxCompliance([invalidLine]);
    assert(!compliance.valid, 'Deve falhar conformidade quando artigo isento não tem exemptionCode');
    assert(compliance.errors.length > 0, 'Deve conter mensagem explicativa de erro');
  });

  await test('Consolidação de totais com Imposto do Selo e Retenção II', () => {
    const line = calculateAgtLineItem({
      lineNumber: 1,
      productCode: 'HONORARIOS',
      productDescription: 'Prestação de Serviços de TI',
      quantity: 1,
      unitPrice: 100000,
      unitPriceIncludesTax: false,
      taxCode: 'NOR',
      taxPercentage: 14,
      stampTaxCode: 'S01',
      stampTaxRatePct: 1, // 1% Selo
    });

    const doc = calculateAgtDocumentTotals([line], {
      withholdingTaxes: [{ type: 'II', ratePct: 6.5, reason: 'Retenção na fonte Imposto Industrial' }],
    });

    assert(doc.totals.merchandiseTotalNet === 100000, 'Base líquida 100.000 Kz');
    assert(doc.totals.totalTaxAmountNOR === 14000, 'IVA 14.000 Kz');
    assert(doc.totals.totalStampTax === 1000, 'Selo 1.000 Kz');
    assert(doc.totals.totalWithholdingTax === 6500, 'Retenção II 6,5% = 6.500 Kz');
    // Total bruto: 100000 + 14000 + 1000 = 115000
    assert(doc.totals.grossTotal === 115000, `Bruto esperado 115000, obtido ${doc.totals.grossTotal}`);
    // Líquido a pagar: 115000 - 6500 = 108500
    assert(doc.totals.netPayableTotal === 108500, `Líquido esperado 108500, obtido ${doc.totals.netPayableTotal}`);
  });

  console.log('\n--- INICIANDO TESTES DE GESTÃO DE SÉRIES AGT (FASE 3) ---');

  const testCompanyId = 'comp_test_fiscal_series_' + Date.now();
  seriesStorage.clearMemoryCache();

  await test('Regra de 15 de Dezembro para abertura de séries de novo ano', () => {
    const currentYear = new Date().getFullYear();

    // Ano passado: proibido
    const pastCheck = isSeriesCreationAllowedForYear(currentYear - 1);
    assert(!pastCheck.allowed, 'Não deve permitir criar série para ano transato');

    // Ano corrente: permitido
    const currentCheck = isSeriesCreationAllowedForYear(currentYear);
    assert(currentCheck.allowed, 'Deve permitir criar série para o ano corrente');

    // Ano seguinte: depende se estamos em ou após 15 de Dezembro
    const mockRefDateBefore15Dec = new Date(currentYear, 10, 10); // Novembro
    const nextYearEarly = isSeriesCreationAllowedForYear(currentYear + 1, mockRefDateBefore15Dec);
    assert(!nextYearEarly.allowed, 'Não deve permitir criar série do próximo ano antes de 15 de Dezembro');

    const mockRefDateAfter15Dec = new Date(currentYear, 11, 16); // 16 de Dezembro
    const nextYearLate = isSeriesCreationAllowedForYear(currentYear + 1, mockRefDateAfter15Dec);
    assert(nextYearLate.allowed, 'Deve permitir criar série do próximo ano a partir de 15 de Dezembro');
  });

  await test('solicitarSerie regista série com estado inicial A e autorização AGT', () => {
    const year = new Date().getFullYear();
    const series = solicitarSerie({
      companyId: testCompanyId,
      seriesCode: `A${year}`,
      seriesYear: year,
      documentType: 'FR',
      firstDocumentNumber: 1,
      operator: 'AuditOp',
      notes: 'Série de teste automatizado',
    });

    assert(series.status === 'A', 'Estado inicial da série deve ser A (Ativa)');
    assert(series.lastDocumentNumber === 0, 'lastDocumentNumber inicial deve ser 0');
    assert(series.firstDocumentNumber === 1, 'firstDocumentNumber deve ser 1');
    assert(series.agtAuthorizationCode?.startsWith(`AGT-AUT-${year}-FR-`) === true, 'Código de autorização AGT deve ser gerado');
  });

  await test('listarSeries recupera séries cadastradas com filtros', () => {
    const year = new Date().getFullYear();
    const list = listarSeries({ companyId: testCompanyId, documentType: 'FR' });
    assert(list.length === 1, 'Deve listar a série FR criada');
    assert(list[0]!.documentType === 'FR', 'Tipo deve ser FR');
    assert(list[0]!.seriesCode === `A${year}`, `Código da série deve ser A${year}`);
  });

  await test('reservarProximoNumeroFiscal avança sequência e transita estado A para U', () => {
    const year = new Date().getFullYear();
    const activeBefore = obterSerieAtiva(testCompanyId, 'FR', year);
    assert(activeBefore?.status === 'A', 'Série deve estar em estado A antes da primeira emissão');

    // Primeira emissão
    const res1 = reservarProximoNumeroFiscal(testCompanyId, 'FR', year);
    assert(res1.sequenceNumber === 1, 'Primeiro número deve ser 1');
    assert(res1.documentNo === `FR A${year}/000001`, `Número formatado esperado FR A${year}/000001, obtido ${res1.documentNo}`);
    assert(res1.status === 'U', 'Estado deve transitar para U (Em Uso)');

    // Segunda emissão contígua (sem saltos)
    const res2 = reservarProximoNumeroFiscal(testCompanyId, 'FR', year);
    assert(res2.sequenceNumber === 2, 'Segundo número deve ser 2');
    assert(res2.documentNo === `FR A${year}/000002`, `Número formatado esperado FR A${year}/000002, obtido ${res2.documentNo}`);
  });

  await test('Bloqueio fiscal: impede emissão quando não existe série autorizada', () => {
    const year = new Date().getFullYear();
    // Tipo FT (Factura de Transporte) não tem série criada nesta empresa
    const validation = validarPermissaoEmissaoFiscal(testCompanyId, 'FT', year);
    assert(!validation.allowed, 'Emissão deve ser bloqueada quando não existe série autorizada para o tipo');
    assert(validation.error?.includes('Emissão fiscal bloqueada') === true, 'Deve retornar mensagem explicativa de bloqueio fiscal');

    let threw = false;
    try {
      reservarProximoNumeroFiscal(testCompanyId, 'FT', year);
    } catch {
      threw = true;
    }
    assert(threw, 'reservarProximoNumeroFiscal deve lançar exceção se não houver série autorizada');
  });

  await test('finalizarSerie transita para F e bloqueia novas emissões', () => {
    const year = new Date().getFullYear();
    const active = obterSerieAtiva(testCompanyId, 'FR', year);
    assert(active !== null, 'Deve existir série ativa');

    const finalized = finalizarSerie(testCompanyId, active!.id, 'GerenteFiscal', 'Encerramento anual');
    assert(finalized.status === 'F', 'Estado deve ser F (Finalizada)');
    assert(Boolean(finalized.closedAtIso), 'Deve registar data de encerramento');

    let blocked = false;
    try {
      reservarProximoNumeroFiscal(testCompanyId, 'FR', year);
    } catch (err: any) {
      blocked = true;
      assert(err.message.includes('bloqueada') || err.message.includes('finalizada'), 'Mensagem deve indicar bloqueio');
    }
    assert(blocked, 'Emissão deve ser proibida em série finalizada');
  });

  await test('inicializarSeriesPadraoSeNecessario provisiona séries primárias', () => {
    const newCompanyId = 'comp_starter_' + Date.now();
    const year = new Date().getFullYear();
    const created = inicializarSeriesPadraoSeNecessario(newCompanyId, year, 'AutoSeed');

    assert(created.length >= 5, 'Deve criar séries padrão para documentos primários (FR, FA, FT, TV, NC, RC)');
    const frSeries = obterSerieAtiva(newCompanyId, 'FR', year);
    assert(frSeries !== null, 'Série FR deve estar ativa');
    assert(frSeries?.status === 'A', 'Série inicial deve estar em estado A');
  });

  console.log('\n--- INICIANDO TESTES DO GERADOR DE QR CODE AGT (FASE 4) ---');

  await test('buildAgtQrCanonicalString gera estrutura canónica oficial com separadores "*"', () => {
    const canonical = buildAgtQrCanonicalString({
      companyNif: '5003069940',
      customerNif: 'Consumidor Final',
      customerCountry: 'AO',
      documentType: 'FR',
      documentStatus: 'N',
      documentDate: '2026-11-07',
      documentNo: 'FR A2026/000001',
      submissionGuidOrHash: 'guid-test-1234',
      totals: {
        taxBaseNor: 10000,
        taxAmountNor: 1400,
        taxBaseIse: 0,
        stampTax: 0,
        iecTax: 0,
        totalTax: 1400,
        grandTotal: 11400,
      },
      signatureJwsPreview: 'ABCD',
      softwareApprovalNumber: '123/AGT/2026',
    });

    assert(canonical.includes('A:5003069940'), 'Deve conter NIF emitente');
    assert(canonical.includes('B:999999999'), 'Consumidor final deve ser normalizado para 999999999');
    assert(canonical.includes('C:AO'), 'País deve ser AO');
    assert(canonical.includes('D:FR'), 'Tipo de documento deve ser FR');
    assert(canonical.includes('E:N'), 'Estado do documento deve ser N');
    assert(canonical.includes('G:FR A2026/000001'), 'Identificação do documento deve constar');
    assert(canonical.includes('I2:10000.00'), 'Base NOR deve estar formatada a 2 casas');
    assert(canonical.includes('I3:1400.00'), 'IVA NOR deve estar formatado a 2 casas');
    assert(canonical.includes('O:11400.00'), 'Total geral deve estar presente');
    assert(canonical.includes('Q:ABCD'), 'Assinatura preview deve estar presente');
    assert(canonical.includes('R:123/AGT/2026'), 'Aprovação software deve estar presente');
  });

  await test('parseAgtQrString decodifica e audita campos do QR Code com precisão', () => {
    const canonical = buildAgtQrCanonicalString({
      companyNif: '5002571293',
      customerNif: '5003069940',
      customerCountry: 'AO',
      documentType: 'FT',
      documentStatus: 'N',
      documentDate: '2026-11-07',
      documentNo: 'FT A2026/000042',
      totals: {
        taxBaseNor: 50000,
        taxAmountNor: 7000,
        grandTotal: 57000,
      },
      signatureJwsPreview: 'XY99',
    });

    const parsed = parseAgtQrString(canonical);
    assert(parsed.valid === true, 'QR canónico deve ser válido');
    assert(parsed.companyNif === '5002571293', 'NIF emitente deve corresponder');
    assert(parsed.customerNif === '5003069940', 'NIF cliente deve corresponder');
    assert(parsed.documentType === 'FT', 'Tipo deve ser FT');
    assert(parsed.documentNo === 'FT A2026/000042', 'DocumentNo deve corresponder');
    assert(parsed.grandTotal === 57000, 'GrandTotal deve ser 57.000 Kz');
    assert(parsed.signaturePreview === 'XY99', 'Preview de assinatura deve corresponder');
  });

  await test('generateAgtQrDataUrl gera Data URL Base64 a 350x350 px com Nível M', async () => {
    const dataUrl = await generateAgtQrDataUrl({
      companyNif: '5003069940',
      documentType: 'FR',
      documentDate: '2026-11-07',
      documentNo: 'FR A2026/000001',
      totals: { grandTotal: 1500 },
    }, { width: 350, errorCorrectionLevel: 'M', version: 4 });

    assert(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), 'Deve gerar data URL PNG válido');
    assert(dataUrl.length > 500, 'Tamanho do Base64 deve ser condizente com QR Code 350px');
  });

  await test('generateAgtQrSvg gera SVG vetorial escalável', async () => {
    const svg = await generateAgtQrSvg({
      companyNif: '5003069940',
      documentType: 'FR',
      documentDate: '2026-11-07',
      documentNo: 'FR A2026/000001',
      totals: { grandTotal: 2500 },
    });

    assert(typeof svg === 'string' && svg.includes('<svg') && svg.includes('</svg>'), 'Deve gerar markup SVG válido');
  });

  console.log('\n--- INICIANDO TESTES DO PIPELINE DE SUBMISSÃO E ASSINATURAS (FASE 5) ---');

  const sampleDocPayload: AgtDocumentPayload = {
    submissionGUID: '',
    documentNo: 'FR A2026/000001',
    series: 'A2026',
    documentType: 'FR',
    documentStatus: 'N',
    documentDate: '2026-11-08',
    systemEntryDate: new Date().toISOString(),
    customerTaxID: '999999999',
    customerCountry: 'AO',
    customerName: 'Cliente Final',
    companyName: 'JAIMONA-COMÉRCIO E SERVIÇOS',
    companyTaxID: '5003069940',
    softwareInfo: {
      softwareApprovalNumber: '123/AGT/2026',
      softwareName: 'SILA-Billing',
      softwareVersion: '2.0.0',
      producerTaxID: '5002571293',
    },
    lines: [
      calculateAgtLineItem({
        lineNumber: 1,
        productCode: 'PROD_01',
        productDescription: 'Artigo Normal',
        quantity: 1,
        unitPrice: 10000,
        unitPriceIncludesTax: false,
        taxCode: 'NOR',
        taxPercentage: 14,
      }),
    ],
    documentTotals: calculateAgtDocumentTotals([
      calculateAgtLineItem({
        lineNumber: 1,
        productCode: 'PROD_01',
        productDescription: 'Artigo Normal',
        quantity: 1,
        unitPrice: 10000,
        unitPriceIncludesTax: false,
        taxCode: 'NOR',
        taxPercentage: 14,
      }),
    ]).totals,
  };

  await test('signAgtDocument gera assinaturas digitais RSA/JWS (Software, Documento e Envelope)', () => {
    const signed = signAgtDocument(sampleDocPayload);

    assert(Boolean(signed.jwsSoftwareSignature), 'Deve gerar jwsSoftwareSignature');
    assert(Boolean(signed.jwsDocumentSignature), 'Deve gerar jwsDocumentSignature');
    assert(Boolean(signed.jwsSignature), 'Deve gerar jwsSignature');
    assert(signed.signaturePreview.length === 4, 'signaturePreview deve conter 4 caracteres');

    // Validação da assinatura do software com a chave pública do produtor
    const softPub = cryptoSignerStore.getSoftwareKeyPair().publicKeyPem;
    const verifySoft = verifyJwsCompact(signed.jwsSoftwareSignature, softPub);
    assert(verifySoft.valid === true, 'Assinatura jwsSoftwareSignature deve ser criptograficamente válida');

    // Validação da assinatura do documento com a chave pública do emitente
    const issuerPub = cryptoSignerStore.getIssuerKeyPair(sampleDocPayload.companyTaxID).publicKeyPem;
    const verifyDoc = verifyJwsCompact(signed.jwsDocumentSignature, issuerPub);
    assert(verifyDoc.valid === true, 'Assinatura jwsDocumentSignature deve ser criptograficamente válida');

    // Violação de integridade: payload adulterado deve falhar na verificação
    const tamperedJws = signed.jwsDocumentSignature.replace(/a/g, 'b');
    const verifyTampered = verifyJwsCompact(tamperedJws, issuerPub);
    assert(verifyTampered.valid === false, 'Assinatura adulterada deve ser rejeitada');
  });

  await test('agtClient.registarFactura aplica limite legal de até 30 documentos por lote', async () => {
    const oversizedBatch: AgtDocumentPayload[] = [];
    for (let i = 0; i < 31; i++) {
      oversizedBatch.push({ ...sampleDocPayload, documentNo: `FR A2026/${String(i + 1).padStart(6, '0')}` });
    }

    let batchRejected = false;
    try {
      await agtClient.registarFactura(oversizedBatch);
    } catch (err: any) {
      batchRejected = true;
      assert(err.message.includes('30 documentos'), 'Deve indicar o limite legal de 30 documentos da AGT');
    }
    assert(batchRejected, 'Lote com mais de 30 documentos deve ser estritamente bloqueado');
  });

  await test('agtClient.registarFactura submete lote válido e gera UUID v4 único por contribuinte', async () => {
    const batch = [{ ...sampleDocPayload }];
    const res = await agtClient.registarFactura(batch, 'HOMOLOGACAO');

    assert(res.statusCode === 200, 'Código de status deve ser 200 para lote válido');
    assert(Boolean(res.submissionGUID), 'Deve conter submissionGUID');
    assert(res.submissionGUID.length === 36, 'submissionGUID deve ser UUID v4 padrão com 36 caracteres');
    assert(Boolean(res.requestID), 'Deve persistir requestID para consulta posterior');
    assert(res.documentValidationStates[sampleDocPayload.documentNo] === 'V', 'Documento deve ser validado com estado V');
  });

  await test('agtClient.obterEstado consulta processamento assíncrono com backoff', async () => {
    const batch = [{ ...sampleDocPayload, documentNo: 'FR A2026/000099' }];
    const submission = await agtClient.registarFactura(batch);

    const statusRes = await agtClient.obterEstado(submission.requestID, submission.submissionGUID);
    assert(statusRes.processStatus === 'CONCLUIDO', 'Processo deve ser concluído');
    assert(statusRes.validationSummary.valid >= 1, 'Deve conter pelo menos um documento válido');
    assert(statusRes.documents['FR A2026/000099'] === 'V', 'Documento deve estar validado (V)');
  });

  await test('agtClient.validarDocumento audita integridade de assinaturas JWS', async () => {
    const docToValidate = { ...sampleDocPayload, documentNo: 'FA A2026/000010' };
    const sigs = signAgtDocument(docToValidate);
    docToValidate.jwsSoftwareSignature = sigs.jwsSoftwareSignature;
    docToValidate.jwsDocumentSignature = sigs.jwsDocumentSignature;

    const validation = await agtClient.validarDocumento(docToValidate);
    assert(validation.valid === true, 'Documento com assinaturas válidas deve ser aprovado');
    assert(validation.verificationDetails?.softwareSignatureValid === true, 'Software signature deve ser válida');
    assert(validation.verificationDetails?.documentSignatureValid === true, 'Document signature deve ser válida');
  });

  console.log('\n--- INICIANDO TESTES DA FICHA MESTRE & MOTOR MULTI-TAXA (FASE 1) ---');

  await test('calculateInvoiceTotals calcula correctamente taxas 0%, 1% (Cabinda), 5% (RED), 7% (INT) e 14% (NOR)', () => {
    const totals = calculateInvoiceTotals([
      { productId: 'p14', code: 'P14', description: 'Normal 14%', unit: 'un', qty: 1, unitPrice: 1140, discountPct: 0, ivaRate: 14 },
      { productId: 'p7', code: 'P7', description: 'Intermédia 7%', unit: 'un', qty: 1, unitPrice: 1070, discountPct: 0, ivaRate: 7 },
      { productId: 'p5', code: 'P5', description: 'Reduzida 5%', unit: 'un', qty: 1, unitPrice: 1050, discountPct: 0, ivaRate: 5 },
      { productId: 'p1', code: 'P1', description: 'Cabinda 1%', unit: 'un', qty: 1, unitPrice: 1010, discountPct: 0, ivaRate: 1 },
      { productId: 'p0', code: 'P0', description: 'Isento 0%', unit: 'un', qty: 1, unitPrice: 500, discountPct: 0, ivaRate: 0, exemptionCode: 'M10' },
    ]);

    assert(totals.taxBase14 === 1000 && totals.taxAmount14 === 140, 'NOR 14% deve extrair base 1000 e IVA 140');
    assert(totals.taxBaseReduced === 1000 && totals.taxAmountReduced === 50, 'RED 5% deve extrair base 1000 e IVA 50');
    assert(totals.taxBaseIntermediate === 2000 && totals.taxAmountIntermediate === 80, 'INT (7% + 1%) deve somar base 2000 e IVA 80');
    assert(totals.taxBase0 === 500 && totals.taxAmount0 === 0, 'ISE 0% deve manter base 500 e IVA 0');
    assert(totals.taxTotal === 270, `taxTotal esperado 270 (140+70+50+10), obtido ${totals.taxTotal}`);
    assert((totals.taxBreakdown?.length || 0) === 5, 'taxBreakdown deve listar todas as 5 faixas tributárias');
  });

  await test('convertCartItemsToAgtLines e desconto global preservam taxa Cabinda 1% sem sobrescrever para 7%', () => {
    const agtLines = convertCartItemsToAgtLines(
      [
        { productId: 'cab1', code: 'CAB1', description: 'Mercadoria Cabinda', unit: 'un', qty: 1, unitPrice: 10100, discountPct: 0, ivaRate: 1 },
        { productId: 'red5', code: 'RED5', description: 'Cesta 5%', unit: 'un', qty: 1, unitPrice: 10500, discountPct: 0, ivaRate: 5 },
        { productId: 'ise0', code: 'ISE0', description: 'Arroz Isento', unit: 'un', qty: 1, unitPrice: 2000, discountPct: 0, ivaRate: 0 },
      ],
      'M81'
    );

    assert(agtLines[0]!.taxCode === 'INT' && agtLines[0]!.taxPercentage === 1, '1% deve mapear para INT 1%');
    assert(agtLines[1]!.taxCode === 'RED' && agtLines[1]!.taxPercentage === 5, '5% deve mapear para RED 5%');
    assert(agtLines[2]!.taxCode === 'ISE' && agtLines[2]!.exemptionCode === 'M81', '0% sem código explícito deve usar M81');

    const withGlobalDiscount = calculateAgtDocumentTotals(agtLines, { globalDiscountPct: 10 });
    // Base Cabinda: 10000 * 0.9 = 9000 -> 1% = 90.00 (nunca 7% = 630!)
    assert(withGlobalDiscount.totals.totalTaxBaseINT === 9000, 'Base INT com 10% desconto deve ser 9000');
    assert(withGlobalDiscount.totals.totalTaxAmountINT === 90, `IVA INT Cabinda 1% esperado 90, obtido ${withGlobalDiscount.totals.totalTaxAmountINT}`);
    assert(withGlobalDiscount.totals.totalTaxAmountRED === 450, `IVA RED 5% esperado 450, obtido ${withGlobalDiscount.totals.totalTaxAmountRED}`);
  });

  await test('generateNextInvoiceNumber respeita prefixos oficiais AGT (FR, FA, FP, NC, ND, RC, FT, CS)', () => {
    const year = new Date().getFullYear();
    const fr = generateNextInvoiceNumber(['FV 2026/000005'], 'FR');
    const fa = generateNextInvoiceNumber([], 'FA', 10);
    const nd = generateNextInvoiceNumber([], 'ND', 0);
    assert(fr === `FR ${year}/000006`, `Esperado FR ${year}/000006, obtido ${fr}`);
    assert(fa === `FA ${year}/000011`, `Esperado FA ${year}/000011, obtido ${fa}`);
    assert(nd === `ND ${year}/000001`, `Esperado ND ${year}/000001, obtido ${nd}`);
  });

  await test('companyValidator distingue prontidão de Simulação vs Produção e protege contra XSS no logótipo', () => {
    const partialCheck = evaluateCompanyMasterCompleteness({
      legalName: 'Kwanza Digital Lda',
      shortName: 'Kwanza Digital',
      nif: '5001234567',
      address: 'Angola',
      cityCountry: 'Luanda - Angola',
      phone: '',
      email: '',
      tagline: '',
      taxRegime: 'GERAL',
      agtEnvironment: 'SIMULACAO',
    });

    assert(partialCheck.readyForSimulation === true, 'Cadastro parcial com firma, nome comercial e NIF válido deve permitir gravação para simulação');
    assert(partialCheck.readyForProductionEmission === false, 'Cadastro incompleto sem endereço/contactos/repartição não pode activar produção');

    const svgAttempt = validateLogoDataUrl('data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=');
    assert(svgAttempt.valid === false, 'SVG no logótipo deve ser bloqueado por segurança');

    const pngValid = validateLogoDataUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
    assert(pngValid.valid === true, 'PNG Base64 válido deve ser aceite');

    assert(validateAngolaIban('AO06 0040 0000 1219 5634 1015 0').valid === true, 'IBAN AO06 com 25 caracteres deve ser válido');
    assert(validateAngolaIban('PT50000201231234567890154').valid === false, 'IBAN estrangeiro deve falhar validação angolana');
  });

  await test('resolveDefaultExemptionCodeForCompany, resolveActiveEstablishment e buildInvoiceIssuerSnapshot preservam identidade', () => {
    assert(resolveDefaultExemptionCodeForCompany({ taxRegime: 'EXCLUSAO' }) === 'M80', 'Regime Exclusão deve derivar M80');
    assert(resolveDefaultExemptionCodeForCompany({ taxRegime: 'SIMPLIFICADO' }) === 'M81', 'Regime Simplificado deve derivar M81');
    assert(resolveDefaultExemptionCodeForCompany({ taxRegime: 'GERAL' }) === 'M10', 'Regime Geral deve derivar M10');

    const est = resolveActiveEstablishment(JAIMONA_COMPANY);
    assert(est.code === '001' && est.isHeadquarters === true, 'Deve resolver estabelecimento matriz 001 por omissão');

    const snapshot = buildInvoiceIssuerSnapshot(JAIMONA_COMPANY, {
      companyId: JAIMONA_COMPANY_ID,
      establishment: est,
    });
    assert(snapshot.nif === '5003069940', 'Snapshot deve preservar NIF da empresa emissora');
    assert(snapshot.nif !== VITRONIS_INSTITUTIONAL.nif, 'NIF da empresa utilizadora nunca se deve misturar com NIF da VITRONIS');
    assert(snapshot.establishmentCode === '001', 'Snapshot deve capturar código do estabelecimento');
  });

  console.log('\n--- INICIANDO TESTES DE SÉRIES, ESTABELECIMENTOS & AMBIENTES (FASE 2) ---');

  await test('Separação estrita SIMULACAO vs PRODUCAO bloqueia emissão cruzada e exige Ficha Mestre completa', () => {
    const f2CompanyId = 'comp_f2_env_' + Date.now();
    const year = new Date().getFullYear();

    // 1. Solicitar série de simulação (permitido mesmo sem perfil completo)
    const simSeries = solicitarSerie({
      companyId: f2CompanyId,
      seriesCode: 'S2026',
      seriesYear: year,
      documentType: 'FR',
      environment: 'SIMULACAO',
      operator: 'Admin',
    });
    assert(normalizeSeriesEnvironment(simSeries.environment) === 'SIMULACAO', 'Série deve ser SIMULACAO');

    // 2. Bloqueio de emissão em PRODUCAO usando apenas série de SIMULACAO
    const prodValidation = validarPermissaoEmissaoFiscal(f2CompanyId, 'FR', year, {
      environment: 'PRODUCAO',
    });
    assert(prodValidation.allowed === false, 'Emissão em PRODUCAO deve bloquear quando só existe série de SIMULACAO');
    assert(prodValidation.error?.includes('PRODUÇÃO') === true, 'Erro deve explicitar bloqueio por falta de série de PRODUÇÃO');

    // 3. Bloqueio de solicitarSerie em PRODUCAO com ficha incompleta
    const incompleteProfile = {
      ...JAIMONA_COMPANY,
      taxOffice: '',
      municipality: '',
      province: '',
      email: '',
    };
    let blockedIncomplete = false;
    try {
      solicitarSerie({
        companyId: f2CompanyId,
        seriesCode: 'P2026',
        seriesYear: year,
        documentType: 'FR',
        environment: 'PRODUCAO',
        companyProfile: incompleteProfile,
        operator: 'Admin',
      });
    } catch {
      blockedIncomplete = true;
    }
    assert(blockedIncomplete, 'solicitarSerie PRODUCAO deve bloquear quando ficha mestre está incompleta');

    // 4. Com ficha completa, solicitarSerie PRODUCAO funciona e isola _PROD
    const completeProfile = {
      ...JAIMONA_COMPANY,
      taxOffice: '3.ª Repartição Fiscal de Luanda',
      municipality: 'Belas',
      province: 'Luanda',
      email: 'jaimonacomercioeservicos@gmail.com',
      phone: '+244 923 000 001',
    };
    const prodSeries = solicitarSerie({
      companyId: f2CompanyId,
      seriesCode: 'P2026',
      seriesYear: year,
      documentType: 'FR',
      environment: 'PRODUCAO',
      companyProfile: completeProfile,
      operator: 'Admin',
    });
    assert(prodSeries.id.endsWith('_PROD'), 'Série de produção deve usar sufixo _PROD para não colidir com simulação');
    assert(prodSeries.agtAuthorizationCode?.startsWith(`AGT-PRD-${year}-FR-`) === true, 'Autorização de produção deve usar prefixo AGT-PRD-');

    const prodActive = obterSerieAtiva(f2CompanyId, 'FR', year, { environment: 'PRODUCAO' });
    const simActive = obterSerieAtiva(f2CompanyId, 'FR', year, { environment: 'SIMULACAO' });
    assert(prodActive?.seriesCode === 'P2026', 'Ambiente PRODUCAO deve resolver apenas P2026');
    assert(simActive?.seriesCode === 'S2026', 'Ambiente SIMULACAO deve resolver apenas S2026');

    const resProd = reservarProximoNumeroFiscal(f2CompanyId, 'FR', year, undefined, { environment: 'PRODUCAO' });
    assert(resProd.documentNo === `FR P2026/000001` && resProd.environment === 'PRODUCAO', 'Numeração em PRODUCAO deve avançar só na série P2026');

    const summary = getSeriesSummaryByEnvironment(f2CompanyId);
    assert(summary.simulacaoAtivas === 1 && summary.producaoAtivas === 1, 'Resumo por ambiente deve contabilizar 1 ativa em cada');

    const readinessNoSeries = evaluateCompanyMasterCompleteness(completeProfile, {
      series: [],
      requireProductionSeriesCheck: true,
    });
    assert(readinessNoSeries.readyForProductionEmission === false, 'Prontidão de produção com requireProductionSeriesCheck deve exigir série de PRODUCAO');

    const readinessWithSeries = evaluateCompanyMasterCompleteness(completeProfile, {
      series: listarSeries({ companyId: f2CompanyId }),
      requireProductionSeriesCheck: true,
    });
    assert(readinessWithSeries.readyForProductionEmission === true, 'Prontidão de produção deve passar com ficha completa + série PRODUCAO');
  });

  await test('Resolução de séries por estabelecimento prioriza série dedicada e faz fallback para série global', () => {
    const estCompanyId = 'comp_f2_est_' + Date.now();
    const year = new Date().getFullYear();

    const globalSeries = solicitarSerie({
      companyId: estCompanyId,
      seriesCode: 'G2026',
      seriesYear: year,
      documentType: 'FR',
      environment: 'SIMULACAO',
      operator: 'Admin',
    });

    const filialSeries = solicitarSerie({
      companyId: estCompanyId,
      seriesCode: 'F22026',
      seriesYear: year,
      documentType: 'FR',
      environment: 'SIMULACAO',
      establishmentId: 'est_filial_02',
      establishmentCode: '002',
      operator: 'Admin',
    });

    const resolvedFilial = obterSerieAtiva(estCompanyId, 'FR', year, {
      environment: 'SIMULACAO',
      establishmentId: 'est_filial_02',
    });
    assert(resolvedFilial?.id === filialSeries.id, 'Filial 002 deve priorizar a sua série dedicada F22026');

    const resolvedSede = obterSerieAtiva(estCompanyId, 'FR', year, {
      environment: 'SIMULACAO',
      establishmentId: 'est_sede_01',
    });
    assert(resolvedSede?.id === globalSeries.id, 'Estabelecimento sem série dedicada deve herdar a série global G2026');
  });

  await test('mergeSeriesFromCloud preserva maior numeração emitida e monotonicidade de estado (F > U > A)', () => {
    const mergeCompanyId = 'comp_f2_merge_' + Date.now();
    const year = new Date().getFullYear();

    const localSeries = solicitarSerie({
      companyId: mergeCompanyId,
      seriesCode: 'M2026',
      seriesYear: year,
      documentType: 'FA',
      environment: 'SIMULACAO',
      operator: 'Admin',
    });

    reservarProximoNumeroFiscal(mergeCompanyId, 'FA', year, undefined, { environment: 'SIMULACAO' });
    reservarProximoNumeroFiscal(mergeCompanyId, 'FA', year, undefined, { environment: 'SIMULACAO' });

    // Simular documento Cloud atrasado (estado A e número 0) e uma nova série finalizada vinda da Cloud
    const merged = mergeSeriesFromCloud(mergeCompanyId, [
      { ...localSeries, status: 'A', lastDocumentNumber: 0 },
      {
        id: `${mergeCompanyId}_C2026_${year}_FR`,
        companyId: mergeCompanyId,
        seriesCode: 'C2026',
        seriesYear: year,
        documentType: 'FR',
        firstDocumentNumber: 1,
        lastDocumentNumber: 15,
        status: 'F',
        environment: 'SIMULACAO',
        requestedAtIso: new Date().toISOString(),
        closedAtIso: new Date().toISOString(),
      },
    ]);

    const mergedFa = merged.find((s) => s.id === localSeries.id);
    const mergedFr = merged.find((s) => s.seriesCode === 'C2026');
    assert(mergedFa?.lastDocumentNumber === 2 && mergedFa.status === 'U', 'Não deve regredir numeração local (2) nem estado (U)');
    assert(mergedFr?.status === 'F' && mergedFr.lastDocumentNumber === 15, 'Deve incorporar série finalizada vinda da Cloud');
  });

  console.log('\n--- INICIANDO TESTES DE INTEGRIDADE DOCUMENTAL & SNAPSHOTS (FASE 3) ---');

  await test('Snapshot histórico preserva identidade emitente e preferência de logótipo após mutação cadastral', () => {
    const historicalCompany = {
      ...JAIMONA_COMPANY,
      legalName: 'Kwanza Comércio Antigo, Lda',
      shortName: 'KWANZA ANTIGO',
      nif: '5008887776',
      address: 'Av. 4 de Fevereiro, N.º 10',
      municipality: 'Ingombota',
      province: 'Luanda',
      postalCode: '1000',
      taxOffice: '1.ª Repartição Fiscal de Luanda',
      taxRegime: 'GERAL' as const,
      bankName1: 'Banco BAI',
      iban1: 'AO06 0040 0000 1219 5634 1015 0',
      logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      showLogoOnPos: false,
      showLogoOnA4: true,
    };

    const snapshot = buildInvoiceIssuerSnapshot(historicalCompany, {
      companyId: 'comp_hist_test',
      establishment: {
        id: 'est_002',
        code: '002',
        name: 'Filial Talatona',
        isHeadquarters: false,
        address: 'Rua do MAT, Talatona',
        municipality: 'Talatona',
        province: 'Luanda',
        active: true,
      },
    });

    const totals = calculateInvoiceTotals([
      { productId: 'p14', code: 'P14', description: 'Serviço Normal 14%', unit: 'un', qty: 1, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
      { productId: 'p1', code: 'P1', description: 'Cabinda 1%', unit: 'un', qty: 1, unitPrice: 1010, discountPct: 0, ivaRate: 1 },
      { productId: 'p5', code: 'P5', description: 'Reduzida 5%', unit: 'un', qty: 1, unitPrice: 1050, discountPct: 0, ivaRate: 5 },
      { productId: 'p0', code: 'P0', description: 'Arroz Isento', unit: 'kg', qty: 1, unitPrice: 2000, discountPct: 0, ivaRate: 0, exemptionCode: 'M10' },
    ]);

    const hashInfo = computeDocumentSaftHash4({
      issuedAtIso: '2026-04-01T10:00:00.000Z',
      number: 'FA S2026/000001',
      grandTotal: totals.grandTotal,
    });

    const historicalInvoice: InvoiceRecord = {
      id: 'inv_hist_1',
      companyId: 'comp_hist_test',
      number: 'FA S2026/000001',
      docType: 'FA',
      issuedAtIso: '2026-04-01T10:00:00.000Z',
      cashier: '02',
      operator: 'Operador A',
      paymentMethod: 'Transferência',
      customerId: 'cust_1',
      customerName: 'Cliente Corporativo Teste',
      customerNif: '5007776665',
      customerLocality: 'Luanda',
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: totals.discountTotal,
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBaseIntermediate: totals.taxBaseIntermediate,
      taxAmountIntermediate: totals.taxAmountIntermediate,
      taxBaseReduced: totals.taxBaseReduced,
      taxAmountReduced: totals.taxAmountReduced,
      taxBase0: totals.taxBase0,
      taxAmount0: totals.taxAmount0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: 'Catorze mil quatrocentos e sessenta Kwanzas',
      amountReceived: totals.grandTotal,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: totals.lines,
      establishmentId: 'est_002',
      establishmentCode: '002',
      establishmentName: 'Filial Talatona',
      seriesCode: 'S2026',
      seriesEnvironment: 'PRODUCAO',
      agtAuthorizationCode: 'AGT-PRD-2026-FA-0001',
      saftHash4: hashInfo.hash4,
      issuerSnapshot: snapshot,
      createdAtIso: '2026-04-01T10:00:00.000Z',
      updatedAtIso: '2026-04-01T10:00:00.000Z',
    };

    // Mutação posterior da empresa viva NÃO pode alterar a factura histórica
    const mutatedLiveCompany = {
      ...historicalCompany,
      legalName: 'Nova Denominação Alterada S.A.',
      nif: '5009999998',
      iban1: 'AO06 0099 0000 0000 0000 0000 0',
    };

    const resolved = resolveCompanyProfileFromSnapshot(historicalInvoice, mutatedLiveCompany);
    assert(resolved.legalName === 'Kwanza Comércio Antigo, Lda', 'Snapshot deve preservar nome histórico');
    assert(resolved.nif === '5008887776', 'Snapshot deve preservar NIF histórico');

    const a4Html = renderDocumentHtml(historicalInvoice, 'A4', mutatedLiveCompany, '');
    assert(a4Html.includes('Kwanza Comércio Antigo, Lda'), 'A4 deve renderizar denominação histórica do snapshot');
    assert(!a4Html.includes('Nova Denominação Alterada'), 'A4 não deve herdar alterações posteriores ao emitente');
    assert(a4Html.includes('Est. 002 · Filial Talatona'), 'A4 deve identificar estabelecimento 002');
    assert(a4Html.includes('Rua do MAT, Talatona'), 'A4 deve mostrar morada distinta do estabelecimento');
    assert(a4Html.includes('14,00% (NOR)'), 'A4 deve apresentar linha de IVA 14%');
    assert(a4Html.includes('5,00% (RED)'), 'A4 deve apresentar linha de IVA 5%');
    assert(a4Html.includes('1,00% (INT-CAB)'), 'A4 deve apresentar linha de IVA 1% Cabinda');
    assert(a4Html.includes('M10:'), 'A4 deve apresentar código de isenção M10');
    assert(a4Html.includes('alt="Logótipo"'), 'A4 com showLogoOnA4=true deve renderizar logótipo');
    assert(
      a4Html.includes(`${hashInfo.hash4}-Processado por programa validado SILA-Billing`),
      'Documento em PRODUCAO deve exibir rodapé fiscal com hash4 real'
    );

    const posHtml = renderDocumentHtml(historicalInvoice, 'POS', mutatedLiveCompany, '');
    assert(!posHtml.includes('alt="Logótipo"'), 'POS com showLogoOnPos=false não deve renderizar logótipo');
    assert(posHtml.includes('DOCUMENTO FISCAL · SÉRIE S2026'), 'POS em PRODUCAO deve exibir cabeçalho fiscal e série');
    assert(posHtml.includes('FACTURA N.º FA S2026/000001'), 'POS deve formatar título correcto para FA');

    const simInvoice: InvoiceRecord = {
      ...historicalInvoice,
      docType: 'ND',
      number: 'ND SIM2026/000001',
      seriesEnvironment: 'SIMULACAO',
    };
    const simPosHtml = renderDocumentHtml(simInvoice, 'POS', mutatedLiveCompany, '');
    assert(simPosHtml.includes('MODELO — SEM VALIDADE FISCAL'), 'POS em SIMULACAO deve avisar que é modelo sem validade fiscal');
    assert(simPosHtml.includes('NOTA DE DÉBITO N.º ND SIM2026/000001'), 'POS deve formatar título Nota de Débito para ND');
  });

  await test('QR Code documental inclui bases I4/I5 multi-taxa e hash4 real da assinatura SAF-T', async () => {
    const totals = calculateInvoiceTotals([
      { productId: 'p14', code: 'P14', description: 'Normal 14%', unit: 'un', qty: 1, unitPrice: 1140, discountPct: 0, ivaRate: 14 },
      { productId: 'p5', code: 'P5', description: 'Reduzida 5%', unit: 'un', qty: 1, unitPrice: 1050, discountPct: 0, ivaRate: 5 },
      { productId: 'p1', code: 'P1', description: 'Cabinda 1%', unit: 'un', qty: 1, unitPrice: 1010, discountPct: 0, ivaRate: 1 },
    ]);
    const hashInfo = computeDocumentSaftHash4({
      issuedAtIso: '2026-04-02T12:00:00.000Z',
      number: 'FR P2026/000007',
      grandTotal: totals.grandTotal,
    });

    const inv: InvoiceRecord = {
      id: 'inv_qr_f3',
      number: 'FR P2026/000007',
      docType: 'FR',
      issuedAtIso: '2026-04-02T12:00:00.000Z',
      cashier: '01',
      operator: '001',
      paymentMethod: 'Multicaixa',
      customerId: '999999999',
      customerName: 'Consumidor Final',
      customerNif: '999999999',
      customerLocality: 'Cabinda',
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: totals.discountTotal,
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBaseIntermediate: totals.taxBaseIntermediate,
      taxAmountIntermediate: totals.taxAmountIntermediate,
      taxBaseReduced: totals.taxBaseReduced,
      taxAmountReduced: totals.taxAmountReduced,
      taxBase0: totals.taxBase0,
      taxAmount0: totals.taxAmount0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: 'Três mil e duzentos Kwanzas',
      amountReceived: totals.grandTotal,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: totals.lines,
      seriesEnvironment: 'PRODUCAO',
      saftHash4: hashInfo.hash4,
      createdAtIso: '2026-04-02T12:00:00.000Z',
      updatedAtIso: '2026-04-02T12:00:00.000Z',
    };

    const canonical = buildAgtQrCanonicalString({
      companyNif: JAIMONA_COMPANY.nif,
      customerNif: inv.customerNif,
      documentType: inv.docType,
      documentDate: inv.issuedAtIso,
      documentNo: inv.number,
      totals: {
        taxBaseNor: inv.taxBase14,
        taxAmountNor: inv.taxAmount14,
        taxBaseIntRed: (inv.taxBaseIntermediate || 0) + (inv.taxBaseReduced || 0),
        taxAmountIntRed: (inv.taxAmountIntermediate || 0) + (inv.taxAmountReduced || 0),
        taxBaseIse: inv.taxBase0,
        totalTax: inv.taxTotal,
        grandTotal: inv.grandTotal,
      },
      signatureJwsPreview: hashInfo.hash4,
      environment: 'PRODUCAO',
    });

    const parsed = parseAgtQrString(canonical);
    assert(parsed.valid === true, 'String QR multi-taxa deve ser válida');
    assert(parsed.taxBaseIntRed === 2000, `Base I4 esperada 2000, obtida ${parsed.taxBaseIntRed}`);
    assert(parsed.taxAmountIntRed === 60, `IVA I5 esperado 60 (50+10), obtido ${parsed.taxAmountIntRed}`);
    assert(parsed.signaturePreview === hashInfo.hash4, 'Campo Q do QR deve transportar saftHash4 real');

    const qrPng = await generateInvoiceQrDataUrl(inv, JAIMONA_COMPANY);
    assert(qrPng.startsWith('data:image/png;base64,'), 'generateInvoiceQrDataUrl deve gerar PNG válido para documento multi-taxa');
  });

  console.log('\n--- INICIANDO TESTES DE PARIDADE DESKTOP/MOBILE & FICHA MESTRE (FASE 4) ---');

  await test('Paridade Desktop e Mobile: todos os campos da Ficha Mestre estão presentes em ambos os modos', () => {
    const compRecord: CompanyRecord = {
      id: 'comp_f4_parity',
      normalizedNif: '5003069940',
      profile: {
        ...JAIMONA_COMPANY,
        establishments: [createDefaultEstablishmentForCompany(JAIMONA_COMPANY)],
      },
      status: 'active',
      plan: {
        planTier: 'PROFISSIONAL',
        commercialActive: true,
        maxUsers: null,
        maxInvoicesPerMonth: null,
        updatedAtIso: new Date().toISOString(),
      },
      baseSequence: 0,
      allowManagerCancel: false,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };

    const sharedOpts = {
      company: compRecord,
      settings: { ...DEFAULT_SETTINGS, companyId: compRecord.id, company: compRecord.profile },
      series: [],
      canManage: true,
      activeSection: 'ALL' as const,
      showRequestAgtSeriesForm: true,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: true,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: true,
      editingWarehouse: null,
      warehouseError: null,
      errorMessage: null,
      savedNotice: false,
      operator: '001',
    };

    const desktopHtml = renderCompanyMasterSection({
      ...sharedOpts,
      mode: 'DESKTOP',
      formId: 'settings-form',
    });
    const mobileHtml = renderCompanyMasterSection({
      ...sharedOpts,
      mode: 'MOBILE',
      formId: 'mobile-quick-company-form',
    });

    for (const desc of COMPANY_MASTER_FIELD_REGISTRY) {
      if (desc.key === 'series' || desc.key === 'establishments') continue;
      const attr = `name="${desc.key}"`;
      assert(desktopHtml.includes(attr), `Desktop deve renderizar campo ${desc.key}`);
      assert(mobileHtml.includes(attr), `Mobile deve renderizar campo ${desc.key}`);
    }

    for (const marker of [
      'data-master-section="series"',
      'data-form="request-agt-series-form"',
      'data-master-section="estabelecimentos"',
      'data-form="save-establishment-form"',
      'data-form="save-warehouse-form"',
      'data-action="upload-company-logo"',
      'name="defaultCashier"',
      'name="maxCashierDiscountPct"',
    ]) {
      assert(desktopHtml.includes(marker), `Desktop deve incluir ${marker}`);
      assert(mobileHtml.includes(marker), `Mobile deve incluir ${marker}`);
    }
  });

  await test('extractSettingsFromFormData preserva os 9 blocos da Ficha Mestre e estabelecimentos sem apagamentos', () => {
    const existingEst = createDefaultEstablishmentForCompany(JAIMONA_COMPANY, 'est_hq_1');
    const existingProfile = {
      ...JAIMONA_COMPANY,
      establishments: [existingEst],
      defaultEstablishmentId: existingEst.id,
      warehouses: [
        {
          id: 'arm_1',
          code: 'ARM-01',
          name: 'Armazém Sede',
          establishmentId: existingEst.id,
          active: true,
        },
      ],
    };

    const fd = new FormData();
    fd.set('legalName', 'Kwanza Digital Soluções, Lda');
    fd.set('shortName', 'KWANZA DIGITAL');
    fd.set('legalNature', 'LDA');
    fd.set('cae', '62010');
    fd.set('commercialRegistry', 'CRC Luanda 998/2026');
    fd.set('shareCapital', '5.000.000,00 Kz');
    fd.set('tagline', 'Inovação e Rigor');
    fd.set('nif', '5004445556');
    fd.set('taxRegime', 'GERAL');
    fd.set('taxOffice', '2.ª Repartição Fiscal de Luanda');
    fd.set('specialTaxTerritory', 'AO-CAB');
    fd.set('agtEnvironment', 'SIMULACAO');
    fd.set('defaultWithholdingTax', '6.5');
    fd.set('isVatRetentionAgentPresent', '1');
    fd.set('isVatRetentionAgent', 'on');
    fd.set('address', 'Av. Pedro de Castro Van-Dúnem Loy, n.º 45');
    fd.set('municipality', 'Belas');
    fd.set('province', 'Luanda');
    fd.set('cityCountry', 'Luanda - Angola');
    fd.set('postalCode', 'CX 2040');
    fd.set('phone', '923000111');
    fd.set('mobile', '912000222');
    fd.set('whatsapp', '923000111');
    fd.set('email', 'fiscal@kwanzadigital.ao');
    fd.set('billingEmail', 'facturas@kwanzadigital.ao');
    fd.set('website', 'www.kwanzadigital.ao');
    fd.set('logoUrl', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
    fd.set('showLogoOnA4Present', '1');
    fd.set('showLogoOnA4', 'on');
    fd.set('showLogoOnPosPresent', '1');
    fd.set('bankName1', 'BAI');
    fd.set('iban1', 'AO06004000001219563410150');
    fd.set('swift1', 'BAIPAOLU');
    fd.set('multicaixaExpressPhone', '923000111');
    fd.set('defaultPaymentTermsDays', '30');
    fd.set('legalRepresentativeName', 'Mateus João');
    fd.set('legalRepresentativeRole', 'Sócio-Gerente');
    fd.set('accountantName', 'Ana Paula');
    fd.set('accountantOcpcaNumber', 'OCPCA-4412');
    fd.set('defaultEstablishmentId', existingEst.id);

    const extracted = extractSettingsFromFormData(fd, {
      companyId: 'comp_f4_extract',
      currentSettings: DEFAULT_SETTINGS,
      currentProfile: existingProfile,
      canCleanFooter: true,
    });

    assert(extracted.company.legalName === 'Kwanza Digital Soluções, Lda', 'Deve atualizar legalName');
    assert(extracted.company.legalNature === 'LDA', 'Deve guardar natureza jurídica');
    assert(extracted.company.taxOffice === '2.ª Repartição Fiscal de Luanda', 'Deve guardar repartição fiscal');
    assert(extracted.company.specialTaxTerritory === 'AO-CAB', 'Deve guardar território fiscal especial');
    assert(extracted.company.isVatRetentionAgent === true, 'Deve ler checkbox isVatRetentionAgent');
    assert(extracted.company.showLogoOnA4 === true && extracted.company.showLogoOnPos === false, 'Deve distinguir showLogoOnA4 (checked) de showLogoOnPos (unchecked)');
    assert(extracted.company.iban1 === 'AO06004000001219563410150', 'Deve guardar IBAN principal');
    assert(extracted.company.accountantOcpcaNumber === 'OCPCA-4412', 'Deve guardar cédula OCPCA');
    assert(extracted.company.establishments?.length === 1 && extracted.company.establishments[0]?.id === existingEst.id, 'Deve preservar estabelecimentos existentes');
    assert(extracted.company.warehouses?.length === 1 && extracted.company.warehouses[0]?.code === 'ARM-01', 'Deve preservar armazéns existentes');
  });

  await test('Gravação parcial em Simulação vs Bloqueio de Produção sem série e Repartição Fiscal', () => {
    const partialCompanyId = 'comp_f4_gate_' + Date.now();
    const partialProfile = {
      legalName: 'Comercial Huambo Teste, Lda',
      shortName: 'HUAMBO TESTE',
      nif: '5006667778',
      taxRegime: 'GERAL' as const,
      agtEnvironment: 'SIMULACAO' as const,
      address: 'Angola',
      cityCountry: 'Huambo - Angola',
      phone: '',
      email: '',
      tagline: '',
    };

    const simCheck = evaluateCompanyMasterCompleteness(partialProfile, {
      series: [],
      requireProductionSeriesCheck: false,
    });
    assert(simCheck.readyForSimulation === true, 'Gravação parcial em Simulação deve ser permitida com dados mínimos');
    assert(simCheck.readyForProductionEmission === false, 'Produção não pode ser liberada com ficha incompleta');

    const fullProfile = {
      ...partialProfile,
      taxOffice: 'Repartição Fiscal do Huambo',
      address: 'Rua 5 de Outubro, n.º 12',
      municipality: 'Huambo',
      province: 'Huambo',
      phone: '923111222',
      email: 'geral@huamboteste.ao',
      agtEnvironment: 'PRODUCAO' as const,
      establishments: [
        createDefaultEstablishmentForCompany({
          shortName: 'HUAMBO TESTE',
          address: 'Rua 5 de Outubro, n.º 12',
          municipality: 'Huambo',
          province: 'Huambo',
          cityCountry: 'Huambo - Angola',
          phone: '923111222',
          email: 'geral@huamboteste.ao',
        }),
      ],
    };

    const prodSeries = solicitarSerie({
      companyId: partialCompanyId,
      seriesCode: 'P2026',
      seriesYear: new Date().getFullYear(),
      documentType: 'FR',
      environment: 'PRODUCAO',
      companyProfile: fullProfile,
      operator: 'Admin',
    });

    const prodCheck = evaluateCompanyMasterCompleteness(fullProfile, {
      series: [prodSeries],
      requireProductionSeriesCheck: true,
    });
    assert(prodCheck.readyForProductionEmission === true, 'Produção deve ficar pronta após ficha completa e série de Produção activa');
  });

  console.log(`\nTODOS OS ${passed}/${total} TESTES FISCAIS PASSARAM COM SUCESSO!\n`);
  return { passed, total };
}

// Execução se chamado diretamente via tsx
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('fiscalTests')) {
  runFiscalTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Falha na execução dos testes fiscais:', err);
      process.exit(1);
    });
}
