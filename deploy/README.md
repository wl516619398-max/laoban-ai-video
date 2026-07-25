# 公网部署说明

## 服务器环境要求

- Linux 云服务器或支持持久化磁盘的容器平台
- Python 3.11 及以上（非 Docker 部署）
- Node.js 20 LTS 及以上、pnpm 9 及以上（前端本地构建或非 Vercel 部署）
- Docker Engine 24+ 与 Docker Compose v2（选择 Docker 部署时）
- 至少一个可持久化目录，用于 SQLite、上传视频、试听音频和最终视频
- 服务器能访问 DeepSeek API 和 Edge TTS 服务

SQLite 和本地 `storage` 只适合单机 MVP 测试。不要部署到没有持久化磁盘的后端 Serverless 环境。

## 环境变量配置

项目根目录的 `.env.example` 是总清单。实际配置位置如下：

### 后端 `backend/.env`

```env
DEEPSEEK_API_KEY=你的 DeepSeek API Key
DEEPSEEK_MODEL=deepseek-v4-flash
TTS_VOICE=zh-CN-XiaoxiaoNeural
DATABASE_PATH=/data/boss-ai/app.db
STORAGE_DIR=/data/boss-ai/storage
FRONTEND_ORIGINS=https://你的前端域名
```

`FRONTEND_ORIGINS` 多个域名用英文逗号分隔，必须包含浏览器实际访问的前端域名。`DATABASE_PATH` 和 `STORAGE_DIR` 支持绝对路径；相对路径相对于 `backend` 目录。

### 前端 `frontend/.env.production`

```env
NEXT_PUBLIC_API_URL=https://你的后端域名
```

前端变量在构建阶段生效，修改后必须重新执行构建和部署。

## 方式一：Docker Compose 部署后端

在项目根目录执行：

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，填入真实 API Key 和前端域名
docker compose up -d --build
docker compose ps
```

Windows PowerShell 使用：

```powershell
copy backend/.env.example backend/.env
docker compose up -d --build
```

默认后端监听 `8000` 端口。可通过 `BACKEND_PORT` 修改宿主机端口。Compose 会将视频保存到 `video_storage` 卷，将 SQLite 保存到 `sqlite_data` 卷。

检查服务：

```text
GET https://你的后端域名/
GET https://你的后端域名/docs
```

## 方式二：直接运行后端

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

Windows PowerShell：

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
uvicorn main:app --host 0.0.0.0 --port 8000
```

生产环境不要使用 `--reload`。反向代理应提供 HTTPS，并把请求转发到 FastAPI 的 `8000` 端口。

## 前端上线

推荐将前端部署到 Vercel，详细步骤见 [`../frontend/README.md`](../frontend/README.md)。也可以在服务器上运行：

```bash
cd frontend
pnpm install
printf 'NEXT_PUBLIC_API_URL=https://你的后端域名\n' > .env.production
pnpm run build
pnpm run start
```

## 常见错误

### 页面请求失败或出现跨域错误

检查 `NEXT_PUBLIC_API_URL` 是否为后端 HTTPS 地址，并确认后端 `FRONTEND_ORIGINS` 与前端域名完全一致。修改前端变量后需要重新构建。

### AI 文案生成失败

检查 `DEEPSEEK_API_KEY` 是否已经配置，服务器是否允许访问 DeepSeek API。不要把 Key 写进前端变量或提交到 Git。

### 视频生成后文件消失

说明 `DATABASE_PATH` 或 `STORAGE_DIR` 指向了容器临时目录。Docker 必须保留 Compose 卷；云服务器必须使用持久化磁盘。

### 上传大视频失败

检查 Nginx、云负载均衡或平台的请求体大小限制，适当增大 `client_max_body_size`。这不是前端业务流程问题。

### 配音失败

检查服务器出网权限、Edge TTS 可访问性和 `TTS_VOICE` 是否为支持的中文声音。可先使用默认的 `zh-CN-XiaoxiaoNeural`。

### Docker 构建失败

检查 Docker Engine 和 Compose 版本，并确认服务器可以访问 PyPI。`imageio-ffmpeg` 会为视频合成准备 FFmpeg 运行文件。
