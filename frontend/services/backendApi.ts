import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CalculatedLineItem,
  type CompanyOperationalStatus,
  type CompanyRecord,
  type Customer,
  type InvoiceRecord,
  type PlanTier,
  type Product,
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

export interface AdminOverviewResponse {
  ok: boolean;
  statusCode?: number;
  adminEmail?: string;
  cloudPersisted?: boolean;
  companies?: AdminCompanySummary[];
  recentLogs?: AdminAuditEntry[];
  error?: string;
}

async function getBearerHeaders(): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Autentique-se na conta Google para aceder a serviços verificados.');
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
    amountReceived: invoice.amountReceived,
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
    const res = await fetch(`${API_BASE}/api/admin/overview`, {
      method: 'GET',
      headers,
    });
    const json = (await res.json().catch(() => ({ ok: false }))) as AdminOverviewResponse;
    return { ...json, statusCode: res.status };
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      error: err instanceof Error ? err.message : 'Falha de comunicação com o servidor.',
    };
  }
}

export async function updatePlatformCompanyAdmin(
  companyId: string,
  patch: { status?: CompanyOperationalStatus; planTier?: PlanTier; reason?: string }
): Promise<{ ok: boolean; error?: string }> {
  const headers = await getBearerHeaders();
  const res = await fetch(`${API_BASE}/api/admin/companies/${encodeURIComponent(companyId)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(patch),
  });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; error?: string };
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
      products?: Array<Record<string, unknown>>;
      customers?: Array<Record<string, unknown>>;
      invoices?: Array<Record<string, unknown>>;
      settings?: Record<string, unknown> | null;
    };
    if (!json.ok) return null;

    const now = new Date().toISOString();
    const products: Product[] = (json.products || []).map((p) => ({
      id: String(p.id || ''),
      companyId: resolvedId,
      code: String(p.code || ''),
      name: String(p.name || ''),
      category: String(p.category || 'Geral'),
      unit: String(p.unit || 'UN'),
      price: Number(p.price) || 0,
      ivaRate: Number(p.ivaRate) === 14 ? 14 : 0,
      exemptionReason: String(p.exemptionReason || ''),
      active: Boolean(p.active ?? true),
      syncState: 'synced',
      synced: true,
      createdAtIso: now,
      updatedAtIso: now,
    }));

    const customers: Customer[] = (json.customers || []).map((c) => ({
      id: String(c.id || ''),
      companyId: resolvedId,
      name: String(c.name || ''),
      nif: String(c.nif || ''),
      locality: String(c.locality || ''),
      phone: String(c.phone || ''),
      address: String(c.address || ''),
      syncState: 'synced',
      synced: true,
      createdAtIso: now,
      updatedAtIso: now,
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
          ivaRate: Number(it.ivaRate) === 14 ? 14 : 0,
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
        docType: inv.docType === 'FP' ? 'FP' : 'FR',
        issuedAtIso,
        cashier: String(inv.cashier || '01'),
        operator: String(inv.operator || '001'),
        paymentMethod:
          inv.paymentMethod === 'Multicaixa'
            ? 'Multicaixa'
            : inv.paymentMethod === 'Transferência'
              ? 'Transferência'
              : 'Dinheiro',
        customerId: String(inv.customerId || ''),
        customerName: String(inv.customerName || 'Consumidor Final'),
        customerNif: String(inv.customerNif || ''),
        customerLocality: String(inv.customerLocality || ''),
        merchandiseTotal: Number(inv.merchandiseTotal) || 0,
        discountTotal: Number(inv.discountTotal) || 0,
        taxBase14: Number(inv.taxBase14) || 0,
        taxAmount14: Number(inv.taxAmount14) || 0,
        taxBase0: Number(inv.taxBase0) || 0,
        taxAmount0: 0,
        taxTotal: Number(inv.taxTotal) || 0,
        grandTotal: Number(inv.grandTotal) || 0,
        amountInWords: String(inv.amountInWords || ''),
        amountReceived: Number(inv.amountReceived) || 0,
        changeAmount: Number(inv.changeAmount) || 0,
        notes: String(inv.notes || ''),
        status: inv.status === 'cancelled' ? 'cancelled' : 'issued',
        cancelReason: inv.cancelReason ? String(inv.cancelReason) : undefined,
        cancelledBy: inv.cancelledBy ? String(inv.cancelledBy) : undefined,
        lines,
        syncState: 'synced',
        synced: true,
        createdAtIso: issuedAtIso,
        updatedAtIso: issuedAtIso,
      };
    });

    let settings: AppSettings | null = null;
    if (json.settings && typeof json.settings === 'object') {
      const sd = json.settings;
      settings = {
        companyId: resolvedId,
        company: {
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
        defaultDocType: sd.defaultDocType === 'FP' ? 'FP' : 'FR',
        defaultNotes: String(sd.defaultNotes || ''),
        autoPrintOnEmit: Boolean(sd.autoPrintOnEmit),
        hidePromotionalFooter:
          typeof sd.hidePromotionalFooter === 'boolean' ? sd.hidePromotionalFooter : true,
        syncState: 'synced',
        synced: true,
        updatedAtIso: now,
      };
    }

    return { products, customers, invoices, settings };
  } catch {
    return null;
  }
}
