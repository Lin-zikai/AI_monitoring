import { withTx, type Db } from '../db/pool.js';
import { smtpPasswordAad } from '../mail/transport.js';
import { getStoredSmtp, putSetting } from '../settings.js';
import { seal, unseal } from './crypto.js';

const b64 = (b: Buffer) => b.toString('base64');

/**
 * 主密钥轮换：把所有密文（SSH 凭据、SMTP 密码）用旧密钥解开、新密钥重新加密，在同一个事务里完成。
 * 任何一条解不开都会整体回滚——要么全部换成新密钥，要么保持原样。需在三个进程都停止时执行。
 */
export async function rotateMasterKey(db: Db, oldKey: Buffer, newKey: Buffer, newVersion: number): Promise<{ credentials: number; smtp: boolean }> {
  return withTx(db, async (tx) => {
    const rows = (await tx.query<{ id: string; ciphertext: Buffer; iv: Buffer; auth_tag: Buffer }>('SELECT id, ciphertext, iv, auth_tag FROM credentials FOR UPDATE')).rows;
    for (const r of rows) {
      const aad = `credential:${r.id}`;
      const next = seal(newKey, unseal(oldKey, { ciphertext: r.ciphertext, iv: r.iv, authTag: r.auth_tag }, aad), aad);
      await tx.query('UPDATE credentials SET ciphertext = $2, iv = $3, auth_tag = $4, key_version = $5 WHERE id = $1', [r.id, next.ciphertext, next.iv, next.authTag, newVersion]);
    }
    const smtp = await getStoredSmtp(tx);
    if (smtp?.passwordSealed) {
      const p = smtp.passwordSealed;
      const plain = unseal(oldKey, { ciphertext: Buffer.from(p.ciphertext, 'base64'), iv: Buffer.from(p.iv, 'base64'), authTag: Buffer.from(p.authTag, 'base64') }, smtpPasswordAad());
      const next = seal(newKey, plain, smtpPasswordAad());
      await putSetting(tx, 'smtp', { ...smtp, passwordSealed: { ciphertext: b64(next.ciphertext), iv: b64(next.iv), authTag: b64(next.authTag) } });
    }
    return { credentials: rows.length, smtp: Boolean(smtp?.passwordSealed) };
  });
}
