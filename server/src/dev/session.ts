import { SignJWT } from 'jose';
import { loadConfig } from '../config.js';
import { uuidPattern } from '../api/auth.js';
import { randomUUID } from 'node:crypto';
import { createPool } from '../db/pool.js';

if (process.env.NODE_ENV === 'production') throw new Error('This helper is for local development only');
const userId = process.argv[2];
if (!userId || !uuidPattern.test(userId)) throw new Error('Usage: npm run session -- <existing-user-uuid>');
const config = loadConfig();
if (!config.session) throw new Error('Set SESSION_JWT_SECRET before generating a development session');
const pool = createPool(config.databaseUrl);
try {
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes')`, [sessionId, userId]);
  const token = await new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId.toLowerCase())
    .setIssuer(config.session.issuer).setAudience(config.session.audience).setIssuedAt().setExpirationTime('15m')
    .sign(new TextEncoder().encode(config.session.secret));
  console.log(token);
} finally { await pool.end(); }
