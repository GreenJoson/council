/** @input 已保存配置身份与仓储；@output 当前编辑项的模型列表和诊断；@pos 选择/配置变化后丢弃过期异步结果。 */
import { useEffect, useRef, useState } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type { AgentConnectionTest, ProviderModels } from "../types/model-router";
export function useModelDiagnostics(repository: OrchestrationRepository, scope: string, modelScope: string, agentId?: string, providerId?: string) {
  const [result, setResult] = useState<AgentConnectionTest>();
  const [models, setModels] = useState<ProviderModels>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<"test" | "models" | null>(null);
  const generation = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    generation.current += 1;
    setResult(undefined); setError(undefined);
    return () => { generation.current += 1; };
  }, [scope]);
  useEffect(() => { setModels(undefined); }, [modelScope]);
  const run = async (kind: "test" | "models") => {
    if (running.current || (kind === "test" ? !agentId : !providerId)) return;
    running.current = true;
    const current = ++generation.current;
    setBusy(kind); setError(undefined);
    if (kind === "test") setResult(undefined); else setModels(undefined);
    try {
      if (kind === "test") {
        const value = await repository.testAgent(agentId!);
        if (current === generation.current) setResult(value);
      } else {
        const value = await repository.listProviderModels(providerId!);
        if (current === generation.current) setModels(value);
      }
    } catch (error) {
      if (current === generation.current) setError(error instanceof Error ? error.message : "连接诊断失败");
    } finally { running.current = false; setBusy(null); }
  };
  return { result, models, error, busy, test: () => run("test"), refresh: () => run("models") };
}
