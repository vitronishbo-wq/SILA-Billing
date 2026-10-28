import { Router } from 'express';
import { getFirebaseAdminContext } from '../firebaseAdmin.ts';

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
    company: 'JAIMONA-COMÉRCIO E SERVIÇOS, (SU) LDA',
    nif: '5003069940',
    projectId: ctx.projectId,
    firestoreDatabaseId: ctx.databaseId,
    credentialSource: ctx.credentialSource,
    hasServiceAccount: ctx.hasExplicitCredentials,
    firestoreReachable,
    message: firestoreMessage,
    timestamp: new Date().toISOString(),
  });
});
