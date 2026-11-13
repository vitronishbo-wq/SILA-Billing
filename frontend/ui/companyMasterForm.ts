import {
  COMPANY_MASTER_FIELD_REGISTRY,
  evaluateCompanyMasterCompleteness,
  FieldRequirementLevel,
  MASTER_SECTION_LABELS,
  MasterSectionId,
  resolveActiveEstablishment,
  validateLogoDataUrl,
} from '../../src/core/companyValidator';
import {
  AGT_DOCUMENT_TYPES,
  AGT_IVA_EXEMPTION_CODES,
  AgtIvaExemptionCode,
  AgtSeriesRecord,
} from '../../src/core/fiscalTypes';
import {
  AgtOperationEnvironment,
  AngolaLegalNature,
  AngolaTaxRegime,
  AngolaTaxTerritory,
  AppSettings,
  canCompanyHideViralFooter,
  CompanyProfile,
  CompanyRecord,
  deriveCompanyInitials,
  EstablishmentRecord,
  shouldShowViralDocumentFooter,
  WarehouseRecord,
} from '../../src/core/types';
import { ICONS } from './icons';

export type CompanyMasterViewMode = 'DESKTOP' | 'MOBILE';
export type CompanyMasterSectionTab = MasterSectionId | 'ALL';

export const MASTER_SECTION_ORDER: readonly MasterSectionId[] = [
  'identificacao',
  'fiscal',
  'endereco',
  'contactos',
  'identidade_visual',
  'series',
  'bancos',
  'estabelecimentos',
  'representantes',
] as const;

const MASTER_SECTION_SHORT_LABELS: Readonly<Record<MasterSectionId, string>> = {
  identificacao: '1. Identificação',
  fiscal: '2. Fiscal AGT',
  endereco: '3. Endereço',
  contactos: '4. Contactos',
  identidade_visual: '5. Logótipo',
  series: '6. Séries AGT',
  bancos: '7. Bancos',
  estabelecimentos: '8. Estabelecimentos',
  representantes: '9. Responsáveis & Caixa',
};

export const ANGOLA_PROVINCES: readonly string[] = [
  'Bengo',
  'Benguela',
  'Bié',
  'Cabinda',
  'Cuando',
  'Cubango',
  'Cuanza Norte',
  'Cuanza Sul',
  'Cunene',
  'Huambo',
  'Huíla',
  'Icolo e Bengo',
  'Luanda',
  'Lunda Norte',
  'Lunda Sul',
  'Malanje',
  'Moxico',
  'Moxico Leste',
  'Namibe',
  'Uíge',
  'Zaire',
];

export interface CompanyMasterRenderOptions {
  mode: CompanyMasterViewMode;
  company: CompanyRecord;
  settings: AppSettings;
  draftProfile?: CompanyProfile | null;
  draftSettings?: Partial<AppSettings> | null;
  series: AgtSeriesRecord[];
  canManage: boolean;
  activeSection: CompanyMasterSectionTab;
  formId: string;
  showRequestAgtSeriesForm: boolean;
  confirmFinalizeSeriesId: string | null;
  agtSeriesErrorMessage: string | null;
  agtSeriesSuccessMessage: string | null;
  showEstablishmentForm: boolean;
  editingEstablishment: Partial<EstablishmentRecord> | null;
  establishmentError: string | null;
  showWarehouseForm: boolean;
  editingWarehouse: Partial<WarehouseRecord> | null;
  warehouseError: string | null;
  errorMessage: string | null;
  savedNotice: boolean;
  operator: string;
}

function escapeHtml(raw: string | undefined | null): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRequirementLabel(req: FieldRequirementLevel): string {
  if (req === 'REQUIRED') return 'Obrigatório';
  if (req === 'CONDITIONAL') return 'Condicional';
  return 'Opcional';
}

function getRequirementTextClass(req: FieldRequirementLevel, isMobile: boolean): string {
  if (req === 'REQUIRED') {
    return isMobile ? 'text-amber-300 font-semibold' : 'text-slate-700 font-semibold';
  }
  if (req === 'CONDITIONAL') {
    return isMobile ? 'text-blue-300' : 'text-blue-700';
  }
  return isMobile ? 'text-slate-400' : 'text-slate-500';
}

function getFieldDescriptor(key: keyof CompanyProfile | 'series' | 'establishments') {
  return COMPANY_MASTER_FIELD_REGISTRY.find((d) => d.key === key);
}

/**
 * Converte imagem PNG/JPG/WebP selecionada num DataURL seguro e compacto (<= 195 KB),
 * garantindo rejeição estrita de SVG ou formatos maliciosos.
 */
export async function resizeImageFileToLogoDataUrl(
  file: File,
  maxDim = 420,
  maxStringBytes = 240 * 1024
): Promise<string> {
  const mime = String(file.type || '').toLowerCase();
  if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) {
    throw new Error(
      'Formato não permitido. Carregue apenas uma imagem PNG, JPG ou WebP (SVG bloqueado por segurança).'
    );
  }

  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Falha ao ler o ficheiro de imagem.'));
    reader.readAsDataURL(file);
  });

  // Se já estiver dentro do limite e válido, devolve diretamente
  if (rawDataUrl.length <= maxStringBytes) {
    const check = validateLogoDataUrl(rawDataUrl);
    if (check.valid) return rawDataUrl;
  }

  // Redimensionamento seguro via canvas no navegador
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Não foi possível processar a imagem seleccionada.'));
    image.src = rawDataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width || 1, img.height || 1));
  const width = Math.max(1, Math.round((img.width || maxDim) * scale));
  const height = Math.max(1, Math.round((img.height || maxDim) * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Contexto gráfico indisponível para optimizar o logótipo.');
  }
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  let output = canvas.toDataURL(mime === 'image/png' ? 'image/png' : 'image/webp', 0.86);
  if (output.length > maxStringBytes) {
    output = canvas.toDataURL('image/jpeg', 0.8);
  }
  if (output.length > maxStringBytes) {
    output = canvas.toDataURL('image/jpeg', 0.6);
  }

  const check = validateLogoDataUrl(output);
  if (!check.valid) {
    throw new Error(check.error || 'O logótipo excede o tamanho máximo permitido (200 KB).');
  }
  return output;
}

/**
 * Extrai e normaliza todos os campos da Ficha Mestre a partir de FormData,
 * preservando estabelecimentos, armazéns e campos não submetidos quando ausentes.
 */
export function extractMasterProfileFromFormData(
  fd: FormData,
  currentCompany: CompanyProfile
): CompanyProfile {
  const str = (key: string, fallback = ''): string => {
    if (!fd.has(key)) return fallback;
    return String(fd.get(key) || '').trim();
  };
  const optStr = (key: string, fallback?: string): string | undefined => {
    if (!fd.has(key)) return fallback;
    const val = String(fd.get(key) || '').trim();
    return val || undefined;
  };

  const taxRegimeRaw = str('taxRegime', currentCompany.taxRegime || 'GERAL').toUpperCase();
  const taxRegime: AngolaTaxRegime =
    taxRegimeRaw === 'SIMPLIFICADO' || taxRegimeRaw === 'EXCLUSAO' ? taxRegimeRaw : 'GERAL';

  const legalNatureRaw = str('legalNature', currentCompany.legalNature || '').toUpperCase();
  const legalNature: AngolaLegalNature | undefined =
    legalNatureRaw === 'LDA' ||
    legalNatureRaw === 'SU_LDA' ||
    legalNatureRaw === 'SA' ||
    legalNatureRaw === 'ENI' ||
    legalNatureRaw === 'COOP' ||
    legalNatureRaw === 'OUTRA'
      ? legalNatureRaw
      : undefined;

  const envRaw = str('agtEnvironment', currentCompany.agtEnvironment || 'SIMULACAO').toUpperCase();
  const agtEnvironment: AgtOperationEnvironment =
    envRaw === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO';

  const territoryRaw = str(
    'specialTaxTerritory',
    currentCompany.specialTaxTerritory || 'AO'
  ).toUpperCase();
  const specialTaxTerritory: AngolaTaxTerritory = territoryRaw === 'AO-CAB' ? 'AO-CAB' : 'AO';

  const rawExemption = str('defaultExemptionCode', currentCompany.defaultExemptionCode || '').toUpperCase();
  const defaultExemptionCode: AgtIvaExemptionCode | undefined =
    rawExemption && AGT_IVA_EXEMPTION_CODES[rawExemption as AgtIvaExemptionCode]
      ? (rawExemption as AgtIvaExemptionCode)
      : undefined;

  let defaultWithholdingTax = currentCompany.defaultWithholdingTax;
  if (fd.has('defaultWithholdingTax')) {
    const rawWht = String(fd.get('defaultWithholdingTax') || '').trim().replace(',', '.');
    if (!rawWht) {
      defaultWithholdingTax = undefined;
    } else {
      const parsedWht = Number(rawWht);
      if (Number.isFinite(parsedWht) && parsedWht >= 0 && parsedWht <= 35) {
        defaultWithholdingTax = parsedWht;
      }
    }
  }

  let defaultPaymentTermsDays = currentCompany.defaultPaymentTermsDays;
  if (fd.has('defaultPaymentTermsDays')) {
    const rawDays = String(fd.get('defaultPaymentTermsDays') || '').trim();
    if (!rawDays) {
      defaultPaymentTermsDays = undefined;
    } else {
      const parsedDays = parseInt(rawDays, 10);
      if (Number.isFinite(parsedDays) && parsedDays >= 0 && parsedDays <= 365) {
        defaultPaymentTermsDays = parsedDays;
      }
    }
  }

  const isVatRetentionAgent = fd.has('isVatRetentionAgentPresent')
    ? fd.get('isVatRetentionAgent') === 'on'
    : fd.has('isVatRetentionAgent')
      ? fd.get('isVatRetentionAgent') === 'on'
      : Boolean(currentCompany.isVatRetentionAgent);

  const showLogoOnPos = fd.has('showLogoOnPosPresent')
    ? fd.get('showLogoOnPos') === 'on'
    : fd.has('showLogoOnPos')
      ? fd.get('showLogoOnPos') === 'on'
      : currentCompany.showLogoOnPos !== false;

  const showLogoOnA4 = fd.has('showLogoOnA4Present')
    ? fd.get('showLogoOnA4') === 'on'
    : fd.has('showLogoOnA4')
      ? fd.get('showLogoOnA4') === 'on'
      : currentCompany.showLogoOnA4 !== false;

  const municipality = optStr('municipality', currentCompany.municipality);
  const province = optStr('province', currentCompany.province);
  const explicitCityCountry = str('cityCountry', currentCompany.cityCountry || '');
  const cityCountry =
    explicitCityCountry ||
    (municipality || province ? `${municipality || province} - Angola` : 'Angola');

  return {
    ...currentCompany,
    // 1. Identificação Jurídica e Comercial
    legalName: str('legalName', currentCompany.legalName),
    shortName: str('shortName', currentCompany.shortName),
    legalNature,
    cae: optStr('cae', currentCompany.cae),
    commercialRegistry: optStr('commercialRegistry', currentCompany.commercialRegistry),
    shareCapital: optStr('shareCapital', currentCompany.shareCapital),
    tagline: str('tagline', currentCompany.tagline),
    // 2. Enquadramento Fiscal
    nif: str('nif', currentCompany.nif),
    taxRegime,
    taxOffice: optStr('taxOffice', currentCompany.taxOffice),
    taxEntity: optStr('taxEntity', currentCompany.taxEntity),
    defaultExemptionCode,
    specialTaxTerritory,
    isVatRetentionAgent,
    defaultWithholdingTax,
    agtEnvironment,
    activityStartDate: optStr('activityStartDate', currentCompany.activityStartDate),
    // 3. Endereço
    address: str('address', currentCompany.address),
    municipality,
    province,
    cityCountry,
    postalCode: optStr('postalCode', currentCompany.postalCode),
    country: 'AO',
    // 4. Contactos
    phone: str('phone', currentCompany.phone),
    mobile: optStr('mobile', currentCompany.mobile),
    whatsapp: optStr('whatsapp', currentCompany.whatsapp),
    email: str('email', currentCompany.email),
    billingEmail: optStr('billingEmail', currentCompany.billingEmail),
    website: optStr('website', currentCompany.website),
    // 5. Identidade Visual
    logoUrl: optStr('logoUrl', currentCompany.logoUrl),
    showLogoOnPos,
    showLogoOnA4,
    // 7. Dados Bancários e Pagamentos
    bankName1: optStr('bankName1', currentCompany.bankName1),
    iban1: optStr('iban1', currentCompany.iban1),
    accountHolder1: optStr('accountHolder1', currentCompany.accountHolder1),
    swift1: optStr('swift1', currentCompany.swift1),
    bankName2: optStr('bankName2', currentCompany.bankName2),
    iban2: optStr('iban2', currentCompany.iban2),
    accountHolder2: optStr('accountHolder2', currentCompany.accountHolder2),
    swift2: optStr('swift2', currentCompany.swift2),
    multicaixaExpressPhone: optStr('multicaixaExpressPhone', currentCompany.multicaixaExpressPhone),
    defaultPaymentTermsDays,
    // 8. Estabelecimentos e Armazéns (preservados e vinculados)
    establishments: currentCompany.establishments,
    warehouses: currentCompany.warehouses,
    defaultEstablishmentId: optStr(
      'defaultEstablishmentId',
      currentCompany.defaultEstablishmentId
    ),
    // 9. Representantes e Responsáveis
    legalRepresentativeName: optStr(
      'legalRepresentativeName',
      currentCompany.legalRepresentativeName
    ),
    legalRepresentativeRole: optStr(
      'legalRepresentativeRole',
      currentCompany.legalRepresentativeRole
    ),
    legalRepresentativeNif: optStr(
      'legalRepresentativeNif',
      currentCompany.legalRepresentativeNif
    ),
    legalRepresentativePhone: optStr(
      'legalRepresentativePhone',
      currentCompany.legalRepresentativePhone
    ),
    accountantName: optStr('accountantName', currentCompany.accountantName),
    accountantOcpcaNumber: optStr(
      'accountantOcpcaNumber',
      currentCompany.accountantOcpcaNumber
    ),
    accountantEmail: optStr('accountantEmail', currentCompany.accountantEmail),
    accountantPhone: optStr('accountantPhone', currentCompany.accountantPhone),
  };
}

/**
 * Extrai AppSettings completos (Ficha Mestre + Predefinições de Caixa/Emissão)
 * usados tanto pelo formulário Desktop quanto pelo formulário Mobile.
 */
export function extractSettingsFromFormData(
  fd: FormData,
  args: {
    companyId: string;
    currentSettings: AppSettings;
    currentProfile: CompanyProfile;
    canCleanFooter: boolean;
  }
): AppSettings {
  const nextProfile = extractMasterProfileFromFormData(fd, args.currentProfile);
  const cur = args.currentSettings;

  const str = (key: string, fallback: string): string => {
    if (!fd.has(key)) return fallback;
    return String(fd.get(key) || '').trim() || fallback;
  };

  const docTypeRaw = String(fd.get('defaultDocType') || cur.defaultDocType || 'FR').toUpperCase();
  const defaultDocType =
    docTypeRaw === 'FP' || docTypeRaw === 'FA' ? docTypeRaw : 'FR';
  const formatRaw = String(fd.get('defaultFormat') || cur.defaultFormat || 'POS').toUpperCase();
  const defaultFormat = formatRaw === 'A4' ? 'A4' : 'POS';

  const autoPrintOnEmit = fd.has('autoPrintOnEmitPresent')
    ? fd.get('autoPrintOnEmit') === 'on'
    : fd.has('autoPrintOnEmit')
      ? fd.get('autoPrintOnEmit') === 'on'
      : Boolean(cur.autoPrintOnEmit);

  const allowCashierPriceEdit = fd.has('allowCashierPriceEditPresent')
    ? fd.get('allowCashierPriceEdit') === 'on'
    : fd.has('allowCashierPriceEdit')
      ? fd.get('allowCashierPriceEdit') === 'on'
      : Boolean(cur.allowCashierPriceEdit);

  const hidePromotionalFooter = args.canCleanFooter
    ? fd.has('hidePromotionalFooterPresent')
      ? fd.get('hidePromotionalFooter') === 'on'
      : fd.has('hidePromotionalFooter')
        ? fd.get('hidePromotionalFooter') === 'on'
        : Boolean(cur.hidePromotionalFooter)
    : false;

  const maxCashierDiscountPct = fd.has('maxCashierDiscountPct')
    ? Math.min(
        100,
        Math.max(
          0,
          parseFloat(String(fd.get('maxCashierDiscountPct') || '5').replace(',', '.')) || 0
        )
      )
    : cur.maxCashierDiscountPct ?? 5;

  const supervisorPin = fd.has('supervisorPin')
    ? String(fd.get('supervisorPin') || '').trim().slice(0, 16)
    : cur.supervisorPin || '';

  return {
    companyId: args.companyId,
    company: nextProfile,
    defaultCashier: str('defaultCashier', cur.defaultCashier || '01'),
    defaultOperator: str('defaultOperator', cur.defaultOperator || '001'),
    defaultDocType,
    defaultFormat,
    defaultNotes: fd.has('defaultNotes')
      ? String(fd.get('defaultNotes') || '').trim()
      : cur.defaultNotes,
    autoPrintOnEmit,
    defaultEstablishmentId: nextProfile.defaultEstablishmentId,
    agtEnvironment: nextProfile.agtEnvironment || 'SIMULACAO',
    hidePromotionalFooter,
    allowCashierPriceEdit,
    maxCashierDiscountPct,
    supervisorPin,
    syncState: 'pending',
    synced: false,
    updatedAtIso: new Date().toISOString(),
  };
}

export function renderCompanyMasterSection(options: CompanyMasterRenderOptions): string {
  const {
    mode,
    company,
    settings,
    draftProfile,
    draftSettings,
    series,
    canManage,
    activeSection,
    formId,
    showRequestAgtSeriesForm,
    confirmFinalizeSeriesId,
    agtSeriesErrorMessage,
    agtSeriesSuccessMessage,
    showEstablishmentForm,
    editingEstablishment,
    establishmentError,
    showWarehouseForm,
    editingWarehouse,
    warehouseError,
    errorMessage,
    savedNotice,
  } = options;

  const isMobile = mode === 'MOBILE';
  const c: CompanyProfile = draftProfile || settings.company;
  const s: AppSettings = draftSettings ? { ...settings, ...draftSettings, company: c } : { ...settings, company: c };
  const establishments: EstablishmentRecord[] =
    Array.isArray(c.establishments) && c.establishments.length > 0
      ? c.establishments
      : [resolveActiveEstablishment(c)];
  const warehouses: WarehouseRecord[] = Array.isArray(c.warehouses) ? c.warehouses : [];
  const activeEst = resolveActiveEstablishment(c, c.defaultEstablishmentId);

  const completeness = evaluateCompanyMasterCompleteness(c, {
    series,
    requireProductionSeriesCheck: c.agtEnvironment === 'PRODUCAO',
  });

  const inputCls = isMobile
    ? 'w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 disabled:opacity-60'
    : 'w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-60';
  const selectCls = isMobile
    ? 'w-full h-11 px-3 rounded-xl bg-slate-950 border border-slate-700 text-sm text-white focus:outline-none focus:border-blue-500 disabled:opacity-60'
    : 'w-full h-9 px-2.5 text-xs bg-slate-50 border border-slate-200 rounded-md text-slate-900 focus:outline-none focus:border-blue-600 disabled:opacity-60';
  const labelCls = isMobile
    ? 'flex items-baseline justify-between gap-2 text-xs font-medium text-slate-300 mb-1'
    : 'flex items-baseline justify-between gap-2 text-[11px] font-medium text-slate-600 mb-1';
  const cardCls = isMobile
    ? 'bg-slate-900/90 border border-slate-800 rounded-2xl p-4 space-y-3'
    : 'bg-white border border-slate-200 rounded-lg p-4 sm:p-5 space-y-4';
  const secTitleCls = isMobile
    ? 'text-xs font-bold text-blue-400 uppercase tracking-wider'
    : 'text-xs font-bold text-slate-900 uppercase tracking-wide';

  const renderFieldLabel = (
    text: string,
    key?: keyof CompanyProfile | 'series' | 'establishments',
    explicitReq?: FieldRequirementLevel
  ) => {
    const desc = key ? getFieldDescriptor(key) : undefined;
    const req = explicitReq || desc?.requirement || 'OPTIONAL';
    return `
      <label class="${labelCls}">
        <span>${escapeHtml(text)}</span>
        <span class="text-[10px] ${getRequirementTextClass(req, isMobile)} shrink-0">${formatRequirementLabel(req)}</span>
      </label>
    `;
  };

  const sectionHiddenClass = (id: MasterSectionId): string =>
    activeSection === 'ALL' || activeSection === id ? '' : 'hidden';

  const renderSectionCompletenessSummary = () => {
    const prodReady = completeness.readyForProductionEmission;
    const simReady = completeness.readyForSimulation;
    const isProdEnv = c.agtEnvironment === 'PRODUCAO';

    return `
      <div class="${
        isMobile
          ? 'bg-slate-900 border border-slate-800 rounded-2xl p-3.5 space-y-2.5'
          : 'bg-slate-50 border border-slate-200 rounded-lg p-4 space-y-3'
      }">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs font-bold ${isMobile ? 'text-white' : 'text-slate-900'}">
                Completude da Ficha Mestre
              </span>
              <span class="text-xs font-mono font-bold tabular-nums ${
                completeness.completionPct >= 85
                  ? isMobile
                    ? 'text-emerald-400'
                    : 'text-emerald-700'
                  : isMobile
                    ? 'text-amber-300'
                    : 'text-amber-700'
              }">${completeness.completionPct}% preenchido</span>
            </div>
            <p class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-600'} mt-0.5 tabular-nums">
              Simulação: <strong class="${simReady ? (isMobile ? 'text-emerald-400' : 'text-emerald-700') : isMobile ? 'text-red-400' : 'text-red-700'}">${simReady ? 'Disponível (gravação parcial permitida)' : 'Faltam dados mínimos'}</strong>
              <span aria-hidden="true"> · </span>
              Produção AGT: <strong class="${prodReady ? (isMobile ? 'text-emerald-400' : 'text-emerald-700') : isMobile ? 'text-amber-300' : 'text-amber-700'}">${prodReady ? 'Pronta para emissão real' : `${completeness.blockingIssues.length} requisito(s) em falta`}</strong>
            </p>
          </div>
          <div class="text-[11px] font-mono tabular-nums ${isMobile ? 'text-slate-300' : 'text-slate-700'}">
            Ambiente: <strong>${isProdEnv ? 'PRODUÇÃO FISCAL' : 'SIMULAÇÃO'}</strong>
            <span aria-hidden="true"> · </span>
            Estab.: <strong>${escapeHtml(activeEst.code)}</strong>
          </div>
        </div>

        <div class="w-full h-1.5 rounded-full overflow-hidden ${isMobile ? 'bg-slate-800' : 'bg-slate-200'}">
          <div
            class="h-full transition-all ${
              prodReady ? 'bg-emerald-500' : simReady ? 'bg-blue-500' : 'bg-amber-500'
            }"
            style="width: ${completeness.completionPct}%"
          ></div>
        </div>

        ${
          completeness.blockingIssues.length > 0
            ? `<div class="pt-1 space-y-1">
                <div class="text-[11px] font-semibold ${isMobile ? 'text-amber-300' : 'text-amber-800'}">
                  Requisitos pendentes para emissão fiscal em Produção:
                </div>
                <ul class="space-y-1 text-[11px] ${isMobile ? 'text-slate-300' : 'text-slate-700'}">
                  ${completeness.blockingIssues
                    .slice(0, 6)
                    .map(
                      (issue) => `
                        <li class="flex items-center justify-between gap-2">
                          <span>• ${escapeHtml(issue.message)}</span>
                          <button
                            type="button"
                            data-action="master-select-section"
                            data-section="${issue.section}"
                            class="shrink-0 text-[10px] font-semibold underline ${
                              isMobile ? 'text-blue-400' : 'text-blue-700'
                            }"
                          >Abrir secção</button>
                        </li>
                      `
                    )
                    .join('')}
                </ul>
              </div>`
            : ''
        }
      </div>
    `;
  };

  const renderSectionTabs = () => {
    const tabBtn = (id: CompanyMasterSectionTab, label: string, ready?: boolean) => {
      const active = activeSection === id;
      const baseCls = isMobile
        ? 'h-9 px-3 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0 flex items-center gap-1.5'
        : 'h-8 px-2.5 rounded-md text-[11px] font-medium whitespace-nowrap transition-colors shrink-0 flex items-center gap-1.5 border';
      const stateCls = isMobile
        ? active
          ? 'bg-blue-600 text-white font-semibold'
          : 'bg-slate-900 border border-slate-800 text-slate-300 hover:text-white'
        : active
          ? 'bg-slate-900 border-slate-900 text-white font-semibold'
          : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50';
      const dot =
        typeof ready === 'boolean'
          ? `<span class="h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-amber-500'}"></span>`
          : '';
      return `
        <button
          type="button"
          data-action="master-select-section"
          data-section="${id}"
          class="${baseCls} ${stateCls}"
        >${dot}<span>${escapeHtml(label)}</span></button>
      `;
    };

    return `
      <div class="flex items-center gap-1.5 overflow-x-auto pb-1">
        ${tabBtn('ALL', 'Todas (9 Secções)')}
        ${MASTER_SECTION_ORDER.map((secId) =>
          tabBtn(secId, MASTER_SECTION_SHORT_LABELS[secId], completeness.sectionStatus[secId]?.ready)
        ).join('')}
      </div>
    `;
  };

  const renderLogoBlock = () => {
    const hasLogo = Boolean(c.logoUrl && validateLogoDataUrl(c.logoUrl).valid);
    const initials = deriveCompanyInitials(c);

    return `
      <div class="flex flex-col sm:flex-row sm:items-center gap-4">
        <div class="h-20 w-24 rounded-xl border ${
          isMobile ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-slate-50'
        } flex items-center justify-center overflow-hidden shrink-0">
          ${
            hasLogo
              ? `<img src="${escapeHtml(c.logoUrl)}" alt="Logótipo ${escapeHtml(c.shortName)}" class="max-h-full max-w-full object-contain p-1" />`
              : `<span class="text-lg font-bold tracking-wider ${
                  isMobile ? 'text-slate-400' : 'text-slate-500'
                }">${escapeHtml(initials)}</span>`
          }
        </div>
        <div class="flex-1 space-y-2">
          <input type="hidden" name="logoUrl" value="${escapeHtml(c.logoUrl || '')}" />
          <div class="flex flex-wrap items-center gap-2">
            <label class="${
              isMobile
                ? 'h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold inline-flex items-center gap-2 cursor-pointer'
                : 'h-9 px-3 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer'
            } ${!canManage ? 'opacity-50 pointer-events-none' : ''}">
              <span>${hasLogo ? 'Substituir Logótipo' : 'Carregar Logótipo (PNG/JPG/WebP)'}</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                data-action="upload-company-logo"
                ${!canManage ? 'disabled' : ''}
                class="hidden"
              />
            </label>
            ${
              hasLogo && canManage
                ? `<button
                    type="button"
                    data-action="remove-company-logo"
                    class="${
                      isMobile
                        ? 'h-11 px-3 rounded-xl bg-slate-800 text-red-400 text-xs font-medium'
                        : 'h-9 px-3 rounded-md border border-red-200 text-red-700 hover:bg-red-50 text-xs font-medium'
                    }"
                  >Remover</button>`
                : ''
            }
          </div>
          <p class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-500'}">
            Máximo 200 KB (PNG, JPG ou WebP — SVG bloqueado por segurança). Optimização automática ao carregar.
          </p>
          <div class="flex flex-wrap gap-4 pt-1">
            <input type="hidden" name="showLogoOnA4Present" value="1" />
            <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none min-h-[36px]">
              <input type="checkbox" name="showLogoOnA4" ${!canManage ? 'disabled' : ''} ${c.showLogoOnA4 !== false ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
              <span>Imprimir logótipo na Factura A4</span>
            </label>
            <input type="hidden" name="showLogoOnPosPresent" value="1" />
            <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none min-h-[36px]">
              <input type="checkbox" name="showLogoOnPos" ${!canManage ? 'disabled' : ''} ${c.showLogoOnPos !== false ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
              <span>Imprimir logótipo no Talão POS 80mm</span>
            </label>
          </div>
        </div>
      </div>
    `;
  };

  const renderSeriesSection = () => {
    const currentYear = new Date().getFullYear();
    const defaultEnv: AgtOperationEnvironment =
      c.agtEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO';
    const isSeriesHidden = activeSection !== 'ALL' && activeSection !== 'series';

    const seriesCardsOrTable = isMobile
      ? series.length === 0
        ? `<div class="p-4 text-center text-xs text-slate-400 bg-slate-950/60 rounded-xl border border-slate-800">
            Nenhuma série AGT registada. Toque em "Solicitar Série à AGT" para adicionar.
          </div>`
        : `<div class="space-y-2">
            ${series
              .map((sr) => {
                const docMeta = AGT_DOCUMENT_TYPES[sr.documentType];
                const estMatch = establishments.find((e) => e.id === sr.establishmentId);
                const envLabel = sr.environment === 'PRODUCAO' ? 'Produção' : 'Simulação';
                const statusLabel =
                  sr.status === 'A'
                    ? 'A · Activa'
                    : sr.status === 'U'
                      ? 'U · Em Uso'
                      : 'F · Finalizada';
                const isConfirming = confirmFinalizeSeriesId === sr.id;
                return `
                  <div class="bg-slate-950 border border-slate-800 rounded-xl p-3 space-y-1.5 text-xs">
                    <div class="flex items-center justify-between gap-2">
                      <span class="font-bold text-white">${escapeHtml(sr.documentType)} — ${escapeHtml(docMeta?.shortName || '')}</span>
                      <span class="font-mono text-[11px] ${
                        sr.status === 'F' ? 'text-slate-500' : 'text-emerald-400'
                      }">${statusLabel}</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400 font-mono tabular-nums">
                      <span class="text-slate-200 font-bold">${escapeHtml(sr.seriesCode)}/${sr.seriesYear}</span>
                      <span>·</span>
                      <span class="${sr.environment === 'PRODUCAO' ? 'text-emerald-400' : 'text-amber-300'}">${envLabel}</span>
                      <span>·</span>
                      <span>${estMatch ? `${escapeHtml(estMatch.code)} · ${escapeHtml(estMatch.name)}` : 'Global Empresa'}</span>
                    </div>
                    <div class="flex items-center justify-between text-[11px] text-slate-400 font-mono tabular-nums pt-1 border-t border-slate-800/70">
                      <span>1.º: ${String(sr.firstDocumentNumber).padStart(6, '0')} · Último: ${
                        sr.lastDocumentNumber > 0 ? String(sr.lastDocumentNumber).padStart(6, '0') : 'Nenhum'
                      }</span>
                      ${
                        canManage && sr.status !== 'F'
                          ? isConfirming
                            ? `<div class="flex items-center gap-1.5 font-sans">
                                <button type="button" data-action="confirm-finalize-agt-series" data-id="${escapeHtml(sr.id)}" class="h-8 px-2.5 rounded-lg bg-red-600 text-white text-[11px] font-semibold">Confirmar F</button>
                                <button type="button" data-action="cancel-finalize-agt-series" class="h-8 px-2 rounded-lg bg-slate-800 text-slate-300 text-[11px]">Cancelar</button>
                              </div>`
                            : `<button type="button" data-action="finalize-agt-series" data-id="${escapeHtml(sr.id)}" class="h-8 px-2.5 rounded-lg bg-slate-800 text-amber-300 text-[11px] font-sans font-medium">Finalizar 'F'</button>`
                          : ''
                      }
                    </div>
                  </div>
                `;
              })
              .join('')}
          </div>`
      : `<div class="border border-slate-200 rounded-lg overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead class="bg-slate-50 border-b border-slate-200 text-[11px] text-slate-500">
              <tr>
                <th class="py-2.5 px-3 font-medium">Documento</th>
                <th class="py-2.5 px-3 font-medium">Série / Ano</th>
                <th class="py-2.5 px-3 font-medium">Ambiente</th>
                <th class="py-2.5 px-3 font-medium">Estabelecimento</th>
                <th class="py-2.5 px-3 font-medium font-mono tabular-nums">1.º / Último</th>
                <th class="py-2.5 px-3 font-medium">Autorização AGT</th>
                <th class="py-2.5 px-3 font-medium">Estado</th>
                <th class="py-2.5 px-3 font-medium text-right">Acção</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100 font-mono tabular-nums">
              ${
                series.length === 0
                  ? `<tr><td colspan="8" class="py-4 px-3 text-xs text-slate-500 text-center font-sans">Nenhuma série registada para esta empresa. Clique em "Solicitar Série à AGT" para provisionar.</td></tr>`
                  : series
                      .map((sr) => {
                        const docMeta = AGT_DOCUMENT_TYPES[sr.documentType];
                        const docLabel = docMeta ? `${sr.documentType} - ${docMeta.shortName}` : sr.documentType;
                        const estMatch = establishments.find((e) => e.id === sr.establishmentId);
                        const envText = sr.environment === 'PRODUCAO'
                          ? `<span class="font-sans text-[11px] font-semibold text-emerald-700">Produção</span>`
                          : `<span class="font-sans text-[11px] font-medium text-amber-700">Simulação</span>`;
                        const statusText =
                          sr.status === 'A'
                            ? `<span class="font-sans text-[11px] font-semibold text-blue-700">A (Activa)</span>`
                            : sr.status === 'U'
                              ? `<span class="font-sans text-[11px] font-semibold text-emerald-700">U (Em Uso)</span>`
                              : `<span class="font-sans text-[11px] text-slate-500">F (Finalizada)</span>`;
                        const isConfirming = confirmFinalizeSeriesId === sr.id;

                        return `
                          <tr class="hover:bg-slate-50/60">
                            <td class="py-2 px-3 font-sans font-medium text-slate-900">${escapeHtml(docLabel)}</td>
                            <td class="py-2 px-3 font-bold text-slate-800">${escapeHtml(sr.seriesCode)}/${sr.seriesYear}</td>
                            <td class="py-2 px-3">${envText}</td>
                            <td class="py-2 px-3 font-sans text-slate-600">${
                              estMatch
                                ? `${escapeHtml(estMatch.code)} · ${escapeHtml(estMatch.name)}`
                                : 'Global empresa'
                            }</td>
                            <td class="py-2 px-3 text-slate-600">
                              ${String(sr.firstDocumentNumber).padStart(6, '0')} ·
                              <strong class="${sr.lastDocumentNumber > 0 ? 'text-blue-700' : 'text-slate-400'}">
                                ${sr.lastDocumentNumber > 0 ? String(sr.lastDocumentNumber).padStart(6, '0') : 'Nenhum'}
                              </strong>
                            </td>
                            <td class="py-2 px-3 text-[10px] text-slate-500 max-w-[140px] truncate" title="${escapeHtml(sr.agtAuthorizationCode || '')}">${escapeHtml(sr.agtAuthorizationCode || '—')}</td>
                            <td class="py-2 px-3">${statusText}</td>
                            <td class="py-2 px-3 text-right font-sans">
                              ${
                                canManage && sr.status !== 'F'
                                  ? isConfirming
                                    ? `<div class="inline-flex items-center gap-1.5">
                                        <button type="button" data-action="confirm-finalize-agt-series" data-id="${escapeHtml(sr.id)}" class="h-7 px-2 rounded bg-red-600 text-white text-[11px] font-semibold">Confirmar</button>
                                        <button type="button" data-action="cancel-finalize-agt-series" class="h-7 px-2 rounded border border-slate-200 text-slate-600 text-[11px]">Voltar</button>
                                      </div>`
                                    : `<button type="button" data-action="finalize-agt-series" data-id="${escapeHtml(sr.id)}" class="text-[11px] text-amber-700 hover:text-amber-900 font-semibold px-2 py-1 rounded hover:bg-amber-50 whitespace-nowrap">Finalizar ('F')</button>`
                                  : `<span class="text-[11px] text-slate-400">—</span>`
                              }
                            </td>
                          </tr>
                        `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>`;

    return `
      <section data-master-section="series" class="${cardCls} ${isSeriesHidden}">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
          <div>
            <h2 class="${secTitleCls}">6. Séries e Configuração Documental AGT (Dec. Exec. 683/25)</h2>
            <p class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-500'} mt-0.5">
              Separação estrita entre séries de Simulação e Produção. Séries fictícias são bloqueadas em modo Produção.
            </p>
          </div>
          ${
            canManage
              ? `<button
                  type="button"
                  data-action="open-request-agt-series-form"
                  class="${
                    isMobile
                      ? 'h-11 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold flex items-center justify-center gap-1.5 shrink-0'
                      : 'h-9 px-3 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0'
                  }"
                >
                  ${ICONS.plus}
                  <span>Solicitar Série à AGT</span>
                </button>`
              : ''
          }
        </div>

        ${
          agtSeriesSuccessMessage
            ? `<div class="p-3 rounded-lg border ${
                isMobile
                  ? 'border-emerald-800 bg-emerald-950/60 text-emerald-300'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-800'
              } text-xs flex items-center justify-between gap-2">
                <span>${escapeHtml(agtSeriesSuccessMessage)}</span>
                <button type="button" data-action="close-request-agt-series-form" class="font-bold px-1">✕</button>
              </div>`
            : ''
        }

        ${
          agtSeriesErrorMessage
            ? `<div class="p-3 rounded-lg border ${
                isMobile
                  ? 'border-red-800 bg-red-950/60 text-red-300'
                  : 'border-red-200 bg-red-50 text-red-700'
              } text-xs flex items-center justify-between gap-2">
                <span>${escapeHtml(agtSeriesErrorMessage)}</span>
                <button type="button" data-action="close-request-agt-series-form" class="font-bold px-1">✕</button>
              </div>`
            : ''
        }

        ${
          showRequestAgtSeriesForm && canManage
            ? `<form data-form="request-agt-series-form" class="p-3.5 rounded-xl border ${
                isMobile ? 'border-blue-800/70 bg-slate-950' : 'border-blue-200 bg-blue-50/40'
              } space-y-3">
                <div class="flex items-center justify-between border-b ${isMobile ? 'border-slate-800' : 'border-blue-200/80'} pb-2">
                  <span class="text-xs font-bold ${isMobile ? 'text-white' : 'text-slate-900'}">Nova Série Documental AGT</span>
                  <button type="button" data-action="close-request-agt-series-form" class="${isMobile ? 'text-slate-400 hover:text-white' : 'text-slate-400 hover:text-slate-700'}">${ICONS.close}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <div class="sm:col-span-4">
                    <label class="${labelCls}"><span>Tipo de Documento *</span></label>
                    <select name="documentType" required class="${selectCls}">
                      ${Object.values(AGT_DOCUMENT_TYPES)
                        .map(
                          (t) =>
                            `<option value="${t.code}" ${t.code === 'FR' ? 'selected' : ''}>${t.code} — ${escapeHtml(t.shortName)}</option>`
                        )
                        .join('')}
                    </select>
                  </div>
                  <div class="sm:col-span-2">
                    <label class="${labelCls}"><span>Código Série *</span></label>
                    <input name="seriesCode" type="text" required maxlength="10" value="${defaultEnv === 'PRODUCAO' ? `P${currentYear}` : `A${currentYear}`}" class="${inputCls} font-mono uppercase" />
                  </div>
                  <div class="sm:col-span-2">
                    <label class="${labelCls}"><span>Ano Fiscal *</span></label>
                    <input name="seriesYear" type="number" required min="${currentYear}" max="${currentYear + 1}" value="${currentYear}" class="${inputCls} font-mono tabular-nums" />
                  </div>
                  <div class="sm:col-span-2">
                    <label class="${labelCls}"><span>1.º N.º *</span></label>
                    <input name="firstDocumentNumber" type="number" required min="1" value="1" class="${inputCls} font-mono tabular-nums" />
                  </div>
                  <div class="sm:col-span-2">
                    <label class="${labelCls}"><span>Ambiente *</span></label>
                    <select name="environment" required class="${selectCls}">
                      <option value="SIMULACAO" ${defaultEnv === 'SIMULACAO' ? 'selected' : ''}>Simulação</option>
                      <option value="PRODUCAO" ${defaultEnv === 'PRODUCAO' ? 'selected' : ''}>Produção</option>
                    </select>
                  </div>
                  <div class="sm:col-span-6">
                    <label class="${labelCls}"><span>Estabelecimento Vinculado</span></label>
                    <select name="establishmentId" class="${selectCls}">
                      <option value="">Todos os estabelecimentos (Global)</option>
                      ${establishments
                        .map(
                          (e) =>
                            `<option value="${escapeHtml(e.id)}" ${e.id === activeEst.id ? 'selected' : ''}>${escapeHtml(e.code)} · ${escapeHtml(e.name)}</option>`
                        )
                        .join('')}
                    </select>
                  </div>
                  <div class="sm:col-span-6">
                    <label class="${labelCls}"><span>Observação / Código Autorização</span></label>
                    <input name="notes" type="text" maxlength="120" placeholder="Opcional" class="${inputCls}" />
                  </div>
                </div>
                <div class="flex items-center justify-end gap-2 pt-1">
                  <button type="button" data-action="close-request-agt-series-form" class="${isMobile ? 'h-11 px-4 rounded-xl bg-slate-800 text-slate-300 text-xs font-medium' : 'h-8 px-3 rounded border border-slate-300 bg-white text-xs text-slate-700'}">Cancelar</button>
                  <button type="submit" class="${isMobile ? 'h-11 px-5 rounded-xl bg-blue-600 text-white text-xs font-bold' : 'h-8 px-4 rounded bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold'}">Submeter Série</button>
                </div>
              </form>`
            : ''
        }

        ${seriesCardsOrTable}
      </section>
    `;
  };

  const renderEstablishmentsSection = () => {
    const isEstHidden = activeSection !== 'ALL' && activeSection !== 'estabelecimentos';

    return `
      <section data-master-section="estabelecimentos" class="${cardCls} ${isEstHidden}">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
          <div>
            <h2 class="${secTitleCls}">8. Estabelecimentos, Caixas e Armazéns</h2>
            <p class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-500'} mt-0.5">
              Estabelecimento padrão activo: <strong>${escapeHtml(activeEst.code)} · ${escapeHtml(activeEst.name)}</strong>. Cada documento emitido grava o snapshot do estabelecimento.
            </p>
          </div>
          ${
            canManage
              ? `<div class="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-action="open-establishment-form"
                    class="${
                      isMobile
                        ? 'h-11 px-3.5 rounded-xl bg-blue-600 text-white text-xs font-bold inline-flex items-center gap-1.5'
                        : 'h-9 px-3 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5'
                    }"
                  >${ICONS.plus}<span>Novo Estabelecimento</span></button>
                  <button
                    type="button"
                    data-action="open-warehouse-form"
                    class="${
                      isMobile
                        ? 'h-11 px-3.5 rounded-xl bg-slate-800 text-slate-200 text-xs font-semibold inline-flex items-center gap-1.5'
                        : 'h-9 px-3 rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 text-xs font-medium inline-flex items-center gap-1.5'
                    }"
                  >${ICONS.plus}<span>Novo Armazém</span></button>
                </div>`
              : ''
          }
        </div>

        ${
          establishmentError
            ? `<div class="p-3 rounded-lg border ${
                isMobile ? 'border-red-800 bg-red-950/60 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
              } text-xs">${escapeHtml(establishmentError)}</div>`
            : ''
        }

        ${
          showEstablishmentForm && canManage
            ? `<form data-form="save-establishment-form" class="p-3.5 rounded-xl border ${
                isMobile ? 'border-blue-800/70 bg-slate-950' : 'border-blue-200 bg-blue-50/40'
              } space-y-3">
                <input type="hidden" name="establishmentId" value="${escapeHtml(editingEstablishment?.id || '')}" />
                <div class="flex items-center justify-between">
                  <span class="text-xs font-bold ${isMobile ? 'text-white' : 'text-slate-900'}">
                    ${editingEstablishment?.id ? 'Editar Estabelecimento' : 'Adicionar Estabelecimento / Filial'}
                  </span>
                  <button type="button" data-action="close-establishment-form" class="text-slate-400 hover:text-slate-600">${ICONS.close}</button>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
                  <div class="sm:col-span-3">
                    <label class="${labelCls}"><span>Código *</span></label>
                    <input name="code" type="text" required maxlength="16" value="${escapeHtml(editingEstablishment?.code || String(establishments.length + 1).padStart(3, '0'))}" placeholder="Ex: 002" class="${inputCls} font-mono uppercase" />
                  </div>
                  <div class="sm:col-span-6">
                    <label class="${labelCls}"><span>Designação *</span></label>
                    <input name="name" type="text" required maxlength="80" value="${escapeHtml(editingEstablishment?.name || '')}" placeholder="Ex: Filial Talatona" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-3">
                    <label class="${labelCls}"><span>Caixa Padrão</span></label>
                    <input name="defaultCashierCode" type="text" maxlength="16" value="${escapeHtml(editingEstablishment?.defaultCashierCode || '01')}" placeholder="01" class="${inputCls} font-mono" />
                  </div>
                  <div class="sm:col-span-6">
                    <label class="${labelCls}"><span>Endereço *</span></label>
                    <input name="address" type="text" required maxlength="160" value="${escapeHtml(editingEstablishment?.address || c.address || '')}" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-3">
                    <label class="${labelCls}"><span>Município</span></label>
                    <input name="municipality" type="text" maxlength="80" value="${escapeHtml(editingEstablishment?.municipality || c.municipality || '')}" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-3">
                    <label class="${labelCls}"><span>Província</span></label>
                    <input name="province" type="text" list="sila-ao-provinces" maxlength="80" value="${escapeHtml(editingEstablishment?.province || c.province || '')}" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-4">
                    <label class="${labelCls}"><span>Telefone</span></label>
                    <input name="phone" type="text" maxlength="40" value="${escapeHtml(editingEstablishment?.phone || c.phone || '')}" class="${inputCls} font-mono" />
                  </div>
                  <div class="sm:col-span-4">
                    <label class="${labelCls}"><span>Email</span></label>
                    <input name="email" type="email" maxlength="120" value="${escapeHtml(editingEstablishment?.email || c.email || '')}" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-4 flex items-center gap-4 pt-2">
                    <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer">
                      <input type="checkbox" name="isHeadquarters" ${editingEstablishment?.isHeadquarters ? 'checked' : ''} class="h-4 w-4 rounded" />
                      <span>Sede / Matriz</span>
                    </label>
                    <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer">
                      <input type="checkbox" name="active" ${editingEstablishment?.active !== false ? 'checked' : ''} class="h-4 w-4 rounded" />
                      <span>Activo</span>
                    </label>
                  </div>
                </div>
                <div class="flex justify-end gap-2">
                  <button type="button" data-action="close-establishment-form" class="${isMobile ? 'h-11 px-4 rounded-xl bg-slate-800 text-slate-300 text-xs' : 'h-8 px-3 rounded border border-slate-200 text-xs text-slate-600'}">Cancelar</button>
                  <button type="submit" class="${isMobile ? 'h-11 px-5 rounded-xl bg-blue-600 text-white text-xs font-bold' : 'h-8 px-4 rounded bg-blue-600 text-white text-xs font-semibold'}">Guardar Estabelecimento</button>
                </div>
              </form>`
            : ''
        }

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          ${establishments
            .map((est) => {
              const isDefault = est.id === activeEst.id;
              return `
                <div class="p-3 rounded-xl border ${
                  isMobile
                    ? isDefault
                      ? 'bg-slate-950 border-blue-600/70'
                      : 'bg-slate-950 border-slate-800'
                    : isDefault
                      ? 'bg-blue-50/40 border-blue-300'
                      : 'bg-slate-50 border-slate-200'
                } space-y-1.5 text-xs">
                  <div class="flex items-center justify-between gap-2">
                    <span class="font-bold ${isMobile ? 'text-white' : 'text-slate-900'}">
                      <span class="font-mono">${escapeHtml(est.code)}</span> · ${escapeHtml(est.name)}
                    </span>
                    <span class="text-[10px] font-semibold ${
                      isDefault
                        ? isMobile
                          ? 'text-blue-400'
                          : 'text-blue-700'
                        : est.active
                          ? isMobile
                            ? 'text-emerald-400'
                            : 'text-emerald-700'
                          : 'text-red-500'
                    }">
                      ${isDefault ? 'Padrão Activo' : est.active ? 'Activo' : 'Inactivo'}
                    </span>
                  </div>
                  <p class="text-[11px] ${isMobile ? 'text-slate-400' : 'text-slate-600'}">
                    ${escapeHtml(est.address)}${est.municipality ? ` · ${escapeHtml(est.municipality)}` : ''}${est.province ? ` · ${escapeHtml(est.province)}` : ''}
                  </p>
                  <p class="text-[11px] font-mono tabular-nums ${isMobile ? 'text-slate-500' : 'text-slate-500'}">
                    Caixa: ${escapeHtml(est.defaultCashierCode || '01')}${est.isHeadquarters ? ' · Matriz' : ''}
                  </p>
                  ${
                    canManage
                      ? `<div class="flex flex-wrap gap-2 pt-1">
                          ${
                            !isDefault && est.active
                              ? `<button type="button" data-action="set-default-establishment" data-id="${escapeHtml(est.id)}" class="${
                                  isMobile ? 'h-9 px-3 rounded-lg bg-blue-600 text-white text-[11px] font-semibold' : 'h-7 px-2.5 rounded bg-slate-900 text-white text-[11px] font-medium'
                                }">Definir Padrão</button>`
                              : ''
                          }
                          <button type="button" data-action="edit-establishment" data-id="${escapeHtml(est.id)}" class="${
                            isMobile ? 'h-9 px-3 rounded-lg bg-slate-800 text-slate-200 text-[11px]' : 'h-7 px-2.5 rounded border border-slate-200 bg-white text-slate-700 text-[11px]'
                          }">Editar</button>
                          ${
                            establishments.length > 1
                              ? `<button type="button" data-action="toggle-establishment-active" data-id="${escapeHtml(est.id)}" class="${
                                  isMobile ? 'h-9 px-3 rounded-lg bg-slate-800 text-slate-300 text-[11px]' : 'h-7 px-2.5 rounded border border-slate-200 bg-white text-slate-600 text-[11px]'
                                }">${est.active ? 'Desactivar' : 'Reactivar'}</button>`
                              : ''
                          }
                        </div>`
                      : ''
                  }
                </div>
              `;
            })
            .join('')}
        </div>

        <!-- Armazéns -->
        <div class="pt-3 border-t ${isMobile ? 'border-slate-800' : 'border-slate-200'} space-y-2.5">
          <div class="text-[11px] font-bold ${isMobile ? 'text-slate-300' : 'text-slate-700'}">
            Armazéns Associados (${warehouses.length})
          </div>
          ${
            warehouseError
              ? `<div class="p-2.5 rounded-lg border ${
                  isMobile ? 'border-red-800 bg-red-950/60 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
                } text-xs">${escapeHtml(warehouseError)}</div>`
              : ''
          }
          ${
            showWarehouseForm && canManage
              ? `<form data-form="save-warehouse-form" class="p-3 rounded-xl border ${
                  isMobile ? 'border-slate-700 bg-slate-950' : 'border-slate-200 bg-slate-50'
                } grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                  <input type="hidden" name="warehouseId" value="${escapeHtml(editingWarehouse?.id || '')}" />
                  <div class="sm:col-span-2">
                    <label class="${labelCls}"><span>Código *</span></label>
                    <input name="code" type="text" required maxlength="16" value="${escapeHtml(editingWarehouse?.code || `ARM-${String(warehouses.length + 1).padStart(2, '0')}`)}" class="${inputCls} font-mono uppercase" />
                  </div>
                  <div class="sm:col-span-4">
                    <label class="${labelCls}"><span>Designação *</span></label>
                    <input name="name" type="text" required maxlength="80" value="${escapeHtml(editingWarehouse?.name || '')}" placeholder="Ex: Armazém Central" class="${inputCls}" />
                  </div>
                  <div class="sm:col-span-3">
                    <label class="${labelCls}"><span>Estabelecimento</span></label>
                    <select name="establishmentId" class="${selectCls}">
                      ${establishments
                        .map(
                          (e) =>
                            `<option value="${escapeHtml(e.id)}" ${(editingWarehouse?.establishmentId || activeEst.id) === e.id ? 'selected' : ''}>${escapeHtml(e.code)} · ${escapeHtml(e.name)}</option>`
                        )
                        .join('')}
                    </select>
                  </div>
                  <div class="sm:col-span-3 flex gap-2">
                    <button type="submit" class="${isMobile ? 'h-11 flex-1 rounded-xl bg-blue-600 text-white text-xs font-bold' : 'h-9 flex-1 rounded-md bg-slate-900 text-white text-xs font-semibold'}">Guardar</button>
                    <button type="button" data-action="close-warehouse-form" class="${isMobile ? 'h-11 px-3 rounded-xl bg-slate-800 text-slate-300 text-xs' : 'h-9 px-3 rounded-md border border-slate-200 text-xs text-slate-600'}">Cancelar</button>
                  </div>
                </form>`
              : ''
          }
          <div class="flex flex-wrap gap-2">
            ${warehouses
              .map((w) => {
                const estMatch = establishments.find((e) => e.id === w.establishmentId);
                return `
                  <div class="px-3 py-2 rounded-lg border ${
                    isMobile ? 'bg-slate-950 border-slate-800 text-slate-200' : 'bg-slate-50 border-slate-200 text-slate-800'
                  } text-xs flex items-center gap-2">
                    <span class="font-mono font-bold">${escapeHtml(w.code)}</span>
                    <span>${escapeHtml(w.name)}</span>
                    ${estMatch ? `<span class="text-[11px] opacity-70">(${escapeHtml(estMatch.code)})</span>` : ''}
                    ${
                      canManage
                        ? `<button type="button" data-action="edit-warehouse" data-id="${escapeHtml(w.id)}" class="text-[11px] underline ${isMobile ? 'text-blue-400' : 'text-blue-700'} ml-1">Editar</button>`
                        : ''
                    }
                  </div>
                `;
              })
              .join('')}
          </div>
        </div>
      </section>
    `;
  };

  const mainFormVisible =
    activeSection !== 'series' && activeSection !== 'estabelecimentos';

  return `
    <div class="space-y-4">
      <datalist id="sila-ao-provinces">
        ${ANGOLA_PROVINCES.map((p) => `<option value="${escapeHtml(p)}"></option>`).join('')}
      </datalist>

      ${renderSectionCompletenessSummary()}
      ${renderSectionTabs()}

      ${
        errorMessage
          ? `<div class="p-3 rounded-lg border ${
              isMobile ? 'border-red-800 bg-red-950/60 text-red-300' : 'border-red-200 bg-red-50 text-red-700'
            } text-xs">${escapeHtml(errorMessage)}</div>`
          : ''
      }

      ${
        savedNotice
          ? `<div class="p-3 rounded-lg border ${
              isMobile ? 'border-emerald-800 bg-emerald-950/60 text-emerald-300' : 'border-emerald-200 bg-emerald-50 text-emerald-800'
            } text-xs font-semibold">Ficha Mestre da empresa guardada com sucesso.</div>`
          : ''
      }

      <form id="${escapeHtml(formId)}" data-form="${escapeHtml(formId)}" class="space-y-4 ${mainFormVisible ? '' : 'hidden'}">
        <input type="hidden" name="defaultEstablishmentId" value="${escapeHtml(activeEst.id)}" />

        <!-- 1. IDENTIFICAÇÃO JURÍDICA E COMERCIAL -->
        <section data-master-section="identificacao" class="${cardCls} ${sectionHiddenClass('identificacao')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.identificacao)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-8">
              ${renderFieldLabel('Denominação Social / Firma', 'legalName')}
              <input name="legalName" type="text" required maxlength="160" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalName)}" placeholder="Ex: JAIMONA - COMÉRCIO E SERVIÇOS, (SU) LDA" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Nome Comercial / Marca', 'shortName')}
              <input name="shortName" type="text" required maxlength="64" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.shortName)}" placeholder="Ex: JAIMONA" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Natureza Jurídica', 'legalNature')}
              <select name="legalNature" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                <option value="" ${!c.legalNature ? 'selected' : ''}>Seleccionar...</option>
                <option value="LDA" ${c.legalNature === 'LDA' ? 'selected' : ''}>Sociedade por Quotas (Lda)</option>
                <option value="SU_LDA" ${c.legalNature === 'SU_LDA' ? 'selected' : ''}>Sociedade Unipessoal (SU, Lda)</option>
                <option value="SA" ${c.legalNature === 'SA' ? 'selected' : ''}>Sociedade Anónima (S.A.)</option>
                <option value="ENI" ${c.legalNature === 'ENI' ? 'selected' : ''}>Empresário em Nome Individual</option>
                <option value="COOP" ${c.legalNature === 'COOP' ? 'selected' : ''}>Cooperativa / Associação</option>
                <option value="OUTRA" ${c.legalNature === 'OUTRA' ? 'selected' : ''}>Outra Entidade</option>
              </select>
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('CAE (Actividade Económica)', 'cae')}
              <input name="cae" type="text" maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.cae)}" placeholder="Ex: 47110" class="${inputCls} font-mono" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Registo Comercial / Matrícula', 'commercialRegistry')}
              <input name="commercialRegistry" type="text" maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.commercialRegistry)}" placeholder="Ex: CRC Luanda n.º 1234/2024" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Capital Social (Kz)', 'shareCapital')}
              <input name="shareCapital" type="text" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.shareCapital)}" placeholder="Ex: 1.000.000,00 Kz" class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-8">
              ${renderFieldLabel('Slogan / Assinatura de Rodapé', 'tagline')}
              <input name="tagline" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.tagline)}" placeholder="Ex: Servimos com Qualidade" class="${inputCls}" />
            </div>
          </div>
        </section>

        <!-- 2. ENQUADRAMENTO FISCAL ANGOLANO (AGT) -->
        <section data-master-section="fiscal" class="${cardCls} ${sectionHiddenClass('fiscal')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.fiscal)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-4">
              ${renderFieldLabel('NIF (Contribuinte Único)', 'nif')}
              <input name="nif" type="text" required maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.nif)}" class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Regime de IVA (CIVA)', 'taxRegime')}
              <select name="taxRegime" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                <option value="GERAL" ${(c.taxRegime || 'GERAL') === 'GERAL' ? 'selected' : ''}>Regime Geral de IVA (14%)</option>
                <option value="SIMPLIFICADO" ${c.taxRegime === 'SIMPLIFICADO' ? 'selected' : ''}>Regime Simplificado (M81)</option>
                <option value="EXCLUSAO" ${c.taxRegime === 'EXCLUSAO' ? 'selected' : ''}>Regime de Exclusão (M80)</option>
              </select>
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Ambiente Operacional AGT', 'agtEnvironment')}
              <select name="agtEnvironment" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                <option value="SIMULACAO" ${(c.agtEnvironment || 'SIMULACAO') === 'SIMULACAO' ? 'selected' : ''}>Simulação / Homologação</option>
                <option value="PRODUCAO" ${c.agtEnvironment === 'PRODUCAO' ? 'selected' : ''}>Produção Fiscal Real (AGT)</option>
              </select>
            </div>
            <div class="sm:col-span-6">
              ${renderFieldLabel('Repartição Fiscal de Domicílio', 'taxOffice')}
              <input name="taxOffice" type="text" maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.taxOffice)}" placeholder="Ex: 1.ª Repartição Fiscal de Luanda" class="${inputCls}" />
            </div>
            <div class="sm:col-span-6">
              ${renderFieldLabel('Código de Isenção Padrão (CIVA)', 'defaultExemptionCode')}
              <select name="defaultExemptionCode" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                <option value="" ${!c.defaultExemptionCode ? 'selected' : ''}>Automático consoante o regime</option>
                ${Object.values(AGT_IVA_EXEMPTION_CODES)
                  .map(
                    (ex) =>
                      `<option value="${ex.code}" ${c.defaultExemptionCode === ex.code ? 'selected' : ''}>${ex.code} — ${escapeHtml(ex.descriptionPt)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Território Fiscal Especial', 'specialTaxTerritory')}
              <select name="specialTaxTerritory" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                <option value="AO" ${(c.specialTaxTerritory || 'AO') === 'AO' ? 'selected' : ''}>AO — Regime Nacional Geral</option>
                <option value="AO-CAB" ${c.specialTaxTerritory === 'AO-CAB' ? 'selected' : ''}>AO-CAB — Cabinda (1% Lei n.º 14/23)</option>
              </select>
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Retenção na Fonte Padrão (%)', 'defaultWithholdingTax')}
              <input name="defaultWithholdingTax" type="number" step="0.1" min="0" max="35" ${!canManage ? 'disabled' : ''} value="${c.defaultWithholdingTax ?? ''}" placeholder="Ex: 6.5" class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Início de Actividade', undefined, 'OPTIONAL')}
              <input name="activityStartDate" type="date" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.activityStartDate)}" class="${inputCls} font-mono" />
            </div>
            <div class="sm:col-span-6">
              ${renderFieldLabel('Entidade Tributária / SAF-T (<TaxEntity>)', undefined, 'OPTIONAL')}
              <input name="taxEntity" type="text" maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.taxEntity)}" placeholder="Ex: Sede" class="${inputCls}" />
            </div>
            <div class="sm:col-span-6 flex items-end pb-1">
              <input type="hidden" name="isVatRetentionAgentPresent" value="1" />
              <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none min-h-[36px]">
                <input type="checkbox" name="isVatRetentionAgent" ${!canManage ? 'disabled' : ''} ${c.isVatRetentionAgent ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
                <span>Empresa sujeita a cativo / agente de retenção de IVA</span>
              </label>
            </div>
          </div>
        </section>

        <!-- 3. ENDEREÇO FISCAL E COMERCIAL -->
        <section data-master-section="endereco" class="${cardCls} ${sectionHiddenClass('endereco')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.endereco)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-12">
              ${renderFieldLabel('Endereço Fiscal Completo (Rua, Bairro, N.º)', 'address')}
              <input name="address" type="text" required maxlength="160" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.address)}" placeholder="Ex: Rua Fapla, Bairro Verde A" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Município', 'municipality')}
              <input name="municipality" type="text" maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.municipality)}" placeholder="Ex: Saurimo / Belas / Ingombota" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Província', 'province')}
              <input name="province" type="text" list="sila-ao-provinces" maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.province)}" placeholder="Ex: Luanda / Lunda Sul" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Caixa / Código Postal', 'postalCode')}
              <input name="postalCode" type="text" maxlength="24" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.postalCode)}" placeholder="Ex: CX 1024" class="${inputCls} font-mono" />
            </div>
            <div class="sm:col-span-12">
              ${renderFieldLabel('Cidade / País de Referência', 'cityCountry')}
              <input name="cityCountry" type="text" required maxlength="80" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.cityCountry || 'Luanda - Angola')}" class="${inputCls}" />
            </div>
          </div>
        </section>

        <!-- 4. CONTACTOS INSTITUCIONAIS -->
        <section data-master-section="contactos" class="${cardCls} ${sectionHiddenClass('contactos')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.contactos)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-4">
              ${renderFieldLabel('Telefone Principal', 'phone')}
              <input name="phone" type="tel" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.phone)}" placeholder="(+244) 9..." class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Telemóvel Alternativo', 'mobile')}
              <input name="mobile" type="tel" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.mobile)}" placeholder="(+244) 9..." class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('WhatsApp Comercial', 'whatsapp')}
              <input name="whatsapp" type="tel" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.whatsapp)}" placeholder="(+244) 9..." class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Email Institucional / Fiscal', 'email')}
              <input name="email" type="email" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.email)}" placeholder="geral@empresa.ao" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Email Exclusivo de Facturação', 'billingEmail')}
              <input name="billingEmail" type="email" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.billingEmail)}" placeholder="faturacao@empresa.ao" class="${inputCls}" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Website Institucional', 'website')}
              <input name="website" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.website)}" placeholder="www.empresa.ao" class="${inputCls}" />
            </div>
          </div>
        </section>

        <!-- 5. IDENTIDADE VISUAL & LOGÓTIPO -->
        <section data-master-section="identidade_visual" class="${cardCls} ${sectionHiddenClass('identidade_visual')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.identidade_visual)}</h2>
          </div>
          ${renderLogoBlock()}
        </section>

        <!-- 7. DADOS BANCÁRIOS E MEIOS DE PAGAMENTO -->
        <section data-master-section="bancos" class="${cardCls} ${sectionHiddenClass('bancos')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.bancos)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-4">
              ${renderFieldLabel('Banco Principal', 'bankName1')}
              <input name="bankName1" type="text" maxlength="60" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.bankName1)}" placeholder="Ex: BAI / BFA / BIC / Atlântico" class="${inputCls}" />
            </div>
            <div class="sm:col-span-8">
              ${renderFieldLabel('IBAN Principal (AO06...)', 'iban1')}
              <input name="iban1" type="text" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.iban1)}" placeholder="AO06004000000000000000000" class="${inputCls} font-mono tabular-nums uppercase" />
            </div>
            <div class="sm:col-span-6">
              ${renderFieldLabel('Titular da Conta Principal', undefined, 'OPTIONAL')}
              <input name="accountHolder1" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountHolder1)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-6">
              ${renderFieldLabel('Código SWIFT / BIC (Banco 1)', undefined, 'OPTIONAL')}
              <input name="swift1" type="text" maxlength="20" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.swift1)}" placeholder="Ex: BAIPAOLU" class="${inputCls} font-mono uppercase" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Banco Secundário', 'bankName2')}
              <input name="bankName2" type="text" maxlength="60" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.bankName2)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-8">
              ${renderFieldLabel('IBAN Secundário', 'iban2')}
              <input name="iban2" type="text" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.iban2)}" placeholder="AO06..." class="${inputCls} font-mono tabular-nums uppercase" />
            </div>
            <div class="sm:col-span-4">
              ${renderFieldLabel('Titular da Conta Secundária', undefined, 'OPTIONAL')}
              <input name="accountHolder2" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountHolder2)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-2">
              ${renderFieldLabel('SWIFT (Banco 2)', undefined, 'OPTIONAL')}
              <input name="swift2" type="text" maxlength="20" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.swift2)}" class="${inputCls} font-mono uppercase" />
            </div>
            <div class="sm:col-span-3">
              ${renderFieldLabel('Multicaixa Express (Tel.)', undefined, 'OPTIONAL')}
              <input name="multicaixaExpressPhone" type="tel" maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.multicaixaExpressPhone)}" placeholder="9..." class="${inputCls} font-mono tabular-nums" />
            </div>
            <div class="sm:col-span-3">
              ${renderFieldLabel('Prazo Vencimento FA (dias)', undefined, 'OPTIONAL')}
              <input name="defaultPaymentTermsDays" type="number" min="0" max="365" ${!canManage ? 'disabled' : ''} value="${c.defaultPaymentTermsDays ?? ''}" placeholder="Ex: 15" class="${inputCls} font-mono tabular-nums" />
            </div>
          </div>
        </section>

        <!-- 9. REPRESENTANTES, RESPONSÁVEIS E CAIXA/EMISSÃO -->
        <section data-master-section="representantes" class="${cardCls} ${sectionHiddenClass('representantes')}">
          <div class="pb-2 border-b ${isMobile ? 'border-slate-800' : 'border-slate-200'}">
            <h2 class="${secTitleCls}">${escapeHtml(MASTER_SECTION_LABELS.representantes)}</h2>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-12 gap-3">
            <div class="sm:col-span-5">
              ${renderFieldLabel('Representante Legal / Gerente', 'legalRepresentativeName')}
              <input name="legalRepresentativeName" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalRepresentativeName)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-3">
              ${renderFieldLabel('Cargo / Função', undefined, 'OPTIONAL')}
              <input name="legalRepresentativeRole" type="text" maxlength="60" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalRepresentativeRole)}" placeholder="Ex: Sócio-Gerente" class="${inputCls}" />
            </div>
            <div class="sm:col-span-2">
              ${renderFieldLabel('NIF do Representante', undefined, 'OPTIONAL')}
              <input name="legalRepresentativeNif" type="text" maxlength="24" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalRepresentativeNif)}" class="${inputCls} font-mono" />
            </div>
            <div class="sm:col-span-2">
              ${renderFieldLabel('Tel. Representante', undefined, 'OPTIONAL')}
              <input name="legalRepresentativePhone" type="tel" maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.legalRepresentativePhone)}" class="${inputCls} font-mono" />
            </div>

            <div class="sm:col-span-4">
              ${renderFieldLabel('Contabilista Responsável', 'accountantName')}
              <input name="accountantName" type="text" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountantName)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-2">
              ${renderFieldLabel('Cédula OCPCA', 'accountantOcpcaNumber')}
              <input name="accountantOcpcaNumber" type="text" maxlength="40" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountantOcpcaNumber)}" class="${inputCls} font-mono" />
            </div>
            <div class="sm:col-span-3">
              ${renderFieldLabel('Email Contabilista', undefined, 'OPTIONAL')}
              <input name="accountantEmail" type="email" maxlength="120" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountantEmail)}" class="${inputCls}" />
            </div>
            <div class="sm:col-span-3">
              ${renderFieldLabel('Tel. Contabilista', undefined, 'OPTIONAL')}
              <input name="accountantPhone" type="tel" maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(c.accountantPhone)}" class="${inputCls} font-mono" />
            </div>
          </div>

          <div class="pt-3 border-t ${isMobile ? 'border-slate-800' : 'border-slate-200'} space-y-3">
            <h3 class="text-xs font-semibold ${isMobile ? 'text-slate-200' : 'text-slate-800'}">Caixa e Predefinições de Emissão (POS / A4)</h3>
            <div class="grid grid-cols-2 sm:grid-cols-12 gap-3">
              <div class="col-span-1 sm:col-span-3">
                <label class="${labelCls}"><span>Caixa Padrão</span></label>
                <input name="defaultCashier" type="text" required maxlength="16" ${!canManage ? 'disabled' : ''} value="${escapeHtml(s.defaultCashier)}" class="${inputCls} font-mono" />
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="${labelCls}"><span>Operador(a) Padrão</span></label>
                <input name="defaultOperator" type="text" required maxlength="32" ${!canManage ? 'disabled' : ''} value="${escapeHtml(s.defaultOperator)}" class="${inputCls} font-mono" />
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="${labelCls}"><span>Documento Padrão</span></label>
                <select name="defaultDocType" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                  <option value="FR" ${s.defaultDocType === 'FR' ? 'selected' : ''}>Factura / Recibo (FR)</option>
                  <option value="FA" ${s.defaultDocType === 'FA' ? 'selected' : ''}>Factura a Prazo (FA)</option>
                  <option value="FP" ${s.defaultDocType === 'FP' ? 'selected' : ''}>Factura Proforma (FP)</option>
                </select>
              </div>
              <div class="col-span-1 sm:col-span-3">
                <label class="${labelCls}"><span>Formato Preferencial</span></label>
                <select name="defaultFormat" ${!canManage ? 'disabled' : ''} class="${selectCls}">
                  <option value="POS" ${s.defaultFormat === 'POS' ? 'selected' : ''}>POS Térmico 80mm</option>
                  <option value="A4" ${s.defaultFormat === 'A4' ? 'selected' : ''}>Factura A4</option>
                </select>
              </div>
              <div class="col-span-2 sm:col-span-8">
                <label class="${labelCls}"><span>Observação Padrão nos Documentos</span></label>
                <input name="defaultNotes" type="text" maxlength="300" ${!canManage ? 'disabled' : ''} value="${escapeHtml(s.defaultNotes)}" class="${inputCls}" />
              </div>
              <div class="col-span-2 sm:col-span-4 flex items-end pb-1">
                <input type="hidden" name="autoPrintOnEmitPresent" value="1" />
                <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none min-h-[36px]">
                  <input name="autoPrintOnEmit" type="checkbox" ${!canManage ? 'disabled' : ''} ${s.autoPrintOnEmit ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
                  <span>Imprimir ao emitir</span>
                </label>
              </div>
              <div class="col-span-1 sm:col-span-6">
                <label class="${labelCls}"><span>Desconto Máx. Caixa (%)</span></label>
                <input name="maxCashierDiscountPct" type="number" min="0" max="100" step="0.5" ${!canManage ? 'disabled' : ''} value="${s.maxCashierDiscountPct ?? 5}" class="${inputCls} font-mono tabular-nums" />
              </div>
              <div class="col-span-1 sm:col-span-6">
                <label class="${labelCls}"><span>PIN do Supervisor</span></label>
                <input name="supervisorPin" type="password" maxlength="16" placeholder="Ex: 1234" ${!canManage ? 'disabled' : ''} value="${escapeHtml(s.supervisorPin || '')}" class="${inputCls} font-mono tracking-widest" />
              </div>
              <div class="col-span-2 sm:col-span-12 space-y-2 pt-1">
                <input type="hidden" name="allowCashierPriceEditPresent" value="1" />
                <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none">
                  <input name="allowCashierPriceEdit" type="checkbox" ${!canManage ? 'disabled' : ''} ${s.allowCashierPriceEdit ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
                  <span>Autorizar Operadores de Caixa a alterar o preço unitário no POS</span>
                </label>
                <input type="hidden" name="hidePromotionalFooterPresent" value="1" />
                <label class="flex items-center gap-2 text-xs ${isMobile ? 'text-slate-200' : 'text-slate-700'} cursor-pointer select-none">
                  <input name="hidePromotionalFooter" type="checkbox" data-field="toggle-clean-footer" ${!canManage || !canCompanyHideViralFooter(company) ? 'disabled' : ''} ${!shouldShowViralDocumentFooter(company, s) ? 'checked' : ''} class="h-4 w-4 rounded border-slate-400 text-blue-600" />
                  <span>Emitir talões POS 80mm e facturas A4 sem linha promocional de rodapé</span>
                </label>
              </div>
            </div>
          </div>
        </section>
      </form>

      ${renderSeriesSection()}
      ${renderEstablishmentsSection()}
    </div>
  `;
}
