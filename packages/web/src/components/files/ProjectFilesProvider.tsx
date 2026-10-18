/**
 * @input  依赖：文件预览仓储（预览、在浏览器中打开）、当前项目身份、只读预览弹层
 * @output 导出：统一文件打开上下文与 ProjectFilesProvider
 * @pos    讨论/决策链接与架构附件共用一个弹层；切换项目和关闭时丢弃旧请求结果
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { loadProjectFilePreview, openProjectFileInBrowser, type ProjectFilePreview, type ProjectFileReference } from "../../data/project-files";
import { getErrorMessage } from "../../data/error-message";
import { ProjectFileDialog } from "./ProjectFileDialog";
import { ProjectFilesContext } from "../../hooks/useProjectFiles";

export function ProjectFilesProvider({ children, projectKey }: { children: ReactNode; projectKey: string }) {
  const [reference, setReference] = useState<ProjectFileReference | null>(null);
  const [preview, setPreview] = useState<ProjectFilePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const close = useCallback(() => { sequence.current++; setReference(null); setPreview(null); setError(null); }, []);
  useEffect(() => { close(); return () => { sequence.current++; }; }, [projectKey, close]);
  const open = useCallback((next: ProjectFileReference) => {
    const current = ++sequence.current;
    setReference(next); setPreview(null); setError(null);
    void loadProjectFilePreview(next).then((result) => {
      if (sequence.current === current) setPreview(result);
    }).catch((failure: unknown) => {
      if (sequence.current === current) setError(getErrorMessage(failure));
    });
  }, []);
  return <ProjectFilesContext.Provider value={open}>
    {children}
    {reference ? <ProjectFileDialog reference={reference} preview={preview} error={error} onClose={close} onRetry={() => open(reference)} onOpenInBrowser={() => openProjectFileInBrowser(reference)} /> : null}
  </ProjectFilesContext.Provider>;
}
