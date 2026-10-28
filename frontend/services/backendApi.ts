import type { InvoiceRecord } from '../../src/core/types.ts';
import { auth } from '../../src/services/firebaseClient.ts';

function resolveApiBaseUrl(): string {
  const raw = typeof import.meta !== 'undefined' && import.meta.env
    ? String(import.meta.env.VITE_API_BASE_URL || '')
    : '';
  return raw.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
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

async function getBearerHeaders(): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Autentique-se na conta Cloud para usar endpoints administrativos.');
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

export async function submitInvoiceAudit(invoice: InvoiceRecord): Promise<AuditInvoiceResponse> {
  const headers = await getBearerHeaders();
  const payload = {
    id: invoice.id,
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

export async function downloadCloudBackupJson(): Promise<void> {
  const headers = await getBearerHeaders();
  const res = await fetch(`${API_BASE}/api/backup`, {
    method: 'GET',
    headers,
  });

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
  a.download = `sila-billing-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
