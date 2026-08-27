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
