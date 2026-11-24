import type {
  CompanyMember,
  CompanyRecord,
  CompanyRole,
  CompanyRoleDefinition,
  MemberStatus,
  PermissionKey,
} from './types.ts';
import {
  isJaimonaOwnerEmail,
  isPlatformAdminEmail,
  JAIMONA_COMPANY_ID,
} from './types.ts';

export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = [
  'pos_sell',
  'a4_sell',
  'pos_discount_special',
  'pos_price_edit',
  'invoice_cancel',
  'credit_note_issue',
  'customers_view',
  'customers_create',
  'customers_manage',
  'products_view',
  'products_manage',
  'cost_prices_view',
  'stock_view',
  'stock_manage',
  'purchases_view',
  'purchases_manage',
  'suppliers_view',
  'suppliers_manage',
  'expenses_manage',
  'finance_view',
  'profits_margins_view',
  'cash_own_shift',
  'cash_all_shifts',
  'reports_own_sales',
  'reports_operational',
  'reports_financial',
  'master_view',
  'master_edit',
  'series_view',
  'series_manage',
  'saft_export',
  'audit_view',
  'users_view',
  'users_manage',
  'roles_manage',
  'settings_manage',
  'backup_export',
] as const;

export const PERMISSION_CATALOG: ReadonlyArray<{
  key: PermissionKey;
  group: 'Vendas & POS' | 'Clientes & Stock' | 'Compras & Finanças' | 'Fiscal & Administração';
  label: string;
}> = [
  { key: 'pos_sell', group: 'Vendas & POS', label: 'Emitir faturas POS' },
  { key: 'a4_sell', group: 'Vendas & POS', label: 'Emitir faturas e proformas A4' },
  { key: 'pos_discount_special', group: 'Vendas & POS', label: 'Aplicar descontos acima do limite' },
  { key: 'pos_price_edit', group: 'Vendas & POS', label: 'Alterar preço unitário no carrinho' },
  { key: 'invoice_cancel', group: 'Vendas & POS', label: 'Anular faturas emitidas' },
  { key: 'credit_note_issue', group: 'Vendas & POS', label: 'Emitir Notas de Crédito (NC)' },
  { key: 'customers_view', group: 'Clientes & Stock', label: 'Consultar clientes' },
  { key: 'customers_create', group: 'Clientes & Stock', label: 'Criar cliente rápido' },
  { key: 'customers_manage', group: 'Clientes & Stock', label: 'Editar e gerir cadastro de clientes' },
  { key: 'products_view', group: 'Clientes & Stock', label: 'Consultar catálogo de venda' },
  { key: 'products_manage', group: 'Clientes & Stock', label: 'Criar e editar produtos/preços' },
  { key: 'cost_prices_view', group: 'Clientes & Stock', label: 'Visualizar preços de custo' },
  { key: 'stock_view', group: 'Clientes & Stock', label: 'Consultar saldos de stock' },
  { key: 'stock_manage', group: 'Clientes & Stock', label: 'Movimentar e reconciliar inventário' },
  { key: 'purchases_view', group: 'Compras & Finanças', label: 'Consultar compras a fornecedores' },
  { key: 'purchases_manage', group: 'Compras & Finanças', label: 'Registar e liquidar compras' },
  { key: 'suppliers_view', group: 'Compras & Finanças', label: 'Consultar fornecedores' },
  { key: 'suppliers_manage', group: 'Compras & Finanças', label: 'Gerir fornecedores e contactos' },
  { key: 'expenses_manage', group: 'Compras & Finanças', label: 'Gerir despesas operacionais' },
  { key: 'finance_view', group: 'Compras & Finanças', label: 'Aceder à Gestão Financeira' },
  { key: 'profits_margins_view', group: 'Compras & Finanças', label: 'Ver lucros, margens e contas' },
  { key: 'cash_own_shift', group: 'Compras & Finanças', label: 'Abrir e fechar o próprio turno de caixa' },
  { key: 'cash_all_shifts', group: 'Compras & Finanças', label: 'Consultar todos os turnos e tesouraria' },
  { key: 'reports_own_sales', group: 'Compras & Finanças', label: 'Ver vendas do próprio turno/operador' },
  { key: 'reports_operational', group: 'Compras & Finanças', label: 'Ver relatórios operacionais globais' },
  { key: 'reports_financial', group: 'Compras & Finanças', label: 'Ver indicadores e relatórios financeiros' },
  { key: 'master_view', group: 'Fiscal & Administração', label: 'Consultar Ficha Mestre fiscal' },
  { key: 'master_edit', group: 'Fiscal & Administração', label: 'Alterar Ficha Mestre e estabelecimentos' },
  { key: 'series_view', group: 'Fiscal & Administração', label: 'Consultar séries fiscais AGT' },
  { key: 'series_manage', group: 'Fiscal & Administração', label: 'Criar e encerrar séries fiscais' },
  { key: 'saft_export', group: 'Fiscal & Administração', label: 'Exportar SAF-T (AO) e listagens fiscais' },
  { key: 'audit_view', group: 'Fiscal & Administração', label: 'Consultar auditoria de actividades' },
  { key: 'users_view', group: 'Fiscal & Administração', label: 'Consultar equipa e funções' },
  { key: 'users_manage', group: 'Fiscal & Administração', label: 'Criar, suspender e editar utilizadores' },
  { key: 'roles_manage', group: 'Fiscal & Administração', label: 'Criar e editar funções personalizadas' },
  { key: 'settings_manage', group: 'Fiscal & Administração', label: 'Gerir configurações operacionais e bloqueio' },
  { key: 'backup_export', group: 'Fiscal & Administração', label: 'Exportar backups locais e Cloud' },
];

export const BASE_ROLE_HIERARCHY: Record<CompanyRole, number> = {
  owner: 100,
  admin: 80,
  manager: 60,
  accountant: 50,
  warehouse: 40,
  seller: 30,
  cashier: 20,
};

export const BASE_ROLE_LABELS: Record<CompanyRole, string> = {
  owner: 'Proprietário',
  admin: 'Administrador',
  manager: 'Gerente',
  cashier: 'Caixa',
  accountant: 'Contabilista',
  warehouse: 'Armazém',
  seller: 'Vendedor',
};

export function formatRoleLabelPt(role: CompanyRole | string): string {
  return BASE_ROLE_LABELS[role as CompanyRole] || String(role || 'Operador');
}

function buildPermMap(granted: PermissionKey[]): Record<PermissionKey, boolean> {
  const out = {} as Record<PermissionKey, boolean>;
  for (const key of ALL_PERMISSION_KEYS) {
    out[key] = false;
  }
  for (const key of granted) {
    out[key] = true;
  }
  return out;
}

export const SYSTEM_ROLE_PERMISSIONS: Record<CompanyRole, Record<PermissionKey, boolean>> = {
  owner: buildPermMap([...ALL_PERMISSION_KEYS]),
  admin: buildPermMap([
    'pos_sell',
    'a4_sell',
    'pos_discount_special',
    'pos_price_edit',
    'invoice_cancel',
    'credit_note_issue',
    'customers_view',
    'customers_create',
    'customers_manage',
    'products_view',
    'products_manage',
    'cost_prices_view',
    'stock_view',
    'stock_manage',
    'purchases_view',
    'purchases_manage',
    'suppliers_view',
    'suppliers_manage',
    'expenses_manage',
    'finance_view',
    'profits_margins_view',
    'cash_own_shift',
    'cash_all_shifts',
    'reports_own_sales',
    'reports_operational',
    'reports_financial',
    'master_view',
    'series_view',
    'audit_view',
    'users_view',
    'users_manage',
    'settings_manage',
  ]),
  manager: buildPermMap([
    'pos_sell',
    'a4_sell',
    'pos_discount_special',
    'pos_price_edit',
    'credit_note_issue',
    'customers_view',
    'customers_create',
    'customers_manage',
    'products_view',
    'products_manage',
    'stock_view',
    'stock_manage',
    'purchases_view',
    'purchases_manage',
    'suppliers_view',
    'suppliers_manage',
    'cash_own_shift',
    'cash_all_shifts',
    'reports_own_sales',
    'reports_operational',
    'audit_view',
    'users_view',
  ]),
  cashier: buildPermMap([
    'pos_sell',
    'a4_sell',
    'customers_view',
    'customers_create',
    'products_view',
    'stock_view',
    'cash_own_shift',
    'reports_own_sales',
  ]),
  accountant: buildPermMap([
    'customers_view',
    'products_view',
    'cost_prices_view',
    'stock_view',
    'purchases_view',
    'suppliers_view',
    'finance_view',
    'profits_margins_view',
    'cash_all_shifts',
    'reports_operational',
    'reports_financial',
    'master_view',
    'series_view',
    'saft_export',
    'audit_view',
    'backup_export',
  ]),
  warehouse: buildPermMap([
    'products_view',
    'products_manage',
    'stock_view',
    'stock_manage',
    'purchases_view',
    'purchases_manage',
    'suppliers_view',
  ]),
  seller: buildPermMap([
    'pos_sell',
    'a4_sell',
    'customers_view',
    'customers_create',
    'customers_manage',
    'products_view',
    'stock_view',
    'reports_own_sales',
  ]),
};

export function getSystemRoleId(baseRole: CompanyRole): string {
  return `role_${baseRole}`;
}

export function buildDefaultCompanyRoles(companyId: string): CompanyRoleDefinition[] {
  const now = '2026-01-01T00:00:00.000Z';
  const order: CompanyRole[] = [
    'owner',
    'admin',
    'manager',
    'cashier',
    'accountant',
    'warehouse',
    'seller',
  ];
  const descriptions: Record<CompanyRole, string> = {
    owner: 'Controlo integral da empresa, dados fiscais, equipa e finanças',
    admin: 'Gestão operacional e administrativa conforme autorização do proprietário',
    manager: 'Supervisão da loja, catálogo, stock, compras e turnos',
    cashier: 'Vendas POS/A4, recebimentos e gestão apenas do próprio turno',
    accountant: 'Documentos fiscais, SAF-T, custos, auditoria e relatórios financeiros',
    warehouse: 'Produtos, entradas de mercadoria, saídas e inventário físico',
    seller: 'Atendimento a clientes, orçamentos e vendas comerciais',
  };

  return order.map((baseRole) => ({
    id: getSystemRoleId(baseRole),
    companyId,
    name: BASE_ROLE_LABELS[baseRole],
    description: descriptions[baseRole],
    baseRole,
    isSystem: true,
    permissions: { ...SYSTEM_ROLE_PERMISSIONS[baseRole] },
    createdAtIso: now,
    updatedAtIso: now,
  }));
}

export function resolveMemberBaseRole(member: Pick<CompanyMember, 'role'>): CompanyRole {
  const raw = String(member.role || 'cashier') as CompanyRole;
  return raw in SYSTEM_ROLE_PERMISSIONS ? raw : 'cashier';
}

export function resolveMemberStatus(member: Pick<CompanyMember, 'status' | 'active'>): MemberStatus {
  if (
    member.status === 'pending_invite' ||
    member.status === 'active' ||
    member.status === 'suspended'
  ) {
    return member.status;
  }
  return member.active ? 'active' : 'suspended';
}

export function normalizeLegacyMember(
  raw: CompanyMember,
  companyAllowManagerCancel = false
): CompanyMember {
  const baseRole = resolveMemberBaseRole(raw);
  const roleId = raw.roleId || getSystemRoleId(baseRole);
  const status = resolveMemberStatus(raw);
  const grant = new Set<PermissionKey>(raw.permissionOverrides?.grant || []);
  const revoke = new Set<PermissionKey>(raw.permissionOverrides?.revoke || []);

  if (baseRole === 'manager' && (raw.allowInvoiceCancel || companyAllowManagerCancel)) {
    grant.add('invoice_cancel');
  }

  return {
    ...raw,
    role: baseRole,
    roleId,
    status,
    active: status === 'active',
    establishmentIds: Array.isArray(raw.establishmentIds) ? raw.establishmentIds : [],
    authorizedCashiers: Array.isArray(raw.authorizedCashiers) ? raw.authorizedCashiers : [],
    permissionOverrides: {
      grant: Array.from(grant),
      revoke: Array.from(revoke),
    },
    allowInvoiceCancel:
      baseRole === 'owner' || grant.has('invoice_cancel') || Boolean(raw.allowInvoiceCancel),
  };
}

export function resolveMemberPermissions(
  member: CompanyMember | null | undefined,
  companyRoles: CompanyRoleDefinition[] = [],
  companyAllowManagerCancel = false
): Record<PermissionKey, boolean> {
  if (!member || resolveMemberStatus(member) !== 'active') {
    return buildPermMap([]);
  }

  const baseRole = resolveMemberBaseRole(member);
  if (baseRole === 'owner') {
    return buildPermMap([...ALL_PERMISSION_KEYS]);
  }

  const roleDef =
    (member.roleId ? companyRoles.find((r) => r.id === member.roleId) : undefined) ||
    companyRoles.find((r) => r.baseRole === baseRole && r.isSystem);

  const baseMatrix = roleDef?.permissions
    ? roleDef.permissions
    : SYSTEM_ROLE_PERMISSIONS[baseRole];

  const resolved = {} as Record<PermissionKey, boolean>;
  for (const key of ALL_PERMISSION_KEYS) {
    resolved[key] = Boolean(baseMatrix[key]);
  }

  if (baseRole === 'manager' && (companyAllowManagerCancel || member.allowInvoiceCancel)) {
    resolved.invoice_cancel = true;
  }

  if (member.permissionOverrides?.grant) {
    for (const k of member.permissionOverrides.grant) {
      if (k in resolved) resolved[k] = true;
    }
  }
  if (member.permissionOverrides?.revoke) {
    for (const k of member.permissionOverrides.revoke) {
      if (k in resolved) resolved[k] = false;
    }
  }

  return resolved;
}

export function hasPermission(
  member: CompanyMember | null | undefined,
  permission: PermissionKey,
  companyRoles: CompanyRoleDefinition[] = [],
  companyAllowManagerCancel = false
): boolean {
  const perms = resolveMemberPermissions(member, companyRoles, companyAllowManagerCancel);
  return Boolean(perms[permission]);
}

export function canMemberAccessEstablishment(
  member: Pick<CompanyMember, 'role' | 'establishmentIds'> | null | undefined,
  establishmentId?: string
): boolean {
  if (!member) return false;
  if (resolveMemberBaseRole(member) === 'owner') return true;
  if (!establishmentId) return true;
  if (!member.establishmentIds || member.establishmentIds.length === 0) return true;
  return member.establishmentIds.includes(establishmentId);
}

export function canMemberOperateCashier(
  member: Pick<CompanyMember, 'role' | 'authorizedCashiers'> | null | undefined,
  cashierCode?: string
): boolean {
  if (!member) return false;
  if (resolveMemberBaseRole(member) === 'owner') return true;
  if (!cashierCode) return true;
  if (!member.authorizedCashiers || member.authorizedCashiers.length === 0) return true;
  const target = cashierCode.trim().toLowerCase();
  return member.authorizedCashiers.some((c) => c.trim().toLowerCase() === target);
}

export function canActorManageTargetMember(params: {
  actor: CompanyMember;
  actorPermissions: Record<PermissionKey, boolean>;
  targetCurrentRole?: CompanyRole;
  targetNewRole: CompanyRole;
  targetPermissions?: Record<PermissionKey, boolean>;
  isSelfEdit?: boolean;
}): { allowed: boolean; reason?: string } {
  const actorBase = resolveMemberBaseRole(params.actor);
  if (!params.actorPermissions.users_manage && actorBase !== 'owner') {
    return { allowed: false, reason: 'Não possui permissão para gerir utilizadores.' };
  }

  if (params.isSelfEdit && actorBase !== 'owner') {
    return {
      allowed: false,
      reason: 'Nenhum colaborador pode alterar o próprio perfil ou conceder permissões a si próprio.',
    };
  }

  if (params.targetCurrentRole === 'owner' && actorBase !== 'owner') {
    return {
      allowed: false,
      reason: 'Apenas o Proprietário pode gerir a conta do Proprietário.',
    };
  }

  if (params.targetNewRole === 'owner' && actorBase !== 'owner') {
    return {
      allowed: false,
      reason: 'Não é permitido atribuir a função de Proprietário.',
    };
  }

  const actorRank = BASE_ROLE_HIERARCHY[actorBase];
  const targetRank = BASE_ROLE_HIERARCHY[params.targetNewRole];
  if (actorBase !== 'owner' && targetRank >= actorRank) {
    return {
      allowed: false,
      reason: 'Não é permitido atribuir uma função igual ou superior à sua.',
    };
  }

  if (params.targetPermissions && actorBase !== 'owner') {
    for (const key of ALL_PERMISSION_KEYS) {
      if (params.targetPermissions[key] && !params.actorPermissions[key]) {
        return {
          allowed: false,
          reason: `Escalada bloqueada: não pode conceder a permissão "${key}" sem a possuir.`,
        };
      }
    }
  }

  return { allowed: true };
}

export function canActorManageRoleDefinition(params: {
  actor: CompanyMember;
  actorPermissions: Record<PermissionKey, boolean>;
  roleBase: CompanyRole;
  requestedPermissions: Partial<Record<PermissionKey, boolean>>;
}): { allowed: boolean; reason?: string } {
  const actorBase = resolveMemberBaseRole(params.actor);
  if (actorBase !== 'owner' && !params.actorPermissions.roles_manage) {
    return { allowed: false, reason: 'Não possui permissão para gerir funções personalizadas.' };
  }
  if (params.roleBase === 'owner' && actorBase !== 'owner') {
    return { allowed: false, reason: 'Função Proprietário não pode ser criada nem alterada.' };
  }
  if (actorBase !== 'owner') {
    if (BASE_ROLE_HIERARCHY[params.roleBase] >= BASE_ROLE_HIERARCHY[actorBase]) {
      return { allowed: false, reason: 'Hierarquia base igual ou superior à do utilizador atual.' };
    }
    for (const key of ALL_PERMISSION_KEYS) {
      if (params.requestedPermissions[key] && !params.actorPermissions[key]) {
        return {
          allowed: false,
          reason: `Não pode atribuir "${key}" a uma função sem deter essa permissão.`,
        };
      }
    }
  }
  return { allowed: true };
}

// ==================== PIN CRIPTOGRÁFICO PBKDF2-SHA256 & LOCKOUT ====================

const PIN_ITERATIONS = 100000;
const PIN_REGEX = /^\d{4,6}$/;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function validatePinFormat(pin: string): { valid: boolean; error?: string } {
  const clean = pin.trim();
  if (!PIN_REGEX.test(clean)) {
    return { valid: false, error: 'O PIN deve ter entre 4 e 6 dígitos numéricos.' };
  }
  return { valid: true };
}

async function derivePbkdf2Hex(pin: string, saltBytes: Uint8Array, iterations: number): Promise<string> {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle) {
    throw new Error('WebCrypto API indisponível para derivação segura de PIN.');
  }
  const enc = new TextEncoder().encode(pin);
  const keyMaterial = await cryptoObj.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits']);
  const bits = await cryptoObj.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function hashMemberPin(pin: string): Promise<string> {
  const check = validatePinFormat(pin);
  if (!check.valid) {
    throw new Error(check.error || 'PIN inválido.');
  }
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const hashHex = await derivePbkdf2Hex(pin.trim(), salt, PIN_ITERATIONS);
  return `pbkdf2_sha256$${PIN_ITERATIONS}$${bytesToHex(salt)}$${hashHex}`;
}

export async function verifyMemberPinHash(pin: string, storedHash?: string): Promise<boolean> {
  if (!storedHash || !pin) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  const saltHex = parts[2] || '';
  const expectedHex = parts[3] || '';
  if (!Number.isFinite(iterations) || iterations < 10000 || !saltHex || !expectedHex) {
    return false;
  }
  try {
    const derived = await derivePbkdf2Hex(pin.trim(), hexToBytes(saltHex), iterations);
    return constantTimeEqualHex(derived, expectedHex);
  } catch {
    return false;
  }
}

export function isPinCurrentlyLocked(
  member: Pick<CompanyMember, 'pinLockedUntilIso'>,
  nowMs = Date.now()
): { locked: boolean; remainingSeconds: number } {
  if (!member.pinLockedUntilIso) return { locked: false, remainingSeconds: 0 };
  const untilMs = Date.parse(member.pinLockedUntilIso);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
    return { locked: false, remainingSeconds: 0 };
  }
  return {
    locked: true,
    remainingSeconds: Math.max(1, Math.ceil((untilMs - nowMs) / 1000)),
  };
}

export function computeProgressiveLockout(
  previousFailures: number,
  nowMs = Date.now()
): {
  failedAttempts: number;
  lockedUntilIso?: string;
  lockoutSeconds: number;
} {
  const failedAttempts = Math.max(1, Math.floor(previousFailures) + 1);
  let lockoutSeconds = 0;
  if (failedAttempts >= 8) {
    lockoutSeconds = 15 * 60;
  } else if (failedAttempts >= 5) {
    lockoutSeconds = 5 * 60;
  } else if (failedAttempts >= 3) {
    lockoutSeconds = 30;
  }
  return {
    failedAttempts,
    lockoutSeconds,
    ...(lockoutSeconds > 0
      ? { lockedUntilIso: new Date(nowMs + lockoutSeconds * 1000).toISOString() }
      : {}),
  };
}

export interface OwnerRecoveryGoogleUser {
  uid?: string | null;
  email?: string | null;
  emailVerified?: boolean | null;
}

export type OwnerRecoveryEligibility =
  | {
      canRecover: true;
      reason: 'owner_uid' | 'owner_email' | 'jaimona_owner' | 'platform_admin';
    }
  | {
      canRecover: false;
      errorCode:
        | 'NOT_OWNER_MEMBER'
        | 'MEMBER_INACTIVE'
        | 'NO_GOOGLE_SESSION'
        | 'EMAIL_NOT_VERIFIED'
        | 'NO_OWNER_ANCHOR'
        | 'IDENTITY_MISMATCH';
      message: string;
    };

/**
 * Valida de forma estrita se uma conta Google autenticada e com e-mail verificado
 * está autorizada a redefinir um PIN esquecido do Proprietário no ecrã de bloqueio.
 * Nunca permite recuperação por Google para caixas/gerentes nem por contas não vinculadas.
 */
export function verifyOwnerPinRecoveryEligibility(params: {
  company: Pick<CompanyRecord, 'id' | 'ownerUid' | 'ownerEmail'>;
  targetMember: CompanyMember | null | undefined;
  googleUser: OwnerRecoveryGoogleUser | null | undefined;
}): OwnerRecoveryEligibility {
  const { company, targetMember, googleUser } = params;
  if (!targetMember || resolveMemberBaseRole(targetMember) !== 'owner') {
    return {
      canRecover: false,
      errorCode: 'NOT_OWNER_MEMBER',
      message:
        'A recuperação por Google aplica-se apenas ao Proprietário. Outros operadores devem solicitar novo PIN ao Proprietário.',
    };
  }
  if (resolveMemberStatus(targetMember) !== 'active') {
    return {
      canRecover: false,
      errorCode: 'MEMBER_INACTIVE',
      message: 'A conta do Proprietário está suspensa ou inactiva.',
    };
  }
  const uUid = String(googleUser?.uid || '').trim();
  const uEmail = String(googleUser?.email || '').trim().toLowerCase();
  if (!googleUser || !uUid || !uEmail) {
    return {
      canRecover: false,
      errorCode: 'NO_GOOGLE_SESSION',
      message: 'Confirme a sessão com a conta Google do Proprietário para continuar.',
    };
  }
  if (googleUser.emailVerified !== true) {
    return {
      canRecover: false,
      errorCode: 'EMAIL_NOT_VERIFIED',
      message: 'O e-mail da conta Google não se encontra verificado.',
    };
  }

  const compOwnerUid = String(company.ownerUid || '').trim();
  const compOwnerEmail = String(company.ownerEmail || '').trim().toLowerCase();
  const memUid = String(targetMember.uid || '').trim();
  const memEmailRaw = String(targetMember.emailLower || targetMember.email || '')
    .trim()
    .toLowerCase();
  const memEmail =
    memEmailRaw &&
    memEmailRaw !== 'proprietario@local' &&
    memEmailRaw !== 'proprietario@empresa.ao'
      ? memEmailRaw
      : '';
  const hasRealMemberUid =
    Boolean(memUid) &&
    !memUid.startsWith('local_') &&
    !memUid.startsWith('owner_') &&
    !memUid.startsWith('mem_');

  if (compOwnerUid && uUid === compOwnerUid) {
    return { canRecover: true, reason: 'owner_uid' };
  }
  if (hasRealMemberUid && uUid === memUid) {
    return { canRecover: true, reason: 'owner_uid' };
  }
  if (company.id === JAIMONA_COMPANY_ID && isJaimonaOwnerEmail(uEmail)) {
    return { canRecover: true, reason: 'jaimona_owner' };
  }
  if (compOwnerEmail && uEmail === compOwnerEmail) {
    return { canRecover: true, reason: 'owner_email' };
  }
  if (memEmail && uEmail === memEmail) {
    return { canRecover: true, reason: 'owner_email' };
  }
  if (isPlatformAdminEmail(uEmail)) {
    return { canRecover: true, reason: 'platform_admin' };
  }

  const hasAnchor = Boolean(
    compOwnerUid ||
      compOwnerEmail ||
      hasRealMemberUid ||
      memEmail ||
      company.id === JAIMONA_COMPANY_ID
  );
  if (!hasAnchor) {
    return {
      canRecover: false,
      errorCode: 'NO_OWNER_ANCHOR',
      message:
        'Esta empresa foi criada apenas localmente sem conta Google associada ao Proprietário.',
    };
  }

  return {
    canRecover: false,
    errorCode: 'IDENTITY_MISMATCH',
    message:
      'A conta Google confirmada não corresponde ao Proprietário registado desta empresa.',
  };
}
