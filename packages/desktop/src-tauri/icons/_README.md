# icons - Council 桌面品牌资源

> ⚠️ 一旦本文件夹有所变化，请更新本文件

| 文件名 | 地位 | 功能 |
|---|---|---|
| `source/council-icon.svg` | 正本 | 可编辑矢量源（1024×1024），其余图片都由它生成 |
| `app-icon.png` | 中间产物 | 源 SVG 渲染出的 1024 透明底 PNG，`tauri icon` 的输入 |
| `icon.icns` | macOS | 写入应用包的图标资源 |
| `icon.ico` | Windows | Windows 桌面图标资源 |
| `icon.png` | 通用 | 512 像素 PNG 图标 |
| `32x32.png` | 小图 | 小尺寸桌面图标 |
| `64x64.png` | 小图 | 中低分辨率桌面图标 |
| `128x128.png` | 标准 | 标准桌面图标 |
| `128x128@2x.png` | 高分屏 | 高分辨率桌面图标 |

## 设计说明

三席位 + 三段弧 + 共识星：三个实心圆是围坐的 Agent，三段弧是它们之间的议事环，中心四角星是收敛出的共识。
桌面图标用深蓝底板（navy 渐变 + 中心光晕）、亮蓝渐变符号、白色共识星，在 Dock 上与浅色界面形成对比；
符号几何用 32 单位坐标，与 Web 端 `BrandLogo`（`packages/web/src/components/presentation.tsx`）和
`packages/web/public/favicon.svg` 共用同一组数值（Web 端按主题变量着色），改动时三处同步。

## 重新生成

在仓库根目录执行（macOS，需要已安装 Google Chrome；`qlmanage` 会把透明底填成白色，不可用）：

```sh
# 1. SVG → 1024 透明底 PNG
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --hide-scrollbars --default-background-color=00000000 --force-device-scale-factor=1 \
  --window-size=1024,1024 --screenshot="$PWD/packages/desktop/src-tauri/icons/app-icon.png" \
  "file://$PWD/packages/desktop/src-tauri/icons/source/council-icon.svg"

# 2. 生成全套平台图标到临时目录，只拷回桌面端用到的 7 个文件
cd packages/desktop
npx tauri icon src-tauri/icons/app-icon.png -o /tmp/council-icons
cp /tmp/council-icons/{32x32,64x64,128x128,128x128@2x,icon}.png \
   /tmp/council-icons/icon.{icns,ico} src-tauri/icons/
```

`tauri icon` 还会产出 `Square*Logo.png`、`StoreLogo.png`、`android/`、`ios/`，本项目只发桌面端，不入库。

## 候选方案

设计候选与预览图保留在本地 `concepts/`（已被 `.gitignore` 忽略），不纳入仓库或桌面应用构建。
