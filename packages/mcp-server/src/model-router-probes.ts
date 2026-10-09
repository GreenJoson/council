/** @input 已保存的 Agent/Provider 与运行时；@output 分阶段诊断；@pos 只读临时目录探针，不读取项目、升级权限或重试写操作。 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRouterConnectionTester } from "./model-router-service.js";
import { diagnosticFailure, observedModel, type AgentProbeResult, type DiagnosticCheck } from "./model-diagnostics.js";
import type { ClaudeRuntime } from "./claude-runtime.js";
import type { CodexRuntime } from "./codex-runtime.js";
import type { OpenAICompatibleModelClient } from "./openai-compatible-model-client.js";
import type { ProviderProfile } from "./model-router-store.js";

export function createModelRouterProbe(input: {
  claude: ClaudeRuntime;
  codex: CodexRuntime;
  remote: OpenAICompatibleModelClient;
  claudeModel?: string;
  codexModel?: string;
  acp: (provider: ProviderProfile, cwd: string, model: string) => Promise<void>;
}): ModelRouterConnectionTester {
  return async (agent, provider, apiKey) => {
    const requestedModel = agent.model || (provider.protocol === "codex-cli" ? input.codexModel : input.claudeModel) || "";
    const checks: DiagnosticCheck[] = [];
    const report: AgentProbeResult = { ok: false, requestedModel, checks };
    const add = (stage: DiagnosticCheck["stage"], status: DiagnosticCheck["status"], message: string, code?: string) => {
      checks.push({ stage, status, message, ...(code ? { code } : {}) });
    };
    let stage: DiagnosticCheck["stage"] = "runtime";
    let directory: string | undefined;
    try {
      if (provider.protocol === "claude-cli" || provider.protocol === "codex-cli") {
        const runtime = provider.protocol === "claude-cli" ? input.claude : input.codex;
        const availability = await runtime.checkAvailability();
        if (!availability.available) { add("runtime", "failed", "CLI 无法启动，请检查安装与可执行文件配置。", "runtime_unavailable"); return report; }
        add("runtime", "passed", "CLI 可启动。");
        if (!availability.authenticated) { add("authentication", "failed", "CLI 未登录，请在终端完成登录。", "authentication_failed"); return report; }
        add("authentication", "passed", "CLI 报告已登录；模型调用仍会验证实际权限。");
        directory = await mkdtemp(path.join(tmpdir(), "council-model-probe-"));
        const challenge = randomUUID();
        await writeFile(path.join(directory, "council-probe.txt"), challenge, { mode: 0o600 });
        stage = "model";
        const result = await runtime.generate({ cwd: directory, model: requestedModel || undefined, permissionProfile: "read_only",
          prompt: "COUNCIL_MODEL_PROBE：仅用只读工具读取当前目录 council-probe.txt，只回复文件中的完整文本。不要修改文件、联网或读取其他目录。" });
        add("model", "passed", "所选模型已返回响应。");
        if ("model" in result) report.observedModel = observedModel(result.model);
        stage = "tools";
        if (result.content.trim() !== challenge) { add("tools", "failed", "未核对到临时文件内容，尚不能确认只读工具可用。", "tool_probe_failed"); return report; }
        add("tools", "passed", "已通过只读工具读取临时验证文件。");
      } else if (provider.protocol === "openai-compatible") {
        stage = "model";
        if (!provider.baseUrl || !apiKey) throw new Error("配置不完整");
        const result = await input.remote.complete({ baseUrl: provider.baseUrl, model: agent.model, apiKey,
          messages: [{ role: "user", content: "只回复 OK，不调用工具。" }] });
        if (!result.content || result.toolCalls.length) throw new Error("非文本响应");
        add("authentication", "passed", "当前凭据成功完成本次模型请求。");
        add("model", "passed", "所选模型已返回响应。");
        report.observedModel = result.observedModel;
        add("tools", "unverified", "本次仅测试模型响应，未验证工具调用。");
      } else {
        directory = await mkdtemp(path.join(tmpdir(), "council-model-probe-"));
        await input.acp(provider, directory, agent.model);
        add("runtime", "passed", "ACP 会话握手成功。");
        add("model", "unverified", "ACP 握手不代表模型已完成实际生成。");
        add("tools", "unverified", "本次未验证 ACP 工具调用。");
      }
      report.ok = true;
    } catch (error) {
      const failure = diagnosticFailure(error);
      add(failure.code === "authentication_failed" ? "authentication" : stage, "failed", failure.message, failure.code);
    } finally {
      add("write_permission", "unverified", "本次诊断没有写入项目；执行权限仍须以实际委派为准。");
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    return report;
  };
}
