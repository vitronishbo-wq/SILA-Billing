/**
 * SILA-Billing — Suíte de Testes e Validação Integral (Fase 5)
 *
 * Cobre os 5 pilares exigidos na Fase 5:
 * 1. Fiscalidade & Cálculos Tributários (multi-taxa 0%, 1% Cabinda, 5%, 7%, 14%, retenções, descontos, NC/ND)
 * 2. Isolamento Multiempresa & Snapshots Históricos Imutáveis
 * 3. Funcionamento Offline & Persistência Determinística
 * 4. Sincronização Cloud & Conformidade estrita com allowlists de `firestore.rules`
 * 5. Regressão (Paridade Desktop/Mobile + Bugfix IVA 0%) e Validação Estrita XSD SAF-T (AO) v1.01_01
 */

import {
  buildMasterProfileMap,
  hydrateProfileFromCloud,
  sanitizeEstablishmentsForCloud,
  sanitizeIssuerSnapshotForCloud,
  sanitizeWarehousesForCloud,
} from './cloudMasterMapper.ts';
import {
  calculateInvoiceTotals,
  formatKzNumber,
  roundKz,
} from './billingEngine.ts';
import {
  evaluateCompanyMasterCompleteness,
  validateLogoDataUrl,
} from './companyValidator.ts';
import {
  generateSaftAoXml,
} from './saftGenerator.ts';
import {
  validateSaftAoXsdStrict,
} from './saftXsdValidator.ts';
import {
  listarSeries,
  mergeSeriesFromCloud,
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
  validateAgtTaxCompliance,
} from './taxEngine.ts';
import {
  buildInvoiceIssuerSnapshot,
  createDefaultEstablishmentForCompany,
  JAIMONA_COMPANY,
  JAIMONA_COMPANY_ID,
  resolveCompanyProfileFromSnapshot,
  VITRONIS_INSTITUTIONAL,
  type CompanyProfile,
  type Customer,
  type InvoiceRecord,
  type Product,
  type Supplier,
  type TaxRate,
} from './types.ts';
import { normalizeCompanyMasterProfile, registerNewCompanyLocal } from '../services/localStore.ts';
import {
  generateNextCustomerInternalCode,
  validateAndBuildCustomer,
  validateCustomerForInvoiceEmission,
} from './customerValidator.ts';
import { renderCustomerMasterForm } from '../../frontend/ui/customerForm.ts';
import { renderDocumentHtml } from '../../frontend/ui/documentRenderer.ts';
import { renderMasterGovernanceModal } from '../../frontend/ui/masterGovernanceModal.ts';
import { renderMobileOperationalView } from '../../frontend/ui/mobileOperationalView.ts';
import {
  renderGeometricWatermarkLayer,
  renderSilaGeometricMark,
} from '../../frontend/ui/brandIdentity.ts';
import {
  renderNewCompanyModal,
  renderTenantOnboardingView,
} from '../../frontend/ui/multicompanyModals.ts';
import { renderTerminalLockScreen } from '../../frontend/ui/rbacViews.ts';
import {
  CATALOG_VIEW_MODE_STORAGE_KEY,
  readCatalogViewModePreference,
  renderCatalogProductCollection,
  renderCatalogViewModeSelector,
  resolveInitialCatalogViewMode,
  writeCatalogViewModePreference,
} from '../../frontend/ui/posCatalogView.ts';
import {
  generateCatalogOrQuotePdfBytes,
  generateDailySummaryPdfBytes,
  generateInvoicePdfBytes,
  generatePaymentReceiptPdfBytes,
  SILA_PDF_SIGNATURE,
} from './pdfGenerator.ts';
import {
  buildCatalogOrQuoteWhatsAppMessage,
  buildCollectionReminderWhatsAppMessage,
  buildDailyOwnerSummaryWhatsAppMessage,
  buildDocumentWhatsAppMessage,
  buildPaymentReceiptWhatsAppMessage,
  buildWhatsAppUrl,
  normalizeWhatsAppPhone,
  resolveOwnerWhatsAppPhone,
  WHATSAPP_DISCREET_SIGNATURE,
} from './whatsappChannel.ts';
import { renderWhatsAppShareModal } from '../../frontend/ui/whatsappShareModal.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[FASE 5 FALHA]: ${message}`);
  }
}

// Allowlists espelhadas exactamente de `firestore.rules`
const FIRESTORE_MASTER_PROFILE_KEYS = new Set([
  'legalNature', 'cae', 'commercialRegistry', 'shareCapital', 'taxRegime', 'taxOffice',
  'taxEntity', 'defaultExemptionCode', 'isVatRetentionAgent', 'defaultWithholdingTax',
  'specialTaxTerritory', 'agtEnvironment', 'activityStartDate', 'municipality', 'province',
  'postalCode', 'country', 'mobile', 'whatsapp', 'billingEmail', 'website', 'logoUrl',
  'showLogoOnPos', 'showLogoOnA4', 'bankName1', 'iban1', 'accountHolder1', 'swift1',
  'bankName2', 'iban2', 'accountHolder2', 'swift2', 'multicaixaExpressPhone',
  'defaultPaymentTermsDays', 'defaultEstablishmentId', 'establishments', 'warehouses',
  'legalRepresentativeName', 'legalRepresentativeRole', 'legalRepresentativeNif',
  'legalRepresentativePhone', 'accountantName', 'accountantOcpcaNumber',
  'accountantEmail', 'accountantPhone',
]);

const FIRESTORE_ESTABLISHMENT_KEYS = new Set([
  'id', 'code', 'name', 'isHeadquarters', 'address', 'municipality',
  'province', 'phone', 'email', 'defaultCashierCode', 'defaultWarehouseId', 'active',
]);

const FIRESTORE_WAREHOUSE_KEYS = new Set([
  'id', 'code', 'name', 'establishmentId', 'address', 'active',
]);

const FIRESTORE_SNAPSHOT_KEYS = new Set([
  'companyId', 'legalName', 'shortName', 'nif', 'taxRegime', 'taxOffice',
  'commercialRegistry', 'shareCapital', 'cae', 'address', 'municipality',
  'province', 'postalCode', 'cityCountry', 'phone', 'mobile', 'whatsapp',
  'email', 'billingEmail', 'website', 'tagline', 'logoUrl', 'showLogoOnPos',
  'showLogoOnA4', 'bankName1', 'iban1', 'accountHolder1', 'swift1',
  'bankName2', 'iban2', 'accountHolder2', 'swift2', 'multicaixaExpressPhone',
  'establishmentId', 'establishmentCode', 'establishmentName', 'establishmentAddress',
  'establishmentMunicipality', 'establishmentProvince',
  'legalRepresentativeName', 'legalRepresentativeRole', 'capturedAtIso',
]);

export async function runPhase5ValidationTests(): Promise<{ passed: number; total: number }> {
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

  console.log('\n=== FASE 5: TESTES INTEGRAIS DE VALIDAÇÃO, OFFLINE, SYNC, REGRESSÃO & XSD ===');

  // -------------------------------------------------------------------------
  // 1. FISCALIDADE & REGRESSÃO DO MOTOR TRIBUTÁRIO
  // -------------------------------------------------------------------------
  await test('5.1 Fiscalidade: conversão multi-taxa, retenções múltiplas (II + IVA_RET) e isenção obrigatória', () => {
    const line14 = calculateAgtLineItem({
      lineNumber: 1,
      productCode: 'SERV-01',
      productDescription: 'Consultoria & Auditoria',
      quantity: 2,
      unitPrice: 50000,
      unitPriceIncludesTax: false,
      taxCode: 'NOR',
      taxPercentage: 14,
    });
    const lineCabinda = calculateAgtLineItem({
      lineNumber: 2,
      productCode: 'CAB-01',
      productDescription: 'Mercadoria Cabinda 1%',
      quantity: 1,
      unitPrice: 10100,
      unitPriceIncludesTax: true,
      taxCode: 'INT',
      taxPercentage: 1,
    });
    const lineIsento = calculateAgtLineItem({
      lineNumber: 3,
      productCode: 'ARR-01',
      productDescription: 'Arroz Cesta Básica',
      quantity: 3,
      unitPrice: 4000,
      unitPriceIncludesTax: true,
      taxCode: 'ISE',
      taxPercentage: 0,
      exemptionCode: 'M10',
    });

    const compliance = validateAgtTaxCompliance([line14, lineCabinda, lineIsento]);
    assert(compliance.valid, `Conformidade devia ser válida: ${compliance.errors.join('; ')}`);

    const consolidated = calculateAgtDocumentTotals([line14, lineCabinda, lineIsento], {
      withholdingTaxes: [
        { type: 'II', ratePct: 6.5, baseAmount: 100000, reason: 'Retenção Serviços' },
        { type: 'IVA_RET', ratePct: 50 },
      ],
    });

    assert(consolidated.totals.totalTaxBaseNOR === 100000, 'Base NOR esperada 100000');
    assert(consolidated.totals.totalTaxAmountNOR === 14000, 'IVA NOR esperado 14000');
    assert(consolidated.totals.totalTaxBaseINT === 10000, 'Base Cabinda INT esperada 10000');
    assert(consolidated.totals.totalTaxAmountINT === 100, 'IVA Cabinda 1% esperado 100');
    assert(consolidated.totals.totalTaxBaseISE === 12000, 'Base isenta esperada 12000');
    // II = 6500; IVA_RET = 50% de 14100 = 7050 => total retenção = 13550
    assert(consolidated.totals.totalWithholdingTax === 13550, `Retenção esperada 13550, obtida ${consolidated.totals.totalWithholdingTax}`);
    assert(consolidated.totals.grossTotal === 136100, `GrossTotal esperado 136100, obtido ${consolidated.totals.grossTotal}`);
    assert(consolidated.totals.netPayableTotal === 122550, `NetPayable esperado 122550, obtido ${consolidated.totals.netPayableTotal}`);

    // Regressão 0% IVA vs 14%: convertCartItemsToAgtLines preserva 0% com M16 sem cair em 14%
    const zeroCart = convertCartItemsToAgtLines(
      [{ productId: 'z1', code: 'Z1', description: 'Medicamento Isento', unit: 'cx', qty: 1, unitPrice: 2500, discountPct: 0, ivaRate: 0, exemptionCode: 'M16' }],
      'M80'
    );
    assert(zeroCart[0]!.taxPercentage === 0 && zeroCart[0]!.taxCode === 'ISE', '0% deve manter taxPercentage=0 e taxCode=ISE');
    assert(zeroCart[0]!.exemptionCode === 'M16', 'Código de isenção M16 explícito deve ser preservado');

    // Reconciliação SAF-T de calculateInvoiceTotals (PVP inclui IVA -> NetTotal + TaxTotal == GrandTotal)
    const posMulti = calculateInvoiceTotals(
      [
        { productId: 'p14', code: 'P14', description: 'Normal 14%', unit: 'un', qty: 1, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
        { productId: 'p1', code: 'P1', description: 'Cabinda 1%', unit: 'un', qty: 1, unitPrice: 2020, discountPct: 0, ivaRate: 1 },
        { productId: 'p5', code: 'P5', description: 'Reduzida 5%', unit: 'un', qty: 1, unitPrice: 1050, discountPct: 0, ivaRate: 5 },
        { productId: 'p0', code: 'P0', description: 'Isento 0%', unit: 'un', qty: 1, unitPrice: 3000, discountPct: 0, ivaRate: 0, exemptionCode: 'M10' },
      ],
      10
    );
    const sumBases =
      posMulti.taxBase14 +
      (posMulti.taxBaseIntermediate || 0) +
      (posMulti.taxBaseReduced || 0) +
      posMulti.taxBase0;
    assert(Math.abs(sumBases - posMulti.merchandiseTotal) < 0.01, 'merchandiseTotal deve igualar soma das bases tributáveis líquidas');
    assert(Math.abs(sumBases + posMulti.taxTotal - posMulti.grandTotal) < 0.01, 'NetTotal + TaxPayable deve igualar GrandTotal sem dupla tributação');
  });

  // -------------------------------------------------------------------------
  // 2. ISOLAMENTO MULTIEMPRESA & SNAPSHOTS HISTÓRICOS
  // -------------------------------------------------------------------------
  await test('5.2 Isolamento Multiempresa: perfis, estabelecimentos, séries e snapshots sem fugas VITRONIS', () => {
    seriesStorage.clearMemoryCache();
    const companyAId = `comp_alfa_${Date.now()}`;
    const companyBId = `comp_beta_${Date.now()}`;
    const year = new Date().getFullYear();

    const profileA: CompanyProfile = {
      legalName: 'Alfa Distribuição Benguela, Lda',
      shortName: 'ALFA BENGUELA',
      legalNature: 'LDA',
      cae: '46900',
      commercialRegistry: 'CRC Benguela 102/2026',
      shareCapital: '2.000.000,00 Kz',
      nif: '5001234567',
      taxRegime: 'GERAL',
      taxOffice: 'Repartição Fiscal de Benguela',
      agtEnvironment: 'PRODUCAO',
      address: 'Rua 10 de Fevereiro, N.º 88',
      municipality: 'Benguela',
      province: 'Benguela',
      cityCountry: 'Benguela - Angola',
      postalCode: 'BG-01',
      phone: '+244 923 100 200',
      email: 'fiscal@alfabenguela.ao',
      tagline: 'Qualidade no Lobito e Benguela',
      bankName1: 'Banco BAI',
      iban1: 'AO06004000001111222233344',
      logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      showLogoOnA4: true,
      showLogoOnPos: false,
      establishments: [
        {
          id: 'est_alfa_001',
          code: '001',
          name: 'Sede Benguela',
          isHeadquarters: true,
          address: 'Rua 10 de Fevereiro, N.º 88',
          municipality: 'Benguela',
          province: 'Benguela',
          active: true,
        },
        {
          id: 'est_alfa_002',
          code: '002',
          name: 'Sucursal Lobito',
          isHeadquarters: false,
          address: 'Av. da Restinga, N.º 14',
          municipality: 'Lobito',
          province: 'Benguela',
          active: true,
        },
      ],
    };

    const profileB: CompanyProfile = {
      legalName: 'Beta Consultoria Lubango, S.A.',
      shortName: 'BETA LUBANGO',
      nif: '5007654321',
      taxRegime: 'EXCLUSAO',
      defaultExemptionCode: 'M80',
      agtEnvironment: 'SIMULACAO',
      address: 'Av. Agostinho Neto, N.º 5',
      municipality: 'Lubango',
      province: 'Huíla',
      cityCountry: 'Lubango - Angola',
      phone: '+244 912 999 888',
      email: 'geral@betalubango.ao',
      tagline: 'Consultoria Huíla',
    };

    // Solicitar séries independentes por empresa e estabelecimento
    solicitarSerie({
      companyId: companyAId,
      seriesCode: 'P02',
      seriesYear: year,
      documentType: 'FA',
      environment: 'PRODUCAO',
      establishmentId: 'est_alfa_002',
      establishmentCode: '002',
      companyProfile: profileA,
      operator: 'AdminAlfa',
    });

    solicitarSerie({
      companyId: companyBId,
      seriesCode: 'S01',
      seriesYear: year,
      documentType: 'FA',
      environment: 'SIMULACAO',
      operator: 'AdminBeta',
    });

    // Empresa B não pode enxergar séries da Empresa A nem emitir em PRODUCAO sem série PRODUCAO
    const listB = listarSeries({ companyId: companyBId });
    assert(listB.length === 1 && listB[0]!.seriesCode === 'S01', 'Empresa B só deve listar a própria série');
    const prodCheckB = validarPermissaoEmissaoFiscal(companyBId, 'FA', year, { environment: 'PRODUCAO' });
    assert(!prodCheckB.allowed, 'Empresa B sem série PRODUCAO não pode emitir em PRODUCAO');

    // Empresa A emite FA na Sucursal Lobito (est_alfa_002)
    const numRes = reservarProximoNumeroFiscal(companyAId, 'FA', year, undefined, {
      environment: 'PRODUCAO',
      establishmentId: 'est_alfa_002',
    });
    assert(numRes.documentNo === `FA P02/000001`, `Esperado FA P02/000001, obtido ${numRes.documentNo}`);

    const estLobito = profileA.establishments![1]!;
    const snapshotA = buildInvoiceIssuerSnapshot(profileA, {
      companyId: companyAId,
      establishment: estLobito,
    });
    const totals = calculateInvoiceTotals([
      { productId: 'p1', code: 'P1', description: 'Serviço Técnico', unit: 'hr', qty: 2, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
    ]);

    const invA: InvoiceRecord = {
      id: 'inv_alfa_lobito_1',
      companyId: companyAId,
      number: numRes.documentNo,
      docType: 'FA',
      issuedAtIso: '2026-05-10T10:00:00.000Z',
      createdAtIso: '2026-05-10T10:00:00.000Z',
      updatedAtIso: '2026-05-10T10:00:00.000Z',
      cashier: '01',
      operator: 'AdminAlfa',
      paymentMethod: 'Transferência',
      customerId: 'c1',
      customerName: 'Cliente Lobito',
      customerNif: '5004445556',
      customerLocality: 'Lobito',
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: 0,
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: totals.amountInWords,
      amountReceived: 0,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: totals.lines,
      establishmentId: estLobito.id,
      establishmentCode: estLobito.code,
      establishmentName: estLobito.name,
      seriesCode: numRes.seriesCode,
      seriesEnvironment: numRes.environment,
      issuerSnapshot: snapshotA,
    };

    // Renderiza com perfil errado (Beta) ou perfil mutado e verifica integridade absoluta do snapshot
    const resolvedFromSnapshot = resolveCompanyProfileFromSnapshot(invA, profileB);
    assert(resolvedFromSnapshot.nif === '5001234567', 'Snapshot deve impedir contaminação pelo NIF da Empresa B');
    assert(resolvedFromSnapshot.nif !== VITRONIS_INSTITUTIONAL.nif, 'Snapshot nunca pode vazar NIF da VITRONIS');

    const a4Html = renderDocumentHtml(invA, 'A4', profileB, '');
    assert(a4Html.includes('Alfa Distribuição Benguela, Lda'), 'A4 deve preservar denominação histórica da Empresa A');
    assert(a4Html.includes('Est. 002 · Sucursal Lobito'), 'A4 deve exibir estabelecimento 002');
    assert(a4Html.includes('Av. da Restinga, N.º 14'), 'A4 deve exibir endereço específico do estabelecimento 002');
    assert(!a4Html.includes('Beta Consultoria'), 'A4 não pode vazar dados da Empresa B');
    assert(
      a4Html.includes('Contribuinte / NIF: 5001234567') &&
        !a4Html.includes(`Contribuinte / NIF: ${VITRONIS_INSTITUTIONAL.nif}`),
      'A4 não pode vazar NIF da VITRONIS como emitente (apenas como produtor de software)'
    );
    assert(
      a4Html.includes(`NIF Produtor: ${VITRONIS_INSTITUTIONAL.nif}`),
      'A4 deve identificar o NIF completo do produtor do software no rodapé técnico'
    );

    // Garante também preservação do NIF âncora JAIMONA
    assert(JAIMONA_COMPANY_ID === 'comp_jaimona' && JAIMONA_COMPANY.nif === '5003069940', 'Empresa âncora comp_jaimona intacta');
  });

  // -------------------------------------------------------------------------
  // 3. FUNCIONAMENTO OFFLINE & REINICIALIZAÇÃO A FRIO
  // -------------------------------------------------------------------------
  await test('5.3 Offline: persistência localStorage de séries sobrevive a cold-start e normalização offline', () => {
    const store = new Map<string, string>();
    const prevWindow = (globalThis as any).window;
    (globalThis as any).window = {
      localStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => {
          store.set(k, v);
        },
        removeItem: (k: string) => {
          store.delete(k);
        },
      },
    };

    try {
      seriesStorage.clearMemoryCache();
      const offComp = `comp_offline_${Date.now()}`;
      const year = new Date().getFullYear();

      solicitarSerie({
        companyId: offComp,
        seriesCode: 'OFF26',
        seriesYear: year,
        documentType: 'FR',
        environment: 'SIMULACAO',
        operator: 'OfflineOp',
      });
      const r1 = reservarProximoNumeroFiscal(offComp, 'FR', year);
      const r2 = reservarProximoNumeroFiscal(offComp, 'FR', year);
      assert(r1.sequenceNumber === 1 && r2.sequenceNumber === 2, 'Offline deve avançar sequência 1 -> 2');

      // Simular reboot do navegador limpando cache em memória
      seriesStorage.clearMemoryCache();
      const reloaded = obterSerieAtiva(offComp, 'FR', year);
      assert(reloaded !== null && reloaded.lastDocumentNumber === 2 && reloaded.status === 'U', 'Após cold-start offline deve recuperar lastDocumentNumber=2 e status=U');

      const r3 = reservarProximoNumeroFiscal(offComp, 'FR', year);
      assert(r3.sequenceNumber === 3 && r3.documentNo === `FR OFF26/000003`, 'Após cold-start deve continuar em 3 sem duplicação');

      // Normalização offline de perfil legado sem estabelecimentos/armazéns
      const legacyMinimal: CompanyProfile = {
        legalName: 'Padaria Offline, Lda',
        shortName: 'PADARIA OFFLINE',
        nif: '5009998887',
        address: 'Rua Direita, N.º 3',
        cityCountry: 'Malanje - Angola',
        phone: '923000999',
        email: 'padaria@offline.ao',
        tagline: 'Pão Quente',
      };
      const normalized = normalizeCompanyMasterProfile(legacyMinimal);
      assert(normalized.establishments?.length === 1 && normalized.establishments[0]!.code === '001', 'Perfil legado offline deve auto-gerar estabelecimento matriz 001');
      assert(normalized.warehouses?.length === 1 && normalized.warehouses[0]!.code === 'ARM-01', 'Perfil legado offline deve auto-gerar armazém principal ARM-01');
      assert(normalized.agtEnvironment === 'SIMULACAO' && normalized.taxRegime === 'GERAL', 'Defaults fiscais offline devem permanecer íntegros');
    } finally {
      seriesStorage.clearMemoryCache();
      if (prevWindow === undefined) {
        delete (globalThis as any).window;
      } else {
        (globalThis as any).window = prevWindow;
      }
    }
  });

  // -------------------------------------------------------------------------
  // 4. SINCRONIZAÇÃO CLOUD & CONFORMIDADE FIRESTORE RULES
  // -------------------------------------------------------------------------
  await test('5.4 Cloud Sync: round-trip dos 9 blocos, bloqueio XSS e conformidade estrita com allowlists firestore.rules', () => {
    const fullProfile: CompanyProfile = {
      legalName: 'Kwanza Global Serviços, S.A.',
      shortName: 'KWANZA GLOBAL',
      legalNature: 'SA',
      cae: '62020',
      commercialRegistry: 'CRC Luanda 2026/77',
      shareCapital: '15.000.000,00 Kz',
      tagline: 'Soluções Empresariais',
      nif: '5004443332',
      taxRegime: 'GERAL',
      taxOffice: 'Repartição Fiscal dos Grandes Contribuintes',
      taxEntity: 'Sede Luanda',
      defaultExemptionCode: 'M10',
      isVatRetentionAgent: true,
      defaultWithholdingTax: 6.5,
      specialTaxTerritory: 'AO-CAB',
      agtEnvironment: 'PRODUCAO',
      activityStartDate: '2020-03-15',
      address: 'Av. Comandante Gika, Ed. Garden Towers',
      municipality: 'Luanda',
      province: 'Luanda',
      cityCountry: 'Luanda - Angola',
      postalCode: '1234',
      country: 'AO',
      phone: '+244 923 555 111',
      mobile: '+244 912 555 222',
      whatsapp: '+244 923 555 111',
      email: 'geral@kwanzaglobal.ao',
      billingEmail: 'facturacao@kwanzaglobal.ao',
      website: 'https://www.kwanzaglobal.ao',
      logoUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      showLogoOnPos: true,
      showLogoOnA4: true,
      bankName1: 'Banco BAI',
      iban1: 'AO06004000001219563410150',
      accountHolder1: 'Kwanza Global Serviços, S.A.',
      swift1: 'BAIPAOLU',
      bankName2: 'Banco BFA',
      iban2: 'AO06000600002222333344455',
      accountHolder2: 'Kwanza Global Serviços, S.A.',
      swift2: 'BFXAAOLU',
      multicaixaExpressPhone: '923555111',
      defaultPaymentTermsDays: 30,
      defaultEstablishmentId: 'est_001',
      establishments: [
        {
          id: 'est_001',
          code: '001',
          name: 'Sede Luanda',
          isHeadquarters: true,
          address: 'Av. Comandante Gika',
          municipality: 'Luanda',
          province: 'Luanda',
          phone: '923555111',
          email: 'sede@kwanzaglobal.ao',
          defaultCashierCode: '01',
          defaultWarehouseId: 'wh_001',
          active: true,
        },
        {
          id: 'est_002',
          code: '002',
          name: 'Loja Cabinda',
          isHeadquarters: false,
          address: 'Rua do Porto, Cabinda',
          municipality: 'Cabinda',
          province: 'Cabinda',
          active: true,
        },
      ],
      warehouses: [
        { id: 'wh_001', code: 'ARM-01', name: 'Armazém Central', establishmentId: 'est_001', address: 'Viana KM 12', active: true },
        { id: 'wh_002', code: 'ARM-02', name: 'Armazém Cabinda', establishmentId: 'est_002', active: true },
      ],
      legalRepresentativeName: 'Domingos António',
      legalRepresentativeRole: 'PCA',
      legalRepresentativeNif: '000111222LA033',
      legalRepresentativePhone: '923000001',
      accountantName: 'Carla Mendes',
      accountantOcpcaNumber: 'OCPCA-8821',
      accountantEmail: 'carla.mendes@ocpca.ao',
      accountantPhone: '923000002',
    };

    const mp = buildMasterProfileMap(fullProfile);
    for (const k of Object.keys(mp)) {
      assert(FIRESTORE_MASTER_PROFILE_KEYS.has(k), `Chave '${k}' em masterProfile não está na allowlist de firestore.rules`);
    }

    const estList = sanitizeEstablishmentsForCloud(fullProfile.establishments);
    assert(estList.length === 2, 'Deve serializar 2 estabelecimentos');
    for (const est of estList) {
      for (const k of Object.keys(est)) {
        assert(FIRESTORE_ESTABLISHMENT_KEYS.has(k), `Chave '${k}' em Establishment não está na allowlist de firestore.rules`);
      }
    }

    const whList = sanitizeWarehousesForCloud(fullProfile.warehouses);
    assert(whList.length === 2, 'Deve serializar 2 armazéns');
    for (const wh of whList) {
      for (const k of Object.keys(wh)) {
        assert(FIRESTORE_WAREHOUSE_KEYS.has(k), `Chave '${k}' em Warehouse não está na allowlist de firestore.rules`);
      }
    }

    const hydrated = hydrateProfileFromCloud(
      {
        legalName: fullProfile.legalName,
        shortName: fullProfile.shortName,
        nif: fullProfile.nif,
        address: fullProfile.address,
        cityCountry: fullProfile.cityCountry,
        phone: fullProfile.phone,
        email: fullProfile.email,
        tagline: fullProfile.tagline,
        masterProfile: mp,
      },
      'comp_kwanza'
    );

    assert(hydrated.legalName === fullProfile.legalName, 'Round-trip legalName');
    assert(hydrated.taxOffice === fullProfile.taxOffice, 'Round-trip taxOffice');
    assert(hydrated.specialTaxTerritory === 'AO-CAB', 'Round-trip specialTaxTerritory');
    assert(hydrated.isVatRetentionAgent === true, 'Round-trip isVatRetentionAgent');
    assert(hydrated.iban2 === fullProfile.iban2, 'Round-trip iban2');
    assert(hydrated.multicaixaExpressPhone === '923555111', 'Round-trip multicaixaExpressPhone');
    assert(hydrated.establishments?.length === 2 && hydrated.warehouses?.length === 2, 'Round-trip estabelecimentos e armazéns');
    assert(hydrated.accountantOcpcaNumber === 'OCPCA-8821', 'Round-trip cédula OCPCA');

    // Sanitização de IssuerSnapshot + bloqueio XSS SVG
    const rawSnap = buildInvoiceIssuerSnapshot(
      { ...fullProfile, logoUrl: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=' },
      { companyId: 'comp_kwanza', establishment: fullProfile.establishments![1]! }
    );
    const cloudSnap = sanitizeIssuerSnapshotForCloud(rawSnap);
    assert(Boolean(cloudSnap), 'Snapshot válido deve ser serializado');
    assert(!('logoUrl' in cloudSnap!), 'Logo SVG XSS deve ser removido na serialização Cloud');
    for (const k of Object.keys(cloudSnap!)) {
      assert(FIRESTORE_SNAPSHOT_KEYS.has(k), `Chave '${k}' em IssuerSnapshot não está na allowlist de firestore.rules`);
    }

    // Reconciliação offline/cloud de séries com preservação de maior número e estado
    const syncComp = `comp_sync_series_${Date.now()}`;
    const year = new Date().getFullYear();
    const sLocal = solicitarSerie({
      companyId: syncComp,
      seriesCode: 'SN26',
      seriesYear: year,
      documentType: 'FR',
      environment: 'PRODUCAO',
      companyProfile: fullProfile,
      operator: 'Op1',
    });
    reservarProximoNumeroFiscal(syncComp, 'FR', year, undefined, { environment: 'PRODUCAO' });
    reservarProximoNumeroFiscal(syncComp, 'FR', year, undefined, { environment: 'PRODUCAO' });

    const reconciled = mergeSeriesFromCloud(syncComp, [
      { ...sLocal, status: 'A', lastDocumentNumber: 1 }, // Cloud desactualizada
    ]);
    const recFr = reconciled.find((s) => s.id === sLocal.id);
    assert(recFr?.lastDocumentNumber === 2 && recFr.status === 'U', 'Cloud Sync nunca pode regredir numeração local mais alta');
  });

  // -------------------------------------------------------------------------
  // 5. REGRESSÃO MOBILE (9 REQUISITOS DE PRODUTO + ZERO ALERTS)
  // -------------------------------------------------------------------------
  await test('5.5 Regressão Mobile: modal de produto inclui os 9 campos operacionais e banner de erro inline', () => {
    const companyRecord = {
      id: 'comp_mob_1',
      normalizedNif: '5001234567',
      profile: JAIMONA_COMPANY,
      status: 'active' as const,
      plan: {
        planTier: 'PROFISSIONAL' as const,
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
    const html = renderMobileOperationalView({
      activeCompany: companyRecord,
      settings: {
        companyId: 'comp_mob_1',
        company: JAIMONA_COMPANY,
        defaultCashier: '01',
        defaultOperator: '001',
        defaultFormat: 'POS',
        defaultDocType: 'FR',
        defaultNotes: '',
        autoPrintOnEmit: false,
        hidePromotionalFooter: false,
        allowCashierPriceEdit: false,
        updatedAtIso: new Date().toISOString(),
      },
      companyMasterDraftProfile: null,
      companyMasterDraftSettings: null,
      companyMasterSection: 'ALL',
      companySeries: [],
      canManageCompanySettings: true,
      companyFormError: null,
      companyFormSavedNotice: false,
      showRequestAgtSeriesForm: false,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: false,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: false,
      editingWarehouse: null,
      warehouseError: null,
      isOnline: true,
      user: { email: 'admin@empresa.ao' },
      mobileTab: 'PRODUCTS',
      mobileCheckoutStep: 'CART',
      cart: [],
      products: [],
      customers: [],
      invoices: [],
      selectedCustomerId: '999999999',
      docType: 'FR',
      paymentMethod: 'Dinheiro',
      amountReceivedInput: '',
      mobileSearchQuery: '',
      mobileProductSearchInput: '',
      lastEmittedInvoice: null,
      showQuickProductModal: true,
      showQuickCustomerModal: false,
      showQuickCompanyModal: false,
      showCustomerPickerModal: false,
      editingMobileProduct: null,
      editingCustomer: null,
      editingCustomerCreditLimitInput: '',
      showCustomerAdvancedFields: false,
      mobileCustomerModalMode: 'QUICK',
      canEditExistingCustomers: true,
      quickCustomerDraft: {
        name: '',
        nif: '',
        phone: '',
        address: '',
        locality: 'Luanda',
        customerType: 'PARTICULAR',
        countryCode: 'AO',
        foreignTaxId: '',
      },
      quickProductError: 'Erro de validação inline no modal móvel',
      quickCustomerError: null,
      operator: '001',
      canViewCostPrices: true,
      canViewProfitsMargins: true,
    });

    for (const marker of [
      'name="code"',
      'name="barcode"',
      'name="category"',
      'name="unit"',
      'name="costPrice"',
      'name="price"',
      'name="ivaRate"',
      'value="0"',
      'name="active"',
      'name="exemptionReason"',
      'Erro de validação inline no modal móvel',
    ]) {
      assert(html.includes(marker), `Modal mobile de artigo deve conter '${marker}'`);
    }

    const restrictedHtml = renderMobileOperationalView({
      activeCompany: companyRecord,
      settings: {
        companyId: 'comp_mob_1',
        company: JAIMONA_COMPANY,
        defaultCashier: '01',
        defaultOperator: '001',
        defaultFormat: 'POS',
        defaultDocType: 'FR',
        defaultNotes: '',
        autoPrintOnEmit: false,
        hidePromotionalFooter: false,
        allowCashierPriceEdit: false,
        updatedAtIso: new Date().toISOString(),
      },
      companyMasterDraftProfile: null,
      companyMasterDraftSettings: null,
      companyMasterSection: 'ALL',
      companySeries: [],
      canManageCompanySettings: false,
      companyFormError: null,
      companyFormSavedNotice: false,
      showRequestAgtSeriesForm: false,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: false,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: false,
      editingWarehouse: null,
      warehouseError: null,
      isOnline: true,
      user: { email: 'caixa@empresa.ao' },
      mobileTab: 'PRODUCTS',
      mobileCheckoutStep: 'CART',
      cart: [],
      products: [],
      customers: [],
      invoices: [],
      selectedCustomerId: '999999999',
      docType: 'FR',
      paymentMethod: 'Dinheiro',
      amountReceivedInput: '',
      mobileSearchQuery: '',
      mobileProductSearchInput: '',
      lastEmittedInvoice: null,
      showQuickProductModal: true,
      showQuickCustomerModal: false,
      showQuickCompanyModal: false,
      showCustomerPickerModal: false,
      editingMobileProduct: null,
      editingCustomer: null,
      editingCustomerCreditLimitInput: '',
      showCustomerAdvancedFields: false,
      mobileCustomerModalMode: 'QUICK',
      canEditExistingCustomers: false,
      quickCustomerDraft: {
        name: '',
        nif: '',
        phone: '',
        address: '',
        locality: 'Luanda',
        customerType: 'PARTICULAR',
        countryCode: 'AO',
        foreignTaxId: '',
      },
      quickProductError: null,
      quickCustomerError: null,
      operator: '001',
      canViewCostPrices: false,
      canViewProfitsMargins: false,
    });
    assert(!restrictedHtml.includes('name="costPrice"'), 'Operador sem cost_prices_view não pode ver input costPrice no mobile');
    assert(!restrictedHtml.includes('mobile-product-margin-readout'), 'Operador sem profits_margins_view não pode ver margem de lucro no mobile');
  });

  // -------------------------------------------------------------------------
  // 6. VALIDAÇÃO ESTRITA XSD SAF-T (AO) v1.01_01 (POSITIVO + NEGATIVO)
  // -------------------------------------------------------------------------
  await test('5.6 SAF-T XSD Positivo: valida XML completo com &, multi-taxa, NC, anulada, Fornecedores e WorkingDocuments', () => {
    const company: CompanyProfile = {
      ...JAIMONA_COMPANY,
      legalName: 'A & B Comércio <Geral>, Lda',
      shortName: 'A & B COMÉRCIO',
      nif: '5003069940',
      address: 'Rua da Missão & Kizomba, N.º 12',
      municipality: 'Luanda',
      province: 'Luanda',
      postalCode: '1000',
      taxEntity: 'Sede Luanda',
      phone: '+244 923 111 222',
      email: 'fiscal@aebcomercio.ao',
    };

    const suppliers: Supplier[] = [
      {
        id: 'sup_xml_1',
        companyId: 'comp_jaimona',
        name: 'Fornecedor Alpha & Filhos, Lda',
        nif: '5005554443',
        phone: '923000111',
        email: 'fornecedor@alpha.ao',
        address: 'Viana, Luanda',
        locality: 'Luanda',
      },
    ];

    const customers: Customer[] = [
      {
        id: 'cli_xml_1',
        name: 'Cliente Silva & Irmãos, S.A.',
        nif: '5008889991',
        phone: '924000111',
        address: 'Talatona, Luanda',
        locality: 'Luanda',
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
    ];

    const products: Product[] = [
      {
        id: 'p_nor',
        code: 'P-NOR',
        name: 'Equipamento & Rede',
        productType: 'P',
        category: 'Tecnologia',
        unit: 'UN',
        price: 11400,
        ivaRate: 14,
        exemptionReason: '',
        active: true,
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
      {
        id: 'p_cab',
        code: 'P-CAB',
        name: 'Serviço Cabinda',
        productType: 'S',
        category: 'Serviços',
        unit: 'HR',
        price: 2020,
        ivaRate: 1,
        exemptionReason: '',
        active: true,
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
      {
        id: 'p_ise',
        code: 'P-ISE',
        name: 'Arroz Cesta Básica',
        productType: 'P',
        category: 'Alimentação',
        unit: 'KG',
        price: 3000,
        ivaRate: 0,
        exemptionCode: 'M10',
        exemptionReason: 'Cesta Básica',
        active: true,
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
    ];

    const t1 = calculateInvoiceTotals([
      { productId: 'p_nor', code: 'P-NOR', description: 'Equipamento & Rede', unit: 'UN', qty: 1, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
      { productId: 'p_cab', code: 'P-CAB', description: 'Serviço Cabinda', unit: 'HR', qty: 1, unitPrice: 2020, discountPct: 0, ivaRate: 1 },
      { productId: 'p_ise', code: 'P-ISE', description: 'Arroz Cesta Básica', unit: 'KG', qty: 1, unitPrice: 3000, discountPct: 0, ivaRate: 0, exemptionCode: 'M10' },
    ]);

    const tNc = calculateInvoiceTotals([
      { productId: 'p_nor', code: 'P-NOR', description: 'Devolução Equipamento', unit: 'UN', qty: 1, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
    ]);

    const invoices: InvoiceRecord[] = [
      {
        id: 'inv_xsd_1',
        number: 'FR A2026/000001',
        docType: 'FR',
        issuedAtIso: '2026-06-05T10:00:00.000Z',
        createdAtIso: '2026-06-05T10:00:00.000Z',
        updatedAtIso: '2026-06-05T10:00:00.000Z',
        cashier: '01',
        operator: 'Op1',
        paymentMethod: 'Multicaixa',
        customerId: 'cli_xml_1',
        customerName: 'Cliente Silva & Irmãos, S.A.',
        customerNif: '5008889991',
        customerLocality: 'Luanda',
        merchandiseTotal: t1.merchandiseTotal,
        discountTotal: 0,
        taxBase14: t1.taxBase14,
        taxAmount14: t1.taxAmount14,
        taxBaseIntermediate: t1.taxBaseIntermediate,
        taxAmountIntermediate: t1.taxAmountIntermediate,
        taxBaseReduced: 0,
        taxAmountReduced: 0,
        taxBase0: t1.taxBase0,
        taxAmount0: 0,
        taxTotal: t1.taxTotal,
        grandTotal: t1.grandTotal,
        amountInWords: t1.amountInWords,
        amountReceived: t1.grandTotal,
        changeAmount: 0,
        notes: '',
        status: 'issued',
        lines: t1.lines,
      },
      {
        id: 'inv_xsd_nc',
        number: 'NC A2026/000001',
        docType: 'NC',
        issuedAtIso: '2026-06-06T12:00:00.000Z',
        createdAtIso: '2026-06-06T12:00:00.000Z',
        updatedAtIso: '2026-06-06T12:00:00.000Z',
        cashier: '01',
        operator: 'Op1',
        paymentMethod: 'Transferência',
        customerId: 'cli_xml_1',
        customerName: 'Cliente Silva & Irmãos, S.A.',
        customerNif: '5008889991',
        customerLocality: 'Luanda',
        returnOriginInvoiceId: 'inv_xsd_1',
        returnOriginNumber: 'FR A2026/000001',
        cancelReason: 'Devolução parcial',
        merchandiseTotal: tNc.merchandiseTotal,
        discountTotal: 0,
        taxBase14: tNc.taxBase14,
        taxAmount14: tNc.taxAmount14,
        taxBase0: 0,
        taxAmount0: 0,
        taxTotal: tNc.taxTotal,
        grandTotal: tNc.grandTotal,
        amountInWords: tNc.amountInWords,
        amountReceived: 0,
        changeAmount: 0,
        notes: '',
        status: 'issued',
        lines: tNc.lines,
      },
      {
        id: 'inv_xsd_canc',
        number: 'FA A2026/000001',
        docType: 'FA',
        issuedAtIso: '2026-06-07T14:00:00.000Z',
        createdAtIso: '2026-06-07T14:00:00.000Z',
        updatedAtIso: '2026-06-07T14:30:00.000Z',
        cancelledAtIso: '2026-06-07T14:30:00.000Z',
        cashier: '01',
        operator: 'Op1',
        paymentMethod: 'Crédito',
        customerId: 'cli_xml_1',
        customerName: 'Cliente Silva & Irmãos, S.A.',
        customerNif: '5008889991',
        customerLocality: 'Luanda',
        merchandiseTotal: tNc.merchandiseTotal,
        discountTotal: 0,
        taxBase14: tNc.taxBase14,
        taxAmount14: tNc.taxAmount14,
        taxBase0: 0,
        taxAmount0: 0,
        taxTotal: tNc.taxTotal,
        grandTotal: tNc.grandTotal,
        amountInWords: tNc.amountInWords,
        amountReceived: 0,
        changeAmount: 0,
        notes: '',
        cancelReason: 'Anulada por erro de cliente',
        status: 'cancelled',
        lines: tNc.lines,
      },
      {
        id: 'inv_xsd_fp',
        number: 'FP A2026/000001',
        docType: 'FP',
        issuedAtIso: '2026-06-08T09:00:00.000Z',
        createdAtIso: '2026-06-08T09:00:00.000Z',
        updatedAtIso: '2026-06-08T09:00:00.000Z',
        cashier: '01',
        operator: 'Op1',
        paymentMethod: 'Transferência',
        customerId: 'cli_xml_1',
        customerName: 'Cliente Silva & Irmãos, S.A.',
        customerNif: '5008889991',
        customerLocality: 'Luanda',
        merchandiseTotal: tNc.merchandiseTotal,
        discountTotal: 0,
        taxBase14: tNc.taxBase14,
        taxAmount14: tNc.taxAmount14,
        taxBase0: 0,
        taxAmount0: 0,
        taxTotal: tNc.taxTotal,
        grandTotal: tNc.grandTotal,
        amountInWords: tNc.amountInWords,
        amountReceived: 0,
        changeAmount: 0,
        notes: '',
        status: 'issued',
        lines: tNc.lines,
      },
    ];

    const saft = generateSaftAoXml({
      company,
      invoices,
      products,
      customers,
      suppliers,
      options: { fiscalYear: 2026, periodMonth: 6, startDate: '2026-06-01', endDate: '2026-06-30' },
    });

    const xsdReport = validateSaftAoXsdStrict(saft.xml);
    assert(
      xsdReport.valid && xsdReport.errors.length === 0,
      `SAF-T gerado deve passar 100% na validação XSD estrita. Erros: ${xsdReport.errors.map((e) => `${e.path}: ${e.message}`).join(' | ')}`
    );
    assert(xsdReport.stats.salesInvoices === 3, `Esperadas 3 facturas em SalesInvoices, obtidas ${xsdReport.stats.salesInvoices}`);
    assert(xsdReport.stats.workingDocuments === 1, `Esperado 1 documento em WorkingDocuments, obtido ${xsdReport.stats.workingDocuments}`);
    assert(xsdReport.stats.suppliers === 1, 'Deve contabilizar 1 fornecedor');
  });

  await test('5.7 SAF-T XSD Negativo: validador detecta sequência XSD inválida, & não escapado, References fora de Line e divergência numérica', () => {
    const t = calculateInvoiceTotals([
      { productId: 'p1', code: 'P1', description: 'Produto Teste', unit: 'UN', qty: 1, unitPrice: 11400, discountPct: 0, ivaRate: 14 },
    ]);
    const validSaft = generateSaftAoXml({
      company: JAIMONA_COMPANY,
      invoices: [
        {
          id: 'inv_neg_1',
          number: 'FR A2026/000001',
          docType: 'FR',
          issuedAtIso: '2026-06-01T10:00:00.000Z',
          createdAtIso: '2026-06-01T10:00:00.000Z',
          updatedAtIso: '2026-06-01T10:00:00.000Z',
          cashier: '01',
          operator: 'Op1',
          paymentMethod: 'Dinheiro',
          customerId: '999999999',
          customerName: 'Consumidor Final',
          customerNif: '999999999',
          customerLocality: 'Luanda',
          merchandiseTotal: t.merchandiseTotal,
          discountTotal: 0,
          taxBase14: t.taxBase14,
          taxAmount14: t.taxAmount14,
          taxBase0: 0,
          taxAmount0: 0,
          taxTotal: t.taxTotal,
          grandTotal: t.grandTotal,
          amountInWords: t.amountInWords,
          amountReceived: t.grandTotal,
          changeAmount: 0,
          notes: '',
          status: 'issued',
          lines: t.lines,
        },
      ],
    });

    // (a) Ordem xs:sequence quebrada em Header
    const badSeq = validSaft.xml.replace(
      /<CompanyName>([\s\S]*?)<\/CompanyName>\s*<BusinessName>([\s\S]*?)<\/BusinessName>/,
      '<BusinessName>$2</BusinessName>\n    <CompanyName>$1</CompanyName>'
    );
    const rSeq = validateSaftAoXsdStrict(badSeq);
    assert(!rSeq.valid && rSeq.errors.some((e) => e.code === 'XSD_SEQUENCE'), 'Deve detectar violação <xs:sequence> em Header');

    // (b) <References> colocado fora de <Line>
    const badRef = validSaft.xml.replace(
      '<CustomerID>',
      '<References><Reference>FR 2026/0</Reference></References>\n        <CustomerID>'
    );
    const rRef = validateSaftAoXsdStrict(badRef);
    assert(!rRef.valid && rRef.errors.some((e) => e.code === 'XSD_SEQUENCE'), 'Deve rejeitar <References> fora de <Line>');

    // (c) '&' não escapado
    const badAmp = validSaft.xml.replace('Consumidor Final', 'Comercio & Servicos');
    const rAmp = validateSaftAoXsdStrict(badAmp);
    assert(!rAmp.valid && rAmp.errors.some((e) => e.code === 'XML_SYNTAX'), 'Deve detectar "&" não escapado');

    // (d) Divergência em TotalCredit e NumberOfEntries
    const badTotals = validSaft.xml
      .replace('<NumberOfEntries>1</NumberOfEntries>', '<NumberOfEntries>9</NumberOfEntries>')
      .replace(/<TotalCredit>[\d.]+<\/TotalCredit>/, '<TotalCredit>999999.00</TotalCredit>');
    const rTot = validateSaftAoXsdStrict(badTotals);
    assert(
      !rTot.valid && rTot.errors.filter((e) => e.code === 'XSD_RECONCILIATION').length >= 2,
      'Deve detectar divergência de NumberOfEntries e TotalCredit'
    );

    // (e) Data inválida fora do padrão YYYY-MM-DD
    const badDate = validSaft.xml.replace(/<InvoiceDate>\d{4}-\d{2}-\d{2}<\/InvoiceDate>/, '<InvoiceDate>01/06/2026</InvoiceDate>');
    const rDate = validateSaftAoXsdStrict(badDate);
    assert(!rDate.valid && rDate.errors.some((e) => e.code === 'XSD_DATATYPE'), 'Deve detectar InvoiceDate inválido');
  });

  // -------------------------------------------------------------------------
  // 7. CADASTRO DE CLIENTES (TIPOS, CRÉDITO, CÓDIGO, HISTÓRICO, ESTRANGEIRO SAF-T & PARIDADE 5 SECÇÕES)
  // -------------------------------------------------------------------------
  await test('5.7 Cadastro de Cliente: Particular, Empresa, Estrangeiro, Crédito, NIF único por empresa e Imutabilidade histórica', () => {
    const compA = 'comp_cli_a';
    const compB = 'comp_cli_b';

    // (a) Código interno sequencial por empresa
    const code1 = generateNextCustomerInternalCode([], compA);
    assert(code1 === 'CLI-0001', `Esperado CLI-0001, obtido ${code1}`);

    // (b) Empresa exige NIF AO válido + domicílio fiscal completo
    const badEmp = validateAndBuildCustomer(
      {
        companyId: compA,
        customerType: 'EMPRESA',
        active: true,
        name: 'Alfa Tech, Lda',
        nif: '999999999',
        phone: '923100200',
        address: '',
      },
      { companyId: compA, existingCustomers: [] }
    );
    assert(!badEmp.ok, 'Empresa não pode ser registada com NIF Consumidor Final');

    const okEmp = validateAndBuildCustomer(
      {
        companyId: compA,
        customerType: 'EMPRESA',
        active: true,
        name: 'Alfa Tech, Lda',
        nif: '5001234567',
        phone: '923100200',
        email: 'contabilidade@alfatech.ao',
        province: 'Luanda',
        municipality: 'Belas',
        address: 'Via Expressa, Edifício Alfa',
      },
      { companyId: compA, existingCustomers: [] }
    );
    assert(okEmp.ok && okEmp.customer?.internalCode === 'CLI-0001', 'Empresa válida deve receber CLI-0001');

    // (c) Bloqueio de duplicação na mesma empresa, mas permitido noutra empresa
    const dupEmp = validateAndBuildCustomer(
      {
        companyId: compA,
        customerType: 'EMPRESA',
        active: true,
        name: 'Duplicada Lda',
        nif: '500 123 4567',
        phone: '923999888',
        province: 'Luanda',
        municipality: 'Luanda',
        address: 'Maianga',
      },
      { companyId: compA, existingCustomers: [okEmp.customer!] }
    );
    assert(!dupEmp.ok, 'NIF duplicado dentro da mesma empresa deve ser bloqueado');

    const otherCompEmp = validateAndBuildCustomer(
      {
        companyId: compB,
        customerType: 'EMPRESA',
        active: true,
        name: 'Alfa Tech Filial B',
        nif: '5001234567',
        phone: '923100200',
        province: 'Benguela',
        municipality: 'Benguela',
        address: 'Centro',
      },
      { companyId: compB, existingCustomers: [okEmp.customer!] }
    );
    assert(otherCompEmp.ok && otherCompEmp.customer?.internalCode === 'CLI-0001', 'Outra empresa pode cadastrar mesmo NIF com CLI-0001 isolado');

    // (d) Particular com crédito exige NIF e contacto
    const badPartCredit = validateAndBuildCustomer(
      {
        companyId: compA,
        customerType: 'PARTICULAR',
        active: true,
        name: 'João Baptista',
        nif: '',
        phone: '924000111',
        address: 'Rocha Pinto',
        creditLimit: 50000,
        paymentTerms: '30_DIAS',
      },
      { companyId: compA, existingCustomers: [okEmp.customer!] }
    );
    assert(!badPartCredit.ok, 'Particular com crédito exige NIF');

    // (e) Cliente Estrangeiro com país PT e NIF estrangeiro sem forçar NIF AO -> Exportação SAF-T AO + XSD
    const foreignRes = validateAndBuildCustomer(
      {
        companyId: compA,
        customerType: 'ESTRANGEIRO',
        active: true,
        name: 'Lusitania Exports, S.A.',
        nif: '',
        countryCode: 'PT',
        foreignTaxId: 'PT508991234',
        phone: '+351 210 000 000',
        address: 'Av. da Liberdade 100, Lisboa',
      },
      { companyId: compA, existingCustomers: [okEmp.customer!] }
    );
    assert(
      foreignRes.ok &&
        foreignRes.customer?.countryCode === 'PT' &&
        foreignRes.customer?.foreignTaxId === 'PT508991234' &&
        foreignRes.customer?.internalCode === 'CLI-0002',
      'Cliente estrangeiro deve aceitar identificação fiscal estrangeira e país PT'
    );

    // (f) Consumidor final liberado para venda directa e bloqueado para crédito/inactivo
    const directCheckOk = validateCustomerForInvoiceEmission(null, {
      companyId: compA,
      docType: 'FR',
      paymentMethod: 'Dinheiro',
      amountDue: 0,
    });
    assert(directCheckOk.allowed, 'Consumidor Final deve emitir FR à vista sem cadastro');
    const directCreditFail = validateCustomerForInvoiceEmission(null, {
      companyId: compA,
      docType: 'FR',
      paymentMethod: 'Crédito',
      amountDue: 1000,
    });
    assert(!directCreditFail.allowed, 'Consumidor Final não pode comprar a crédito');

    // (g) Histórico de alterações sem modificar facturas históricas
    const oldInvoiceSnapshot: Pick<InvoiceRecord, 'customerId' | 'customerName' | 'customerNif'> = {
      customerId: okEmp.customer!.id,
      customerName: okEmp.customer!.name,
      customerNif: okEmp.customer!.nif,
    };
    const editedEmp = validateAndBuildCustomer(
      {
        id: okEmp.customer!.id,
        companyId: compA,
        customerType: 'EMPRESA',
        active: true,
        internalCode: okEmp.customer!.internalCode,
        name: 'Alfa Tech Angola, S.A.',
        nif: '5001234567',
        phone: '923100201',
        province: 'Luanda',
        municipality: 'Belas',
        address: 'Nova Sede, Belas',
      },
      {
        companyId: compA,
        existingCustomers: [okEmp.customer!],
        previousCustomer: okEmp.customer!,
        actorLabel: 'Gestor',
      }
    );
    assert(
      editedEmp.ok &&
        (editedEmp.customer?.changeHistory?.length || 0) === 1 &&
        oldInvoiceSnapshot.customerName === 'Alfa Tech, Lda',
      'Alteração do cliente deve registar changeHistory sem alterar facturas já emitidas'
    );

    // (h) SAF-T XML para cliente estrangeiro mantém <Country>PT</Country> válido no XSD
    const foreignProd: Product = {
      id: 'p1',
      code: 'P001',
      name: 'Serviço Exportação',
      category: 'Serviços',
      unit: 'un',
      price: 10000,
      ivaRate: 14,
      exemptionReason: '',
      active: true,
      createdAtIso: '2026-06-01T09:00:00.000Z',
      updatedAtIso: '2026-06-01T09:00:00.000Z',
    };
    const tot = calculateInvoiceTotals([
      {
        productId: foreignProd.id,
        code: foreignProd.code,
        description: foreignProd.name,
        unit: foreignProd.unit,
        qty: 1,
        unitPrice: foreignProd.price,
        discountPct: 0,
        ivaRate: 14,
      },
    ]);
    const foreignSaft = generateSaftAoXml({
      company: {
        ...JAIMONA_COMPANY,
        nif: '5003069940',
        province: 'Luanda',
        municipality: 'Luanda',
        address: 'Centro',
      },
      customers: [foreignRes.customer!],
      products: [foreignProd],
      invoices: [
        {
          id: 'inv_for_1',
          companyId: compA,
          number: 'FR S12026/000001',
          seriesCode: 'S1',
          docType: 'FR',
          paymentMethod: 'Transferência',
          cashier: '01',
          operator: 'Op',
          issuedAtIso: '2026-06-05T10:00:00.000Z',
          createdAtIso: '2026-06-05T10:00:00.000Z',
          updatedAtIso: '2026-06-05T10:00:00.000Z',
          customerId: foreignRes.customer!.id,
          customerName: foreignRes.customer!.name,
          customerNif: foreignRes.customer!.nif,
          customerLocality: foreignRes.customer!.locality,
          merchandiseTotal: tot.merchandiseTotal,
          discountTotal: 0,
          taxBase14: tot.taxBase14,
          taxAmount14: tot.taxAmount14,
          taxBase0: 0,
          taxAmount0: 0,
          taxTotal: tot.taxTotal,
          grandTotal: tot.grandTotal,
          amountInWords: tot.amountInWords,
          amountReceived: tot.grandTotal,
          changeAmount: 0,
          notes: '',
          status: 'issued',
          lines: tot.lines,
        },
      ],
    });
    assert(
      foreignSaft.xml.includes('<Country>PT</Country>') &&
        foreignSaft.xml.includes('<CustomerTaxID>PT508991234</CustomerTaxID>') &&
        validateSaftAoXsdStrict(foreignSaft.xml).valid,
      'SAF-T deve exportar cliente estrangeiro com Country=PT e passar validação XSD'
    );
  });

  await test('5.8 Paridade 5 Secções Desktop e Mobile no Formulário de Cliente + Campos Avançados', () => {
    const sampleCust: Customer = {
      id: 'cust_parity_1',
      companyId: 'comp_1',
      internalCode: 'CLI-0007',
      customerType: 'EMPRESA',
      active: true,
      name: 'Kwanza Distribuição, Lda',
      nif: '5001234567',
      countryCode: 'AO',
      province: 'Luanda',
      municipality: 'Viana',
      address: 'ZEE Luanda-Bengo',
      locality: 'Viana · Luanda',
      phone: '+244 923 000 111',
      email: 'geral@kwanza.ao',
      creditLimit: 250000,
      paymentTerms: '30_DIAS',
      notes: 'Cliente prioritário',
      createdAtIso: '2026-06-01T09:00:00.000Z',
      updatedAtIso: '2026-06-01T09:00:00.000Z',
    };

    for (const viewMode of ['DESKTOP', 'MOBILE'] as const) {
      const html = renderCustomerMasterForm({
        mode: viewMode,
        companyId: 'comp_1',
        customer: sampleCust,
        creditLimitInput: '250000',
        formId: viewMode === 'DESKTOP' ? 'customer-form' : 'mobile-quick-customer-form',
        isDirectCustomer: false,
        showAdvanced: true,
        errorMessage: null,
        canManage: true,
        defaultLocality: 'Luanda',
      });
      for (const marker of [
        '01 — Identificação',
        '02 — Contactos',
        '03 — Endereço',
        '04 — Dados Comerciais',
        '05 — Observações',
        'name="customerType"',
        'name="active"',
        'name="name"',
        'name="nif"',
        'name="phone"',
        'name="email"',
        'name="province"',
        'name="municipality"',
        'name="address"',
        'name="creditLimit"',
        'name="paymentTerms"',
        'name="notes"',
        'name="bankName"',
        'name="bankIban"',
        'name="documentRef"',
        'name="representativeName"',
        'name="representativePhone"',
        'name="specialCreditNotes"',
      ]) {
        assert(html.includes(marker), `Modo ${viewMode} do formulário de cliente deve conter '${marker}'`);
      }
    }
  });

  await test('5.10 Estrutura POS/A4 consolidada: 25 pontos de integridade fiscal, QR SVG imediato, cliente, pagamentos, Huambo e produtor', () => {
    const huamboProfile: CompanyProfile = {
      ...JAIMONA_COMPANY,
      shortName: 'Bela Vista',
      legalName: 'Bela Vista Comércio Geral, Lda',
      nif: '5002571293',
      address: 'Av. Norton de Matos, N.º 45',
      municipality: 'Huambo',
      province: 'Huambo',
      cityCountry: 'Huambo - Angola',
      tagline: 'Obrigado pela preferência',
    };
    const estHuambo = createDefaultEstablishmentForCompany(huamboProfile);
    assert(
      !estHuambo.name.startsWith('Bela Vista'),
      'Estabelecimento padrão não deve repetir o nome comercial no prefixo'
    );

    const warnShortNif = evaluateCompanyMasterCompleteness(
      { ...huamboProfile, nif: '500257129' },
      { series: [], requireProductionSeriesCheck: false }
    );
    assert(
      warnShortNif.warnings.some((w) => w.field === 'nif' && w.message.includes('último dígito')),
      'Deve alertar quando NIF societário começar por 5 com apenas 9 dígitos'
    );

    const totals = calculateInvoiceTotals([
      {
        productId: 'p_rice',
        code: 'ARR01',
        description: 'Arroz Agulha 25Kg',
        unit: 'sc',
        qty: 2,
        unitPrice: 1250,
        discountPct: 10,
        ivaRate: 0,
        exemptionCode: 'M10',
        exemptionReason: 'Isento — Cesta Básica',
      },
      {
        productId: 'p_oil',
        code: 'OLE01',
        description: 'Óleo Alimentar 1L',
        unit: 'un',
        qty: 1,
        unitPrice: 1000,
        discountPct: 0,
        ivaRate: 14,
      },
    ]);

    const invEmpresa: InvoiceRecord = {
      id: 'inv_pos_25pts',
      companyId: 'comp_belavista',
      number: 'FR P2026/000012',
      docType: 'FR',
      issuedAtIso: '2026-07-15T14:35:00.000Z',
      createdAtIso: '2026-07-15T14:35:00.000Z',
      updatedAtIso: '2026-07-15T14:35:00.000Z',
      cashier: '01',
      operator: '001',
      paymentMethod: 'Combinado',
      paymentSplits: [
        { method: 'Dinheiro', amount: 2000 },
        { method: 'Multicaixa', amount: 1500, reference: 'TPA-441' },
      ],
      customerId: 'cust_emp_1',
      customerType: 'EMPRESA',
      customerCountryCode: 'AO',
      customerName: 'Planalto Logística, Lda',
      customerNif: '5001122334',
      customerAddress: 'Rua Mariano Machado, N.º 10',
      customerPhone: '923445566',
      customerEmail: 'faturas@planalto.ao',
      customerLocality: 'Huambo, Huambo',
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: totals.discountTotal,
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBase0: totals.taxBase0,
      taxAmount0: 0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: totals.amountInWords,
      amountReceived: 3500,
      changeAmount: roundKz(3500 - totals.grandTotal),
      notes: '',
      status: 'issued',
      lines: totals.lines,
      establishmentId: estHuambo.id,
      establishmentCode: estHuambo.code,
      establishmentName: estHuambo.name,
      seriesCode: 'P2026',
      seriesEnvironment: 'PRODUCAO',
      atcud: 'AGT-2026-001-12',
      saftHash4: 'pf2F',
      issuerSnapshot: buildInvoiceIssuerSnapshot(huamboProfile, {
        companyId: 'comp_belavista',
        establishment: estHuambo,
      }),
    };

    const posHtml = renderDocumentHtml(invEmpresa, 'POS', huamboProfile, '');
    assert(posHtml.includes('Contribuinte (NIF): 5002571293'), 'POS deve mostrar NIF completo de 10 dígitos');
    assert(posHtml.includes('Empresa'), 'POS deve distinguir tipo de cliente Empresa');
    assert(posHtml.includes('NIF Cliente: 5001122334'), 'POS deve exibir NIF do cliente');
    assert(posHtml.includes('Rua Mariano Machado, N.º 10'), 'POS deve exibir morada do cliente');
    assert(posHtml.includes('923445566') && posHtml.includes('faturas@planalto.ao'), 'POS deve exibir telefone e e-mail do cliente');
    assert(posHtml.includes('Caixa: <span class="font-semibold">01</span>') && posHtml.includes('Operador(a): <span class="font-semibold">001</span>'), 'POS deve separar visualmente Caixa e Operador');
    assert(posHtml.includes('Artigo · Qtd × P. Unit.') && posHtml.includes('>Subtotal<'), 'POS deve ter barra estruturada para artigos sem tabela de células vazias');
    assert(!posHtml.includes('<table'), 'POS não deve usar tabela rígida com células vazias nos artigos');
    assert(!posHtml.includes('1.250,002.500,00'), 'POS não pode concatenar preço unitário e subtotal');
    assert(
      posHtml.includes('M10: Isento, Art.º 12.º, alínea a) do CIVA') &&
        !posHtml.includes('Isento nos termos da Lei do IVA (Bens da Cesta Básica) (Art.º 12.º, alínea a) do CIVA) —'),
      'POS deve apresentar código e fundamento legal conciso de isenção sem repetitividade'
    );
    assert(posHtml.includes('Desc. artigo: -10,00%'), 'POS deve discriminar desconto do artigo');
    assert(posHtml.includes('Dinheiro') && posHtml.includes('Multicaixa (TPA-441)'), 'POS deve discriminar pagamentos múltiplos');
    assert(posHtml.includes('Est. 001 · Sede / Loja Principal'), 'POS deve apresentar estabelecimento sem repetir Bela Vista');
    assert(!posHtml.includes('Est. 001 · Bela Vista'), 'POS não deve duplicar o nome comercial no estabelecimento');
    assert(posHtml.includes('DOCUMENTO FISCAL · SÉRIE P2026'), 'POS deve apresentar série documental');
    assert(posHtml.includes('ATCUD: AGT-2026-001-12'), 'POS deve apresentar ATCUD atribuído');
    const qrSvgMatches = (posHtml.match(/<svg /g) || []).length;
    assert(qrSvgMatches === 1, `POS deve renderizar exactamente 1 QR Code SVG efectivo (encontrados ${qrSvgMatches})`);
    assert(!posHtml.includes('QR AGT (Produção)</div>') && !posHtml.includes('QR Verificação (Simulação)</div>'), 'POS não deve duplicar legenda abaixo do QR Code');
    assert(posHtml.includes('pf2F-Processado por programa validado SILA-Billing') && posHtml.includes('RSA-SHA1'), 'POS deve preservar integralmente a assinatura/hash SAF-T');
    assert(posHtml.includes('FISCAL VÁLIDO (PRODUÇÃO AGT)'), 'POS deve identificar claramente o estado fiscal');
    assert(posHtml.includes('Huambo, Huambo'), 'POS deve exibir localidade informada do cliente');
    assert(posHtml.includes('Huambo - Angola'), 'POS deve exibir localidade dinâmica do estabelecimento no Huambo');
    assert(!posHtml.includes('Luanda - Angola'), 'POS do Huambo não deve exibir Luanda fixa');
    assert(!posHtml.includes('Meio de pagamento:'), 'POS não deve repetir Meio de pagamento quando detalha Pagamentos');
    const thankCount = (posHtml.match(/obrigado pela/gi) || []).length;
    assert(thankCount === 1, `POS não deve duplicar mensagem de agradecimento (encontradas ${thankCount})`);
    assert(posHtml.includes('Software SILA-Billing v1.0 · Produtor: VITRONIS, Lda · NIF 5002571293'), 'POS deve uniformizar identificação do software e produtor');

    // Teste Consumidor Final herdando Huambo dinamicamente e ocultando Troco quando zero
    const invConsumidorFinal: InvoiceRecord = {
      ...invEmpresa,
      id: 'inv_pos_cf_huambo',
      customerId: 'cust_direct_comp_belavista',
      customerType: 'CONSUMIDOR_FINAL',
      customerName: 'Cliente de Venda Directa',
      customerNif: 'Consumidor Final',
      customerAddress: undefined,
      customerPhone: undefined,
      customerEmail: undefined,
      customerLocality: 'Luanda - Angola',
      paymentMethod: 'Multicaixa',
      paymentSplits: undefined,
      amountReceived: totals.grandTotal,
      changeAmount: 0,
      status: 'cancelled',
      seriesEnvironment: 'SIMULACAO',
      atcud: undefined,
    };
    const cfHtml = renderDocumentHtml(invConsumidorFinal, 'POS', huamboProfile, '');
    assert(cfHtml.includes('Consumidor Final'), 'POS deve identificar cliente Consumidor Final');
    assert(cfHtml.includes('Localidade: Huambo - Angola'), 'Consumidor Final deve herdar localidade dinâmica do Huambo');
    assert(!cfHtml.includes('Luanda - Angola'), 'Consumidor Final no Huambo não deve manter Luanda antiga');
    assert(!cfHtml.includes('Troco:'), 'Troco zero não deve ser exibido no POS');
    assert(cfHtml.includes('ANULADO'), 'POS deve destacar estado ANULADO para documentos anulados');
  });

  await test('5.10 Registo Inicial de Empresa: selector obrigatório de Regime de IVA (zero auto-selecção), Simulação obrigatória e atalho discreto para Ficha Mestre', async () => {
    // 1. Modal inicial de cadastro não pode pré-seleccionar regime de IVA
    const newCompanyHtml = renderNewCompanyModal({
      errorMessage: null,
      isSubmitting: false,
      isSignedIn: false,
    });
    assert(
      newCompanyHtml.includes('name="taxRegime"') &&
        newCompanyHtml.includes('<option value="" selected disabled>Seleccionar regime fiscal de IVA...</option>'),
      'Modal de registo inicial deve exigir selecção manual do regime de IVA sem valor pré-seleccionado'
    );
    for (const regime of ['value="GERAL"', 'value="SIMPLIFICADO"', 'value="EXCLUSAO"']) {
      assert(newCompanyHtml.includes(regime), `Modal inicial deve listar opção ${regime}`);
      assert(
        !newCompanyHtml.includes(`${regime} selected`),
        `Opção ${regime} nunca pode vir pré-seleccionada automaticamente`
      );
    }
    assert(
      newCompanyHtml.includes('Inicia em') && newCompanyHtml.includes('Simulação'),
      'Modal inicial deve informar que a empresa inicia em Simulação até completar a Ficha Mestre'
    );

    // 2. Modal Master de criação administrativa de empresa também exige regime de IVA sem pré-selecção
    const masterHtml = renderMasterGovernanceModal({
      isSignedIn: true,
      userEmail: 'wtmedia0@gmail.com',
      isLoading: false,
      accessDenied: false,
      errorMessage: null,
      searchQuery: '',
      mergedCompanies: [],
      recentLogs: [],
      activeCompanyId: 'comp_test',
      activeTab: 'companies',
      showNewCompanyForm: true,
    });
    assert(
      masterHtml.includes('id="master-new-company-form"') &&
        masterHtml.includes('name="taxRegime"') &&
        masterHtml.includes('<option value="" selected disabled>Seleccionar regime fiscal de IVA...</option>'),
      'Modal Master de nova empresa deve exigir selecção manual do regime de IVA'
    );

    // 3. registerNewCompanyLocal rejeita estritamente registo sem taxRegime explícito
    let rejectedMissingRegime = false;
    try {
      await registerNewCompanyLocal({
        legalName: 'Kiala Comercial, Lda',
        shortName: 'KIALA',
        nif: '5401122330',
        taxRegime: '' as any,
      });
    } catch (err) {
      rejectedMissingRegime =
        err instanceof Error && err.message.includes('Regime Fiscal de IVA');
    }
    assert(rejectedMissingRegime, 'registerNewCompanyLocal deve rejeitar registo sem Regime de IVA explícito');

    // 4. Empresa recém-registada com dados simplificados fica bloqueada de Produção até Ficha Mestre completa
    const partialProfile: CompanyProfile = {
      legalName: 'Kiala Comercial, Lda',
      shortName: 'KIALA',
      nif: '5401122330',
      taxRegime: 'SIMPLIFICADO',
      agtEnvironment: 'SIMULACAO',
      address: 'Rua 1, Talatona',
      cityCountry: 'Luanda - Angola',
      phone: '+244 923 000 111',
      email: '',
      tagline: 'Obrigado pela preferência',
    };
    const incompleteEval = evaluateCompanyMasterCompleteness(partialProfile, {
      series: [],
      requireProductionSeriesCheck: true,
    });
    assert(
      !incompleteEval.readyForProductionEmission && incompleteEval.completionPct < 100,
      'Empresa com registo inicial incompleto não pode estar pronta para Produção AGT'
    );

    // 5. No telemóvel, exibe indicação discreta + acesso imediato à Ficha Mestre apenas quando incompleta
    const mobileCompany = {
      id: 'comp_kiala',
      normalizedNif: '5401122330',
      profile: partialProfile,
      status: 'active' as const,
      plan: {
        planTier: 'FREE' as const,
        commercialActive: false,
        maxUsers: null,
        maxInvoicesPerMonth: null,
        updatedAtIso: new Date().toISOString(),
      },
      baseSequence: 0,
      allowManagerCancel: false,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const baseMobileProps = {
      activeCompany: mobileCompany,
      settings: {
        companyId: 'comp_kiala',
        company: partialProfile,
        defaultCashier: '01',
        defaultOperator: '001',
        defaultFormat: 'POS' as const,
        defaultDocType: 'FR' as const,
        defaultNotes: '',
        autoPrintOnEmit: false,
        hidePromotionalFooter: false,
        allowCashierPriceEdit: false,
        updatedAtIso: new Date().toISOString(),
      },
      companyMasterDraftProfile: null,
      companyMasterDraftSettings: null,
      companyMasterSection: 'ALL' as const,
      companySeries: [],
      canManageCompanySettings: true,
      companyFormError: null,
      companyFormSavedNotice: false,
      showRequestAgtSeriesForm: false,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: false,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: false,
      editingWarehouse: null,
      warehouseError: null,
      isOnline: true,
      user: { email: 'kiala@empresa.ao' },
      mobileTab: 'HOME' as const,
      mobileCheckoutStep: 'CART' as const,
      cart: [],
      products: [],
      customers: [],
      invoices: [],
      selectedCustomerId: '999999999',
      docType: 'FR' as const,
      paymentMethod: 'Dinheiro' as const,
      amountReceivedInput: '',
      mobileSearchQuery: '',
      mobileProductSearchInput: '',
      lastEmittedInvoice: null,
      showQuickProductModal: false,
      showQuickCustomerModal: false,
      showQuickCompanyModal: false,
      showCustomerPickerModal: false,
      editingMobileProduct: null,
      editingCustomer: null,
      editingCustomerCreditLimitInput: '',
      showCustomerAdvancedFields: false,
      mobileCustomerModalMode: 'QUICK' as const,
      canEditExistingCustomers: true,
      quickCustomerDraft: {
        name: '',
        nif: '',
        phone: '',
        address: '',
        locality: 'Luanda',
        customerType: 'PARTICULAR' as const,
        countryCode: 'AO',
        foreignTaxId: '',
      },
      quickProductError: null,
      quickCustomerError: null,
      operator: '001',
      canViewMaster: true,
      masterCompletionPct: incompleteEval.completionPct,
      isMasterProductionReady: false,
    };

    const mobileIncompleteHtml = renderMobileOperationalView(baseMobileProps);
    assert(
      mobileIncompleteHtml.includes(`Modo Simulação · Ficha Mestre (${incompleteEval.completionPct}%)`) &&
        mobileIncompleteHtml.includes('data-action="mobile-open-quick-company"') &&
        mobileIncompleteHtml.includes('Completar →'),
      'Home Mobile deve exibir indicação minimalista de Ficha Mestre incompleta com acesso directo em 1 toque'
    );

    const mobileReadyHtml = renderMobileOperationalView({
      ...baseMobileProps,
      masterCompletionPct: 100,
      isMasterProductionReady: true,
    });
    assert(
      !mobileReadyHtml.includes('Modo Simulação · Ficha Mestre'),
      'Home Mobile deve ocultar a barra discreta quando a Ficha Mestre e Produção estiverem completas'
    );
  });

  await test('5.11 Catálogo POS/A4 (Lista vs Touch): matchMedia inicial, localStorage sem sobrescrever escolha manual, lista responsiva e cartões touch preservados', () => {
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
    };

    // 1. Detecção inicial via matchMedia('(pointer: fine)') apenas sem escolha guardada
    assert(
      resolveInitialCatalogViewMode((q) => ({ matches: q === '(pointer: fine)' })) === 'list',
      'Ponteiro fino (rato) deve iniciar em modo list quando não há escolha guardada'
    );
    assert(
      resolveInitialCatalogViewMode(() => ({ matches: false })) === 'touch',
      'Dispositivo sem ponteiro fino deve iniciar em modo touch quando não há escolha guardada'
    );
    assert(
      readCatalogViewModePreference(mockStorage, () => ({ matches: true })) === 'list',
      'Sem valor no localStorage, deve usar matchMedia inicial (list)'
    );

    // 2. Escolha manual em localStorage nunca é sobrescrita por matchMedia
    writeCatalogViewModePreference('touch', mockStorage);
    assert(
      store.get(CATALOG_VIEW_MODE_STORAGE_KEY) === 'touch',
      'localStorage deve guardar valor permitido touch'
    );
    assert(
      readCatalogViewModePreference(mockStorage, () => ({ matches: true })) === 'touch',
      'Escolha manual touch deve prevalecer mesmo com (pointer: fine) activo'
    );

    writeCatalogViewModePreference('list', mockStorage);
    assert(
      readCatalogViewModePreference(mockStorage, () => ({ matches: false })) === 'list',
      'Escolha manual list deve prevalecer mesmo em dispositivo touch'
    );

    // 3. Selector minimalista Lista / Touch
    const selectorHtml = renderCatalogViewModeSelector('list');
    assert(
      selectorHtml.includes('data-action="set-catalog-view-mode"') &&
        selectorHtml.includes('data-value="list"') &&
        selectorHtml.includes('aria-pressed="true"') &&
        selectorHtml.includes('data-value="touch"') &&
        selectorHtml.includes('aria-pressed="false"'),
      'Selector minimalista deve expor os dois modos (list/touch) com estado aria-pressed consistente'
    );

    // 4. Motor único: mesmos produtos, cart, data-action="add-to-cart" nos dois modos
    const sampleProducts: Product[] = [
      {
        id: 'prod_excel_1',
        code: 'ARR-25KG',
        name: 'Arroz Tio Lucas Agulha Longo Especial Saco 25 Kilogramas Importado',
        productType: 'P',
        category: 'Mercearia',
        unit: 'sc',
        price: 24500,
        ivaRate: 0,
        exemptionCode: 'M10',
        exemptionReason: 'Cesta Básica',
        trackStock: true,
        stockQty: 18,
        minStockQty: 5,
        active: true,
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
      {
        id: 'prod_excel_2',
        code: 'SERV-IT',
        name: 'Assistência Técnica Remota e Presencial Mensal',
        productType: 'S',
        category: 'Serviços',
        unit: 'hr',
        price: 11400,
        ivaRate: 14,
        exemptionReason: '',
        trackStock: false,
        active: true,
        createdAtIso: '2026-06-01T09:00:00.000Z',
        updatedAtIso: '2026-06-01T09:00:00.000Z',
      },
    ];
    const sampleCart = [
      {
        productId: 'prod_excel_1',
        code: 'ARR-25KG',
        description: sampleProducts[0]!.name,
        unit: 'sc',
        qty: 2,
        unitPrice: 24500,
        discountPct: 0,
        ivaRate: 0 as const,
        exemptionCode: 'M10' as const,
      },
    ];

    const listHtml = renderCatalogProductCollection({
      products: sampleProducts,
      cart: sampleCart,
      mode: 'list',
      action: 'add-to-cart',
      isSuspended: false,
    });
    assert(
      listHtml.includes('@container') &&
        listHtml.includes('min-h-[30px]') &&
        listHtml.includes('data-action="add-to-cart"') &&
        listHtml.includes('data-id="prod_excel_1"') &&
        listHtml.includes('24.500,00 Kz') &&
        listHtml.includes('×2') &&
        listHtml.includes('18 sc') &&
        listHtml.includes('title="ARR-25KG · Arroz Tio Lucas') &&
        listHtml.includes('line-clamp-2 @sm:line-clamp-1'),
      'Modo Lista deve renderizar linhas horizontais compactas estilo Excel responsivas com nomes longos legíveis, stock, preço e mesmo add-to-cart'
    );

    const touchHtml = renderCatalogProductCollection({
      products: sampleProducts,
      cart: sampleCart,
      mode: 'touch',
      action: 'add-to-cart',
      isSuspended: false,
    });
    assert(
      touchHtml.includes('grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3') &&
        touchHtml.includes('min-h-[92px]') &&
        touchHtml.includes('data-action="add-to-cart"') &&
        touchHtml.includes('data-id="prod_excel_1"') &&
        touchHtml.includes('×2'),
      'Modo Touch deve preservar integralmente a grelha e dimensão min-h-[92px] dos cartões táteis'
    );
  });

  await test('5.12 Ecrã de Bloqueio Minimalista: selector único de operador, zero jornais/Limpar e Privacidade reservada ao cadastro inicial', () => {
    const compRecord = {
      id: 'comp_jaimona',
      normalizedNif: '5003069940',
      profile: JAIMONA_COMPANY,
      status: 'active' as const,
      plan: {
        planTier: 'PROFISSIONAL' as const,
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
    const lockHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [
        {
          id: 'mem_owner_1',
          companyId: 'comp_jaimona',
          uid: 'uid_owner_1',
          email: 'owner@jaimona.ao',
          displayName: 'Proprietário',
          role: 'owner',
          allowInvoiceCancel: true,
          pinHash: 'pbkdf2$100000$salt$hash',
          active: true,
          status: 'active',
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
        },
        {
          id: 'mem_cashier_1',
          companyId: 'comp_jaimona',
          uid: 'uid_cashier_1',
          email: 'maria@jaimona.ao',
          displayName: 'Maria Caixa',
          role: 'cashier',
          allowInvoiceCancel: false,
          pinHash: 'pbkdf2$100000$salt$hash2',
          active: true,
          status: 'active',
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
        },
      ],
      roles: [],
      selectedMemberId: 'mem_owner_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: true,
      isSignedIn: false,
      signedInEmail: '',
      isPlatformAdmin: false,
    });

    assert(
      lockHtml.includes('JAIMONA') && lockHtml.includes('NIF 5003069940'),
      'Ecrã de bloqueio deve manter identificação da empresa e NIF no topo'
    );
    for (const forbidden of [
      'Terminal Protegido',
      'RBAC Activo',
      '1. Identificação do Operador',
      '2. Autenticação Individual',
      'Limpar',
      'Política de Privacidade',
      'open-privacy-policy',
    ]) {
      assert(
        !lockHtml.includes(forbidden),
        `Ecrã de bloqueio não deve conter texto ou controlo eliminado: '${forbidden}'`
      );
    }
    assert(
      lockHtml.includes('id="lock-screen-member-select"') &&
        lockHtml.includes('Introduza o seu PIN (4 a 6 dígitos)') &&
        lockHtml.includes('id="terminal-unlock-pin-input"') &&
        lockHtml.includes('data-action="lock-keypad-backspace"') &&
        lockHtml.includes('Desbloquear Terminal'),
      'Ecrã de bloqueio deve conter selector único de operador, campo PIN, apagamento tradicional e botão de desbloqueio'
    );

    const regModalHtml = renderNewCompanyModal({
      errorMessage: null,
      isSubmitting: false,
      isSignedIn: false,
    });
    assert(
      regModalHtml.includes('data-action="open-privacy-policy"') &&
        regModalHtml.includes('Política de Privacidade'),
      'Política de Privacidade deve estar acessível na janela de cadastro inicial'
    );
  });

  await test('5.13 Identidade Geométrica Minimalista: SVG inline puro, zero URLs externos, bloqueio/onboarding/mobile/desktop e isolamento de impressão', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    // 1. Marca e camada geométrica puramente inline (zero dependências, zero URLs externos, zero imagens)
    const markSvg = renderSilaGeometricMark('w-4 h-4 text-blue-400');
    const darkWatermark = renderGeometricWatermarkLayer('dark', 'center');
    const lightWatermark = renderGeometricWatermarkLayer('light', 'corner');

    for (const fragment of [markSvg, darkWatermark, lightWatermark]) {
      assert(fragment.includes('<svg') && fragment.includes('</svg>'), 'Identidade deve usar apenas SVG inline');
      assert(!/https?:\/\//i.test(fragment), 'Identidade geométrica não pode conter URLs externos');
      assert(!/<img/i.test(fragment), 'Identidade geométrica não pode usar imagens raster externas');
    }
    for (const wm of [darkWatermark, lightWatermark]) {
      assert(
        wm.includes('no-print') &&
          wm.includes('sila-watermark-layer') &&
          wm.includes('pointer-events-none') &&
          wm.includes('aria-hidden="true"'),
        'Fundo d’água geométrico deve ser não-interactivo e isolado da impressão'
      );
    }

    // 2. Onboarding (Desktop & Mobile) e Bloqueio em modo offline com identidade geométrica
    const onboardingHtml = renderTenantOnboardingView({
      userEmail: '',
      isSignedIn: false,
      isOnline: false,
      isSyncing: false,
      syncMessage: null,
    });
    assert(
      onboardingHtml.includes('sila-bg-grid-light') &&
        onboardingHtml.includes('sila-watermark-layer') &&
        onboardingHtml.includes('sila-card-elevated') &&
        onboardingHtml.includes('Cadastrar Nova Empresa'),
      'Onboarding deve apresentar micro-grelha clara, selo geométrico e cartão elevado funcionando offline'
    );

    const compRecord = {
      id: 'comp_jaimona',
      normalizedNif: '5003069940',
      profile: JAIMONA_COMPANY,
      status: 'active' as const,
      plan: {
        planTier: 'PROFISSIONAL' as const,
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

    const lockHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [
        {
          id: 'mem_owner_1',
          companyId: 'comp_jaimona',
          uid: 'uid_owner_1',
          email: 'owner@jaimona.ao',
          displayName: 'Proprietário',
          role: 'owner',
          allowInvoiceCancel: true,
          pinHash: 'pbkdf2$100000$salt$hash',
          active: true,
          status: 'active',
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
        },
      ],
      roles: [],
      selectedMemberId: 'mem_owner_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: false,
      isSignedIn: false,
      signedInEmail: '',
      isPlatformAdmin: false,
    });
    assert(
      lockHtml.includes('no-print') &&
        lockHtml.includes('sila-bg-grid-dark') &&
        lockHtml.includes('sila-watermark-layer'),
      'Ecrã de bloqueio deve aplicar micro-grelha escura e selo geométrico com isolamento no-print'
    );

    const mobileHtml = renderMobileOperationalView({
      activeCompany: compRecord,
      settings: {
        companyId: 'comp_jaimona',
        company: JAIMONA_COMPANY,
        defaultCashier: '01',
        defaultOperator: '001',
        defaultFormat: 'POS',
        defaultDocType: 'FR',
        defaultNotes: '',
        autoPrintOnEmit: false,
        hidePromotionalFooter: false,
        allowCashierPriceEdit: false,
        updatedAtIso: new Date().toISOString(),
      },
      companyMasterDraftProfile: null,
      companyMasterDraftSettings: null,
      companyMasterSection: 'ALL',
      companySeries: [],
      canManageCompanySettings: true,
      companyFormError: null,
      companyFormSavedNotice: false,
      showRequestAgtSeriesForm: false,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: false,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: false,
      editingWarehouse: null,
      warehouseError: null,
      isOnline: false,
      user: null,
      mobileTab: 'HOME',
      mobileCheckoutStep: 'CART',
      cart: [],
      products: [],
      customers: [],
      invoices: [],
      selectedCustomerId: '999999999',
      docType: 'FR',
      paymentMethod: 'Dinheiro',
      amountReceivedInput: '',
      mobileSearchQuery: '',
      mobileProductSearchInput: '',
      lastEmittedInvoice: null,
      showQuickProductModal: false,
      showQuickCustomerModal: false,
      showQuickCompanyModal: false,
      showCustomerPickerModal: false,
      editingMobileProduct: null,
      editingCustomer: null,
      editingCustomerCreditLimitInput: '',
      showCustomerAdvancedFields: false,
      mobileCustomerModalMode: 'QUICK',
      canEditExistingCustomers: true,
      quickCustomerDraft: {
        name: '',
        nif: '',
        phone: '',
        address: '',
        locality: 'Luanda',
        customerType: 'PARTICULAR',
        countryCode: 'AO',
        foreignTaxId: '',
      },
      quickProductError: null,
      quickCustomerError: null,
      operator: '001',
      canSellPos: true,
      canViewProducts: true,
      canViewCustomers: true,
      canViewDocs: true,
      canViewMaster: true,
    });
    assert(
      mobileHtml.includes('sila-bg-grid-dark') &&
        mobileHtml.includes('sila-watermark-layer') &&
        mobileHtml.includes('Offline'),
      'Workspace Mobile deve preservar modo offline com micro-grelha escura e selo geométrico'
    );

    // 3. CSS de impressão isola grelha/selos + renderDocumentHtml (A4 e POS) permanece 100% intacto sem marcas d'água
    const indexCss = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    const printSection = indexCss.slice(indexCss.indexOf('@media print'));
    assert(
      printSection.includes('.sila-watermark-layer') &&
        printSection.includes('.sila-bg-grid-light') &&
        printSection.includes('.sila-bg-grid-dark') &&
        printSection.includes('background-image: none !important'),
      'Regra @media print em src/index.css deve anular completamente fundos, grelhas e selos na impressão'
    );

    const appTs = fs.readFileSync(path.resolve(process.cwd(), 'frontend/app.ts'), 'utf8');
    assert(
      appTs.includes('sila-shell-bar') &&
        appTs.includes('sila-bg-grid-light') &&
        appTs.includes("renderGeometricWatermarkLayer('light', 'corner')"),
      'Shell Desktop deve integrar barra institucional, micro-grelha clara e selo geométrico no workspace'
    );

    const t = calculateInvoiceTotals([
      { productId: 'p1', code: 'P1', description: 'Artigo Teste', unit: 'un', qty: 1, unitPrice: 1140, discountPct: 0, ivaRate: 14 },
    ]);
    const sampleInv: InvoiceRecord = {
      id: 'inv_print_clean',
      number: 'FR A2026/000001',
      docType: 'FR',
      issuedAtIso: '2026-06-10T10:00:00.000Z',
      createdAtIso: '2026-06-10T10:00:00.000Z',
      updatedAtIso: '2026-06-10T10:00:00.000Z',
      cashier: '01',
      operator: '001',
      paymentMethod: 'Dinheiro',
      customerId: '999999999',
      customerName: 'Consumidor Final',
      customerNif: '999999999',
      customerLocality: 'Luanda - Angola',
      merchandiseTotal: t.merchandiseTotal,
      discountTotal: 0,
      taxBase14: t.taxBase14,
      taxAmount14: t.taxAmount14,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: t.taxTotal,
      grandTotal: t.grandTotal,
      amountInWords: t.amountInWords,
      amountReceived: t.grandTotal,
      changeAmount: 0,
      notes: '',
      status: 'issued',
      lines: t.lines,
    };

    for (const fmt of ['A4', 'POS'] as const) {
      const docHtml = renderDocumentHtml(sampleInv, fmt, JAIMONA_COMPANY, '');
      assert(
        !docHtml.includes('sila-watermark-layer') && !docHtml.includes('sila-bg-grid'),
        `Documento ${fmt} não pode receber marcas d'água nem estilos de grelha da interface`
      );
    }
  });

  await test('5.14 Recuperação de PIN do Proprietário no Ecrã de Bloqueio: opção visível só para Owner, fluxo Google + redefinição', () => {
    const compRecord = {
      id: 'comp_jaimona',
      normalizedNif: '5003069940',
      profile: JAIMONA_COMPANY,
      status: 'active' as const,
      plan: {
        planTier: 'PROFISSIONAL' as const,
        commercialActive: true,
        maxUsers: null,
        maxInvoicesPerMonth: null,
        updatedAtIso: new Date().toISOString(),
      },
      baseSequence: 0,
      allowManagerCancel: false,
      ownerEmail: 'jaimonacomercioeservicos@gmail.com',
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const ownerMem = {
      id: 'mem_owner_1',
      companyId: 'comp_jaimona',
      uid: 'uid_owner_1',
      email: 'jaimonacomercioeservicos@gmail.com',
      displayName: 'Proprietário',
      role: 'owner' as const,
      allowInvoiceCancel: true,
      pinHash: 'pbkdf2_sha256$100000$salt$hash',
      active: true,
      status: 'active' as const,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
    const cashierMem = {
      ...ownerMem,
      id: 'mem_cashier_1',
      uid: 'uid_cashier_1',
      email: 'caixa@jaimona.ao',
      displayName: 'Caixa 1',
      role: 'cashier' as const,
      allowInvoiceCancel: false,
    };

    const ownerLockHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [ownerMem, cashierMem],
      roles: [],
      selectedMemberId: 'mem_owner_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: true,
      isSignedIn: false,
      signedInEmail: '',
      isPlatformAdmin: false,
      ownerRecoveryStep: 'NONE',
    });
    assert(
      ownerLockHtml.includes('data-action="lock-owner-recovery-open"') &&
        ownerLockHtml.includes('Esqueceu o PIN do Proprietário?'),
      'Proprietário com PIN configurado deve ver acesso discreto para recuperação por Google'
    );

    const cashierLockHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [ownerMem, cashierMem],
      roles: [],
      selectedMemberId: 'mem_cashier_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: true,
      isSignedIn: false,
      signedInEmail: '',
      isPlatformAdmin: false,
      ownerRecoveryStep: 'VERIFY_GOOGLE',
    });
    assert(
      !cashierLockHtml.includes('lock-owner-recovery-open') &&
        !cashierLockHtml.includes('lock-owner-recovery-verify-google') &&
        !cashierLockHtml.includes('recover-owner-pin-form'),
      'Caixa nunca pode aceder ao fluxo de recuperação Google nem redefinição de PIN de Proprietário'
    );

    const verifyGoogleHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [ownerMem, cashierMem],
      roles: [],
      selectedMemberId: 'mem_owner_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: true,
      isSignedIn: false,
      signedInEmail: '',
      isPlatformAdmin: false,
      ownerRecoveryStep: 'VERIFY_GOOGLE',
    });
    assert(
      verifyGoogleHtml.includes('data-action="lock-owner-recovery-verify-google"') &&
        verifyGoogleHtml.includes('Confirmar com Google') &&
        verifyGoogleHtml.includes('data-action="lock-owner-recovery-cancel"'),
      'Passo VERIFY_GOOGLE deve exigir confirmação interactiva da conta Google do Proprietário'
    );

    const setNewPinHtml = renderTerminalLockScreen({
      company: compRecord,
      companies: [compRecord],
      members: [ownerMem, cashierMem],
      roles: [],
      selectedMemberId: 'mem_owner_1',
      pinInput: '',
      newPinConfirmInput: '',
      isSubmitting: false,
      errorMessage: null,
      lockReasonMessage: null,
      isOnline: true,
      isSignedIn: true,
      signedInEmail: 'jaimonacomercioeservicos@gmail.com',
      isPlatformAdmin: false,
      ownerRecoveryStep: 'SET_NEW_PIN',
    });
    assert(
      setNewPinHtml.includes('data-form="recover-owner-pin-form"') &&
        setNewPinHtml.includes('id="lock-recover-pin"') &&
        setNewPinHtml.includes('id="lock-recover-pin-confirm"') &&
        setNewPinHtml.includes('Redefinir PIN e Desbloquear'),
      'Passo SET_NEW_PIN deve permitir redefinir o PIN do Proprietário após confirmação Google'
    );
  });

  await test('5.15 Canal Comercial WhatsApp Nativo: PDF 1.4 real (FR/RC/FP, Comprovativo, Catálogo/Orçamento, Resumo Diário), assinatura discreta e UI', () => {
    // 1. Normalização telefónica angolana e internacional + URL wa.me
    const p1 = normalizeWhatsAppPhone('943 671 515');
    assert(p1.valid && p1.digits === '244943671515' && p1.display === '+244943671515', 'Número local de 9 dígitos deve normalizar para 244...');
    const p2 = normalizeWhatsAppPhone('00244 923-100-200');
    assert(p2.valid && p2.digits === '244923100200', 'Prefixo 00244 deve normalizar sem 00');
    const p3 = normalizeWhatsAppPhone('+351 912 345 678');
    assert(p3.valid && p3.digits === '351912345678', 'Número internacional deve preservar indicativo');
    const waUrl = buildWhatsAppUrl(p1.digits, 'Olá Teste');
    assert(waUrl.startsWith('https://wa.me/244943671515?text='), 'URL wa.me deve incluir dígitos E.164 e texto codificado');

    const companyProf: CompanyProfile = {
      ...JAIMONA_COMPANY,
      shortName: 'JAIMONA',
      legalName: 'JAIMONA COMÉRCIO E SERVIÇOS, LDA',
      nif: '5003069940',
      phone: '+244 943 671 515',
      whatsapp: '943671515',
      bankName1: 'BAI',
      iban1: 'AO06.0040.0000.1234.5678.1019.9',
    };
    assert(resolveOwnerWhatsAppPhone(companyProf) === '943671515', 'Deve resolver telefone WhatsApp do proprietário');

    // 2. PDF real para Factura (FR), Recibo (RC) e Proforma (FP) com acentuação PT e QR Code
    const totals = calculateInvoiceTotals([
      {
        productId: 'p_1',
        code: 'SERV01',
        description: 'Configuração de Gestão & Faturação',
        unit: 'un',
        qty: 1,
        unitPrice: 25000,
        discountPct: 0,
        ivaRate: 14,
      },
    ]);
    const baseInvoice: InvoiceRecord = {
      id: 'inv_wa_1',
      companyId: 'comp_jaimona',
      number: 'FR S12026/000099',
      docType: 'FR',
      issuedAtIso: '2026-08-10T11:20:00.000Z',
      createdAtIso: '2026-08-10T11:20:00.000Z',
      updatedAtIso: '2026-08-10T11:20:00.000Z',
      cashier: '01',
      operator: '001',
      paymentMethod: 'Multicaixa',
      customerId: 'cust_wa_1',
      customerName: 'Kwanza Comércio, Lda',
      customerNif: '5001122334',
      customerPhone: '923000111',
      customerLocality: 'Luanda',
      merchandiseTotal: totals.merchandiseTotal,
      discountTotal: 0,
      taxBase14: totals.taxBase14,
      taxAmount14: totals.taxAmount14,
      taxBase0: 0,
      taxAmount0: 0,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      amountInWords: totals.amountInWords,
      amountReceived: totals.grandTotal,
      changeAmount: 0,
      notes: 'Entrega imediata',
      status: 'issued',
      lines: totals.lines,
      saftHash4: 'abCD',
    };

    const latin1Decoder = new TextDecoder('latin1');
    for (const dt of ['FR', 'RC', 'FP'] as const) {
      const docRec: InvoiceRecord = {
        ...baseInvoice,
        docType: dt,
        number: `${dt} S12026/000099`,
      };
      const pdfBytes = generateInvoicePdfBytes(docRec, companyProf);
      const pdfText = latin1Decoder.decode(pdfBytes);
      assert(
        pdfText.startsWith('%PDF-1.4') &&
          pdfText.includes('%%EOF') &&
          pdfText.includes('/WinAnsiEncoding') &&
          pdfText.includes('xref'),
        `PDF ${dt} deve respeitar formato binário PDF 1.4 válido com tabela xref`
      );
      assert(
        pdfText.includes(SILA_PDF_SIGNATURE) &&
          pdfText.includes('Kwanza Com') &&
          pdfText.includes('5003069940'),
        `PDF ${dt} deve conter assinatura discreta '${SILA_PDF_SIGNATURE}', dados da empresa e cliente`
      );

      const waMsg = buildDocumentWhatsAppMessage(docRec, companyProf);
      assert(
        waMsg.includes(WHATSAPP_DISCREET_SIGNATURE) &&
          waMsg.includes(docRec.number) &&
          waMsg.includes(`${formatKzNumber(docRec.grandTotal)} Kz`),
        `Mensagem WhatsApp de ${dt} deve incluir número, valor em Kz e assinatura ${WHATSAPP_DISCREET_SIGNATURE}`
      );
    }

    // 3. Cobrança & Aviso de Vencimento
    const overdueInv: InvoiceRecord = {
      ...baseInvoice,
      id: 'inv_wa_due',
      number: 'FR S12026/000045',
      issuedAtIso: '2026-07-01T10:00:00.000Z',
      paymentMethod: 'Crédito',
      amountReceived: 5000,
      amountDue: 23500,
    };
    const collectionMsg = buildCollectionReminderWhatsAppMessage(
      {
        customer: {
          name: 'Kwanza Comércio, Lda',
          nif: '5001122334',
          phone: '923000111',
          paymentTerms: '15_DIAS',
        },
        openInvoices: [overdueInv],
        referenceNowIso: '2026-08-10T10:00:00.000Z',
      },
      companyProf
    );
    assert(
      collectionMsg.includes('Aviso de Vencimento') &&
        collectionMsg.includes('23.500,00 Kz') &&
        collectionMsg.includes(WHATSAPP_DISCREET_SIGNATURE) &&
        collectionMsg.includes('IBAN'),
      'Cobrança deve destacar vencimento, total em dívida, IBAN e assinatura SILA-Billing'
    );

    // 4. Comprovativo de Pagamento (PDF + Mensagem)
    const proofPayload = {
      receiptNumber: 'CMP-884411',
      issuedAtIso: '2026-08-10T15:00:00.000Z',
      customerName: 'Kwanza Comércio, Lda',
      customerNif: '5001122334',
      customerPhone: '923000111',
      paymentMethod: 'Transferência' as const,
      reference: 'TRF-2026-99',
      paidAmount: 23500,
      remainingDebtAfter: 0,
      operator: '001',
      cashier: '01',
      settledInvoices: [
        {
          invoiceNumber: overdueInv.number,
          invoiceTotal: overdueInv.grandTotal,
          appliedAmount: 23500,
          remainingDue: 0,
        },
      ],
    };
    const proofPdfText = latin1Decoder.decode(generatePaymentReceiptPdfBytes(proofPayload, companyProf));
    const proofMsg = buildPaymentReceiptWhatsAppMessage(proofPayload, companyProf);
    assert(
      proofPdfText.startsWith('%PDF-1.4') &&
        proofPdfText.includes('COMPROVATIVO DE PAGAMENTO') &&
        proofPdfText.includes('CMP-884411') &&
        proofPdfText.includes(SILA_PDF_SIGNATURE),
      'PDF do comprovativo de pagamento deve ser válido e incluir número CMP e assinatura'
    );
    assert(
      proofMsg.includes('CMP-884411') &&
        proofMsg.includes('23.500,00 Kz') &&
        proofMsg.includes('Liquidado na totalidade') &&
        proofMsg.includes(WHATSAPP_DISCREET_SIGNATURE),
      'Mensagem do comprovativo deve confirmar quitação total e assinatura'
    );

    // 5. Catálogo Comercial & Orçamento (garantindo zero exposição do preço de custo)
    const catalogProducts: Product[] = [
      {
        id: 'cat_p1',
        code: 'ART-01',
        name: 'Impressora Térmica 80mm',
        category: 'Hardware',
        unit: 'un',
        price: 85000,
        costPrice: 41234, // nunca deve aparecer no catálogo do cliente
        ivaRate: 14,
        exemptionReason: '',
        active: true,
        createdAtIso: '2026-01-01T00:00:00.000Z',
        updatedAtIso: '2026-01-01T00:00:00.000Z',
      },
    ];
    const catalogPdfText = latin1Decoder.decode(
      generateCatalogOrQuotePdfBytes(
        {
          mode: 'CATALOG',
          referenceCode: 'CAT-20260810',
          issuedAtIso: '2026-08-10T12:00:00.000Z',
          products: catalogProducts,
        },
        companyProf
      )
    );
    assert(
      catalogPdfText.startsWith('%PDF-1.4') &&
        catalogPdfText.includes('Impressora T') &&
        catalogPdfText.includes('85.000,00') &&
        !catalogPdfText.includes('41.234') &&
        !catalogPdfText.includes('41234') &&
        catalogPdfText.includes(SILA_PDF_SIGNATURE),
      'Catálogo comercial PDF nunca pode expor preço de custo interno'
    );
    const quotePdfText = latin1Decoder.decode(
      generateCatalogOrQuotePdfBytes(
        {
          mode: 'QUOTE',
          referenceCode: 'ORC-20260810-101',
          issuedAtIso: '2026-08-10T12:00:00.000Z',
          cartItems: [
            {
              productId: 'cat_p1',
              code: 'ART-01',
              description: 'Impressora Térmica 80mm',
              unit: 'un',
              qty: 2,
              unitPrice: 85000,
              discountPct: 0,
              ivaRate: 14,
            },
          ],
          validityDays: 15,
        },
        companyProf
      )
    );
    const quoteMsg = buildCatalogOrQuoteWhatsAppMessage(
      {
        mode: 'QUOTE',
        referenceCode: 'ORC-20260810-101',
        customerName: 'Kwanza Comércio, Lda',
        cartItems: [
          {
            productId: 'cat_p1',
            code: 'ART-01',
            description: 'Impressora Térmica 80mm',
            unit: 'un',
            qty: 2,
            unitPrice: 85000,
            discountPct: 0,
            ivaRate: 14,
          },
        ],
        validityDays: 15,
      },
      companyProf
    );
    assert(
      quotePdfText.includes('ORC-20260810-101') &&
        quoteMsg.includes('ORC-20260810-101') &&
        quoteMsg.includes(WHATSAPP_DISCREET_SIGNATURE),
      'Orçamento PDF e mensagem WhatsApp devem estar consistentes e com assinatura discreta'
    );

    // 6. Resumo Diário ao Proprietário
    const dailySummaryPayload = {
      dateIso: '2026-08-10',
      generatedAtIso: '2026-08-10T19:00:00.000Z',
      totalSalesGross: 120000,
      validDocCount: 4,
      cancelledCount: 0,
      averageTicket: 30000,
      cashTotal: 70000,
      multicaixaTotal: 35000,
      transferTotal: 15000,
      creditTotal: 0,
      debtCollectionsTotal: 23500,
      openReceivablesTotal: 45000,
      activeCashSessionSummary: {
        cashier: '01',
        operator: '001',
        status: 'open' as const,
        openingFloat: 10000,
        expectedCash: 103500,
        countedCash: null,
        differenceAmount: null,
      },
      topProducts: [{ name: 'Impressora Térmica 80mm', qty: 1, revenue: 85000 }],
    };
    const dailyPdfText = latin1Decoder.decode(
      generateDailySummaryPdfBytes(dailySummaryPayload, companyProf)
    );
    const dailyMsg = buildDailyOwnerSummaryWhatsAppMessage(dailySummaryPayload, companyProf);
    assert(
      dailyPdfText.includes('RESUMO DI') &&
        dailyPdfText.includes('120.000,00 Kz') &&
        dailyPdfText.includes(SILA_PDF_SIGNATURE) &&
        dailyMsg.includes('120.000,00 Kz') &&
        dailyMsg.includes(WHATSAPP_DISCREET_SIGNATURE),
      'Resumo diário PDF e WhatsApp ao proprietário devem incluir vendas, caixa e assinatura discreta'
    );

    // 7. Modal de Partilha WhatsApp + UI Mobile
    const modalHtml = renderWhatsAppShareModal({
      kind: 'DOCUMENT',
      title: 'Enviar FR S12026/000099 no WhatsApp',
      subtitle: 'Kwanza Comércio, Lda · 28.500,00 Kz',
      recipientLabel: 'Kwanza Comércio, Lda',
      phoneInput: '923000111',
      messageText: 'Teste\n' + WHATSAPP_DISCREET_SIGNATURE,
      pdfFileName: 'FR_S12026_000099.pdf',
      pdfBytes: new Uint8Array([1, 2, 3, 4]),
      pdfDownloaded: false,
      copiedFeedback: false,
      shareError: null,
      canNativeShareFiles: false,
    });
    assert(
      modalHtml.includes('id="whatsapp-open-link"') &&
        modalHtml.includes('href="https://wa.me/244923000111?text=') &&
        modalHtml.includes('data-action="whatsapp-download-pdf"') &&
        modalHtml.includes('sem instala'),
      'Modal WhatsApp deve apresentar download de PDF, link wa.me seguro e aviso de consulta sem instalação'
    );

    const mobileHomeHtml = renderMobileOperationalView({
      activeCompany: {
        id: 'comp_jaimona',
        normalizedNif: '5003069940',
        profile: companyProf,
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
        ownerEmail: 'jaimona@ao.com',
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      },
      settings: {
        companyId: 'comp_jaimona',
        company: companyProf,
        defaultDocType: 'FR',
        defaultFormat: 'POS',
        defaultCashier: '01',
        defaultOperator: '001',
        defaultNotes: '',
        autoPrintOnEmit: false,
        hidePromotionalFooter: false,
        allowCashierPriceEdit: false,
        maxCashierDiscountPct: 5,
        inactivityLockMinutes: 10,
        updatedAtIso: new Date().toISOString(),
      },
      companyMasterDraftProfile: null,
      companyMasterDraftSettings: null,
      companyMasterSection: 'ALL',
      companySeries: [],
      canManageCompanySettings: true,
      companyFormError: null,
      companyFormSavedNotice: false,
      showRequestAgtSeriesForm: false,
      confirmFinalizeSeriesId: null,
      agtSeriesErrorMessage: null,
      agtSeriesSuccessMessage: null,
      showEstablishmentForm: false,
      editingEstablishment: null,
      establishmentError: null,
      showWarehouseForm: false,
      editingWarehouse: null,
      warehouseError: null,
      isOnline: true,
      user: { email: 'jaimona@ao.com' },
      mobileTab: 'HOME',
      mobileCheckoutStep: 'CART',
      cart: [],
      products: catalogProducts,
      customers: [],
      invoices: [overdueInv],
      selectedCustomerId: '999999999',
      docType: 'FR',
      paymentMethod: 'Dinheiro',
      amountReceivedInput: '',
      mobileSearchQuery: '',
      mobileProductSearchInput: '',
      lastEmittedInvoice: baseInvoice,
      showQuickProductModal: false,
      showQuickCustomerModal: false,
      showQuickCompanyModal: false,
      showCustomerPickerModal: false,
      editingMobileProduct: null,
      editingCustomer: null,
      editingCustomerCreditLimitInput: '',
      showCustomerAdvancedFields: false,
      mobileCustomerModalMode: 'QUICK',
      canEditExistingCustomers: true,
      quickCustomerDraft: {
        name: '',
        nif: '',
        phone: '',
        address: '',
        locality: 'Luanda',
        customerType: 'PARTICULAR',
      },
      quickProductError: null,
      quickCustomerError: null,
      operator: '001',
      unlockedOperatorName: 'Proprietário',
      unlockedRoleLabel: 'Proprietário',
      canSellPos: true,
      canViewProducts: true,
      canManageProducts: true,
      canViewCustomers: true,
      canCreateCustomers: true,
      canViewDocs: true,
      canOperateCash: true,
      canExportSaft: true,
    });
    assert(
      mobileHomeHtml.includes('data-action="whatsapp-daily-summary"'),
      'Ecrã inicial Mobile deve expor botão rápido para envio de resumo diário ao proprietário via WhatsApp'
    );
  });

  console.log(`\n=== FASE 5 CONCLUÍDA: ${passed}/${total} TESTES PASSARAM COM SUCESSO ===\n`);
  return { passed, total };
}

if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('phase5ValidationTests')) {
  runPhase5ValidationTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Falha nos testes da Fase 5:', err);
      process.exit(1);
    });
}
