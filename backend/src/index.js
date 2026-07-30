import express from 'express';
import cookieParser from 'cookie-parser';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { authRouter } from './routes/auth.js';
import { apiRouter } from './routes/api.js';
import { webhookRouter } from './routes/webhooks.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.get('/healthz', (req, res) => res.json({ ok: true, version: config.apiVersion }));

// Webhooks must be mounted before any JSON body parser so the raw body — which
// the HMAC is computed over — stays intact.
app.use('/webhooks', webhookRouter);

app.use(cookieParser());
app.use('/', authRouter);
app.use('/api', apiRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  console.error('[server] unhandled error', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[server] listening on :${config.port} (Admin API ${config.apiVersion})`);
  try {
    await migrate();
    if (config.schedulerEnabled) startScheduler();
    else console.log('[scheduler] disabled by SCHEDULER_ENABLED=false');
  } catch (err) {
    console.error('[server] startup failed', err);
    process.exit(1);
  }
});

const shutdown = (signal) => async () => {
  console.log(`[server] ${signal} received, shutting down`);
  stopScheduler();
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on('SIGTERM', shutdown('SIGTERM'));
process.on('SIGINT', shutdown('SIGINT'));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection', err));
