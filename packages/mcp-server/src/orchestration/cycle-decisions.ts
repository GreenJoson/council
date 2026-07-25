/**
 * @input  依赖：CouncilDatabase 的议题/消息读取与 Actor 决策写入
 * @output 导出：把最终 synthesis 正文原样落成 proposed 决策的写入器
 * @pos    收敛结论与决策记录之间唯一的搬运处；正文必须逐字一致，接受与否只能由用户定
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { stripProtocolTrailers } from "council-orchestrator";
import type { CouncilDatabase } from "../database.js";
import type { CycleDecisionWriter } from "./cycle-driver.js";

/**
 * 用最终 synthesis 消息生成 proposed 决策。
 *
 * 正文取消息原文（只去掉协议尾块），不做摘要也不重排——决策与 synthesis
 * 逐字一致是这一步存在的全部意义；一旦允许改写，"决策写的是不是大家谈成的
 * 那个"就再也无法从库里验证。
 *
 * `alternatives` 留空同理：被否决的方案已经按阶段指令写在 synthesis 正文里，
 * 从自由格式 Markdown 里猜哪几段是替代方案只会静默丢内容。
 */
export function createCycleDecisionWriter(
  database: CouncilDatabase,
): CycleDecisionWriter {
  return {
    recordProposedDecision: (input) => {
      const synthesis = database.getMessage(input.synthesisMessageId);
      if (synthesis.topicId !== input.topicId) {
        throw new Error("收敛结论消息不属于该议题。");
      }
      const body = stripProtocolTrailers(synthesis.content);
      if (!body) {
        throw new Error("收敛结论正文为空，拒绝写入决策。");
      }
      const topic = database.getTopic(input.topicId);
      const decision = database.createDecisionAsActor({
        topicId: input.topicId,
        title: topic.title,
        decision: body,
        rationale:
          `圆桌讨论 ${input.cycleId} 收敛产出，正文取自 synthesis 消息 ${input.synthesisMessageId}。`,
        alternatives: [],
        // 只能是 proposed：接受与否是用户的判断，数据库层也会拒绝非人类写 accepted。
        status: "proposed",
        actorId: synthesis.actorId,
      });
      return Promise.resolve({ id: decision.id });
    },
  };
}
