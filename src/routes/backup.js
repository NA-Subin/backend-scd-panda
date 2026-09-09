import { Elysia } from 'elysia';
import path from 'node:path';
import { requireAdmin } from '../authMiddleware.js';
import { runBackup, listBackups, pruneOldBackups, deleteBackup, BACKUP_DIR } from '../backup.js';

export const backupRoutes = new Elysia()
  .get('/api/admin/backups', async ({ headers }) => {
    requireAdmin(headers);
    const backups = await listBackups();
    return { backups };
  })

  // Runs an on-demand backup in addition to the automatic 1am one - same
  // pg_dump + prune-old-files logic either way.
  .post('/api/admin/backups', async ({ headers }) => {
    requireAdmin(headers);
    const result = await runBackup();
    const removed = await pruneOldBackups();
    return { ok: true, filename: result.filename, removedOldBackups: removed };
  })

  .get('/api/admin/backups/:filename', async ({ headers, params, set }) => {
    requireAdmin(headers);
    const safeName = path.basename(params.filename);
    if (!safeName.endsWith('.sql')) {
      set.status = 400;
      return { error: 'Invalid filename' };
    }
    const file = Bun.file(path.join(BACKUP_DIR, safeName));
    if (!(await file.exists())) {
      set.status = 404;
      return { error: 'Backup not found' };
    }
    return file;
  })

  .delete('/api/admin/backups/:filename', async ({ headers, params, set }) => {
    requireAdmin(headers);
    const safeName = path.basename(params.filename);
    try {
      await deleteBackup(safeName);
    } catch {
      set.status = 404;
      return { error: 'Backup not found' };
    }
    return { ok: true };
  });
