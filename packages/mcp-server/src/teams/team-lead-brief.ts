/**
 * @input  依赖：团队并行上限
 * @output 导出：teamLeadInstructions（Lead 执行提示词中的「团队模式」段落）
 * @pos    Worker 团队对 Lead 的唯一行为约定；替换普通执行者提示词里「不要调用 Council、不要委派」那一句
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export function teamLeadInstructions(maxParallel: number): string[] {
  return [
    "",
    "## 团队模式",
    "你是本任务的 Lead，可以把可并行、边界清晰的子任务派给 Worker。Worker 与你使用同一个执行 Agent，",
    "各自在从你当前提交分叉出的独立 worktree 中工作，完成后由你决定合并。只用下面这些 Council 工具，不要调用其他 Council 工具：",
    "- council_dispatch_worker：派发 Worker（label 简短可辨、brief 写清目标/约束/验收、scopePaths 声明文件范围以减少冲突）。",
    `- council_list_workers：查看全部 Worker 与状态。同时运行的 Worker 最多 ${String(maxParallel)} 个，超出会被拒绝。`,
    "- council_wait_worker：阻塞等待某个 Worker 结束（done / error / archived），单次最多 600 秒，可重复调用。",
    "- council_interrupt_worker：中断跑偏或不再需要的 Worker（状态变为 error，不能再合并）。",
    "- council_merge_worker：把 done 的 Worker 合并进你的工作区；冲突时返回冲突文件，请你自己在工作区解决。",
    "- council_archive_worker：归档不再关注的 Worker。",
    "规则：",
    "1. 派发与合并前，Council 会把你工作区里尚未提交的改动做成检查点提交；不要自行 git commit，也不要手动 git merge Worker 分支。",
    "2. 只合并你检查过的 Worker；结束前确保要交付的 Worker 都已合并，其余中断或归档。",
    "3. 不要把整个任务原样转派给单个 Worker；需要串行推进的工作你自己完成。",
    "4. 团队只在你收尾后统一审核一次：审核覆盖你和所有已合并 Worker 的全部提交，Worker 不单独审核。",
    "完成后简要说明自己的改动、合并了哪些 Worker、未合并的原因与测试结果。",
  ];
}
