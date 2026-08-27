import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { basicDataRoutes } from './routes/basicData.js';
import { tablesRoutes } from './routes/tables.js';
import { authRoutes } from './routes/auth.js';

const port = process.env.PORT || 4000;

const app = new Elysia()
  .use(cors({ origin: process.env.CORS_ORIGIN || '*' }))
  .onError(({ error, set }) => {
    console.error(error);
    set.status = error.status || 500;
    return { error: error.message || 'Internal server error' };
  })
  .get('/health', () => ({ ok: true }))
  .use(basicDataRoutes)
  .use(authRoutes)
  .use(tablesRoutes)
  .listen(port);

console.log(`Backend listening on http://localhost:${port}`);
