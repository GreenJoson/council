/**
 * @input  依赖：Tauri 构建配置
 * @output 导出：桌面资源与权限构建脚本
 * @pos    Cargo 编译 Council 桌面应用前的标准入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
fn main() {
    tauri_build::build();
}
