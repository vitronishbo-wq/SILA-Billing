import type { AgtIvaExemptionCode, AgtIvaTaxCode, AgtSeriesEnvironment } from './fiscalTypes.ts';

export type TaxRate = 0 | 1 | 5 | 7 | 14;
export type DirectPaymentMethod = 'Dinheiro' | 'Multicaixa' | 'Transferência';
export type PaymentMethod = DirectPaymentMethod | 'Crédito' | 'Combinado';
export type DocumentType = 'FR' | 'FA' | 'FP' | 'NC' | 'ND' | 'RC' | 'FT' | 'CS';
export type DocumentFormat = 'POS' | 'A4';
export type InvoiceStatus = 'issued' | 'cancelled';

export type AngolaTaxRegime = 'GERAL' | 'SIMPLIFICADO' | 'EXCLUSAO';
export type AngolaLegalNature = 'LDA' | 'SU_LDA' | 'SA' | 'ENI' | 'COOP' | 'OUTRA';
export type AgtOperationEnvironment = 'SIMULACAO' | 'PRODUCAO';
export type AngolaTaxTerritory = 'AO' | 'AO-CAB';

export interface PaymentSplit {
  method: DirectPaymentMethod;
  amount: number;
  reference?: string;
}

export type PlanTier = 'FREE' | 'ESSENCIAL' | 'PROFISSIONAL' | 'ENTERPRISE';
export type CompanyOperationalStatus = 'active' | 'suspended' | 'pending';
export type CompanyRole =
  | 'owner'
  | 'admin'
  | 'manager'
  | 'cashier'
  | 'accountant'
  | 'warehouse'
  | 'seller';
export type SyncState = 'synced' | 'pending' | 'error' | 'conflict';

export type MemberStatus = 'pending_invite' | 'active' | 'suspended';

export type PermissionKey =
  | 'pos_sell'
  | 'a4_sell'
  | 'pos_discount_special'
  | 'pos_price_edit'
  | 'invoice_cancel'
  | 'credit_note_issue'
  | 'customers_view'
  | 'customers_create'
  | 'customers_manage'
  | 'products_view'
  | 'products_manage'
  | 'cost_prices_view'
  | 'stock_view'
  | 'stock_manage'
  | 'purchases_view'
  | 'purchases_manage'
  | 'suppliers_view'
  | 'suppliers_manage'
  | 'expenses_manage'
  | 'finance_view'
  | 'profits_margins_view'
  | 'cash_own_shift'
  | 'cash_all_shifts'
  | 'reports_own_sales'
  | 'reports_operational'
  | 'reports_financial'
  | 'master_view'
  | 'master_edit'
  | 'series_view'
  | 'series_manage'
  | 'saft_export'
  | 'audit_view'
  | 'users_view'
  | 'users_manage'
  | 'roles_manage'
  | 'settings_manage'
  | 'backup_export';

export const PLATFORM_ADMIN_EMAIL = 'wtmedia0@gmail.com';
export const JAIMONA_COMPANY_ID = 'comp_jaimona';
export const JAIMONA_OWNER_EMAIL = 'jaimonacomercioeservicos@gmail.com';

export const VITRONIS_INSTITUTIONAL = {
  legalName: 'VITRONIS – ROBÓTICA E CONTROLE - SERVIÇOS, LDA',
  shortName: 'VITRONIS',
  address: 'Huambo, Município de Huambo, Comuna de Huambo, Cidade-Alta',
  city: 'Huambo',
  phone: '(244) 948 323 383',
  whatsappDigits: '244948323383',
  website: 'www.vitronis.co.ao',
  websiteUrl: 'https://www.vitronis.co.ao',
  email: 'inf@vitronis.co.ao',
  nif: '5002571293',
  ibanBai: 'AO06.0040.0000.1219.5634.1015.0',
  termsVersion: '2026.1-VITRONIS',
} as const;

export const FREE_MONTHLY_INVOICE_LIMIT = 40;
export const FREE_SOFT_NOTICE_THRESHOLD = 36;
export const FREE_COURTESY_BUFFER = 10;
export const CLOUD_PROTECTION_NUDGE_INVOICES = 60;
export const CLOUD_PROTECTION_NUDGE_RECORDS = 120;

export type GrowthTriggerReason =
  | 'monthly_limit'
  | 'cloud_protection'
  | 'clean_footer'
  | 'team_access';

export interface EstablishmentRecord {
  id: string;
  code: string; // Ex: '001', 'MATRIZ', 'FILIAL_01'
  name: string;
  isHeadquarters: boolean;
  address: string;
  municipality?: string;
  province?: string;
  phone?: string;
  email?: string;
  defaultCashierCode?: string;
  defaultWarehouseId?: string;
  active: boolean;
}

export interface WarehouseRecord {
  id: string;
  code: string;
  name: string;
  establishmentId: string;
  address?: string;
  active: boolean;
}

export interface InvoiceIssuerSnapshot {
  companyId: string;
  legalName: string;
  shortName: string;
  nif: string;
  taxRegime: AngolaTaxRegime;
  taxOffice?: string;
  commercialRegistry?: string;
  shareCapital?: string;
  cae?: string;
  address: string;
  municipality?: string;
  province?: string;
  cityCountry: string;
  postalCode?: string;
  phone: string;
  mobile?: string;
  whatsapp?: string;
  email: string;
  billingEmail?: string;
  website?: string;
  tagline: string;
  logoUrl?: string;
  showLogoOnPos?: boolean;
  showLogoOnA4?: boolean;
  bankName1?: string;
  iban1?: string;
  accountHolder1?: string;
  swift1?: string;
  bankName2?: string;
  iban2?: string;
  accountHolder2?: string;
  swift2?: string;
  multicaixaExpressPhone?: string;
  establishmentId?: string;
  establishmentCode?: string;
  establishmentName?: string;
  establishmentAddress?: string;
  establishmentMunicipality?: string;
  establishmentProvince?: string;
  legalRepresentativeName?: string;
  legalRepresentativeRole?: string;
  capturedAtIso: string;
}

export interface CompanyProfile {
  // 1. Identificação Jurídica e Comercial
  legalName: string;
  shortName: string;
  legalNature?: AngolaLegalNature;
  cae?: string;
  commercialRegistry?: string;
  shareCapital?: string;
  tagline: string;
  // 2. Identificação e Enquadramento Fiscal Angolano
  nif: string;
  taxRegime?: AngolaTaxRegime;
  taxOffice?: string;
  taxEntity?: string;
  defaultExemptionCode?: AgtIvaExemptionCode;
  isVatRetentionAgent?: boolean;
  defaultWithholdingTax?: number;
  specialTaxTerritory?: AngolaTaxTerritory;
  agtEnvironment?: AgtOperationEnvironment;
  activityStartDate?: string;
  // 3. Endereço Fiscal e Comercial
  address: string;
  municipality?: string;
  province?: string;
  cityCountry: string;
  postalCode?: string;
  country?: string;
  // 4. Contactos Institucionais
  phone: string;
  mobile?: string;
  whatsapp?: string;
  email: string;
  billingEmail?: string;
  website?: string;
  // 5. Identidade Visual
  logoUrl?: string;
  showLogoOnPos?: boolean;
  showLogoOnA4?: boolean;
  // 6. Dados Bancários e Meios de Pagamento
  bankName1?: string;
  iban1?: string;
  accountHolder1?: string;
  swift1?: string;
  bankName2?: string;
  iban2?: string;
  accountHolder2?: string;
  swift2?: string;
  multicaixaExpressPhone?: string;
  defaultPaymentTermsDays?: number;
  // 7. Estabelecimentos, Caixas e Armazéns
  establishments?: EstablishmentRecord[];
  warehouses?: WarehouseRecord[];
  defaultEstablishmentId?: string;
  // 8. Representantes e Responsáveis
  legalRepresentativeName?: string;
  legalRepresentativeRole?: string;
  legalRepresentativeNif?: string;
  legalRepresentativePhone?: string;
  accountantName?: string;
  accountantOcpcaNumber?: string;
  accountantEmail?: string;
  accountantPhone?: string;
}

export const NEUTRAL_PLATFORM_PROFILE: CompanyProfile = {
  legalName: 'SILA-Billing — Selecionar ou Cadastrar Empresa',
  shortName: 'Nova Empresa',
  nif: '---',
  address: 'Angola',
  cityCountry: 'Luanda - Angola',
  country: 'AO',
  phone: '',
  email: '',
  tagline: 'Obrigado pela preferência',
  taxRegime: 'GERAL',
  agtEnvironment: 'SIMULACAO',
};

export const JAIMONA_COMPANY: CompanyProfile = {
  legalName: 'JAIMONA-COMÉRCIO E SERVIÇOS, (SU) LDA',
  shortName: 'JAIMONA',
  legalNature: 'SU_LDA',
  nif: '5003069940',
  taxRegime: 'GERAL',
  address: 'Rua Fapla, Bairro Verde A – Saurimo',
  municipality: 'Saurimo',
  province: 'Lunda Sul',
  cityCountry: 'Saurimo - Angola',
  country: 'AO',
  phone: '(+244) 943671515',
  email: JAIMONA_OWNER_EMAIL,
  tagline: 'Servimos com Qualidade',
  agtEnvironment: 'SIMULACAO',
};

export function resolveEstablishmentLocality(
  profile: Pick<CompanyProfile, 'municipality' | 'province' | 'cityCountry' | 'country'>,
  est?: Pick<EstablishmentRecord, 'municipality' | 'province'> | null
): string {
  const mun = String(est?.municipality || profile.municipality || '').trim();
  const prov = String(est?.province || profile.province || '').trim();
  const countryLabel =
    !profile.country || profile.country.toUpperCase() === 'AO'
      ? 'Angola'
      : profile.country.toUpperCase();

  if (mun && prov) {
    return mun.toLowerCase() === prov.toLowerCase()
      ? `${mun} - ${countryLabel}`
      : `${mun}, ${prov} - ${countryLabel}`;
  }
  if (mun) return `${mun} - ${countryLabel}`;
  if (prov) return `${prov} - ${countryLabel}`;
  const fallback = String(profile.cityCountry || '').trim();
  return fallback || countryLabel;
}

export function createDefaultEstablishmentForCompany(
  profile: Pick<CompanyProfile, 'address' | 'municipality' | 'province' | 'cityCountry' | 'phone' | 'email' | 'shortName'>,
  establishmentId = 'est_matriz'
): EstablishmentRecord {
  const fallbackCity = profile.cityCountry
    ? profile.cityCountry.split('-')[0]!.split(',')[0]!.trim()
    : '';
  const mun = String(profile.municipality || fallbackCity || 'Luanda').trim();
  const prov = String(profile.province || mun).trim();
  return {
    id: establishmentId,
    code: '001',
    name: 'Sede / Loja Principal',
    isHeadquarters: true,
    address: profile.address || 'Angola',
    municipality: mun,
    province: prov,
    phone: profile.phone || '',
    email: profile.email || '',
    defaultCashierCode: '01',
    defaultWarehouseId: 'armazem_principal',
    active: true,
  };
}

export function buildInvoiceIssuerSnapshot(
  profile: CompanyProfile,
  options?: {
    companyId?: string;
    establishment?: EstablishmentRecord | null;
    capturedAtIso?: string;
  }
): InvoiceIssuerSnapshot {
  const est =
    options?.establishment ||
    profile.establishments?.find((e) => e.id === profile.defaultEstablishmentId) ||
    profile.establishments?.find((e) => e.isHeadquarters && e.active) ||
    profile.establishments?.find((e) => e.active) ||
    createDefaultEstablishmentForCompany(profile);

  return {
    companyId: options?.companyId || '',
    legalName: profile.legalName,
    shortName: profile.shortName,
    nif: profile.nif,
    taxRegime: profile.taxRegime || 'GERAL',
    taxOffice: profile.taxOffice,
    commercialRegistry: profile.commercialRegistry,
    shareCapital: profile.shareCapital,
    cae: profile.cae,
    address: profile.address,
    municipality: profile.municipality,
    province: profile.province,
    cityCountry: profile.cityCountry,
    postalCode: profile.postalCode,
    phone: profile.phone,
    mobile: profile.mobile,
    whatsapp: profile.whatsapp,
    email: profile.email,
    billingEmail: profile.billingEmail,
    website: profile.website,
    tagline: profile.tagline,
    logoUrl: profile.logoUrl,
    showLogoOnPos: profile.showLogoOnPos,
    showLogoOnA4: profile.showLogoOnA4,
    bankName1: profile.bankName1,
    iban1: profile.iban1,
    accountHolder1: profile.accountHolder1,
    swift1: profile.swift1,
    bankName2: profile.bankName2,
    iban2: profile.iban2,
    accountHolder2: profile.accountHolder2,
    swift2: profile.swift2,
    multicaixaExpressPhone: profile.multicaixaExpressPhone,
    establishmentId: est.id,
    establishmentCode: est.code,
    establishmentName: est.name,
    establishmentAddress: est.address,
    ...(est.municipality || profile.municipality
      ? { establishmentMunicipality: (est.municipality || profile.municipality || '').trim() }
      : {}),
    ...(est.province || profile.province
      ? { establishmentProvince: (est.province || profile.province || '').trim() }
      : {}),
    legalRepresentativeName: profile.legalRepresentativeName,
    legalRepresentativeRole: profile.legalRepresentativeRole,
    capturedAtIso: options?.capturedAtIso || new Date().toISOString(),
  };
}

export function formatDocumentTypeLabelPt(docType: DocumentType | string): string {
  switch (String(docType || '').toUpperCase()) {
    case 'FR':
      return 'Factura / Recibo';
    case 'FA':
      return 'Factura';
    case 'FP':
      return 'Factura Proforma';
    case 'NC':
      return 'Nota de Crédito';
    case 'ND':
      return 'Nota de Débito';
    case 'RC':
      return 'Recibo';
    case 'FT':
      return 'Factura de Transporte / Guia';
    case 'CS':
      return 'Comprovativo de Saída';
    default:
      return 'Factura / Recibo';
  }
}

export function resolveCompanyProfileFromSnapshot(
  invoice?: Pick<InvoiceRecord, 'issuerSnapshot'> | null,
  fallbackCompany: CompanyProfile = NEUTRAL_PLATFORM_PROFILE
): CompanyProfile {
  const snap = invoice?.issuerSnapshot;
  if (!snap || !snap.legalName || !snap.nif) {
    return fallbackCompany;
  }

  return {
    ...fallbackCompany,
    legalName: snap.legalName,
    shortName: snap.shortName || snap.legalName,
    nif: snap.nif,
    taxRegime: snap.taxRegime || fallbackCompany.taxRegime || 'GERAL',
    taxOffice: snap.taxOffice,
    commercialRegistry: snap.commercialRegistry,
    shareCapital: snap.shareCapital,
    cae: snap.cae,
    address: snap.address,
    municipality: snap.establishmentMunicipality || snap.municipality,
    province: snap.establishmentProvince || snap.province,
    cityCountry:
      snap.establishmentMunicipality || snap.establishmentProvince
        ? resolveEstablishmentLocality(
            {
              municipality: snap.establishmentMunicipality || snap.municipality,
              province: snap.establishmentProvince || snap.province,
              cityCountry: snap.cityCountry || fallbackCompany.cityCountry,
              country: fallbackCompany.country || 'AO',
            },
            {
              municipality: snap.establishmentMunicipality,
              province: snap.establishmentProvince,
            }
          )
        : snap.cityCountry || fallbackCompany.cityCountry,
    postalCode: snap.postalCode,
    phone: snap.phone,
    mobile: snap.mobile,
    whatsapp: snap.whatsapp,
    email: snap.email,
    billingEmail: snap.billingEmail,
    website: snap.website,
    tagline: snap.tagline,
    logoUrl: snap.logoUrl,
    showLogoOnPos: snap.showLogoOnPos,
    showLogoOnA4: snap.showLogoOnA4,
    bankName1: snap.bankName1,
    iban1: snap.iban1,
    accountHolder1: snap.accountHolder1,
    swift1: snap.swift1,
    bankName2: snap.bankName2,
    iban2: snap.iban2,
    accountHolder2: snap.accountHolder2,
    swift2: snap.swift2,
    multicaixaExpressPhone: snap.multicaixaExpressPhone,
    legalRepresentativeName: snap.legalRepresentativeName,
    legalRepresentativeRole: snap.legalRepresentativeRole,
  };
}

export function isPlatformAdminEmail(email?: string | null): boolean {
  return String(email || '').trim().toLowerCase() === PLATFORM_ADMIN_EMAIL;
}

export function isJaimonaOwnerEmail(email?: string | null): boolean {
  return String(email || '').trim().toLowerCase() === JAIMONA_OWNER_EMAIL;
}

/**
 * Normaliza o NIF fiscal removendo espaços, pontos, traços ou barras
 * para garantir unicidade estrita: 1 NIF = 1 Empresa em todo o sistema.
 */
export function normalizeCompanyNif(raw: string): string {
  return String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/[\s.\-/]+/g, '');
}

/**
 * Valida se o NIF empresarial é elegível para registo de empresa emissora.
 */
export function validateCompanyNif(raw: string): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  const normalized = normalizeCompanyNif(raw);
  if (!normalized) {
    return { valid: false, normalized, error: 'O NIF da empresa é obrigatório.' };
  }
  if (
    normalized === 'CONSUMIDORFINAL' ||
    normalized === '999999999' ||
    normalized === '000000000'
  ) {
    return {
      valid: false,
      normalized,
      error: 'Informe um NIF empresarial válido (não pode ser Consumidor Final).',
    };
  }
  if (!/^[A-Z0-9]{6,20}$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Formato de NIF inválido. Utilize entre 6 e 20 caracteres alfanuméricos.',
    };
  }
  return { valid: true, normalized };
}

/**
 * Gera iniciais dinâmicas para o selo documental A4 preservando "JM" na JAIMONA.
 */
export function deriveCompanyInitials(
  company: Pick<CompanyProfile, 'shortName' | 'legalName' | 'nif'>
): string {
  if (
    normalizeCompanyNif(company.nif) === '5003069940' &&
    company.shortName.trim().toUpperCase() === 'JAIMONA'
  ) {
    return 'JM';
  }
  const source = (company.shortName || company.legalName || 'SB').trim().toUpperCase();
  const words = source.split(/[\s\-.,/()]+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]![0] || ''}${words[1]![0] || ''}`.slice(0, 2);
  }
  const clean = source.replace(/[^A-Z0-9]/g, '');
  return clean.slice(0, 2) || 'SB';
}

/**
 * Devolve o ID do cliente "Consumidor Final" isolado por empresa,
 * mantendo 'cust_direct' intacto para a empresa predefinida JAIMONA.
 */
export function getDirectCustomerIdForCompany(companyId: string): string {
  return companyId === JAIMONA_COMPANY_ID ? 'cust_direct' : `cust_direct_${companyId}`;
}

export interface CompanyPlanMetadata {
  planTier: PlanTier;
  commercialActive: boolean;
  maxUsers: number | null;
  maxInvoicesPerMonth: number | null;
  updatedAtIso: string;
}

export interface CompanyRecord {
  id: string;
  normalizedNif: string; // Único no sistema: 1 NIF = 1 Empresa
  profile: CompanyProfile;
  status: CompanyOperationalStatus;
  plan: CompanyPlanMetadata;
  baseSequence: number; // 15678 na JAIMONA, 0 nas novas empresas
  allowManagerCancel: boolean;
  ownerUid?: string;
  ownerEmail?: string;
  termsAcceptedVersion?: string;
  termsAcceptedAtIso?: string;
  courtesyMonthKey?: string;
  maxObservedIso?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export function hasPaidCommercialEntitlement(
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  if (company.id === JAIMONA_COMPANY_ID) return true;
  return company.plan?.planTier !== 'FREE';
}

export function canCompanySyncCloudData(
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  if (company.id === JAIMONA_COMPANY_ID) return true;
  const tier = company.plan?.planTier;
  return tier === 'PROFISSIONAL' || tier === 'ENTERPRISE';
}

export function canCompanyManageMultiOperatorTeam(
  _company?: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  // Decisão 1: Utilizadores, funções, PINs, permissões e auditoria local disponíveis em TODOS os planos.
  return true;
}

export function canCompanyInviteCloudMembers(
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  return canCompanySyncCloudData(company);
}

export function canCompanyHideViralFooter(
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  return hasPaidCommercialEntitlement(company);
}

export interface CompanyRoleDefinition {
  id: string;
  companyId: string;
  name: string;
  description?: string;
  baseRole: CompanyRole;
  isSystem: boolean;
  permissions: Partial<Record<PermissionKey, boolean>>;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface MemberPermissionOverrides {
  grant: PermissionKey[];
  revoke: PermissionKey[];
}

export interface CompanyMember {
  id: string; // `${companyId}_${uid}`
  companyId: string;
  uid: string;
  email: string;
  emailLower?: string;
  phone?: string;
  displayName: string;
  role: CompanyRole;
  roleId?: string;
  establishmentIds?: string[]; // Vazio = acesso a todos os estabelecimentos da empresa
  authorizedCashiers?: string[]; // Vazio = qualquer caixa
  permissionOverrides?: MemberPermissionOverrides;
  status?: MemberStatus;
  allowInvoiceCancel: boolean;
  active: boolean;
  pinHash?: string; // pbkdf2_sha256$<iterations>$<saltHex>$<hashHex>
  pinUpdatedAtIso?: string;
  pinFailedAttempts?: number;
  pinLockedUntilIso?: string;
  invitedByUid?: string;
  claimedAtIso?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface CompanyInviteRecord {
  id: string;
  companyId: string;
  companyShortName: string;
  memberId: string;
  emailLower: string;
  displayName: string;
  role: CompanyRole;
  roleId: string;
  establishmentIds: string[];
  authorizedCashiers: string[];
  status: 'pending' | 'accepted' | 'revoked';
  createdByUid: string;
  acceptedByUid?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export type SecurityAuditAction =
  | 'LOGIN'
  | 'LOGOUT'
  | 'PIN_SETUP'
  | 'PIN_UNLOCK_OK'
  | 'PIN_UNLOCK_FAIL'
  | 'PIN_LOCKOUT'
  | 'TERMINAL_LOCK'
  | 'OPERATOR_SWITCH'
  | 'ACCESS_DENIED'
  | 'INVOICE_EMIT'
  | 'INVOICE_CANCEL'
  | 'PRICE_EDIT'
  | 'DISCOUNT_OVERRIDE'
  | 'USER_CREATE'
  | 'USER_UPDATE'
  | 'USER_SUSPEND'
  | 'ROLE_UPDATE'
  | 'INVITE_CLAIM'
  | 'PRIVACY_ACCEPTED'
  | 'SYNC_CONFLICT_RESOLVED';

export interface SecurityAuditEntry {
  id: string;
  companyId: string;
  establishmentId?: string;
  actorUid: string;
  actorEmail?: string;
  actorName: string;
  actorRole: string;
  action: SecurityAuditAction;
  targetType: string;
  targetId?: string;
  summary: string;
  beforeJson?: string;
  afterJson?: string;
  outcome: 'allowed' | 'denied';
  createdAtIso: string;
  synced?: boolean;
}

export interface SyncQueueEntry {
  id: string;
  companyId: string;
  entityType:
    | 'company'
    | 'product'
    | 'customer'
    | 'invoice'
    | 'settings'
    | 'cash_session'
    | 'cash_movement'
    | 'stock_movement'
    | 'supplier'
    | 'purchase'
    | 'fiscal_series'
    | 'role'
    | 'audit_log';
  entityId: string;
  entityLabel?: string;
  operation: 'upsert' | 'delete' | 'cancel';
  status: SyncState;
  retryCount?: number;
  lastAttemptIso?: string;
  nextRetryAfterIso?: string;
  clientOperationId?: string;
  deviceId?: string;
  baselineFingerprint?: string;
  errorMessage?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export type SyncConflictType =
  | 'FISCAL_NUMBER_COLLISION'
  | 'INVOICE_STATE_CONFLICT'
  | 'PRODUCT_CONFLICT'
  | 'CUSTOMER_CONFLICT'
  | 'SUPPLIER_CONFLICT'
  | 'SETTINGS_CONFLICT'
  | 'CASH_SESSION_CONFLICT'
  | 'HASH_CHAIN_FORK';

export type SyncConflictResolutionChoice =
  | 'KEEP_LOCAL'
  | 'USE_CLOUD'
  | 'REASSIGN_LOCAL_SERIES_NUMBER'
  | 'ACKNOWLEDGE_AUDIT';

export interface SyncConflictRecord {
  id: string;
  companyId: string;
  type: SyncConflictType;
  entityType: SyncQueueEntry['entityType'];
  entityId: string;
  entityLabel: string;
  summary: string;
  details: string;
  localSummary: string;
  cloudSummary: string;
  localSnapshotJson?: string;
  cloudSnapshotJson?: string;
  recommendedAction: SyncConflictResolutionChoice;
  status: 'open' | 'resolved';
  resolutionChoice?: SyncConflictResolutionChoice;
  resolvedBy?: string;
  resolvedAtIso?: string;
  createdAtIso: string;
  updatedAtIso: string;
}

export type SyncBaselineMap = Record<string, string>;

export interface CommittedCheckoutOpRecord {
  operationId: string;
  invoiceId: string;
  invoiceNumber: string;
  cartFingerprint: string;
  grandTotal: number;
  committedAtIso: string;
}

export interface AppSettings {
  companyId?: string;
  company: CompanyProfile;
  defaultCashier: string;
  defaultOperator: string;
  defaultFormat: DocumentFormat;
  defaultDocType: DocumentType;
  defaultNotes: string;
  autoPrintOnEmit: boolean;
  defaultEstablishmentId?: string;
  agtEnvironment?: AgtOperationEnvironment;
  hidePromotionalFooter?: boolean;
  allowCashierPriceEdit?: boolean;
  maxCashierDiscountPct?: number; // Limite máx. de desconto permitido a operador de caixa sem supervisor (ex: 5%)
  supervisorPin?: string; // Legado: migrado para pinHash individual por colaborador
  inactivityLockMinutes?: number; // Bloqueio automático por inactividade (padrão: 10 min)
  privacyPolicyAcceptedVersion?: string;
  privacyPolicyAcceptedAtIso?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  updatedAtIso: string;
}

export function shouldShowViralDocumentFooter(
  company: Pick<CompanyRecord, 'id' | 'plan'>,
  settings?: Pick<AppSettings, 'hidePromotionalFooter'> | null
): boolean {
  if (!canCompanyHideViralFooter(company)) {
    return true;
  }
  if (typeof settings?.hidePromotionalFooter === 'boolean') {
    return !settings.hidePromotionalFooter;
  }
  return false;
}

export const DEFAULT_SETTINGS: AppSettings = {
  companyId: '',
  company: NEUTRAL_PLATFORM_PROFILE,
  defaultCashier: '01',
  defaultOperator: '001',
  defaultFormat: 'POS',
  defaultDocType: 'FR',
  defaultNotes: 'Venda directa a retalho.',
  autoPrintOnEmit: false,
  hidePromotionalFooter: false,
  allowCashierPriceEdit: false,
  maxCashierDiscountPct: 5,
  supervisorPin: '',
  syncState: 'pending',
  synced: false,
  updatedAtIso: new Date().toISOString(),
};

export const DEFAULT_PRODUCT_CATEGORIES = [
  'Bebidas',
  'Mercearia',
  'Padaria',
  'Cafetaria',
  'Serviços',
  'Geral',
] as const;

export const DEFAULT_PRODUCT_UNITS = [
  'un',
  'kg',
  'g',
  'lt',
  'ml',
  'cx',
  'pct',
  'dz',
  'm',
  'm²',
  'hr',
  'serv',
  'mês',
] as const;

export const DEFAULT_IVA_EXEMPTION_REASONS = [
  'Isento nos termos da Lei do IVA (Cesta Básica)',
  'Regime de Exclusão do IVA (Art.º 16.º do CIVA)',
  'Isento ao abrigo do Art.º 12.º do CIVA',
  'Não sujeito a IVA nos termos da legislação em vigor',
] as const;

export interface ProductPriceChange {
  changedAtIso: string;
  previousPrice: number;
  newPrice: number;
  previousCost?: number;
  newCost?: number;
  changedBy: string;
}

export type ProductType = 'P' | 'S' | 'K'; // P = Produto/Mercadoria, S = Serviço, K = Kit/Composto

export interface Product {
  id: string;
  companyId?: string;
  code: string; // Código interno / SKU
  barcode?: string; // Código de barras EAN / UPC / QR comercial
  name: string;
  productType?: ProductType;
  category: string;
  unit: string;
  costPrice?: number; // Preço de aquisição em Kwanzas (Kz)
  price: number; // Preço unitário de venda em Kwanzas (Kz)
  ivaRate: TaxRate;
  exemptionCode?: AgtIvaExemptionCode;
  exemptionReason: string;
  active: boolean;
  trackStock?: boolean;
  stockQty?: number;
  minStockQty?: number;
  priceHistory?: ProductPriceChange[]; // Últimas 20 alterações de preço auditadas
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export type CustomerType = 'CONSUMIDOR_FINAL' | 'PARTICULAR' | 'EMPRESA' | 'ESTRANGEIRO';

export type CustomerPaymentTerms =
  | 'IMEDIATO'
  | '15_DIAS'
  | '30_DIAS'
  | '45_DIAS'
  | '60_DIAS'
  | 'PERSONALIZADO';

export interface CustomerChangeLogEntry {
  changedAtIso: string;
  changedBy: string;
  summary: string;
}

export interface Customer {
  id: string;
  companyId?: string;
  internalCode?: string; // Código interno único gerado automaticamente por empresa (ex: CLI-0001)
  customerType?: CustomerType;
  active?: boolean;
  // Dados fiscais
  name: string;
  nif: string;
  normalizedNif?: string;
  countryCode?: string; // ISO-3166-1 alpha-2 ('AO' padrão ou código estrangeiro)
  foreignTaxId?: string; // Identificação fiscal estrangeira (quando customerType === 'ESTRANGEIRO')
  province?: string;
  municipality?: string;
  locality: string;
  address: string;
  // Contactos & dados comerciais (separados da identificação fiscal documental)
  phone: string;
  email?: string;
  creditLimit?: number;
  paymentTerms?: CustomerPaymentTerms;
  hasCreditAccount?: boolean;
  notes?: string;
  // Campos avançados (recolhíveis na UI)
  bankName?: string;
  bankIban?: string;
  documentRef?: string;
  representativeName?: string;
  representativePhone?: string;
  specialCreditNotes?: string;
  // Histórico de alterações (não altera documentos emitidos)
  changeHistory?: CustomerChangeLogEntry[];
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface CartDraftItem {
  productId: string;
  code: string;
  description: string;
  unit: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  ivaRate: TaxRate;
  exemptionCode?: AgtIvaExemptionCode;
  exemptionReason?: string;
}

export interface CalculatedLineItem extends CartDraftItem {
  id: string;
  lineGross: number; // qty * unitPrice
  lineDiscount: number;
  lineNet: number; // lineGross - lineDiscount (Total c/ IVA)
  lineBase: number; // Base tributável s/ IVA
  lineTax: number; // Valor do IVA
  lineTotal: number; // Valor final da linha
}

export interface TaxBreakdownItem {
  taxCode: AgtIvaTaxCode;
  rate: TaxRate;
  base: number;
  amount: number;
}

export interface InvoiceTotals {
  lines: CalculatedLineItem[];
  merchandiseTotal: number;
  grossItemsTotal: number;
  lineDiscountTotal: number;
  globalDiscountPct: number;
  globalDiscountAmount: number;
  discountTotal: number;
  taxBase14: number;
  taxAmount14: number;
  taxBaseIntermediate?: number; // 7% ou 1% Cabinda (INT)
  taxAmountIntermediate?: number;
  taxBaseReduced?: number; // 5% (RED)
  taxAmountReduced?: number;
  taxBase0: number;
  taxAmount0: number;
  taxBreakdown?: TaxBreakdownItem[];
  taxTotal: number;
  grandTotal: number;
  amountInWords: string;
}

export interface InvoiceRecord {
  id: string;
  companyId?: string;
  number: string;
  docType: DocumentType;
  issuedAtIso: string;
  cashier: string;
  operator: string;
  paymentMethod: PaymentMethod;
  customerId: string;
  customerName: string;
  customerNif: string;
  customerLocality: string;
  customerType?: CustomerType;
  customerCountryCode?: string;
  customerAddress?: string;
  customerPhone?: string;
  customerEmail?: string;
  merchandiseTotal: number;
  discountTotal: number;
  globalDiscountPct?: number;
  globalDiscountAmount?: number;
  taxBase14: number;
  taxAmount14: number;
  taxBaseIntermediate?: number;
  taxAmountIntermediate?: number;
  taxBaseReduced?: number;
  taxAmountReduced?: number;
  taxBase0: number;
  taxAmount0: number;
  taxTotal: number;
  grandTotal: number;
  amountInWords: string;
  issuerSnapshot?: InvoiceIssuerSnapshot;
  establishmentId?: string;
  establishmentCode?: string;
  establishmentName?: string;
  seriesCode?: string;
  seriesEnvironment?: AgtSeriesEnvironment;
  agtAuthorizationCode?: string;
  atcud?: string;
  saftHash4?: string;
  saftHashFull?: string;
  previousInvoiceHash?: string;
  sessionId?: string;
  amountReceived: number;
  initialAmountReceived?: number;
  changeAmount: number;
  initialChangeAmount?: number;
  amountDue?: number;
  transferReference?: string;
  paymentSplits?: PaymentSplit[];
  paymentSummary?: string;
  returnOriginInvoiceId?: string;
  returnOriginNumber?: string;
  returnCreditApplied?: number;
  notes: string;
  status: InvoiceStatus;
  cancelReason?: string;
  cancelledBy?: string;
  cancelledAtIso?: string;
  discountAuthorizedBy?: string;
  reprintCount?: number;
  lastReprintedAtIso?: string;
  lastReprintedBy?: string;
  lines: CalculatedLineItem[];
  clientOperationId?: string;
  terminalDeviceId?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface SuspendedSale {
  id: string;
  companyId: string;
  label: string;
  customerId: string;
  customerName: string;
  docType: DocumentType;
  paymentMethod: PaymentMethod;
  cart: CartDraftItem[];
  globalDiscountPct: number;
  notes: string;
  suspendedAtIso: string;
}

export type CashMovementType =
  | 'REFORCO'
  | 'SANGRIA'
  | 'ENTRADA'
  | 'SAIDA'
  | 'LIQUIDACAO_DIVIDA';

export type FinancialEntryKind =
  | 'DESPESA_OPERACIONAL'
  | 'RECEITA_EXTRAORDINARIA'
  | 'PAGAMENTO_FORNECEDOR'
  | 'MOVIMENTO_CAIXA';

export const DEFAULT_EXPENSE_CATEGORIES = [
  'Renda e Instalações',
  'Energia, Água e Telecom',
  'Salários e Pessoal',
  'Transporte e Combustível',
  'Impostos e Taxas',
  'Manutenção e Material',
  'Outras Despesas Operacionais',
] as const;

export const DEFAULT_EXTRA_REVENUE_CATEGORIES = [
  'Prestação Eventual de Serviços',
  'Comissões e Intermediação',
  'Aluguer / Cedência de Espaço',
  'Recuperação / Reembolso',
  'Rendimentos e Outras Receitas',
] as const;

export type CashSessionStatus = 'open' | 'closed';

export interface CashMovement {
  id: string;
  companyId: string;
  sessionId: string;
  cashier: string;
  operator: string;
  type: CashMovementType;
  entryKind?: FinancialEntryKind;
  category?: string;
  amount: number;
  paymentMethod: DirectPaymentMethod;
  reason: string;
  reference?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  customerName?: string;
  purchaseId?: string;
  createdByUid?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
}

export interface CashSession {
  id: string;
  companyId: string;
  cashier: string;
  operator: string;
  openedByUid?: string;
  closedByOperator?: string;
  closedByUid?: string;
  status: CashSessionStatus;
  openingFloat: number;
  openingNotes?: string;
  openedAtIso: string;
  closedAtIso?: string;
  expectedCash?: number;
  countedCash?: number;
  differenceAmount?: number;
  salesCash?: number;
  salesMulticaixa?: number;
  salesTransfer?: number;
  salesCredit?: number;
  debtCash?: number;
  debtMulticaixa?: number;
  debtTransfer?: number;
  reforcosTotal?: number;
  entradasTotal?: number;
  sangriasTotal?: number;
  saidasTotal?: number;
  invoiceCount?: number;
  closingNotes?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface CashSessionSummary {
  openingFloat: number;
  salesCash: number;
  salesMulticaixa: number;
  salesTransfer: number;
  salesCredit: number;
  debtCash: number;
  debtMulticaixa: number;
  debtTransfer: number;
  totalByMethod: {
    Dinheiro: number;
    Multicaixa: number;
    Transferência: number;
    Crédito: number;
  };
  totalReceivedAllMethods: number;
  reforcosTotal: number;
  entradasTotal: number;
  sangriasTotal: number;
  saidasTotal: number;
  expectedCash: number;
  countedCash: number | null;
  differenceAmount: number | null;
  invoiceCount: number;
  cancelledCount: number;
  movementCount: number;
}

export const DEFAULT_WAREHOUSE_ID = 'armazem_principal';

export type StockMovementType =
  | 'ENTRADA_MERCADORIA'
  | 'SAIDA_VENDA'
  | 'DEVOLUCAO_CLIENTE'
  | 'AJUSTE_INVENTARIO'
  | 'RECONCILIACAO_FISICA'
  | 'TRANSFERENCIA_ARMAZEM';

export type StockMovementDirection = 'IN' | 'OUT' | 'NEUTRAL';

export interface StockMovement {
  id: string;
  companyId: string;
  productId: string;
  productCode: string;
  productName: string;
  unit: string;
  type: StockMovementType;
  direction: StockMovementDirection;
  qty: number;
  previousStock: number;
  newStock: number;
  unitCost?: number;
  warehouseId: string;
  targetWarehouseId?: string;
  reason: string;
  reference?: string;
  invoiceId?: string;
  invoiceNumber?: string;
  operator: string;
  createdByUid?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
}

export type PurchasePaymentMethod = DirectPaymentMethod | 'Crédito';

export type PurchaseStatus = 'recorded' | 'cancelled';

export interface Supplier {
  id: string;
  companyId: string;
  name: string;
  nif: string;
  phone: string;
  email?: string;
  address: string;
  locality: string;
  contactPerson?: string;
  iban?: string;
  paymentTermsDays?: number;
  notes?: string;
  active?: boolean;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  updatedAtIso?: string;
}

export interface PurchaseLineItem {
  productId: string;
  code: string;
  name: string;
  unit: string;
  qty: number;
  unitCost: number;
  total: number;
}

export interface PurchaseRecord {
  id: string;
  companyId: string;
  number: string;
  supplierInvoiceRef?: string;
  supplierId: string;
  supplierName: string;
  supplierNif: string;
  issuedAtIso: string;
  dueDateIso?: string;
  lines: PurchaseLineItem[];
  totalAmount: number;
  amountPaid: number;
  amountDue: number;
  paymentMethod: PurchasePaymentMethod;
  paymentSummary?: string;
  reference?: string;
  warehouseId: string;
  updateStock: boolean;
  notes: string;
  operator: string;
  status: PurchaseStatus;
  cancelReason?: string;
  cancelledBy?: string;
  createdByUid?: string;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  updatedAtIso?: string;
}
