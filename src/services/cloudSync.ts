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
  CompanyMember,
  CompanyRecord,
  Customer,
  DEFAULT_SETTINGS,
  InvoiceRecord,
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  JAIMONA_OWNER_EMAIL,
  normalizeCompanyNif,
  Product,
  validateCompanyNif,
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
        planTier: 'FREE',
        commercialActive: false,
        baseSequence: Math.max(0, Number(company.baseSequence) || 0),
        allowManagerCancel: Boolean(company.allowManagerCancel),
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

export async function upsertProductCloud(
  product: Product,
  isNew: boolean,
  company?: CompanyRecord
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

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
    if (!snap.exists()) {
      await setDoc(compProdRef, {
        id: productId,
        companyId,
        companyOwnerUid: ownerUid,
        updatedByUid: user.uid,
        code: product.code.slice(0, 32),
        name: product.name.slice(0, 160),
        category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
        unit: (product.unit || 'un').slice(0, 16),
        price: Number(product.price) || 0,
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(compProdRef, {
        updatedByUid: user.uid,
        code: product.code.slice(0, 32),
        name: product.name.slice(0, 160),
        category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
        unit: (product.unit || 'un').slice(0, 16),
        price: Number(product.price) || 0,
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
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
          name: product.name.slice(0, 160),
          category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
          unit: (product.unit || 'un').slice(0, 16),
          price: Number(product.price) || 0,
          ivaRate: product.ivaRate === 14 ? 14 : 0,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        await updateDoc(legacyRef, {
          code: product.code.slice(0, 32),
          name: product.name.slice(0, 160),
          category: (product.category || 'Geral').trim().slice(0, 48) || 'Geral',
          unit: (product.unit || 'un').slice(0, 16),
          price: Number(product.price) || 0,
          ivaRate: product.ivaRate === 14 ? 14 : 0,
          exemptionReason: (product.exemptionReason || '').slice(0, 120),
          active: Boolean(product.active),
          updatedAt: serverTimestamp(),
        });
      }
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, compProdPath);
  }
}

export async function removeProductCloud(
  productIdRaw: string,
  companyIdRaw: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
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
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(custRef, {
        updatedByUid: user.uid,
        name: customer.name.slice(0, 160),
        nif: (customer.nif || '').slice(0, 32),
        locality: (customer.locality || '').slice(0, 160),
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
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        legBatch.update(legCustRef, {
          name: customer.name.slice(0, 160),
          nif: (customer.nif || '').slice(0, 32),
          locality: (customer.locality || '').slice(0, 160),
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
  companyIdRaw: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
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
      if (invoice.status === 'cancelled' && existingSnap.data()?.status !== 'cancelled') {
        await updateDoc(invRef, {
          status: 'cancelled',
          cancelReason: (invoice.cancelReason || 'Anulação operacional').slice(0, 240),
          cancelledBy: (invoice.cancelledBy || user.email || user.uid).slice(0, 120),
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

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
      taxBase14: invoice.taxBase14,
      taxAmount14: invoice.taxAmount14,
      taxBase0: invoice.taxBase0,
      taxAmount0: 0,
      taxTotal: invoice.taxTotal,
      grandTotal: invoice.grandTotal,
      amountInWords: invoice.amountInWords.slice(0, 300),
      amountReceived: invoice.amountReceived,
      changeAmount: invoice.changeAmount,
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
  companyIdRaw: string
): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return;
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
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, settingsPath);
  }
}

export async function pullCompanyFromCloud(companyIdRaw: string): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  settings: AppSettings | null;
} | null> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified || !companyIdRaw) return null;

  const companyId = sanitizeId(companyIdRaw);
  const prodPath = `companies/${companyId}/products`;
  const custPath = `companies/${companyId}/customers`;
  const invPath = `companies/${companyId}/invoices`;
  const settingsRef = doc(db, 'companies', companyId, 'settings', 'general');

  try {
    const [prodSnap, custSnap, invSnap, settingsSnap] = await Promise.all([
      getDocs(query(collection(db, prodPath), where('companyOwnerUid', '==', user.uid))),
      getDocs(query(collection(db, custPath), where('companyOwnerUid', '==', user.uid))),
      getDocs(query(collection(db, invPath), where('companyOwnerUid', '==', user.uid))),
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
      return {
        id: data.id,
        companyId,
        code: data.code,
        name: data.name,
        category: data.category || 'Geral',
        unit: data.unit,
        price: data.price,
        ivaRate: data.ivaRate === 14 ? 14 : 0,
        exemptionReason: data.exemptionReason || '',
        active: Boolean(data.active),
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
          query(collection(db, itemsPath), where('companyOwnerUid', '==', user.uid))
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
        syncState: 'synced',
        synced: true,
        updatedAtIso: new Date().toISOString(),
      };
    }

    return { products, customers, invoices, settings };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, invPath);
  }
}

async function pullLegacyJaimonaFromCloud(): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
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
    return {
      id: data.id,
      companyId: JAIMONA_COMPANY_ID,
      code: data.code,
      name: data.name,
      category: data.category || 'Geral',
      unit: data.unit,
      price: data.price,
      ivaRate: data.ivaRate === 14 ? 14 : 0,
      exemptionReason: data.exemptionReason || '',
      active: Boolean(data.active),
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

  return { products, customers, invoices, settings };
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
            planTier: cd.planTier || 'FREE',
            commercialActive: Boolean(cd.commercialActive ?? false),
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

