export type TaxRate = 0 | 14;
export type PaymentMethod = 'Dinheiro' | 'Multicaixa' | 'Transferência';
export type DocumentType = 'FR' | 'FP';
export type DocumentFormat = 'POS' | 'A4';
export type InvoiceStatus = 'issued' | 'cancelled';

export interface CompanyProfile {
  legalName: string;
  shortName: string;
  nif: string;
  address: string;
  cityCountry: string;
  phone: string;
  email: string;
  tagline: string;
}

export const JAIMONA_COMPANY: CompanyProfile = {
  legalName: 'JAIMONA-COMÉRCIO E SERVIÇOS, (SU) LDA',
  shortName: 'JAIMONA',
  nif: '5003069940',
  address: 'Rua Fapla, Bairro Verde A – Saurimo',
  cityCountry: 'Saurimo - Angola',
  phone: '(+244) 943671515',
  email: 'jaimonacomercioeservicos@gmail.com',
  tagline: 'Servimos com Qualidade',
};

export interface AppSettings {
  company: CompanyProfile;
  defaultCashier: string;
  defaultOperator: string;
  defaultFormat: DocumentFormat;
  defaultDocType: DocumentType;
  defaultNotes: string;
  autoPrintOnEmit: boolean;
  synced?: boolean;
  updatedAtIso: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  company: JAIMONA_COMPANY,
  defaultCashier: '01',
  defaultOperator: '001',
  defaultFormat: 'POS',
  defaultDocType: 'FR',
  defaultNotes: 'Venda directa a retalho.',
  autoPrintOnEmit: false,
  synced: false,
  updatedAtIso: new Date().toISOString(),
};

export interface Product {
  id: string;
  code: string;
  name: string;
  unit: string;
  price: number; // PVP Unitário (IVA incluído quando ivaRate === 14)
  ivaRate: TaxRate;
  exemptionReason: string;
  active: boolean;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface Customer {
  id: string;
  name: string;
  nif: string;
  locality: string;
  phone: string;
  address: string;
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface CartDraftItem {
  productId: string;
  code: string;
  description: string;
  unit: string;
  qty: number;
  unitPrice: number;
  discountPct: number;
  ivaRate: TaxRate;
}

export interface CalculatedLineItem extends CartDraftItem {
  id: string;
  lineGross: number;   // qty * unitPrice
  lineDiscount: number;
  lineNet: number;     // lineGross - lineDiscount (Total c/ IVA)
  lineBase: number;    // Base tributável s/ IVA
  lineTax: number;     // Valor do IVA
  lineTotal: number;   // Valor final da linha
}

export interface InvoiceTotals {
  lines: CalculatedLineItem[];
  merchandiseTotal: number; // Soma das bases s/ IVA + isentos (ex: 4695.65 + 2449.35 / ou soma bruta mercadorias)
  grossItemsTotal: number;  // Soma bruta das linhas antes de imposto separado
  discountTotal: number;
  taxBase14: number;
  taxAmount14: number;
  taxBase0: number;
  taxAmount0: number;
  taxTotal: number;
  grandTotal: number;
  amountInWords: string;
}

export interface InvoiceRecord {
  id: string;
  number: string;
  docType: DocumentType;
  issuedAtIso: string;
  cashier: string;
  operator: string;
  paymentMethod: PaymentMethod;
  customerId: string;
  customerName: string;
  customerNif: string;
  customerLocality: string;
  merchandiseTotal: number;
  discountTotal: number;
  taxBase14: number;
  taxAmount14: number;
  taxBase0: number;
  taxAmount0: number;
  taxTotal: number;
  grandTotal: number;
  amountInWords: string;
  amountReceived: number;
  changeAmount: number;
  notes: string;
  status: InvoiceStatus;
  lines: CalculatedLineItem[];
  synced?: boolean;
  createdAtIso: string;
  updatedAtIso: string;
}
