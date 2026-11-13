import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import {
  AgtDocumentType,
  AgtIvaExemptionCode,
  AgtSeriesEnvironment,
  AgtSeriesRecord,
  AgtSeriesStatus,
} from '../core/fiscalTypes';
import { validateLogoDataUrl } from '../core/companyValidator';
import {
  AngolaLegalNature,
  AngolaTaxRegime,
  AngolaTaxTerritory,
  AppSettings,
  CalculatedLineItem,
  canCompanySyncCloudData,
  CashMovement,
  CashMovementType,
  CashSession,
  CompanyMember,
  CompanyProfile,
  CompanyRecord,
  Customer,
  DEFAULT_SETTINGS,
  DEFAULT_WAREHOUSE_ID,
  DirectPaymentMethod,
  DocumentType,
  EstablishmentRecord,
  InvoiceIssuerSnapshot,
  InvoiceRecord,
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  PaymentSplit,
  Product,
  ProductPriceChange,
  ProductType,
  PurchaseLineItem,
  PurchasePaymentMethod,
  PurchaseRecord,
  StockMovement,
  StockMovementDirection,
  StockMovementType,
  Supplier,
  TaxRate,
  validateCompanyNif,
  VITRONIS_INSTITUTIONAL,
  WarehouseRecord,
} from '../core/types';
import { auth, db, handleFirestoreError, OperationType } from './firebaseClient';

function sanitizeId(raw: string): string {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'item_default';
}

function normalizeTaxRate(raw: unknown): TaxRate {
  const num = Number(raw);
  if (num === 1 || num === 5 || num === 7 || num === 14) return num;
  return 0;
}

const VALID_DOC_TYPES: ReadonlySet<DocumentType> = new Set([
  'FR',
  'FA',
  'FP',
  'NC',
  'ND',
  'RC',
  'FT',
  'CS',
]);

function normalizeDocType(raw: unknown): DocumentType {
  const candidate = String(raw || '').trim().toUpperCase() as DocumentType;
  return VALID_DOC_TYPES.has(candidate) ? candidate : 'FR';
}

function sanitizeEstablishmentsForCloud(raw?: EstablishmentRecord[]): EstablishmentRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && e.id && e.code && e.name)
    .slice(0, 20)
    .map((e) => ({
      id: sanitizeId(e.id),
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
        ? { defaultWarehouseId: sanitizeId(e.defaultWarehouseId).slice(0, 64) }
        : {}),
      active: e.active !== false,
    }));
}

function sanitizeWarehousesForCloud(raw?: WarehouseRecord[]): WarehouseRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w) => w && w.id && w.code && w.name)
    .slice(0, 20)
    .map((w) => ({
      id: sanitizeId(w.id).slice(0, 64),
      code: String(w.code).trim().slice(0, 16),
      name: String(w.name).trim().slice(0, 120),
      establishmentId: sanitizeId(w.establishmentId || 'est_matriz'),
      ...(w.address ? { address: String(w.address).trim().slice(0, 160) } : {}),
      active: w.active !== false,
    }));
}

function buildMasterProfileMap(profile: CompanyProfile): Record<string, unknown> {
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
    mp.defaultEstablishmentId = sanitizeId(profile.defaultEstablishmentId);
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

function hydrateProfileFromCloud(cd: Record<string, unknown>, fallbackId: string): CompanyProfile {
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

function sanitizeIssuerSnapshotForCloud(
  snap?: InvoiceIssuerSnapshot
): Record<string, unknown> | undefined {
  if (!snap || !snap.legalName || !snap.nif) return undefined;
  const out: Record<string, unknown> = {
    companyId: sanitizeId(snap.companyId || 'comp'),
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
  if (snap.establishmentId) out.establishmentId = sanitizeId(snap.establishmentId);
  if (snap.establishmentCode) out.establishmentCode = String(snap.establishmentCode).slice(0, 16);
  if (snap.establishmentName) out.establishmentName = String(snap.establishmentName).slice(0, 120);
  if (snap.establishmentAddress) {
    out.establishmentAddress = String(snap.establishmentAddress).slice(0, 160);
  }
  if (snap.legalRepresentativeName) {
    out.legalRepresentativeName = String(snap.legalRepresentativeName).slice(0, 120);
  }
  if (snap.legalRepresentativeRole) {
    out.legalRepresentativeRole = String(snap.legalRepresentativeRole).slice(0, 64);
  }
  return out;
}

const verifiedCloudCompaniesCache = new Set<string>();

/**
 * Regista ou atualiza a empresa e o índice único /company_nifs/{normalizedNif} no Cloud Firestore.
 * Se outro proprietário já tiver registado o mesmo NIF no Firestore, a escrita falha atomicamente
 * pelas regras de segurança (1 NIF = 1 Empresa).
 */
export async function ensureCompanyRegisteredCloud(
  company: CompanyRecord,
  forceUpdate = false
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const cacheKey = `${user.uid}:${company.id}`;
  if (!forceUpdate && verifiedCloudCompaniesCache.has(cacheKey)) {
    return;
  }

  const nifCheck = validateCompanyNif(company.profile.nif);
  if (!nifCheck.valid) {
    throw new Error(nifCheck.error || 'NIF inválido para sincronização Cloud.');
  }

  const companyId = sanitizeId(company.id);
  const normalizedNif = nifCheck.normalized;
  const companyRef = doc(db, 'companies', companyId);
  const nifRef = doc(db, 'company_nifs', normalizedNif);
  const memberRef = doc(db, 'companies', companyId, 'members', user.uid);
  const userLinkRef = doc(db, 'users', user.uid, 'company_links', companyId);

  try {
    if (!company.id) return;

    const existingComp = await getDoc(companyRef).catch(() => null);

    if (!existingComp || !existingComp.exists()) {
      // Impede que outra conta (incluindo o Super-Admin em teste) assuma a titularidade da JAIMONA na Cloud
      if (companyId === JAIMONA_COMPANY_ID && !isJaimonaOwnerEmail(user.email)) {
        return;
      }

      const batch = writeBatch(db);

      batch.set(nifRef, {
        normalizedNif,
        companyId,
        ownerUid: user.uid,
        shortName: (company.profile.shortName || company.profile.legalName).slice(0, 64),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      const resolvedOwnerEmail =
        companyId === JAIMONA_COMPANY_ID
          ? JAIMONA_OWNER_EMAIL
          : (company.ownerEmail || user.email || '').slice(0, 120);

      const isProtectedJaimona =
        companyId === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(user.email);

      const masterProfilePayload = buildMasterProfileMap(company.profile);

      batch.set(companyRef, {
        id: companyId,
        normalizedNif,
        ownerUid: user.uid,
        ownerEmail: resolvedOwnerEmail,
        legalName: company.profile.legalName.slice(0, 160),
        shortName: company.profile.shortName.slice(0, 64),
        nif: company.profile.nif.slice(0, 32),
        address: (company.profile.address || company.profile.cityCountry || 'Angola').slice(0, 160),
        cityCountry: (company.profile.cityCountry || 'Angola').slice(0, 80),
        phone: (company.profile.phone || '').slice(0, 40),
        email: (company.profile.email || '').slice(0, 120),
        tagline: (company.profile.tagline || '').slice(0, 120),
        masterProfile: masterProfilePayload,
        status: 'active',
        planTier: isProtectedJaimona ? 'PROFISSIONAL' : 'FREE',
        commercialActive: isProtectedJaimona,
        baseSequence: Math.max(0, Number(company.baseSequence) || 0),
        allowManagerCancel: Boolean(company.allowManagerCancel),
        termsAcceptedVersion: (
          company.termsAcceptedVersion || VITRONIS_INSTITUTIONAL.termsVersion
        ).slice(0, 32),
        termsAcceptedAtIso: (
          company.termsAcceptedAtIso ||
          company.createdAtIso ||
          new Date().toISOString()
        ).slice(0, 40),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(memberRef, {
        id: user.uid,
        companyId,
        companyOwnerUid: user.uid,
        uid: user.uid,
        email: (user.email || '').slice(0, 120),
        emailLower: (user.email || '').trim().toLowerCase().slice(0, 120),
        displayName: (user.displayName || user.email || 'Proprietário').slice(0, 120),
        role: 'owner',
        allowInvoiceCancel: true,
        active: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      batch.set(userLinkRef, {
        companyId,
        uid: user.uid,
        role: 'owner',
        shortName: company.profile.shortName.slice(0, 64),
        nif: company.profile.nif.slice(0, 32),
        normalizedNif,
        updatedAt: serverTimestamp(),
      });

      await batch.commit();
    } else if (existingComp.data()?.ownerUid === user.uid) {
      await updateDoc(companyRef, {
        legalName: company.profile.legalName.slice(0, 160),
        shortName: company.profile.shortName.slice(0, 64),
        address: (company.profile.address || company.profile.cityCountry || 'Angola').slice(0, 160),
        cityCountry: (company.profile.cityCountry || 'Angola').slice(0, 80),
        phone: (company.profile.phone || '').slice(0, 40),
        email: (company.profile.email || '').slice(0, 120),
        tagline: (company.profile.tagline || '').slice(0, 120),
        masterProfile: buildMasterProfileMap(company.profile),
        allowManagerCancel: Boolean(company.allowManagerCancel),
        updatedAt: serverTimestamp(),
      });
    }
    verifiedCloudCompaniesCache.add(cacheKey);
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `companies/${companyId}`);
  }
}

export async function upsertCompanyMemberCloud(
  company: CompanyRecord,
  member: CompanyMember
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (member.role !== 'owner' && !canCompanySyncCloudData(company)) return;

  const companyId = sanitizeId(company.id);
  const memberDocId = sanitizeId(member.uid || member.id);
  const path = `companies/${companyId}/members/${memberDocId}`;
  const ref = doc(db, 'companies', companyId, 'members', memberDocId);
  const ownerUid = company.ownerUid || user.uid;

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        id: memberDocId,
        companyId,
        companyOwnerUid: ownerUid,
        uid: sanitizeId(member.uid || memberDocId),
        email: (member.email || '').slice(0, 120),
        emailLower: (member.email || '').trim().toLowerCase().slice(0, 120),
        displayName: (member.displayName || member.email || 'Operador').slice(0, 120),
        role: member.role,
        allowInvoiceCancel: Boolean(member.allowInvoiceCancel),
        active: Boolean(member.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        displayName: (member.displayName || member.email || 'Operador').slice(0, 120),
        role: member.role,
        allowInvoiceCancel: Boolean(member.allowInvoiceCancel),
        active: Boolean(member.active),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

function sanitizePriceHistory(raw?: ProductPriceChange[]): ProductPriceChange[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw
    .slice(0, 20)
    .map((entry) => {
      const clean: ProductPriceChange = {
        changedAtIso: String(entry.changedAtIso || new Date().toISOString()).slice(0, 40),
        previousPrice: Math.min(999999999, Math.max(0, Number(entry.previousPrice) || 0)),
        newPrice: Math.min(999999999, Math.max(0, Number(entry.newPrice) || 0)),
        changedBy: String(entry.changedBy || 'Operador').slice(0, 120) || 'Operador',
      };
      if (typeof entry.previousCost === 'number' && Number.isFinite(entry.previousCost) && entry.previousCost >= 0) {
        clean.previousCost = Math.min(999999999, entry.previousCost);
      }
      if (typeof entry.newCost === 'number' && Number.isFinite(entry.newCost) && entry.newCost >= 0) {
        clean.newCost = Math.min(999999999, entry.newCost);
      }
      return clean;
    });
}

export async function upsertProductCloud(
  product: Product,
  isNew: boolean,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || product.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const productId = sanitizeId(product.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  // Sincroniza na estrutura multiempresa isolada /companies/{companyId}/products/{productId}
  const compProdPath = `companies/${companyId}/products/${productId}`;
  const compProdRef = doc(db, 'companies', companyId, 'products', productId);

  try {
    const snap = await getDoc(compProdRef);
    const barcodeVal = String(product.barcode || '').trim().slice(0, 48);
    const costPriceVal =
      typeof product.costPrice === 'number' && Number.isFinite(product.costPrice) && product.costPrice > 0
        ? Math.min(999999999, product.costPrice)
        : 0;
    const cleanHistory = sanitizePriceHistory(product.priceHistory);
    const stockFields =
      typeof product.trackStock === 'boolean'
        ? {
            trackStock: Boolean(product.trackStock),
            stockQty: Number(product.stockQty) || 0,
            minStockQty: Math.max(0, Number(product.minStockQty) || 0),
          }
        : {};
    const historyField = cleanHistory.length > 0 ? { priceHistory: cleanHistory } : {};

    const normalizedRate = normalizeTaxRate(product.ivaRate);
    const extraProductFields = {
      ...(product.productType === 'P' || product.productType === 'S' || product.productType === 'K'
        ? { productType: product.productType }
        : {}),
      ...(product.exemptionCode
        ? { exemptionCode: String(product.exemptionCode).trim().slice(0, 16) }
        : {}),
    };

    if (!snap.exists()) {
      await setDoc(compProdRef, {
        id: productId,
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        code: product.code.slice(0, 32),
        barcode: barcodeVal,
        name: product.name.slice(0, 160),
        category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
        unit: (product.unit || 'un').slice(0, 16),
        costPrice: costPriceVal,
        price: Number(product.price) || 0,
        ivaRate: normalizedRate,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
        ...extraProductFields,
        ...stockFields,
        ...historyField,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(compProdRef, {
        updatedByUid: user.uid,
        code: product.code.slice(0, 32),
        barcode: barcodeVal,
        name: product.name.slice(0, 160),
        category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
        unit: (product.unit || 'un').slice(0, 16),
        costPrice: costPriceVal,
        price: Number(product.price) || 0,
        ivaRate: normalizedRate,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
        ...extraProductFields,
        ...stockFields,
        ...historyField,
        updatedAt: serverTimestamp(),
      });
    }

    // Mantém espelho clássico apenas para o e-mail titular real da JAIMONA
    if (companyId === JAIMONA_COMPANY_ID && ownerUid === user.uid && isJaimonaOwnerEmail(user.email)) {
      const legacyRef = doc(db, 'users', user.uid, 'products', productId);
      const legSnap = await getDoc(legacyRef);
      if (!legSnap.exists()) {
        await setDoc(legacyRef, {
          id: productId,
          ownerId: user.uid,
          code: product.code.slice(0, 32),
          barcode: barcodeVal,
          name: product.name.slice(0, 160),
          category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
          unit: (product.unit || 'un').slice(0, 16),
          costPrice: costPriceVal,
          price: Number(product.price) || 0,
          ivaRate: normalizedRate,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
          ...extraProductFields,
          ...stockFields,
          ...historyField,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(legacyRef, {
          code: product.code.slice(0, 32),
          barcode: barcodeVal,
          name: product.name.slice(0, 160),
          category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
          unit: (product.unit || 'un').slice(0, 16),
          costPrice: costPriceVal,
          price: Number(product.price) || 0,
          ivaRate: normalizedRate,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
          ...extraProductFields,
          ...stockFields,
          ...historyField,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, compProdPath);
  }
}

export async function updateProductStockCloud(
  productIdRaw: string,
  stockQty: number,
  companyIdRaw: string,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
  if (company && !canCompanySyncCloudData(company)) return;
  const companyId = sanitizeId(companyIdRaw);
  const productId = sanitizeId(productIdRaw);
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }
  const path = `companies/${companyId}/products/${productId}`;
  try {
    const compProdRef = doc(db, 'companies', companyId, 'products', productId);
    const snap = await getDoc(compProdRef);
    if (snap.exists()) {
      await updateDoc(compProdRef, {
        updatedByUid: user.uid,
        stockQty: Number(stockQty) || 0,
        updatedAt: serverTimestamp(),
      });
    }
    if (companyId === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(user.email)) {
      const legacyRef = doc(db, 'users', user.uid, 'products', productId);
      const legSnap = await getDoc(legacyRef);
      if (legSnap.exists()) {
        await updateDoc(legacyRef, {
          stockQty: Number(stockQty) || 0,
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, path);
  }
}

export async function removeProductCloud(
  productIdRaw: string,
  companyIdRaw: string,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
  if (company && !canCompanySyncCloudData(company)) return;
  const companyId = sanitizeId(companyIdRaw);
  const productId = sanitizeId(productIdRaw);
  const path = `companies/${companyId}/products/${productId}`;
  try {
    await deleteDoc(doc(db, 'companies', companyId, 'products', productId));
    if (companyId === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(user.email)) {
      await deleteDoc(doc(db, 'users', user.uid, 'products', productId)).catch(() => null);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertCustomerCloud(
  customer: Customer,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || customer.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const customerId = sanitizeId(customer.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const custPath = `companies/${companyId}/customers/${customerId}`;
  const custRef = doc(db, 'companies', companyId, 'customers', customerId);
  const privRef = doc(db, 'companies', companyId, 'customers', customerId, 'private', 'contact');

  try {
    const [snap, privSnap] = await Promise.all([
      getDoc(custRef),
      getDoc(privRef).catch(() => null),
    ]);
    const creditLimitVal =
      typeof customer.creditLimit === 'number' && Number.isFinite(customer.creditLimit)
        ? Math.min(999999999, Math.max(0, customer.creditLimit))
        : 0;
    const batch = writeBatch(db);
    if (!snap.exists()) {
      batch.set(custRef, {
        id: customerId,
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        name: customer.name.slice(0, 160),
        nif: (customer.nif || '').slice(0, 32),
        locality: (customer.locality || '').slice(0, 160),
        creditLimit: creditLimitVal,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(custRef, {
        updatedByUid: user.uid,
        name: customer.name.slice(0, 160),
        nif: (customer.nif || '').slice(0, 32),
        locality: (customer.locality || '').slice(0, 160),
        creditLimit: creditLimitVal,
        updatedAt: serverTimestamp(),
      });
    }

    if (!privSnap || !privSnap.exists()) {
      batch.set(privRef, {
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        phone: (customer.phone || '').slice(0, 40),
        address: (customer.address || '').slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(privRef, {
        updatedByUid: user.uid,
        phone: (customer.phone || '').slice(0, 40),
        address: (customer.address || '').slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    if (companyId === JAIMONA_COMPANY_ID && ownerUid === user.uid && isJaimonaOwnerEmail(user.email)) {
      const legCustRef = doc(db, 'users', user.uid, 'customers', customerId);
      const legPrivRef = doc(db, 'users', user.uid, 'customers', customerId, 'private', 'contact');
      const [legSnap, legPrivSnap] = await Promise.all([
        getDoc(legCustRef),
        getDoc(legPrivRef).catch(() => null),
      ]);
      const legBatch = writeBatch(db);
      if (!legSnap.exists()) {
        legBatch.set(legCustRef, {
          id: customerId,
          ownerId: user.uid,
          name: customer.name.slice(0, 160),
          nif: (customer.nif || '').slice(0, 32),
          locality: (customer.locality || '').slice(0, 160),
          creditLimit: creditLimitVal,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        legBatch.update(legCustRef, {
          name: customer.name.slice(0, 160),
          nif: (customer.nif || '').slice(0, 32),
          locality: (customer.locality || '').slice(0, 160),
          creditLimit: creditLimitVal,
          updatedAt: serverTimestamp(),
        });
      }

      if (!legPrivSnap || !legPrivSnap.exists()) {
        legBatch.set(legPrivRef, {
          ownerId: user.uid,
          phone: (customer.phone || '').slice(0, 40),
          address: (customer.address || '').slice(0, 200),
          updatedAt: serverTimestamp(),
        });
      } else {
        legBatch.update(legPrivRef, {
          phone: (customer.phone || '').slice(0, 40),
          address: (customer.address || '').slice(0, 200),
          updatedAt: serverTimestamp(),
        });
      }
      await legBatch.commit().catch(() => null);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, custPath);
  }
}

export async function removeCustomerCloud(
  customerIdRaw: string,
  companyIdRaw: string,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
  if (company && !canCompanySyncCloudData(company)) return;
  const companyId = sanitizeId(companyIdRaw);
  const customerId = sanitizeId(customerIdRaw);
  const custPath = `companies/${companyId}/customers/${customerId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'companies', companyId, 'customers', customerId, 'private', 'contact'));
    batch.delete(doc(db, 'companies', companyId, 'customers', customerId));
    await batch.commit();

    if (companyId === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(user.email)) {
      const legBatch = writeBatch(db);
      legBatch.delete(doc(db, 'users', user.uid, 'customers', customerId, 'private', 'contact'));
      legBatch.delete(doc(db, 'users', user.uid, 'customers', customerId));
      await legBatch.commit().catch(() => null);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, custPath);
  }
}

export async function createInvoiceCloud(
  invoice: InvoiceRecord,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || invoice.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const invoiceId = sanitizeId(invoice.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }
  const invPath = `companies/${companyId}/invoices/${invoiceId}`;
  const invRef = doc(db, 'companies', companyId, 'invoices', invoiceId);

  try {
    const existingSnap = await getDoc(invRef);
    if (existingSnap.exists()) {
      const exData = existingSnap.data();
      if (invoice.status === 'cancelled' && exData?.status !== 'cancelled') {
        await updateDoc(invRef, {
          status: 'cancelled',
          cancelReason: (invoice.cancelReason || 'Anulação operacional').slice(0, 240),
          cancelledBy: (invoice.cancelledBy || user.email || user.uid).slice(0, 120),
          cancelledAtIso: (invoice.cancelledAtIso || new Date().toISOString()).slice(0, 40),
          updatedAt: serverTimestamp(),
        });
      } else if (
        invoice.status === 'issued' &&
        exData?.status === 'issued' &&
        ((Number(exData?.amountDue) || 0) !== (Number(invoice.amountDue) || 0) ||
          (Number(exData?.reprintCount) || 0) !== (Number(invoice.reprintCount) || 0) ||
          String(exData?.notes || '') !== String(invoice.notes || ''))
      ) {
        await updateDoc(invRef, {
          amountReceived: invoice.amountReceived,
          ...(typeof invoice.initialAmountReceived === 'number'
            ? { initialAmountReceived: invoice.initialAmountReceived }
            : {}),
          amountDue: Math.max(0, Number(invoice.amountDue) || 0),
          changeAmount: invoice.changeAmount,
          ...(typeof invoice.initialChangeAmount === 'number'
            ? { initialChangeAmount: invoice.initialChangeAmount }
            : {}),
          ...(invoice.paymentSummary ? { paymentSummary: invoice.paymentSummary.slice(0, 160) } : {}),
          ...(invoice.transferReference ? { transferReference: invoice.transferReference.slice(0, 80) } : {}),
          ...(typeof invoice.reprintCount === 'number' && invoice.reprintCount > 0
            ? { reprintCount: Math.min(10000, Math.floor(invoice.reprintCount)) }
            : {}),
          ...(invoice.lastReprintedAtIso
            ? { lastReprintedAtIso: invoice.lastReprintedAtIso.slice(0, 40) }
            : {}),
          ...(invoice.lastReprintedBy
            ? { lastReprintedBy: invoice.lastReprintedBy.slice(0, 120) }
            : {}),
          notes: (invoice.notes || '').slice(0, 300),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    const cleanSplits: PaymentSplit[] = Array.isArray(invoice.paymentSplits)
      ? invoice.paymentSplits
          .filter(
            (s) =>
              s &&
              (s.method === 'Dinheiro' || s.method === 'Multicaixa' || s.method === 'Transferência') &&
              Number(s.amount) > 0
          )
          .slice(0, 5)
          .map((s) => ({
            method: s.method,
            amount: Math.min(999999999, Number(s.amount)),
            ...(s.reference ? { reference: String(s.reference).slice(0, 80) } : {}),
          }))
      : [];

    const sanitizedSnapshot = sanitizeIssuerSnapshotForCloud(invoice.issuerSnapshot);

    const batch = writeBatch(db);
    batch.set(invRef, {
      id: invoiceId,
      companyId,
      companyOwnerUid: ownerUid,
      emittedByUid: user.uid,
      number: invoice.number.slice(0, 40),
      docType: normalizeDocType(invoice.docType),
      issuedAtIso: invoice.issuedAtIso.slice(0, 40),
      cashier: invoice.cashier.slice(0, 16),
      operator: invoice.operator.slice(0, 32),
      paymentMethod: invoice.paymentMethod,
      customerId: sanitizeId(invoice.customerId),
      customerName: invoice.customerName.slice(0, 160),
      customerNif: (invoice.customerNif || '').slice(0, 32),
      customerLocality: (invoice.customerLocality || '').slice(0, 160),
      merchandiseTotal: invoice.merchandiseTotal,
      discountTotal: invoice.discountTotal,
      ...(invoice.globalDiscountPct ? { globalDiscountPct: invoice.globalDiscountPct } : {}),
      ...(invoice.globalDiscountAmount ? { globalDiscountAmount: invoice.globalDiscountAmount } : {}),
      taxBase14: invoice.taxBase14,
      taxAmount14: invoice.taxAmount14,
      ...(typeof invoice.taxBaseIntermediate === 'number'
        ? { taxBaseIntermediate: invoice.taxBaseIntermediate }
        : {}),
      ...(typeof invoice.taxAmountIntermediate === 'number'
        ? { taxAmountIntermediate: invoice.taxAmountIntermediate }
        : {}),
      ...(typeof invoice.taxBaseReduced === 'number'
        ? { taxBaseReduced: invoice.taxBaseReduced }
        : {}),
      ...(typeof invoice.taxAmountReduced === 'number'
        ? { taxAmountReduced: invoice.taxAmountReduced }
        : {}),
      taxBase0: invoice.taxBase0,
      taxAmount0: 0,
      taxTotal: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
      amountInWords: invoice.amountInWords.slice(0, 300),
      ...(invoice.establishmentId ? { establishmentId: sanitizeId(invoice.establishmentId) } : {}),
      ...(invoice.establishmentCode
        ? { establishmentCode: invoice.establishmentCode.slice(0, 16) }
        : {}),
      ...(invoice.establishmentName
        ? { establishmentName: invoice.establishmentName.slice(0, 120) }
        : {}),
      ...(invoice.seriesCode ? { seriesCode: invoice.seriesCode.slice(0, 16) } : {}),
      ...(invoice.seriesEnvironment
        ? { seriesEnvironment: invoice.seriesEnvironment }
        : {}),
      ...(invoice.agtAuthorizationCode
        ? { agtAuthorizationCode: invoice.agtAuthorizationCode.slice(0, 64) }
        : {}),
      ...(invoice.saftHash4 ? { saftHash4: invoice.saftHash4.slice(0, 16) } : {}),
      ...(sanitizedSnapshot ? { issuerSnapshot: sanitizedSnapshot } : {}),
      ...(invoice.sessionId ? { sessionId: sanitizeId(invoice.sessionId) } : {}),
      amountReceived: invoice.amountReceived,
      ...(typeof invoice.initialAmountReceived === 'number'
        ? { initialAmountReceived: invoice.initialAmountReceived }
        : {}),
      changeAmount: invoice.changeAmount,
      ...(typeof invoice.initialChangeAmount === 'number'
        ? { initialChangeAmount: invoice.initialChangeAmount }
        : {}),
      ...(invoice.amountDue && invoice.amountDue > 0 ? { amountDue: invoice.amountDue } : {}),
      ...(invoice.transferReference ? { transferReference: invoice.transferReference.slice(0, 80) } : {}),
      ...(cleanSplits.length > 0 ? { paymentSplits: cleanSplits } : {}),
      ...(invoice.paymentSummary ? { paymentSummary: invoice.paymentSummary.slice(0, 160) } : {}),
      ...(invoice.returnOriginInvoiceId ? { returnOriginInvoiceId: sanitizeId(invoice.returnOriginInvoiceId) } : {}),
      ...(invoice.returnOriginNumber ? { returnOriginNumber: invoice.returnOriginNumber.slice(0, 40) } : {}),
      ...(invoice.returnCreditApplied ? { returnCreditApplied: invoice.returnCreditApplied } : {}),
      ...(typeof invoice.reprintCount === 'number' && invoice.reprintCount > 0
        ? { reprintCount: Math.min(10000, Math.floor(invoice.reprintCount)) }
        : {}),
      ...(invoice.lastReprintedAtIso
        ? { lastReprintedAtIso: invoice.lastReprintedAtIso.slice(0, 40) }
        : {}),
      ...(invoice.lastReprintedBy
        ? { lastReprintedBy: invoice.lastReprintedBy.slice(0, 120) }
        : {}),
      notes: (invoice.notes || '').slice(0, 300),
      itemCount: invoice.lines.length,
      status: 'issued',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    for (const line of invoice.lines) {
      const itemId = sanitizeId(line.id);
      const itemRef = doc(db, 'companies', companyId, 'invoices', invoiceId, 'items', itemId);
      batch.set(itemRef, {
        id: itemId,
        invoiceId,
        companyId,
        companyOwnerUid: ownerUid,
        code: line.code.slice(0, 32),
        description: line.description.slice(0, 160),
        unit: (line.unit || 'un').slice(0, 16),
        qty: line.qty,
        unitPrice: line.unitPrice,
        discountPct: line.discountPct,
        ivaRate: normalizeTaxRate(line.ivaRate),
        ...(line.exemptionCode
          ? { exemptionCode: String(line.exemptionCode).trim().slice(0, 16) }
          : {}),
        lineGross: line.lineGross,
        lineNet: line.lineNet,
        lineBase: line.lineBase,
        lineTax: line.lineTax,
        lineTotal: line.lineTotal,
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, invPath);
  }
}

export async function cancelInvoiceCloud(
  invoiceIdRaw: string,
  cancelReason: string,
  companyIdRaw: string,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
  if (company && !canCompanySyncCloudData(company)) return;
  const companyId = sanitizeId(companyIdRaw);
  const invoiceId = sanitizeId(invoiceIdRaw);
  const invPath = `companies/${companyId}/invoices/${invoiceId}`;
  try {
    const invRef = doc(db, 'companies', companyId, 'invoices', invoiceId);
    const snap = await getDoc(invRef);
    if (snap.exists() && snap.data()?.status !== 'cancelled') {
      await updateDoc(invRef, {
        status: 'cancelled',
        cancelReason: cancelReason.trim().slice(0, 240),
        cancelledBy: (user.email || user.uid).slice(0, 120),
        cancelledAtIso: new Date().toISOString().slice(0, 40),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, invPath);
  }
}

export async function upsertSettingsCloud(
  settings: AppSettings,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || settings.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }
  const settingsPath = `companies/${companyId}/settings/general`;
  const ref = doc(db, 'companies', companyId, 'settings', 'general');
  const resolvedEstablishmentId =
    settings.defaultEstablishmentId || settings.company.defaultEstablishmentId;
  const resolvedAgtEnv =
    settings.agtEnvironment === 'PRODUCAO' || settings.company.agtEnvironment === 'PRODUCAO'
      ? 'PRODUCAO'
      : 'SIMULACAO';

  const payload = {
    companyId,
    companyOwnerUid: ownerUid,
    updatedByUid: user.uid,
    legalName: (settings.company.legalName || DEFAULT_SETTINGS.company.legalName).slice(0, 160),
    shortName: (settings.company.shortName || DEFAULT_SETTINGS.company.shortName).slice(0, 64),
    nif: (settings.company.nif || DEFAULT_SETTINGS.company.nif).slice(0, 32),
    address: (settings.company.address || DEFAULT_SETTINGS.company.address).slice(0, 160),
    cityCountry: (settings.company.cityCountry || DEFAULT_SETTINGS.company.cityCountry).slice(0, 80),
    phone: (settings.company.phone || '').slice(0, 40),
    email: (settings.company.email || '').slice(0, 120),
    tagline: (settings.company.tagline || '').slice(0, 120),
    defaultCashier: (settings.defaultCashier || '01').slice(0, 16),
    defaultOperator: (settings.defaultOperator || '001').slice(0, 32),
    defaultFormat: settings.defaultFormat === 'A4' ? 'A4' : 'POS',
    defaultDocType: normalizeDocType(settings.defaultDocType),
    defaultNotes: (settings.defaultNotes || '').slice(0, 300),
    autoPrintOnEmit: Boolean(settings.autoPrintOnEmit),
    hidePromotionalFooter: Boolean(settings.hidePromotionalFooter ?? true),
    allowCashierPriceEdit: Boolean(settings.allowCashierPriceEdit ?? false),
    ...(resolvedEstablishmentId
      ? { defaultEstablishmentId: sanitizeId(resolvedEstablishmentId) }
      : {}),
    agtEnvironment: resolvedAgtEnv,
    masterProfile: buildMasterProfileMap(settings.company),
    updatedAt: serverTimestamp(),
  };

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, payload);
    } else {
      await updateDoc(ref, {
        updatedByUid: user.uid,
        legalName: payload.legalName,
        shortName: payload.shortName,
        address: payload.address,
        cityCountry: payload.cityCountry,
        phone: payload.phone,
        email: payload.email,
        tagline: payload.tagline,
        defaultCashier: payload.defaultCashier,
        defaultOperator: payload.defaultOperator,
        defaultFormat: payload.defaultFormat,
        defaultDocType: payload.defaultDocType,
        defaultNotes: payload.defaultNotes,
        autoPrintOnEmit: payload.autoPrintOnEmit,
        hidePromotionalFooter: payload.hidePromotionalFooter,
        allowCashierPriceEdit: payload.allowCashierPriceEdit,
        ...(resolvedEstablishmentId
          ? { defaultEstablishmentId: sanitizeId(resolvedEstablishmentId) }
          : {}),
        agtEnvironment: resolvedAgtEnv,
        masterProfile: payload.masterProfile,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, settingsPath);
  }
}

export async function upsertFiscalSeriesCloud(
  series: AgtSeriesRecord,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || series.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const seriesId = sanitizeId(series.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const seriesPath = `companies/${companyId}/fiscal_series/${seriesId}`;
  const ref = doc(db, 'companies', companyId, 'fiscal_series', seriesId);
  const env: AgtSeriesEnvironment = series.environment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO';
  const status: AgtSeriesStatus =
    series.status === 'F' ? 'F' : series.status === 'U' ? 'U' : 'A';

  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        id: seriesId,
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        seriesCode: String(series.seriesCode || '').slice(0, 16),
        seriesYear: Math.max(2020, Math.min(2100, Math.floor(series.seriesYear || new Date().getFullYear()))),
        documentType: String(series.documentType || 'FR').slice(0, 8),
        firstDocumentNumber: Math.max(1, Math.floor(series.firstDocumentNumber || 1)),
        lastDocumentNumber: Math.max(0, Math.floor(series.lastDocumentNumber || 0)),
        status,
        environment: env,
        ...(series.establishmentId ? { establishmentId: sanitizeId(series.establishmentId) } : {}),
        ...(series.establishmentCode
          ? { establishmentCode: String(series.establishmentCode).slice(0, 16) }
          : {}),
        ...(series.agtAuthorizationCode
          ? { agtAuthorizationCode: String(series.agtAuthorizationCode).slice(0, 64) }
          : {}),
        requestedAtIso: String(series.requestedAtIso || new Date().toISOString()).slice(0, 40),
        ...(series.authorizedAtIso
          ? { authorizedAtIso: String(series.authorizedAtIso).slice(0, 40) }
          : {}),
        ...(series.closedAtIso ? { closedAtIso: String(series.closedAtIso).slice(0, 40) } : {}),
        ...(series.notes ? { notes: String(series.notes).slice(0, 300) } : {}),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (snap.data()?.status !== 'F') {
      await updateDoc(ref, {
        updatedByUid: user.uid,
        lastDocumentNumber: Math.max(
          Number(snap.data()?.lastDocumentNumber) || 0,
          Math.max(0, Math.floor(series.lastDocumentNumber || 0))
        ),
        status,
        ...(series.closedAtIso ? { closedAtIso: String(series.closedAtIso).slice(0, 40) } : {}),
        ...(series.notes ? { notes: String(series.notes).slice(0, 300) } : {}),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, seriesPath);
  }
}

export async function upsertCashSessionCloud(
  session: CashSession,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || session.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const sessionId = sanitizeId(session.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const sessPath = `companies/${companyId}/cash_sessions/${sessionId}`;
  const sessRef = doc(db, 'companies', companyId, 'cash_sessions', sessionId);

  const optionalSummaryFields: Record<string, unknown> = {};
  if (session.openingNotes) optionalSummaryFields.openingNotes = session.openingNotes.slice(0, 240);
  if (session.closedAtIso) optionalSummaryFields.closedAtIso = session.closedAtIso.slice(0, 40);
  if (session.closedByOperator) {
    optionalSummaryFields.closedByOperator = session.closedByOperator.slice(0, 32);
  }
  if (session.closedByUid) {
    optionalSummaryFields.closedByUid = sanitizeId(session.closedByUid);
  }
  if (typeof session.expectedCash === 'number' && Number.isFinite(session.expectedCash)) {
    optionalSummaryFields.expectedCash = session.expectedCash;
  }
  if (typeof session.countedCash === 'number' && Number.isFinite(session.countedCash)) {
    optionalSummaryFields.countedCash = Math.max(0, session.countedCash);
  }
  if (typeof session.differenceAmount === 'number' && Number.isFinite(session.differenceAmount)) {
    optionalSummaryFields.differenceAmount = session.differenceAmount;
  }
  if (typeof session.salesCash === 'number' && session.salesCash >= 0) {
    optionalSummaryFields.salesCash = session.salesCash;
  }
  if (typeof session.salesMulticaixa === 'number' && session.salesMulticaixa >= 0) {
    optionalSummaryFields.salesMulticaixa = session.salesMulticaixa;
  }
  if (typeof session.salesTransfer === 'number' && session.salesTransfer >= 0) {
    optionalSummaryFields.salesTransfer = session.salesTransfer;
  }
  if (typeof session.salesCredit === 'number' && session.salesCredit >= 0) {
    optionalSummaryFields.salesCredit = session.salesCredit;
  }
  if (typeof session.debtCash === 'number' && session.debtCash >= 0) {
    optionalSummaryFields.debtCash = session.debtCash;
  }
  if (typeof session.debtMulticaixa === 'number' && session.debtMulticaixa >= 0) {
    optionalSummaryFields.debtMulticaixa = session.debtMulticaixa;
  }
  if (typeof session.debtTransfer === 'number' && session.debtTransfer >= 0) {
    optionalSummaryFields.debtTransfer = session.debtTransfer;
  }
  if (typeof session.reforcosTotal === 'number' && session.reforcosTotal >= 0) {
    optionalSummaryFields.reforcosTotal = session.reforcosTotal;
  }
  if (typeof session.entradasTotal === 'number' && session.entradasTotal >= 0) {
    optionalSummaryFields.entradasTotal = session.entradasTotal;
  }
  if (typeof session.sangriasTotal === 'number' && session.sangriasTotal >= 0) {
    optionalSummaryFields.sangriasTotal = session.sangriasTotal;
  }
  if (typeof session.saidasTotal === 'number' && session.saidasTotal >= 0) {
    optionalSummaryFields.saidasTotal = session.saidasTotal;
  }
  if (typeof session.invoiceCount === 'number' && session.invoiceCount >= 0) {
    optionalSummaryFields.invoiceCount = session.invoiceCount;
  }
  if (session.closingNotes) optionalSummaryFields.closingNotes = session.closingNotes.slice(0, 240);

  try {
    const snap = await getDoc(sessRef);
    if (!snap.exists()) {
      await setDoc(sessRef, {
        id: sessionId,
        companyId,
        companyOwnerUid: ownerUid,
        openedByUid: sanitizeId(session.openedByUid || user.uid),
        updatedByUid: user.uid,
        cashier: (session.cashier || '01').slice(0, 16),
        operator: (session.operator || '001').slice(0, 32),
        status: session.status === 'closed' ? 'closed' : 'open',
        openingFloat: Math.min(999999999, Math.max(0, Number(session.openingFloat) || 0)),
        openedAtIso: (session.openedAtIso || new Date().toISOString()).slice(0, 40),
        ...optionalSummaryFields,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (snap.data()?.status === 'open') {
      await updateDoc(sessRef, {
        updatedByUid: user.uid,
        status: session.status === 'closed' ? 'closed' : 'open',
        ...optionalSummaryFields,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, sessPath);
  }
}

export async function createCashMovementCloud(
  movement: CashMovement,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const rawCompanyId = company?.id || movement.companyId || '';
  if (!rawCompanyId) return;
  const companyId = sanitizeId(rawCompanyId);
  const movementId = sanitizeId(movement.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const movPath = `companies/${companyId}/cash_movements/${movementId}`;
  const movRef = doc(db, 'companies', companyId, 'cash_movements', movementId);

  try {
    const existing = await getDoc(movRef);
    if (existing.exists()) return;

    const validEntryKind =
      movement.entryKind === 'DESPESA_OPERACIONAL' ||
      movement.entryKind === 'RECEITA_EXTRAORDINARIA' ||
      movement.entryKind === 'PAGAMENTO_FORNECEDOR' ||
      movement.entryKind === 'MOVIMENTO_CAIXA'
        ? movement.entryKind
        : undefined;

    await setDoc(movRef, {
      id: movementId,
      companyId,
      companyOwnerUid: ownerUid,
      createdByUid: user.uid,
      sessionId: sanitizeId(movement.sessionId || 'unassigned'),
      cashier: (movement.cashier || '01').slice(0, 16),
      operator: (movement.operator || '001').slice(0, 32),
      type: movement.type,
      ...(validEntryKind ? { entryKind: validEntryKind } : {}),
      ...(movement.category ? { category: movement.category.trim().slice(0, 64) } : {}),
      amount: Math.min(999999999, Math.max(0.01, Number(movement.amount) || 0.01)),
      paymentMethod:
        movement.paymentMethod === 'Multicaixa'
          ? 'Multicaixa'
          : movement.paymentMethod === 'Transferência'
            ? 'Transferência'
            : 'Dinheiro',
      reason: (movement.reason || 'Movimento de caixa').trim().slice(0, 240) || 'Movimento de caixa',
      ...(movement.reference ? { reference: movement.reference.slice(0, 80) } : {}),
      ...(movement.invoiceId ? { invoiceId: sanitizeId(movement.invoiceId) } : {}),
      ...(movement.invoiceNumber ? { invoiceNumber: movement.invoiceNumber.slice(0, 40) } : {}),
      ...(movement.customerName ? { customerName: movement.customerName.slice(0, 160) } : {}),
      ...(movement.purchaseId ? { purchaseId: sanitizeId(movement.purchaseId) } : {}),
      createdAtIso: (movement.createdAtIso || new Date().toISOString()).slice(0, 40),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, movPath);
  }
}

export async function createStockMovementCloud(
  movement: StockMovement,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const rawCompanyId = movement.companyId || company?.id || '';
  if (!rawCompanyId) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const companyId = sanitizeId(rawCompanyId);
  const movementId = sanitizeId(movement.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const stockMovPath = `companies/${companyId}/stock_movements/${movementId}`;
  const stockMovRef = doc(db, 'companies', companyId, 'stock_movements', movementId);

  const validType: StockMovementType =
    movement.type === 'ENTRADA_MERCADORIA' ||
    movement.type === 'SAIDA_VENDA' ||
    movement.type === 'DEVOLUCAO_CLIENTE' ||
    movement.type === 'AJUSTE_INVENTARIO' ||
    movement.type === 'RECONCILIACAO_FISICA' ||
    movement.type === 'TRANSFERENCIA_ARMAZEM'
      ? movement.type
      : 'AJUSTE_INVENTARIO';

  const validDirection: StockMovementDirection =
    movement.direction === 'IN' || movement.direction === 'OUT' || movement.direction === 'NEUTRAL'
      ? movement.direction
      : 'NEUTRAL';

  try {
    const existing = await getDoc(stockMovRef);
    if (existing.exists()) return;

    const cleanRef = movement.reference ? movement.reference.trim().slice(0, 80) : '';
    const cleanTargetWh = movement.targetWarehouseId
      ? sanitizeId(movement.targetWarehouseId).slice(0, 64)
      : '';

    await setDoc(stockMovRef, {
      id: movementId,
      companyId,
      companyOwnerUid: ownerUid,
      createdByUid: user.uid,
      productId: sanitizeId(movement.productId || 'prod_default'),
      productCode: (movement.productCode || 'SKU').trim().slice(0, 32) || 'SKU',
      productName: (movement.productName || 'Artigo').trim().slice(0, 160) || 'Artigo',
      unit: (movement.unit || 'un').trim().slice(0, 16) || 'un',
      type: validType,
      direction: validDirection,
      qty: Math.min(999999999, Math.max(0, Number(movement.qty) || 0)),
      previousStock: Math.min(999999999, Math.max(-999999, Number(movement.previousStock) || 0)),
      newStock: Math.min(999999999, Math.max(-999999, Number(movement.newStock) || 0)),
      ...(typeof movement.unitCost === 'number' &&
      Number.isFinite(movement.unitCost) &&
      movement.unitCost >= 0
        ? { unitCost: Math.min(999999999, movement.unitCost) }
        : {}),
      warehouseId: sanitizeId(movement.warehouseId || DEFAULT_WAREHOUSE_ID).slice(0, 64),
      ...(cleanTargetWh ? { targetWarehouseId: cleanTargetWh } : {}),
      reason: (movement.reason || 'Movimento de stock').trim().slice(0, 240) || 'Movimento de stock',
      ...(cleanRef ? { reference: cleanRef } : {}),
      ...(movement.invoiceId ? { invoiceId: sanitizeId(movement.invoiceId) } : {}),
      ...(movement.invoiceNumber ? { invoiceNumber: movement.invoiceNumber.trim().slice(0, 40) } : {}),
      operator: (movement.operator || '001').trim().slice(0, 32) || '001',
      createdAtIso: (movement.createdAtIso || new Date().toISOString()).slice(0, 40),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, stockMovPath);
  }
}

export async function upsertSupplierCloud(
  supplier: Supplier,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const rawCompanyId = supplier.companyId || company?.id || '';
  if (!rawCompanyId) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const companyId = sanitizeId(rawCompanyId);
  const supplierId = sanitizeId(supplier.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const supPath = `companies/${companyId}/suppliers/${supplierId}`;
  const supRef = doc(db, 'companies', companyId, 'suppliers', supplierId);
  const privRef = doc(db, 'companies', companyId, 'suppliers', supplierId, 'private', 'contact');

  try {
    const existing = await getDoc(supRef);
    const batch = writeBatch(db);

    const commonPayload: Record<string, unknown> = {
      updatedByUid: user.uid,
      name: (supplier.name || 'Fornecedor').trim().slice(0, 160) || 'Fornecedor',
      nif: (supplier.nif || '').trim().slice(0, 32),
      locality: (supplier.locality || '').trim().slice(0, 160),
      active: supplier.active !== false,
      updatedAt: serverTimestamp(),
      ...(supplier.contactPerson
        ? { contactPerson: supplier.contactPerson.trim().slice(0, 120) }
        : {}),
      ...(supplier.iban ? { iban: supplier.iban.trim().slice(0, 48) } : {}),
      ...(typeof supplier.paymentTermsDays === 'number' &&
      Number.isFinite(supplier.paymentTermsDays) &&
      supplier.paymentTermsDays >= 0
        ? { paymentTermsDays: Math.min(3650, Math.round(supplier.paymentTermsDays)) }
        : {}),
      ...(supplier.notes ? { notes: supplier.notes.trim().slice(0, 300) } : {}),
    };

    if (!existing.exists()) {
      batch.set(supRef, {
        id: supplierId,
        companyId,
        companyOwnerUid: ownerUid,
        ...commonPayload,
        createdAt: serverTimestamp(),
      });
    } else {
      batch.update(supRef, commonPayload);
    }

    const privSnap = await getDoc(privRef).catch(() => null);
    if (!privSnap || !privSnap.exists()) {
      batch.set(privRef, {
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        phone: (supplier.phone || '').trim().slice(0, 40),
        email: (supplier.email || '').trim().slice(0, 120),
        address: (supplier.address || '').trim().slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(privRef, {
        updatedByUid: user.uid,
        phone: (supplier.phone || '').trim().slice(0, 40),
        email: (supplier.email || '').trim().slice(0, 120),
        address: (supplier.address || '').trim().slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, supPath);
  }
}

export async function removeSupplierCloud(
  supplierIdRaw: string,
  companyIdRaw: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw || !supplierIdRaw) return;

  const companyId = sanitizeId(companyIdRaw);
  const supplierId = sanitizeId(supplierIdRaw);
  if (companyId === JAIMONA_COMPANY_ID && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const supPath = `companies/${companyId}/suppliers/${supplierId}`;
  const supRef = doc(db, 'companies', companyId, 'suppliers', supplierId);
  const privRef = doc(db, 'companies', companyId, 'suppliers', supplierId, 'private', 'contact');

  try {
    const batch = writeBatch(db);
    batch.delete(privRef);
    batch.delete(supRef);
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, supPath);
  }
}

export async function upsertPurchaseCloud(
  purchase: PurchaseRecord,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const rawCompanyId = purchase.companyId || company?.id || '';
  if (!rawCompanyId) return;
  if (company && !canCompanySyncCloudData(company)) return;

  const companyId = sanitizeId(rawCompanyId);
  const purchaseId = sanitizeId(purchase.id);
  const ownerUid = company?.ownerUid || user.uid;
  if (companyId === JAIMONA_COMPANY_ID && !company?.ownerUid && !isJaimonaOwnerEmail(user.email)) {
    return;
  }

  const purPath = `companies/${companyId}/purchases/${purchaseId}`;
  const purRef = doc(db, 'companies', companyId, 'purchases', purchaseId);

  const validPm: PurchasePaymentMethod =
    purchase.paymentMethod === 'Multicaixa' ||
    purchase.paymentMethod === 'Transferência' ||
    purchase.paymentMethod === 'Crédito'
      ? purchase.paymentMethod
      : 'Dinheiro';

  try {
    const existing = await getDoc(purRef);
    if (!existing.exists()) {
      const batch = writeBatch(db);
      const safeLines = (purchase.lines || []).slice(0, 200);
      const itemCount = Math.max(1, safeLines.length);

      batch.set(purRef, {
        id: purchaseId,
        companyId,
        companyOwnerUid: ownerUid,
        createdByUid: user.uid,
        updatedByUid: user.uid,
        number: (purchase.number || 'CMP 001').trim().slice(0, 40) || 'CMP 001',
        ...(purchase.supplierInvoiceRef
          ? { supplierInvoiceRef: purchase.supplierInvoiceRef.trim().slice(0, 60) }
          : {}),
        supplierId: sanitizeId(purchase.supplierId || 'sup_default'),
        supplierName: (purchase.supplierName || 'Fornecedor').trim().slice(0, 160) || 'Fornecedor',
        supplierNif: (purchase.supplierNif || '').trim().slice(0, 32),
        issuedAtIso: (purchase.issuedAtIso || new Date().toISOString()).slice(0, 40),
        ...(purchase.dueDateIso ? { dueDateIso: purchase.dueDateIso.slice(0, 40) } : {}),
        totalAmount: Math.min(999999999, Math.max(0, Number(purchase.totalAmount) || 0)),
        amountPaid: Math.min(999999999, Math.max(0, Number(purchase.amountPaid) || 0)),
        amountDue: Math.min(999999999, Math.max(0, Number(purchase.amountDue) || 0)),
        paymentMethod: validPm,
        ...(purchase.paymentSummary
          ? { paymentSummary: purchase.paymentSummary.trim().slice(0, 160) }
          : {}),
        ...(purchase.reference ? { reference: purchase.reference.trim().slice(0, 80) } : {}),
        warehouseId: sanitizeId(purchase.warehouseId || DEFAULT_WAREHOUSE_ID).slice(0, 64),
        updateStock: Boolean(purchase.updateStock),
        notes: (purchase.notes || '').trim().slice(0, 300),
        operator: (purchase.operator || '001').trim().slice(0, 32) || '001',
        itemCount,
        status: 'recorded',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      safeLines.forEach((line, idx) => {
        const itemId = sanitizeId(`item_${idx + 1}_${line.productId || idx}`);
        const itemRef = doc(db, 'companies', companyId, 'purchases', purchaseId, 'items', itemId);
        batch.set(itemRef, {
          id: itemId,
          purchaseId,
          companyId,
          companyOwnerUid: ownerUid,
          productId: sanitizeId(line.productId || 'prod_default'),
          code: (line.code || 'SKU').trim().slice(0, 32) || 'SKU',
          name: (line.name || 'Artigo').trim().slice(0, 160) || 'Artigo',
          unit: (line.unit || 'UN').trim().slice(0, 16) || 'UN',
          qty: Math.min(1000000, Math.max(0.0001, Number(line.qty) || 1)),
          unitCost: Math.min(999999999, Math.max(0, Number(line.unitCost) || 0)),
          total: Math.min(999999999, Math.max(0, Number(line.total) || 0)),
          createdAt: serverTimestamp(),
        });
      });

      await batch.commit();

      // Caso tenha sido criada localmente e logo anulada antes da primeira sincronização
      if (purchase.status === 'cancelled') {
        const reason =
          (purchase.cancelReason || 'Anulada pelo utilizador').trim().slice(0, 240);
        await updateDoc(purRef, {
          updatedByUid: user.uid,
          status: 'cancelled',
          cancelReason: reason.length >= 4 ? reason : 'Anulada',
          cancelledBy: (purchase.cancelledBy || user.email || 'Operador').trim().slice(0, 120),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    const existingData = existing.data();
    if (existingData.status === 'cancelled') return;

    if (purchase.status === 'cancelled') {
      const reason = (purchase.cancelReason || 'Anulada pelo utilizador').trim().slice(0, 240);
      await updateDoc(purRef, {
        updatedByUid: user.uid,
        status: 'cancelled',
        cancelReason: reason.length >= 4 ? reason : 'Anulada',
        cancelledBy: (purchase.cancelledBy || user.email || 'Operador').trim().slice(0, 120),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(purRef, {
        updatedByUid: user.uid,
        amountPaid: Math.min(999999999, Math.max(0, Number(purchase.amountPaid) || 0)),
        amountDue: Math.min(999999999, Math.max(0, Number(purchase.amountDue) || 0)),
        paymentMethod: validPm,
        ...(purchase.paymentSummary
          ? { paymentSummary: purchase.paymentSummary.trim().slice(0, 160) }
          : {}),
        ...(purchase.reference ? { reference: purchase.reference.trim().slice(0, 80) } : {}),
        notes: (purchase.notes || '').trim().slice(0, 300),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, purPath);
  }
}

export async function pullCompanyFromCloud(companyIdRaw: string): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
  stockMovements: StockMovement[];
  suppliers: Supplier[];
  purchases: PurchaseRecord[];
  fiscalSeries?: AgtSeriesRecord[];
  settings: AppSettings | null;
} | null> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return null;

  const companyId = sanitizeId(companyIdRaw);

  // Proteção estrita: nunca executar queries client-side de proprietário em comp_jaimona
  // quando autenticado com outra conta (ex.: Super-Admin ou terceiros)
  if (companyId === JAIMONA_COMPANY_ID && !isJaimonaOwnerEmail(user.email)) {
    return null;
  }

  const compDocSnap = await getDoc(doc(db, 'companies', companyId)).catch(() => null);
  if (
    compDocSnap &&
    compDocSnap.exists() &&
    compDocSnap.data().ownerUid &&
    compDocSnap.data().ownerUid !== user.uid
  ) {
    return null;
  }

  if (compDocSnap && compDocSnap.exists() && companyId !== JAIMONA_COMPANY_ID) {
    const cloudTier = compDocSnap.data().planTier;
    if (cloudTier !== 'PROFISSIONAL' && cloudTier !== 'ENTERPRISE') {
      return null;
    }
  }

  const prodPath = `companies/${companyId}/products`;
  const custPath = `companies/${companyId}/customers`;
  const invPath = `companies/${companyId}/invoices`;
  const sessPath = `companies/${companyId}/cash_sessions`;
  const movPath = `companies/${companyId}/cash_movements`;
  const stockMovPath = `companies/${companyId}/stock_movements`;
  const supPath = `companies/${companyId}/suppliers`;
  const purPath = `companies/${companyId}/purchases`;
  const seriesPath = `companies/${companyId}/fiscal_series`;
  const settingsRef = doc(db, 'companies', companyId, 'settings', 'general');

  try {
    const [
      prodSnap,
      custSnap,
      invSnap,
      sessSnap,
      movSnap,
      stockMovSnap,
      supSnap,
      purSnap,
      seriesSnap,
      settingsSnap,
    ] = await Promise.all([
      getDocs(
        query(
          collection(db, prodPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ),
      getDocs(
        query(
          collection(db, custPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ),
      getDocs(
        query(
          collection(db, invPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ),
      getDocs(
        query(
          collection(db, sessPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, movPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, stockMovPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, supPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, purPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDocs(
        query(
          collection(db, seriesPath),
          where('companyId', '==', companyId),
          where('companyOwnerUid', '==', user.uid)
        )
      ).catch(() => null),
      getDoc(settingsRef).catch(() => null),
    ]);

    // Migração transparente /users/{uid}/... estritamente restrita ao e-mail titular da JAIMONA
    if (
      companyId === JAIMONA_COMPANY_ID &&
      isJaimonaOwnerEmail(user.email) &&
      prodSnap.empty &&
      custSnap.empty &&
      invSnap.empty &&
      (!settingsSnap || !settingsSnap.exists())
    ) {
      return pullLegacyJaimonaFromCloud();
    }

    const products: Product[] = prodSnap.docs.map((d) => {
      const data = d.data();
      const history = sanitizePriceHistory(data.priceHistory as ProductPriceChange[] | undefined);
      const pt =
        data.productType === 'P' || data.productType === 'S' || data.productType === 'K'
          ? (data.productType as ProductType)
          : undefined;
      return {
        id: data.id,
        companyId,
        code: data.code,
        ...(data.barcode ? { barcode: String(data.barcode) } : {}),
        name: data.name,
        ...(pt ? { productType: pt } : {}),
        category: data.category || 'Geral',
        unit: data.unit,
        ...(typeof data.costPrice === 'number' && data.costPrice > 0
          ? { costPrice: Number(data.costPrice) }
          : {}),
        price: data.price,
        ivaRate: normalizeTaxRate(data.ivaRate),
        ...(data.exemptionCode
          ? { exemptionCode: String(data.exemptionCode) as AgtIvaExemptionCode }
          : {}),
        exemptionReason: data.exemptionReason || '',
        active: Boolean(data.active),
        ...(typeof data.trackStock === 'boolean'
          ? {
              trackStock: data.trackStock,
              stockQty: Number(data.stockQty) || 0,
              minStockQty: Math.max(0, Number(data.minStockQty) || 0),
            }
          : {}),
        ...(history.length > 0 ? { priceHistory: history } : {}),
        syncState: 'synced',
        synced: true,
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      };
    });

    const customers: Customer[] = await Promise.all(
      custSnap.docs.map(async (d) => {
        const data = d.data();
        let phone = '';
        let address = '';
        try {
          const privSnap = await getDoc(
            doc(db, 'companies', companyId, 'customers', data.id, 'private', 'contact')
          );
          if (privSnap.exists()) {
            phone = privSnap.data().phone || '';
            address = privSnap.data().address || '';
          }
        } catch {
          // Ignore missing private doc
        }
        return {
          id: data.id,
          companyId,
          name: data.name,
          nif: data.nif || '',
          locality: data.locality || '',
          phone,
          address,
          ...(typeof data.creditLimit === 'number' && data.creditLimit > 0
            ? { creditLimit: data.creditLimit }
            : {}),
          syncState: 'synced',
          synced: true,
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
        };
      })
    );

    const invoices: InvoiceRecord[] = await Promise.all(
      invSnap.docs.map(async (d) => {
        const data = d.data();
        const itemsPath = `companies/${companyId}/invoices/${data.id}/items`;
        const itemsSnap = await getDocs(
          query(
            collection(db, itemsPath),
            where('companyId', '==', companyId),
            where('companyOwnerUid', '==', user.uid)
          )
        );
        const lines: CalculatedLineItem[] = itemsSnap.docs.map((itemDoc) => {
          const it = itemDoc.data();
          return {
            id: it.id,
            productId: it.id,
            code: it.code,
            description: it.description,
            unit: it.unit,
            qty: it.qty,
            unitPrice: it.unitPrice,
            discountPct: it.discountPct,
            ivaRate: normalizeTaxRate(it.ivaRate),
            ...(it.exemptionCode
              ? { exemptionCode: String(it.exemptionCode) as AgtIvaExemptionCode }
              : {}),
            lineGross: it.lineGross,
            lineDiscount: Math.max(0, it.lineGross - it.lineNet),
            lineNet: it.lineNet,
            lineBase: it.lineBase,
            lineTax: it.lineTax,
            lineTotal: it.lineTotal,
          };
        });

        return {
          id: data.id,
          companyId,
          number: data.number,
          docType: normalizeDocType(data.docType),
          issuedAtIso: data.issuedAtIso,
          cashier: data.cashier,
          operator: data.operator,
          paymentMethod: data.paymentMethod,
          customerId: data.customerId,
          customerName: data.customerName,
          customerNif: data.customerNif,
          customerLocality: data.customerLocality,
          merchandiseTotal: data.merchandiseTotal,
          discountTotal: data.discountTotal,
          globalDiscountPct: typeof data.globalDiscountPct === 'number' ? data.globalDiscountPct : undefined,
          globalDiscountAmount: typeof data.globalDiscountAmount === 'number' ? data.globalDiscountAmount : undefined,
          taxBase14: data.taxBase14,
          taxAmount14: data.taxAmount14,
          ...(typeof data.taxBaseIntermediate === 'number'
            ? { taxBaseIntermediate: data.taxBaseIntermediate }
            : {}),
          ...(typeof data.taxAmountIntermediate === 'number'
            ? { taxAmountIntermediate: data.taxAmountIntermediate }
            : {}),
          ...(typeof data.taxBaseReduced === 'number'
            ? { taxBaseReduced: data.taxBaseReduced }
            : {}),
          ...(typeof data.taxAmountReduced === 'number'
            ? { taxAmountReduced: data.taxAmountReduced }
            : {}),
          taxBase0: data.taxBase0,
          taxAmount0: 0,
          taxTotal: data.taxTotal,
          grandTotal: data.grandTotal,
          amountInWords: data.amountInWords,
          ...(data.issuerSnapshot && typeof data.issuerSnapshot === 'object'
            ? { issuerSnapshot: data.issuerSnapshot as InvoiceIssuerSnapshot }
            : {}),
          ...(data.establishmentId ? { establishmentId: String(data.establishmentId) } : {}),
          ...(data.establishmentCode ? { establishmentCode: String(data.establishmentCode) } : {}),
          ...(data.establishmentName ? { establishmentName: String(data.establishmentName) } : {}),
          ...(data.seriesCode ? { seriesCode: String(data.seriesCode) } : {}),
          ...(data.seriesEnvironment
            ? {
                seriesEnvironment: (data.seriesEnvironment === 'PRODUCAO'
                  ? 'PRODUCAO'
                  : 'SIMULACAO') as AgtSeriesEnvironment,
              }
            : {}),
          ...(data.agtAuthorizationCode
            ? { agtAuthorizationCode: String(data.agtAuthorizationCode) }
            : {}),
          ...(data.saftHash4 ? { saftHash4: String(data.saftHash4) } : {}),
          sessionId: data.sessionId ? String(data.sessionId) : undefined,
          amountReceived: data.amountReceived,
          initialAmountReceived:
            typeof data.initialAmountReceived === 'number' ? data.initialAmountReceived : undefined,
          changeAmount: data.changeAmount,
          initialChangeAmount:
            typeof data.initialChangeAmount === 'number' ? data.initialChangeAmount : undefined,
          amountDue: typeof data.amountDue === 'number' ? data.amountDue : undefined,
          transferReference: data.transferReference || undefined,
          paymentSplits: Array.isArray(data.paymentSplits)
            ? (data.paymentSplits as Array<Record<string, unknown>>)
                .filter(
                  (sp) =>
                    sp &&
                    (sp.method === 'Dinheiro' ||
                      sp.method === 'Multicaixa' ||
                      sp.method === 'Transferência') &&
                    Number(sp.amount) > 0
                )
                .map((sp) => ({
                  method: sp.method as DirectPaymentMethod,
                  amount: Number(sp.amount),
                  ...(sp.reference ? { reference: String(sp.reference) } : {}),
                }))
            : undefined,
          paymentSummary: data.paymentSummary || undefined,
          returnOriginInvoiceId: data.returnOriginInvoiceId || undefined,
          returnOriginNumber: data.returnOriginNumber || undefined,
          returnCreditApplied: typeof data.returnCreditApplied === 'number' ? data.returnCreditApplied : undefined,
          notes: data.notes || '',
          status: data.status === 'cancelled' ? 'cancelled' : 'issued',
          cancelReason: data.cancelReason || undefined,
          cancelledBy: data.cancelledBy || undefined,
          cancelledAtIso: data.cancelledAtIso ? String(data.cancelledAtIso) : undefined,
          reprintCount: typeof data.reprintCount === 'number' ? data.reprintCount : undefined,
          lastReprintedAtIso: data.lastReprintedAtIso ? String(data.lastReprintedAtIso) : undefined,
          lastReprintedBy: data.lastReprintedBy ? String(data.lastReprintedBy) : undefined,
          lines,
          syncState: 'synced',
          synced: true,
          createdAtIso: data.issuedAtIso,
          updatedAtIso: data.cancelledAtIso ? String(data.cancelledAtIso) : data.issuedAtIso,
        };
      })
    );

    const fiscalSeries: AgtSeriesRecord[] = (seriesSnap?.docs || []).map((d) => {
      const sd = d.data();
      return {
        id: String(sd.id || d.id),
        companyId,
        seriesCode: String(sd.seriesCode || ''),
        seriesYear: Number(sd.seriesYear) || new Date().getFullYear(),
        documentType: String(sd.documentType || 'FR') as AgtDocumentType,
        firstDocumentNumber: Number(sd.firstDocumentNumber) || 1,
        lastDocumentNumber: Number(sd.lastDocumentNumber) || 0,
        status: (sd.status === 'F' ? 'F' : sd.status === 'U' ? 'U' : 'A') as AgtSeriesStatus,
        environment: (sd.environment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO') as AgtSeriesEnvironment,
        ...(sd.establishmentId ? { establishmentId: String(sd.establishmentId) } : {}),
        ...(sd.establishmentCode ? { establishmentCode: String(sd.establishmentCode) } : {}),
        ...(sd.agtAuthorizationCode
          ? { agtAuthorizationCode: String(sd.agtAuthorizationCode) }
          : {}),
        requestedAtIso: String(sd.requestedAtIso || new Date().toISOString()),
        ...(sd.authorizedAtIso ? { authorizedAtIso: String(sd.authorizedAtIso) } : {}),
        ...(sd.closedAtIso ? { closedAtIso: String(sd.closedAtIso) } : {}),
        ...(sd.notes ? { notes: String(sd.notes) } : {}),
      };
    });

    const cashSessions: CashSession[] = (sessSnap?.docs || []).map((d) => {
      const data = d.data();
      const openedAtIso = String(data.openedAtIso || new Date().toISOString());
      return {
        id: String(data.id || d.id),
        companyId,
        cashier: String(data.cashier || '01'),
        operator: String(data.operator || '001'),
        openedByUid: data.openedByUid ? String(data.openedByUid) : undefined,
        closedByOperator: data.closedByOperator ? String(data.closedByOperator) : undefined,
        closedByUid: data.closedByUid ? String(data.closedByUid) : undefined,
        status: data.status === 'closed' ? 'closed' : 'open',
        openingFloat: Number(data.openingFloat) || 0,
        openingNotes: data.openingNotes ? String(data.openingNotes) : undefined,
        openedAtIso,
        closedAtIso: data.closedAtIso ? String(data.closedAtIso) : undefined,
        expectedCash: typeof data.expectedCash === 'number' ? data.expectedCash : undefined,
        countedCash: typeof data.countedCash === 'number' ? data.countedCash : undefined,
        differenceAmount:
          typeof data.differenceAmount === 'number' ? data.differenceAmount : undefined,
        salesCash: typeof data.salesCash === 'number' ? data.salesCash : undefined,
        salesMulticaixa: typeof data.salesMulticaixa === 'number' ? data.salesMulticaixa : undefined,
        salesTransfer: typeof data.salesTransfer === 'number' ? data.salesTransfer : undefined,
        salesCredit: typeof data.salesCredit === 'number' ? data.salesCredit : undefined,
        debtCash: typeof data.debtCash === 'number' ? data.debtCash : undefined,
        debtMulticaixa: typeof data.debtMulticaixa === 'number' ? data.debtMulticaixa : undefined,
        debtTransfer: typeof data.debtTransfer === 'number' ? data.debtTransfer : undefined,
        reforcosTotal: typeof data.reforcosTotal === 'number' ? data.reforcosTotal : undefined,
        entradasTotal: typeof data.entradasTotal === 'number' ? data.entradasTotal : undefined,
        sangriasTotal: typeof data.sangriasTotal === 'number' ? data.sangriasTotal : undefined,
        saidasTotal: typeof data.saidasTotal === 'number' ? data.saidasTotal : undefined,
        invoiceCount: typeof data.invoiceCount === 'number' ? data.invoiceCount : undefined,
        closingNotes: data.closingNotes ? String(data.closingNotes) : undefined,
        syncState: 'synced',
        synced: true,
        createdAtIso: openedAtIso,
        updatedAtIso: String(data.closedAtIso || openedAtIso),
      };
    });

    const cashMovements: CashMovement[] = (movSnap?.docs || []).map((d) => {
      const data = d.data();
      const rawType = String(data.type || 'ENTRADA') as CashMovementType;
      const validType: CashMovementType =
        rawType === 'REFORCO' ||
        rawType === 'SANGRIA' ||
        rawType === 'ENTRADA' ||
        rawType === 'SAIDA' ||
        rawType === 'LIQUIDACAO_DIVIDA'
          ? rawType
          : 'ENTRADA';
      const pm: DirectPaymentMethod =
        data.paymentMethod === 'Multicaixa'
          ? 'Multicaixa'
          : data.paymentMethod === 'Transferência'
            ? 'Transferência'
            : 'Dinheiro';
      const rawKind = String(data.entryKind || '');
      const validEntryKind =
        rawKind === 'DESPESA_OPERACIONAL' ||
        rawKind === 'RECEITA_EXTRAORDINARIA' ||
        rawKind === 'PAGAMENTO_FORNECEDOR' ||
        rawKind === 'MOVIMENTO_CAIXA'
          ? (rawKind as CashMovement['entryKind'])
          : undefined;
      return {
        id: String(data.id || d.id),
        companyId,
        sessionId: String(data.sessionId || 'unassigned'),
        cashier: String(data.cashier || '01'),
        operator: String(data.operator || '001'),
        type: validType,
        ...(validEntryKind ? { entryKind: validEntryKind } : {}),
        ...(data.category ? { category: String(data.category) } : {}),
        amount: Number(data.amount) || 0,
        paymentMethod: pm,
        reason: String(data.reason || ''),
        reference: data.reference ? String(data.reference) : undefined,
        invoiceId: data.invoiceId ? String(data.invoiceId) : undefined,
        invoiceNumber: data.invoiceNumber ? String(data.invoiceNumber) : undefined,
        customerName: data.customerName ? String(data.customerName) : undefined,
        purchaseId: data.purchaseId ? String(data.purchaseId) : undefined,
        createdByUid: data.createdByUid ? String(data.createdByUid) : undefined,
        syncState: 'synced',
        synced: true,
        createdAtIso: String(data.createdAtIso || new Date().toISOString()),
      };
    });

    const stockMovements: StockMovement[] = (stockMovSnap?.docs || []).map((d) => {
      const data = d.data();
      const rawType = String(data.type || 'AJUSTE_INVENTARIO') as StockMovementType;
      const validType: StockMovementType =
        rawType === 'ENTRADA_MERCADORIA' ||
        rawType === 'SAIDA_VENDA' ||
        rawType === 'DEVOLUCAO_CLIENTE' ||
        rawType === 'AJUSTE_INVENTARIO' ||
        rawType === 'RECONCILIACAO_FISICA' ||
        rawType === 'TRANSFERENCIA_ARMAZEM'
          ? rawType
          : 'AJUSTE_INVENTARIO';
      const rawDir = String(data.direction || 'NEUTRAL') as StockMovementDirection;
      const validDir: StockMovementDirection =
        rawDir === 'IN' || rawDir === 'OUT' || rawDir === 'NEUTRAL' ? rawDir : 'NEUTRAL';
      return {
        id: String(data.id || d.id),
        companyId,
        productId: String(data.productId || ''),
        productCode: String(data.productCode || ''),
        productName: String(data.productName || ''),
        unit: String(data.unit || 'un'),
        type: validType,
        direction: validDir,
        qty: Number(data.qty) || 0,
        previousStock: Number(data.previousStock) || 0,
        newStock: Number(data.newStock) || 0,
        ...(typeof data.unitCost === 'number' ? { unitCost: Number(data.unitCost) } : {}),
        warehouseId: String(data.warehouseId || DEFAULT_WAREHOUSE_ID),
        ...(data.targetWarehouseId ? { targetWarehouseId: String(data.targetWarehouseId) } : {}),
        reason: String(data.reason || ''),
        ...(data.reference ? { reference: String(data.reference) } : {}),
        ...(data.invoiceId ? { invoiceId: String(data.invoiceId) } : {}),
        ...(data.invoiceNumber ? { invoiceNumber: String(data.invoiceNumber) } : {}),
        operator: String(data.operator || '001'),
        ...(data.createdByUid ? { createdByUid: String(data.createdByUid) } : {}),
        syncState: 'synced',
        synced: true,
        createdAtIso: String(data.createdAtIso || new Date().toISOString()),
      };
    });

    const suppliers: Supplier[] = await Promise.all(
      (supSnap?.docs || []).map(async (d) => {
        const data = d.data();
        const supId = String(data.id || d.id);
        let phone = '';
        let email = '';
        let address = '';
        try {
          const privSnap = await getDoc(
            doc(db, 'companies', companyId, 'suppliers', supId, 'private', 'contact')
          );
          if (privSnap.exists()) {
            phone = String(privSnap.data().phone || '');
            email = String(privSnap.data().email || '');
            address = String(privSnap.data().address || '');
          }
        } catch {
          // Ignore missing private doc
        }
        return {
          id: supId,
          companyId,
          name: String(data.name || ''),
          nif: String(data.nif || ''),
          phone,
          ...(email ? { email } : {}),
          address,
          locality: String(data.locality || ''),
          ...(data.contactPerson ? { contactPerson: String(data.contactPerson) } : {}),
          ...(data.iban ? { iban: String(data.iban) } : {}),
          ...(typeof data.paymentTermsDays === 'number'
            ? { paymentTermsDays: Number(data.paymentTermsDays) }
            : {}),
          ...(data.notes ? { notes: String(data.notes) } : {}),
          active: data.active !== false,
          syncState: 'synced',
          synced: true,
          updatedAtIso: new Date().toISOString(),
        };
      })
    );

    const purchases: PurchaseRecord[] = await Promise.all(
      (purSnap?.docs || []).map(async (d) => {
        const data = d.data();
        const purId = String(data.id || d.id);
        const itemsPath = `companies/${companyId}/purchases/${purId}/items`;
        const itemsSnap = await getDocs(
          query(
            collection(db, itemsPath),
            where('companyId', '==', companyId),
            where('companyOwnerUid', '==', user.uid)
          )
        ).catch(() => null);

        const lines: PurchaseLineItem[] = (itemsSnap?.docs || []).map((itemDoc) => {
          const it = itemDoc.data();
          return {
            productId: String(it.productId || ''),
            code: String(it.code || ''),
            name: String(it.name || ''),
            unit: String(it.unit || 'UN'),
            qty: Number(it.qty) || 0,
            unitCost: Number(it.unitCost) || 0,
            total: Number(it.total) || 0,
          };
        });

        const pm: PurchasePaymentMethod =
          data.paymentMethod === 'Multicaixa' ||
          data.paymentMethod === 'Transferência' ||
          data.paymentMethod === 'Crédito'
            ? data.paymentMethod
            : 'Dinheiro';

        return {
          id: purId,
          companyId,
          number: String(data.number || ''),
          ...(data.supplierInvoiceRef
            ? { supplierInvoiceRef: String(data.supplierInvoiceRef) }
            : {}),
          supplierId: String(data.supplierId || ''),
          supplierName: String(data.supplierName || ''),
          supplierNif: String(data.supplierNif || ''),
          issuedAtIso: String(data.issuedAtIso || new Date().toISOString()),
          ...(data.dueDateIso ? { dueDateIso: String(data.dueDateIso) } : {}),
          lines,
          totalAmount: Number(data.totalAmount) || 0,
          amountPaid: Number(data.amountPaid) || 0,
          amountDue: Number(data.amountDue) || 0,
          paymentMethod: pm,
          ...(data.paymentSummary ? { paymentSummary: String(data.paymentSummary) } : {}),
          ...(data.reference ? { reference: String(data.reference) } : {}),
          warehouseId: String(data.warehouseId || DEFAULT_WAREHOUSE_ID),
          updateStock: Boolean(data.updateStock ?? true),
          notes: String(data.notes || ''),
          operator: String(data.operator || '001'),
          status: data.status === 'cancelled' ? 'cancelled' : 'recorded',
          ...(data.cancelReason ? { cancelReason: String(data.cancelReason) } : {}),
          ...(data.cancelledBy ? { cancelledBy: String(data.cancelledBy) } : {}),
          ...(data.createdByUid ? { createdByUid: String(data.createdByUid) } : {}),
          syncState: 'synced',
          synced: true,
          updatedAtIso: String(data.issuedAtIso || new Date().toISOString()),
        };
      })
    );

    let settings: AppSettings | null = null;
    if (settingsSnap && settingsSnap.exists()) {
      const sd = settingsSnap.data();
      const hydratedCompany = hydrateProfileFromCloud(sd, companyId);
      settings = {
        companyId,
        company: {
          ...hydratedCompany,
          legalName: sd.legalName || DEFAULT_SETTINGS.company.legalName,
          shortName: sd.shortName || DEFAULT_SETTINGS.company.shortName,
          nif: sd.nif || DEFAULT_SETTINGS.company.nif,
          address: sd.address || DEFAULT_SETTINGS.company.address,
          cityCountry: sd.cityCountry || DEFAULT_SETTINGS.company.cityCountry,
          phone: sd.phone || '',
          email: sd.email || '',
          tagline: sd.tagline || '',
        },
        defaultCashier: sd.defaultCashier || '01',
        defaultOperator: sd.defaultOperator || '001',
        defaultFormat: sd.defaultFormat === 'A4' ? 'A4' : 'POS',
        defaultDocType: normalizeDocType(sd.defaultDocType),
        defaultNotes: sd.defaultNotes || '',
        autoPrintOnEmit: Boolean(sd.autoPrintOnEmit),
        ...(sd.defaultEstablishmentId
          ? { defaultEstablishmentId: String(sd.defaultEstablishmentId) }
          : hydratedCompany.defaultEstablishmentId
            ? { defaultEstablishmentId: hydratedCompany.defaultEstablishmentId }
            : {}),
        agtEnvironment:
          sd.agtEnvironment === 'PRODUCAO' || hydratedCompany.agtEnvironment === 'PRODUCAO'
            ? 'PRODUCAO'
            : 'SIMULACAO',
        hidePromotionalFooter:
          typeof sd.hidePromotionalFooter === 'boolean' ? sd.hidePromotionalFooter : true,
        allowCashierPriceEdit: Boolean(sd.allowCashierPriceEdit ?? false),
        syncState: 'synced',
        synced: true,
        updatedAtIso: new Date().toISOString(),
      };
    }

    return {
      products,
      customers,
      invoices,
      cashSessions,
      cashMovements,
      stockMovements,
      suppliers,
      purchases,
      fiscalSeries,
      settings,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, invPath);
  }
}

async function pullLegacyJaimonaFromCloud(): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
  stockMovements: StockMovement[];
  suppliers: Supplier[];
  purchases: PurchaseRecord[];
  settings: AppSettings | null;
} | null> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return null;

  const prodPath = `users/${user.uid}/products`;
  const custPath = `users/${user.uid}/customers`;
  const invPath = `users/${user.uid}/invoices`;
  const settingsRef = doc(db, 'users', user.uid, 'settings', 'general');

  const [prodSnap, custSnap, invSnap, settingsSnap] = await Promise.all([
    getDocs(query(collection(db, prodPath), where('ownerId', '==', user.uid))),
    getDocs(query(collection(db, custPath), where('ownerId', '==', user.uid))),
    getDocs(query(collection(db, invPath), where('ownerId', '==', user.uid))),
    getDoc(settingsRef),
  ]);

  const products: Product[] = prodSnap.docs.map((d) => {
    const data = d.data();
    const history = sanitizePriceHistory(data.priceHistory as ProductPriceChange[] | undefined);
    return {
      id: data.id,
      companyId: JAIMONA_COMPANY_ID,
      code: data.code,
      ...(data.barcode ? { barcode: String(data.barcode) } : {}),
      name: data.name,
      category: data.category || 'Geral',
      unit: data.unit,
      ...(typeof data.costPrice === 'number' && data.costPrice > 0
        ? { costPrice: Number(data.costPrice) }
        : {}),
      price: data.price,
      ivaRate: data.ivaRate === 14 ? 14 : 0,
      exemptionReason: data.exemptionReason || '',
      active: Boolean(data.active),
      ...(history.length > 0 ? { priceHistory: history } : {}),
      syncState: 'synced',
      synced: true,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    };
  });

  const customers: Customer[] = await Promise.all(
    custSnap.docs.map(async (d) => {
      const data = d.data();
      let phone = '';
      let address = '';
      try {
        const privSnap = await getDoc(
          doc(db, 'users', user.uid, 'customers', data.id, 'private', 'contact')
        );
        if (privSnap.exists()) {
          phone = privSnap.data().phone || '';
          address = privSnap.data().address || '';
        }
      } catch {
        // Ignore
      }
      return {
        id: data.id,
        companyId: JAIMONA_COMPANY_ID,
        name: data.name,
        nif: data.nif || '',
        locality: data.locality || '',
        phone,
        address,
        ...(typeof data.creditLimit === 'number' && data.creditLimit > 0
          ? { creditLimit: data.creditLimit }
          : {}),
        syncState: 'synced',
        synced: true,
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      };
    })
  );

  const invoices: InvoiceRecord[] = await Promise.all(
    invSnap.docs.map(async (d) => {
      const data = d.data();
      const itemsPath = `users/${user.uid}/invoices/${data.id}/items`;
      const itemsSnap = await getDocs(
        query(collection(db, itemsPath), where('ownerId', '==', user.uid))
      );
      const lines: CalculatedLineItem[] = itemsSnap.docs.map((itemDoc) => {
        const it = itemDoc.data();
        return {
          id: it.id,
          productId: it.id,
          code: it.code,
          description: it.description,
          unit: it.unit,
          qty: it.qty,
          unitPrice: it.unitPrice,
          discountPct: it.discountPct,
          ivaRate: it.ivaRate === 14 ? 14 : 0,
          lineGross: it.lineGross,
          lineDiscount: Math.max(0, it.lineGross - it.lineNet),
          lineNet: it.lineNet,
          lineBase: it.lineBase,
          lineTax: it.lineTax,
          lineTotal: it.lineTotal,
        };
      });

      return {
        id: data.id,
        companyId: JAIMONA_COMPANY_ID,
        number: data.number,
        docType: data.docType === 'FP' ? 'FP' : data.docType === 'NC' ? 'NC' : 'FR',
        issuedAtIso: data.issuedAtIso,
        cashier: data.cashier,
        operator: data.operator,
        paymentMethod: data.paymentMethod,
        customerId: data.customerId,
        customerName: data.customerName,
        customerNif: data.customerNif,
        customerLocality: data.customerLocality,
        merchandiseTotal: data.merchandiseTotal,
        discountTotal: data.discountTotal,
        taxBase14: data.taxBase14,
        taxAmount14: data.taxAmount14,
        taxBase0: data.taxBase0,
        taxAmount0: 0,
        taxTotal: data.taxTotal,
        grandTotal: data.grandTotal,
        amountInWords: data.amountInWords,
        amountReceived: data.amountReceived,
        changeAmount: data.changeAmount,
        notes: data.notes || '',
        status: data.status === 'cancelled' ? 'cancelled' : 'issued',
        lines,
        syncState: 'synced',
        synced: true,
        createdAtIso: data.issuedAtIso,
        updatedAtIso: data.issuedAtIso,
      };
    })
  );

  let settings: AppSettings | null = null;
  if (settingsSnap.exists()) {
    const sd = settingsSnap.data();
    settings = {
      companyId: JAIMONA_COMPANY_ID,
      company: {
        legalName: sd.legalName || DEFAULT_SETTINGS.company.legalName,
        shortName: sd.shortName || DEFAULT_SETTINGS.company.shortName,
        nif: sd.nif || DEFAULT_SETTINGS.company.nif,
        address: sd.address || DEFAULT_SETTINGS.company.address,
        cityCountry: sd.cityCountry || DEFAULT_SETTINGS.company.cityCountry,
        phone: sd.phone || '',
        email: sd.email || '',
        tagline: sd.tagline || '',
      },
      defaultCashier: sd.defaultCashier || '01',
      defaultOperator: sd.defaultOperator || '001',
      defaultFormat: sd.defaultFormat === 'A4' ? 'A4' : 'POS',
      defaultDocType: sd.defaultDocType === 'FP' ? 'FP' : 'FR',
      defaultNotes: sd.defaultNotes || '',
      autoPrintOnEmit: Boolean(sd.autoPrintOnEmit),
      syncState: 'synced',
      synced: true,
      updatedAtIso: new Date().toISOString(),
    };
  }

  return {
    products,
    customers,
    invoices,
    cashSessions: [],
    cashMovements: [],
    stockMovements: [],
    suppliers: [],
    purchases: [],
    settings,
  };
}

/**
 * Descarrega a lista de empresas pertencentes ao utilizador autenticado a partir de /users/{uid}/company_links.
 */
export async function pullOwnedCompaniesFromCloud(): Promise<CompanyRecord[]> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return [];

  const linksPath = `users/${user.uid}/company_links`;
  try {
    const linksSnap = await getDocs(
      query(collection(db, linksPath), where('uid', '==', user.uid))
    );

    const results: CompanyRecord[] = [];
    for (const linkDoc of linksSnap.docs) {
      const ld = linkDoc.data();
      const compId = sanitizeId(ld.companyId || linkDoc.id);
      if (compId === JAIMONA_COMPANY_ID && !isJaimonaOwnerEmail(user.email)) {
        // Remove vínculo legado obsoleto gravado antes do desacoplamento multi-tenant
        await deleteDoc(doc(db, linksPath, linkDoc.id)).catch(() => null);
        continue;
      }
      const compSnap = await getDoc(doc(db, 'companies', compId)).catch(() => null);
      if (compSnap && compSnap.exists()) {
        const cd = compSnap.data();
        const now = new Date().toISOString();
        results.push({
          id: compId,
          normalizedNif: String(cd.normalizedNif || normalizeCompanyNif(String(cd.nif || ''))),
          profile: hydrateProfileFromCloud(cd, compId),
          status:
            cd.status === 'suspended'
              ? 'suspended'
              : cd.status === 'pending'
                ? 'pending'
                : 'active',
          plan: {
            planTier:
              compId === JAIMONA_COMPANY_ID && (!cd.planTier || cd.planTier === 'FREE')
                ? 'PROFISSIONAL'
                : cd.planTier || 'FREE',
            commercialActive:
              compId === JAIMONA_COMPANY_ID
                ? true
                : Boolean(cd.commercialActive ?? (cd.planTier && cd.planTier !== 'FREE')),
            maxUsers: null,
            maxInvoicesPerMonth: null,
            updatedAtIso: now,
          },
          baseSequence: Math.max(
            compId === JAIMONA_COMPANY_ID ? 15678 : 0,
            Number(cd.baseSequence) || 0
          ),
          allowManagerCancel: Boolean(cd.allowManagerCancel ?? false),
          ownerUid: String(cd.ownerUid || user.uid),
          ownerEmail: String(cd.ownerEmail || user.email || ''),
          termsAcceptedVersion: cd.termsAcceptedVersion
            ? String(cd.termsAcceptedVersion)
            : undefined,
          termsAcceptedAtIso: cd.termsAcceptedAtIso ? String(cd.termsAcceptedAtIso) : undefined,
          syncState: 'synced',
          synced: true,
          createdAtIso: now,
          updatedAtIso: now,
        });
      }
    }

    if (
      isJaimonaOwnerEmail(user.email) &&
      !results.some((r) => r.id === JAIMONA_COMPANY_ID)
    ) {
      const jaimonaSnap = await getDoc(doc(db, 'companies', JAIMONA_COMPANY_ID)).catch(() => null);
      if (jaimonaSnap && jaimonaSnap.exists()) {
        const cd = jaimonaSnap.data();
        const now = new Date().toISOString();
        results.push({
          id: JAIMONA_COMPANY_ID,
          normalizedNif: String(cd.normalizedNif || normalizeCompanyNif(String(cd.nif || ''))),
          profile: hydrateProfileFromCloud(cd, JAIMONA_COMPANY_ID),
          status:
            cd.status === 'suspended'
              ? 'suspended'
              : cd.status === 'pending'
                ? 'pending'
                : 'active',
          plan: {
            planTier:
              !cd.planTier || cd.planTier === 'FREE' ? 'PROFISSIONAL' : cd.planTier,
            commercialActive: true,
            maxUsers: null,
            maxInvoicesPerMonth: null,
            updatedAtIso: now,
          },
          baseSequence: Math.max(15678, Number(cd.baseSequence) || 0),
          allowManagerCancel: Boolean(cd.allowManagerCancel ?? false),
          ownerUid: String(cd.ownerUid || user.uid),
          ownerEmail: JAIMONA_OWNER_EMAIL,
          syncState: 'synced',
          synced: true,
          createdAtIso: now,
          updatedAtIso: now,
        });
      }
    }

    return results;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, linksPath);
  }
}

export async function pullAllFromCloud(companyId = '') {
  if (!companyId) return null;
  return pullCompanyFromCloud(companyId);
}

