// 与后台 API（server/src/api/routes）返回字段一一对应。
// 注意：Postgres 的 sum(bigint) 为 numeric，经 node-pg 以字符串返回，因此聚合 Token 统一按 NumLike 处理。

export type NumLike = number | string | null;
export type Role = 'admin' | 'user';

export interface AuthUser { id: string; email: string; name: string; role: Role }

export interface Meta {
  timezone: string;
  intervalHours: number;
  today: string;
  lastSuccessAt: string | null;
  oldestSuccessAt: string | null;
  nextCollectionAt: string;
  targets: number;
  staleTargets: number;
  incomplete: boolean;
  sources?: string[];
}

export interface Filters {
  users: Array<{ id: string; name: string; team: string | null }>;
  servers: Array<{ id: string; name: string }>;
  models: string[];
  teams: string[];
}

export type Dimension = 'date' | 'user' | 'server' | 'model' | 'source' | 'team';

export interface Measures {
  totalTokens: NumLike;
  inputTokens: NumLike;
  outputTokens: NumLike;
  cacheCreationTokens: NumLike;
  cacheReadTokens: NumLike;
  costUsd: number | null;
}

export interface UsageRow extends Measures { key0: string; label0: string; key1?: string; label1?: string; flagged: boolean }
export interface UsageResponse { from: string; to: string; groupBy: Dimension[]; rows: UsageRow[] }

export interface Totals { todayTokens: NumLike; todayCost: number | null; monthTokens: NumLike; monthCost: number | null; activeUsersToday?: number; activeUsersMonth?: number }

export interface Issue {
  targetId: string; serverName: string; dataDir?: string; userName?: string; lastStatus: string | null;
  lastErrorCode?: string | null; lastError?: string | null; lastSuccessAt: string | null; consecutiveFailures?: number;
}

export interface Overview {
  freshness: Meta;
  month: string;
  totals: Totals;
  trend: { from: string; to: string; rows: Array<{ date: string; model: string; totalTokens: NumLike; costUsd: number | null }> };
  models: Array<{ model: string; totalTokens: NumLike; costUsd: number | null }>;
  todayRanking: Array<{ userId: string; name: string; team: string | null; claudeTokens: NumLike; claudeCost: number | null; codexTokens: NumLike; codexCost: number | null; totalTokens: NumLike; totalCost: number | null }>;
  ranking: Array<{ userId: string; name: string; team: string | null; monthlyBudgetUsd: number | null; monthTokens: NumLike; monthCost: number | null; todayTokens: NumLike }>;
  issues: Issue[];
}

export interface UserListItem {
  id: string; name: string; email: string | null; role: Role; team: string | null; isActive: boolean; monthlyBudgetUsd: number | null; canLogin: boolean;
  todayTokens: NumLike; todayCost: number; monthTokens: NumLike; monthCost: number; monthAlerts: number; targetCount: number; failingTargets: number;
}
export interface UserListResponse { today: string; month: string; users: UserListItem[] }

export interface UserAlert {
  id: string; ruleName: string | null; metric: Metric | null; periodType: Period | null; periodKey: string | null; tier: number | null;
  observedValue: number | null; thresholdValue: number | null; incomplete: boolean; createdAt: string; emailStatus: EmailStatus | null; emailNote: string | null;
}

export interface UserSource {
  targetId: string; serverId: string; serverName: string; source: string; dataDir: string; sharedAccount: boolean; enabled: boolean;
  lastSuccessAt: string | null; lastStatus: string | null; stale: boolean; totalTokens: NumLike; costUsd: number | null; flagged: boolean;
}

export interface UserDetail {
  user?: { id: string; name: string; email: string | null; team: string | null; role: Role; monthlyBudgetUsd: number | null; isActive: boolean };
  freshness: Meta;
  month: string;
  totals: Totals;
  trend: { from: string; to: string; rows: Array<Measures & { date: string; serverId: string; serverName: string }> };
  models: Array<Measures & { model: string }>;
  sources: UserSource[];
  alerts: UserAlert[];
}

export interface Credential {
  id: string; name: string; kind: string; publicFingerprint: string; keyType: string;
  createdAt: string; rotatedAt: string | null; revokedAt: string | null; usedBy: number;
}

export interface Target {
  id: string; serverId: string; userId: string; userName: string; source: string; dataDir: string;
  sshUsername: string | null; credentialId: string | null; sharedAccount: boolean; sourceStartDate: string | null; sourceEndDate: string | null;
  enabled: boolean; initializedAt: string | null; lastAttemptAt: string | null; lastSuccessAt: string | null; lastStatus: string | null;
  lastErrorCode: string | null; lastError: string | null; consecutiveFailures: number; missingOk: boolean; dirHint: string | null; collecting: boolean; hasFlaggedData: boolean;
}

export interface Server {
  id: string; name: string; host: string; port: number; sshUsername: string; credentialId: string | null; credentialName: string | null;
  credentialRevoked: boolean; hostKeyFingerprint: string | null; collectCommand: string; defaultUserId: string | null; enabled: boolean;
  lastConnectOkAt: string | null; lastError: string | null; targets: Target[];
}

export interface Anomaly { date: string; kind: 'missing' | 'decrease'; previousTotal: number; newTotal: number }

export interface Run {
  id: string; batchId: string | null; targetId: string; serverName: string; dataDir: string; userName: string; trigger: string; status: string;
  attempt: number; rangeSince: string | null; rangeUntil: string | null; startedAt: string | null; finishedAt: string | null;
  errorCode: string | null; errorMessage: string | null; rowsWritten: number | null; anomalies: Anomaly[]; ccusageVersion: string | null; createdAt: string;
}

export type Metric = 'tokens' | 'cost' | 'budget_pct';
export type Period = 'daily' | 'monthly';
export type ScopeType = 'global' | 'team' | 'user';
export type EmailStatus = 'pending' | 'sending' | 'sent' | 'failed';

export interface AlertRuleInput {
  name: string; metric: Metric; period: Period; tiers: number[]; scopeType: ScopeType; scopeUserId: string | null; scopeTeam: string | null;
  source: string | null; notifyAdmins: boolean; extraEmails: string[]; enabled: boolean;
}
export interface AlertRule extends AlertRuleInput { id: string; scopeUserName: string | null; createdAt: string; updatedAt: string }

export interface AlertEvent {
  id: string; kind: 'usage' | 'collection_failure' | 'account_limit'; ruleName: string | null; userId: string | null; userName: string | null; metric: Metric | null;
  periodType: Period | null; periodKey: string | null; tier: number | null; observedValue: number | null; thresholdValue: number | null;
  dataAsOf: string | null; incomplete: boolean; emailNote: string | null; createdAt: string; serverName: string | null; dataDir: string | null;
  outboxId: string | null; emailStatus: EmailStatus | null; emailAttempts: number | null; emailSentAt: string | null; emailError: string | null; emailTo: string[] | null;
}

export interface GeneralSettings {
  timezone: string; collectIntervalHours: number; lookbackDays: number; reconcileDays: number; backfillDays: number;
  backfillAlerts: boolean; failureAlertThreshold: number; retentionDays: number;
}

export interface SmtpSettings { configured: boolean; envFallback?: boolean; host?: string; port?: number; secure?: boolean; username?: string; from?: string; hasPassword?: boolean }

export interface AuditLog { id: number; actorEmail: string | null; action: string; entityType: string; entityId: string | null; detail: Record<string, unknown>; ip: string | null; createdAt: string }
