import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Sealed { ciphertext: Buffer; iv: Buffer; authTag: Buffer }

/** AES-256-GCM。aad 绑定用途（如凭据 ID），防止密文被挪到别的记录上解密。 */
export function seal(masterKey: Buffer, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function unseal(masterKey: Buffer, sealed: Sealed, aad: string): string {
  const decipher = createDecipheriv('aes-256-gcm', masterKey, sealed.iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(sealed.authTag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
}
