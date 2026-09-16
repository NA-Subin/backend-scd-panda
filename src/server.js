import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { basicDataRoutes } from './routes/basicData.js';
import { tablesRoutes } from './routes/tables.js';
import { authRoutes } from './routes/auth.js';
import { adminRoutes } from './routes/admin.js';
import { uploadRoutes } from './routes/uploads.js';
import { backupRoutes } from './routes/backup.js';
import { bootstrapImportRoutes } from './routes/bootstrapImport.js';
import { startBackupScheduler } from './backupScheduler.js';

const port = process.env.PORT || 4000;

// Comma-separated list in CORS_ORIGIN (e.g. multiple local dev ports).
// Falls back to "*" only if CORS_ORIGIN is unset entirely.
const corsOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : '*';

const app = new Elysia()
  .use(cors({ origin: corsOrigins }))
  .onError(({ error, set }) => {
    console.error(error);
    set.status = error.status || 500;
    return { error: error.message || 'Internal server error' };
  })
  .get('/health', () => ({ ok: true }))
  .use(basicDataRoutes)
  .use(authRoutes)
  .use(adminRoutes)
  .use(uploadRoutes)
  .use(backupRoutes)
  .use(bootstrapImportRoutes)
  .use(tablesRoutes)
  // Firebase export JSON re-imports can be tens of MB; raise Bun's default body limit.
  .listen({ port, maxRequestBodySize: 200 * 1024 * 1024 });

console.log(`Backend listening on http://localhost:${port}`);

startBackupScheduler();
