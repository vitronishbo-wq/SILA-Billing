import {
  AGT_IVA_EXEMPTION_CODES,
  type AgtIvaExemptionCode,
  type AgtSeriesRecord,
} from './fiscalTypes.ts';
import {
  createDefaultEstablishmentForCompany,
  validateCompanyNif,
  type AngolaTaxRegime,
  type CompanyProfile,
  type EstablishmentRecord,
} from './types.ts';

export type MasterSectionId =
  | 'identificacao'
  | 'fiscal'
  | 'endereco'
  | 'contactos'
  | 'identidade_visual'
  | 'series'
  | 'bancos'
  | 'estabelecimentos'
  | 'representantes';

export type FieldRequirementLevel = 'REQUIRED' | 'CONDITIONAL' | 'OPTIONAL';

export interface MasterFieldDescriptor {
  key: keyof CompanyProfile | 'series' | 'establishments';
  section: MasterSectionId;
  label: string;
  requirement: FieldRequirementLevel;
  legalNote: string;
}

export const MASTER_SECTION_LABELS: Readonly<Record<MasterSectionId, string>> = {
  identificacao: '1. Identificação Jurídica e Comercial',
  fiscal: '2. Enquadramento Fiscal Angolano (AGT)',
  endereco: '3. Endereço Fiscal e Comercial',
  contactos: '4. Contactos Institucionais',
  identidade_visual: '5. Identidade Visual e Logótipo',
  series: '6. Séries e Configuração Documental',
  bancos: '7. Dados Bancários e Meios de Pagamento',
  estabelecimentos: '8. Estabelecimentos, Caixas e Armazéns',
  representantes: '9. Representantes e Responsáveis',
};

export const COMPANY_MASTER_FIELD_REGISTRY: readonly MasterFieldDescriptor[] = [
  // 1. Identificação Jurídica e Comercial
  {
    key: 'legalName',
    section: 'identificacao',
    label: 'Denominação Social / Firma',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório em documentos AGT, cabeçalho SAF-T (<CompanyName>) e facturas A4/POS.',
  },
  {
    key: 'shortName',
    section: 'identificacao',
    label: 'Nome Comercial / Marca',
    requirement: 'REQUIRED',
    legalNote: 'Utilizado no cabeçalho POS, SAF-T (<BusinessName>) e selecção multiempresa.',
  },
  {
    key: 'legalNature',
    section: 'identificacao',
    label: 'Natureza Jurídica',
    requirement: 'OPTIONAL',
    legalNote: 'Enquadramento societário (Lda, SU Lda, S.A., ENI, Cooperativa).',
  },
  {
    key: 'cae',
    section: 'identificacao',
    label: 'CAE (Código de Actividade Económica)',
    requirement: 'OPTIONAL',
    legalNote: 'Referência de enquadramento de actividade económica em Angola.',
  },
  {
    key: 'commercialRegistry',
    section: 'identificacao',
    label: 'Registo Comercial / Matrícula',
    requirement: 'CONDITIONAL',
    legalNote: 'Obrigatório para sociedades comerciais em facturas A4 (ex: Conservatória do Registo Comercial).',
  },
  {
    key: 'shareCapital',
    section: 'identificacao',
    label: 'Capital Social (Kz)',
    requirement: 'CONDITIONAL',
    legalNote: 'Exigido em facturas A4 de sociedades comerciais quando aplicável (CSC).',
  },
  {
    key: 'tagline',
    section: 'identificacao',
    label: 'Slogan / Mensagem de Rodapé',
    requirement: 'OPTIONAL',
    legalNote: 'Mensagem institucional exibida no rodapé dos documentos POS e A4.',
  },
  // 2. Enquadramento Fiscal Angolano
  {
    key: 'nif',
    section: 'fiscal',
    label: 'NIF (Número de Identificação Fiscal)',
    requirement: 'REQUIRED',
    legalNote: 'Identificador único do contribuinte na AGT, QR Code (campo A) e SAF-T (<CompanyID>).',
  },
  {
    key: 'taxRegime',
    section: 'fiscal',
    label: 'Regime de IVA (Geral / Simplificado / Exclusão)',
    requirement: 'REQUIRED',
    legalNote: 'Define as menções obrigatórias de enquadramento e código de isenção padrão (CIVA).',
  },
  {
    key: 'taxOffice',
    section: 'fiscal',
    label: 'Repartição Fiscal de Domicílio',
    requirement: 'CONDITIONAL',
    legalNote: 'Recomendado/exigido antes da emissão fiscal em produção (ex: 1.ª Repartição Fiscal de Luanda).',
  },
  {
    key: 'defaultExemptionCode',
    section: 'fiscal',
    label: 'Código de Isenção Padrão (CIVA)',
    requirement: 'CONDITIONAL',
    legalNote: 'Obrigatório quando o regime é Exclusão (M80) ou Simplificado (M81).',
  },
  {
    key: 'specialTaxTerritory',
    section: 'fiscal',
    label: 'Território Fiscal Especial',
    requirement: 'OPTIONAL',
    legalNote: 'Permite sinalizar regime especial de Cabinda (AO-CAB, Lei n.º 14/23).',
  },
  {
    key: 'agtEnvironment',
    section: 'fiscal',
    label: 'Ambiente Operacional AGT',
    requirement: 'REQUIRED',
    legalNote: 'Separa operação em Simulação/Homologação de emissão real em Produção (Dec. 683/25).',
  },
  {
    key: 'defaultWithholdingTax',
    section: 'fiscal',
    label: 'Retenção na Fonte Padrão (%)',
    requirement: 'OPTIONAL',
    legalNote: 'Taxa predefinida de retenção (ex: 6,5% Imposto Industrial em serviços).',
  },
  // 3. Endereço Fiscal
  {
    key: 'address',
    section: 'endereco',
    label: 'Endereço Fiscal Completo',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório no cabeçalho documental, A4/POS e SAF-T (<AddressDetail>).',
  },
  {
    key: 'municipality',
    section: 'endereco',
    label: 'Município',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório para emissão em produção e cabeçalho SAF-T (<City>).',
  },
  {
    key: 'province',
    section: 'endereco',
    label: 'Província',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório no cabeçalho SAF-T (AO) (<Province>) e A4.',
  },
  {
    key: 'cityCountry',
    section: 'endereco',
    label: 'Cidade / País de Referência',
    requirement: 'REQUIRED',
    legalNote: 'Identificação territorial combinada apresentada nos talões e relatórios.',
  },
  {
    key: 'postalCode',
    section: 'endereco',
    label: 'Caixa Postal / Código Postal',
    requirement: 'OPTIONAL',
    legalNote: 'Quando ausente, assume fallback "Desconhecido" no SAF-T (AO).',
  },
  // 4. Contactos Institucionais
  {
    key: 'phone',
    section: 'contactos',
    label: 'Telefone Principal',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório nas facturas e no campo <Telephone> do SAF-T (AO).',
  },
  {
    key: 'mobile',
    section: 'contactos',
    label: 'Telemóvel Alternativo',
    requirement: 'OPTIONAL',
    legalNote: 'Contacto secundário exibido em documentos A4 e ficha institucional.',
  },
  {
    key: 'whatsapp',
    section: 'contactos',
    label: 'WhatsApp Comercial',
    requirement: 'OPTIONAL',
    legalNote: 'Utilizado para partilha rápida de comprovativos com clientes.',
  },
  {
    key: 'email',
    section: 'contactos',
    label: 'Email Institucional / Fiscal',
    requirement: 'REQUIRED',
    legalNote: 'Obrigatório no cabeçalho SAF-T (<Email>) e na emissão A4.',
  },
  {
    key: 'billingEmail',
    section: 'contactos',
    label: 'Email Exclusivo de Facturação',
    requirement: 'OPTIONAL',
    legalNote: 'Endereço dedicado para envio/recepção de facturas electrónicas.',
  },
  {
    key: 'website',
    section: 'contactos',
    label: 'Website Institucional',
    requirement: 'OPTIONAL',
    legalNote: 'Impresso no cabeçalho/rodapé da factura A4 quando preenchido.',
  },
  // 5. Identidade Visual
  {
    key: 'logoUrl',
    section: 'identidade_visual',
    label: 'Logótipo da Empresa',
    requirement: 'OPTIONAL',
    legalNote: 'Imagem PNG/JPG/WebP (máx. 200 KB) impressa nos templates A4 e POS.',
  },
  // 6. Séries Documentais
  {
    key: 'series',
    section: 'series',
    label: 'Séries Documentais AGT',
    requirement: 'REQUIRED',
    legalNote: 'Pelo menos uma série autorizada activa para emissão fiscal real (Dec. 683/25).',
  },
  // 7. Dados Bancários
  {
    key: 'bankName1',
    section: 'bancos',
    label: 'Banco Principal',
    requirement: 'CONDITIONAL',
    legalNote: 'Recomendado para facturas a prazo (FA) e pagamentos por transferência.',
  },
  {
    key: 'iban1',
    section: 'bancos',
    label: 'IBAN Principal (AO06...)',
    requirement: 'CONDITIONAL',
    legalNote: 'Exibido nas facturas A4 para liquidação bancária.',
  },
  {
    key: 'bankName2',
    section: 'bancos',
    label: 'Banco Secundário',
    requirement: 'OPTIONAL',
    legalNote: 'Coordenada bancária alternativa em facturas A4.',
  },
  {
    key: 'iban2',
    section: 'bancos',
    label: 'IBAN Secundário',
    requirement: 'OPTIONAL',
    legalNote: 'IBAN alternativo em facturas A4.',
  },
  // 8. Estabelecimentos
  {
    key: 'establishments',
    section: 'estabelecimentos',
    label: 'Estabelecimentos / Lojas Activas',
    requirement: 'REQUIRED',
    legalNote: 'Identifica a origem operacional de cada documento emitido e série vinculada.',
  },
  // 9. Representantes e Responsáveis
  {
    key: 'legalRepresentativeName',
    section: 'representantes',
    label: 'Representante Legal / Gerente',
    requirement: 'OPTIONAL',
    legalNote: 'Identificação do gerente ou administrador para auditoria interna.',
  },
  {
    key: 'accountantName',
    section: 'representantes',
    label: 'Contabilista Responsável',
    requirement: 'OPTIONAL',
    legalNote: 'Responsável técnico pela contabilidade e validação do SAF-T (AO).',
  },
  {
    key: 'accountantOcpcaNumber',
    section: 'representantes',
    label: 'Cédula OCPCA do Contabilista',
    requirement: 'OPTIONAL',
    legalNote: 'Número de inscrição na Ordem dos Contabilistas e Peritos Contabilistas de Angola.',
  },
];

export interface CompanyValidationIssue {
  section: MasterSectionId;
  field: string;
  severity: 'error' | 'warning';
  message: string;
}

export interface SectionCompletenessStatus {
  section: MasterSectionId;
  label: string;
  completedCount: number;
  totalCount: number;
  missingRequired: string[];
  ready: boolean;
}

export interface CompanyMasterCompletenessResult {
  completionPct: number;
  readyForSimulation: boolean;
  readyForProductionEmission: boolean;
  blockingIssues: CompanyValidationIssue[];
  warnings: CompanyValidationIssue[];
  sectionStatus: Record<MasterSectionId, SectionCompletenessStatus>;
  fieldStatus: Record<string, 'ok' | 'missing_required' | 'missing_conditional' | 'invalid' | 'optional_empty'>;
}

const MAX_LOGO_STRING_BYTES = 260 * 1024; // ~200 KB binário em Base64

export function validateLogoDataUrl(rawUrl?: string | null): {
  valid: boolean;
  error?: string;
} {
  const val = String(rawUrl || '').trim();
  if (!val) {
    return { valid: true };
  }

  const lower = val.toLowerCase();
  if (
    lower.includes('<svg') ||
    lower.includes('<script') ||
    lower.startsWith('data:image/svg') ||
    lower.startsWith('javascript:')
  ) {
    return {
      valid: false,
      error: 'Formato de logótipo não permitido por segurança. Utilize apenas PNG, JPG ou WebP.',
    };
  }

  if (val.length > MAX_LOGO_STRING_BYTES) {
    return {
      valid: false,
      error: 'O logótipo excede o tamanho máximo recomendado (200 KB). Reduza a imagem antes de guardar.',
    };
  }

  const isAllowedDataImage = /^data:image\/(png|jpeg|jpg|webp);base64,[a-z0-9+/=\s]+$/i.test(val);
  const isHttpsUrl = /^https:\/\/[^\s"'<>]+$/i.test(val);
  if (!isAllowedDataImage && !isHttpsUrl) {
    return {
      valid: false,
      error: 'URL de logótipo inválido. Carregue uma imagem PNG/JPG/WebP ou informe um endereço HTTPS válido.',
    };
  }

  return { valid: true };
}

export function validateAngolaIban(rawIban?: string | null): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  const normalized = String(rawIban || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-]+/g, '');
  if (!normalized) {
    return { valid: true, normalized: '' };
  }
  if (!/^AO06[0-9]{21}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'IBAN angolano inválido. Deve começar por AO06 seguido de 21 dígitos (25 caracteres no total).',
    };
  }
  return { valid: true, normalized };
}

export function resolveDefaultExemptionCodeForCompany(
  profile: Pick<CompanyProfile, 'taxRegime' | 'defaultExemptionCode'>,
  explicitCode?: AgtIvaExemptionCode | string | null
): AgtIvaExemptionCode {
  const candidate = String(explicitCode || '').trim().toUpperCase() as AgtIvaExemptionCode;
  if (candidate && AGT_IVA_EXEMPTION_CODES[candidate]) {
    return candidate;
  }

  const companyDefault = String(profile.defaultExemptionCode || '')
    .trim()
    .toUpperCase() as AgtIvaExemptionCode;
  if (companyDefault && AGT_IVA_EXEMPTION_CODES[companyDefault]) {
    return companyDefault;
  }

  const regime: AngolaTaxRegime = profile.taxRegime || 'GERAL';
  if (regime === 'EXCLUSAO') return 'M80';
  if (regime === 'SIMPLIFICADO') return 'M81';
  return 'M10';
}

export function resolveActiveEstablishment(
  profile: CompanyProfile,
  preferredEstablishmentId?: string | null
): EstablishmentRecord {
  const list = Array.isArray(profile.establishments) ? profile.establishments : [];
  if (preferredEstablishmentId) {
    const exact = list.find((e) => e.id === preferredEstablishmentId && e.active);
    if (exact) return exact;
  }
  if (profile.defaultEstablishmentId) {
    const def = list.find((e) => e.id === profile.defaultEstablishmentId && e.active);
    if (def) return def;
  }
  const hq = list.find((e) => e.isHeadquarters && e.active);
  if (hq) return hq;
  const anyActive = list.find((e) => e.active);
  if (anyActive) return anyActive;
  return createDefaultEstablishmentForCompany(profile);
}

export function validateEstablishmentRecord(est: Partial<EstablishmentRecord>): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!String(est.code || '').trim()) {
    errors.push('O código do estabelecimento é obrigatório (ex: 001).');
  }
  if (!String(est.name || '').trim()) {
    errors.push('A designação do estabelecimento é obrigatória.');
  }
  if (!String(est.address || '').trim()) {
    errors.push('O endereço do estabelecimento é obrigatório.');
  }
  return { valid: errors.length === 0, errors };
}

export function evaluateCompanyMasterCompleteness(
  profile: CompanyProfile,
  options?: {
    series?: ReadonlyArray<AgtSeriesRecord>;
    requireProductionSeriesCheck?: boolean;
  }
): CompanyMasterCompletenessResult {
  const blockingIssues: CompanyValidationIssue[] = [];
  const warnings: CompanyValidationIssue[] = [];
  const fieldStatus: CompanyMasterCompletenessResult['fieldStatus'] = {};

  const hasText = (v?: string | null): boolean => Boolean(String(v || '').trim());

  // 1. Identificação Jurídica e Comercial
  const hasLegalName = hasText(profile.legalName) && !profile.legalName.includes('Selecionar ou Cadastrar');
  const hasShortName = hasText(profile.shortName) && profile.shortName !== 'Nova Empresa';
  fieldStatus.legalName = hasLegalName ? 'ok' : 'missing_required';
  fieldStatus.shortName = hasShortName ? 'ok' : 'missing_required';
  fieldStatus.legalNature = hasText(profile.legalNature) ? 'ok' : 'optional_empty';
  fieldStatus.cae = hasText(profile.cae) ? 'ok' : 'optional_empty';
  fieldStatus.tagline = hasText(profile.tagline) ? 'ok' : 'optional_empty';

  const isCorporate =
    profile.legalNature === 'LDA' ||
    profile.legalNature === 'SU_LDA' ||
    profile.legalNature === 'SA';
  fieldStatus.commercialRegistry = hasText(profile.commercialRegistry)
    ? 'ok'
    : isCorporate
      ? 'missing_conditional'
      : 'optional_empty';
  fieldStatus.shareCapital = hasText(profile.shareCapital)
    ? 'ok'
    : isCorporate
      ? 'missing_conditional'
      : 'optional_empty';

  if (!hasLegalName) {
    blockingIssues.push({
      section: 'identificacao',
      field: 'legalName',
      severity: 'error',
      message: 'A Denominação Social / Firma da empresa é obrigatória.',
    });
  }
  if (!hasShortName) {
    blockingIssues.push({
      section: 'identificacao',
      field: 'shortName',
      severity: 'error',
      message: 'O Nome Comercial abreviado da empresa é obrigatório.',
    });
  }
  if (isCorporate && !hasText(profile.commercialRegistry)) {
    warnings.push({
      section: 'identificacao',
      field: 'commercialRegistry',
      severity: 'warning',
      message: 'Recomenda-se indicar o número de Registo Comercial para exibição nas facturas A4.',
    });
  }

  // 2. Enquadramento Fiscal
  const nifCheck = validateCompanyNif(profile.nif);
  fieldStatus.nif = nifCheck.valid ? 'ok' : 'invalid';
  if (!nifCheck.valid) {
    blockingIssues.push({
      section: 'fiscal',
      field: 'nif',
      severity: 'error',
      message: nifCheck.error || 'O NIF da empresa emitente é inválido.',
    });
  }

  const hasTaxRegime =
    profile.taxRegime === 'GERAL' ||
    profile.taxRegime === 'SIMPLIFICADO' ||
    profile.taxRegime === 'EXCLUSAO';
  fieldStatus.taxRegime = hasTaxRegime ? 'ok' : 'missing_required';
  if (!hasTaxRegime) {
    blockingIssues.push({
      section: 'fiscal',
      field: 'taxRegime',
      severity: 'error',
      message: 'Seleccione o Regime Fiscal de IVA da empresa (Geral, Simplificado ou Exclusão).',
    });
  }

  const hasTaxOffice = hasText(profile.taxOffice);
  fieldStatus.taxOffice = hasTaxOffice ? 'ok' : 'missing_conditional';
  if (!hasTaxOffice) {
    warnings.push({
      section: 'fiscal',
      field: 'taxOffice',
      severity: 'warning',
      message: 'Informe a Repartição Fiscal de domicílio antes de activar a emissão em produção.',
    });
  }

  const needsDefaultExemption =
    profile.taxRegime === 'EXCLUSAO' || profile.taxRegime === 'SIMPLIFICADO';
  const hasValidDefaultExemption = Boolean(
    profile.defaultExemptionCode && AGT_IVA_EXEMPTION_CODES[profile.defaultExemptionCode]
  );
  fieldStatus.defaultExemptionCode = hasValidDefaultExemption
    ? 'ok'
    : needsDefaultExemption
      ? 'missing_conditional'
      : 'optional_empty';
  if (needsDefaultExemption && !hasValidDefaultExemption) {
    warnings.push({
      section: 'fiscal',
      field: 'defaultExemptionCode',
      severity: 'warning',
      message: `Regime ${profile.taxRegime}: recomenda-se definir o código padrão (${profile.taxRegime === 'EXCLUSAO' ? 'M80' : 'M81'}).`,
    });
  }

  fieldStatus.agtEnvironment =
    profile.agtEnvironment === 'PRODUCAO' || profile.agtEnvironment === 'SIMULACAO'
      ? 'ok'
      : 'missing_required';
  fieldStatus.specialTaxTerritory = hasText(profile.specialTaxTerritory) ? 'ok' : 'optional_empty';
  fieldStatus.defaultWithholdingTax =
    typeof profile.defaultWithholdingTax === 'number' && profile.defaultWithholdingTax >= 0
      ? 'ok'
      : 'optional_empty';

  // 3. Endereço Fiscal
  const hasAddress = hasText(profile.address) && profile.address.trim().toLowerCase() !== 'angola';
  const hasMunicipality = hasText(profile.municipality);
  const hasProvince = hasText(profile.province);
  const hasCityCountry = hasText(profile.cityCountry);

  fieldStatus.address = hasAddress ? 'ok' : 'missing_required';
  fieldStatus.municipality = hasMunicipality ? 'ok' : 'missing_required';
  fieldStatus.province = hasProvince ? 'ok' : 'missing_required';
  fieldStatus.cityCountry = hasCityCountry ? 'ok' : 'missing_required';
  fieldStatus.postalCode = hasText(profile.postalCode) ? 'ok' : 'optional_empty';

  if (!hasAddress) {
    blockingIssues.push({
      section: 'endereco',
      field: 'address',
      severity: 'error',
      message: 'Informe o endereço fiscal completo da empresa (rua, bairro, n.º).',
    });
  }
  if (!hasMunicipality) {
    blockingIssues.push({
      section: 'endereco',
      field: 'municipality',
      severity: 'error',
      message: 'O Município do endereço fiscal é obrigatório para emissão fiscal e SAF-T (AO).',
    });
  }
  if (!hasProvince) {
    blockingIssues.push({
      section: 'endereco',
      field: 'province',
      severity: 'error',
      message: 'A Província do endereço fiscal é obrigatória para emissão fiscal e SAF-T (AO).',
    });
  }

  // 4. Contactos Institucionais
  const hasPhone = hasText(profile.phone);
  const hasEmail = hasText(profile.email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email.trim());
  fieldStatus.phone = hasPhone ? 'ok' : 'missing_required';
  fieldStatus.email = hasEmail ? 'ok' : hasText(profile.email) ? 'invalid' : 'missing_required';
  fieldStatus.mobile = hasText(profile.mobile) ? 'ok' : 'optional_empty';
  fieldStatus.whatsapp = hasText(profile.whatsapp) ? 'ok' : 'optional_empty';
  fieldStatus.billingEmail = hasText(profile.billingEmail) ? 'ok' : 'optional_empty';
  fieldStatus.website = hasText(profile.website) ? 'ok' : 'optional_empty';

  if (!hasPhone) {
    blockingIssues.push({
      section: 'contactos',
      field: 'phone',
      severity: 'error',
      message: 'O Telefone principal da empresa é obrigatório.',
    });
  }
  if (!hasEmail) {
    blockingIssues.push({
      section: 'contactos',
      field: 'email',
      severity: 'error',
      message: 'Informe um Email institucional válido para constar nos documentos e SAF-T.',
    });
  }

  // 5. Identidade Visual
  const logoValidation = validateLogoDataUrl(profile.logoUrl);
  fieldStatus.logoUrl = !logoValidation.valid
    ? 'invalid'
    : hasText(profile.logoUrl)
      ? 'ok'
      : 'optional_empty';
  if (!logoValidation.valid) {
    blockingIssues.push({
      section: 'identidade_visual',
      field: 'logoUrl',
      severity: 'error',
      message: logoValidation.error || 'Logótipo inválido.',
    });
  }

  // 6. Séries Documentais
  const activeSeries = (options?.series || []).filter(
    (s) => s.status === 'A' || s.status === 'U'
  );
  const hasActiveProductionSeries = activeSeries.some(
    (s) => (s.environment || 'SIMULACAO') === 'PRODUCAO'
  );
  const seriesChecked = Array.isArray(options?.series);
  fieldStatus.series = !seriesChecked
    ? 'optional_empty'
    : activeSeries.length > 0
      ? 'ok'
      : 'missing_required';

  if (seriesChecked && activeSeries.length === 0) {
    blockingIssues.push({
      section: 'series',
      field: 'series',
      severity: 'error',
      message: 'Nenhuma série documental activa encontrada para esta empresa.',
    });
  }
  if (
    seriesChecked &&
    (options?.requireProductionSeriesCheck || profile.agtEnvironment === 'PRODUCAO') &&
    !hasActiveProductionSeries
  ) {
    blockingIssues.push({
      section: 'series',
      field: 'series',
      severity: 'error',
      message:
        'O modo Produção exige pelo menos uma série autorizada de ambiente PRODUCAO (séries de simulação são bloqueadas em produção).',
    });
  }

  // 7. Dados Bancários
  const iban1Check = validateAngolaIban(profile.iban1);
  const iban2Check = validateAngolaIban(profile.iban2);
  fieldStatus.bankName1 = hasText(profile.bankName1) ? 'ok' : 'missing_conditional';
  fieldStatus.iban1 = !iban1Check.valid
    ? 'invalid'
    : hasText(profile.iban1)
      ? 'ok'
      : 'missing_conditional';
  fieldStatus.bankName2 = hasText(profile.bankName2) ? 'ok' : 'optional_empty';
  fieldStatus.iban2 = !iban2Check.valid
    ? 'invalid'
    : hasText(profile.iban2)
      ? 'ok'
      : 'optional_empty';

  if (!iban1Check.valid) {
    blockingIssues.push({
      section: 'bancos',
      field: 'iban1',
      severity: 'error',
      message: iban1Check.error || 'IBAN principal inválido.',
    });
  }
  if (!iban2Check.valid) {
    blockingIssues.push({
      section: 'bancos',
      field: 'iban2',
      severity: 'error',
      message: iban2Check.error || 'IBAN secundário inválido.',
    });
  }
  if (!hasText(profile.iban1)) {
    warnings.push({
      section: 'bancos',
      field: 'iban1',
      severity: 'warning',
      message: 'Sem IBAN configurado — facturas a prazo (FA/A4) não mostrarão coordenadas bancárias.',
    });
  }

  // 8. Estabelecimentos
  const establishments = Array.isArray(profile.establishments) ? profile.establishments : [];
  const activeEstablishments = establishments.filter((e) => e.active);
  fieldStatus.establishments = activeEstablishments.length > 0 ? 'ok' : 'missing_conditional';
  if (activeEstablishments.length === 0) {
    warnings.push({
      section: 'estabelecimentos',
      field: 'establishments',
      severity: 'warning',
      message: 'Nenhum estabelecimento formal cadastrado; será utilizado o estabelecimento matriz padrão (001).',
    });
  } else {
    for (const est of activeEstablishments) {
      const estCheck = validateEstablishmentRecord(est);
      if (!estCheck.valid) {
        blockingIssues.push({
          section: 'estabelecimentos',
          field: 'establishments',
          severity: 'error',
          message: `Estabelecimento '${est.name || est.code}': ${estCheck.errors.join(' ')}`,
        });
      }
    }
  }

  // 9. Representantes e Responsáveis
  fieldStatus.legalRepresentativeName = hasText(profile.legalRepresentativeName)
    ? 'ok'
    : 'optional_empty';
  fieldStatus.accountantName = hasText(profile.accountantName) ? 'ok' : 'optional_empty';
  fieldStatus.accountantOcpcaNumber = hasText(profile.accountantOcpcaNumber)
    ? 'ok'
    : 'optional_empty';

  // Agregação por secção
  const sectionKeys: MasterSectionId[] = [
    'identificacao',
    'fiscal',
    'endereco',
    'contactos',
    'identidade_visual',
    'series',
    'bancos',
    'estabelecimentos',
    'representantes',
  ];

  const sectionStatus = {} as Record<MasterSectionId, SectionCompletenessStatus>;
  let completedRequiredWeight = 0;
  let totalRequiredWeight = 0;

  for (const sec of sectionKeys) {
    const descriptors = COMPANY_MASTER_FIELD_REGISTRY.filter((d) => d.section === sec);
    const missingRequired: string[] = [];
    let completedCount = 0;

    for (const desc of descriptors) {
      const st = fieldStatus[desc.key] || 'optional_empty';
      if (st === 'ok') {
        completedCount += 1;
      } else if (desc.requirement === 'REQUIRED') {
        missingRequired.push(desc.label);
      }

      if (desc.requirement === 'REQUIRED') {
        totalRequiredWeight += 2;
        if (st === 'ok') completedRequiredWeight += 2;
      } else if (desc.requirement === 'CONDITIONAL') {
        totalRequiredWeight += 1;
        if (st === 'ok') completedRequiredWeight += 1;
      }
    }

    const secHasBlocking = blockingIssues.some((b) => b.section === sec);
    sectionStatus[sec] = {
      section: sec,
      label: MASTER_SECTION_LABELS[sec],
      completedCount,
      totalCount: descriptors.length,
      missingRequired,
      ready: !secHasBlocking && missingRequired.length === 0,
    };
  }

  const completionPct =
    totalRequiredWeight > 0
      ? Math.min(100, Math.round((completedRequiredWeight / totalRequiredWeight) * 100))
      : 0;

  const readyForSimulation =
    hasLegalName &&
    hasShortName &&
    nifCheck.valid &&
    logoValidation.valid &&
    iban1Check.valid &&
    iban2Check.valid;

  const readyForProductionEmission =
    readyForSimulation &&
    blockingIssues.length === 0 &&
    hasTaxOffice;

  return {
    completionPct,
    readyForSimulation,
    readyForProductionEmission,
    blockingIssues,
    warnings,
    sectionStatus,
    fieldStatus,
  };
}
