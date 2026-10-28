# SILA-Billing — Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Tenant Isolation**: Every document under `/users/{userId}/...` must only be readable and writable by a signed-in user with `request.auth.uid == userId` and `request.auth.token.email_verified == true`.
2. **Owner Field Integrity**: Every entity's `ownerId` field must strictly match `request.auth.uid` on creation and remain immutable on update (`incoming().ownerId == existing().ownerId`).
3. **Subcollection Master Gate & Atomicity**:
   - `/users/{userId}/invoices/{invoiceId}/items/{itemId}` can only be read if the parent invoice exists and belongs to `request.auth.uid`.
   - On creation of an `InvoiceLineItem`, either the parent invoice already exists (`exists(...)`) OR is created atomically in the same batch (`existsAfter(...)`), and its `ownerId == request.auth.uid`.
   - `/users/{userId}/customers/{customerId}/private/{docId}` requires `docId == 'contact'` and parent customer ownership via `exists(...)` or `existsAfter(...)`.
4. **Terminal State Locking**: Once an `Invoice` reaches `status == 'cancelled'`, no subsequent updates are allowed (`existing().status != 'cancelled'`). Even when `status == 'issued'`, only cancellation (`status: 'cancelled'` + `updatedAt`) is permitted; financial totals and invoice numbers are strictly immutable after emission.
5. **Temporal Integrity**: `createdAt` must equal `request.time` on create and remain immutable on update. `updatedAt` must equal `request.time` on both create and update.
6. **Volumetric & Regex Guards**: All document IDs (`userId`, `productId`, `customerId`, `invoiceId`, `itemId`) must match `^[a-zA-Z0-9_\-]+$` with length `<= 128`. All strings enforce strict `maxLength` bounds.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Email Spoof**: Signed-in user with `email_verified: false` attempts to create `/users/u1/products/p1`. -> `PERMISSION_DENIED`
2. **Cross-Tenant Read/List**: User `u2` attempts `list` or `get` on `/users/u1/invoices`. -> `PERMISSION_DENIED`
3. **Owner Spoofing on Create**: User `u1` creates `/users/u1/products/p1` with `ownerId: 'u2'`. -> `PERMISSION_DENIED`
4. **Shadow/Ghost Field Injection**: User `u1` creates `/users/u1/customers/c1` including unauthorized field `"isAdmin": true`. -> `PERMISSION_DENIED`
5. **ID Poisoning**: User `u1` creates `/users/u1/products/bad$id!@#` with invalid characters or >128 chars. -> `PERMISSION_DENIED`
6. **Denial-of-Wallet Oversized String**: User `u1` sets `notes` on invoice to a 5,000-character string (`> 300`). -> `PERMISSION_DENIED`
7. **Client Timestamp Forgery**: User `u1` creates product with `createdAt` set to a past timestamp instead of `request.time`. -> `PERMISSION_DENIED`
8. **Immortal Field Mutation**: User `u1` updates product `p1` and alters `createdAt` or `ownerId`. -> `PERMISSION_DENIED`
9. **Invoice Financial Tampering**: User `u1` attempts to update `grandTotal` on an already issued invoice. -> `PERMISSION_DENIED`
10. **Terminal State Bypass**: User `u1` attempts to revert a `cancelled` invoice back to `issued`. -> `PERMISSION_DENIED`
11. **Orphaned Line Item Write**: User `u1` creates `/users/u1/invoices/non_existent/items/i1` without creating or having parent invoice `non_existent`. -> `PERMISSION_DENIED`
12. **PII Leak on Split Subcollection**: User `u2` attempts `get` on `/users/u1/customers/c1/private/contact`. -> `PERMISSION_DENIED`
