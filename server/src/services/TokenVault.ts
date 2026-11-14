import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class TokenVault {
  private readonly key: Buffer;

  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    if (this.key.length !== 32 || this.key.toString('base64') !== encodedKey) throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }

  encrypt(token: string, connectionId: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(connectionId));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
  }

  decrypt(value: string, connectionId: string): string {
    const [version, nonce, tag, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !tag || !ciphertext || extra !== undefined) throw new Error('Invalid encrypted token');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64'));
    decipher.setAAD(Buffer.from(connectionId));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  }
}
