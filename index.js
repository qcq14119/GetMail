import express from "express";
import { createHash, randomBytes, randomUUID, timingSafeEqual, scrypt } from "node:crypto";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppError, authority, authorizationScope, microsoft } from "./microsoft.js";
import { openStore, exportBackup, readBackup } from "./storage.js";
import { parseImport, groupImportRows, clientIdPattern, emailPattern, normalizeEmail } from "./public/import-parser.js";

const root = dirname(fileURLToPath(import.meta.url));
const maxImport = 512_000;
const digest = (value) => createHash("sha256").update(value).digest();
const derive = promisify(scrypt);
const folderNames = { inbox: "inbox", junk: "junkemail" };

function publicAccount({ id, email, clientId, refreshToken, checkedAt, needsAuth, source }, access) {
  return {
    id, email, checkedAt, needsAuth, source, accessExpiresAt: access?.expiresAt,
    status: needsAuth ? "需要重新授权" : !refreshToken ? "待授权" : !clientId ? "缺少 Client ID" :
      checkedAt ? "上次验证成功" : "令牌尚未验证"
  };
}

function accountRecord(email, clientId = "", refreshToken = "", source = "import") {
  return { id: randomUUID(), revision: randomUUID(), email, clientId, refreshToken, source };
}

function backupAccounts(data) {
  if (!Array.isArray(data)) throw new Error("Backup records");
  return data.map(({ email, clientId, refreshToken, source }) => {
    if (typeof email !== "string" || !emailPattern.test(email) ||
        typeof clientId !== "string" || (clientId && !clientIdPattern.test(clientId)) ||
        typeof refreshToken !== "string" || refreshToken.length > maxImport ||
        !["import", "microsoft"].includes(source) ||
        (source === "microsoft" && (!clientId || !refreshToken))) throw new Error("Backup record");
    return accountRecord(normalizeEmail(email), clientId, refreshToken, source);
  });
}

export function createApp(config, ms = microsoft()) {
  const origin = new URL(config.appUrl).origin;
  const redirectUri = `${origin}/auth/microsoft/callback`;
  const secureCookie = origin.startsWith("https:");
  const store = openStore(config.dataDir, config.dataKey);
  let settings = store.loadSettings();
  let oauth = settings.oauth || { clientId: config.clientId || "", clientSecret: config.clientSecret || "" };
  const hasOAuth = () => Boolean(oauth.clientId && oauth.clientSecret);
  const username = () => settings.login?.username || "getmail";
  let passwordHash = settings.login ? null : digest(config.password);

  async function validPassword(password) {
    if (password.length > 1024) return false;
    const candidate = digest(password);
    if (passwordHash) return timingSafeEqual(candidate, passwordHash);
    const login = settings.login;
    const key = await derive(password, login.salt, 32);
    if (login !== settings.login || !timingSafeEqual(key, Buffer.from(login.hash, "base64"))) return false;
    passwordHash = candidate;
    return true;
  }
  const app = express();
  const cached = new Map();
  const refreshing = new Map();
  const authorizations = new Map();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
    next();
  });

  function findAccount(id) {
    const account = store.all().find((item) => item.id === id);
    if (!account) throw new AppError(404, "找不到这个邮箱。");
    return account;
  }

  function editCurrent(original, update) {
    return store.change((accounts) => {
      const account = accounts.find(({ id }) => id === original.id);
      if (account?.revision !== original.revision) throw new AppError(409, "邮箱授权已更新，请重试。");
      return update(account, accounts);
    });
  }

  function cacheToken(account, token) {
    const lifetime = Number(token.expires_in);
    const entry = {
      revision: account.revision, value: token.access_token,
      expiresAt: Date.now() + (Number.isFinite(lifetime) && lifetime > 0 ? lifetime * 1000 : 0)
    };
    cached.set(account.id, entry);
    return entry;
  }

  async function refreshAccount(account) {
    const appRegistration = oauth;
    if (account.needsAuth || !account.refreshToken) throw new AppError(409, "请先用 Microsoft 授权。", "reauthorize");
    if (!account.clientId) throw new AppError(409, "请补齐原应用的 Client ID，或用 Microsoft 授权。", "client");
    if (account.source === "microsoft" && (!hasOAuth() || account.clientId.toLowerCase() !== oauth.clientId.toLowerCase())) {
      throw new AppError(422, "请配置原 Microsoft 应用，或用当前应用重新授权。", "client");
    }
    let token;
    try {
      token = await ms.refresh(account, account.source === "microsoft" ? appRegistration.clientSecret : undefined);
    } catch (error) {
      if (account.source === "microsoft" && appRegistration !== oauth) throw new AppError(409, "微软应用配置已更新，请重试。");
      if (error.code === "reauthorize") editCurrent(account, (current) => { current.needsAuth = true; });
      throw error;
    }
    if (account.source === "microsoft" && appRegistration !== oauth) throw new AppError(409, "微软应用配置已更新，请重试。");
    const updated = editCurrent(account, (current) => {
      if (current.refreshToken !== account.refreshToken) throw new AppError(409, "邮箱令牌已更新，请重试。");
      if (typeof token.refresh_token === "string" && token.refresh_token && token.refresh_token !== current.refreshToken) {
        current.refreshToken = token.refresh_token;
      }
      current.checkedAt = Date.now();
      return current;
    });
    return cacheToken(updated, token);
  }

  function accessFor(id, rejected) {
    const account = findAccount(id);
    const entry = cached.get(id);
    if (entry?.revision === account.revision && entry !== rejected && entry.expiresAt > Date.now() + 30_000) return entry;
    const inFlight = refreshing.get(id);
    if (inFlight?.revision === account.revision) return inFlight.promise;
    const pending = { revision: account.revision, promise: refreshAccount(account).finally(() => {
      if (refreshing.get(id) === pending) refreshing.delete(id);
    }) };
    refreshing.set(id, pending);
    return pending.promise;
  }

  async function readMail(id, read) {
    let entry = await accessFor(id);
    let result;
    try {
      result = await read(entry.value);
    } catch (error) {
      if (error.code !== "access") throw error;
      entry = await accessFor(id, entry);
      result = await read(entry.value);
    }
    const account = findAccount(id);
    if (account.revision !== entry.revision) {
      throw new AppError(409, "邮箱授权已更新，请重试。");
    }
    return { result, account: publicAccount(account, cached.get(id)) };
  }

  app.get("/auth/microsoft/callback", async (req, res) => {
    const { state, code, error: authorizationError } = req.query;
    const flow = typeof state === "string" && authorizations.get(state);
    const browserId = /(?:^|;\s*)getmail_oauth=([a-f0-9]+)(?:;|$)/.exec(req.get("Cookie") || "")?.[1];
    if (!flow || flow.expiresAt < Date.now() || flow.browserId !== browserId || flow.oauth !== oauth) {
      return res.redirect(303, "/?oauth=invalid");
    }
    authorizations.delete(state);
    res.clearCookie("getmail_oauth", { httpOnly: true, sameSite: "lax", secure: secureCookie, path: "/auth/microsoft/callback" });
    if (authorizationError || typeof code !== "string" || !code) {
      switch (authorizationError) {
        case "access_denied": return res.redirect(303, "/?oauth=cancelled");
        case "interaction_required":
        case "login_required": return res.redirect(303, "/?oauth=interaction");
        case "unauthorized_client": return res.redirect(303, "/?oauth=client");
        case "temporarily_unavailable":
        case "server_error": return res.redirect(303, "/?oauth=unavailable");
        default: return res.redirect(303, "/?oauth=failed");
      }
    }
    try {
      const token = await ms.token({
        grant_type: "authorization_code", client_id: flow.oauth.clientId, client_secret: flow.oauth.clientSecret,
        redirect_uri: redirectUri, code, code_verifier: flow.verifier, scope: authorizationScope
      });
      const profile = await ms.profile(token.access_token);
      const addresses = [profile.mail, profile.userPrincipalName].filter((email) => typeof email === "string").map(normalizeEmail);
      if (!addresses.includes(flow.account.email)) return res.redirect(303, "/?oauth=mismatch");
      if (typeof token.refresh_token !== "string" || !token.refresh_token) return res.redirect(303, "/?oauth=failed");
      if (flow.oauth !== oauth || flow.login !== settings.login) return res.redirect(303, "/?oauth=invalid");
      const updated = editCurrent(flow.account, (account) => {
        Object.assign(account, {
          clientId: flow.oauth.clientId, refreshToken: token.refresh_token, source: "microsoft",
          revision: randomUUID(), checkedAt: Date.now(), needsAuth: false
        });
        return account;
      });
      cacheToken(updated, token);
      return res.redirect(303, `/?oauth=ok&account=${updated.id}`);
    } catch (error) {
      const outcome = ["unavailable", "client", "scope"].includes(error.code) ? error.code : "failed";
      return res.redirect(303, `/?oauth=${outcome}`);
    }
  });

  app.use(async (req, res, next) => {
    const authorization = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.get("Authorization") || "");
    if (authorization) {
      const decoded = Buffer.from(authorization[1], "base64").toString("utf8");
      const split = decoded.indexOf(":");
      const login = settings.login;
      if (split >= 0 && decoded.slice(0, split) === username() &&
          await validPassword(decoded.slice(split + 1)) && login === settings.login) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="GetMail", charset="UTF-8"').status(401).send("请登录 GetMail。");
  });

  app.use("/api", (req, res, next) => {
    if (req.get("Sec-Fetch-Site") === "cross-site") throw new AppError(403, "请从 GetMail 工作台发起请求。");
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.get("Origin") !== origin || !req.is("application/json")) throw new AppError(403, "请求来源不匹配，请通过 APP_URL 打开工作台。");
    next();
  }, express.json({ limit: "8mb" }));

  function listAccounts() {
    return store.all().map((account) => publicAccount(account, cached.get(account.id)));
  }

  function publicSettings() {
    return { username: username(), clientId: oauth.clientId, hasOAuth: hasOAuth(), redirectUri };
  }

  app.get("/api/settings", (req, res) => res.json(publicSettings()));
  app.post("/api/settings/login", async (req, res) => {
    const { username: name, currentPassword, newPassword } = req.body || {};
    if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]{1,64}$/.test(name) ||
        typeof currentPassword !== "string" || typeof newPassword !== "string" ||
        !newPassword.length || newPassword.length > 256 || /[\x00-\x1f\x7f]/.test(newPassword)) {
      throw new AppError(400, "用户名可用字母、数字、点、下划线和连字符。请填写新密码。");
    }
    const previous = settings.login;
    if (!await validPassword(currentPassword) || previous !== settings.login) throw new AppError(403, "当前密码不正确，或登录设置刚刚发生了变更。");
    const salt = randomBytes(16).toString("base64");
    const hash = (await derive(newPassword, salt, 32)).toString("base64");
    if (previous !== settings.login) throw new AppError(409, "登录设置已更新，请重试。");
    const next = { ...settings, login: { username: name, salt, hash } };
    store.saveSettings(next);
    settings = next;
    passwordHash = digest(newPassword);
    authorizations.clear();
    res.json({ username: name });
  });

  app.post("/api/settings/microsoft", (req, res) => {
    const { clientId, clientSecret = "" } = req.body || {};
    if (typeof clientId !== "string" || !clientIdPattern.test(clientId.trim()) ||
        typeof clientSecret !== "string" || clientSecret.length > 4096) throw new AppError(400, "请填写 Entra 应用的 Client ID 和客户端密码值。");
    const id = clientId.trim().toLowerCase();
    const secret = clientSecret.trim() || (id === oauth.clientId.toLowerCase() ? oauth.clientSecret : "");
    if (!secret) throw new AppError(400, "请输入此应用的 Client Secret 值。");
    const next = { ...settings, oauth: { clientId: id, clientSecret: secret } };
    store.saveSettings(next);
    settings = next;
    oauth = next.oauth;
    cached.clear();
    authorizations.clear();
    res.json(publicSettings());
  });

  app.get("/api/accounts", (req, res) => res.json({ accounts: listAccounts(), hasOAuth: hasOAuth() }));
  function importAccounts(rows, choices = {}) {
    if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new AppError(400, "请选择要保留的账号。");
    const replacedIds = [];
    const result = store.change((accounts) => {
      const existing = new Map(accounts.map((account) => [account.email, account]));
      let imported = 0;
      let skipped = 0;
      for (const [email, candidates] of groupImportRows(rows)) {
        const current = existing.get(email);
        const choice = Object.hasOwn(choices, email) ? choices[email] : undefined;
        const selected = current || candidates.length > 1 ?
          candidates.find(({ line }) => line === choice) : candidates[0];
        if (!selected) {
          if (current && choice === 0) { skipped += candidates.length; continue; }
          throw new AppError(409, "有重复邮箱，请重新核对并选择要保留的版本。");
        }
        const entry = accountRecord(email, selected.clientId.trim(), selected.refreshToken.trim(), selected.source);
        if (current) {
          Object.assign(current, entry, { id: current.id, checkedAt: undefined, needsAuth: false });
          replacedIds.push(current.id);
        } else accounts.push(entry);
        imported += 1;
        skipped += candidates.length - 1;
      }
      return { imported, skipped };
    });
    for (const id of replacedIds) cached.delete(id);
    return { ...result, replacedIds, accounts: listAccounts() };
  }

  app.post("/api/accounts/import", (req, res) => {
    const { text, separator = "", choices } = req.body || {};
    if (typeof text !== "string" || text.length > maxImport || typeof separator !== "string" || /[\r\n]/.test(separator)) {
      throw new AppError(400, "请检查导入文本和分隔符。");
    }
    res.json(importAccounts(parseImport(text, separator), choices));
  });

  app.post("/api/accounts/:id/credentials/view", (req, res) => {
    const { clientId, refreshToken } = findAccount(req.params.id);
    res.json({ clientId, refreshToken });
  });

  app.post("/api/accounts/:id/credentials", (req, res) => {
    const { email, clientId = "", refreshToken = "" } = req.body || {};
    if (email !== undefined && (typeof email !== "string" || email.trim().length > 254 || !emailPattern.test(email.trim()))) {
      throw new AppError(400, "请输入有效的邮箱地址。");
    }
    if (typeof clientId !== "string" || (clientId.trim() && !clientIdPattern.test(clientId.trim())) ||
        typeof refreshToken !== "string" || refreshToken.length > maxImport) {
      throw new AppError(400, "请检查 Client ID 和刷新令牌格式。");
    }
    const original = findAccount(req.params.id);
    const nextEmail = email === undefined ? original.email : normalizeEmail(email);
    const renamed = nextEmail !== original.email;
    const changed = editCurrent(original, (account, accounts) => {
      if (renamed && accounts.some(({ email }) => email === nextEmail)) throw new AppError(409, "此邮箱地址已在列表中。");
      const nextClientId = clientId.trim() || account.clientId;
      const nextToken = refreshToken.trim();
      const sameClient = nextClientId.toLowerCase() === account.clientId.toLowerCase();
      const newToken = nextToken && nextToken !== account.refreshToken;
      if (!renamed && account.clientId && !sameClient && !newToken) {
        throw new AppError(400, "更换 Client ID 时，请同时填写该应用签发的新令牌。");
      }
      const value = renamed ? (newToken ? nextToken : "") : (nextToken || account.refreshToken);
      if (renamed && !value) {
        Object.assign(account, accountRecord(nextEmail), { id: original.id, checkedAt: undefined, needsAuth: false });
        return true;
      }
      if (!renamed && sameClient && value === account.refreshToken) return false;
      if (!value) throw new AppError(400, "请输入刷新令牌。");
      const source = (sameClient && account.source === "microsoft") ||
        (hasOAuth() && nextClientId.toLowerCase() === oauth.clientId.toLowerCase()) ? "microsoft" : "import";
      Object.assign(account, {
        email: nextEmail, clientId: nextClientId, refreshToken: value, source, needsAuth: false,
        revision: randomUUID(), checkedAt: undefined
      });
      return true;
    });
    if (changed) cached.delete(original.id);
    res.json({ accounts: listAccounts(), changed });
  });

  app.post("/api/accounts/:id/remove", (req, res) => {
    const { id } = req.params;
    store.change((accounts) => {
      const index = accounts.findIndex((account) => account.id === id);
      if (index === -1) throw new AppError(404, "找不到这个邮箱。");
      accounts.splice(index, 1);
    });
    cached.delete(id);
    for (const [state, flow] of authorizations) {
      if (flow.account.id === id) authorizations.delete(state);
    }
    res.json({ accounts: listAccounts() });
  });

  app.get("/api/accounts/:id/mail", async (req, res) => {
    const { id } = req.params;
    const folder = req.query.folder || "inbox";
    if (typeof folder !== "string" || !Object.hasOwn(folderNames, folder)) throw new AppError(400, "找不到这个邮件文件夹。");
    const { result: messages, account } = await readMail(id, (access) => ms.list(access, folderNames[folder]));
    res.json({ messages, account });
  });
  app.get("/api/accounts/:id/mail/:messageId", async (req, res) => {
    const { id, messageId } = req.params;
    if (!/^[A-Za-z0-9_+=/-]{1,2048}$/.test(messageId)) throw new AppError(400, "邮件编号有误。");
    const { result: message, account } = await readMail(id, (access) => ms.message(access, messageId));
    res.json({ message, account });
  });
  app.post("/api/accounts/:id/authorize", (req, res) => {
    if (!hasOAuth()) throw new AppError(503, "请在设置中配置 Microsoft 授权。");
    const account = findAccount(req.params.id);
    const state = randomBytes(32).toString("hex");
    const browserId = randomBytes(32).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    for (const [key, flow] of authorizations) if (flow.expiresAt < Date.now()) authorizations.delete(key);
    if (authorizations.size >= 100) throw new AppError(429, "授权请求过多，请稍后再试。");
    authorizations.set(state, { account, browserId, verifier, oauth, login: settings.login, expiresAt: Date.now() + 600_000 });
    res.cookie("getmail_oauth", browserId, {
      httpOnly: true, sameSite: "lax", secure: secureCookie, maxAge: 600_000, path: "/auth/microsoft/callback"
    });
    const query = new URLSearchParams({
      response_type: "code", response_mode: "query", client_id: oauth.clientId, redirect_uri: redirectUri,
      scope: authorizationScope, state, code_challenge: digest(verifier).toString("base64url"),
      code_challenge_method: "S256", login_hint: account.email, prompt: "select_account"
    });
    res.json({ url: `${authority}/authorize?${query}` });
  });

  function backupPassword(req) {
    const { password } = req.body || {};
    if (typeof password !== "string" || password.length < 12 || password.length > 256) {
      throw new AppError(400, "导出密码须为 12 至 256 个字符。");
    }
    return password;
  }
  app.post("/api/backup/export", async (req, res) => {
    const password = backupPassword(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== "string")) throw new AppError(400, "请选择要导出的邮箱。");
    const selected = new Set(ids);
    const accounts = store.all().filter(({ id }) => selected.has(id))
      .map(({ email, clientId, refreshToken, source }) => ({ email, clientId, refreshToken, source }));
    if (accounts.length !== selected.size) throw new AppError(409, "邮箱列表已更新，请重新选择。");
    const backup = await exportBackup(accounts, password);
    res.attachment(`getmail-accounts-${new Date().toISOString().slice(0, 10)}.json`).json(backup);
  });
  async function accountFile(req) {
    const password = backupPassword(req);
    let restored;
    try {
      restored = backupAccounts(await readBackup(req.body.backup, password));
    } catch {
      throw new AppError(400, "无法读取账号文件，请检查文件和导出密码。");
    }
    return restored.map((account, index) => ({ ...account, line: index + 1, valid: true }));
  }
  app.post("/api/accounts/import-file/preview", async (req, res) => {
    const rows = (await accountFile(req)).map(({ line, email, clientId, refreshToken }) =>
      ({ line, email, clientId, hasToken: Boolean(refreshToken), valid: true }));
    res.json({ rows, accounts: listAccounts() });
  });
  app.post("/api/accounts/import-file", async (req, res) => {
    res.json(importAccounts(await accountFile(req), req.body.choices));
  });

  app.use(express.static(join(root, "public")));
  app.use((req, res) => res.status(404).json({ error: "找不到这个页面。" }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof AppError) return res.status(error.status).json({ error: error.message, code: error.code });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "请求内容太大。" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "无法读取请求内容。" });
    console.error("GetMail request failed", error.name, error.code || "");
    res.status(500).json({ error: "GetMail 暂时无法处理请求。" });
  });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(join(root, ".env"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const port = Number(process.env.APP_PORT || process.env.PORT || 47863);
  const appUrl = new URL(process.env.APP_URL || process.env.UPPCODER_SELF_URL || `http://localhost:${port}`);
  const host = process.env.HOST || (appUrl.protocol === "https:" ? "0.0.0.0" : "127.0.0.1");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname) && ["127.0.0.1", "::1", "localhost"].includes(host);
  const password = process.env.APP_PASSWORD || "";
  const encodedKey = process.env.DATA_KEY || "";
  const dataKey = Buffer.from(encodedKey, "base64");
  if ((!local && appUrl.protocol !== "https:") || appUrl.pathname !== "/" || appUrl.search || appUrl.hash ||
      appUrl.username || appUrl.password || !password.length || password.length > 256 || /[\x00-\x1f\x7f]/.test(password) ||
      dataKey.length !== 32 || dataKey.toString("base64") !== encodedKey) {
    throw new Error("请配置正确的 APP_URL、非空的 APP_PASSWORD 和 Base64 编码的 32 字节 DATA_KEY。");
  }
  const clientId = process.env.MS_CLIENT_ID;
  const clientSecret = process.env.MS_CLIENT_SECRET;
  if (Boolean(clientId) !== Boolean(clientSecret) || (clientId && !clientIdPattern.test(clientId))) {
    throw new Error("MS_CLIENT_ID 和 MS_CLIENT_SECRET 需要一起配置，Client ID 必须是应用注册的 UUID。");
  }
  const app = createApp({
    appUrl: appUrl.origin, password, dataKey, clientId, clientSecret,
    dataDir: resolve(process.env.DATA_DIR || join(root, "data"))
  });
  app.listen(port, host, () => console.log(`GetMail 已启动 · ${appUrl.origin}`));
}
