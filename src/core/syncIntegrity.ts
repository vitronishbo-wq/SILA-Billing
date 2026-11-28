import { roundKz } from './billingEngine.ts';
import type { AgtDocumentType, AgtSeriesEnvironment } from './fiscalTypes.ts';
import { computeDocumentSaftHash4, generateChainedDocumentHash } from './saftGenerator.ts';
import {
  formatFiscalDocumentNo,
  normalizeSeriesEnvironment,
  parseFiscalDocumentNo,
  reservarProximoNumeroFiscal,
  sincronizarSequenciaMaximaSerie,
} from './seriesManager.ts';
import type {
  AppSettings,
  CartDraftItem,
  CashMovement,
  CashSession,
  CommittedCheckoutOpRecord,
  Customer,
  DocumentType,
  InvoiceRecord,
  Product,
  PurchaseRecord,
  StockMovement,
  Supplier,
  SyncBaselineMap,
  SyncConflictRecord,
  SyncQueueEntry,
} from './types.ts';

const TERMINAL_DEVICE_STORAGE_KEY = 'sila_terminal_device_id_v1';
let fallbackEphemeralDeviceId = '';
let monotonicIdCounter = 0;

const memoryExecutionLocks = new Map<string, Promise<void>>();

/**
 * Garante um identificador estável por dispositivo/navegador para rastrear origem
 * e eliminar colisões de IDs entre terminais offline.
 */
export function getOrCreateTerminalDeviceId(): string {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      const existing = window.localStorage.getItem(TERMINAL_DEVICE_STORAGE_KEY);
      if (existing && /^[a-zA-Z0-9_-]{6,32}$/.test(existing)) {
        return existing;
      }
      const rand =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
          : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 10);
      const generated = `term_${rand}`;
      window.localStorage.setItem(TERMINAL_DEVICE_STORAGE_KEY, generated);
      return generated;
    }
  } catch {
    // Fallback em memória caso localStorage esteja bloqueado
  }
  if (!fallbackEphemeralDeviceId) {
    fallbackEphemeralDeviceId = `term_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }
  return fallbackEphemeralDeviceId;
}

/**
 * Gera identificadores únicos à prova de colisão mesmo em emissões no mesmo milissegundo
 * ou entre múltiplos terminais/abas offline.
 */
export function generateUniqueEntityId(prefix: string, deviceId?: string): string {
  const cleanPrefix = String(prefix || 'rec')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 16) || 'rec';
  const cleanDev = String(deviceId || getOrCreateTerminalDeviceId())
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-6);
  monotonicIdCounter = (monotonicIdCounter + 1) % 1_000_000;
  const seqTag = monotonicIdCounter.toString(36).padStart(2, '0');
  const uuidChunk =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 8)
      : `${Math.random().toString(36).slice(2, 6)}${Math.random().toString(36).slice(2, 6)}`;
  return `${cleanPrefix}_${Date.now()}_${cleanDev}_${seqTag}${uuidChunk}`;
}

/**
 * Serializa operações críticas (emissão fiscal, reserva de série, sync) entre múltiplas abas
 * do mesmo navegador via Web Locks API com mutex em memória para ambientes sem navigator.locks.
 */
export async function withTerminalExecutionLock<T>(
  lockName: string,
  fn: () => Promise<T>
): Promise<T> {
  const runInMemoryMutex = async (): Promise<T> => {
    const prev = memoryExecutionLocks.get(lockName) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextChain = prev.then(() => gate, () => gate);
    memoryExecutionLocks.set(lockName, nextChain);
    await prev.catch(() => null);
    try {
      return await fn();
    } finally {
      release();
      if (memoryExecutionLocks.get(lockName) === nextChain) {
        memoryExecutionLocks.delete(lockName);
      }
    }
  };

  const navLocks =
    typeof navigator !== 'undefined'
      ? (navigator as unknown as {
          locks?: {
            request: <R>(
              name: string,
              cb: () => Promise<R>
            ) => Promise<R>;
          };
        }).locks
      : undefined;

  if (navLocks && typeof navLocks.request === 'function') {
    return navLocks.request(lockName, runInMemoryMutex);
  }
  return runInMemoryMutex();
}

function stableDjb2Hash(raw: string): string {
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Assinatura determinística do carrinho atual para prevenção de submissões duplicadas.
 */
export function computeCartFingerprint(params: {
  companyId: string;
  docType: DocumentType;
  customerId: string;
  paymentMethod: string;
  globalDiscountPct: number;
  grandTotal: number;
  cart: ReadonlyArray<CartDraftItem>;
}): string {
  const canonicalLines = (params.cart || []).map((l) => ({
    id: l.productId,
    qty: roundKz(Number(l.qty) || 0),
    price: roundKz(Number(l.unitPrice) || 0),
    disc: roundKz(Number(l.discountPct) || 0),
    iva: Number(l.ivaRate) || 0,
  }));
  return stableDjb2Hash(
    JSON.stringify({
      c: params.companyId,
      dt: params.docType,
      cu: params.customerId,
      pm: params.paymentMethod,
      gd: roundKz(params.globalDiscountPct || 0),
      gt: roundKz(params.grandTotal || 0),
      lines: canonicalLines,
    })
  );
}

export interface DuplicateCheckoutCheckResult {
  duplicate: boolean;
  reason?: string;
  existingInvoiceId?: string;
  existingInvoiceNumber?: string;
}

/**
 * Bloqueia cliques duplos, reenvios após timeout ou gravações repetidas da mesma operação de venda.
 */
export function checkDuplicateCheckoutSubmission(params: {
  companyId: string;
  clientOperationId: string;
  cartFingerprint: string;
  existingInvoices: ReadonlyArray<InvoiceRecord>;
  recentCommittedOps: ReadonlyArray<CommittedCheckoutOpRecord>;
  nowMs?: number;
  rapidWindowMs?: number;
}): DuplicateCheckoutCheckResult {
  const opId = String(params.clientOperationId || '').trim();
  if (opId) {
    const matchedInv = params.existingInvoices.find(
      (i) => (i.companyId || params.companyId) === params.companyId && i.clientOperationId === opId
    );
    if (matchedInv) {
      return {
        duplicate: true,
        existingInvoiceId: matchedInv.id,
        existingInvoiceNumber: matchedInv.number,
        reason: `Esta venda já foi registada (${matchedInv.number}). Submissão duplicada bloqueada.`,
      };
    }

    const matchedOp = params.recentCommittedOps.find((op) => op.operationId === opId);
    if (matchedOp) {
      return {
        duplicate: true,
        existingInvoiceId: matchedOp.invoiceId,
        existingInvoiceNumber: matchedOp.invoiceNumber,
        reason: `Operação já concluída como ${matchedOp.invoiceNumber}. Repetição bloqueada.`,
      };
    }
  }

  const nowMs = params.nowMs ?? Date.now();
  const rapidWindowMs = params.rapidWindowMs ?? 3500;
  const rapidMatch = params.recentCommittedOps.find((op) => {
    if (op.cartFingerprint !== params.cartFingerprint) return false;
    const opMs = Date.parse(op.committedAtIso);
    return Number.isFinite(opMs) && Math.abs(nowMs - opMs) <= rapidWindowMs;
  });

  if (rapidMatch) {
    return {
      duplicate: true,
      existingInvoiceId: rapidMatch.invoiceId,
      existingInvoiceNumber: rapidMatch.invoiceNumber,
      reason: `Venda idêntica acabada de emitir (${rapidMatch.invoiceNumber}). Aguarde alguns segundos antes de repetir o mesmo carrinho.`,
    };
  }

  return { duplicate: false };
}

export function normalizeFiscalNumberKey(
  numberRaw: string,
  env?: AgtSeriesEnvironment | string
): string {
  const cleanNo = String(numberRaw || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
  const cleanEnv = normalizeSeriesEnvironment(env);
  return `${cleanEnv}::${cleanNo}`;
}

/**
 * Calcula o maior número sequencial já existente em faturas locais/cloud para uma série,
 * impedindo que um reset parcial de localStorage cause reutilização de numeração fiscal.
 */
export function getHighestSequenceForSeriesInInvoices(
  invoices: ReadonlyArray<InvoiceRecord>,
  params: {
    companyId: string;
    docType: AgtDocumentType;
    seriesCode: string;
    environment: AgtSeriesEnvironment;
  }
): number {
  const targetEnv = normalizeSeriesEnvironment(params.environment);
  const targetCode = String(params.seriesCode || '').trim().toUpperCase();
  let maxSeq = 0;

  for (const inv of invoices) {
    if ((inv.companyId || params.companyId) !== params.companyId) continue;
    if (normalizeSeriesEnvironment(inv.seriesEnvironment) !== targetEnv) continue;
    const parsed = parseFiscalDocumentNo(inv.number);
    if (!parsed.valid || !parsed.seqNumber) continue;
    if (parsed.docType !== params.docType) continue;
    if (parsed.seriesCode !== targetCode) continue;
    if (parsed.seqNumber > maxSeq) {
      maxSeq = parsed.seqNumber;
    }
  }
  return maxSeq;
}

export function computeBaselineKey(
  entityType: SyncQueueEntry['entityType'],
  entityId: string
): string {
  return `${entityType}:${entityId}`;
}

export function computeProductCatalogFingerprint(p: Product): string {
  return stableDjb2Hash(
    JSON.stringify({
      code: String(p.code || '').trim(),
      barcode: String(p.barcode || '').trim(),
      name: String(p.name || '').trim(),
      pt: p.productType || 'P',
      cat: String(p.category || 'Geral').trim(),
      unit: String(p.unit || 'un').trim(),
      price: roundKz(Number(p.price) || 0),
      cost: typeof p.costPrice === 'number' ? roundKz(p.costPrice) : 0,
      iva: Number(p.ivaRate) || 0,
      exCode: p.exemptionCode || '',
      exReason: String(p.exemptionReason || '').trim(),
      active: Boolean(p.active),
      trackStock: Boolean(p.trackStock),
      minStock: roundKz(Number(p.minStockQty) || 0),
    })
  );
}

export function computeProductFingerprint(p: Product): string {
  return `${computeProductCatalogFingerprint(p)}|stk:${roundKz(Number(p.stockQty) || 0)}`;
}

export function computeCustomerFingerprint(c: Customer): string {
  return stableDjb2Hash(
    JSON.stringify({
      name: String(c.name || '').trim(),
      nif: String(c.nif || '').trim().toUpperCase(),
      type: c.customerType || 'PARTICULAR',
      active: c.active !== false,
      locality: String(c.locality || '').trim(),
      province: String(c.province || '').trim(),
      municipality: String(c.municipality || '').trim(),
      phone: String(c.phone || '').trim(),
      email: String(c.email || '').trim().toLowerCase(),
      address: String(c.address || '').trim(),
      creditLimit: roundKz(Number(c.creditLimit) || 0),
      paymentTerms: c.paymentTerms || 'IMEDIATO',
      hasCredit: Boolean(c.hasCreditAccount),
      notes: String(c.notes || '').trim(),
    })
  );
}

export function computeSupplierFingerprint(s: Supplier): string {
  return stableDjb2Hash(
    JSON.stringify({
      name: String(s.name || '').trim(),
      nif: String(s.nif || '').trim().toUpperCase(),
      phone: String(s.phone || '').trim(),
      email: String(s.email || '').trim().toLowerCase(),
      address: String(s.address || '').trim(),
      locality: String(s.locality || '').trim(),
      contactPerson: String(s.contactPerson || '').trim(),
      iban: String(s.iban || '').trim(),
      terms: Number(s.paymentTermsDays) || 0,
      notes: String(s.notes || '').trim(),
      active: s.active !== false,
    })
  );
}

export function computeSettingsFingerprint(s: AppSettings): string {
  return stableDjb2Hash(
    JSON.stringify({
      legalName: String(s.company?.legalName || '').trim(),
      shortName: String(s.company?.shortName || '').trim(),
      nif: String(s.company?.nif || '').trim(),
      taxRegime: s.company?.taxRegime || 'GERAL',
      agtEnv: s.agtEnvironment || s.company?.agtEnvironment || 'SIMULACAO',
      address: String(s.company?.address || '').trim(),
      cityCountry: String(s.company?.cityCountry || '').trim(),
      phone: String(s.company?.phone || '').trim(),
      email: String(s.company?.email || '').trim(),
      tagline: String(s.company?.tagline || '').trim(),
      defaultCashier: String(s.defaultCashier || '01'),
      defaultOperator: String(s.defaultOperator || '001'),
      defaultFormat: s.defaultFormat || 'POS',
      defaultDocType: s.defaultDocType || 'FR',
      defaultEstId: s.defaultEstablishmentId || '',
      autoPrint: Boolean(s.autoPrintOnEmit),
      hideFooter: Boolean(s.hidePromotionalFooter),
      allowPriceEdit: Boolean(s.allowCashierPriceEdit),
    })
  );
}

export function buildSyncBaselinesFromRecords(params: {
  products: ReadonlyArray<Product>;
  customers: ReadonlyArray<Customer>;
  suppliers: ReadonlyArray<Supplier>;
  settings?: AppSettings | null;
}): SyncBaselineMap {
  const map: SyncBaselineMap = {};
  for (const p of params.products) {
    if (p.synced) {
      map[computeBaselineKey('product', p.id)] = computeProductFingerprint(p);
    }
  }
  for (const c of params.customers) {
    if (c.synced) {
      map[computeBaselineKey('customer', c.id)] = computeCustomerFingerprint(c);
    }
  }
  for (const s of params.suppliers) {
    if (s.synced) {
      map[computeBaselineKey('supplier', s.id)] = computeSupplierFingerprint(s);
    }
  }
  if (params.settings && params.settings.synced !== false) {
    map[computeBaselineKey('settings', 'general')] = computeSettingsFingerprint(params.settings);
  }
  return map;
}

export interface StockReconciliationOutcome {
  mode: 'NO_REMOTE_STOCK_CHANGE' | 'AUTO_RECONCILED' | 'CONFLICT_MANUAL_REQUIRED';
  reconciledStockQty: number;
  localPendingDelta: number;
  reason?: string;
}

/**
 * Reconcilia stock quando dois terminais movimentaram o mesmo artigo offline:
 * soma os deltas líquidos dos movimentos locais pendentes (vendas/compras/devoluções)
 * sobre o stock atual da Cloud para que nenhuma dedução seja perdida.
 */
export function reconcileConcurrentStock(params: {
  localProduct: Product;
  cloudProduct: Product;
  localPendingMovements: ReadonlyArray<StockMovement>;
  cloudMovementsForProduct: ReadonlyArray<StockMovement>;
  localExistingMovementsIds: ReadonlySet<string>;
}): StockReconciliationOutcome {
  const { localProduct, cloudProduct, localPendingMovements, cloudMovementsForProduct, localExistingMovementsIds } = params;

  const newRemoteMovements = cloudMovementsForProduct.filter(
    (m) => !localExistingMovementsIds.has(m.id)
  );
  const localDelta = localPendingMovements.reduce((sum, m) => {
    const q = Math.abs(Number(m.qty) || 0);
    if (m.direction === 'IN') return sum + q;
    if (m.direction === 'OUT') return sum - q;
    return sum;
  }, 0);

  const hasHardLocalCount = localPendingMovements.some(
    (m) => m.type === 'RECONCILIACAO_FISICA' || m.type === 'AJUSTE_INVENTARIO'
  );
  const hasHardRemoteCount = newRemoteMovements.some(
    (m) => m.type === 'RECONCILIACAO_FISICA' || m.type === 'AJUSTE_INVENTARIO'
  );

  const cloudQty = roundKz(Number(cloudProduct.stockQty) || 0);
  const localQty = roundKz(Number(localProduct.stockQty) || 0);

  // Sem movimentos remotos novos e stock remoto já coincide com a base antes do delta local
  const expectedLocalFromCloud = roundKz(cloudQty + localDelta);
  if (newRemoteMovements.length === 0 && expectedLocalFromCloud === localQty) {
    return {
      mode: 'NO_REMOTE_STOCK_CHANGE',
      reconciledStockQty: localQty,
      localPendingDelta: localDelta,
    };
  }

  // Se houve contagem física / ajuste exato concorrente em ambos os lados, exige confirmação humana
  if ((hasHardLocalCount || hasHardRemoteCount) && newRemoteMovements.length > 0 && localQty !== cloudQty) {
    return {
      mode: 'CONFLICT_MANUAL_REQUIRED',
      reconciledStockQty: localQty,
      localPendingDelta: localDelta,
      reason: `Contagem física ou ajuste manual de stock concorrente entre este terminal (${localQty}) e a Cloud (${cloudQty}).`,
    };
  }

  // Movimentos aditivos (vendas POS, devoluções, entradas por compras) reconciliam-se exatamente via delta líquido
  if (localPendingMovements.length > 0 && newRemoteMovements.length > 0) {
    return {
      mode: 'AUTO_RECONCILED',
      reconciledStockQty: expectedLocalFromCloud,
      localPendingDelta: localDelta,
      reason: `Stock de "${localProduct.name}" reconciliado automaticamente (${cloudQty} na Cloud ${localDelta >= 0 ? '+' : ''}${localDelta} local = ${expectedLocalFromCloud}).`,
    };
  }

  return {
    mode: 'NO_REMOTE_STOCK_CHANGE',
    reconciledStockQty: localQty,
    localPendingDelta: localDelta,
  };
}

export interface PrePushAnalysisInput {
  companyId: string;
  localProducts: ReadonlyArray<Product>;
  cloudProducts: ReadonlyArray<Product>;
  localCustomers: ReadonlyArray<Customer>;
  cloudCustomers: ReadonlyArray<Customer>;
  localSuppliers: ReadonlyArray<Supplier>;
  cloudSuppliers: ReadonlyArray<Supplier>;
  localInvoices: ReadonlyArray<InvoiceRecord>;
  cloudInvoices: ReadonlyArray<InvoiceRecord>;
  localCashSessions: ReadonlyArray<CashSession>;
  cloudCashSessions: ReadonlyArray<CashSession>;
  localStockMovements: ReadonlyArray<StockMovement>;
  cloudStockMovements: ReadonlyArray<StockMovement>;
  localSettings: AppSettings;
  cloudSettings: AppSettings | null;
  queueEntries: ReadonlyArray<SyncQueueEntry>;
  baselines: SyncBaselineMap;
  existingConflicts: ReadonlyArray<SyncConflictRecord>;
}

export interface PrePushAnalysisResult {
  blockedEntityKeys: Set<string>;
  reconciledProducts: Product[];
  reconcileNotes: string[];
  conflictsToSave: SyncConflictRecord[];
}

function makeConflictId(type: SyncConflictRecord['type'], entityType: string, entityId: string): string {
  return `conf_${type}_${entityType}_${entityId}`;
}

/**
 * Analisa todas as alterações pendentes locais face à fotografia mais recente da Cloud
 * ANTES de enviar gravações ou aplicar merges, garantindo zero perda de dados e zero sobrescrita cega.
 */
export function analyzePrePushSyncConflicts(input: PrePushAnalysisInput): PrePushAnalysisResult {
  const now = new Date().toISOString();
  const blockedEntityKeys = new Set<string>();
  const reconciledProducts: Product[] = [];
  const reconcileNotes: string[] = [];
  const conflictMap = new Map<string, SyncConflictRecord>();

  for (const existing of input.existingConflicts) {
    conflictMap.set(existing.id, existing);
  }

  const upsertConflict = (
    draft: Omit<SyncConflictRecord, 'id' | 'status' | 'createdAtIso' | 'updatedAtIso'>
  ) => {
    const id = makeConflictId(draft.type, draft.entityType, draft.entityId);
    const prev = conflictMap.get(id);
    if (prev && prev.status === 'resolved' && prev.localSnapshotJson === draft.localSnapshotJson && prev.cloudSnapshotJson === draft.cloudSnapshotJson) {
      return;
    }
    conflictMap.set(id, {
      ...draft,
      id,
      status: 'open',
      createdAtIso: prev?.createdAtIso || now,
      updatedAtIso: now,
    });
    blockedEntityKeys.add(computeBaselineKey(draft.entityType, draft.entityId));
  };

  // 1. Faturas pendentes: colisão de número fiscal + divergência de estado (anulada na Cloud)
  const cloudInvById = new Map(input.cloudInvoices.map((i) => [i.id, i]));
  const cloudInvByFiscalKey = new Map<string, InvoiceRecord>();
  for (const ci of input.cloudInvoices) {
    cloudInvByFiscalKey.set(normalizeFiscalNumberKey(ci.number, ci.seriesEnvironment), ci);
  }

  for (const locInv of input.localInvoices) {
    if (locInv.synced && locInv.syncState !== 'conflict') continue;

    const sameIdCloud = cloudInvById.get(locInv.id);
    if (sameIdCloud) {
      if (sameIdCloud.status === 'cancelled' && locInv.status !== 'cancelled') {
        upsertConflict({
          companyId: input.companyId,
          type: 'INVOICE_STATE_CONFLICT',
          entityType: 'invoice',
          entityId: locInv.id,
          entityLabel: locInv.number,
          summary: `Fatura ${locInv.number} foi anulada noutro terminal na Cloud`,
          details:
            'Este documento sofreu alteração local offline (ex: cobrança de dívida ou notas), mas já consta como ANULADO na Cloud. Documentos anulados são fiscalmente imutáveis.',
          localSummary: `Local: ${locInv.customerName} · Recebido ${roundKz(locInv.amountReceived)} Kz · Estado: emitida`,
          cloudSummary: `Cloud: ANULADA (${sameIdCloud.cancelReason || 'Sem motivo'})`,
          localSnapshotJson: JSON.stringify(locInv),
          cloudSnapshotJson: JSON.stringify(sameIdCloud),
          recommendedAction: 'USE_CLOUD',
        });
      }
      continue;
    }

    const fiscalKey = normalizeFiscalNumberKey(locInv.number, locInv.seriesEnvironment);
    const collidingCloud = cloudInvByFiscalKey.get(fiscalKey);
    if (collidingCloud && collidingCloud.id !== locInv.id) {
      upsertConflict({
        companyId: input.companyId,
        type: 'FISCAL_NUMBER_COLLISION',
        entityType: 'invoice',
        entityId: locInv.id,
        entityLabel: locInv.number,
        summary: `Colisão de numeração fiscal: ${locInv.number} emitido offline em 2 terminais`,
        details:
          'Dois terminais offline emitiram documentos distintos com o mesmo número sequencial. Para manter a conformidade AGT e SAF-T sem perder nenhuma venda, reatribua a cópia local pendente ao próximo número livre da série.',
        localSummary: `Local (${locInv.id}): ${locInv.customerName} · ${roundKz(locInv.grandTotal)} Kz · ${locInv.issuedAtIso.slice(0, 16).replace('T', ' ')}`,
        cloudSummary: `Cloud (${collidingCloud.id}): ${collidingCloud.customerName} · ${roundKz(collidingCloud.grandTotal)} Kz · ${collidingCloud.issuedAtIso.slice(0, 16).replace('T', ' ')}`,
        localSnapshotJson: JSON.stringify(locInv),
        cloudSnapshotJson: JSON.stringify(collidingCloud),
        recommendedAction: 'REASSIGN_LOCAL_SERIES_NUMBER',
      });
    }
  }

  // 2. Turnos de caixa (sessões fechadas na Cloud não podem ser sobrescritas por regra fiscal/auditável)
  const cloudSessById = new Map(input.cloudCashSessions.map((s) => [s.id, s]));
  for (const locSess of input.localCashSessions) {
    if (locSess.synced && locSess.syncState !== 'conflict') continue;
    const cSess = cloudSessById.get(locSess.id);
    if (
      cSess &&
      cSess.status === 'closed' &&
      (locSess.status === 'open' ||
        roundKz(cSess.countedCash || 0) !== roundKz(locSess.countedCash || 0) ||
        cSess.closedAtIso !== locSess.closedAtIso)
    ) {
      upsertConflict({
        companyId: input.companyId,
        type: 'CASH_SESSION_CONFLICT',
        entityType: 'cash_session',
        entityId: locSess.id,
        entityLabel: `Caixa ${locSess.cashier} (${locSess.operator})`,
        summary: `Turno de Caixa ${locSess.cashier} já foi encerrado na Cloud`,
        details:
          'Este turno já consta como fechado na Cloud com contagem final registada. Adote o encerramento da Cloud para evitar bloqueio na sincronização.',
        localSummary: `Local: ${locSess.status === 'closed' ? `Fechado · Contado ${roundKz(locSess.countedCash || 0)} Kz` : 'Ainda aberto'}`,
        cloudSummary: `Cloud: Fechado · Contado ${roundKz(cSess.countedCash || 0)} Kz (${(cSess.closedAtIso || '').slice(0, 16).replace('T', ' ')})`,
        localSnapshotJson: JSON.stringify(locSess),
        cloudSnapshotJson: JSON.stringify(cSess),
        recommendedAction: 'USE_CLOUD',
      });
    }
  }

  // 3. Produtos: reconciliação automática de stock via StockMovements + conflitos reais de catálogo
  const cloudProdById = new Map(input.cloudProducts.map((p) => [p.id, p]));
  const localMovIds = new Set(input.localStockMovements.map((m) => m.id));
  const pendingDeleteProdIds = new Set(
    input.queueEntries
      .filter((q) => q.entityType === 'product' && q.operation === 'delete')
      .map((q) => q.entityId)
  );

  for (const locProd of input.localProducts) {
    if (locProd.synced && locProd.syncState !== 'conflict') continue;
    const cProd = cloudProdById.get(locProd.id);
    if (!cProd) continue;

    const baseFp = input.baselines[computeBaselineKey('product', locProd.id)];
    const cloudFp = computeProductFingerprint(cProd);
    const localFp = computeProductFingerprint(locProd);

    if (cloudFp === localFp) continue;

    const localCatalogFp = computeProductCatalogFingerprint(locProd);
    const cloudCatalogFp = computeProductCatalogFingerprint(cProd);

    // Reconcilia stock se houver movimentos concorrentes
    let effectiveLocalProd = locProd;
    const pendingProdMovs = input.localStockMovements.filter(
      (m) => !m.synced && m.productId === locProd.id
    );
    const cloudProdMovs = input.cloudStockMovements.filter((m) => m.productId === locProd.id);

    const stockOutcome = reconcileConcurrentStock({
      localProduct: locProd,
      cloudProduct: cProd,
      localPendingMovements: pendingProdMovs,
      cloudMovementsForProduct: cloudProdMovs,
      localExistingMovementsIds: localMovIds,
    });

    if (stockOutcome.mode === 'CONFLICT_MANUAL_REQUIRED') {
      upsertConflict({
        companyId: input.companyId,
        type: 'PRODUCT_CONFLICT',
        entityType: 'product',
        entityId: locProd.id,
        entityLabel: `${locProd.code} · ${locProd.name}`,
        summary: `Conflito de stock em "${locProd.name}"`,
        details: stockOutcome.reason || 'Ajuste de inventário concorrente entre terminais.',
        localSummary: `Local: Preço ${roundKz(locProd.price)} Kz · Stock ${roundKz(locProd.stockQty || 0)}`,
        cloudSummary: `Cloud: Preço ${roundKz(cProd.price)} Kz · Stock ${roundKz(cProd.stockQty || 0)}`,
        localSnapshotJson: JSON.stringify(locProd),
        cloudSnapshotJson: JSON.stringify(cProd),
        recommendedAction: 'KEEP_LOCAL',
      });
      continue;
    }

    if (stockOutcome.mode === 'AUTO_RECONCILED' && stockOutcome.reconciledStockQty !== locProd.stockQty) {
      effectiveLocalProd = {
        ...locProd,
        stockQty: stockOutcome.reconciledStockQty,
      };
      reconciledProducts.push(effectiveLocalProd);
      if (stockOutcome.reason) reconcileNotes.push(stockOutcome.reason);
    }

    // Verifica conflito de catálogo (preço/nome/imposto) apenas se a Cloud também mudou desde o baseline conhecido
    const catalogChangedLocallyAndCloud =
      localCatalogFp !== cloudCatalogFp &&
      Boolean(baseFp) &&
      cloudFp !== baseFp &&
      localCatalogFp !== baseFp?.split('|stk:')[0];

    if (catalogChangedLocallyAndCloud) {
      // Se este terminal mudou APENAS o stock (venda offline) enquanto o gerente alterou o preço na Cloud,
      // combina automaticamente os metadados da Cloud + stock reconciliado!
      const baseCatalogFp = baseFp?.split('|stk:')[0];
      if (baseCatalogFp && localCatalogFp === baseCatalogFp) {
        const mergedProd: Product = {
          ...cProd,
          stockQty: effectiveLocalProd.stockQty,
          trackStock: Boolean(cProd.trackStock ?? effectiveLocalProd.trackStock),
          syncState: 'pending',
          synced: false,
          updatedAtIso: now,
        };
        reconciledProducts.push(mergedProd);
        reconcileNotes.push(
          `Catálogo de "${cProd.name}" atualizado da Cloud preservando a dedução de stock local (${mergedProd.stockQty}).`
        );
      } else {
        upsertConflict({
          companyId: input.companyId,
          type: 'PRODUCT_CONFLICT',
          entityType: 'product',
          entityId: locProd.id,
          entityLabel: `${locProd.code} · ${locProd.name}`,
          summary: `Edição concorrente do artigo "${locProd.name}"`,
          details:
            'Este artigo foi editado offline aqui e também alterado noutro terminal na Cloud. Escolha qual versão deve prevalecer.',
          localSummary: `Local: "${locProd.name}" · ${roundKz(locProd.price)} Kz · IVA ${locProd.ivaRate}% · Stock ${roundKz(effectiveLocalProd.stockQty || 0)}`,
          cloudSummary: `Cloud: "${cProd.name}" · ${roundKz(cProd.price)} Kz · IVA ${cProd.ivaRate}% · Stock ${roundKz(cProd.stockQty || 0)}`,
          localSnapshotJson: JSON.stringify(effectiveLocalProd),
          cloudSnapshotJson: JSON.stringify(cProd),
          recommendedAction: 'KEEP_LOCAL',
        });
      }
    }
  }

  for (const delId of pendingDeleteProdIds) {
    const cProd = cloudProdById.get(delId);
    const baseFp = input.baselines[computeBaselineKey('product', delId)];
    if (cProd && baseFp && computeProductFingerprint(cProd) !== baseFp) {
      upsertConflict({
        companyId: input.companyId,
        type: 'PRODUCT_CONFLICT',
        entityType: 'product',
        entityId: delId,
        entityLabel: `${cProd.code} · ${cProd.name}`,
        summary: `Remoção offline vs alteração na Cloud: "${cProd.name}"`,
        details:
          'Este artigo foi marcado para eliminação offline, mas foi atualizado na Cloud entretanto.',
        localSummary: 'Local: Marcado para eliminar',
        cloudSummary: `Cloud: Ativo (${cProd.name} · ${roundKz(cProd.price)} Kz)`,
        localSnapshotJson: JSON.stringify({ id: delId, _deleted: true }),
        cloudSnapshotJson: JSON.stringify(cProd),
        recommendedAction: 'USE_CLOUD',
      });
    }
  }

  // 4. Clientes concorrentes
  const cloudCustById = new Map(input.cloudCustomers.map((c) => [c.id, c]));
  for (const locCust of input.localCustomers) {
    if (locCust.synced && locCust.syncState !== 'conflict') continue;
    const cCust = cloudCustById.get(locCust.id);
    if (!cCust) continue;
    const baseFp = input.baselines[computeBaselineKey('customer', locCust.id)];
    const cloudFp = computeCustomerFingerprint(cCust);
    const localFp = computeCustomerFingerprint(locCust);
    if (cloudFp !== localFp && baseFp && cloudFp !== baseFp) {
      upsertConflict({
        companyId: input.companyId,
        type: 'CUSTOMER_CONFLICT',
        entityType: 'customer',
        entityId: locCust.id,
        entityLabel: locCust.name,
        summary: `Edição concorrente do cliente "${locCust.name}"`,
        details:
          'Os dados do cliente (ou limite de crédito) foram alterados offline neste terminal e também na Cloud.',
        localSummary: `Local: ${locCust.name} · NIF ${locCust.nif} · Limite ${roundKz(locCust.creditLimit || 0)} Kz`,
        cloudSummary: `Cloud: ${cCust.name} · NIF ${cCust.nif} · Limite ${roundKz(cCust.creditLimit || 0)} Kz`,
        localSnapshotJson: JSON.stringify(locCust),
        cloudSnapshotJson: JSON.stringify(cCust),
        recommendedAction: 'KEEP_LOCAL',
      });
    }
  }

  // 5. Fornecedores concorrentes
  const cloudSupById = new Map(input.cloudSuppliers.map((s) => [s.id, s]));
  for (const locSup of input.localSuppliers) {
    if (locSup.synced && locSup.syncState !== 'conflict') continue;
    const cSup = cloudSupById.get(locSup.id);
    if (!cSup) continue;
    const baseFp = input.baselines[computeBaselineKey('supplier', locSup.id)];
    const cloudFp = computeSupplierFingerprint(cSup);
    const localFp = computeSupplierFingerprint(locSup);
    if (cloudFp !== localFp && baseFp && cloudFp !== baseFp) {
      upsertConflict({
        companyId: input.companyId,
        type: 'SUPPLIER_CONFLICT',
        entityType: 'supplier',
        entityId: locSup.id,
        entityLabel: locSup.name,
        summary: `Edição concorrente do fornecedor "${locSup.name}"`,
        details: 'Este fornecedor foi editado simultaneamente offline e na Cloud.',
        localSummary: `Local: ${locSup.name} · NIF ${locSup.nif}`,
        cloudSummary: `Cloud: ${cSup.name} · NIF ${cSup.nif}`,
        localSnapshotJson: JSON.stringify(locSup),
        cloudSnapshotJson: JSON.stringify(cSup),
        recommendedAction: 'KEEP_LOCAL',
      });
    }
  }

  // 6. Configurações concorrentes
  if (input.cloudSettings && input.localSettings.synced === false) {
    const baseFp = input.baselines[computeBaselineKey('settings', 'general')];
    const cloudFp = computeSettingsFingerprint(input.cloudSettings);
    const localFp = computeSettingsFingerprint(input.localSettings);
    if (cloudFp !== localFp && baseFp && cloudFp !== baseFp) {
      upsertConflict({
        companyId: input.companyId,
        type: 'SETTINGS_CONFLICT',
        entityType: 'settings',
        entityId: 'general',
        entityLabel: input.localSettings.company.shortName || 'Configurações',
        summary: 'Alteração concorrente nas Configurações da Empresa',
        details:
          'As definições da empresa foram modificadas offline e também alteradas na Cloud por outro gestor.',
        localSummary: `Local: ${input.localSettings.company.shortName} · Série/Env ${input.localSettings.agtEnvironment || 'SIMULACAO'}`,
        cloudSummary: `Cloud: ${input.cloudSettings.company.shortName} · Série/Env ${input.cloudSettings.agtEnvironment || 'SIMULACAO'}`,
        localSnapshotJson: JSON.stringify(input.localSettings),
        cloudSnapshotJson: JSON.stringify(input.cloudSettings),
        recommendedAction: 'USE_CLOUD',
      });
    }
  }

  return {
    blockedEntityKeys,
    reconciledProducts,
    reconcileNotes,
    conflictsToSave: Array.from(conflictMap.values()),
  };
}

/**
 * Deteta bifurcações na cadeia de hash SAF-T (dois documentos que apontam para o mesmo hash anterior)
 * após sincronização de múltiplos terminais offline.
 */
export function detectHashChainForks(
  companyId: string,
  invoices: ReadonlyArray<InvoiceRecord>
): SyncConflictRecord[] {
  const now = new Date().toISOString();
  const seenByParent = new Map<string, InvoiceRecord>();
  const conflicts: SyncConflictRecord[] = [];

  const sorted = [...invoices]
    .filter((i) => (i.companyId || companyId) === companyId && i.previousInvoiceHash && i.saftHashFull)
    .sort((a, b) => a.issuedAtIso.localeCompare(b.issuedAtIso));

  for (const inv of sorted) {
    const scopeKey = `${normalizeSeriesEnvironment(inv.seriesEnvironment)}::${inv.seriesCode || 'DEFAULT'}::${inv.previousInvoiceHash}`;
    const earlier = seenByParent.get(scopeKey);
    if (earlier && earlier.id !== inv.id) {
      conflicts.push({
        id: makeConflictId('HASH_CHAIN_FORK', 'invoice', inv.id),
        companyId,
        type: 'HASH_CHAIN_FORK',
        entityType: 'invoice',
        entityId: inv.id,
        entityLabel: inv.number,
        summary: `Cadeia SAF-T ramificada detetada entre ${earlier.number} e ${inv.number}`,
        details:
          'Dois terminais offline iniciaram o encadeamento criptográfico SAF-T a partir do mesmo documento anterior. Para evitar este fenómeno entre múltiplos caixas offline, atribua uma série fiscal própria por terminal/caixa.',
        localSummary: `Documento: ${inv.number} (${inv.issuedAtIso.slice(0, 16).replace('T', ' ')})`,
        cloudSummary: `Documento concorrente: ${earlier.number} (${earlier.issuedAtIso.slice(0, 16).replace('T', ' ')})`,
        recommendedAction: 'ACKNOWLEDGE_AUDIT',
        status: 'open',
        createdAtIso: now,
        updatedAtIso: now,
      });
    } else {
      seenByParent.set(scopeKey, inv);
    }
  }

  return conflicts;
}

/**
 * Resolve uma colisão de numeração fiscal offline reatribuindo a fatura local pendente
 * para o próximo número sequencial disponível na série ativa + recalculando hash SAF-T e ATCUD.
 * Nunca modifica faturas já sincronizadas na Cloud.
 */
export function reassignCollidingLocalInvoice(params: {
  companyId: string;
  collidingInvoice: InvoiceRecord;
  allInvoices: ReadonlyArray<InvoiceRecord>;
  existingStockMovements: ReadonlyArray<StockMovement>;
  existingCashMovements: ReadonlyArray<CashMovement>;
}): {
  updatedInvoice: InvoiceRecord;
  updatedStockMovements: StockMovement[];
  updatedCashMovements: CashMovement[];
  previousNumber: string;
  newNumber: string;
} {
  const { companyId, collidingInvoice, allInvoices } = params;
  const docType = collidingInvoice.docType as AgtDocumentType;
  const env = normalizeSeriesEnvironment(collidingInvoice.seriesEnvironment);
  const parsedOld = parseFiscalDocumentNo(collidingInvoice.number);
  const targetSeriesCode = collidingInvoice.seriesCode || parsedOld.seriesCode;

  // Garante que o contador da série local nunca fica atrás de qualquer documento já existente
  const minSeqFloor = targetSeriesCode
    ? getHighestSequenceForSeriesInInvoices(allInvoices, {
        companyId,
        docType,
        seriesCode: targetSeriesCode,
        environment: env,
      })
    : 0;

  let newNumber = collidingInvoice.number;
  let seriesCode = targetSeriesCode;
  let agtAuthorizationCode = collidingInvoice.agtAuthorizationCode;
  let atcud = collidingInvoice.atcud;

  try {
    const reserved = reservarProximoNumeroFiscal(
      companyId,
      docType,
      undefined,
      targetSeriesCode,
      {
        environment: env,
        establishmentId: collidingInvoice.establishmentId,
        minLastDocumentNumber: minSeqFloor,
      }
    );
    newNumber = reserved.documentNo;
    seriesCode = reserved.seriesCode;
    agtAuthorizationCode = reserved.agtAuthorizationCode || agtAuthorizationCode;
    atcud =
      reserved.environment === 'PRODUCAO' && agtAuthorizationCode
        ? `${agtAuthorizationCode.trim()}-${reserved.sequenceNumber}`
        : undefined;
    sincronizarSequenciaMaximaSerie(companyId, reserved.seriesId, reserved.sequenceNumber);
  } catch {
    const nextFallbackSeq = Math.max(1, minSeqFloor + 1);
    const code = targetSeriesCode || `A${new Date().getFullYear()}`;
    newNumber = formatFiscalDocumentNo(docType, code, nextFallbackSeq);
  }

  // Encontra o último documento emitido nessa série/ambiente (excluindo o próprio em reatribuição)
  const sameSeriesDocs = allInvoices
    .filter(
      (i) =>
        i.id !== collidingInvoice.id &&
        (i.companyId || companyId) === companyId &&
        (!seriesCode || i.seriesCode === seriesCode) &&
        normalizeSeriesEnvironment(i.seriesEnvironment) === env
    )
    .sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso));

  const latestPrev = sameSeriesDocs[0];
  const prevHash = latestPrev
    ? latestPrev.saftHashFull ||
      generateChainedDocumentHash(latestPrev, latestPrev.previousInvoiceHash || '')
    : '';

  const hashRes = computeDocumentSaftHash4(
    {
      issuedAtIso: collidingInvoice.issuedAtIso,
      number: newNumber,
      grandTotal: collidingInvoice.grandTotal,
    },
    prevHash
  );

  const now = new Date().toISOString();
  const auditNote = `[Reatribuído de ${collidingInvoice.number} após conflito offline]`;
  const nextNotes = collidingInvoice.notes?.includes(auditNote)
    ? collidingInvoice.notes
    : `${collidingInvoice.notes ? `${collidingInvoice.notes} · ` : ''}${auditNote}`.slice(0, 300);

  const updatedInvoice: InvoiceRecord = {
    ...collidingInvoice,
    number: newNumber,
    seriesCode,
    seriesEnvironment: env,
    ...(agtAuthorizationCode ? { agtAuthorizationCode } : {}),
    ...(atcud ? { atcud } : { atcud: undefined }),
    previousInvoiceHash: prevHash || undefined,
    saftHash4: hashRes.hash4,
    saftHashFull: hashRes.fullHash,
    notes: nextNotes,
    syncState: 'pending',
    synced: false,
    syncError: undefined,
    updatedAtIso: now,
  };

  const updatedStockMovements = params.existingStockMovements
    .filter((m) => m.invoiceId === collidingInvoice.id)
    .map((m) => ({
      ...m,
      invoiceNumber: newNumber,
      reference: newNumber,
      reason: m.reason.includes(collidingInvoice.number)
        ? m.reason.replace(collidingInvoice.number, newNumber).slice(0, 240)
        : m.reason,
    }));

  const updatedCashMovements = params.existingCashMovements
    .filter((m) => m.invoiceId === collidingInvoice.id)
    .map((m) => ({
      ...m,
      invoiceNumber: newNumber,
    }));

  return {
    updatedInvoice,
    updatedStockMovements,
    updatedCashMovements,
    previousNumber: collidingInvoice.number,
    newNumber,
  };
}
