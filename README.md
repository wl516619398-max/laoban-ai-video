# 老板AI短视频助手

面向中国县城实体老板的短视频生成 MVP。老板填写店铺信息并上传一段视频素材，系统生成三套不同方向的视频方案供选择。

## 技术栈

- 前端：Next.js + TypeScript + Tailwind CSS
- 后端：Python FastAPI
- 数据库：SQLite（为后续迁移 Supabase 保留清晰的数据边界）
- 素材：本地 Storage 保存上传视频，V0.7 使用 FFmpeg 完成基础拼接
- 配音：Edge TTS 生成中文 `voice.mp3`

## 目录结构

```text
.
├── backend/
│   ├── main.py              # FastAPI 应用与接口
│   ├── services/ai/         # DeepSeek AI 服务
│   ├── services/video_analysis_service.py # 未来视频理解接口
│   ├── services/editor_service.py        # 句子分段、素材映射与 FFmpeg 合成
│   ├── prompts/business_video_prompt.txt  # MVP 文案 Prompt
│   ├── requirements.txt     # Python 依赖
│   └── storage/             # 上传素材、voice.mp3 与 final.mp4
├── frontend/
│   ├── app/
│   │   ├── globals.css      # 全局样式
│   │   ├── layout.tsx       # 页面元信息
│   │   └── page.tsx         # 首页与上传/生成交互
│   ├── package.json
│   ├── postcss.config.js
│   ├── tailwind.config.ts
│   └── tsconfig.json
└── README.md
```

## 安装方法

### 1. 启动后端

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
# Windows PowerShell
copy .env.example .env
# macOS / Linux 使用：cp .env.example .env
# 然后编辑 .env，填入你的 DeepSeek API Key

uvicorn main:app --reload --port 8000
```

后端地址：<http://localhost:8000>，接口文档：<http://localhost:8000/docs>。

### 2. 启动前端

另开一个终端：

```bash
cd frontend
npm install
copy .env.example .env.local   # Windows
# macOS / Linux 使用：cp .env.example .env.local
npm run dev
```

打开 <http://localhost:3000>。

如果后端不是运行在 `http://localhost:8000`，修改 `frontend/.env.local` 中的 `NEXT_PUBLIC_API_URL`。

## 公网测试部署（V1.4）

当前版本适合部署到一台有持久化磁盘的云服务器或容器实例，前端和后端可以分别部署。SQLite 和本地 `storage/` 依赖持久化磁盘，不建议直接部署到无状态 Serverless 环境。

### 前端部署步骤

```bash
cd frontend
npm install

# 复制环境变量文件
# Windows PowerShell
copy .env.example .env.production
# macOS / Linux
# cp .env.example .env.production
```

编辑 `frontend/.env.production`：

```env
NEXT_PUBLIC_API_URL=https://你的后端域名
```

然后构建并启动：

```bash
npm run build
npm run start
```

生产环境默认监听 3000 端口。云平台需要把域名或公网入口转发到该端口。

### 后端部署步骤

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
copy .env.example .env   # macOS / Linux 使用 cp .env.example .env
```

编辑 `backend/.env` 后启动生产服务：

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

云平台如果通过环境变量提供端口，将命令中的 `8000` 替换为平台端口。

### 公网环境变量

后端必须配置：

```env
DEEPSEEK_API_KEY=你的_deepseek_api_key
DEEPSEEK_MODEL=deepseek-v4-flash
TTS_VOICE=zh-CN-XiaoxiaoNeural
FRONTEND_ORIGINS=https://你的前端域名
```

后端存储配置：

```env
STORAGE_DIR=storage
DATABASE_PATH=app.db
```

如果云服务器使用挂载盘，建议将 `STORAGE_DIR` 和 `DATABASE_PATH` 设置为挂载盘内的绝对路径。`STORAGE_DIR` 保存上传视频、试听音频和生成视频，`DATABASE_PATH` 保存 SQLite 数据库。

前端必须配置：

```env
NEXT_PUBLIC_API_URL=https://你的后端域名
```

前端的 `NEXT_PUBLIC_API_URL` 在构建时写入页面，修改后需要重新执行 `npm run build`。后端的 `FRONTEND_ORIGINS` 多个地址使用英文逗号分隔。

## 接口说明

### `POST /upload`

使用 `multipart/form-data` 上传字段 `file`。接口会把视频保存到 `backend/storage/`，同时记录文件名称、大小和上传时间，并返回 `file_id`。

### `POST /generate`

发送 `shop_name`、`industry`、`city`、`specialty`、`material_id`，接口一次返回 3 套方案：老板故事型、产品展示型、本地流量型。每套包含主题、推荐标题、适合目的、拍摄素材建议和 60 秒脚本。

响应新增 `plans` 数组，同时保留第一套方案的旧顶层字段，兼容原有接口调用。

### `POST /video-tasks`

发送 `material_ids` 和用户选中的方案 `script`，创建异步视频制作任务。任务先生成 `voice.mp3`，完成后由前端调用 `/render` 进入混剪。

兼容单素材调用：也可以发送旧字段 `material_id`。

### `POST /video-tasks/{task_id}/render`

配音完成后启动 FFmpeg 混剪，返回：

```json
{"status":"混剪中"}
```

### `GET /video-tasks/{task_id}`

查询任务状态。状态包括：生成配音、配音完成、混剪素材、添加声音、生成完成、生成失败。

### `GET /video-tasks/{task_id}/voice`

下载或试听任务生成的 `voice.mp3`。

### `GET /video-tasks/{task_id}/video`

返回生成完成后的 `final.mp4` 地址。

## DeepSeek 配置

1. 在 [DeepSeek API 控制台](https://platform.deepseek.com/) 创建 API Key。
2. 复制 `backend/.env.example` 为 `backend/.env`。
3. 填写：

```env
DEEPSEEK_API_KEY=你的_deepseek_api_key
DEEPSEEK_MODEL=deepseek-v4-flash
TTS_VOICE=zh-CN-XiaoxiaoNeural
```

`DEEPSEEK_MODEL` 可选，默认使用 `deepseek-v4-flash`。API 采用 DeepSeek 的 OpenAI 兼容 Chat Completions 接口，并使用 JSON Output 约束返回结构。

未配置 `DEEPSEEK_API_KEY` 时，`POST /generate` 会返回错误提示，不再返回模拟文案。

首次安装依赖时会安装 `edge-tts`，用于根据 60 秒口播稿生成中文 `voice.mp3`。`TTS_VOICE` 可选，默认使用 `zh-CN-XiaoxiaoNeural`。

## 当前产品链路

填写店铺信息 → 上传多个店内视频 → AI 生成三套方向 → 用户选择最佳方案 → 生成 `voice.mp3` → 按句号映射素材 → FFmpeg 拼接并添加声音 → 输出 `final.mp4`。

## V0.7 MVP 边界与未来扩展

- 当前版本只做基础成片验证：店铺信息 + 多素材上传 + AI 文案 + AI 配音 + FFmpeg 拼接。
- 不加入 AI 识别素材、自动找精彩片段、视频理解模型或自动调色。
- 已预留 `video_analysis_service`，未来接入视频理解 Agent。
- `editor_service` 按“。”切分完整句子，一个句子对应一个片段；逗号只作为语音停顿参考。素材不足时循环使用，素材过多时随机抽取。
- 当前不生成独立字幕文件和背景音乐，先输出带 AI 配音的 `final.mp4`。
