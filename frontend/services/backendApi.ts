import type {
  AgtDocumentType,
  AgtIvaExemptionCode,
  AgtSeriesEnvironment,
  AgtSeriesRecord,
  AgtSeriesStatus,
} from '../../src/core/fiscalTypes.ts';
import { hydrateProfileFromCloud } from '../../src/core/cloudMasterMapper.ts';
import { resolveMemberBaseRole, resolveMemberStatus } from '../../src/core/rbac.ts';
import {
  DEFAULT_SETTINGS,
  DEFAULT_WAREHOUSE_ID,
  type AppSettings,
  type CalculatedLineItem,
  type CashMovement,
  type CashMovementType,
  type CashSession,
  type CompanyMember,
  type CompanyOperationalStatus,
  type CompanyRecord,
  type CompanyRole,
  type CompanyRoleDefinition,
  type Customer,
  type DirectPaymentMethod,
  type DocumentType,
  type InvoiceIssuerSnapshot,
  type InvoiceRecord,
  type PaymentSplit,
  type PlanTier,
  type Product,
  type ProductPriceChange,
  type ProductType,
  type PurchaseLineItem,
  type PurchasePaymentMethod,
  type PurchaseRecord,
  type SecurityAuditEntry,
  type StockMovement,
  type StockMovementDirection,
  type StockMovementType,
  type Supplier,
  type TaxRate,
} from '../../src/core/types.ts';
import { auth } from '../../src/services/firebaseClient.ts';

const PRODUCTION_RENDER_API_URL = 'https://sila-billing.onrender.com';

function resolveApiBaseUrl(): string {
  const raw =
    typeof import.meta !== 'undefined' && import.meta.env
      ? String(import.meta.env.VITE_API_BASE_URL || '')
      : '';
  const cleaned = raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (cleaned) {
    return cleaned;
  }

  // Em produção no Firebase Hosting (silabilling.web.app / firebaseapp.com),
  // liga nativamente ao backend oficial no Render sem exigir configuração manual.
  if (typeof window !== 'undefined') {
    const host = window.location.hostname.toLowerCase();
    if (host.endsWith('.web.app') || host.endsWith('.firebaseapp.com')) {
      return PRODUCTION_RENDER_API_URL;
    }
  }

  return '';
}

const API_BASE = resolveApiBaseUrl();

export interface BackendHealthStatus {
  ok: boolean;
  service: string;
  projectId: string;
  firestoreDatabaseId: string;
  credentialSource: string;
  hasServiceAccount: boolean;
  firestoreReachable: boolean;
  message: string;
  timestamp: string;
}

export interface AuditInvoiceResponse {
  ok: boolean;
  auditHash?: string;
  persistedInFirestore?: boolean;
  databaseId?: string;
  error?: string;
}

export interface AdminCompanySummary {
  id: string;
  shortName: string;
  legalName: string;
  nif: string;
  normalizedNif: string;
  cityCountry: string;
  ownerEmail: string;
  status: CompanyOperationalStatus;
  planTier: PlanTier;
  commercialActive: boolean;
  invoiceCount: number;
  createdAtIso: string;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  companyId: string;
  companyName: string;
  adminEmail: string;
  details: string;
  createdAtIso: string;
}

export interface AdminOverviewStats {
  totalCompanies: number;
  activeCompanies: number;
  suspendedCompanies: number;
  totalInvoicesCount: number;
  totalUsersCount: number;
  commercialActiveCount: number;
  baseOrganicCount: number;
  plansBreakdown: {
    FREE: number;
    ESSENCIAL: number;
    PROFISSIONAL: number;
    ENTERPRISE: number;
  };
}

export interface AdminCompanyDetails {
  cloudPersisted?: boolean;
  company: {
    id: string;
    legalName: string;
    shortName: string;
    nif: string;
    normalizedNif: string;
    cityCountry: string;
    address: string;
    phone: string;
    email: string;
    status: CompanyOperationalStatus;
    planTier: PlanTier;
    commercialActive: boolean;
    baseSequence: number;
    allowManagerCancel: boolean;
    createdAtIso: string;
    updatedAtIso: string;
  };
  counts: {
    invoices: number;
    products: number;
    customers: number;
    cashSessions: number;
  };
  members: Array<{
    uid: string;
    email: string;
    role: string;
    active: boolean;
    allowInvoiceCancel?: boolean;
    addedAtIso: string;
  }>;
  auditHistory: Array<{
    id: string;
    action: string;
    adminEmail: string;
    details: string;
    createdAtIso: string;
  }>;
}

export interface PlatformUserSummary {
  uid: string;
  email: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
  companies: Array<{
    companyId: string;
    companyName: string;
    role: string;
    active: boolean;
  }>;
}

export interface SystemStatusResponse {
  ok: boolean;
  telemetry: {
    uptimeSeconds: number;
    nodeVersion: string;
    memory: {
      rssMb: number;
      heapUsedMb: number;
      heapTotalMb: number;
    };
    environment: string;
    port: number;
  };
  firestore: {
    initialized: boolean;
    databaseId: string;
    hasExplicitCredentials: boolean;
    credentialSource: string;
  };
  services: {
    backendApi: string;
    cryptoEngine: string;
    agtFiscalValidator: string;
  };
  timestampIso: string;
}

export interface AdminOverviewResponse {
  ok: boolean;
  statusCode?: number;
  adminEmail?: string;
  cloudPersisted?: boolean;
  stats?: AdminOverviewStats;
  companies?: AdminCompanySummary[];
  recentLogs?: AdminAuditEntry[];
  error?: string;
}

async function getBearerHeaders(): Promise<Record<string, string>> {
  let currentUser = auth.currentUser;
  if (!currentUser && typeof auth.authStateReady === 'function') {
    try {
      await Promise.race([
        auth.authStateReady(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500)),
      ]);
      currentUser = auth.currentUser;
    } catch {
      // continua com utilizador atual
    }
  }

  if (!currentUser) {
    throw new Error('Sessão administrativa não iniciada. Inicie sessão com a conta Google para aceder ao Painel Master.');
  }
  const token = await currentUser.getIdToken();
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export async function fetchBackendHealth(): Promise<BackendHealthStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()) as BackendHealthStatus;
  } catch {
    return null;
  }
}

export async function requestEnsureAuthDomains(): Promise<{
  ok: boolean;
  added: string[];
  alreadyPresent: boolean;
}> {
  try {
    const res = await fetch(`${API_BASE}/api/health/ensure-auth-domains`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, added: [], alreadyPresent: false };
    const data = (await res.json()) as {
      ok?: boolean;
      added?: string[];
      alreadyPresent?: boolean;
    };
    return {
      ok: Boolean(data.ok),
      added: Array.isArray(data.added) ? data.added : [],
      alreadyPresent: Boolean(data.alreadyPresent),
    };
  } catch {
    return { ok: false, added: [], alreadyPresent: false };
  }
}

export async function submitInvoiceAudit(
  invoice: InvoiceRecord,
  companyId: string
): Promise<AuditInvoiceResponse> {
  const resolvedCompanyId = String(companyId || invoice.companyId || '').trim();
  if (!resolvedCompanyId) {
    return { ok: false, error: 'Selecione uma empresa ativa antes de submeter auditoria.' };
  }
  const headers = await getBearerHeaders();
  const payload = {
    id: invoice.id,
    companyId: resolvedCompanyId,
    number: invoice.number,
    docType: invoice.docType,
    issuedAtIso: invoice.issuedAtIso,
    cashier: invoice.cashier,
    operator: invoice.operator,
    paymentMethod: invoice.paymentMethod,
    customerId: invoice.customerId,
    customerName: invoice.customerName,
    customerNif: invoice.customerNif,
    customerLocality: invoice.customerLocality,
    globalDiscountPct: invoice.globalDiscountPct || 0,
    amountReceived: invoice.amountReceived,
    transferReference: invoice.transferReference,
    paymentSummary: invoice.paymentSummary,
    returnOriginInvoiceId: invoice.returnOriginInvoiceId,
    returnOriginNumber: invoice.returnOriginNumber,
    returnCreditApplied: invoice.returnCreditApplied,
    notes: invoice.notes,
    clientGrandTotal: invoice.grandTotal,
    lines: invoice.lines.map((l) => ({
      productId: l.productId,
      code: l.code,
      description: l.description,
      unit: l.unit,
      qty: l.qty,
      unitPrice: l.unitPrice,
      discountPct: l.discountPct,
      ivaRate: l.ivaRate,
    })),
  };

  const res = await fetch(`${API_BASE}/api/audit/invoices`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  return (await res.json()) as AuditInvoiceResponse;
}

export async function registerCompanyBackend(
  company: CompanyRecord
): Promise<{ ok: boolean; statusCode: number; error?: string }> {
  const headers = await getBearerHeaders();
  const res = await fetch(`${API_BASE}/api/companies/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: company.id,
      legalName: company.profile.legalName,
      shortName: company.profile.shortName,
      nif: company.profile.nif,
      address: company.profile.address,
      cityCountry: company.profile.cityCountry,
      phone: company.profile.phone,
      email: company.profile.email,
      tagline: company.profile.tagline,
      baseSequence: company.baseSequence,
      termsAcceptedVersion: company.termsAcceptedVersion,
      termsAcceptedAtIso: company.termsAcceptedAtIso,
    }),
  });

  const data = (await res.json().catch(() => ({ ok: false }))) as {
    ok: boolean;
    error?: string;
  };
  return { ok: Boolean(data.ok), statusCode: res.status, error: data.error };
}

export async function cancelInvoiceBackend(
  companyId: string,
  invoiceId: string,
  cancelReason: string
): Promise<{ ok: boolean; error?: string }> {
  const headers = await getBearerHeaders();
  const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyId)}/cancel-invoice`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ invoiceId, cancelReason }),
  });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
}

export async function downloadCloudBackupJson(companyId: string): Promise<void> {
  const resolvedCompanyId = String(companyId || '').trim();
  if (!resolvedCompanyId) {
    throw new Error('Selecione uma empresa ativa para exportar o backup da Cloud.');
  }
  const headers = await getBearerHeaders();
  const res = await fetch(
    `${API_BASE}/api/backup?companyId=${encodeURIComponent(resolvedCompanyId)}`,
    {
      method: 'GET',
      headers,
    }
  );

  if (!res.ok) {
    let errMsg = `Erro HTTP ${res.status}`;
    try {
      const json = await res.json();
      if (json?.error) errMsg = json.error;
    } catch {
      // Ignore parse error
    }
    throw new Error(errMsg);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sila-billing-backup-${resolvedCompanyId}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function fetchPlatformAdminOverview(): Promise<AdminOverviewResponse> {
  try {
    const headers = await getBearerHeaders();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    let res: Response;
    try {
      res = await fetch(`${API_BASE}/api/admin/overview`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
    } catch (netErr) {
      if (API_BASE) {
        // Tenta rota local caso o endpoint remoto esteja inacessível ou em cold start
        res = await fetch('/api/admin/overview', {
          method: 'GET',
          headers,
          signal: controller.signal,
        });
      } else {
        throw netErr;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    const json = (await res.json().catch(() => ({ ok: false }))) as AdminOverviewResponse;
    return { ...json, statusCode: res.status };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      statusCode: 0,
      error: isAbort
        ? 'Tempo limite de resposta excedido ao contactar o servidor.'
        : err instanceof Error
          ? err.message
          : 'Falha de comunicação com o servidor.',
    };
  }
}

export async function fetchPlatformCompanyDetails(
  companyId: string
): Promise<{ ok: boolean; data?: AdminCompanyDetails; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/admin/companies/${encodeURIComponent(companyId)}/details`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      return { ok: false, error: errJson.error || `Erro ${res.status} ao obter perfil da empresa.` };
    }
    const json = await res.json();
    return { ok: true, data: json };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao consultar detalhes da empresa.',
    };
  }
}

export async function createPlatformCompany(payload: {
  shortName: string;
  legalName?: string;
  nif: string;
  cityCountry?: string;
  ownerEmail?: string;
  taxRegime?: 'GERAL' | 'SIMPLIFICADO' | 'EXCLUSAO';
  planTier?: PlanTier;
  status?: CompanyOperationalStatus;
}): Promise<{ ok: boolean; companyId?: string; persistedInFirestore?: boolean; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/admin/companies`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const json = await res.json().catch(() => ({ ok: false }));
    if (!res.ok) {
      return { ok: false, error: json.error || `Erro HTTP ${res.status}` };
    }
    return {
      ok: true,
      companyId: json.companyId,
      persistedInFirestore: json.persistedInFirestore,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao criar empresa.',
    };
  }
}

export async function fetchPlatformUsers(): Promise<{
  ok: boolean;
  cloudPersisted?: boolean;
  users?: PlatformUserSummary[];
  error?: string;
}> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/admin/users`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      return { ok: false, error: json.error || `Erro HTTP ${res.status}` };
    }
    const json = await res.json();
    return { ok: true, cloudPersisted: json.cloudPersisted, users: json.users };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha ao obter directório de utilizadores.',
    };
  }
}

export async function fetchPlatformSystemStatus(): Promise<SystemStatusResponse | null> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/admin/system-status`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) return null;
    return (await res.json()) as SystemStatusResponse;
  } catch {
    return null;
  }
}

export async function updatePlatformCompanyAdmin(
  companyId: string,
  patch: { status?: CompanyOperationalStatus; planTier?: PlanTier; reason?: string }
): Promise<{ ok: boolean; persistedInFirestore?: boolean; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/admin/companies/${encodeURIComponent(companyId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    });
    return (await res.json().catch(() => ({ ok: false }))) as {
      ok: boolean;
      persistedInFirestore?: boolean;
      error?: string;
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Falha de comunicação com o servidor.',
    };
  }
}

export async function logPlatformSupportAccess(
  companyId: string,
  companyName: string
): Promise<void> {
  try {
    const headers = await getBearerHeaders();
    await fetch(`${API_BASE}/api/admin/support-access`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ companyId, companyName }),
    });
  } catch {
    // Registo assíncrono não bloqueante
  }
}

export async function fetchCompanyWorkspaceBackend(companyId: string): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
  stockMovements: StockMovement[];
  suppliers: Supplier[];
  purchases: PurchaseRecord[];
  fiscalSeries?: AgtSeriesRecord[];
  auditLogs?: SecurityAuditEntry[];
  members?: CompanyMember[];
  roles?: CompanyRoleDefinition[];
  settings: AppSettings | null;
} | null> {
  const resolvedId = String(companyId || '').trim();
  if (!resolvedId) return null;

  try {
    const headers = await getBearerHeaders();
    const res = await fetch(
      `${API_BASE}/api/companies/${encodeURIComponent(resolvedId)}/workspace`,
      {
        method: 'GET',
        headers,
      }
    );
    if (!res.ok) return null;

    const json = (await res.json()) as {
      ok?: boolean;
      members?: Array<Record<string, unknown>>;
      roles?: Array<Record<string, unknown>>;
      products?: Array<Record<string, unknown>>;
      customers?: Array<Record<string, unknown>>;
      invoices?: Array<Record<string, unknown>>;
      cashSessions?: Array<Record<string, unknown>>;
      cashMovements?: Array<Record<string, unknown>>;
      stockMovements?: Array<Record<string, unknown>>;
      suppliers?: Array<Record<string, unknown>>;
      purchases?: Array<Record<string, unknown>>;
      fiscalSeries?: Array<Record<string, unknown>>;
      auditLogs?: Array<Record<string, unknown>>;
      settings?: Record<string, unknown> | null;
    };
    if (!json.ok) return null;

    const now = new Date().toISOString();
    const extractTsIso = (raw: unknown, fallback = '2025-01-01T00:00:00.000Z'): string => {
      if (!raw) return fallback;
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'object') {
        const obj = raw as { _seconds?: number; seconds?: number };
        const secs = typeof obj._seconds === 'number' ? obj._seconds : obj.seconds;
        if (typeof secs === 'number' && Number.isFinite(secs)) {
          return new Date(secs * 1000).toISOString();
        }
      }
      return fallback;
    };
    const normalizeRate = (raw: unknown): TaxRate => {
      const n = Number(raw);
      return n === 1 || n === 5 || n === 7 || n === 14 ? n : 0;
    };
    const VALID_DOCS: ReadonlySet<DocumentType> = new Set([
      'FR', 'FA', 'FP', 'NC', 'ND', 'RC', 'FT', 'CS',
    ]);
    const normalizeDoc = (raw: unknown): DocumentType => {
      const d = String(raw || '').trim().toUpperCase() as DocumentType;
      return VALID_DOCS.has(d) ? d : 'FR';
    };

    const products: Product[] = (json.products || []).map((p) => {
      const rawHist = Array.isArray(p.priceHistory)
        ? (p.priceHistory as Array<Record<string, unknown>>).slice(0, 20)
        : [];
      const priceHistory: ProductPriceChange[] = rawHist.map((h) => ({
        changedAtIso: String(h.changedAtIso || now),
        previousPrice: Number(h.previousPrice) || 0,
        newPrice: Number(h.newPrice) || 0,
        ...(typeof h.previousCost === 'number' ? { previousCost: Number(h.previousCost) } : {}),
        ...(typeof h.newCost === 'number' ? { newCost: Number(h.newCost) } : {}),
        changedBy: String(h.changedBy || 'Operador'),
      }));
      const pt =
        p.productType === 'P' || p.productType === 'S' || p.productType === 'K'
          ? (p.productType as ProductType)
          : undefined;
      return {
        id: String(p.id || ''),
        companyId: resolvedId,
        code: String(p.code || ''),
        ...(p.barcode ? { barcode: String(p.barcode) } : {}),
        name: String(p.name || ''),
        ...(pt ? { productType: pt } : {}),
        category: String(p.category || 'Geral'),
        unit: String(p.unit || 'UN'),
        ...(typeof p.costPrice === 'number' && p.costPrice > 0
          ? { costPrice: Number(p.costPrice) }
          : {}),
        price: Number(p.price) || 0,
        ivaRate: normalizeRate(p.ivaRate),
        ...(p.exemptionCode ? { exemptionCode: String(p.exemptionCode) as AgtIvaExemptionCode } : {}),
        exemptionReason: String(p.exemptionReason || ''),
        active: Boolean(p.active ?? true),
        ...(typeof p.trackStock === 'boolean'
          ? {
              trackStock: p.trackStock,
              stockQty: Number(p.stockQty) || 0,
              minStockQty: Math.max(0, Number(p.minStockQty) || 0),
            }
          : {}),
        ...(priceHistory.length > 0 ? { priceHistory } : {}),
        syncState: 'synced',
        synced: true,
        createdAtIso: extractTsIso(p.createdAt),
        updatedAtIso: extractTsIso(p.updatedAt, extractTsIso(p.createdAt)),
      };
    });

    const customers: Customer[] = (json.customers || []).map((c) => ({
      id: String(c.id || ''),
      companyId: resolvedId,
      ...(c.internalCode ? { internalCode: String(c.internalCode) } : {}),
      ...(c.customerType ? { customerType: c.customerType as Customer['customerType'] } : {}),
      active: c.active !== false,
      name: String(c.name || ''),
      nif: String(c.nif || ''),
      ...(c.normalizedNif ? { normalizedNif: String(c.normalizedNif) } : {}),
      ...(c.countryCode ? { countryCode: String(c.countryCode) } : {}),
      ...(c.foreignTaxId ? { foreignTaxId: String(c.foreignTaxId) } : {}),
      ...(c.province ? { province: String(c.province) } : {}),
      ...(c.municipality ? { municipality: String(c.municipality) } : {}),
      locality: String(c.locality || ''),
      phone: String(c.phone || ''),
      ...(c.email ? { email: String(c.email) } : {}),
      address: String(c.address || ''),
      ...(typeof c.creditLimit === 'number' && c.creditLimit > 0
        ? { creditLimit: Number(c.creditLimit) }
        : {}),
      ...(c.paymentTerms ? { paymentTerms: c.paymentTerms as Customer['paymentTerms'] } : {}),
      ...(typeof c.hasCreditAccount === 'boolean' ? { hasCreditAccount: c.hasCreditAccount } : {}),
      ...(c.notes ? { notes: String(c.notes) } : {}),
      ...(c.bankName ? { bankName: String(c.bankName) } : {}),
      ...(c.bankIban ? { bankIban: String(c.bankIban) } : {}),
      ...(c.documentRef ? { documentRef: String(c.documentRef) } : {}),
      ...(c.representativeName ? { representativeName: String(c.representativeName) } : {}),
      ...(c.representativePhone ? { representativePhone: String(c.representativePhone) } : {}),
      ...(c.specialCreditNotes ? { specialCreditNotes: String(c.specialCreditNotes) } : {}),
      ...(Array.isArray(c.changeHistory) ? { changeHistory: c.changeHistory as Customer['changeHistory'] } : {}),
      syncState: 'synced',
      synced: true,
      createdAtIso: extractTsIso(c.createdAt),
      updatedAtIso: extractTsIso(c.updatedAt, extractTsIso(c.createdAt)),
    }));

    const invoices: InvoiceRecord[] = (json.invoices || []).map((inv) => {
      const rawLines = Array.isArray(inv.lines)
        ? (inv.lines as Array<Record<string, unknown>>)
        : [];
      const lines: CalculatedLineItem[] = rawLines.map((it) => {
        const lineGross = Number(it.lineGross) || 0;
        const lineNet = Number(it.lineNet) || 0;
        return {
          id: String(it.id || ''),
          productId: String(it.id || ''),
          code: String(it.code || ''),
          description: String(it.description || ''),
          unit: String(it.unit || 'UN'),
          qty: Number(it.qty) || 1,
          unitPrice: Number(it.unitPrice) || 0,
          discountPct: Number(it.discountPct) || 0,
          ivaRate: normalizeRate(it.ivaRate),
          ...(it.exemptionCode ? { exemptionCode: String(it.exemptionCode) as AgtIvaExemptionCode } : {}),
          lineGross,
          lineDiscount: Math.max(0, lineGross - lineNet),
          lineNet,
          lineBase: Number(it.lineBase) || 0,
          lineTax: Number(it.lineTax) || 0,
          lineTotal: Number(it.lineTotal) || 0,
        };
      });

      const issuedAtIso = String(inv.issuedAtIso || now);
      return {
        id: String(inv.id || ''),
        companyId: resolvedId,
        number: String(inv.number || ''),
        docType: normalizeDoc(inv.docType),
        issuedAtIso,
        cashier: String(inv.cashier || '01'),
        operator: String(inv.operator || '001'),
        paymentMethod:
          inv.paymentMethod === 'Multicaixa'
            ? 'Multicaixa'
            : inv.paymentMethod === 'Transferência'
              ? 'Transferência'
              : inv.paymentMethod === 'Crédito'
                ? 'Crédito'
                : inv.paymentMethod === 'Combinado'
                  ? 'Combinado'
                  : 'Dinheiro',
        customerId: String(inv.customerId || ''),
        customerName: String(inv.customerName || 'Consumidor Final'),
        customerNif: String(inv.customerNif || ''),
        customerLocality: String(inv.customerLocality || ''),
        ...(inv.customerType ? { customerType: inv.customerType as InvoiceRecord['customerType'] } : {}),
        ...(inv.customerCountryCode ? { customerCountryCode: String(inv.customerCountryCode) } : {}),
        ...(inv.customerAddress ? { customerAddress: String(inv.customerAddress) } : {}),
        ...(inv.customerPhone ? { customerPhone: String(inv.customerPhone) } : {}),
        ...(inv.customerEmail ? { customerEmail: String(inv.customerEmail) } : {}),
        merchandiseTotal: Number(inv.merchandiseTotal) || 0,
        discountTotal: Number(inv.discountTotal) || 0,
        globalDiscountPct: typeof inv.globalDiscountPct === 'number' ? inv.globalDiscountPct : undefined,
        globalDiscountAmount: typeof inv.globalDiscountAmount === 'number' ? inv.globalDiscountAmount : undefined,
        taxBase14: Number(inv.taxBase14) || 0,
        taxAmount14: Number(inv.taxAmount14) || 0,
        ...(typeof inv.taxBaseIntermediate === 'number' ? { taxBaseIntermediate: inv.taxBaseIntermediate } : {}),
        ...(typeof inv.taxAmountIntermediate === 'number' ? { taxAmountIntermediate: inv.taxAmountIntermediate } : {}),
        ...(typeof inv.taxBaseReduced === 'number' ? { taxBaseReduced: inv.taxBaseReduced } : {}),
        ...(typeof inv.taxAmountReduced === 'number' ? { taxAmountReduced: inv.taxAmountReduced } : {}),
        taxBase0: Number(inv.taxBase0) || 0,
        taxAmount0: 0,
        taxTotal: Number(inv.taxTotal) || 0,
        grandTotal: Number(inv.grandTotal) || 0,
        amountInWords: String(inv.amountInWords || ''),
        ...(inv.issuerSnapshot && typeof inv.issuerSnapshot === 'object'
          ? { issuerSnapshot: inv.issuerSnapshot as InvoiceIssuerSnapshot }
          : {}),
        ...(inv.establishmentId ? { establishmentId: String(inv.establishmentId) } : {}),
        ...(inv.establishmentCode ? { establishmentCode: String(inv.establishmentCode) } : {}),
        ...(inv.establishmentName ? { establishmentName: String(inv.establishmentName) } : {}),
        ...(inv.seriesCode ? { seriesCode: String(inv.seriesCode) } : {}),
        ...(inv.seriesEnvironment
          ? {
              seriesEnvironment: (inv.seriesEnvironment === 'PRODUCAO'
                ? 'PRODUCAO'
                : 'SIMULACAO') as AgtSeriesEnvironment,
            }
          : {}),
        ...(inv.agtAuthorizationCode ? { agtAuthorizationCode: String(inv.agtAuthorizationCode) } : {}),
        ...(inv.atcud ? { atcud: String(inv.atcud) } : {}),
        ...(inv.saftHash4 ? { saftHash4: String(inv.saftHash4) } : {}),
        ...(inv.saftHashFull ? { saftHashFull: String(inv.saftHashFull) } : {}),
        ...(inv.previousInvoiceHash ? { previousInvoiceHash: String(inv.previousInvoiceHash) } : {}),
        sessionId: inv.sessionId ? String(inv.sessionId) : undefined,
        amountReceived: Number(inv.amountReceived) || 0,
        initialAmountReceived:
          typeof inv.initialAmountReceived === 'number' ? inv.initialAmountReceived : undefined,
        changeAmount: Number(inv.changeAmount) || 0,
        initialChangeAmount:
          typeof inv.initialChangeAmount === 'number' ? inv.initialChangeAmount : undefined,
        amountDue: typeof inv.amountDue === 'number' ? inv.amountDue : undefined,
        transferReference: inv.transferReference ? String(inv.transferReference) : undefined,
        paymentSplits: Array.isArray(inv.paymentSplits)
          ? (inv.paymentSplits as Array<Record<string, unknown>>)
              .filter(
                (sp) =>
                  sp &&
                  (sp.method === 'Dinheiro' ||
                    sp.method === 'Multicaixa' ||
                    sp.method === 'Transferência') &&
                  Number(sp.amount) > 0
              )
              .map(
                (sp): PaymentSplit => ({
                  method: sp.method as DirectPaymentMethod,
                  amount: Number(sp.amount),
                  ...(sp.reference ? { reference: String(sp.reference) } : {}),
                })
              )
          : undefined,
        paymentSummary: inv.paymentSummary ? String(inv.paymentSummary) : undefined,
        returnOriginInvoiceId: inv.returnOriginInvoiceId ? String(inv.returnOriginInvoiceId) : undefined,
        returnOriginNumber: inv.returnOriginNumber ? String(inv.returnOriginNumber) : undefined,
        returnCreditApplied: typeof inv.returnCreditApplied === 'number' ? inv.returnCreditApplied : undefined,
        notes: String(inv.notes || ''),
        status: inv.status === 'cancelled' ? 'cancelled' : 'issued',
        cancelReason: inv.cancelReason ? String(inv.cancelReason) : undefined,
        cancelledBy: inv.cancelledBy ? String(inv.cancelledBy) : undefined,
        cancelledAtIso: inv.cancelledAtIso ? String(inv.cancelledAtIso) : undefined,
        reprintCount: typeof inv.reprintCount === 'number' ? inv.reprintCount : undefined,
        lastReprintedAtIso: inv.lastReprintedAtIso ? String(inv.lastReprintedAtIso) : undefined,
        lastReprintedBy: inv.lastReprintedBy ? String(inv.lastReprintedBy) : undefined,
        lines,
        syncState: 'synced',
        synced: true,
        createdAtIso: issuedAtIso,
        updatedAtIso: inv.cancelledAtIso ? String(inv.cancelledAtIso) : issuedAtIso,
      };
    });

    const cashSessions: CashSession[] = (json.cashSessions || []).map((s) => {
      const openedAtIso = String(s.openedAtIso || now);
      return {
        id: String(s.id || ''),
        companyId: resolvedId,
        cashier: String(s.cashier || '01'),
        operator: String(s.operator || '001'),
        openedByUid: s.openedByUid ? String(s.openedByUid) : undefined,
        closedByOperator: s.closedByOperator ? String(s.closedByOperator) : undefined,
        closedByUid: s.closedByUid ? String(s.closedByUid) : undefined,
        status: s.status === 'closed' ? 'closed' : 'open',
        openingFloat: Number(s.openingFloat) || 0,
        openingNotes: s.openingNotes ? String(s.openingNotes) : undefined,
        openedAtIso,
        closedAtIso: s.closedAtIso ? String(s.closedAtIso) : undefined,
        expectedCash: typeof s.expectedCash === 'number' ? s.expectedCash : undefined,
        countedCash: typeof s.countedCash === 'number' ? s.countedCash : undefined,
        differenceAmount: typeof s.differenceAmount === 'number' ? s.differenceAmount : undefined,
        salesCash: typeof s.salesCash === 'number' ? s.salesCash : undefined,
        salesMulticaixa: typeof s.salesMulticaixa === 'number' ? s.salesMulticaixa : undefined,
        salesTransfer: typeof s.salesTransfer === 'number' ? s.salesTransfer : undefined,
        salesCredit: typeof s.salesCredit === 'number' ? s.salesCredit : undefined,
        debtCash: typeof s.debtCash === 'number' ? s.debtCash : undefined,
        debtMulticaixa: typeof s.debtMulticaixa === 'number' ? s.debtMulticaixa : undefined,
        debtTransfer: typeof s.debtTransfer === 'number' ? s.debtTransfer : undefined,
        reforcosTotal: typeof s.reforcosTotal === 'number' ? s.reforcosTotal : undefined,
        entradasTotal: typeof s.entradasTotal === 'number' ? s.entradasTotal : undefined,
        sangriasTotal: typeof s.sangriasTotal === 'number' ? s.sangriasTotal : undefined,
        saidasTotal: typeof s.saidasTotal === 'number' ? s.saidasTotal : undefined,
        invoiceCount: typeof s.invoiceCount === 'number' ? s.invoiceCount : undefined,
        closingNotes: s.closingNotes ? String(s.closingNotes) : undefined,
        syncState: 'synced',
        synced: true,
        createdAtIso: openedAtIso,
        updatedAtIso: String(s.closedAtIso || openedAtIso),
      };
    });

    const cashMovements: CashMovement[] = (json.cashMovements || []).map((m) => {
      const rawType = String(m.type || 'ENTRADA') as CashMovementType;
      const validType: CashMovementType =
        rawType === 'REFORCO' ||
        rawType === 'SANGRIA' ||
        rawType === 'ENTRADA' ||
        rawType === 'SAIDA' ||
        rawType === 'LIQUIDACAO_DIVIDA'
          ? rawType
          : 'ENTRADA';
      const pm: DirectPaymentMethod =
        m.paymentMethod === 'Multicaixa'
          ? 'Multicaixa'
          : m.paymentMethod === 'Transferência'
            ? 'Transferência'
            : 'Dinheiro';
      return {
        id: String(m.id || ''),
        companyId: resolvedId,
        sessionId: String(m.sessionId || 'unassigned'),
        cashier: String(m.cashier || '01'),
        operator: String(m.operator || '001'),
        type: validType,
        amount: Number(m.amount) || 0,
        paymentMethod: pm,
        reason: String(m.reason || ''),
        reference: m.reference ? String(m.reference) : undefined,
        invoiceId: m.invoiceId ? String(m.invoiceId) : undefined,
        invoiceNumber: m.invoiceNumber ? String(m.invoiceNumber) : undefined,
        customerName: m.customerName ? String(m.customerName) : undefined,
        createdByUid: m.createdByUid ? String(m.createdByUid) : undefined,
        syncState: 'synced',
        synced: true,
        createdAtIso: String(m.createdAtIso || now),
      };
    });

    const stockMovements: StockMovement[] = (json.stockMovements || []).map((sm) => {
      const rawType = String(sm.type || 'AJUSTE_INVENTARIO') as StockMovementType;
      const validType: StockMovementType =
        rawType === 'ENTRADA_MERCADORIA' ||
        rawType === 'SAIDA_VENDA' ||
        rawType === 'DEVOLUCAO_CLIENTE' ||
        rawType === 'AJUSTE_INVENTARIO' ||
        rawType === 'RECONCILIACAO_FISICA' ||
        rawType === 'TRANSFERENCIA_ARMAZEM'
          ? rawType
          : 'AJUSTE_INVENTARIO';
      const rawDir = String(sm.direction || 'NEUTRAL') as StockMovementDirection;
      const validDir: StockMovementDirection =
        rawDir === 'IN' || rawDir === 'OUT' || rawDir === 'NEUTRAL' ? rawDir : 'NEUTRAL';
      return {
        id: String(sm.id || ''),
        companyId: resolvedId,
        productId: String(sm.productId || ''),
        productCode: String(sm.productCode || ''),
        productName: String(sm.productName || ''),
        unit: String(sm.unit || 'un'),
        type: validType,
        direction: validDir,
        qty: Math.max(0, Number(sm.qty) || 0),
        previousStock: Number(sm.previousStock) || 0,
        newStock: Number(sm.newStock) || 0,
        ...(typeof sm.unitCost === 'number' && sm.unitCost >= 0
          ? { unitCost: Number(sm.unitCost) }
          : {}),
        warehouseId: String(sm.warehouseId || DEFAULT_WAREHOUSE_ID),
        ...(sm.targetWarehouseId ? { targetWarehouseId: String(sm.targetWarehouseId) } : {}),
        reason: String(sm.reason || ''),
        ...(sm.reference ? { reference: String(sm.reference) } : {}),
        ...(sm.invoiceId ? { invoiceId: String(sm.invoiceId) } : {}),
        ...(sm.invoiceNumber ? { invoiceNumber: String(sm.invoiceNumber) } : {}),
        operator: String(sm.operator || '001'),
        ...(sm.createdByUid ? { createdByUid: String(sm.createdByUid) } : {}),
        syncState: 'synced',
        synced: true,
        createdAtIso: String(sm.createdAtIso || now),
      };
    });

    const suppliers: Supplier[] = (json.suppliers || []).map((sup) => ({
      id: String(sup.id || ''),
      companyId: resolvedId,
      name: String(sup.name || ''),
      nif: String(sup.nif || ''),
      phone: String(sup.phone || ''),
      ...(sup.email ? { email: String(sup.email) } : {}),
      address: String(sup.address || ''),
      locality: String(sup.locality || ''),
      ...(sup.contactPerson ? { contactPerson: String(sup.contactPerson) } : {}),
      ...(sup.iban ? { iban: String(sup.iban) } : {}),
      ...(typeof sup.paymentTermsDays === 'number'
        ? { paymentTermsDays: Number(sup.paymentTermsDays) }
        : {}),
      ...(sup.notes ? { notes: String(sup.notes) } : {}),
      active: sup.active !== false,
      syncState: 'synced',
      synced: true,
      updatedAtIso: extractTsIso(sup.updatedAt, extractTsIso(sup.createdAt)),
    }));

    const purchases: PurchaseRecord[] = (json.purchases || []).map((pur) => {
      const rawLines = Array.isArray(pur.lines)
        ? (pur.lines as Array<Record<string, unknown>>)
        : [];
      const lines: PurchaseLineItem[] = rawLines.map((it) => ({
        productId: String(it.productId || ''),
        code: String(it.code || ''),
        name: String(it.name || ''),
        unit: String(it.unit || 'UN'),
        qty: Math.max(0, Number(it.qty) || 0),
        unitCost: Math.max(0, Number(it.unitCost) || 0),
        total: Math.max(0, Number(it.total) || 0),
      }));
      const pm: PurchasePaymentMethod =
        pur.paymentMethod === 'Multicaixa' ||
        pur.paymentMethod === 'Transferência' ||
        pur.paymentMethod === 'Crédito'
          ? pur.paymentMethod
          : 'Dinheiro';

      return {
        id: String(pur.id || ''),
        companyId: resolvedId,
        number: String(pur.number || ''),
        ...(pur.supplierInvoiceRef
          ? { supplierInvoiceRef: String(pur.supplierInvoiceRef) }
          : {}),
        supplierId: String(pur.supplierId || ''),
        supplierName: String(pur.supplierName || ''),
        supplierNif: String(pur.supplierNif || ''),
        issuedAtIso: String(pur.issuedAtIso || now),
        ...(pur.dueDateIso ? { dueDateIso: String(pur.dueDateIso) } : {}),
        lines,
        totalAmount: Math.max(0, Number(pur.totalAmount) || 0),
        amountPaid: Math.max(0, Number(pur.amountPaid) || 0),
        amountDue: Math.max(0, Number(pur.amountDue) || 0),
        paymentMethod: pm,
        ...(pur.paymentSummary ? { paymentSummary: String(pur.paymentSummary) } : {}),
        ...(pur.reference ? { reference: String(pur.reference) } : {}),
        warehouseId: String(pur.warehouseId || DEFAULT_WAREHOUSE_ID),
        updateStock: Boolean(pur.updateStock ?? true),
        notes: String(pur.notes || ''),
        operator: String(pur.operator || '001'),
        status: pur.status === 'cancelled' ? 'cancelled' : 'recorded',
        ...(pur.cancelReason ? { cancelReason: String(pur.cancelReason) } : {}),
        ...(pur.cancelledBy ? { cancelledBy: String(pur.cancelledBy) } : {}),
        ...(pur.createdByUid ? { createdByUid: String(pur.createdByUid) } : {}),
        syncState: 'synced',
        synced: true,
        updatedAtIso: String(pur.issuedAtIso || now),
      };
    });

    let settings: AppSettings | null = null;
    if (json.settings && typeof json.settings === 'object') {
      const sd = json.settings;
      const hydratedCompany = hydrateProfileFromCloud(sd, resolvedId);
      settings = {
        companyId: resolvedId,
        company: {
          ...hydratedCompany,
          legalName: String(sd.legalName || DEFAULT_SETTINGS.company.legalName),
          shortName: String(sd.shortName || DEFAULT_SETTINGS.company.shortName),
          nif: String(sd.nif || DEFAULT_SETTINGS.company.nif),
          address: String(sd.address || DEFAULT_SETTINGS.company.address),
          cityCountry: String(sd.cityCountry || DEFAULT_SETTINGS.company.cityCountry),
          phone: String(sd.phone || ''),
          email: String(sd.email || ''),
          tagline: String(sd.tagline || ''),
        },
        defaultCashier: String(sd.defaultCashier || '01'),
        defaultOperator: String(sd.defaultOperator || '001'),
        defaultFormat: sd.defaultFormat === 'A4' ? 'A4' : 'POS',
        defaultDocType: normalizeDoc(sd.defaultDocType),
        defaultNotes: String(sd.defaultNotes || ''),
        autoPrintOnEmit: Boolean(sd.autoPrintOnEmit),
        ...(sd.defaultEstablishmentId ? { defaultEstablishmentId: String(sd.defaultEstablishmentId) } : {}),
        agtEnvironment: sd.agtEnvironment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO',
        hidePromotionalFooter:
          typeof sd.hidePromotionalFooter === 'boolean' ? sd.hidePromotionalFooter : true,
        allowCashierPriceEdit: Boolean(sd.allowCashierPriceEdit ?? false),
        syncState: 'synced',
        synced: true,
        updatedAtIso: extractTsIso(sd.updatedAt),
      };
    }

    const members: CompanyMember[] | undefined = Array.isArray(json.members)
      ? json.members.map((m) => {
          const baseRole = resolveMemberBaseRole({ role: m.role as CompanyRole });
          const st = resolveMemberStatus({
            status: m.status as CompanyMember['status'],
            active: typeof m.active === 'boolean' ? m.active : true,
          });
          return {
            id: String(m.id || m.uid || ''),
            companyId: resolvedId,
            uid: String(m.uid || m.id || ''),
            email: String(m.email || ''),
            ...(m.phone ? { phone: String(m.phone) } : {}),
            displayName: String(m.displayName || m.email || 'Operador'),
            role: baseRole,
            ...(m.roleId ? { roleId: String(m.roleId) } : { roleId: `role_${baseRole}` }),
            ...(Array.isArray(m.establishmentIds)
              ? { establishmentIds: (m.establishmentIds as unknown[]).map((x) => String(x)) }
              : {}),
            ...(Array.isArray(m.authorizedCashiers)
              ? { authorizedCashiers: (m.authorizedCashiers as unknown[]).map((x) => String(x)) }
              : {}),
            ...(m.permissionOverrides && typeof m.permissionOverrides === 'object'
              ? { permissionOverrides: m.permissionOverrides as CompanyMember['permissionOverrides'] }
              : {}),
            status: st,
            ...(m.pinHash ? { pinHash: String(m.pinHash) } : {}),
            allowInvoiceCancel: Boolean(m.allowInvoiceCancel),
            active: st === 'active',
            createdAtIso: now,
            updatedAtIso: now,
          };
        })
      : undefined;

    const roles: CompanyRoleDefinition[] | undefined = Array.isArray(json.roles)
      ? json.roles.map((r) => ({
          id: String(r.id || ''),
          companyId: resolvedId,
          name: String(r.name || ''),
          description: String(r.description || ''),
          baseRole: resolveMemberBaseRole({ role: (r.baseRole || 'cashier') as CompanyRole }),
          isSystem: Boolean(r.isSystem),
          permissions: (r.permissions || {}) as CompanyRoleDefinition['permissions'],
          createdAtIso: String(r.createdAtIso || now),
          updatedAtIso: String(r.updatedAtIso || now),
        }))
      : undefined;

    const fiscalSeries: AgtSeriesRecord[] | undefined = Array.isArray(json.fiscalSeries)
      ? json.fiscalSeries.map((sd) => ({
          id: String(sd.id || ''),
          companyId: resolvedId,
          seriesCode: String(sd.seriesCode || ''),
          seriesYear: Number(sd.seriesYear) || new Date().getFullYear(),
          documentType: String(sd.documentType || 'FR') as AgtDocumentType,
          firstDocumentNumber: Number(sd.firstDocumentNumber) || 1,
          lastDocumentNumber: Number(sd.lastDocumentNumber) || 0,
          status: (sd.status === 'F' ? 'F' : sd.status === 'U' ? 'U' : 'A') as AgtSeriesStatus,
          environment: (sd.environment === 'PRODUCAO' ? 'PRODUCAO' : 'SIMULACAO') as AgtSeriesEnvironment,
          ...(sd.establishmentId ? { establishmentId: String(sd.establishmentId) } : {}),
          ...(sd.establishmentCode ? { establishmentCode: String(sd.establishmentCode) } : {}),
          ...(sd.agtAuthorizationCode ? { agtAuthorizationCode: String(sd.agtAuthorizationCode) } : {}),
          requestedAtIso: String(sd.requestedAtIso || now),
          ...(sd.authorizedAtIso ? { authorizedAtIso: String(sd.authorizedAtIso) } : {}),
          ...(sd.closedAtIso ? { closedAtIso: String(sd.closedAtIso) } : {}),
          ...(sd.notes ? { notes: String(sd.notes) } : {}),
        }))
      : undefined;

    const auditLogs: SecurityAuditEntry[] | undefined = Array.isArray(json.auditLogs)
      ? json.auditLogs.map((al) => ({
          id: String(al.id || ''),
          companyId: resolvedId,
          ...(al.establishmentId ? { establishmentId: String(al.establishmentId) } : {}),
          actorUid: String(al.actorUid || ''),
          ...(al.actorEmail ? { actorEmail: String(al.actorEmail) } : {}),
          actorName: String(al.actorName || 'Operador'),
          actorRole: String(al.actorRole || ''),
          action: String(al.action || 'LOGIN') as SecurityAuditEntry['action'],
          targetType: String(al.targetType || ''),
          ...(al.targetId ? { targetId: String(al.targetId) } : {}),
          summary: String(al.summary || ''),
          ...(al.beforeJson ? { beforeJson: String(al.beforeJson) } : {}),
          ...(al.afterJson ? { afterJson: String(al.afterJson) } : {}),
          outcome: al.outcome === 'denied' ? 'denied' : 'allowed',
          createdAtIso: String(al.createdAtIso || now),
          synced: true,
        }))
      : undefined;

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
      auditLogs,
      members,
      roles,
      settings,
    };
  } catch {
    return null;
  }
}

// ==================== INTEGRAÇÃO AGT (DECRETO EXECUTIVO 683/25) ====================

export async function registerAgtBatchBackend(
  documents: any[],
  environment: 'HOMOLOGACAO' | 'PRODUCAO' = 'HOMOLOGACAO'
): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/agt/invoices/register-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documents, environment }),
    });
    const data = await res.json();
    return { ok: res.ok, result: data.result, error: data.error };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro de rede ao comunicar com a AGT.' };
  }
}

export async function getAgtBatchStatusBackend(
  requestId: string,
  submissionGUID?: string
): Promise<{ ok: boolean; status?: any; error?: string }> {
  try {
    const url = new URL(`${API_BASE}/api/agt/invoices/status/${encodeURIComponent(requestId)}`, window.location.origin);
    if (submissionGUID) url.searchParams.set('submissionGUID', submissionGUID);
    const res = await fetch(url.toString());
    const data = await res.json();
    return { ok: res.ok, status: data.status, error: data.error };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao consultar estado na AGT.' };
  }
}

export async function queryAgtDocumentBackend(
  documentNo: string,
  companyTaxID: string
): Promise<{ ok: boolean; queryRes?: any; error?: string }> {
  try {
    const url = new URL(`${API_BASE}/api/agt/invoices/query/${encodeURIComponent(documentNo)}`, window.location.origin);
    url.searchParams.set('companyTaxID', companyTaxID);
    const res = await fetch(url.toString());
    const data = await res.json();
    return { ok: res.ok, queryRes: data.queryRes, error: data.error };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao consultar documento na AGT.' };
  }
}

export async function validateAgtDocumentBackend(
  document: any
): Promise<{ ok: boolean; validation?: any; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/agt/invoices/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    });
    const data = await res.json();
    return { ok: res.ok, validation: data.validation, error: data.error };
  } catch (err: any) {
    return { ok: false, error: err.message || 'Erro ao validar documento junto do serviço AGT.' };
  }
}

// ==================== RBAC, CONVITES E AUDITORIA DE SEGURANÇA ====================

export async function claimCompanyInvitesBackend(): Promise<{
  ok: boolean;
  claimedCompanyIds: string[];
}> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/companies/invites/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      claimedCompanyIds?: string[];
    };
    return {
      ok: Boolean(data.ok),
      claimedCompanyIds: Array.isArray(data.claimedCompanyIds) ? data.claimedCompanyIds : [],
    };
  } catch {
    return { ok: false, claimedCompanyIds: [] };
  }
}

export async function upsertCompanyMemberBackend(
  companyId: string,
  member: CompanyMember
): Promise<{ ok: boolean; persistedInFirestore?: boolean; status?: string; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyId)}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify(member),
    });
    return (await res.json().catch(() => ({ ok: false }))) as {
      ok: boolean;
      persistedInFirestore?: boolean;
      status?: string;
      error?: string;
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erro ao sincronizar colaborador.' };
  }
}

export async function deleteCompanyMemberBackend(
  companyId: string,
  memberId: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(
      `${API_BASE}/api/companies/${encodeURIComponent(companyId)}/members/${encodeURIComponent(memberId)}`,
      {
        method: 'DELETE',
        headers,
      }
    );
    return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erro ao remover colaborador.' };
  }
}

export async function upsertCompanyRoleBackend(
  companyId: string,
  role: CompanyRoleDefinition
): Promise<{ ok: boolean; error?: string }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyId)}/roles`, {
      method: 'POST',
      headers,
      body: JSON.stringify(role),
    });
    return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Erro ao sincronizar função.' };
  }
}

export async function appendSecurityAuditBackend(
  companyId: string,
  entry: SecurityAuditEntry
): Promise<{ ok: boolean }> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyId)}/audit-logs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(entry),
    });
    return { ok: res.ok };
  } catch {
    return { ok: false };
  }
}

export async function fetchSecurityAuditsBackend(
  companyId: string
): Promise<SecurityAuditEntry[]> {
  try {
    const headers = await getBearerHeaders();
    const res = await fetch(`${API_BASE}/api/companies/${encodeURIComponent(companyId)}/audit-logs`, {
      method: 'GET',
      headers,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { ok?: boolean; logs?: SecurityAuditEntry[] };
    return Array.isArray(data.logs) ? data.logs : [];
  } catch {
    return [];
  }
}

