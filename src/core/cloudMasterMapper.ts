/**
 * SILA-Billing — Mapeador Puro de Ficha Mestre e Snapshots para Cloud Firestore
 *
 * Isolado de dependências DOM/Firebase Client para permitir testes determinísticos
 * em Node.js e validação de conformidade contra `firestore.rules`.
 */

import { validateLogoDataUrl } from './companyValidator.ts';
import type { AgtIvaExemptionCode } from './fiscalTypes.ts';
import type {
  AngolaLegalNature,
  AngolaTaxRegime,
  AngolaTaxTerritory,
  CompanyProfile,
  EstablishmentRecord,
  InvoiceIssuerSnapshot,
  WarehouseRecord,
} from './types.ts';

export function sanitizeCloudId(raw: string): string {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'item_default';
}

export function sanitizeEstablishmentsForCloud(raw?: EstablishmentRecord[]): EstablishmentRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && e.id && e.code && e.name)
    .slice(0, 20)
    .map((e) => ({
      id: sanitizeCloudId(e.id),
      code: String(e.code).trim().slice(0, 16),
      name: String(e.name).trim().slice(0, 120),
      isHeadquarters: Boolean(e.isHeadquarters),
      address: String(e.address || '').trim().slice(0, 160),
      ...(e.municipality ? { municipality: String(e.municipality).trim().slice(0, 80) } : {}),
      ...(e.province ? { province: String(e.province).trim().slice(0, 80) } : {}),
      ...(e.phone ? { phone: String(e.phone).trim().slice(0, 40) } : {}),
      ...(e.email ? { email: String(e.email).trim().slice(0, 120) } : {}),
      ...(e.defaultCashierCode
        ? { defaultCashierCode: String(e.defaultCashierCode).trim().slice(0, 16) }
        : {}),
      ...(e.defaultWarehouseId
        ? { defaultWarehouseId: sanitizeCloudId(e.defaultWarehouseId).slice(0, 64) }
        : {}),
      active: e.active !== false,
    }));
}

export function sanitizeWarehousesForCloud(raw?: WarehouseRecord[]): WarehouseRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && w.id && w.code && w.name)
    .slice(0, 20)
    .map((w) => ({
      id: sanitizeCloudId(w.id).slice(0, 64),
      code: String(w.code).trim().slice(0, 16),
      name: String(w.name).trim().slice(0, 120),
      establishmentId: sanitizeCloudId(w.establishmentId || 'est_matriz'),
      ...(w.address ? { address: String(w.address).trim().slice(0, 160) } : {}),
      active: w.active !== false,
    }));
}

export function buildMasterProfileMap(profile: CompanyProfile): Record<string, unknown> {
  const mp: Record<string, unknown> = {};
  if (profile.legalNature) mp.legalNature = String(profile.legalNature).slice(0, 16);
  if (profile.cae) mp.cae = String(profile.cae).trim().slice(0, 32);
  if (profile.commercialRegistry) {
    mp.commercialRegistry = String(profile.commercialRegistry).trim().slice(0, 80);
  }
  if (profile.shareCapital) mp.shareCapital = String(profile.shareCapital).trim().slice(0, 40);

  mp.taxRegime =
    profile.taxRegime === 'SIMPLIFICADO' || profile.taxRegime === 'EXCLUSAO'
      ? profile.taxRegime
      : 'GERAL';
  if (profile.taxOffice) mp.taxOffice = String(profile.taxOffice).trim().slice(0, 120);
  if (profile.taxEntity) mp.taxEntity = String(profile.taxEntity).trim().slice(0, 120);
  if (profile.defaultExemptionCode) {
    mp.defaultExemptionCode = String(profile.defaultExemptionCode).trim().slice(0, 16);
  }
  if (typeof profile.isVatRetentionAgent === 'boolean') {
    mp.isVatRetentionAgent = profile.isVatRetentionAgent;
  }
  if (
    typeof profile.defaultWithholdingTax === 'number' &&
    Number.isFinite(profile.defaultWithholdingTax)
  ) {
    mp.defaultWithholdingTax = Math.min(100, Math.max(0, profile.defaultWithholdingTax));
  }
  if (profile.specialTaxTerritory) {
    mp.specialTaxTerritory = profile.specialTaxTerritory === 'AO-CAB' ? 'AO-CAB' : 'AO';
  }
  mp.agtEnvironment = profile.agtEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO';
  if (profile.activityStartDate) {
    mp.activityStartDate = String(profile.activityStartDate).trim().slice(0, 20);
  }

  if (profile.municipality) mp.municipality = String(profile.municipality).trim().slice(0, 80);
  if (profile.province) mp.province = String(profile.province).trim().slice(0, 80);
  if (profile.postalCode) mp.postalCode = String(profile.postalCode).trim().slice(0, 32);
  if (profile.country) mp.country = String(profile.country).trim().slice(0, 8);

  if (profile.mobile) mp.mobile = String(profile.mobile).trim().slice(0, 40);
  if (profile.whatsapp) mp.whatsapp = String(profile.whatsapp).trim().slice(0, 40);
  if (profile.billingEmail) mp.billingEmail = String(profile.billingEmail).trim().slice(0, 120);
  if (profile.website) mp.website = String(profile.website).trim().slice(0, 160);

  if (profile.logoUrl && validateLogoDataUrl(profile.logoUrl).valid) {
    mp.logoUrl = profile.logoUrl.trim().slice(0, 270000);
  }
  if (typeof profile.showLogoOnPos === 'boolean') mp.showLogoOnPos = profile.showLogoOnPos;
  if (typeof profile.showLogoOnA4 === 'boolean') mp.showLogoOnA4 = profile.showLogoOnA4;

  if (profile.bankName1) mp.bankName1 = String(profile.bankName1).trim().slice(0, 80);
  if (profile.iban1) mp.iban1 = String(profile.iban1).trim().slice(0, 40);
  if (profile.accountHolder1) mp.accountHolder1 = String(profile.accountHolder1).trim().slice(0, 120);
  if (profile.swift1) mp.swift1 = String(profile.swift1).trim().slice(0, 24);
  if (profile.bankName2) mp.bankName2 = String(profile.bankName2).trim().slice(0, 80);
  if (profile.iban2) mp.iban2 = String(profile.iban2).trim().slice(0, 40);
  if (profile.accountHolder2) mp.accountHolder2 = String(profile.accountHolder2).trim().slice(0, 120);
  if (profile.swift2) mp.swift2 = String(profile.swift2).trim().slice(0, 24);
  if (profile.multicaixaExpressPhone) {
    mp.multicaixaExpressPhone = String(profile.multicaixaExpressPhone).trim().slice(0, 40);
  }
  if (
    typeof profile.defaultPaymentTermsDays === 'number' &&
    Number.isFinite(profile.defaultPaymentTermsDays)
  ) {
    mp.defaultPaymentTermsDays = Math.min(
      3650,
      Math.max(0, Math.floor(profile.defaultPaymentTermsDays))
    );
  }

  if (profile.defaultEstablishmentId) {
    mp.defaultEstablishmentId = sanitizeCloudId(profile.defaultEstablishmentId);
  }
  const ests = sanitizeEstablishmentsForCloud(profile.establishments);
  if (ests.length > 0) mp.establishments = ests;
  const whs = sanitizeWarehousesForCloud(profile.warehouses);
  if (whs.length > 0) mp.warehouses = whs;

  if (profile.legalRepresentativeName) {
    mp.legalRepresentativeName = String(profile.legalRepresentativeName).trim().slice(0, 120);
  }
  if (profile.legalRepresentativeRole) {
    mp.legalRepresentativeRole = String(profile.legalRepresentativeRole).trim().slice(0, 64);
  }
  if (profile.legalRepresentativeNif) {
    mp.legalRepresentativeNif = String(profile.legalRepresentativeNif).trim().slice(0, 32);
  }
  if (profile.legalRepresentativePhone) {
    mp.legalRepresentativePhone = String(profile.legalRepresentativePhone).trim().slice(0, 40);
  }
  if (profile.accountantName) mp.accountantName = String(profile.accountantName).trim().slice(0, 120);
  if (profile.accountantOcpcaNumber) {
    mp.accountantOcpcaNumber = String(profile.accountantOcpcaNumber).trim().slice(0, 40);
  }
  if (profile.accountantEmail) {
    mp.accountantEmail = String(profile.accountantEmail).trim().slice(0, 120);
  }
  if (profile.accountantPhone) {
    mp.accountantPhone = String(profile.accountantPhone).trim().slice(0, 40);
  }

  return mp;
}

export function hydrateProfileFromCloud(cd: Record<string, unknown>, fallbackId: string): CompanyProfile {
  const mp =
    cd.masterProfile && typeof cd.masterProfile === 'object'
      ? (cd.masterProfile as Record<string, unknown>)
      : {};

  const taxRegimeRaw = String(mp.taxRegime || '');
  const taxRegime: AngolaTaxRegime =
    taxRegimeRaw === 'SIMPLIFICADO' || taxRegimeRaw === 'EXCLUSAO' ? taxRegimeRaw : 'GERAL';

  const legalNatureRaw = String(mp.legalNature || '') as AngolaLegalNature;
  const legalNature: AngolaLegalNature | undefined =
    legalNatureRaw === 'LDA' ||
    legalNatureRaw === 'SU_LDA' ||
    legalNatureRaw === 'SA' ||
    legalNatureRaw === 'ENI' ||
    legalNatureRaw === 'COOP' ||
    legalNatureRaw === 'OUTRA'
      ? legalNatureRaw
      : undefined;

  const logoCandidate = typeof mp.logoUrl === 'string' ? mp.logoUrl : undefined;
  const safeLogo = logoCandidate && validateLogoDataUrl(logoCandidate).valid ? logoCandidate : undefined;

  return {
    legalName: String(cd.legalName || cd.shortName || fallbackId),
    shortName: String(cd.shortName || cd.legalName || fallbackId),
    nif: String(cd.nif || ''),
    address: String(cd.address || 'Angola'),
    cityCountry: String(cd.cityCountry || 'Angola'),
    phone: String(cd.phone || ''),
    email: String(cd.email || ''),
    tagline: String(cd.tagline || ''),
    ...(legalNature ? { legalNature } : {}),
    ...(mp.cae ? { cae: String(mp.cae) } : {}),
    ...(mp.commercialRegistry ? { commercialRegistry: String(mp.commercialRegistry) } : {}),
    ...(mp.shareCapital ? { shareCapital: String(mp.shareCapital) } : {}),
    taxRegime,
    ...(mp.taxOffice ? { taxOffice: String(mp.taxOffice) } : {}),
    ...(mp.taxEntity ? { taxEntity: String(mp.taxEntity) } : {}),
    ...(mp.defaultExemptionCode
      ? { defaultExemptionCode: String(mp.defaultExemptionCode) as AgtIvaExemptionCode }
      : {}),
    ...(typeof mp.isVatRetentionAgent === 'boolean'
      ? { isVatRetentionAgent: mp.isVatRetentionAgent }
      : {}),
    ...(typeof mp.defaultWithholdingTax === 'number'
      ? { defaultWithholdingTax: mp.defaultWithholdingTax }
      : {}),
    ...(mp.specialTaxTerritory
      ? {
          specialTaxTerritory: (mp.specialTaxTerritory === 'AO-CAB'
            ? 'AO-CAB'
            : 'AO') as AngolaTaxTerritory,
        }
      : {}),
    agtEnvironment: mp.agtEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO',
    ...(mp.activityStartDate ? { activityStartDate: String(mp.activityStartDate) } : {}),
    ...(mp.municipality ? { municipality: String(mp.municipality) } : {}),
    ...(mp.province ? { province: String(mp.province) } : {}),
    ...(mp.postalCode ? { postalCode: String(mp.postalCode) } : {}),
    country: mp.country ? String(mp.country) : 'AO',
    ...(mp.mobile ? { mobile: String(mp.mobile) } : {}),
    ...(mp.whatsapp ? { whatsapp: String(mp.whatsapp) } : {}),
    ...(mp.billingEmail ? { billingEmail: String(mp.billingEmail) } : {}),
    ...(mp.website ? { website: String(mp.website) } : {}),
    ...(safeLogo ? { logoUrl: safeLogo } : {}),
    ...(typeof mp.showLogoOnPos === 'boolean' ? { showLogoOnPos: mp.showLogoOnPos } : {}),
    ...(typeof mp.showLogoOnA4 === 'boolean' ? { showLogoOnA4: mp.showLogoOnA4 } : {}),
    ...(mp.bankName1 ? { bankName1: String(mp.bankName1) } : {}),
    ...(mp.iban1 ? { iban1: String(mp.iban1) } : {}),
    ...(mp.accountHolder1 ? { accountHolder1: String(mp.accountHolder1) } : {}),
    ...(mp.swift1 ? { swift1: String(mp.swift1) } : {}),
    ...(mp.bankName2 ? { bankName2: String(mp.bankName2) } : {}),
    ...(mp.iban2 ? { iban2: String(mp.iban2) } : {}),
    ...(mp.accountHolder2 ? { accountHolder2: String(mp.accountHolder2) } : {}),
    ...(mp.swift2 ? { swift2: String(mp.swift2) } : {}),
    ...(mp.multicaixaExpressPhone
      ? { multicaixaExpressPhone: String(mp.multicaixaExpressPhone) }
      : {}),
    ...(typeof mp.defaultPaymentTermsDays === 'number'
      ? { defaultPaymentTermsDays: mp.defaultPaymentTermsDays }
      : {}),
    ...(mp.defaultEstablishmentId
      ? { defaultEstablishmentId: String(mp.defaultEstablishmentId) }
      : {}),
    ...(Array.isArray(mp.establishments)
      ? { establishments: sanitizeEstablishmentsForCloud(mp.establishments as EstablishmentRecord[]) }
      : {}),
    ...(Array.isArray(mp.warehouses)
      ? { warehouses: sanitizeWarehousesForCloud(mp.warehouses as WarehouseRecord[]) }
      : {}),
    ...(mp.legalRepresentativeName
      ? { legalRepresentativeName: String(mp.legalRepresentativeName) }
      : {}),
    ...(mp.legalRepresentativeRole
      ? { legalRepresentativeRole: String(mp.legalRepresentativeRole) }
      : {}),
    ...(mp.legalRepresentativeNif
      ? { legalRepresentativeNif: String(mp.legalRepresentativeNif) }
      : {}),
    ...(mp.legalRepresentativePhone
      ? { legalRepresentativePhone: String(mp.legalRepresentativePhone) }
      : {}),
    ...(mp.accountantName ? { accountantName: String(mp.accountantName) } : {}),
    ...(mp.accountantOcpcaNumber
      ? { accountantOcpcaNumber: String(mp.accountantOcpcaNumber) }
      : {}),
    ...(mp.accountantEmail ? { accountantEmail: String(mp.accountantEmail) } : {}),
    ...(mp.accountantPhone ? { accountantPhone: String(mp.accountantPhone) } : {}),
  };
}

export function sanitizeIssuerSnapshotForCloud(
  snap?: InvoiceIssuerSnapshot
): Record<string, unknown> | undefined {
  if (!snap || !snap.legalName || !snap.nif) return undefined;
  const out: Record<string, unknown> = {
    companyId: sanitizeCloudId(snap.companyId || 'comp'),
    legalName: String(snap.legalName).slice(0, 160),
    shortName: String(snap.shortName || snap.legalName).slice(0, 64),
    nif: String(snap.nif).slice(0, 32),
    taxRegime:
      snap.taxRegime === 'SIMPLIFICADO' || snap.taxRegime === 'EXCLUSAO'
        ? snap.taxRegime
        : 'GERAL',
    address: String(snap.address || 'Angola').slice(0, 160),
    cityCountry: String(snap.cityCountry || 'Angola').slice(0, 80),
    phone: String(snap.phone || '').slice(0, 40),
    email: String(snap.email || '').slice(0, 120),
    tagline: String(snap.tagline || '').slice(0, 120),
    capturedAtIso: String(snap.capturedAtIso || new Date().toISOString()).slice(0, 40),
  };
  if (snap.taxOffice) out.taxOffice = String(snap.taxOffice).slice(0, 120);
  if (snap.commercialRegistry) out.commercialRegistry = String(snap.commercialRegistry).slice(0, 80);
  if (snap.shareCapital) out.shareCapital = String(snap.shareCapital).slice(0, 40);
  if (snap.cae) out.cae = String(snap.cae).slice(0, 32);
  if (snap.municipality) out.municipality = String(snap.municipality).slice(0, 80);
  if (snap.province) out.province = String(snap.province).slice(0, 80);
  if (snap.postalCode) out.postalCode = String(snap.postalCode).slice(0, 32);
  if (snap.mobile) out.mobile = String(snap.mobile).slice(0, 40);
  if (snap.whatsapp) out.whatsapp = String(snap.whatsapp).slice(0, 40);
  if (snap.billingEmail) out.billingEmail = String(snap.billingEmail).slice(0, 120);
  if (snap.website) out.website = String(snap.website).slice(0, 160);
  if (snap.logoUrl && validateLogoDataUrl(snap.logoUrl).valid) {
    out.logoUrl = snap.logoUrl.slice(0, 270000);
  }
  if (typeof snap.showLogoOnPos === 'boolean') out.showLogoOnPos = snap.showLogoOnPos;
  if (typeof snap.showLogoOnA4 === 'boolean') out.showLogoOnA4 = snap.showLogoOnA4;
  if (snap.bankName1) out.bankName1 = String(snap.bankName1).slice(0, 80);
  if (snap.iban1) out.iban1 = String(snap.iban1).slice(0, 40);
  if (snap.accountHolder1) out.accountHolder1 = String(snap.accountHolder1).slice(0, 120);
  if (snap.swift1) out.swift1 = String(snap.swift1).slice(0, 24);
  if (snap.bankName2) out.bankName2 = String(snap.bankName2).slice(0, 80);
  if (snap.iban2) out.iban2 = String(snap.iban2).slice(0, 40);
  if (snap.accountHolder2) out.accountHolder2 = String(snap.accountHolder2).slice(0, 120);
  if (snap.swift2) out.swift2 = String(snap.swift2).slice(0, 24);
  if (snap.multicaixaExpressPhone) {
    out.multicaixaExpressPhone = String(snap.multicaixaExpressPhone).slice(0, 40);
  }
  if (snap.establishmentId) out.establishmentId = sanitizeCloudId(snap.establishmentId);
  if (snap.establishmentCode) out.establishmentCode = String(snap.establishmentCode).slice(0, 16);
  if (snap.establishmentName) out.establishmentName = String(snap.establishmentName).slice(0, 120);
  if (snap.establishmentAddress) {
    out.establishmentAddress = String(snap.establishmentAddress).slice(0, 160);
  }
  if (snap.establishmentMunicipality) {
    out.establishmentMunicipality = String(snap.establishmentMunicipality).slice(0, 80);
  }
  if (snap.establishmentProvince) {
    out.establishmentProvince = String(snap.establishmentProvince).slice(0, 80);
  }
  if (snap.legalRepresentativeName) {
    out.legalRepresentativeName = String(snap.legalRepresentativeName).slice(0, 120);
  }
  if (snap.legalRepresentativeRole) {
    out.legalRepresentativeRole = String(snap.legalRepresentativeRole).slice(0, 64);
  }
  return out;
}
