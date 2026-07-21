/**
 * @input  依赖：Council 模型设置 REST 协议
 * @output 导出：Agent 设置、更新输入与连接测试类型
 * @pos    设置界面和 OrchestrationRepository 共享的领域模型
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type AgentProviderKind = "claude-cli" | "codex-cli" | "openai-compatible";

export interface AgentSetting {
  id: string;
  label: string;
  kind: AgentProviderKind;
  model: string;
  baseUrl?: string;
  enabled: boolean;
  requiresApiKey: boolean;
  hasApiKey: boolean;
  updatedAt: string;
}

export interface UpdateAgentSettingInput {
  agentId: string;
  model: string;
  baseUrl?: string;
  enabled: boolean;
  apiKey?: string;
  clearApiKey?: boolean;
}

export interface AgentConnectionTest {
  ok: true;
  latencyMs: number;
}
