/** @input 显式注入的编排仓储；@output 执行详情共享访问边界；@pos 避免在任务卡中创建第二份仓储。 */
import { createContext, useContext } from "react";
import type { OrchestrationRepository } from "../data/orchestration-repository";

export const ExecutionRepositoryContext = createContext<OrchestrationRepository | null>(null);
export const useExecutionRepository = () => useContext(ExecutionRepositoryContext);
