import jwt from 'jsonwebtoken';

// Verifies a "Bearer <token>" Authorization header and returns the decoded
// JWT payload, or throws a 401 error (caught by Elysia's onError in server.js).
export function requireAuth(headers) {
  const header = headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const err = new Error('Missing token');
    err.status = 401;
    throw err;
  }
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    const err = new Error('Invalid or expired token');
    err.status = 401;
    throw err;
  }
}

// Same as requireAuth, plus checks the caller's position was granted the
// AdminData right at login (accessRights is baked into the token itself -
// see routes/auth.js - so this doesn't need its own DB lookup). Used to gate
// the Firebase-import endpoints, which can rewrite or add to every table in
// the database.
export function requireAdmin(headers) {
  const payload = requireAuth(headers);
  if (!payload.accessRights?.includes('AdminData')) {
    const err = new Error('ต้องมีสิทธิ์ผู้ดูแลระบบ (admin)');
    err.status = 403;
    throw err;
  }
  return payload;
}
