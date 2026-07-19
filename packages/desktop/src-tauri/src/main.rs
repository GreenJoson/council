/**
 * @input  依赖：council_desktop_lib
 * @output 导出：Council 桌面进程入口
 * @pos    启动 Tauri 应用，不承载业务逻辑
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */
fn main() {
    council_desktop_lib::run();
}
