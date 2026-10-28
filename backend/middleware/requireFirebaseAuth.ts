import type { NextFunction, Request, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';

export interface AuthenticatedRequest extends Request {
  firebaseUser?: DecodedIdToken;
}

export async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      error: 'Cabeçalho Authorization Bearer token ausente.',
    });
    return;
  }

  const idToken = authHeader.slice('Bearer '.length).trim();
  if (!idToken) {
    res.status(401).json({
      ok: false,
      error: 'Token Firebase ID vazio.',
    });
    return;
  }

  const { auth, initError } = getFirebaseAdminContext();
  if (!auth) {
    res.status(503).json({
      ok: false,
      error: `Firebase Admin indisponível: ${initError || 'não inicializado'}`,
    });
    return;
  }

  try {
    const decoded = await auth.verifyIdToken(idToken);
    if (!decoded.email_verified) {
      res.status(403).json({
        ok: false,
        error: 'Conta com email não verificado.',
      });
      return;
    }
    req.firebaseUser = decoded;
    next();
  } catch (err) {
    res.status(401).json({
      ok: false,
      error:
        err instanceof Error
          ? `Token Firebase inválido ou expirado: ${err.message}`
          : 'Token Firebase inválido.',
    });
  }
}
