import { App, Checkbox, DatePicker, Form, Input, Modal, Select, Switch } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useLayoutEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { FormRow } from '../../components/common';
import { useIsMobile } from '../../responsive';
import { validateQuietly } from '../../form';
import type { Credential, Filters, Meta, Server, Target } from '../../types';
import { DATA_DIR_RULES, guessHome, sourceDirName, sourceLabel, userOptions } from './shared';

interface TargetForm {
  userId: string; dataDir: string; missingOk: boolean; sources?: string[]; dirs?: Record<string, string>; sshUsername?: string; credentialId?: string; sharedAccount: boolean;
  sourceStartDate?: Dayjs | null; sourceEndDate?: Dayjs | null; enabled: boolean;
}

export type TargetModalState = { server: Server; target: Target | null } | null;

export function TargetModal({ state, credentials, users, sources, sourceInfo, onClose, onSaved }: {
  state: TargetModalState; credentials: Credential[]; users: Filters['users']; sources: string[]; sourceInfo?: Meta['sourceInfo']; onClose: () => void; onSaved: () => void;
}) {
  const [form] = Form.useForm<TargetForm>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const target = state?.target ?? null;
  const available = sources.length ? sources : ['claude-code'];
  const picked: string[] = Form.useWatch('sources', form) ?? [];

  // 打开时（首帧绘制之前）填好初值，见 ServerModal
  useLayoutEffect(() => {
    if (!state) return;
    const home = guessHome(state.server);
    const t = state.target;
    form.resetFields();
    form.setFieldsValue(t
      ? {
        userId: t.userId, dataDir: t.dataDir, sshUsername: t.sshUsername ?? undefined, credentialId: t.credentialId ?? undefined,
        sharedAccount: t.sharedAccount, missingOk: t.missingOk, sourceStartDate: t.sourceStartDate ? dayjs(t.sourceStartDate) : null,
        sourceEndDate: t.sourceEndDate ? dayjs(t.sourceEndDate) : null, enabled: t.enabled,
      }
      : {
        sources: available, dirs: Object.fromEntries(available.map((src) => [src, `${home}/${sourceDirName(src, sourceInfo)}`])),
        sharedAccount: false, missingOk: true, enabled: true,
      });
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => { form.resetFields(); onClose(); };

  const submit = async () => {
    if (!state) return;
    const v = await validateQuietly(form);
    if (!v) return;
    const common = {
      sshUsername: v.sshUsername?.trim() || null, credentialId: v.credentialId ?? null, sharedAccount: v.sharedAccount, missingOk: v.missingOk,
      sourceStartDate: v.sourceStartDate ? v.sourceStartDate.format('YYYY-MM-DD') : null, sourceEndDate: v.sourceEndDate ? v.sourceEndDate.format('YYYY-MM-DD') : null, enabled: v.enabled,
    };
    setSaving(true);
    try {
      if (target) {
        await api.patch(`/targets/${target.id}`, { ...common, dataDir: v.dataDir.trim() });
        message.success('已保存');
      } else {
        // 每个勾选的数据源各建一个采集目标；其中一个失败不影响其他
        const wanted = v.sources ?? [];
        const failed: Array<{ source: string; reason: string }> = [];
        for (const source of wanted) {
          try {
            await api.post(`/servers/${state.server.id}/targets`, { ...common, userId: v.userId, source, dataDir: (v.dirs?.[source] ?? '').trim() });
          } catch (err) { failed.push({ source, reason: errorMessage(err) }); }
        }
        if (failed.length) {
          // 已建好的数据源从表单里去掉：改正后再点“确定”只会重试失败的那几个，不会重复创建
          const created = wanted.filter((src) => !failed.some((f) => f.source === src));
          form.setFieldsValue({ sources: failed.map((f) => f.source) });
          message.error(`${created.length ? `${created.map((src) => sourceLabel(src, sourceInfo)).join('、')} 已添加；` : ''}${failed.map((f) => `${sourceLabel(f.source, sourceInfo)} 添加失败：${f.reason}`).join('；')}`);
          if (created.length) onSaved();
          return;
        }
        message.success('采集目标已添加；可先“测试目录”，再“立即采集”完成首次历史回填');
      }
      close(); onSaved();
    } catch (err) { message.error(errorMessage(err)); } finally { setSaving(false); }
  };

  return (
    <Modal title={`${target ? '编辑' : '添加'}采集目标 · ${state?.server.name ?? ''}`} open={state !== null} onOk={submit} confirmLoading={saving} onCancel={close} destroyOnHidden width={600}>
      <Form form={form} layout="vertical" autoComplete="off">
        <FormRow>
          <Form.Item name="userId" label="绑定用户" rules={[{ required: true, message: '请选择用户' }]} style={{ width: 260 }}
            extra={target ? '修改归属请使用“调整绑定”，以保留历史归属' : undefined}>
            <Select showSearch optionFilterProp="label" disabled={Boolean(target)} options={userOptions(users)} />
          </Form.Item>
          {target && <Form.Item label="数据源" style={{ width: 200 }}><Input disabled value={sourceLabel(target.source, sourceInfo)} /></Form.Item>}
        </FormRow>
        {target ? (
          <Form.Item name="dataDir" label="数据目录（服务器上的绝对路径）" rules={DATA_DIR_RULES}>
            <Input style={{ fontFamily: 'monospace' }} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="sources" label="数据源（可多选，每个数据源各建一个采集目标）" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个数据源' }]}>
              <Checkbox.Group options={available.map((src) => ({ value: src, label: sourceLabel(src, sourceInfo) }))} />
            </Form.Item>
            {available.filter((src) => picked.includes(src)).map((src) => (
              <Form.Item key={src} name={['dirs', src]} label={`${sourceLabel(src, sourceInfo)} 数据目录`} tooltip="服务器上的绝对路径；已按该 SSH 账户的家目录自动填写，采集别人的目录时请修改。" rules={DATA_DIR_RULES}>
                <Input style={{ fontFamily: 'monospace' }} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
              </Form.Item>
            ))}
          </>
        )}
        <Form.Item name="missingOk" valuePropName="checked" style={{ marginBottom: 8 }} extra="该账户还没用过这个工具时，远端不会有对应目录。勾选后这种情况显示为“未使用”，不算采集失败、不发告警。">
          <Checkbox>目录不存在时不算失败</Checkbox>
        </Form.Item>
        <Form.Item name="sharedAccount" valuePropName="checked" extra="多人共用同一账户和目录且记录无可靠身份字段时勾选：用量只能整体归属为共享账户。">
          <Checkbox>这是一个共享账户 / 共享目录</Checkbox>
        </Form.Item>
        <FormRow>
          <Form.Item name="sshUsername" label="覆盖 SSH 用户名（可选）" tooltip="无法用专用采集账户集中授权时，为该目标单独指定登录用户" style={{ width: 220 }}><Input placeholder={`默认 ${state?.server.sshUsername ?? ''}`} maxLength={32} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></Form.Item>
          <Form.Item name="credentialId" label="覆盖 SSH 凭据（可选）" style={{ width: 300 }}>
            <Select allowClear placeholder="默认使用服务器凭据" options={credentials.map((c) => ({ value: c.id, label: c.name, disabled: Boolean(c.revokedAt) }))} />
          </Form.Item>
        </FormRow>
        <FormRow>
          <Form.Item name="sourceStartDate" label="来源起始日期（可选）" tooltip="日志迁移时的来源切换边界：只入库该日期及之后的用量，避免与旧来源重复统计"><DatePicker inputReadOnly={isMobile} /></Form.Item>
          <Form.Item name="sourceEndDate" label="来源截止日期（可选）" tooltip="只入库该日期及之前的用量"><DatePicker inputReadOnly={isMobile} /></Form.Item>
        </FormRow>
        <Form.Item name="enabled" label="启用采集" valuePropName="checked"><Switch /></Form.Item>
      </Form>
    </Modal>
  );
}
