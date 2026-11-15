# GetMail

个人 Outlook / Hotmail 邮箱工作台。一次导入多个账号，点哪个邮箱就取哪个。收件箱和垃圾邮件各显示最近 30 封，正文以纯文本显示。

## 本地运行

需要 Node.js 26。首次配置时，在项目目录将 `.env.example` 复制为 `.env`，并生成加密密钥。PowerShell 示例：

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

将生成值填入 `.env` 的 `DATA_KEY`，给 `APP_PASSWORD` 设置一个登录密码。配置过的实例可直接用脚本启动：Windows 双击 `start.bat` 或运行 `.\start.bat`，Linux 运行 `sh start.sh`。打开 [本地工作台](http://localhost:47863)，首次登录的用户名是 `getmail`。

脚本会在依赖缺失时运行 `npm ci --omit=dev`。如果当前 Node 不是 26，但有 npm，脚本会用 npm 运行 Node 26；缓存未命中时需要联网。仍可用 `npm start` 直接启动。更新源码后，如果依赖有变化，请重新运行 `npm ci`。按 `Ctrl+C` 停止。

邮箱地址、每个账号的 Client ID 和 Refresh Token 默认加密写入 `data/accounts.sqlite`。导入时提供的邮箱密码不保存。`.env` 用于实例配置，其中的 `MS_CLIENT_ID` 和 `MS_CLIENT_SECRET` 属于 GetMail 自己注册的微软应用。更换 `DATA_KEY` 前请先导出备份，已有数据库需要原密钥解密。

首次登录使用 `getmail` 和 `.env` 的 `APP_PASSWORD`。之后可以在「设置 → 工作台登录」验证当前密码，修改用户名和密码。保存立即生效，浏览器若沿用旧密码，可在无痕窗口用新凭据登录。页面设置优先于初始配置，密码只存验证用的哈希。

## 导入和授权

- 支持邮箱、邮箱加密码、邮箱加密码及 Refresh Token、邮箱加密码及 Client ID 和 Refresh Token。密码位可留空，导入后只保存邮箱和授权信息。
- 一行一个账号。自动模式识别三、四横线。遇到拆分歧义或其他格式，选择自定义并在预览里核对每列。「本次导入」标记提交后会新增的行。
- 商家 Refresh Token 需要同一应用的 Client ID，以及 Microsoft Graph 邮件读取权限。如果商家应用需要客户端密钥，或只授权了 IMAP，可以对自己有权操作的邮箱使用 Microsoft 重新授权。
- 要启用 Microsoft 授权，在 Microsoft Entra 注册支持个人 Microsoft 账号的应用。在「身份验证」添加 **Web** 重定向 URI（复制「设置 → Microsoft 授权」显示的地址），在「API 权限」添加 Microsoft Graph 委托权限 `Mail.Read`、`User.Read`。从应用「概述」复制应用程序（客户端）ID，在「证书和密码」创建客户端密码并立即复制「值」。将两项填入 GetMail 设置后即可授权。GetMail 会一并申请 `offline_access`。设置加密保存在本实例的数据库里，账号备份仅包含邮箱数据。
- 如果微软授权后提示邮箱不匹配，请导入与微软返回的主邮箱或登录名相同的地址，再为该账号授权。

## 账号导出与导入

点「导入邮箱」可以粘贴账号文本、选择 TXT 文件或拖入文件，确认预览后再保存。重复邮箱可保留现有账号或选择导入版本。

点「导出账号」进入多选，勾选需要的邮箱，用独立的导出密码下载加密账号文件。迁移时在导入侧栏选取该 JSON，用同一个密码解锁预览。通过 GetMail 授权的账号迁移后，需要配置同一个 Microsoft 应用，或重新授权。

选中邮箱后，点地址旁的「编辑」可修改地址和令牌，或移除邮箱。更换地址时，原令牌会清除，可以同时填写新地址对应的令牌。

## Uppcoder

本地验收并推送后，在 Uppcoder 的 Express 应用中连接公有仓库 `https://github.com/qcq14119/GetMail`，在应用目录执行 `npm ci --omit=dev`，启动入口为 `index.js`（也可用 `npm start`）。监听端口优先采用容器的 `APP_PORT`，其次是 `PORT`，默认 47863。

GetMail 会读取 Uppcoder 提供的 `UPPCODER_SELF_URL` 作为外部地址。若模板没有注入该值，或浏览器使用自定义域名，将 `APP_URL` 设为实际访问的 HTTPS 根地址。显式的 `APP_URL` 优先。HTTPS 部署默认监听 `0.0.0.0`。将 `DATA_DIR` 指向可持久化的目录，并设置工作台口令和加密密钥。

在 Entra 的 Web 重定向 URI 中添加「设置 → Microsoft 授权」显示的线上地址，例如 `https://你的域名/auth/microsoft/callback`。客户端 ID 和密钥在工作台保存时写入数据库。授权回调负责接收微软发来的邮箱授权码，GetMail 后端再用应用凭据把授权码换成邮箱令牌。本地的 localhost 回调只供本机测试。

GitHub 只保存源码和配置模板。`.gitignore` 排除实际 `.env`、整个 `data/` 目录和默认命名的备份。若自定义数据目录或备份文件名，将文件保存在仓库目录之外。容器更新后检查账号仍能读出，再用一个有效账号验证取件。

## 验证

`npm test` 使用模拟 Microsoft 响应验证主要 API 和授权回调。真实邮箱取件需要有效且具备对应权限的 Microsoft 授权。
