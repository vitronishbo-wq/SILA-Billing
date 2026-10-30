export type TaxRate = 0 | 14;
export type PaymentMethod = 'Dinheiro' | 'Multicaixa' | 'Transferência';
export type DocumentType = 'FR' | 'FP';
export type DocumentFormat = 'POS' | 'A4';
export type InvoiceStatus = 'issued' | 'cancelled';

export type PlanTier = 'FREE' | 'ESSENCIAL' | 'PROFISSIONAL' | 'ENTERPRISE';
export type CompanyOperationalStatus = 'active' | 'suspended' | 'pending';
export type CompanyRole = 'owner' | 'manager' | 'cashier';
export type SyncState = 'synced' | 'pending' | 'error';

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

export interface CompanyProfile {
  legalName: string;
  shortName: string;
  nif: string;
  address: string;
  cityCountry: string;
  phone: string;
  email: string;
  tagline: string;
}

export const NEUTRAL_PLATFORM_PROFILE: CompanyProfile = {
  legalName: 'SILA-Billing — Selecionar ou Cadastrar Empresa',
  shortName: 'Nova Empresa',
  nif: '---',
  address: 'Angola',
  cityCountry: 'Luanda - Angola',
  phone: '',
  email: '',
  tagline: 'Obrigado pela preferência',
};

export const JAIMONA_COMPANY: CompanyProfile = {
  legalName: 'JAIMONA-COMÉRCIO E SERVIÇOS, (SU) LDA',
  shortName: 'JAIMONA',
  nif: '5003069940',
  address: 'Rua Fapla, Bairro Verde A – Saurimo',
  cityCountry: 'Saurimo - Angola',
  phone: '(+244) 943671515',
  email: JAIMONA_OWNER_EMAIL,
  tagline: 'Servimos com Qualidade',
};

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
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  return canCompanySyncCloudData(company);
}

export function canCompanyHideViralFooter(
  company: Pick<CompanyRecord, 'id' | 'plan'>
): boolean {
  return hasPaidCommercialEntitlement(company);
}

export interface CompanyMember {
  id: string; // `${companyId}_${uid}`
  companyId: string;
  uid: string;
  email: string;
  displayName: string;
  role: CompanyRole;
  allowInvoiceCancel: boolean;
  active: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface SyncQueueEntry {
  id: string;
  companyId: string;
  entityType: 'company' | 'product' | 'customer' | 'invoice' | 'settings';
  entityId: string;
  operation: 'upsert' | 'delete' | 'cancel';
  status: SyncState;
  errorMessage?: string;
  createdAtIso: string;
  updatedAtIso: string;
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
  hidePromotionalFooter?: boolean;
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

export interface Product {
  id: string;
  companyId?: string;
  code: string;
  name: string;
  category: string;
  unit: string;
  price: number; // Preço Unitário em Kwanzas (Kz)
  ivaRate: TaxRate;
  exemptionReason: string;
  active: boolean;
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface Customer {
  id: string;
  companyId?: string;
  name: string;
  nif: string;
  locality: string;
  phone: string;
  address: string;
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

export interface InvoiceTotals {
  lines: CalculatedLineItem[];
  merchandiseTotal: number;
  grossItemsTotal: number;
  discountTotal: number;
  taxBase14: number;
  taxAmount14: number;
  taxBase0: number;
  taxAmount0: number;
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
  merchandiseTotal: number;
  discountTotal: number;
  taxBase14: number;
  taxAmount14: number;
  taxBase0: number;
  taxAmount0: number;
  taxTotal: number;
  grandTotal: number;
  amountInWords: string;
  amountReceived: number;
  changeAmount: number;
  notes: string;
  status: InvoiceStatus;
  cancelReason?: string;
  cancelledBy?: string;
  cancelledAtIso?: string;
  lines: CalculatedLineItem[];
  syncState?: SyncState;
  syncError?: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}
