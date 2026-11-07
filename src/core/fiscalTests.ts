/**
 * Suite de Verificação e Auditoria Fiscal Automatizada
 * Validação ponta-a-ponta do Motor Tributário (Fase 2) e Gestão de Séries AGT (Fase 3).
 */

import {
  AGT_DOCUMENT_TYPES,
  isSeriesCreationAllowedForYear,
} from './fiscalTypes.ts';
import {
  finalizarSerie,
  inicializarSeriesPadraoSeNecessario,
  listarSeries,
  obterSerieAtiva,
  reservarProximoNumeroFiscal,
  seriesStorage,
  solicitarSerie,
  validarPermissaoEmissaoFiscal,
} from './seriesManager.ts';
import {
  calculateAgtDocumentTotals,
  calculateAgtLineItem,
  roundUpToCent,
  validateAgtTaxCompliance,
} from './taxEngine.ts';
import {
  buildAgtQrCanonicalString,
  generateAgtQrDataUrl,
  generateAgtQrSvg,
  parseAgtQrString,
} from './fiscalQrGenerator.ts';

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
