import { SignJWT } from 'jose';
import { loadConfig } from '../config.js';
import { uuidPattern } from '../api/auth.js';

if (process.env.NODE_ENV === 'production') throw new Error('This helper is for local development only');
const userId = process.argv[2];
if (!userId || !uuidPattern.test(userId)) throw new Error('Usage: npm run session -- <existing-user-uuid>');
const config = loadConfig();
if (!config.session) throw new Error('Set SESSION_JWT_SECRET before generating a development session');
const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId.toLowerCase())
  .setIssuer(config.session.issuer).setAudience(config.session.audience).setIssuedAt().setExpirationTime('15m')
  .sign(new TextEncoder().encode(config.session.secret));
console.log(token);
