# 后端生产部署

## 1. 安装依赖

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate

# Windows PowerShell
.\.venv\Scripts\Activate.ps1

pip install -r requirements.txt
```

## 2. 配置环境变量

复制 `.env.example` 为 `.env`，至少配置：

```env
DEEPSEEK_API_KEY=你的 API Key
TTS_VOICE=zh-CN-XiaoxiaoNeural
DATABASE_PATH=/data/boss-ai/app.db
STORAGE_DIR=/data/boss-ai/storage
FRONTEND_ORIGINS=https://你的前端域名
```

`DATABASE_PATH` 和 `STORAGE_DIR` 支持绝对路径；相对路径相对于 `backend` 目录。部署到公网时，二者都应放在持久化磁盘中，否则重启或重新部署可能丢失历史记录、上传素材和成片。

## 3. 生产启动

```bash
uvicorn main:app --host 0.0.0.0 --port 8000
```

生产环境不要使用 `--reload`。反向代理或云平台应将公网 HTTPS 请求转发到该服务端口，并让 `FRONTEND_ORIGINS` 与前端实际域名完全一致；多个域名用英文逗号分隔。

启动后可检查：

```text
GET /
GET /docs
```

当前仍使用 SQLite 和本地文件存储，适合 MVP 公网测试；暂不适合无持久化磁盘的 Serverless 部署。
