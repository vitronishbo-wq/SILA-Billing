import { createSeedInvoice, INITIAL_CUSTOMERS, INITIAL_PRODUCTS } from '../core/seedData';
import {
  AppSettings,
  CartDraftItem,
  Customer,
  DEFAULT_SETTINGS,
  DocumentFormat,
  DocumentType,
  InvoiceRecord,
  PaymentMethod,
  Product,
} from '../core/types';

export interface PosWorkspaceDraft {
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

const DB_NAME = 'sila_billing_idb_v1';
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('products')) {
        db.createObjectStore('products', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('customers')) {
        db.createObjectStore('customers', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('invoices')) {
        db.createObjectStore('invoices', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
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

export async function bootstrapLocalStore(): Promise<{
  products: Product[];
  customers: Customer[];
  invoices: InvoiceRecord[];
  settings: AppSettings;
  posDraft: PosWorkspaceDraft | null;
}> {
  const seededMeta = await getFromStore<{ key: string; value: boolean }>('meta', 'seeded');

  if (!seededMeta?.value) {
    for (const p of INITIAL_PRODUCTS) {
      await putInStore('products', p);
    }
    for (const c of INITIAL_CUSTOMERS) {
      await putInStore('customers', c);
    }
    await putInStore('invoices', createSeedInvoice());
    await putInStore('meta', { key: 'app_settings', value: DEFAULT_SETTINGS });
    await putInStore('meta', { key: 'seeded', value: true });
  }

  const [rawProducts, customers, invoices, settingsMeta, draftMeta] = await Promise.all([
    getAllFromStore<Product>('products'),
    getAllFromStore<Customer>('customers'),
    getAllFromStore<InvoiceRecord>('invoices'),
    getFromStore<{ key: string; value: AppSettings }>('meta', 'app_settings'),
    getFromStore<{ key: string; value: PosWorkspaceDraft }>('meta', 'pos_draft'),
  ]);

  const products: Product[] = [];
  for (const p of rawProducts) {
    if (p.category && p.category.trim()) {
      products.push(p);
    } else {
      const seedMatch = INITIAL_PRODUCTS.find((sp) => sp.id === p.id || sp.code === p.code);
      const lower = p.name.toLowerCase();
      const inferred =
        seedMatch?.category ||
        (/água|agua|sumo|refrigerante|bebida|cerveja|vinho/.test(lower)
          ? 'Bebidas'
          : /pão|pao|bolo|pastel|padaria/.test(lower)
            ? 'Padaria'
            : /café|cafe|chá|cha/.test(lower)
              ? 'Cafetaria'
              : /serviço|servico|entrega|transporte|taxa/.test(lower)
                ? 'Serviços'
                : 'Mercearia');
      const upgraded: Product = { ...p, category: inferred };
      await putInStore('products', upgraded);
      products.push(upgraded);
    }
  }

  products.sort((a, b) => a.code.localeCompare(b.code));
  customers.sort((a, b) =>
    a.id === 'cust_direct' ? -1 : b.id === 'cust_direct' ? 1 : a.name.localeCompare(b.name)
  );
  invoices.sort((a, b) => b.issuedAtIso.localeCompare(a.issuedAtIso));

  return {
    products,
    customers,
    invoices,
    settings: settingsMeta?.value || DEFAULT_SETTINGS,
    posDraft: draftMeta?.value || null,
  };
}

export const localDb = {
  saveProduct: (p: Product) => putInStore('products', p),
  deleteProduct: (id: string) => deleteFromStore('products', id),
  saveCustomer: (c: Customer) => putInStore('customers', c),
  deleteCustomer: (id: string) => deleteFromStore('customers', id),
  saveInvoice: (inv: InvoiceRecord) => putInStore('invoices', inv),
  saveSettings: (settings: AppSettings) =>
    putInStore('meta', { key: 'app_settings', value: settings }),
  savePosDraft: (draft: PosWorkspaceDraft) =>
    putInStore('meta', { key: 'pos_draft', value: draft }),
};
