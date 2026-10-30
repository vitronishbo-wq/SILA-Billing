import type { NextFunction, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';
import {
  isJaimonaOwnerEmail,
  JAIMONA_COMPANY_ID,
  PLATFORM_ADMIN_EMAIL,
  type CompanyRole,
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
  allowCancel: boolean;
  companyData: Record<string, unknown> | null;
}

/**
 * Valida no servidor se o utilizador autenticado pertence à empresa indicada
 * e devolve o papel efetivo (owner | manager | cashier).
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
  const [companySnap, memberSnap] = await Promise.all([
    companyRef.get(),
    companyRef.collection('members').doc(user.uid).get(),
  ]);

  if (!companySnap.exists) {
    // Compatibilidade pré-sincronização restrita ao e-mail titular da JAIMONA ou Super-Admin SILA-Billing
    const isGlobalAdmin = await checkIsPlatformAdmin(user, db);
    if (safeCompanyId === JAIMONA_COMPANY_ID && (isJaimonaOwnerEmail(user.email) || isGlobalAdmin)) {
      return {
        existsInCloud: false,
        companyStatus: 'active',
        role: 'owner',
        allowCancel: true,
        companyData: null,
      };
    }
    return null;
  }

  const cData = companySnap.data() || {};
  const status =
    cData.status === 'suspended'
      ? 'suspended'
      : cData.status === 'pending'
        ? 'pending'
        : 'active';

  if (cData.ownerUid === user.uid) {
    return {
      existsInCloud: true,
      companyStatus: status,
      role: 'owner',
      allowCancel: true,
      companyData: cData,
    };
  }

  if (memberSnap.exists && memberSnap.data()?.active === true) {
    const mData = memberSnap.data()!;
    const role: CompanyRole =
      mData.role === 'owner' ? 'owner' : mData.role === 'manager' ? 'manager' : 'cashier';
    const allowCancel =
      role === 'owner' ||
      (role === 'manager' &&
        (Boolean(cData.allowManagerCancel) || Boolean(mData.allowInvoiceCancel)));

    return {
      existsInCloud: true,
      companyStatus: status,
      role,
      allowCancel,
      companyData: cData,
    };
  }

  // Fallback por email verificado caso o proprietário tenha pré-registado o membro por email
  const emailLower = (user.email || '').trim().toLowerCase();
  if (emailLower) {
    const byEmailSnap = await companyRef
      .collection('members')
      .where('emailLower', '==', emailLower)
      .limit(1)
      .get();

    if (!byEmailSnap.empty) {
      const docMatch = byEmailSnap.docs[0]!;
      const mData = docMatch.data();
      if (mData.active === true) {
        const role: CompanyRole =
          mData.role === 'owner' ? 'owner' : mData.role === 'manager' ? 'manager' : 'cashier';
        const allowCancel =
          role === 'owner' ||
          (role === 'manager' &&
            (Boolean(cData.allowManagerCancel) || Boolean(mData.allowInvoiceCancel)));
        return {
          existsInCloud: true,
          companyStatus: status,
          role,
          allowCancel,
          companyData: cData,
        };
      }
    }
  }

  // Administrador global da plataforma tem leitura de suporte auditada
  const isGlobalAdmin = await checkIsPlatformAdmin(user, db);
  if (isGlobalAdmin) {
    return {
      existsInCloud: true,
      companyStatus: status,
      role: 'owner',
      allowCancel: true,
      companyData: cData,
    };
  }

  return null;
}
