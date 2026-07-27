/**
 * @input  依赖：AgentDefinitionEditor、目录候选模型列表
 * @output 导出：模型 ID 输入框把目录候选渲染成 datalist 的回归测试
 * @pos    防止候选模型退回成纯手填，也防止空候选时留下空的 list 引用
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AgentDefinitionEditor,
  type AgentDefinitionDraft,
} from "../src/components/ModelRouterEditor";
import type { ProviderProfile } from "../src/types/model-router";

const MOCK_TIME = "2026-01-01T00:00:00.000Z";

const PROVIDER: ProviderProfile = {
  id: "provider-kimi-code",
  slug: "kimi-code",
  displayName: "Kimi Code",
  protocol: "acp",
  requiresApiKey: false,
  hasApiKey: false,
  brandAssetId: "brand-kimi",
  runtimeDefinitionId: "kimi-code",
  status: "active",
  createdAt: MOCK_TIME,
  updatedAt: MOCK_TIME,
};

const DRAFT: AgentDefinitionDraft = {
  displayName: "Kimi",
  slug: "kimi-code",
  model: "",
  mentionAlias: "kimi",
  enabled: true,
};

function renderEditor(modelCandidates: readonly string[]): string {
  return renderToStaticMarkup(
    <AgentDefinitionEditor
      provider={PROVIDER}
      modelCandidates={modelCandidates}
      draft={DRAFT}
      busyAction={null}
      isAdding
      isDirty={false}
      identityLocked={false}
      removable={false}
      removeConfirming={false}
      onDraftChange={() => {}}
      onSave={() => {}}
      onTest={() => {}}
      onCancel={() => {}}
      onRequestRemove={() => {}}
      onCancelRemove={() => {}}
      onRemove={() => {}}
    />,
  );
}

describe("模型 ID 候选渲染", () => {
  it("目录给出候选时把它们渲染成 datalist 并挂到输入框上", () => {
    const markup = renderEditor(["kimi-code/k3", "kimi-code/k3-256k"]);

    expect(markup).toContain('list="agent-model-candidates-provider-kimi-code"');
    expect(markup).toContain('id="agent-model-candidates-provider-kimi-code"');
    expect(markup).toContain('value="kimi-code/k3"');
    expect(markup).toContain('value="kimi-code/k3-256k"');
  });

  /*
   * 候选表为空时必须连 list 属性一起省掉：指向一个不存在的 datalist
   * 在浏览器里不会报错，只会让输入框看起来"有下拉但永远是空的"。
   */
  it("目录没有候选时不留下空的 datalist 引用", () => {
    const markup = renderEditor([]);

    expect(markup).not.toContain("datalist");
    expect(markup).not.toContain("list=");
  });

  /*
   * 候选是提示不是白名单：用户填目录里没有的模型，输入框照样接受。
   * 真实可用模型随会员档位和 CLI 版本变化，封成白名单等于当天挡人。
   */
  it("候选之外的模型 ID 仍然能填进输入框", () => {
    const markup = renderToStaticMarkup(
      <AgentDefinitionEditor
        provider={PROVIDER}
        modelCandidates={["kimi-code/k3"]}
        draft={{ ...DRAFT, model: "kimi-code/未来还没上线的模型" }}
        busyAction={null}
        isAdding
        isDirty={false}
        identityLocked={false}
        removable={false}
        removeConfirming={false}
        onDraftChange={() => {}}
        onSave={() => {}}
        onTest={() => {}}
        onCancel={() => {}}
        onRequestRemove={() => {}}
        onCancelRemove={() => {}}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain('value="kimi-code/未来还没上线的模型"');
  });
});
