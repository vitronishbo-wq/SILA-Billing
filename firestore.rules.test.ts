/**
 * Firestore Security Rules Test Suite — Dirty Dozen Verification
 * Verifies that all 12 adversarial payloads in security_spec.md are rejected with PERMISSION_DENIED.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  auth: { uid: string; email_verified: boolean } | null;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED' | 'ALLOWED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Unverified Email Spoof',
    auth: { uid: 'user_1', email_verified: false },
    operation: 'create',
    path: '/users/user_1/products/prod_1',
    payload: { id: 'prod_1', ownerId: 'user_1', code: '001', name: 'Água', unit: 'un', price: 700, ivaRate: 14, exemptionReason: '', active: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-Tenant Read/List',
    auth: { uid: 'user_2', email_verified: true },
    operation: 'list',
    path: '/users/user_1/invoices',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Owner Spoofing on Create',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/products/prod_1',
    payload: { id: 'prod_1', ownerId: 'user_2', code: '001', name: 'Água', unit: 'un', price: 700, ivaRate: 14, exemptionReason: '', active: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Shadow/Ghost Field Injection',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/customers/cust_1',
    payload: { id: 'cust_1', ownerId: 'user_1', name: 'Cliente', nif: '5000000000', locality: 'Saurimo', isAdmin: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'ID Poisoning',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/products/bad$id!@#',
    payload: { id: 'bad$id!@#', ownerId: 'user_1', code: '001', name: 'Água', unit: 'un', price: 700, ivaRate: 14, exemptionReason: '', active: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Denial-of-Wallet Oversized String',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/invoices/inv_1',
    payload: { notes: 'x'.repeat(5000) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Client Timestamp Forgery',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/products/prod_1',
    payload: { createdAt: '1999-01-01T00:00:00Z' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Immortal Field Mutation',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'update',
    path: '/users/user_1/products/prod_1',
    payload: { ownerId: 'user_999' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Invoice Financial Tampering',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'update',
    path: '/users/user_1/invoices/inv_1',
    payload: { grandTotal: 10 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Terminal State Bypass',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'update',
    path: '/users/user_1/invoices/inv_cancelled',
    payload: { status: 'issued' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Orphaned Line Item Write',
    auth: { uid: 'user_1', email_verified: true },
    operation: 'create',
    path: '/users/user_1/invoices/missing_invoice/items/item_1',
    payload: { id: 'item_1', invoiceId: 'missing_invoice', ownerId: 'user_1' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'PII Leak on Split Subcollection',
    auth: { uid: 'user_2', email_verified: true },
    operation: 'get',
    path: '/users/user_1/customers/cust_1/private/contact',
    expectedResult: 'PERMISSION_DENIED',
  },
];
