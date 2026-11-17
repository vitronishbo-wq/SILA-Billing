import type { NextFunction, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import {
  buildDefaultCompanyRoles,
  normalizeLegacyMember,
  resolveMemberBaseRole,
  resolveMemberPermissions,
  resolveMemberStatus,
} from '../../src/core/rbac.ts';
import {
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  PLATFORM_ADMIN_EMAIL,
  type CompanyMember,
  type CompanyRole,
  type CompanyRoleDefinition,
  type PermissionKey,
} from '../../src/core/types.ts';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';
import type { AuthenticatedRequest } from './requireFirebaseAuth.ts';

function getAllowedAdminEmails(): Set<string> {
  const emails = new Set<string>([PLATFORM_ADMIN_EMAIL]);
  const rawEnv = process.env.PLATFORM_ADMIN_EMAILS || '';
  for (const part of rawEnv.split(',')) {
    const clean = part.trim().toLowerCase();
    if (clean) emails.add(clean);
  }
  return emails;
}

export async function checkIsPlatformAdmin(
  user: DecodedIdToken,
  db: Firestore | null
): Promise<boolean> {
  if (!user.email_verified) return false;

  const email = (user.email || '').trim().toLowerCase();
  if (email && getAllowedAdminEmails().has(email)) {
    return true;
  }

  if (db) {
    try {
      const adminDoc = await db.collection('platform_admins').doc(user.uid).get();
      if (adminDoc.exists && adminDoc.data()?.active !== false) {
        return true;
      }
    } catch {
      // Ignora erro de leitura quando Admin SDK corre sem credencial explícita em dev
    }
  }

  return false;
}

export async function requirePlatformAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = req.firebaseUser;
  if (!user || !user.email_verified) {
    res.status(403).json({
      ok: false,
      error: 'Acesso negado: conta autenticada com email verificado é obrigatória.',
    });
    return;
  }

  const ctx = getFirebaseAdminContext();
  const allowed = await checkIsPlatformAdmin(user, ctx.db);

  if (!allowed) {
    res.status(403).json({
      ok: false,
      error: 'Acesso restrito exclusivamente à administração global da plataforma SILA-Billing.',
    });
    return;
  }

  next();
}

export interface VerifiedCompanyMembership {
  existsInCloud: boolean;
  companyStatus: 'active' | 'suspended' | 'pending';
  role: CompanyRole;
  roleId: string;
  memberId: string;
  memberRecord: CompanyMember | null;
  permissions: Record<PermissionKey, boolean>;
  establishmentIds: string[];
  authorizedCashiers: string[];
  allowCancel: boolean;
  isPlatformSupport?: boolean;
  companyData: Record<string, unknown> | null;
}

function resolveDocToMember(
  docId: string,
  companyId: string,
  raw: Record<string, unknown>,
  allowManagerCancel: boolean
): CompanyMember {
  const now = new Date().toISOString();
  const candidate: CompanyMember = {
    id: String(raw.id || docId),
    companyId: String(raw.companyId || companyId),
    uid: String(raw.uid || docId),
    email: String(raw.email || ''),
    emailLower: String(raw.emailLower || raw.email || '').trim().toLowerCase(),
    ...(raw.phone ? { phone: String(raw.phone) } : {}),
    displayName: String(raw.displayName || raw.email || 'Colaborador'),
    role: resolveMemberBaseRole({ role: raw.role as CompanyRole }),
    roleId: raw.roleId ? String(raw.roleId) : undefined,
    establishmentIds: Array.isArray(raw.establishmentIds)
      ? raw.establishmentIds.map((x) => String(x))
      : [],
    authorizedCashiers: Array.isArray(raw.authorizedCashiers)
      ? raw.authorizedCashiers.map((x) => String(x))
      : [],
    permissionOverrides:
      raw.permissionOverrides && typeof raw.permissionOverrides === 'object'
        ? {
            grant: Array.isArray((raw.permissionOverrides as { grant?: unknown[] }).grant)
              ? ((raw.permissionOverrides as { grant: unknown[] }).grant.map((x) =>
                  String(x)
                ) as PermissionKey[])
              : [],
            revoke: Array.isArray((raw.permissionOverrides as { revoke?: unknown[] }).revoke)
              ? ((raw.permissionOverrides as { revoke: unknown[] }).revoke.map((x) =>
                  String(x)
                ) as PermissionKey[])
              : [],
          }
        : undefined,
    status:
      raw.status === 'pending_invite' || raw.status === 'active' || raw.status === 'suspended'
        ? raw.status
        : raw.active === true
          ? 'active'
          : 'suspended',
    allowInvoiceCancel: Boolean(raw.allowInvoiceCancel),
    active: Boolean(raw.active),
    ...(raw.pinHash ? { pinHash: String(raw.pinHash) } : {}),
    createdAtIso: String(raw.createdAtIso || now),
    updatedAtIso: String(raw.updatedAtIso || now),
  };
  return normalizeLegacyMember(candidate, allowManagerCancel);
}

/**
 * Valida no servidor se o utilizador autenticado pertence à empresa indicada
 * e devolve o papel efectivo (7 funções base + funções personalizadas) e permissões granulares.
 */
export async function verifyCompanyMembershipServer(
  db: Firestore,
  companyId: string,
  user: DecodedIdToken
): Promise<VerifiedCompanyMembership | null> {
  const safeCompanyId = String(companyId || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  if (!safeCompanyId) {
    return null;
  }

  const companyRef = db.collection('companies').doc(safeCompanyId);
  const [companySnap, memberSnap, rolesSnap] = await Promise.all([
    companyRef.get(),
    companyRef.collection('members').doc(user.uid).get(),
    companyRef.collection('roles').get().catch(() => null),
  ]);

  const systemRoles = buildDefaultCompanyRoles(safeCompanyId);
  const customRoles: CompanyRoleDefinition[] = (rolesSnap?.docs || []).map(
    (d) => ({ id: d.id, ...(d.data() as Omit<CompanyRoleDefinition, 'id'>) })
  );
  const allRoles = [
    ...systemRoles.filter((sr) => !customRoles.some((cr) => cr.id === sr.id)),
    ...customRoles,
  ];

  if (!companySnap.exists) {
    const isGlobalAdmin = await checkIsPlatformAdmin(user, db);
    if (safeCompanyId === JAIMONA_COMPANY_ID && (isJaimonaOwnerEmail(user.email) || isGlobalAdmin)) {
      const ownerStub = normalizeLegacyMember({
        id: `${safeCompanyId}_${user.uid}`,
        companyId: safeCompanyId,
        uid: user.uid,
        email: user.email || '',
        displayName: user.name || user.email || 'Proprietário',
        role: 'owner',
        roleId: 'role_owner',
        status: 'active',
        allowInvoiceCancel: true,
        active: true,
        createdAtIso: new Date().toISOString(),
        updatedAtIso: new Date().toISOString(),
      });
      return {
        existsInCloud: false,
        companyStatus: 'active',
        role: 'owner',
        roleId: 'role_owner',
        memberId: ownerStub.id,
        memberRecord: ownerStub,
        permissions: resolveMemberPermissions(ownerStub, allRoles, true),
        establishmentIds: [],
        authorizedCashiers: [],
        allowCancel: true,
        isPlatformSupport: isGlobalAdmin && !isJaimonaOwnerEmail(user.email),
        companyData: null,
      };
    }
    return null;
  }

  const cData = companySnap.data() || {};
  const allowManagerCancel = Boolean(cData.allowManagerCancel);
  const status =
    cData.status === 'suspended'
      ? 'suspended'
      : cData.status === 'pending'
        ? 'pending'
        : 'active';

  if (cData.ownerUid === user.uid) {
    const ownerMember = memberSnap.exists
      ? resolveDocToMember(memberSnap.id, safeCompanyId, memberSnap.data() || {}, allowManagerCancel)
      : normalizeLegacyMember({
          id: user.uid,
          companyId: safeCompanyId,
          uid: user.uid,
          email: String(cData.ownerEmail || user.email || ''),
          displayName: user.name || String(cData.ownerEmail || user.email || 'Proprietário'),
          role: 'owner',
          roleId: 'role_owner',
          status: 'active',
          allowInvoiceCancel: true,
          active: true,
          createdAtIso: new Date().toISOString(),
          updatedAtIso: new Date().toISOString(),
        });
    const perms = resolveMemberPermissions({ ...ownerMember, role: 'owner', status: 'active', active: true }, allRoles, allowManagerCancel);
    return {
      existsInCloud: true,
      companyStatus: status,
      role: 'owner',
      roleId: ownerMember.roleId || 'role_owner',
      memberId: ownerMember.id,
      memberRecord: { ...ownerMember, role: 'owner', status: 'active', active: true },
      permissions: perms,
      establishmentIds: [],
      authorizedCashiers: [],
      allowCancel: true,
      companyData: cData,
    };
  }

  if (memberSnap.exists) {
    const m = resolveDocToMember(
      memberSnap.id,
      safeCompanyId,
      memberSnap.data() || {},
      allowManagerCancel
    );
    if (resolveMemberStatus(m) === 'active') {
      const perms = resolveMemberPermissions(m, allRoles, allowManagerCancel);
      return {
        existsInCloud: true,
        companyStatus: status,
        role: m.role,
        roleId: m.roleId || `role_${m.role}`,
        memberId: m.id,
        memberRecord: m,
        permissions: perms,
        establishmentIds: m.establishmentIds || [],
        authorizedCashiers: m.authorizedCashiers || [],
        allowCancel: Boolean(perms.invoice_cancel),
        companyData: cData,
      };
    }
    return null;
  }

  // Fallback por email verificado apenas para membro explícito já activo
  const emailLower = (user.email || '').trim().toLowerCase();
  if (emailLower) {
    const byEmailSnap = await companyRef
      .collection('members')
      .where('emailLower', '==', emailLower)
      .limit(1)
      .get();

    if (!byEmailSnap.empty) {
      const docMatch = byEmailSnap.docs[0]!;
      const m = resolveDocToMember(
        docMatch.id,
        safeCompanyId,
        docMatch.data() || {},
        allowManagerCancel
      );
      if (resolveMemberStatus(m) === 'active') {
        const perms = resolveMemberPermissions(m, allRoles, allowManagerCancel);
        return {
          existsInCloud: true,
          companyStatus: status,
          role: m.role,
          roleId: m.roleId || `role_${m.role}`,
          memberId: m.id,
          memberRecord: m,
          permissions: perms,
          establishmentIds: m.establishmentIds || [],
          authorizedCashiers: m.authorizedCashiers || [],
          allowCancel: Boolean(perms.invoice_cancel),
          companyData: cData,
        };
      }
    }
  }

  // Administrador global VITRONIS só tem acesso de suporte auditado, separado da administração interna de cliente
  const isGlobalAdmin = await checkIsPlatformAdmin(user, db);
  if (isGlobalAdmin) {
    const supportStub = normalizeLegacyMember({
      id: `support_${user.uid}`,
      companyId: safeCompanyId,
      uid: user.uid,
      email: user.email || '',
      displayName: 'Suporte VITRONIS',
      role: 'owner',
      roleId: 'role_owner',
      status: 'active',
      allowInvoiceCancel: true,
      active: true,
      createdAtIso: new Date().toISOString(),
      updatedAtIso: new Date().toISOString(),
    });
    return {
      existsInCloud: true,
      companyStatus: status,
      role: 'owner',
      roleId: 'role_owner',
      memberId: supportStub.id,
      memberRecord: supportStub,
      permissions: resolveMemberPermissions(supportStub, allRoles, true),
      establishmentIds: [],
      authorizedCashiers: [],
      allowCancel: true,
      isPlatformSupport: true,
      companyData: cData,
    };
  }

  return null;
}
