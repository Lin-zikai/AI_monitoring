import { PlusOutlined } from '@ant-design/icons';
import { App, DatePicker, Form, Image, Input, InputNumber, Modal, Segmented, Select, Space, Typography, Upload } from 'antd';
import type { UploadFile } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api';
import { FormRow } from '../../components/common';
import { useStatsToday } from '../../components/Layout';
import { validateQuietly } from '../../form';
import { useIsMobile } from '../../responsive';
import type { Bill, BillAttachmentInput, BillCategory, BillCurrency, BillInput } from '../../types';
import { readStored, writeStored } from './money';

export type BillKind = 'vpn' | 'ai';

interface BillForm { category: BillCategory; month: Dayjs; amount: number; currency: BillCurrency; title?: string; paidOn?: Dayjs | null; note?: string }

const MAX_FILES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const EXISTING = 'existing:'; // 已保存截图在列表里的 uid 前缀
const CURRENCIES = ['CNY', 'USD'] as const;
const currencyKey = (kind: BillKind) => `ledger.currency.${kind}`;
export const attachmentUrl = (id: string) => `/api/bills/attachments/${id}`;

/** File → base64（去掉 data:…;base64, 前缀） */
const toBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
  reader.onerror = () => reject(new Error(`无法读取图片“${file.name}”`));
  reader.readAsDataURL(file);
});

/**
 * 上传 / 编辑账单。kind 决定类别：VPN 固定为 vpn；AI 在 Claude Code / Codex 之间选。
 * 截图不自动上传：选中（或粘贴、拖入）的图片先留在浏览器里，保存时随表单一起以 base64 提交。
 */
export function BillModal({ kind, editing, startMonth, open, onClose, onSaved }: {
  /** 记账起始月份：更早的月份不可选 */
  startMonth?: string;
  kind: BillKind; editing: Bill | null; open: boolean; onClose: () => void; /** 保存成功；month 是这笔账单所在的月份 */ onSaved: (month: string) => void;
}) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const today = useStatsToday();
  const [form] = Form.useForm<BillForm>();
  const [saving, setSaving] = useState(false);
  const [files, setFiles] = useState<UploadFile[]>([]);
  const filesRef = useRef<UploadFile[]>([]);
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<{ src: string; revoke: boolean } | null>(null);
  const putFiles = (next: UploadFile[]) => { filesRef.current = next; setFiles(next); };

  // 打开时（首帧绘制之前）重置：新建用默认值（当前统计月份、上次用过的币种），编辑则带入原值和已有截图
  useLayoutEffect(() => {
    if (!open) return;
    form.resetFields();
    setRemovedIds([]);
    if (editing) {
      form.setFieldsValue({
        category: editing.category, month: dayjs(`${editing.month}-01`), amount: editing.amount, currency: editing.currency,
        title: editing.title ?? undefined, paidOn: editing.paidOn ? dayjs(editing.paidOn) : null, note: editing.note ?? undefined,
      });
      putFiles(editing.attachments.map((a) => ({ uid: EXISTING + a.id, name: a.filename, status: 'done', url: attachmentUrl(a.id), thumbUrl: attachmentUrl(a.id) })));
    } else {
      form.setFieldsValue({
        category: kind === 'vpn' ? 'vpn' : readStored('ledger.category.ai', ['claude-code', 'codex'] as const, 'claude-code'),
        month: dayjs(today).startOf('month'), currency: readStored(currencyKey(kind), CURRENCIES, kind === 'vpn' ? 'CNY' : 'USD'),
      });
      putFiles([]);
    }
    // 只在打开的那一刻重置：对话框开着时 meta 的定时刷新（today 变化）不能把填到一半的表单清掉
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 选择、粘贴、拖入的图片都走这里：逐张检查类型、大小和数量，不合格的给出原因 */
  const addFiles = useCallback((incoming: File[]) => {
    const next = [...filesRef.current];
    for (const file of incoming) {
      if (!ACCEPT.includes(file.type)) { message.error(`“${file.name}”不是 PNG、JPEG 或 WebP 图片`); continue; }
      if (file.size > MAX_BYTES) { message.error(`“${file.name}”有 ${(file.size / 1024 / 1024).toFixed(1)} MB，单张截图不能超过 5 MB`); continue; }
      if (next.length >= MAX_FILES) { message.error(`每笔账单最多 ${MAX_FILES} 张截图`); break; }
      // 没有 thumbUrl：antd 会读 originFileObj 生成缩略图
      next.push({ uid: `new:${Date.now()}:${Math.random().toString(36).slice(2)}`, name: file.name, status: 'done', originFileObj: file as UploadFile['originFileObj'] });
    }
    putFiles(next);
  }, [message]);

  // 对话框打开期间，Ctrl+V 粘贴剪贴板里的截图；粘贴的是文字时不拦截（照常粘进输入框）
  useEffect(() => {
    if (!open) return;
    const onPaste = (e: ClipboardEvent) => {
      const images = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
      if (images.length === 0) return;
      e.preventDefault();
      // 剪贴板里的截图一律叫 image.png：换成带时间的名字，列表里能分清
      addFiles(images.map((f, i) => new File([f], `粘贴的截图-${dayjs().format('MMDD-HHmmss')}${i ? `-${i + 1}` : ''}.${f.type.split('/')[1] ?? 'png'}`, { type: f.type })));
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [open, addFiles]);

  const closePreview = () => setPreview((p) => { if (p?.revoke) URL.revokeObjectURL(p.src); return null; });
  // 关闭即清空：表单值、待上传的图片都不留到下一次打开
  const close = () => { form.resetFields(); putFiles([]); closePreview(); onClose(); };

  const submit = async () => {
    const v = await validateQuietly(form);
    if (!v) return;
    setSaving(true);
    try {
      const fresh = files.filter((f) => !f.uid.startsWith(EXISTING) && f.originFileObj);
      const encoded: BillAttachmentInput[] = await Promise.all(fresh.map(async (f) => {
        const file = f.originFileObj as File;
        return { filename: f.name, contentType: file.type, dataBase64: await toBase64(file) };
      }));
      const month = v.month.format('YYYY-MM');
      const body: BillInput = {
        category: kind === 'vpn' ? 'vpn' : v.category, month, amount: v.amount, currency: v.currency,
        title: v.title?.trim() || null, paidOn: v.paidOn ? v.paidOn.format('YYYY-MM-DD') : null, note: v.note?.trim() || null,
      };
      if (editing) await api.patch(`/bills/${editing.id}`, { ...body, addAttachments: encoded, removeAttachmentIds: removedIds });
      else await api.post('/bills', { ...body, attachments: encoded });
      writeStored(currencyKey(kind), v.currency);
      if (kind === 'ai') writeStored('ledger.category.ai', v.category);
      message.success('已保存');
      onSaved(month);
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  const name = kind === 'vpn' ? 'VPN 账单' : 'AI 账单';
  return (
    <Modal title={editing ? `编辑 ${name}` : `上传 ${name}`} open={open} onOk={submit} okText="保存" confirmLoading={saving} onCancel={close} destroyOnHidden width={560}>
      {/* 拖到对话框任意位置都算数；用捕获阶段接管，避免上传按钮自己的 drop 处理再加一遍 */}
      <div
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDropCapture={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); e.stopPropagation(); addFiles(Array.from(e.dataTransfer.files)); }}
      >
        <Form form={form} layout="vertical" autoComplete="off">
          {kind === 'ai' && (
            <Form.Item name="category" label="工具" rules={[{ required: true, message: '请选择是哪个工具的账单' }]}>
              <Segmented block options={[{ value: 'claude-code', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
            </Form.Item>
          )}
          <FormRow>
            <Form.Item name="month" label="账单月份" rules={[{ required: true, message: '请选择月份' }]} style={{ width: 200 }}>
              <DatePicker picker="month" allowClear={false} inputReadOnly={isMobile} style={{ width: '100%' }}
                disabledDate={(d) => d.isBefore(`${startMonth ?? '2020-01'}-01`, 'month') || d.isAfter(dayjs(today).add(1, 'month'), 'month')} />
            </Form.Item>
            <Form.Item label="金额" required style={{ width: 296 }}>
              <Space.Compact style={{ display: 'flex' }}>
                <Form.Item name="amount" noStyle rules={[{ required: true, message: '请输入金额' }]}>
                  <InputNumber min={0} max={10_000_000} precision={2} inputMode="decimal" placeholder="0.00" style={{ flex: 1, minWidth: 0 }} />
                </Form.Item>
                <Form.Item name="currency" noStyle>
                  <Select aria-label="币种" style={{ width: 104, flex: 'none' }} options={[{ value: 'CNY', label: '¥ CNY' }, { value: 'USD', label: '$ USD' }]} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
          </FormRow>
          <FormRow>
            <Form.Item name="title" label="名称（可选）" style={{ width: 304 }}>
              <Input maxLength={200} placeholder={kind === 'vpn' ? '服务商 / 套餐' : '账号 / 套餐，如 Max 20x'} />
            </Form.Item>
            <Form.Item name="paidOn" label="付款日期（可选）" style={{ width: 192 }}>
              <DatePicker inputReadOnly={isMobile} style={{ width: '100%' }} />
            </Form.Item>
          </FormRow>
          <Form.Item name="note" label="备注（可选）"><Input.TextArea maxLength={2000} autoSize={{ minRows: 2, maxRows: 5 }} /></Form.Item>
          <Form.Item label={`截图（${files.length} / ${MAX_FILES}）`} style={{ marginBottom: 0 }}
            extra={isMobile ? `点击添加图片；最多 ${MAX_FILES} 张，每张不超过 5 MB` : `可直接粘贴截图（Ctrl+V），或点击 / 拖入图片；最多 ${MAX_FILES} 张，每张不超过 5 MB`}>
            <Upload
              className="ledger-upload" listType="picture-card" accept={ACCEPT.join(',')} multiple fileList={files}
              // 不自动上传，也不让组件自己维护列表：所有来源的图片统一交给 addFiles
              beforeUpload={(file) => { addFiles([file]); return Upload.LIST_IGNORE; }}
              onRemove={(f) => {
                if (f.uid.startsWith(EXISTING)) setRemovedIds((ids) => [...ids, f.uid.slice(EXISTING.length)]);
                putFiles(filesRef.current.filter((x) => x.uid !== f.uid));
              }}
              onPreview={(f) => {
                const blob = f.originFileObj as File | undefined;
                setPreview(blob ? { src: URL.createObjectURL(blob), revoke: true } : f.url ? { src: f.url, revoke: false } : null);
              }}
            >
              {files.length < MAX_FILES && (
                <button type="button" style={{ border: 0, background: 'none', color: 'inherit', cursor: 'pointer' }}>
                  <PlusOutlined />
                  <div style={{ marginTop: 8 }}>添加截图</div>
                </button>
              )}
            </Upload>
          </Form.Item>
        </Form>
        {editing && <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>移除的截图在点“保存”后才会真正删除。</Typography.Text>}
      </div>
      {preview && <Image alt="截图预览" style={{ display: 'none' }} preview={{ open: true, src: preview.src, onOpenChange: (o) => { if (!o) closePreview(); } }} />}
    </Modal>
  );
}
