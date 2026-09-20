import { FolderOpenOutlined } from '@ant-design/icons';
import { Alert, App, Button, Input, Typography } from 'antd';
import { useRef, useState, type DragEvent } from 'react';
import { useIsMobile } from '../../responsive';

const MAX_KEY_FILE_BYTES = 20_000;

/** 私钥是否带口令保护（只看明文头部，不涉及密钥内容）。 */
function isEncryptedKey(text: string | undefined): boolean {
  if (!text) return false;
  if (/Proc-Type:\s*4,ENCRYPTED|BEGIN ENCRYPTED PRIVATE KEY/.test(text)) return true; // 传统 PEM / PKCS#8
  const m = /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END/.exec(text);
  if (!m) return false;
  try {
    // openssh-key-v1：magic(15 字节) + string ciphername；未加密时为 "none"
    const head = atob(m[1]!.replace(/\s+/g, '').slice(0, 64));
    const len = head.charCodeAt(18);
    return head.slice(19, 19 + len) !== 'none';
  } catch {
    return false;
  }
}

export const PRIVATE_KEY_RULES = [{ required: true, min: 50, message: '请粘贴完整的私钥，或拖入私钥文件' }];

/** 私钥带口令保护时，口令必填（表单里私钥字段名须为 privateKey） */
export const passphraseRules = [({ getFieldValue }: { getFieldValue: (name: string) => unknown }) => ({
  validator: async (_: unknown, value: string | undefined) => {
    if (isEncryptedKey(getFieldValue('privateKey') as string | undefined) && !value) throw new Error('这把私钥有口令保护，请填写口令');
  },
})];

/** 私钥输入：可直接粘贴，也可把密钥文件拖进来或点按钮选择。文件只在浏览器内读取成文本，不会单独上传。 */
export function PrivateKeyInput({ value, onChange, onFileName }: { value?: string; onChange?: (v: string) => void; onFileName?: (name: string) => void }) {
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const { message } = App.useApp();
  // 触屏没有拖放：提示语改成“点下方按钮选文件”，按钮用正常尺寸（40px）方便点按；粘贴照常可用
  const isMobile = useIsMobile();

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_KEY_FILE_BYTES) return void message.error('文件过大，不像是 SSH 私钥');
    const text = (await file.text()).replace(/\r\n/g, '\n');
    if (/^(ssh-|ecdsa-|sk-)\S+ AAAA/.test(text.trim())) return void message.error(`“${file.name}”是公钥文件，请选择不带 .pub 后缀的私钥文件`);
    if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return void message.error(`“${file.name}”不是 OpenSSH / PEM 格式的私钥`);
    onChange?.(text);
    onFileName?.(file.name);
    message.success(`已读取 ${file.name}`);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault(); // 否则浏览器会直接打开被拖入的文件
    setDragging(false);
    void loadFile(e.dataTransfer.files[0]);
  };

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <Input.TextArea
        value={value} onChange={(e) => onChange?.(e.target.value)} rows={isMobile ? 6 : 8} spellCheck={false} autoComplete="off" autoCapitalize="none" autoCorrect="off"
        placeholder={isMobile ? '在此粘贴私钥内容，或点下方“选择文件”\n-----BEGIN OPENSSH PRIVATE KEY-----' : '在此粘贴私钥内容，或把私钥文件（如 id_ed25519）拖到这里\n-----BEGIN OPENSSH PRIVATE KEY-----'}
        style={{ fontFamily: 'monospace', fontSize: 12, ...(dragging ? { borderColor: '#2a78d6', borderStyle: 'dashed' } : {}) }}
      />
      {dragging && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(42,120,214,0.08)', borderRadius: 6, pointerEvents: 'none', color: '#2a78d6', fontWeight: 500 }}>
          松开以读取私钥文件
        </div>
      )}
      {isEncryptedKey(value) && (
        <Alert type="warning" showIcon style={{ marginTop: 8 }} title="这把私钥有口令保护：请在下方“私钥口令”中填写口令，否则无法解析。平台采集是无人值守的，建议为采集单独生成一把不带口令的专用密钥。" />
      )}
      <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <Button size={isMobile ? 'middle' : 'small'} icon={<FolderOpenOutlined />} onClick={() => picker.current?.click()}>选择文件</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>文件只在浏览器内读取，随表单一起提交</Typography.Text>
        <input ref={picker} type="file" style={{ display: 'none' }} onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
    </div>
  );
}
