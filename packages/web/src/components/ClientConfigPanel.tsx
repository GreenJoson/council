/**
 * @input  依赖：界面语言上下文、OrchestrationRepository 的客户端接入三方法（list/apply/restore）
 * @output 导出：ClientConfigPanel「客户端接入」面板（Claude / Codex 两张卡：状态徽标、目标路径、写入/重新写入/还原）
 * @pos    ModelRouterDialog 右侧工作台的一个分区；只展示与触发，写入/漂移/还原规则全部在服务端
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { FileCode2, FolderTree, LoaderCircle, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { OrchestrationRepository } from "../data/orchestration-repository";
import type {
  ClientConfigClient,
  ClientConfigState,
  ClientConfigStatus,
} from "../data/client-config-api";

export interface ClientConfigPanelProps {
  repository: OrchestrationRepository;
}

type BusyAction = "apply" | "force" | "restore";

const CLIENT_LABELS: Record<ClientConfigClient, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const STATE_LABELS: Record<ClientConfigState, string> = {
  not_applied: "未写入",
  applied: "已写入",
  drifted: "已漂移",
  missing: "文件丢失",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "客户端接入操作失败";
}

function ClientConfigCard({
  status,
  busy,
  error,
  onApply,
  onRestore,
}: {
  status: ClientConfigStatus;
  busy: BusyAction | null;
  error: string | null;
  onApply: (force: boolean) => void;
  onRestore: () => void;
}) {
  const { t, locale } = useI18n();
  const label = CLIENT_LABELS[status.client];
  const disabled = busy !== null;
  // 漂移时普通写入会被服务端 409 拒绝，只提供显式覆盖入口
  const drifted = status.state === "drifted";
  return (
    <article className="client-config-card" aria-label={label} data-client={status.client}>
      <header className="client-config-card-head">
        <strong>{label}</strong>
        <span className={`client-config-badge is-${status.state}`} data-state={status.state}>
          {t(STATE_LABELS[status.state])}
        </span>
      </header>
      <dl className="client-config-paths">
        <div>
          <dt><FileCode2 size={13} />{t("配置文件")}</dt>
          <dd>{status.configFile}</dd>
        </div>
        <div>
          <dt><FolderTree size={13} />{t("Skill 目录")}</dt>
          <dd>{status.skillsDir}</dd>
        </div>
      </dl>
      {status.appliedAt ? (
        <p className="client-config-meta">
          {t("上次写入：{time}", { time: new Date(status.appliedAt).toLocaleString(locale) })}
        </p>
      ) : null}
      {status.detail ? <p className="client-config-detail">{status.detail}</p> : null}
      {status.notice ? <p className="client-config-notice">{status.notice}</p> : null}
      {error ? <p className="client-config-error" role="alert">{error}</p> : null}
      <footer className="client-config-actions">
        {drifted ? (
          <button className="secondary-button" type="button" disabled={disabled} onClick={() => onApply(true)}>
            {busy === "force" ? <LoaderCircle className="spinner" size={14} /> : <Upload size={14} />}
            {t("重新写入（覆盖漂移）")}
          </button>
        ) : (
          <button className="primary-button" type="button" disabled={disabled} onClick={() => onApply(false)}>
            {busy === "apply" ? <LoaderCircle className="spinner" size={14} /> : <Upload size={14} />}
            {t("写入")}
          </button>
        )}
        {status.state !== "not_applied" ? (
          <button className="secondary-button" type="button" disabled={disabled} onClick={onRestore}>
            {busy === "restore" ? <LoaderCircle className="spinner" size={14} /> : <RotateCcw size={14} />}
            {t("还原")}
          </button>
        ) : null}
      </footer>
    </article>
  );
}

export function ClientConfigPanel({ repository }: ClientConfigPanelProps) {
  const { t } = useI18n();
  const [clients, setClients] = useState<ClientConfigStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Partial<Record<ClientConfigClient, BusyAction>>>({});
  const [errors, setErrors] = useState<Partial<Record<ClientConfigClient, string>>>({});

  const load = useCallback(async () => {
    try {
      setClients(await repository.listClientConfigs());
      setLoadError(null);
    } catch (error) {
      setLoadError(errorText(error));
    }
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(client: ClientConfigClient, action: BusyAction): Promise<void> {
    setBusy((current) => ({ ...current, [client]: action }));
    setErrors((current) => ({ ...current, [client]: undefined }));
    try {
      const next = action === "restore"
        ? await repository.restoreClientConfig(client)
        : await repository.applyClientConfig(client, { force: action === "force" });
      setClients((current) => current?.map((item) => (item.client === client ? next : item)) ?? [next]);
    } catch (error) {
      setErrors((current) => ({ ...current, [client]: errorText(error) }));
      // 失败多半意味着磁盘状态已变（如刚漂移），刷新一次让徽标与按钮跟上
      void load();
    } finally {
      setBusy((current) => ({ ...current, [client]: undefined }));
    }
  }

  return (
    <section className="client-config-panel" aria-label={t("客户端接入")}>
      <header className="client-config-intro">
        <strong>{t("客户端接入")}</strong>
        <p>
          {t("把 Council MCP 注册与 Council Skill 写入本机 Claude Code / Codex 配置。写入前自动备份原文件，可随时还原；只改 Council 自己的片段。")}
        </p>
      </header>
      {loadError ? <p className="client-config-error" role="alert">{loadError}</p> : null}
      {clients ? (
        <div className="client-config-cards">
          {clients.map((status) => (
            <ClientConfigCard
              key={status.client}
              status={status}
              busy={busy[status.client] ?? null}
              error={errors[status.client] ?? null}
              onApply={(force) => void run(status.client, force ? "force" : "apply")}
              onRestore={() => void run(status.client, "restore")}
            />
          ))}
        </div>
      ) : loadError ? null : (
        <div className="settings-loading"><LoaderCircle className="spinner" size={20} />{t("正在读取客户端接入状态…")}</div>
      )}
    </section>
  );
}
