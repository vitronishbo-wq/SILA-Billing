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
  AppSettings,
  CalculatedLineItem,
  canCompanySyncCloudData,
  CashMovement,
  CashMovementType,
  CashSession,
  CompanyMember,
  CompanyRecord,
  Customer,
  DEFAULT_SETTINGS,
  DirectPaymentMethod,
  InvoiceRecord,
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  PaymentSplit,
  Product,
  ProductPriceChange,
  validateCompanyNif,
  VITRONIS_INSTITUTIONAL,
} from '../core/types';
import { auth, db, handleFirestoreError, OperationType } from './firebaseClient';

function sanitizeId(raw: string): string {
  return String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'item_default';
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
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
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
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
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
          ivaRate: product.ivaRate === 14 ? 14 : 0,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
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
          ivaRate: product.ivaRate === 14 ? 14 : 0,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
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
          updatedAt: serverTimestamp(),
        });
      } else if (
        invoice.status === 'issued' &&
        exData?.status === 'issued' &&
        (Number(exData?.amountDue) || 0) !== (Number(invoice.amountDue) || 0)
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

    const batch = writeBatch(db);
    batch.set(invRef, {
      id: invoiceId,
      companyId,
      companyOwnerUid: ownerUid,
      emittedByUid: user.uid,
      number: invoice.number.slice(0, 40),
      docType: invoice.docType,
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
      taxBase0: invoice.taxBase0,
      taxAmount0: 0,
      taxTotal: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
      amountInWords: invoice.amountInWords.slice(0, 300),
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
        ivaRate: line.ivaRate,
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
    defaultDocType: settings.defaultDocType === 'FP' ? 'FP' : 'FR',
    defaultNotes: (settings.defaultNotes || '').slice(0, 300),
    autoPrintOnEmit: Boolean(settings.autoPrintOnEmit),
    hidePromotionalFooter: Boolean(settings.hidePromotionalFooter ?? true),
    allowCashierPriceEdit: Boolean(settings.allowCashierPriceEdit ?? false),
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
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, settingsPath);
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

    await setDoc(movRef, {
      id: movementId,
      companyId,
      companyOwnerUid: ownerUid,
      createdByUid: user.uid,
      sessionId: sanitizeId(movement.sessionId || 'unassigned'),
      cashier: (movement.cashier || '01').slice(0, 16),
      operator: (movement.operator || '001').slice(0, 32),
      type: movement.type,
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
      createdAtIso: (movement.createdAtIso || new Date().toISOString()).slice(0, 40),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, movPath);
  }
}

export async function pullCompanyFromCloud(companyIdRaw: string): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  cashSessions: CashSession[];
  cashMovements: CashMovement[];
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
  const settingsRef = doc(db, 'companies', companyId, 'settings', 'general');

  try {
    const [prodSnap, custSnap, invSnap, sessSnap, movSnap, settingsSnap] = await Promise.all([
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
      return {
        id: data.id,
        companyId,
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
          companyId,
          number: data.number,
          docType: data.docType === 'FP' ? 'FP' : 'FR',
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
          taxBase0: data.taxBase0,
          taxAmount0: 0,
          taxTotal: data.taxTotal,
          grandTotal: data.grandTotal,
          amountInWords: data.amountInWords,
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
          lines,
          syncState: 'synced',
          synced: true,
          createdAtIso: data.issuedAtIso,
          updatedAtIso: data.issuedAtIso,
        };
      })
    );

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
      return {
        id: String(data.id || d.id),
        companyId,
        sessionId: String(data.sessionId || 'unassigned'),
        cashier: String(data.cashier || '01'),
        operator: String(data.operator || '001'),
        type: validType,
        amount: Number(data.amount) || 0,
        paymentMethod: pm,
        reason: String(data.reason || ''),
        reference: data.reference ? String(data.reference) : undefined,
        invoiceId: data.invoiceId ? String(data.invoiceId) : undefined,
        invoiceNumber: data.invoiceNumber ? String(data.invoiceNumber) : undefined,
        customerName: data.customerName ? String(data.customerName) : undefined,
        createdByUid: data.createdByUid ? String(data.createdByUid) : undefined,
        syncState: 'synced',
        synced: true,
        createdAtIso: String(data.createdAtIso || new Date().toISOString()),
      };
    });

    let settings: AppSettings | null = null;
    if (settingsSnap && settingsSnap.exists()) {
      const sd = settingsSnap.data();
      settings = {
        companyId,
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
        hidePromotionalFooter:
          typeof sd.hidePromotionalFooter === 'boolean' ? sd.hidePromotionalFooter : true,
        allowCashierPriceEdit: Boolean(sd.allowCashierPriceEdit ?? false),
        syncState: 'synced',
        synced: true,
        updatedAtIso: new Date().toISOString(),
      };
    }

    return { products, customers, invoices, cashSessions, cashMovements, settings };
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
        docType: data.docType === 'FP' ? 'FP' : 'FR',
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

  return { products, customers, invoices, cashSessions: [], cashMovements: [], settings };
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
          profile: {
            legalName: String(cd.legalName || cd.shortName || compId),
            shortName: String(cd.shortName || cd.legalName || compId),
            nif: String(cd.nif || ''),
            address: String(cd.address || 'Angola'),
            cityCountry: String(cd.cityCountry || 'Angola'),
            phone: String(cd.phone || ''),
            email: String(cd.email || ''),
            tagline: String(cd.tagline || ''),
          },
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
          profile: {
            legalName: String(cd.legalName || cd.shortName || JAIMONA_COMPANY_ID),
            shortName: String(cd.shortName || cd.legalName || JAIMONA_COMPANY_ID),
            nif: String(cd.nif || ''),
            address: String(cd.address || 'Angola'),
            cityCountry: String(cd.cityCountry || 'Angola'),
            phone: String(cd.phone || ''),
            email: String(cd.email || ''),
            tagline: String(cd.tagline || ''),
          },
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
  } catch {
    return [];
  }
}

export async function pullAllFromCloud(companyId = '') {
  if (!companyId) return null;
  return pullCompanyFromCloud(companyId);
}

