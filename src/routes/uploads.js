import { Elysia } from 'elysia';
import { randomUUID } from 'crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';
import { requireAuth } from '../authMiddleware.js';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'panda');
await mkdir(UPLOAD_DIR, { recursive: true });

export const uploadRoutes = new Elysia()
  // GET below stays public - uploaded images are rendered via plain <img src>
  // tags all over the app, which can't attach an Authorization header.
  .post('/panda/uploads', async ({ body, request, headers, set }) => {
    requireAuth(headers);

    const file = body?.pic;
    if (!file || typeof file === 'string') {
      set.status = 400;
      return { error: 'No picture file in request.' };
    }

    const ext = path.extname(file.name || '') || '.png';
    const filename = `upfile_${randomUUID()}${ext}`;
    await Bun.write(path.join(UPLOAD_DIR, filename), await file.arrayBuffer());

    await pool.query(
      `INSERT INTO panda_img (uuid, f_name, f_size, f_type, f_path, f_status, f_etc, f_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), file.name, file.size, file.type, `panda/${filename}`, 1, '-', new Date()]
    );

    const origin = new URL(request.url).origin;
    return {
      file_name: file.name,
      file_size: file.size,
      file_path: `${origin}/panda/${filename}`,
    };
  })
  .get('/panda/:filename', async ({ params, set }) => {
    const safeName = path.basename(params.filename);
    const file = Bun.file(path.join(UPLOAD_DIR, safeName));
    if (!(await file.exists())) {
      set.status = 404;
      return { error: 'File not found' };
    }
    return file;
  });
