# SILA-Billing — Security Specification (Phase 0 TDD — Multiempresa & RBAC)

## 1. Data Invariants
1. **Strict Tenant & Multi-Company Isolation**:
   - Legacy `/users/{userId}/...` documents remain accessible exclusively to verified `request.auth.uid == userId`.
   - Multi-company `/companies/{companyId}/...` documents require active membership verified via the Master Gate `/companies/{companyId}/members/{request.auth.uid}` (`active == true`). Ownership of Company A grants zero access to Company B.
2. **Global Legal Invariant (`1 NIF = 1 Empresa`)**:
   - Every `/companies/{companyId}` creation must atomically create `/company_nifs/{normalizedNif}` (`existsAfter` + `getAfter`).
   - Once `/company_nifs/{normalizedNif}` exists, its `companyId` is strictly immutable (`incoming().companyId == existing().companyId`), making it impossible to register a second company with the same NIF.
3. **Three-Tier RBAC Enforcement (`owner | manager | cashier`)**:
   - `cashier` can ONLY `get` products, `create` customers, and `create` issued invoices on an `active` company. `cashier` is strictly denied `create`/`update`/`delete` on `products`, `update`/`delete` on `customers`, `update` on `settings`, and `cancel` (`update`) on `invoices`.
   - `manager` can manage `products` and `customers`, emit `invoices`, and can ONLY cancel an invoice if `company.allowManagerCancel == true` or `member.allowInvoiceCancel == true`.
   - `owner` manages fiscal profile, settings, members, products, customers, and invoice cancellations for their own company only, and cannot self-escalate `planTier` or `commercialActive`.
4. **Audited Terminal State Locking on Invoices**:
   - Once an invoice reaches `status == 'cancelled'`, zero further updates are allowed.
   - Transitioning `issued -> cancelled` requires authorized role (`owner` or permitted `manager`) AND mandatory `cancelReason` (`size() >= 4 && size() <= 240`).
5. **Platform Master Admin Isolation**:
   - `isPlatformAdmin()` requires `request.auth != null && request.auth.token.email_verified == true` BEFORE checking `request.auth.token.email == 'wtmedia0@gmail.com'` or `exists(/platform_admins/$(request.auth.uid))`.
   - Clients can never write to `/platform_admins` or `/platform_audit_logs`.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Email Spoof on Admin Email**: Signed-in user with `email: 'wtmedia0@gmail.com'` and `email_verified: false` attempts to suspend `/companies/comp_jaimona`. -> `PERMISSION_DENIED`
2. **Cross-Company Data Read**: Owner of `comp_alpha` attempts `get` or `list` on `/companies/comp_jaimona/invoices`. -> `PERMISSION_DENIED`
3. **Duplicate NIF Registration (`1 NIF = 1 Empresa` Violation)**: User `u2` attempts to create `comp_clone` claiming `/company_nifs/5003069940` already bound to `comp_jaimona`. -> `PERMISSION_DENIED`
4. **Cashier Editing Product Price**: Active `cashier` member attempts `update` or `delete` on `/companies/comp_1/products/prod_1`. -> `PERMISSION_DENIED`
5. **Cashier Cancelling Invoice**: Active `cashier` member attempts `update` (`status: 'cancelled'`) on `/companies/comp_1/invoices/inv_1`. -> `PERMISSION_DENIED`
6. **Invoice Cancellation Without Justification**: `owner` attempts `update` (`status: 'cancelled'`, `cancelReason: ''`) on `/companies/comp_1/invoices/inv_1`. -> `PERMISSION_DENIED`
7. **Self-Assigned Commercial Plan Upgrade**: `owner` creates or updates `/companies/comp_1` with `planTier: 'ENTERPRISE'` or `commercialActive: true`. -> `PERMISSION_DENIED`
8. **Emission on Suspended Company**: Member attempts `create` on `/companies/comp_suspended/invoices/inv_9` while parent company has `status == 'suspended'`. -> `PERMISSION_DENIED`
9. **Shadow/Ghost Field Injection**: User injects `"isPlatformAdmin": true` into `/companies/comp_1/customers/c1`. -> `PERMISSION_DENIED`
10. **ID Poisoning & Oversized Payload**: User creates `/companies/bad$id/products/p1` or `notes` of 5,000 chars. -> `PERMISSION_DENIED`
11. **Terminal State Bypass**: `owner` attempts to revert a `cancelled` invoice back to `issued`. -> `PERMISSION_DENIED`
12. **PII Leak Across Companies**: User from `comp_2` attempts `get` on `/companies/comp_1/customers/c1/private/contact`. -> `PERMISSION_DENIED`
