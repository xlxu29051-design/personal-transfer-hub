# Transfer Hub

零依赖的个人跨设备传输站。手机和电脑打开同一个地址，用一把访问密钥进入；文字、图片、代码和文件保存在你自己的机器上。

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Dependencies](https://img.shields.io/badge/dependencies-0-1f6feb)](#技术栈)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey)](#快速开始)

仓库公开的是源码，不是你的资料。访问密钥、数据库和个人文件都留在本地，不会进入 Git。

## 目录

- [它解决什么问题](#它解决什么问题)
- [特性](#特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [配置](#配置)
- [使用](#使用)
- [项目结构](#项目结构)
- [数据怎么保存](#数据怎么保存)
- [接口](#接口)
- [安全](#安全)
- [部署](#部署)
- [备份与恢复](#备份与恢复)
- [边界](#边界)
- [常见问题](#常见问题)
- [许可证](#许可证)

## 它解决什么问题

一段话在手机上，一个文件在电脑上，来回转发容易断、容易散，也容易过期。Transfer Hub 把这些收进同一个私有空间：

- 只有知道访问密钥的人能看到内容。
- 记录默认长期保留，刷新或重启服务都还在。
- 删除先进入废纸篓；只有清空或永久删除，才会真正移除文件。

它是单用户工具，不提供注册、公开分享链接或多人权限。

## 特性

- **一把密钥。** 连续输错会暂时锁定。未登录访问内容接口会返回 401。
- **分类。** 可以新建和重命名。删除普通分类时，里面的记录会移到系统默认分类，不会一起被删掉。
- **文字。** 保存笔记、链接和代码片段，可以搜索、复制和修改。
- **文件。** 支持多选、拖拽、粘贴图片或文件，上传时显示进度，下载时保留原文件名。
- **预览。** 图片、纯文本、代码和 PDF 可以直接打开。
- **废纸篓。** 普通删除可以还原；永久删除或清空才会删掉磁盘上的文件。
- **批量操作。** 多选后移动分类、删除、还原或永久删除，一次最多 500 条。
- **多设备。** 页面可见时大约每 15 秒拉取一次，也可以手动刷新。
- **手机可用。** 窄屏使用独立的分类抽屉，桌面布局保持不变。

## 技术栈

| 部分 | 选择 |
| --- | --- |
| 运行时 | Node.js 20 或更高版本，只使用 `http`、`fs`、`crypto`、`path`、`url` |
| 依赖 | 无。不需要执行 `npm install` |
| 前端 | 原生 HTML、CSS 和 JavaScript |
| 元数据 | `data/db.json` |
| 文件 | `data/uploads/`，存储名是随机 id，不使用用户原始路径 |
| 会话 | 进程内存。服务重启后需要重新输入密钥 |

## 快速开始

### 环境

先确认 Node.js 版本：

```powershell
node --version
```

需要 v20 或更高。Windows、Linux 和 macOS 都可以运行。

### 启动

Windows PowerShell：

```powershell
git clone https://github.com/xlxu29051-design/personal-transfer-hub.git
Set-Location personal-transfer-hub
Copy-Item .env.example .env
notepad .env
node server.js
```

macOS 或 Linux：

```bash
git clone https://github.com/xlxu29051-design/personal-transfer-hub.git
cd personal-transfer-hub
cp .env.example .env
# 把 APP_PASSWORD 改成至少 8 位的随机密钥
node server.js
```

看到类似下面的输出后，打开 <http://localhost:8787>。

```text
Personal Transfer Hub listening at http://localhost:8787
Persistent data directory: .../data
```

`APP_PASSWORD` 必须至少 8 个字符。更短的密钥会被登录逻辑直接拒绝。

如果故意不设置 `APP_PASSWORD`，首次启动会生成随机密钥，明文写在 `data/initial-password.txt`，哈希写在 `data/.password-hash`。把明文保存到密码管理器后，删除 `initial-password.txt`。这两个文件都已被 Git 忽略。

### 确认服务可用

```powershell
curl.exe http://127.0.0.1:8787/api/health
curl.exe http://127.0.0.1:8787/api/bootstrap
```

第一条应返回：

```json
{"ok":true}
```

第二条在未登录时返回 401，错误信息是「请先输入访问密钥」。

## 配置

启动时读取项目根目录的 `.env`。系统环境里已经存在的同名变量优先，不会被 `.env` 覆盖。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PASSWORD` | 空 | 访问密钥。使用至少 8 位的长随机字符串 |
| `HOST` | `0.0.0.0` | 监听地址。只给本机或本机反代使用时改为 `127.0.0.1` |
| `PORT` | `8787` | 监听端口 |
| `COOKIE_SECURE` | 未设置 | 设为 `1` 时，会话 Cookie 增加 `Secure`，只通过 HTTPS 发送 |
| `TRUST_PROXY` | 未设置 | 设为 `1` 时，若 `X-Forwarded-Proto` 是 `https`，同样把 Cookie 标为 `Secure` |
| `MAX_FILE_BYTES` | `262144000` | 单个文件上限，默认 250 MB |

公网示例：

```dotenv
APP_PASSWORD=replace-with-a-long-random-secret
HOST=127.0.0.1
PORT=8787
COOKIE_SECURE=1
TRUST_PROXY=1
MAX_FILE_BYTES=262144000
```

修改 `.env` 后需要重启进程。访问密钥不写入 `db.json`。

## 使用

1. 输入访问密钥，进入空间。
2. 在左侧管理分类。没有指定分类时，内容保存到系统默认分类。它最初叫「未分类」，可以改名，但不能删除。
3. 在底部输入文字，或把图片和文件粘贴、拖进输入区，再点「发送」。也可以点「添加」选择多个文件。
4. 记录出现在上方。搜索会匹配标题、文字内容和分类名。
5. 图片、文本、代码和 PDF 可以预览；其他文件按原文件名下载。文字记录可以复制和编辑。
6. 点「选择」后可以批量移动或删除。普通删除进入废纸篓，可以从废纸篓还原、永久删除或清空。
7. 另一台设备打开同一个地址并输入同一把密钥。页面处于可见状态时大约每 15 秒同步一次，右上角也可以手动刷新。
8. 退出只清除当前浏览器的会话，不会删除任何记录。

一条文字最多 20000 个字符。分类名最多 60 个字符，重名判断不区分大小写。

## 项目结构

```text
.
├── public
│   ├── index.html          # 页面结构
│   ├── app.js              # 登录、列表、上传、预览和废纸篓
│   └── styles.css          # 桌面端和手机端样式
├── data                    # 运行后生成，除 .gitkeep 外不入库
│   ├── .gitkeep
│   ├── db.json             # 分类和记录元数据
│   ├── uploads             # 文件内容
│   ├── .password-hash      # 仅在未配置 APP_PASSWORD 时生成
│   └── initial-password.txt
├── server.js               # HTTP 服务、鉴权、存储和安全头
├── package.json            # 启动脚本；private 用于阻止误发布到 npm
├── .env.example            # 配置模板，可以提交
├── .gitignore
└── README.md
```

## 数据怎么保存

`data/db.json` 只有 `topics` 和 `entries`。文字直接存在对应记录中。文件记录保存原文件名、MIME、大小、SHA-256 和存储名，二进制内容写到 `data/uploads/<id>.bin`。

元数据先写入 `db.json.tmp`，完成后再改名为 `db.json`，避免进程中断时留下半份 JSON。原始文件名里的路径分隔符和控制字符会被替换，最长保留 180 个字符；磁盘上的存储名不接受用户指定。

克隆这个仓库后，`data/` 里只有 `.gitkeep`。每台机器的记录互相独立。

## 接口

页面和静态资源可以直接访问。下面除健康检查、登录、会话查询和退出以外，都需要登录后的 `sid` Cookie。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查，返回 `{"ok":true}` |
| `POST` | `/api/login` | JSON：`{"password":"..."}`。成功后设置会话 Cookie |
| `GET` | `/api/session` | 返回当前请求是否已登录 |
| `POST` | `/api/logout` | 清除会话 Cookie |
| `GET` | `/api/bootstrap` | 返回全部分类和记录 |
| `POST` | `/api/topics` | 新建分类，JSON：`{"name":"..."}` |
| `PATCH` | `/api/topics/:id` | 重命名分类 |
| `DELETE` | `/api/topics/:id` | 删除普通分类，并将其记录改挂到系统默认分类 |
| `POST` | `/api/topics/:id/notes` | 新建文字，JSON：`{"content":"..."}` |
| `POST` | `/api/topics/:id/files` | `multipart/form-data`，字段名是 `file`，可以包含多个文件 |
| `PATCH` | `/api/entries/:id` | 修改文字。废纸篓中的记录和文件记录不能修改 |
| `DELETE` | `/api/entries/:id` | 把一条记录移入废纸篓 |
| `POST` | `/api/entries/move` | JSON：`{"ids":["..."],"topicId":"..."}` |
| `POST` | `/api/entries/trash` | 批量移入废纸篓。`POST /api/entries/delete` 与它相同 |
| `POST` | `/api/entries/restore` | 从废纸篓批量还原。原分类已不存在时挂回系统默认分类 |
| `POST` | `/api/entries/purge` | 永久删除已经位于废纸篓中的记录和文件 |
| `POST` | `/api/trash/empty` | 清空废纸篓 |
| `GET` | `/api/files/:id` | 按原文件名下载。图片、文本和 PDF 可加 `?inline=1` 内联打开 |

登录失败返回 401。同一远端地址在 15 分钟内失败 5 次后返回 429，并锁定 15 分钟。超过大小限制返回 413。

## 安全

这些措施适合一个个人站点，不能把它当成多用户或公开上传服务。

- 密钥使用 scrypt 校验，比较时采用恒定时间比较。
- 配置了 `APP_PASSWORD` 时，每次启动都从环境变量计算校验值，明文不会写进数据库。
- 没有配置密钥时，随机盐和哈希才写入 `data/.password-hash`。明文只在首次生成时出现于 `initial-password.txt`。
- 会话令牌为 32 字节随机值。Cookie 使用 `HttpOnly` 和 `SameSite=Lax`，有效期 30 天，只保存在当前进程的内存中。
- 响应包含 `Content-Security-Policy`、`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY` 和 `Referrer-Policy: no-referrer`。通过 HTTPS 访问时附加 HSTS。
- 静态文件会限制在 `public/` 内，不能通过路径穿越读取项目外的文件。
- 上传文件使用随机存储名，并记录 SHA-256。程序不扫描病毒，也不解析宏或压缩包内容。

登录锁定依据的是 TCP 连接的远端地址，不会读取 `X-Forwarded-For`。服务放在反向代理后面时，失败次数可能都记在代理地址上。

不要提交或外发 `.env`、`data/db.json`、`data/uploads/`、`data/.password-hash` 和 `data/initial-password.txt`。

## 部署

本地开发可以监听所有网卡。公开访问时让 Node 只监听本机，由 Caddy、Nginx，或一台你自己管理的 HTTPS 隧道转发请求。不要把 8787 端口直接暴露到公网。

```caddy
transfer.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

对应环境变量使用上一节的公网示例，至少设置长密钥、`HOST=127.0.0.1`、`COOKIE_SECURE=1` 和 `TRUST_PROXY=1`。

如果流量经过 Cloudflare 等代理，先确认套餐允许的请求体大小。应用默认接受 250 MB，代理限制通常更小；免费代理不适合作为大文件传输通道。需要稳定传输大文件时，使用 VPS 上直接终结 TLS 的 Caddy 或 Nginx。

上线前用真实浏览器检查四件事：两台设备都能进入；一台上传后另一台刷新可见；下载后的文件名和内容正确；未登录访问 `/api/bootstrap` 返回 401。

容器或云主机必须把 `data/` 放到持久磁盘。没有持久卷时，重新创建容器会丢失全部记录。

## 备份与恢复

至少保留：

- `data/db.json`
- `data/uploads/`

没有使用 `APP_PASSWORD` 时，还要保留 `data/.password-hash`，否则恢复后原来的随机密钥失效。使用 `APP_PASSWORD` 时，在新环境放回同一份 `.env`；不要把 `.env` 打进准备上传或公开的压缩包。

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Compress-Archive -Path data\db.json, data\uploads -DestinationPath "transfer-hub-$stamp.zip"
```

恢复前先停止服务，把文件放回原来的 `data/` 位置，再启动。

## 边界

当前不会做这些事：

- 用户注册、多用户隔离和权限分级
- 免登录的公开分享链接
- 病毒扫描
- 断点续传、分片上传和对象存储直传
- 多个 Node 进程共享登录状态

上传时文件会完整读入内存，因此不要把 `MAX_FILE_BYTES` 调到超过机器可用内存的大小。一次批量请求最多处理 500 个 id。

以后如果需要多人协作、TB 级文件或断点续传，应把文件迁到 S3、R2 或 MinIO，把元数据迁到 PostgreSQL，而不是继续扩大这个 JSON 文件。

## 常见问题

**刷新网页或重启服务后，记录还在吗？**

记录还在，它们写在 `data/`。重启后要重新登录，因为会话没有写入磁盘。

**忘记密钥怎么办？**

使用 `APP_PASSWORD` 时，修改 `.env` 并重启，旧密钥立即失效，已有记录保留。使用自动生成的密钥时，停止服务，删除 `data/.password-hash` 和 `data/initial-password.txt`，不要设置 `APP_PASSWORD`，然后重新启动。新明文会写在 `initial-password.txt`。

**为什么另一台电脑是空的？**

每份程序只读取它自己目录里的 `data/`。仓库和个人备份里默认都没有你的记录。另一台设备要访问同一份数据，必须打开正在运行这份 `data/` 的那个服务。

**可以给别人一个账号吗？**

不能分开。知道密钥的人会看到全部记录，也拥有删除权限。

## 许可证

本仓库尚未授予开源许可证。你可以查看和学习源码；复制、修改或再分发前，请先联系仓库所有者。