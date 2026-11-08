import cors from 'cors';
import express, { type Express } from 'express';
import { ensureFirebaseAuthorizedDomains, getFirebaseAdminContext } from './firebaseAdmin.ts';
import { adminRouter } from './routes/admin.ts';
import { agtRouter } from './routes/agt.ts';
import { auditRouter } from './routes/audit.ts';
import { backupRouter } from './routes/backup.ts';
import { companiesRouter } from './routes/companies.ts';
import { healthRouter } from './routes/health.ts';

export function createApiApp(): Express {
  const app = express();

  const ctx = getFirebaseAdminContext();
  if (ctx.hasExplicitCredentials) {
    void ensureFirebaseAuthorizedDomains();
  }

  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        // Sem cabeçalho origin (mesma origem, ferramentas CLI, server-side)
        if (!origin) {
          callback(null, true);
          return;
        }
        // Origens configuradas explicitamente por variável de ambiente
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
          callback(null, true);
          return;
        }
        // Domínios institucionais e ambientes de desenvolvimento/staging
        const oLower = origin.toLowerCase();
        if (
          oLower.endsWith('.web.app') ||
          oLower.endsWith('.firebaseapp.com') ||
          oLower.endsWith('.run.app') ||
          oLower.includes('localhost') ||
          oLower.includes('127.0.0.1') ||
          process.env.NODE_ENV !== 'production'
        ) {
          callback(null, true);
          return;
        }
        // Negação segura sem atirar exceção que mascara erro como "Failed to fetch"
        callback(null, false);
      },
      credentials: true,
    })
  );

  app.use(express.json({ limit: '2mb' }));

  // Rotas oficiais da API SILA-Billing
  app.use('/api/health', healthRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/backup', backupRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/agt', agtRouter);

  return app;
}
