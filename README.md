# 机械控制系统 (Mechanical Control System)

基于Tauri + Rust + Android的机械设备蓝牙控制应用

## 功能特性

- 🔗 蓝牙连接与通信
- 🎮 实时机械设备控制
- 📱 跨平台支持（Windows、Android）
- ⚡ 高性能Rust后端
- 🎨 响应式Web界面

## 系统架构

- **前端**: HTML + CSS + JavaScript (Vanilla)
- **桌面**: Tauri (跨平台)
- **移动**: Android (Tauri + Rust)
- **后端**: Rust 蓝牙驱动

## 开发环境设置

### 推荐IDE

- [VS Code](https://code.visualstudio.com/)
- [Tauri插件](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### 依赖要求

- Rust 1.70+
- Node.js 18+
- Android SDK (Android编译)

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式
npm run tauri dev

# 构建
npm run tauri build

# Android构建
npm run tauri android build
```

## 项目结构

```
.
├── src/                  # Web前端
├── src-tauri/           # Tauri配置和Rust代码
│   ├── src/             # Rust源代码
│   ├── gen/             # 生成的Android代码
│   └── Cargo.toml       # Rust依赖
└── package.json         # Node.js依赖
```

## 蓝牙通信协议

- 设备: 支持标准BLE设备
- 通讯: 蓝牙Low Energy (BLE)
- 编码: UTF-8文本或二进制格式

## 许可证

MIT
