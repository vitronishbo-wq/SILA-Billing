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
import { AppSettings, CalculatedLineItem, Customer, DEFAULT_SETTINGS, InvoiceRecord, Product } from '../core/types';
import { auth, db, handleFirestoreError, OperationType } from './firebaseClient';

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || 'item_default';
}

export async function upsertProductCloud(product: Product, isNew: boolean): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const productId = sanitizeId(product.id);
  const path = `users/${user.uid}/products/${productId}`;
  const ref = doc(db, 'users', user.uid, 'products', productId);

  try {
    const snap = await getDoc(ref);
    if (!snap.exists() || isNew) {
      await setDoc(ref, {
        id: productId,
        ownerId: user.uid,
        code: product.code.slice(0, 32),
        name: product.name.slice(0, 160),
        unit: (product.unit || 'un').slice(0, 16),
        price: Number(product.price) || 0,
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      await updateDoc(ref, {
        code: product.code.slice(0, 32),
        name: product.name.slice(0, 160),
        unit: (product.unit || 'un').slice(0, 16),
        price: Number(product.price) || 0,
        ivaRate: product.ivaRate === 14 ? 14 : 0,
        exemptionReason: (product.exemptionReason || '').slice(0, 120),
        active: Boolean(product.active),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, isNew ? OperationType.CREATE : OperationType.UPDATE, path);
  }
}

export async function removeProductCloud(productIdRaw: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const productId = sanitizeId(productIdRaw);
  const path = `users/${user.uid}/products/${productId}`;
  try {
    await deleteDoc(doc(db, 'users', user.uid, 'products', productId));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

export async function upsertCustomerCloud(customer: Customer): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const customerId = sanitizeId(customer.id);
  const custPath = `users/${user.uid}/customers/${customerId}`;
  const custRef = doc(db, 'users', user.uid, 'customers', customerId);
  const privRef = doc(db, 'users', user.uid, 'customers', customerId, 'private', 'contact');

  try {
    const snap = await getDoc(custRef);
    const batch = writeBatch(db);
    if (!snap.exists()) {
      batch.set(custRef, {
        id: customerId,
        ownerId: user.uid,
        name: customer.name.slice(0, 160),
        nif: (customer.nif || '').slice(0, 32),
        locality: (customer.locality || '').slice(0, 160),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      batch.set(privRef, {
        ownerId: user.uid,
        phone: (customer.phone || '').slice(0, 40),
        address: (customer.address || '').slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(custRef, {
        name: customer.name.slice(0, 160),
        nif: (customer.nif || '').slice(0, 32),
        locality: (customer.locality || '').slice(0, 160),
        updatedAt: serverTimestamp(),
      });
      batch.update(privRef, {
        phone: (customer.phone || '').slice(0, 40),
        address: (customer.address || '').slice(0, 200),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, custPath);
  }
}

export async function removeCustomerCloud(customerIdRaw: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const customerId = sanitizeId(customerIdRaw);
  const custPath = `users/${user.uid}/customers/${customerId}`;
  try {
    const batch = writeBatch(db);
    batch.delete(doc(db, 'users', user.uid, 'customers', customerId, 'private', 'contact'));
    batch.delete(doc(db, 'users', user.uid, 'customers', customerId));
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, custPath);
  }
}

export async function createInvoiceCloud(invoice: InvoiceRecord): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const invoiceId = sanitizeId(invoice.id);
  const invPath = `users/${user.uid}/invoices/${invoiceId}`;
  const invRef = doc(db, 'users', user.uid, 'invoices', invoiceId);

  try {
    const existingSnap = await getDoc(invRef);
    if (existingSnap.exists()) {
      if (invoice.status === 'cancelled' && existingSnap.data()?.status !== 'cancelled') {
        await updateDoc(invRef, {
          status: 'cancelled',
          updatedAt: serverTimestamp(),
        });
      }
      return;
    }

    const batch = writeBatch(db);
    batch.set(invRef, {
      id: invoiceId,
      ownerId: user.uid,
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
      const itemRef = doc(db, 'users', user.uid, 'invoices', invoiceId, 'items', itemId);
      batch.set(itemRef, {
        id: itemId,
        invoiceId,
        ownerId: user.uid,
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

export async function cancelInvoiceCloud(invoiceIdRaw: string): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;
  const invoiceId = sanitizeId(invoiceIdRaw);
  const invPath = `users/${user.uid}/invoices/${invoiceId}`;
  try {
    const invRef = doc(db, 'users', user.uid, 'invoices', invoiceId);
    const snap = await getDoc(invRef);
    if (snap.exists() && snap.data()?.status !== 'cancelled') {
      await updateDoc(invRef, {
        status: 'cancelled',
        updatedAt: serverTimestamp(),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, invPath);
  }
}

export async function upsertSettingsCloud(settings: AppSettings): Promise<void> {
  const user = auth.currentUser;
  if (!user || !user.emailVerified) return;

  const settingsPath = `users/${user.uid}/settings/general`;
  const ref = doc(db, 'users', user.uid, 'settings', 'general');

  const payload = {
    ownerId: user.uid,
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
        legalName: payload.legalName,
        shortName: payload.shortName,
        nif: payload.nif,
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

export async function pullAllFromCloud(): Promise<{
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

  try {
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
        code: data.code,
        name: data.name,
        unit: data.unit,
        price: data.price,
        ivaRate: data.ivaRate === 14 ? 14 : 0,
        exemptionReason: data.exemptionReason || '',
        active: Boolean(data.active),
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
          // Ignore missing private doc
        }
        return {
          id: data.id,
          name: data.name,
          nif: data.nif || '',
          locality: data.locality || '',
          phone,
          address,
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
            lineDiscount: Math.max(0, it.lineGross - it.lineBase),
            lineNet: it.lineNet,
            lineBase: it.lineBase,
            lineTax: it.lineTax,
            lineTotal: it.lineTotal,
          };
        });

        return {
          id: data.id,
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
        synced: true,
        updatedAtIso: new Date().toISOString(),
      };
    }

    return { products, customers, invoices, settings };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, invPath);
  }
}
