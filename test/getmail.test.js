import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../index.js";
import { microsoft } from "../microsoft.js";
import { parseImport } from "../public/import-parser.js";

const clientId = "00000000-0000-4000-8000-000000000001";
const password = "test-app-password";
const backupPassword = "test-backup-password";

test("automatic import keeps ambiguous lines out and handles custom separators literally", () => {
  const rows = parseImport([
    "one@example.com---example",
    `two@example.com--------${clientId}----sample-token`,
    "box@mail.example---team.com----demo",
    "hyphen@example.com-----demo",
    "ONE@example.com----duplicate"
  ].join("\n"), "");
  assert.deepEqual(rows.map((row) => row.included), [true, true, false, false, false]);
  assert.equal(rows[1].refreshToken, "sample-token");
  const [custom] = parseImport("box@mail.example---team.com||-demo", "||");
  assert.equal(custom.email, "box@mail.example---team.com");
  assert.equal(custom.password, "-demo");
  assert.equal(custom.included, true);
  for (const separator of ["----", "||"]) {
    const token = `M.example${separator}part${separator}`;
    const line = ["backup@example.com", "", clientId, token].join(separator);
    for (const mode of separator === "----" ? ["", separator] : [separator]) {
      const [row] = parseImport(line, mode);
      assert.equal(row.included, true);
      assert.equal(row.refreshToken, token);
    }
  }
});

test("import, isolated mail, refresh rotation, OAuth callback, and encrypted migration", async (t) => {
  const calls = [];
  let codeVerifier;
  const reply = (data, status = 200) => Response.json(data, { status });
  const ms = microsoft(async (input, options) => {
    const url = new URL(input);
    if (url.hostname === "login.microsoftonline.com") {
      const params = options.body;
      const incoming = params.get("refresh_token");
      calls.push(incoming || params.get("code"));
      if (incoming === "expired-token") return reply({ error: "invalid_grant" }, 400);
      if (incoming === "offline-token") return reply({}, 503);
      if (params.get("code")) codeVerifier = params.get("code_verifier");
      const access = incoming || params.get("code");
      return reply({ access_token: access, refresh_token: `rotated-${access}`, expires_in: 3600 });
    }
    assert.equal(url.hostname, "graph.microsoft.com");
    const token = options.headers.Authorization.slice(7);
    if (url.pathname === "/v1.0/me") return reply({ mail: token === "wrong-user" ? "other@example.com" : "pending@example.com" });
    const mail = { id: "message/1=", subject: `For ${token}`, from: { emailAddress: { name: "Sender" } }, bodyPreview: "Snippet" };
    if (url.pathname.includes("/mailFolders/")) return reply({ value: url.pathname.includes("/inbox/") ? [mail] : [] });
    assert.equal(options.headers.Prefer, 'outlook.body-content-type="text"');
    assert.equal(decodeURIComponent(url.pathname), "/v1.0/me/messages/message/1=");
    return reply({ ...mail, body: { contentType: "text", content: "<b>Literal text</b>" } });
  });

  async function start(dataDir, dataKey = randomBytes(32), origin = "http://localhost:47863") {
    const app = createApp({ appUrl: origin, password, dataDir, dataKey, clientId, clientSecret: "fixture-secret" }, ms);
    const server = await new Promise((resolve) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = "Basic " + Buffer.from(`getmail:${password}`).toString("base64");
    return (endpoint, { body, headers, unauthenticated = false } = {}) => fetch(base + endpoint, {
      redirect: "manual",
      headers: {
        ...(!unauthenticated && { Authorization: auth }),
        ...(body && { "Content-Type": "application/json", Origin: origin }),
        ...headers
      },
      ...(body && { method: "POST", body: JSON.stringify(body) })
    });
  }

  const dataDir = await mkdtemp(join(tmpdir(), "getmail-test-"));
  const key = randomBytes(32);
  const api = await start(dataDir, key);
  assert.equal((await api("/api/accounts", { unauthenticated: true })).status, 401);
  assert.equal((await api("/api/accounts/import", { body: { text: "a@example.com" }, headers: { Origin: "http://elsewhere.test" } })).status, 403);
  const imported = await (await api("/api/accounts/import", { body: { text: [
    `first@example.com----discard-this-password----${clientId}----first-token`,
    `expired@example.com--------${clientId}----expired-token`,
    `offline@example.com--------${clientId}----offline-token`,
    "pending@example.com",
    "missing@example.com----password----missing-id-token"
  ].join("\n") } })).json();
  assert.equal(imported.imported, 5);
  assert.deepEqual(calls, []);
  const [first, expired, offline, pending, missing] = imported.accounts;
  assert.equal(missing.status, "缺少 Client ID");
  assert.doesNotMatch(JSON.stringify(imported), /first-token|discard-this-password/);
  assert.doesNotMatch(await readFile(join(dataDir, "accounts.sqlite"), "utf8"), /first-token|first@example.com|discard-this-password/);

  const mailPath = `/api/accounts/${first.id}/mail`;
  const [inbox, junk] = await Promise.all([api(mailPath), api(`${mailPath}?folder=junk`)]);
  assert.equal((await inbox.json()).messages[0].subject, "For first-token");
  assert.deepEqual((await junk.json()).messages, []);
  assert.deepEqual(calls, ["first-token"]);
  assert.equal((await (await api(`${mailPath}/message%2F1%3D`)).json()).message.body, "<b>Literal text</b>");
  assert.equal((await api(`/api/accounts/${expired.id}/mail`)).status, 409);
  assert.equal((await api(`/api/accounts/${offline.id}/mail`)).status, 503);
  const statuses = (await (await api("/api/accounts")).json()).accounts;
  assert.equal(statuses.find(({ id }) => id === expired.id).needsAuth, true);
  assert.equal(statuses.find(({ id }) => id === offline.id).needsAuth, undefined);

  const credentialsPath = `/api/accounts/${first.id}/credentials`;
  assert.equal((await api(`${credentialsPath}/view`, { body: {}, unauthenticated: true })).status, 401);
  assert.equal((await api(`${credentialsPath}/view`, { body: {}, headers: { Origin: "http://elsewhere.test" } })).status, 403);
  const credentialsResponse = await api(`${credentialsPath}/view`, { body: {} });
  assert.equal(credentialsResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await credentialsResponse.json(), { clientId, refreshToken: "rotated-first-token" });
  assert.equal((await (await api(credentialsPath, { body: {} })).json()).changed, false);
  assert.equal((await api(credentialsPath, { body: {
    clientId: "00000000-0000-4000-8000-000000000002", refreshToken: "rotated-first-token"
  } })).status, 400);

  assert.equal((await api(`/api/accounts/${missing.id}/credentials`, { body: { clientId, refreshToken: "" } })).status, 200);
  assert.equal((await api(`/api/accounts/${missing.id}/mail`)).status, 200);
  async function begin() {
    const response = await api(`/api/accounts/${pending.id}/authorize`, { body: {} });
    const target = new URL((await response.json()).url);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return { target, cookie, callback: `/auth/microsoft/callback?state=${target.searchParams.get("state")}` };
  }
  for (const [error, outcome] of [["interaction_required", "interaction"], ["access_denied", "cancelled"], ["unauthorized_client", "client"]]) {
    const flow = await begin();
    const response = await api(`${flow.callback}&error=${error}&error_description=AADSTS16000`, { headers: { Cookie: flow.cookie } });
    assert.equal(response.headers.get("location"), `/?oauth=${outcome}`);
  }
  const wrong = await begin();
  assert.equal(wrong.target.origin + wrong.target.pathname, "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize");
  assert.equal(wrong.target.searchParams.get("login_hint"), pending.email);
  assert.equal((await api(`${wrong.callback}&code=wrong-user`)).headers.get("location"), "/?oauth=invalid");
  assert.equal((await api(`${wrong.callback}&code=wrong-user`, { headers: { Cookie: wrong.cookie } })).headers.get("location"), "/?oauth=mismatch");
  const right = await begin();
  const callback = await api(`${right.callback}&code=right-user`, { headers: { Cookie: right.cookie } });
  assert.equal(callback.headers.get("location"), `/?oauth=ok&account=${pending.id}`);
  assert.equal(createHash("sha256").update(codeVerifier).digest("base64url"), right.target.searchParams.get("code_challenge"));
  assert.equal((await api(`${right.callback}&code=right-user`, { headers: { Cookie: right.cookie } })).headers.get("location"), "/?oauth=invalid");
  const updated = await (await api(`/api/accounts/${pending.id}/credentials`, { body: { refreshToken: "new-app-token" } })).json();
  assert.equal(updated.accounts.find(({ id }) => id === pending.id).source, "microsoft");

  const restarted = await start(dataDir, key);
  const afterRestart = await (await restarted(mailPath)).json();
  assert.equal(afterRestart.messages[0].subject, "For rotated-first-token");
  assert.equal((await api("/api/backup/export", { body: { password: backupPassword, ids: [] } })).status, 400);
  const backup = await (await api("/api/backup/export", { body: { password: backupPassword, ids: [first.id, pending.id] } })).json();
  assert.doesNotMatch(JSON.stringify(backup), /first@example.com|rotated-first-token/);
  const destination = await start(await mkdtemp(join(tmpdir(), "getmail-restore-")));
  const filePath = "/api/accounts/import-file";
  assert.equal((await destination(`${filePath}/preview`, { body: { password: "wrong-password", backup } })).status, 400);
  const preview = await (await destination(`${filePath}/preview`, { body: { password: backupPassword, backup } })).json();
  assert.deepEqual(preview.rows.map(({ email }) => email), [first.email, pending.email]);
  assert.doesNotMatch(JSON.stringify(preview), /rotated-first-token/);
  const result = await (await destination(filePath, { body: { password: backupPassword, backup } })).json();
  assert.equal(result.imported, 2);
  assert.equal((await destination(filePath, { body: { password: backupPassword, backup } })).status, 409);
  const choices = { [first.email]: 0, [pending.email]: 2 };
  const duplicateFile = await (await destination(filePath, { body: { password: backupPassword, backup, choices } })).json();
  assert.equal(duplicateFile.skipped, 1);
  assert.deepEqual(duplicateFile.replacedIds, [result.accounts[1].id]);
  const text = "one@example.com\nONE@example.com----unused";
  assert.equal((await destination("/api/accounts/import", { body: { text } })).status, 409);
  const deduped = await (await destination("/api/accounts/import", { body: { text, choices: { "one@example.com": 2 } } })).json();
  assert.equal(deduped.imported, 1);
  assert.equal(deduped.skipped, 1);
  const moved = result.accounts.find(({ email }) => email === "first@example.com");
  assert.equal((await destination(`/api/accounts/${moved.id}/mail`)).status, 200);
  const movedPath = `/api/accounts/${moved.id}`;
  assert.equal((await destination(`${movedPath}/credentials`, { body: { email: pending.email } })).status, 409);
  assert.equal((await destination(`${movedPath}/credentials`, { body: { email: "invalid" } })).status, 400);
  const renamed = await (await destination(`${movedPath}/credentials`, { body: { email: " Fixed@Example.com " } })).json();
  assert.equal(renamed.accounts.find(({ id }) => id === moved.id).email, "fixed@example.com");
  assert.deepEqual(await (await destination(`${movedPath}/credentials/view`, { body: {} })).json(), { clientId: "", refreshToken: "" });
  assert.equal((await destination(`${movedPath}/mail`)).status, 409);
  assert.equal((await destination(`${movedPath}/remove`, { body: {}, unauthenticated: true })).status, 401);
  const removed = await (await destination(`${movedPath}/remove`, { body: {} })).json();
  assert.equal(removed.accounts.some(({ id }) => id === moved.id), false);
  assert.equal((await destination(`${movedPath}/mail`)).status, 404);
  assert.equal((await destination(`${movedPath}/remove`, { body: {} })).status, 404);

  const settingsPath = "/api/settings";
  assert.equal((await api(settingsPath, { unauthenticated: true })).status, 401);
  const newId = "00000000-0000-4000-8000-000000000002";
  assert.equal((await api(`${settingsPath}/microsoft`, { body: { clientId: newId } })).status, 400);
  const beforeChange = await begin();
  const saved = await (await api(`${settingsPath}/microsoft`, {
    body: { clientId: newId, clientSecret: "new-secret-value" }
  })).json();
  assert.equal(saved.clientId, newId);
  assert.doesNotMatch(JSON.stringify(saved), /new-secret-value/);
  assert.equal((await api(`${beforeChange.callback}&code=right-user`, { headers: { Cookie: beforeChange.cookie } })).headers.get("location"), "/?oauth=invalid");
  assert.equal((await begin()).target.searchParams.get("client_id"), newId);
  const login = { username: "owner", currentPassword: password, newPassword: "7" };
  assert.equal((await api(`${settingsPath}/login`, { body: { ...login, newPassword: "" } })).status, 400);
  assert.equal((await api(`${settingsPath}/login`, { body: { ...login, currentPassword: "incorrect" } })).status, 403);
  assert.equal((await api(`${settingsPath}/login`, { body: login })).status, 200);
  assert.equal((await api(settingsPath)).status, 401);
  const headers = { Authorization: "Basic " + Buffer.from(`owner:${login.newPassword}`).toString("base64") };
  const afterSettingsRestart = await start(dataDir, key);
  const persisted = await (await afterSettingsRestart(settingsPath, { headers })).json();
  assert.equal(persisted.clientId, newId);
  assert.equal(persisted.username, "owner");
  assert.doesNotMatch(await readFile(join(dataDir, "accounts.sqlite"), "utf8"), /new-secret-value/);
  const deployed = await start(await mkdtemp(join(tmpdir(), "getmail-deployed-")), randomBytes(32), "https://mail.example.com");
  const deployedAccounts = await (await deployed("/api/accounts/import", { body: { text: "deployed@example.com" } })).json();
  const authorize = await deployed(`/api/accounts/${deployedAccounts.accounts[0].id}/authorize`, { body: {} });
  const target = new URL((await authorize.json()).url);
  assert.equal(target.searchParams.get("redirect_uri"), "https://mail.example.com/auth/microsoft/callback");
  assert.match(authorize.headers.get("set-cookie"), /; Secure/);
});
