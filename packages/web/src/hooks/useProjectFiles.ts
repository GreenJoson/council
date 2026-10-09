/** @input 项目文件引用 @output 文件打开上下文 @pos 文件 UI 的单向依赖边界，避免 Markdown 与弹层循环引用 */
import { createContext, useContext } from "react";
import type { ProjectFileReference } from "../data/project-files";

export const ProjectFilesContext = createContext<((reference: ProjectFileReference) => void) | null>(null);
export const useOpenProjectFile = () => useContext(ProjectFilesContext);
