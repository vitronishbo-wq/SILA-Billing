import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { createApiApp } from './backend/app.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = createApiApp();
  const isProd = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT) || 3000;

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) {
          next();
          return;
        }
        res.sendFile(path.join(distPath, 'index.html'));
      });
    } else {
      app.get('/', (_req, res) => {
        res.status(200).json({
          service: 'sila-billing-backend',
          status: 'online',
          endpoints: ['/api/health', '/api/audit/invoices', '/api/backup'],
        });
      });
    }
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`[SILA-Billing] Servidor ativo em http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
  });
}

startServer().catch((err) => {
  console.error('Erro fatal ao iniciar servidor SILA-Billing:', err);
  process.exit(1);
});
