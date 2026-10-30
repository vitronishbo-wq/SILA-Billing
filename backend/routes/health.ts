import { Router } from 'express';
import { PLATFORM_ADMIN_EMAIL } from '../../src/core/types.ts';
import { ensureFirebaseAuthorizedDomains, getFirebaseAdminContext } from '../firebaseAdmin.ts';

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const ctx = getFirebaseAdminContext();
  let firestoreReachable = false;
  let firestoreMessage = 'Credenciais de Service Account ainda não configuradas no ambiente.';

  if (ctx.db && ctx.hasExplicitCredentials) {
    try {
      await ctx.db.collection('_health').doc('ping').get();
      firestoreReachable = true;
      firestoreMessage = 'Ligação administrativa ao Firestore verificada com sucesso.';
    } catch (err) {
      firestoreReachable = false;
      firestoreMessage =
        err instanceof Error ? err.message : 'Erro ao consultar Firestore.';
    }
  } else if (ctx.initError) {
    firestoreMessage = ctx.initError;
  }

  res.status(200).json({
    ok: true,
    service: 'sila-billing-backend',
    platform: 'SILA-Billing',
    architecture: 'multitenant-isolated',
    platformAdminEmail: PLATFORM_ADMIN_EMAIL,
    projectId: ctx.projectId,
    firestoreDatabaseId: ctx.databaseId,
    credentialSource: ctx.credentialSource,
    hasServiceAccount: ctx.hasExplicitCredentials,
    firestoreReachable,
    message: firestoreMessage,
    timestamp: new Date().toISOString(),
  });
});

healthRouter.post('/ensure-auth-domains', async (_req, res) => {
  const result = await ensureFirebaseAuthorizedDomains();
  res.status(result.ok ? 200 : 202).json(result);
});
