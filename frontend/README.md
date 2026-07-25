# 前端部署

## Vercel 部署

当前前端是标准 Next.js App Router 项目，适合部署到 Vercel。Vercel 只负责页面和静态资源，视频上传、SQLite、配音和视频合成仍由独立 FastAPI 后端负责。

1. 在 Vercel 导入项目仓库。
2. 将 Root Directory 设置为 `frontend`。
3. Framework Preset 选择 Next.js。
4. 在 Vercel 项目环境变量中配置：

   ```env
   NEXT_PUBLIC_API_URL=https://你的后端域名
   ```

5. 使用默认构建命令 `pnpm run build`，输出由 Vercel 自动处理。

`NEXT_PUBLIC_API_URL` 会在构建时写入浏览器端页面。修改后端域名后，必须重新部署前端。后端的 `FRONTEND_ORIGINS` 需要包含 Vercel 实际域名，例如 `https://your-project.vercel.app`。

## 本地验证

```bash
cd frontend
pnpm install
copy .env.example .env.local   # Windows PowerShell
# macOS / Linux: cp .env.example .env.local
pnpm run build
pnpm run start
```

Vercel 不提供本项目所需的持久化视频存储和 SQLite 磁盘，因此不要把后端部署为 Vercel Serverless Function。
