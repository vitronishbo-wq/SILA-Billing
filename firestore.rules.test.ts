/**
 * Firestore Security Rules Test Suite — Multi-Company, 1 NIF = 1 Empresa & RBAC Verification
 * Verifies that all 12 adversarial payloads in security_spec.md are rejected with PERMISSION_DENIED.
 */

export interface SecurityTestCase {
  id: number;
  name: string;
  auth: { uid: string; email?: string; email_verified: boolean } | null;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expectedResult: 'PERMISSION_DENIED' | 'ALLOWED';
}

export const DIRTY_DOZEN_TESTS: SecurityTestCase[] = [
  {
    id: 1,
    name: 'Unverified Email Spoof on Admin Email',
    auth: { uid: 'spoof_uid', email: 'wtmedia0@gmail.com', email_verified: false },
    operation: 'update',
    path: '/companies/comp_jaimona',
    payload: { status: 'suspended' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-Company Data Read',
    auth: { uid: 'owner_alpha', email: 'alpha@empresa.ao', email_verified: true },
    operation: 'list',
    path: '/companies/comp_jaimona/invoices',
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Duplicate NIF Registration (1 NIF = 1 Empresa Violation)',
    auth: { uid: 'user_2', email: 'user2@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/company_nifs/5003069940',
    payload: { normalizedNif: '5003069940', companyId: 'comp_clone', ownerUid: 'user_2', shortName: 'Clone' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cashier Editing Product Price',
    auth: { uid: 'cashier_1', email: 'caixa@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/companies/comp_1/products/prod_1',
    payload: { price: 10 },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Cashier Cancelling Invoice',
    auth: { uid: 'cashier_1', email: 'caixa@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/companies/comp_1/invoices/inv_1',
    payload: { status: 'cancelled', cancelReason: 'Tentativa caixa' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Invoice Cancellation Without Justification',
    auth: { uid: 'owner_1', email: 'dono@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/companies/comp_1/invoices/inv_1',
    payload: { status: 'cancelled', cancelReason: '' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Self-Assigned Commercial Plan Upgrade',
    auth: { uid: 'owner_1', email: 'dono@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/companies/comp_1',
    payload: { planTier: 'ENTERPRISE', commercialActive: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Emission on Suspended Company',
    auth: { uid: 'owner_suspended', email: 'susp@empresa.ao', email_verified: true },
    operation: 'create',
    path: '/companies/comp_suspended/invoices/inv_9',
    payload: { id: 'inv_9', companyId: 'comp_suspended', status: 'issued' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Shadow/Ghost Field Injection',
    auth: { uid: 'owner_1', email: 'dono@empresa.ao', email_verified: true },
    operation: 'create',
    path: '/companies/comp_1/customers/cust_1',
    payload: { id: 'cust_1', companyId: 'comp_1', isPlatformAdmin: true },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'ID Poisoning & Oversized Payload',
    auth: { uid: 'owner_1', email: 'dono@empresa.ao', email_verified: true },
    operation: 'create',
    path: '/companies/bad$id!@#/products/p1',
    payload: { notes: 'x'.repeat(5000) },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Terminal State Bypass',
    auth: { uid: 'owner_1', email: 'dono@empresa.ao', email_verified: true },
    operation: 'update',
    path: '/companies/comp_1/invoices/inv_cancelled',
    payload: { status: 'issued' },
    expectedResult: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'PII Leak Across Companies',
    auth: { uid: 'owner_2', email: 'outro@empresa.ao', email_verified: true },
    operation: 'get',
    path: '/companies/comp_1/customers/cust_1/private/contact',
    expectedResult: 'PERMISSION_DENIED',
  },
];
