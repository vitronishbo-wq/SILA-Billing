import {
  createDefaultSettingsForCompany,
  createDirectCustomerForCompany,
  createSeedInvoice,
  INITIAL_CUSTOMERS,
  INITIAL_PRODUCTS,
  JAIMONA_INITIAL_COMPANY,
} from '../core/seedData';
import {
  AppSettings,
  CartDraftItem,
  CompanyMember,
  CompanyProfile,
  CompanyRecord,
  Customer,
  DEFAULT_SETTINGS,
  DocumentFormat,
  DocumentType,
  getDirectCustomerIdForCompany,
  InvoiceRecord,
  JAIMONA_COMPANY_ID,
  normalizeCompanyNif,
  PaymentMethod,
  Product,
  SyncQueueEntry,
  validateCompanyNif,
} from '../core/types';

export interface PosWorkspaceDraft {
  companyId?: string;
  activeModule: 'NEW_POS' | 'NEW_A4' | 'CUSTOMERS' | 'PRODUCTS' | 'HISTORY' | 'SETTINGS' | 'SYNC';
  previewFormat: DocumentFormat;
  cart: CartDraftItem[];
  selectedCustomerId: string;
  docType: DocumentType;
  paymentMethod: PaymentMethod;
  amountReceivedInput: string;
  notes: string;
  cashier: string;
  operator: string;
  updatedAtIso: string;
}

export interface PreMulticompanySnapshot {
  capturedAtIso: string;
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  settings: AppSettings | null;
  posDraft: PosWorkspaceDraft | null;
}

export interface CompanyWorkspaceBundle {
  activeCompany: CompanyRecord;
  companies: CompanyRecord[];
  members: CompanyMember[];
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  settings: AppSettings;
  posDraft: PosWorkspaceDraft | null;
  hasPreMigrationBackup: boolean;
}

export interface RegisterCompanyInput {
  legalName: string;
  shortName: string;
  nif: string;
  address?: string;
  cityCountry?: string;
  phone?: string;
  email?: string;
  tagline?: string;
  ownerUid?: string;
  ownerEmail?: string;
  ownerDisplayName?: string;
  copyStarterCatalog?: boolean;
}

const DB_NAME = 'sila_billing_idb_v1';
const DB_VERSION = 2;

function ensureStoreIndex(
  tx: IDBTransaction,
  storeName: string,
  indexName: string,
  keyPath: string,
  unique = false
): void {
  const store = tx.objectStore(storeName);
  if (!store.indexNames.contains(indexName)) {
    store.createIndex(indexName, keyPath, { unique });
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction!;

      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'products', 'by_company', 'companyId', false);

      if (!db.objectStoreNames.contains('customers')) {
        db.createObjectStore('customers', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'customers', 'by_company', 'companyId', false);

      if (!db.objectStoreNames.contains('invoices')) {
        db.createObjectStore('invoices', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'invoices', 'by_company', 'companyId', false);

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }

      if (!db.objectStoreNames.contains('companies')) {
        db.createObjectStore('companies', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'companies', 'by_normalized_nif', 'normalizedNif', true);

      if (!db.objectStoreNames.contains('company_members')) {
        db.createObjectStore('company_members', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'company_members', 'by_company', 'companyId', false);

      if (!db.objectStoreNames.contains('sync_queue')) {
        db.createObjectStore('sync_queue', { keyPath: 'id' });
      }
      ensureStoreIndex(tx, 'sync_queue', 'by_company', 'companyId', false);
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getAllFromStore<T>(storeName: string): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function getAllByCompanyIndex<T extends { companyId?: string }>(
  storeName: string,
  companyId: string
): Promise<T[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    if (store.indexNames.contains('by_company')) {
      const idx = store.index('by_company');
      const req = idx.getAll(IDBKeyRange.only(companyId));
      req.onsuccess = () => resolve(req.result as T[]);
      req.onerror = () => reject(req.error);
      return;
    }
    const fallbackReq = store.getAll();
    fallbackReq.onsuccess = () => {
      const rows = (fallbackReq.result as T[]).filter(
        (r) => (r.companyId || JAIMONA_COMPANY_ID) === companyId
      );
      resolve(rows);
    };
    fallbackReq.onerror = () => reject(fallbackReq.error);
  });
}

async function getFromStore<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

async function putInStore<T>(storeName: string, record: T): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteFromStore(storeName: string, id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function inferProductCategory(p: Product): string {
  if (p.category && p.category.trim()) return p.category.trim();
  const seedMatch = INITIAL_PRODUCTS.find((sp) => sp.id === p.id || sp.code === p.code);
  if (seedMatch?.category) return seedMatch.category;
  const lower = p.name.toLowerCase();
  if (/água|agua|sumo|refrigerante|bebida|cerveja|vinho/.test(lower)) return 'Bebidas';
  if (/pão|pao|bolo|pastel|padaria/.test(lower)) return 'Padaria';
  if (/café|cafe|chá|cha/.test(lower)) return 'Cafetaria';
  if (/serviço|servico|entrega|transporte|taxa/.test(lower)) return 'Serviços';
  return 'Mercearia';
}

export async function findCompanyByNif(rawNif: string): Promise<CompanyRecord | null> {
  const normalized = normalizeCompanyNif(rawNif);
  if (!normalized) return null;

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('companies', 'readonly');
    const store = tx.objectStore('companies');
    if (store.indexNames.contains('by_normalized_nif')) {
      const idx = store.index('by_normalized_nif');
      const req = idx.get(normalized);
      req.onsuccess = () => resolve((req.result as CompanyRecord | undefined) || null);
      req.onerror = () => reject(req.error);
      return;
    }
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      const found =
        (allReq.result as CompanyRecord[]).find(
          (c) => normalizeCompanyNif(c.normalizedNif || c.profile.nif) === normalized
        ) || null;
      resolve(found);
    };
    allReq.onerror = () => reject(allReq.error);
  });
}

async function ensureMulticompanyInitialized(): Promise<void> {
  const seededMeta = await getFromStore<{ key: string; value: boolean }>('meta', 'seeded');

  if (!seededMeta?.value) {
    // Instalação limpa: cria JAIMONA como 1.ª empresa de referência mantendo todos os IDs clássicos
    await putInStore('companies', JAIMONA_INITIAL_COMPANY);
    for (const p of INITIAL_PRODUCTS) {
      await putInStore('products', { ...p, companyId: JAIMONA_COMPANY_ID });
    }
    for (const c of INITIAL_CUSTOMERS) {
      await putInStore('customers', { ...c, companyId: JAIMONA_COMPANY_ID });
    }
    await putInStore('invoices', { ...createSeedInvoice(), companyId: JAIMONA_COMPANY_ID });
    await putInStore('meta', { key: 'app_settings', value: DEFAULT_SETTINGS });
    await putInStore('meta', {
      key: `app_settings:${JAIMONA_COMPANY_ID}`,
      value: DEFAULT_SETTINGS,
    });
    await putInStore('meta', { key: 'active_company_id', value: JAIMONA_COMPANY_ID });
    await putInStore('meta', {
      key: 'migration_multicompany_v2',
      value: { completedAtIso: new Date().toISOString(), mode: 'fresh_install' },
    });
    await putInStore('meta', { key: 'seeded', value: true });
    return;
  }

  // Migração idempotente e repetível de instalações existentes (v1 -> v2)
  const migrationDone = await getFromStore<{
    key: string;
    value: { completedAtIso: string; mode: string };
  }>('meta', 'migration_multicompany_v2');

  const existingJaimona = await getFromStore<CompanyRecord>('companies', JAIMONA_COMPANY_ID);
  if (migrationDone?.value && existingJaimona) {
    return;
  }

  const [rawProducts, rawCustomers, rawInvoices, legacySettingsMeta, legacyDraftMeta, existingBackup] =
    await Promise.all([
      getAllFromStore<Product>('products'),
      getAllFromStore<Customer>('customers'),
      getAllFromStore<InvoiceRecord>('invoices'),
      getFromStore<{ key: string; value: AppSettings }>('meta', 'app_settings'),
      getFromStore<{ key: string; value: PosWorkspaceDraft }>('meta', 'pos_draft'),
      getFromStore<{ key: string; value: PreMulticompanySnapshot }>(
        'meta',
        'backup_pre_multicompany_v1'
      ),
    ]);

  // 1. Grava cópia de segurança imutável ANTES de qualquer alteração nos registos v1
  if (!existingBackup?.value) {
    const snapshot: PreMulticompanySnapshot = {
      capturedAtIso: new Date().toISOString(),
      products: rawProducts,
      customers: rawCustomers,
      invoices: rawInvoices,
      settings: legacySettingsMeta?.value || null,
      posDraft: legacyDraftMeta?.value || null,
    };
    await putInStore('meta', { key: 'backup_pre_multicompany_v1', value: snapshot });
  }

  // 2. Regista a JAIMONA preservando eventuais personalizações já feitas nas configurações
  const legacySettings = legacySettingsMeta?.value || DEFAULT_SETTINGS;
  const jaimonaProfile: CompanyProfile = {
    ...JAIMONA_INITIAL_COMPANY.profile,
    ...legacySettings.company,
    nif: legacySettings.company?.nif || JAIMONA_INITIAL_COMPANY.profile.nif,
  };

  const jaimonaRecord: CompanyRecord = existingJaimona || {
    ...JAIMONA_INITIAL_COMPANY,
    normalizedNif: normalizeCompanyNif(jaimonaProfile.nif),
    profile: jaimonaProfile,
    synced: Boolean(legacySettings.synced),
    syncState: legacySettings.synced ? 'synced' : 'pending',
    updatedAtIso: new Date().toISOString(),
  };
  await putInStore('companies', jaimonaRecord);

  // 3. Associa registos existentes a comp_jaimona preservando 100% dos IDs originais
  for (const p of rawProducts) {
    const category = inferProductCategory(p);
    if (!p.companyId || !p.category) {
      await putInStore('products', {
        ...p,
        companyId: p.companyId || JAIMONA_COMPANY_ID,
        category,
        syncState: p.syncState || (p.synced ? 'synced' : 'pending'),
      });
    }
  }

  for (const c of rawCustomers) {
    if (!c.companyId) {
      await putInStore('customers', {
        ...c,
        companyId: JAIMONA_COMPANY_ID,
        syncState: c.syncState || (c.synced ? 'synced' : 'pending'),
      });
    }
  }

  for (const inv of rawInvoices) {
    if (!inv.companyId) {
      await putInStore('invoices', {
        ...inv,
        companyId: JAIMONA_COMPANY_ID,
        syncState: inv.syncState || (inv.synced ? 'synced' : 'pending'),
      });
    }
  }

  // 4. Espelha configurações e rascunho POS para as chaves particionadas por empresa
  const scopedSettings: AppSettings = {
    ...legacySettings,
    companyId: JAIMONA_COMPANY_ID,
    company: jaimonaProfile,
    syncState: legacySettings.syncState || (legacySettings.synced ? 'synced' : 'pending'),
  };
  await putInStore('meta', { key: `app_settings:${JAIMONA_COMPANY_ID}`, value: scopedSettings });

  if (legacyDraftMeta?.value) {
    await putInStore('meta', {
      key: `pos_draft:${JAIMONA_COMPANY_ID}`,
      value: { ...legacyDraftMeta.value, companyId: JAIMONA_COMPANY_ID },
    });
  }

  const activeCompanyMeta = await getFromStore<{ key: string; value: string }>(
    'meta',
    'active_company_id'
  );
  if (!activeCompanyMeta?.value) {
    await putInStore('meta', { key: 'active_company_id', value: JAIMONA_COMPANY_ID });
  }

  await putInStore('meta', {
    key: 'migration_multicompany_v2',
    value: { completedAtIso: new Date().toISOString(), mode: 'upgraded_from_v1' },
  });
}

export async function loadCompanyWorkspace(companyId: string): Promise<CompanyWorkspaceBundle> {
  await ensureMulticompanyInitialized();

  const [allCompanies, backupMeta] = await Promise.all([
    getAllFromStore<CompanyRecord>('companies'),
    getFromStore<{ key: string; value: PreMulticompanySnapshot }>(
      'meta',
      'backup_pre_multicompany_v1'
    ),
  ]);

  allCompanies.sort((a, b) =>
    a.id === JAIMONA_COMPANY_ID
      ? -1
      : b.id === JAIMONA_COMPANY_ID
        ? 1
        : a.profile.shortName.localeCompare(b.profile.shortName, 'pt')
  );

  const activeCompany =
    allCompanies.find((c) => c.id === companyId) ||
    allCompanies.find((c) => c.id === JAIMONA_COMPANY_ID) ||
    allCompanies[0] ||
    JAIMONA_INITIAL_COMPANY;

  await putInStore('meta', { key: 'active_company_id', value: activeCompany.id });

  const [rawProducts, customers, invoices, members, scopedSettingsMeta, legacySettingsMeta, draftMeta] =
    await Promise.all([
      getAllByCompanyIndex<Product>('products', activeCompany.id),
      getAllByCompanyIndex<Customer>('customers', activeCompany.id),
      getAllByCompanyIndex<InvoiceRecord>('invoices', activeCompany.id),
      getAllByCompanyIndex<CompanyMember>('company_members', activeCompany.id),
      getFromStore<{ key: string; value: AppSettings }>(
        'meta',
        `app_settings:${activeCompany.id}`
      ),
      activeCompany.id === JAIMONA_COMPANY_ID
        ? getFromStore<{ key: string; value: AppSettings }>('meta', 'app_settings')
        : Promise.resolve(undefined),
      getFromStore<{ key: string; value: PosWorkspaceDraft }>(
        'meta',
        `pos_draft:${activeCompany.id}`
      ),
    ]);

  // Garante cliente Consumidor Final próprio da empresa
  const directCustId = getDirectCustomerIdForCompany(activeCompany.id);
  if (!customers.some((c) => c.id === directCustId)) {
    const directCustomer = createDirectCustomerForCompany(activeCompany);
    await putInStore('customers', directCustomer);
    customers.unshift(directCustomer);
  }

  // Normaliza categorias caso algum artigo antigo não tenha
  const products: Product[] = [];
  for (const p of rawProducts) {
    if (p.category && p.category.trim()) {
      products.push(p);
    } else {
      const upgraded: Product = {
        ...p,
        companyId: activeCompany.id,
        category: inferProductCategory(p),
      };
      await putInStore('products', upgraded);
      products.push(upgraded);
    }
  }

  products.sort((a, b) => a.code.localeCompare(b.code));
  customers.sort((a, b) =>
    a.id === directCustId ? -1 : b.id === directCustId ? 1 : a.name.localeCompare(b.name, 'pt')
  );
  invoices.sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso));

  const fallbackSettings = createDefaultSettingsForCompany(activeCompany);
  const resolvedSettings: AppSettings = scopedSettingsMeta?.value
    ? { ...scopedSettingsMeta.value, companyId: activeCompany.id, company: activeCompany.profile }
    : legacySettingsMeta?.value
      ? { ...legacySettingsMeta.value, companyId: activeCompany.id }
      : fallbackSettings;

  return {
    activeCompany,
    companies: allCompanies,
    members,
    products,
    customers,
    invoices,
    settings: resolvedSettings,
    posDraft: draftMeta?.value || null,
    hasPreMigrationBackup: Boolean(backupMeta?.value),
  };
}

export async function bootstrapLocalStore(
  preferredCompanyId?: string
): Promise<CompanyWorkspaceBundle> {
  await ensureMulticompanyInitialized();
  const savedActiveMeta = await getFromStore<{ key: string; value: string }>(
    'meta',
    'active_company_id'
  );
  const targetCompanyId = preferredCompanyId || savedActiveMeta?.value || JAIMONA_COMPANY_ID;
  return loadCompanyWorkspace(targetCompanyId);
}

/**
 * Regista uma nova empresa localmente respeitando rigorosamente a regra legal:
 * 1 NIF = 1 única empresa em todo o sistema SILA-Billing.
 */
export async function registerNewCompanyLocal(
  input: RegisterCompanyInput
): Promise<CompanyRecord> {
  await ensureMulticompanyInitialized();

  const nifCheck = validateCompanyNif(input.nif);
  if (!nifCheck.valid) {
    throw new Error(nifCheck.error || 'NIF inválido.');
  }

  const duplicate = await findCompanyByNif(nifCheck.normalized);
  if (duplicate) {
    throw new Error(
      `O NIF ${input.nif.trim()} já pertence à empresa "${duplicate.profile.shortName}". Cada NIF pode cadastrar apenas uma única empresa.`
    );
  }

  const legalName = input.legalName.trim();
  const shortName = (input.shortName || legalName).trim().slice(0, 64);
  if (!legalName) {
    throw new Error('A designação social da empresa é obrigatória.');
  }

  const now = new Date().toISOString();
  const slug = Math.random().toString(36).slice(2, 7);
  const companyId = `comp_${Date.now()}_${slug}`;
  const cityCountry = (input.cityCountry || 'Angola').trim() || 'Angola';

  const newCompany: CompanyRecord = {
    id: companyId,
    normalizedNif: nifCheck.normalized,
    profile: {
      legalName: legalName.slice(0, 160),
      shortName,
      nif: input.nif.trim().slice(0, 32),
      address: (input.address || cityCountry).trim().slice(0, 160),
      cityCountry: cityCountry.slice(0, 80),
      phone: (input.phone || '').trim().slice(0, 40),
      email: (input.email || '').trim().slice(0, 120),
      tagline: (input.tagline || 'Obrigado pela preferência').trim().slice(0, 120),
    },
    status: 'active',
    plan: {
      planTier: 'FREE',
      commercialActive: false,
      maxUsers: null,
      maxInvoicesPerMonth: null,
      updatedAtIso: now,
    },
    baseSequence: 0,
    allowManagerCancel: false,
    ownerUid: input.ownerUid,
    ownerEmail: input.ownerEmail,
    syncState: 'pending',
    synced: false,
    createdAtIso: now,
    updatedAtIso: now,
  };

  await putInStore('companies', newCompany);

  const directCustomer = createDirectCustomerForCompany(newCompany);
  await putInStore('customers', directCustomer);

  const defaultSettings = createDefaultSettingsForCompany(newCompany);
  await putInStore('meta', { key: `app_settings:${companyId}`, value: defaultSettings });

  if (input.ownerUid) {
    const ownerMember: CompanyMember = {
      id: `${companyId}_${input.ownerUid}`,
      companyId,
      uid: input.ownerUid,
      email: input.ownerEmail || '',
      displayName: input.ownerDisplayName || input.ownerEmail || 'Proprietário',
      role: 'owner',
      allowInvoiceCancel: true,
      active: true,
      createdAtIso: now,
      updatedAtIso: now,
    };
    await putInStore('company_members', ownerMember);
  }

  if (input.copyStarterCatalog) {
    for (const sp of INITIAL_PRODUCTS) {
      const cloned: Product = {
        ...sp,
        id: `${companyId}_${sp.code}`,
        companyId,
        syncState: 'pending',
        synced: false,
        createdAtIso: now,
        updatedAtIso: now,
      };
      await putInStore('products', cloned);
    }
  }

  return newCompany;
}

/**
 * Atualiza configurações e perfil da empresa ativa garantindo que o NIF não colide com outra empresa.
 */
export async function saveCompanySettingsScoped(
  companyId: string,
  settings: AppSettings
): Promise<CompanyRecord> {
  const nifCheck = validateCompanyNif(settings.company.nif);
  if (!nifCheck.valid) {
    throw new Error(nifCheck.error || 'NIF inválido.');
  }

  const duplicate = await findCompanyByNif(nifCheck.normalized);
  if (duplicate && duplicate.id !== companyId) {
    throw new Error(
      `O NIF ${settings.company.nif.trim()} já está registado noutra empresa ("${duplicate.profile.shortName}"). Não é permitido duplicar NIF no sistema.`
    );
  }

  const existingCompany =
    (await getFromStore<CompanyRecord>('companies', companyId)) || JAIMONA_INITIAL_COMPANY;

  const now = new Date().toISOString();
  const updatedCompany: CompanyRecord = {
    ...existingCompany,
    id: companyId,
    normalizedNif: nifCheck.normalized,
    profile: { ...settings.company },
    syncState: settings.synced ? 'synced' : 'pending',
    synced: Boolean(settings.synced),
    updatedAtIso: now,
  };

  await putInStore('companies', updatedCompany);

  const scopedSettings: AppSettings = {
    ...settings,
    companyId,
    updatedAtIso: settings.updatedAtIso || now,
  };
  await putInStore('meta', { key: `app_settings:${companyId}`, value: scopedSettings });
  if (companyId === JAIMONA_COMPANY_ID) {
    await putInStore('meta', { key: 'app_settings', value: scopedSettings });
  }

  return updatedCompany;
}

/**
 * Procedimento de Rollback seguro para repor o snapshot v1 pré-migração caso solicitado.
 */
export async function restorePreMulticompanySnapshot(): Promise<boolean> {
  const backupMeta = await getFromStore<{ key: string; value: PreMulticompanySnapshot }>(
    'meta',
    'backup_pre_multicompany_v1'
  );
  if (!backupMeta?.value) return false;

  const snap = backupMeta.value;
  for (const p of snap.products) {
    await putInStore('products', { ...p, companyId: JAIMONA_COMPANY_ID });
  }
  for (const c of snap.customers) {
    await putInStore('customers', { ...c, companyId: JAIMONA_COMPANY_ID });
  }
  for (const inv of snap.invoices) {
    await putInStore('invoices', { ...inv, companyId: JAIMONA_COMPANY_ID });
  }
  if (snap.settings) {
    await putInStore('meta', { key: 'app_settings', value: snap.settings });
    await putInStore('meta', {
      key: `app_settings:${JAIMONA_COMPANY_ID}`,
      value: { ...snap.settings, companyId: JAIMONA_COMPANY_ID },
    });
  }
  if (snap.posDraft) {
    await putInStore('meta', { key: 'pos_draft', value: snap.posDraft });
    await putInStore('meta', {
      key: `pos_draft:${JAIMONA_COMPANY_ID}`,
      value: { ...snap.posDraft, companyId: JAIMONA_COMPANY_ID },
    });
  }
  await putInStore('meta', { key: 'active_company_id', value: JAIMONA_COMPANY_ID });
  return true;
}

export const localDb = {
  saveCompany: (company: CompanyRecord) => putInStore('companies', company),
  deleteCompanyRollback: async (companyId: string) => {
    await deleteFromStore('companies', companyId);
    await deleteFromStore('customers', getDirectCustomerIdForCompany(companyId));
    const prods = await getAllByCompanyIndex<Product>('products', companyId);
    for (const p of prods) {
      await deleteFromStore('products', p.id);
    }
    const members = await getAllByCompanyIndex<CompanyMember>('company_members', companyId);
    for (const m of members) {
      await deleteFromStore('company_members', m.id);
    }
    await deleteFromStore('meta', `app_settings:${companyId}`);
  },
  getAllCompanies: () => getAllFromStore<CompanyRecord>('companies'),
  saveMember: (member: CompanyMember) => putInStore('company_members', member),
  deleteMember: (id: string) => deleteFromStore('company_members', id),
  enqueueSync: (entry: SyncQueueEntry) => putInStore('sync_queue', entry),
  deleteSyncEntry: (id: string) => deleteFromStore('sync_queue', id),
  saveProduct: (p: Product, companyId = JAIMONA_COMPANY_ID) =>
    putInStore('products', { ...p, companyId: p.companyId || companyId }),
  deleteProduct: (id: string) => deleteFromStore('products', id),
  saveCustomer: (c: Customer, companyId = JAIMONA_COMPANY_ID) =>
    putInStore('customers', { ...c, companyId: c.companyId || companyId }),
  deleteCustomer: (id: string) => deleteFromStore('customers', id),
  saveInvoice: (inv: InvoiceRecord, companyId = JAIMONA_COMPANY_ID) =>
    putInStore('invoices', { ...inv, companyId: inv.companyId || companyId }),
  saveSettings: (settings: AppSettings, companyId = JAIMONA_COMPANY_ID) =>
    saveCompanySettingsScoped(companyId, settings),
  savePosDraft: (draft: PosWorkspaceDraft, companyId = JAIMONA_COMPANY_ID) =>
    putInStore('meta', {
      key: `pos_draft:${companyId}`,
      value: { ...draft, companyId },
    }),
  getPreMigrationSnapshot: async (): Promise<PreMulticompanySnapshot | null> => {
    const m = await getFromStore<{ key: string; value: PreMulticompanySnapshot }>(
      'meta',
      'backup_pre_multicompany_v1'
    );
    return m?.value || null;
  },
};
