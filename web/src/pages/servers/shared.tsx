import { App, Tag, Typography } from 'antd';
import type { Rule } from 'antd/es/form';
import type { Filters, Meta, Server } from '../../types';

const { Paragraph } = Typography;

export type ModalApi = ReturnType<typeof App.useApp>['modal'];

/** 数据源的显示名与家目录下的默认目录名（后台 /meta 的 sourceInfo 优先，这里是兜底） */
export const SOURCE_META: Record<string, { label: string; dir: string }> = { 'claude-code': { label: 'Claude Code', dir: '.claude' }, codex: { label: 'Codex', dir: '.codex' } };
export const sourceLabel = (s: string, info?: Meta['sourceInfo']) => info?.[s]?.label ?? SOURCE_META[s]?.label ?? s;
export const sourceDirName = (s: string, info?: Meta['sourceInfo']) => info?.[s]?.defaultDirName ?? SOURCE_META[s]?.dir ?? `.${s}`;

/** 从自动安装登记的采集命令反推远端家目录；否则按惯例猜 /home/<用户名> */
export function guessHome(server: Server): string {
  const m = /^(\/.+)\/\.local\/share\/usage-monitor\/ccusage-collect$/.exec(server.collectCommand);
  return m ? m[1]! : server.sshUsername === 'root' ? '/root' : `/home/${server.sshUsername}`;
}

/** 用户下拉选项：同名时靠团队区分 */
export const userOptions = (users: Filters['users']) => users.map((u) => ({ value: u.id, label: u.team ? `${u.name}（${u.team}）` : u.name }));

export const DATA_DIR_RULES: Rule[] = [{ required: true, message: '请输入数据目录' }, { pattern: /^\/[A-Za-z0-9._@+\-/]*$/, message: '必须是不含空格与特殊字符的绝对路径' }];

/** 耗时的远端操作：期间显示一个不可关闭的“进行中”对话框，结束（无论成败）后关掉 */
export async function withProgressModal<T>(modal: ModalApi, title: string, content: string, run: () => Promise<T>): Promise<T> {
  const progress = modal.info({ title, content, okButtonProps: { loading: true, disabled: true }, okText: '进行中', keyboard: false, maskClosable: false });
  try {
    return await run();
  } finally {
    progress.destroy();
  }
}

export interface OnboardResult { id: string; ok: boolean; steps: Array<{ step: string; ok: boolean; message: string }> }
export const STEP_LABEL: Record<string, string> = { hostkey: '主机指纹', collector: '采集组件', targets: '采集目标', collect: '首次采集' };

/** 一步接入的逐步结果 */
export function OnboardSteps({ result, intervalHours }: { result: OnboardResult; intervalHours?: number }) {
  return (
    <div>
      {result.steps.map((st) => (
        <Paragraph key={st.step} style={{ marginBottom: 6 }}>
          <Tag color={st.ok ? 'success' : 'error'}>{STEP_LABEL[st.step] ?? st.step}</Tag><span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{st.message}</span>
        </Paragraph>
      ))}
      <Paragraph type="secondary" style={{ marginBottom: 0, marginTop: 8 }}>
        {result.ok
          ? `之后${intervalHours ? `每 ${intervalHours} 小时` : '按采集周期'}自动采集。某个工具的目录在远端不存在时会显示“未使用”，不算失败。`
          : '解决问题后，在该服务器的“更多 → 重新接入”里重试即可，不需要重新填写。'}
      </Paragraph>
    </div>
  );
}

export function showOnboardResult(modal: ModalApi, result: OnboardResult, titles: { ok: string; failed: string }, intervalHours?: number) {
  (result.ok ? modal.success : modal.warning)({ title: result.ok ? titles.ok : titles.failed, width: 600, content: <OnboardSteps result={result} intervalHours={intervalHours} /> });
}
