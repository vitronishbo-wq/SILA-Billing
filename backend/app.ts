import cors from 'cors';
import express, { type Express } from 'express';
import { adminRouter } from './routes/admin.ts';
import { auditRouter } from './routes/audit.ts';
import { backupRouter } from './routes/backup.ts';
import { companiesRouter } from './routes/companies.ts';
import { healthRouter } from './routes/health.ts';

export function createApiApp(): Express {
  const app = express();

  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        if (
          origin.endsWith('.web.app') ||
          origin.endsWith('.firebaseapp.com') ||
          origin.endsWith('.run.app')
        ) {
          callback(null, true);
          return;
        }
        callback(new Error('Origem não autorizada por política CORS.'));
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

  return app;
}
