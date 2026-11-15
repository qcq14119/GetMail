import { parseImport, groupImportRows, normalizeEmail } from "./import-parser.js";

const byId = (id) => document.getElementById(id);
const workbench = byId("workbench");
const search = byId("search");
const accountList = byId("account-list");
const mailList = byId("mail-list");
const reader = byId("reader");
const status = byId("status");
const refresh = byId("refresh");
const authorize = byId("reauthorize");
const currentEmail = byId("current-email");
const credentialsForm = byId("credentials-form");
const tokenField = credentialsForm.elements.refreshToken;
for (const field of document.querySelectorAll('input[type="password"]')) {
  const label = field.labels[0];
  field.id ||= `${field.form.id}-${field.name}`;
  label.htmlFor = field.id;
  const wrapper = document.createElement("div");
  wrapper.className = "secret-input";
  label.after(wrapper);
  const toggle = document.createElement("button");
  toggle.className = "secret-toggle";
  toggle.type = "button";
  const icon = document.createElement("span");
  icon.className = "eye";
  icon.setAttribute("aria-hidden", "true");
  toggle.append(icon);
  wrapper.append(field, toggle);
  const fieldName = label.textContent.trim();
  function setVisibility(visible) {
    field.type = visible ? "text" : "password";
    const action = visible ? "隐藏" : "显示";
    toggle.setAttribute("aria-label", `${action}${fieldName}`);
    toggle.title = `${action}${fieldName}`;
    toggle.setAttribute("aria-pressed", String(visible));
  }
  setVisibility(false);
  toggle.addEventListener("click", () => setVisibility(field.type === "password"));
  field.form.addEventListener("reset", () => setVisibility(false));
}
const importInput = byId("import-text");
const delimiterMode = byId("delimiter-mode");
const customDelimiter = byId("custom-delimiter");
const folders = [...document.querySelectorAll("[data-folder]")];
const viewButtons = [...document.querySelectorAll(".mobile-nav [data-view]")];
const timeFormat = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Shanghai" });
let accounts = [];
let hasOAuth = false;
let account;
let folder = "inbox";
let messages = [];
let selectedMessage;
let mailRequest;
let messageRequest;
let credentialsId;
let savedCredentials;
let exportSelection;
let fileImport;
let importFileVersion = 0;
let importChoices = new Map();

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function formattedTime(value) {
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? timeFormat.format(time) : "";
}

function setView(view) {
  workbench.dataset.view = view;
  viewButtons.forEach((button) => button.setAttribute("aria-pressed", button.dataset.view === view));
}

function setStatus(message, problem = false) {
  status.textContent = message;
  status.classList.toggle("problem", problem);
}

function notice(message, problem = false) {
  const node = byId("notice");
  node.textContent = message;
  node.hidden = !message;
  node.classList.toggle("problem", problem);
}

async function api(path, { body, signal } = {}) {
  const response = await fetch(path, {
    signal,
    ...(body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {})
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    throw Object.assign(new Error(data?.error || "请求未完成，请重试。"), { status: response.status });
  }
  return data;
}

function renderToken() {
  const panel = byId("token-status").parentElement;
  panel.hidden = !account;
  byId("current-mailbox").hidden = !account;
  if (currentEmail.textContent !== (account?.email || "")) currentEmail.textContent = account?.email || "";
  refresh.disabled = !account;
  folders.forEach((button) => {
    button.disabled = !account;
    button.setAttribute("aria-pressed", button.dataset.folder === folder);
  });
  if (!account) return;
  byId("token-status").textContent = account.status;
  byId("token-status").classList.toggle("problem", account.needsAuth || account.status === "缺少 Client ID");
  const dates = [];
  if (account.status !== "待授权") dates.push("刷新令牌到期时间未知");
  if (account.checkedAt) dates.push(`上次验证 ${formattedTime(account.checkedAt)}`);
  if (account.accessExpiresAt) dates.push(`访问令牌预计到期 ${formattedTime(account.accessExpiresAt)}`);
  if (dates.length > 1) dates.push("北京时间");
  if (!hasOAuth) dates.push("微软授权待配置");
  byId("token-dates").textContent = dates.join(" · ");
  authorize.disabled = false;
  authorize.textContent = account.status === "待授权" ? "用 Microsoft 授权" : "用 Microsoft 重新授权";
}

function renderAccounts() {
  const query = search.value.trim().toLowerCase();
  const matches = accounts.filter((item) => item.email.includes(query));
  accountList.replaceChildren();
  byId("account-count").textContent = `${accounts.length} 个`;
  for (const item of matches) {
    const row = element("div", "", "row account");
    row.dataset.id = item.id;
    const button = element("button", "", "account-action");
    button.type = "button";
    button.setAttribute("aria-labelledby", `email-${item.id}`);
    button.setAttribute("aria-describedby", `mailbox-status-${item.id}`);
    button.setAttribute("aria-pressed", exportSelection ? exportSelection.has(item.id) : item.id === account?.id);
    const caption = element("span", "", "account-caption");
    const email = element("strong", item.email, "account-address");
    email.id = `email-${item.id}`;
    email.dir = "ltr";
    const mailboxStatus = element("span", item.status, "muted");
    mailboxStatus.id = `mailbox-status-${item.id}`;
    caption.append(email, mailboxStatus);
    const marker = exportSelection ? element("span", exportSelection.has(item.id) ? "✓" : "", "export-check") :
      element("span", item.email[0].toUpperCase(), "avatar");
    marker.setAttribute("aria-hidden", "true");
    row.append(button, marker, caption);
    if (exportSelection) row.dataset.selecting = "";
    let previousSelection = "";
    email.addEventListener("pointerdown", () => {
      previousSelection = window.getSelection()?.toString() || "";
    });
    email.addEventListener("click", () => {
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.containsNode(email, true) && selection.toString() !== previousSelection) return;
      button.click();
    });
    button.addEventListener("click", () => {
      if (!exportSelection) return selectAccount(item.id);
      if (exportSelection.has(item.id)) exportSelection.delete(item.id);
      else exportSelection.add(item.id);
      button.setAttribute("aria-pressed", exportSelection.has(item.id));
      marker.textContent = exportSelection.has(item.id) ? "✓" : "";
      renderExportActions();
    });
    accountList.append(row);
  }
  if (!matches.length) accountList.append(element("p", accounts.length ? "没有匹配的邮箱。" : "导入邮箱后即可取件。", "empty"));
  renderExportActions();
}

function renderExportActions() {
  byId("export-actions").hidden = !exportSelection;
  byId("open-export").disabled = !accounts.length || Boolean(exportSelection);
  if (!exportSelection) return;
  const all = accounts.length > 0 && accounts.every(({ id }) => exportSelection.has(id));
  byId("export-all").textContent = all ? "取消全选" : "全选";
  const download = byId("open-export-dialog");
  download.disabled = exportSelection.size === 0;
  download.textContent = exportSelection.size ? `导出所选（${exportSelection.size}）` : "导出所选";
}

byId("open-export").addEventListener("click", () => {
  exportSelection = new Set();
  setView("accounts");
  renderAccounts();
  byId("export-all").focus();
});
byId("export-all").addEventListener("click", () => {
  exportSelection = accounts.every(({ id }) => exportSelection.has(id)) ? new Set() : new Set(accounts.map(({ id }) => id));
  renderAccounts();
});
byId("cancel-export").addEventListener("click", () => {
  exportSelection = undefined;
  renderAccounts();
  byId("open-export").focus();
});

function renderReader(message, placeholder = "选择一封邮件查看正文。") {
  reader.replaceChildren();
  if (!message) {
    reader.append(element("p", placeholder, "empty"));
    return;
  }
  const letter = element("article", "", "letter");
  const sender = element("div", "", "sender-line");
  const identity = element("div");
  identity.append(element("b", message.sender), element("span", message.address, "muted"));
  sender.append(element("span", message.sender?.[0], "avatar"), identity, element("time", formattedTime(message.receivedDateTime)));
  letter.append(element("h3", message.subject), sender, element("p", message.body || "（无正文）", "letter-body"));
  reader.append(letter);
}

function renderMessages() {
  mailList.replaceChildren();
  for (const message of messages) {
    const button = element("button", "", "row mail");
    button.type = "button";
    button.setAttribute("aria-pressed", message.id === selectedMessage);
    const line = element("span", "", "subject-line");
    line.append(element("strong", message.subject, "mail-title"), element("time", formattedTime(message.receivedDateTime)));
    button.append(line, element("span", message.sender, "muted"), element("span", message.snippet, "snippet"));
    button.addEventListener("click", () => openMessage(message.id, button));
    mailList.append(button);
  }
}

function updateAccount(updated) {
  const index = accounts.findIndex(({ id }) => id === updated.id);
  if (index !== -1) accounts[index] = updated;
  if (account?.id === updated.id) {
    account = updated;
    renderToken();
    const current = [...accountList.children].find((row) => row.dataset.id === updated.id);
    if (current) current.querySelector(".muted").textContent = updated.status;
  }
}

function replaceAccounts(items) {
  accounts = items;
  account = accounts.find(({ id }) => id === account?.id);
  renderAccounts();
  renderToken();
}

function selectAccount(id) {
  account = accounts.find((item) => item.id === id);
  if (!account) return;
  folder = "inbox";
  if (!exportSelection) {
    for (const row of accountList.children) row.querySelector(".account-action")?.setAttribute("aria-pressed", row.dataset.id === id);
  }
  setView("mail");
  fetchFolder();
  if (window.matchMedia("(max-width: 820px)").matches) refresh.focus();
}

async function fetchFolder() {
  mailRequest?.abort();
  messageRequest?.abort();
  messages = [];
  selectedMessage = undefined;
  renderToken();
  renderMessages();
  renderReader();
  if (!account) return setStatus("从邮箱列表选择一个账号。");
  const { id } = account;
  const controller = new AbortController();
  mailRequest = controller;
  setStatus("正在取件…");
  try {
    const data = await api(`/api/accounts/${id}/mail?folder=${folder}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    messages = data.messages;
    updateAccount(data.account);
    renderMessages();
    setStatus(messages.length ? `最近 ${messages.length} 封` : "此文件夹暂无邮件");
  } catch (error) {
    if (controller.signal.aborted) return;
    setStatus(error.message, true);
    try {
      const data = await api("/api/accounts", { signal: controller.signal });
      const latest = data.accounts.find((item) => item.id === id);
      if (latest && !controller.signal.aborted) updateAccount(latest);
    } catch { /* Keep the original fetch error visible. */ }
  }
}

async function openMessage(id, button) {
  messageRequest?.abort();
  const controller = new AbortController();
  messageRequest = controller;
  selectedMessage = id;
  for (const row of mailList.children) row.setAttribute("aria-pressed", row === button);
  setView("reader");
  if (window.matchMedia("(max-width: 820px)").matches) viewButtons[2].focus();
  renderReader(null, "正在读取正文…");
  try {
    const data = await api(`/api/accounts/${account.id}/mail/${encodeURIComponent(id)}`, { signal: controller.signal });
    if (controller.signal.aborted) return;
    updateAccount(data.account);
    renderReader(data.message);
  } catch (error) {
    if (!controller.signal.aborted) renderReader(null, error.message);
  }
}

function previewImport() {
  const custom = delimiterMode.value === "custom";
  customDelimiter.disabled = !custom;
  byId("custom-delimiter-field").hidden = !custom;
  const separator = custom ? customDelimiter.value : "";
  const fromFile = Boolean(fileImport);
  const rows = fromFile ? fileImport?.rows || [] : custom && !separator ? [] : parseImport(importInput.value, separator);
  const groups = groupImportRows(rows);
  const existing = new Set(accounts.map(({ email }) => email));
  const results = byId("import-results");
  const header = byId("import-headings");
  const hasExtra = rows.some((row) => row.extra?.length);
  header.replaceChildren();
  for (const label of ["行", "账号", ...(fromFile ? [] : ["密码"]), "Client ID", "Refresh Token", ...(hasExtra ? ["其他字段"] : []), "本次导入"]) {
    const heading = element("th", label);
    heading.scope = "col";
    header.append(heading);
  }
  const fragment = document.createDocumentFragment();
  let included = 0;
  let pending = false;
  for (const [email, candidates] of groups) {
    const conflict = existing.has(email) || candidates.length > 1;
    const choice = importChoices.get(email);
    if (conflict && choice === undefined) pending = true;
    else if (choice !== 0) included += 1;
  }
  for (const row of rows) {
    const tr = element("tr");
    const email = normalizeEmail(row.email);
    const candidates = groups.get(email);
    const valid = candidates?.includes(row);
    const conflict = valid && (existing.has(email) || candidates.length > 1);
    const values = [String(row.line), row.email, ...(fromFile ? [] : [row.password]), row.clientId,
      fromFile ? (row.hasToken ? "已包含" : "—") : row.refreshToken];
    if (hasExtra) values.push(row.extra?.join(separator || " / "));
    values.forEach((value, index) => {
      const hiddenField = !fromFile && (index === 2 || index === 4);
      const cell = element("td", hiddenField && value ? "" : value || "—");
      if (hiddenField && value) {
        const reveal = element("details", "", "import-secret");
        reveal.append(element("summary", "查看"), element("code", value));
        cell.append(reveal);
      }
      tr.append(cell);
    });
    const decision = element("td", valid && !conflict ? "是" : "—");
    if (conflict && candidates[0] === row) {
      const select = element("select");
      select.setAttribute("aria-label", `保留 ${email}`);
      const placeholder = new Option("选择保留版本", "");
      placeholder.disabled = true;
      select.add(placeholder);
      if (existing.has(email)) select.add(new Option("保留现有账号", "0"));
      for (const candidate of candidates) {
        const label = candidates.length === 1 ? "使用导入的账号" : `使用第 ${candidate.line} 行`;
        select.add(new Option(label, String(candidate.line)));
      }
      select.value = String(importChoices.get(email) ?? "");
      select.addEventListener("change", () => {
        importChoices.set(email, Number(select.value));
        previewImport();
        [...results.querySelectorAll("select")].find((item) => item.getAttribute("aria-label") === select.getAttribute("aria-label"))?.focus();
      });
      decision.replaceChildren(select);
    }
    tr.append(decision);
    fragment.append(tr);
  }
  results.replaceChildren(fragment);
  byId("import-preview").hidden = !rows.length && (fromFile || !custom || Boolean(separator));
  byId("import-table").hidden = !rows.length;
  byId("import-summary").textContent = pending ? "请为重复邮箱选择要保留的版本。" :
    !fromFile && custom && !separator ? "输入分隔符后显示预览。" : rows.some((row) => row.ambiguous) ?
    `共 ${rows.length} 行 · 可用自定义分隔符核对未拆开的行。` : `共 ${rows.length} 行`;
  const save = byId("save-import");
  save.disabled = pending || !included;
  save.textContent = included ? `导入 ${included} 个邮箱` : "导入邮箱";
}

const importDialog = byId("import-dialog");
const importForm = byId("import-form");
const importDrop = byId("import-drop");
const fileName = byId("import-file-name");
const fileButton = byId("preview-file");
const fileInput = byId("account-file");
const filePassword = byId("account-file-password");
const importError = importForm.querySelector(".problem");

function showImportFile(name = "") {
  const encrypted = Boolean(fileImport);
  byId("import-file-fields").hidden = !encrypted;
  byId("import-text-label").hidden = encrypted;
  byId("import-delimiter").hidden = encrypted;
  byId("import-drop-hint").hidden = encrypted;
  importInput.hidden = encrypted;
  fileName.textContent = name;
  fileName.hidden = !name;
  importError.hidden = true;
  importChoices.clear();
  previewImport();
}

function resetImportFile() {
  importFileVersion += 1;
  fileImport = undefined;
  fileInput.value = "";
  filePassword.value = "";
  fileButton.disabled = false;
  importDrop.removeAttribute("data-dragging");
  showImportFile();
}

function reportImportError(message) {
  importError.textContent = message;
  importError.hidden = false;
}

async function readImportFile(file) {
  if (!file || importForm.hasAttribute("aria-busy")) return;
  const version = ++importFileVersion;
  importError.hidden = true;
  const isCurrent = () => version === importFileVersion && importDialog.open && !importForm.hasAttribute("aria-busy");
  try {
    if (file.size > 8_000_000) throw new Error("文件太大，请分批导入。");
    const content = await file.text();
    if (!isCurrent()) return;
    if (/\.json$/i.test(file.name) || /^\s*\{/.test(content)) {
      const backup = JSON.parse(content);
      if (backup?.format !== "getmail-backup") throw new Error("请选择 GetMail 导出的加密备份，或导入 TXT。");
      fileImport = { backup, rows: [] };
      filePassword.value = "";
      fileButton.disabled = false;
      showImportFile(file.name);
      filePassword.focus();
    } else {
      if (content.length > importInput.maxLength) throw new Error("账号文本太长，请分批导入。");
      if (content.includes("\0")) throw new Error("无法读取此文本，请保存为 UTF-8 编码的 TXT。");
      fileImport = undefined;
      filePassword.value = "";
      importInput.value = content;
      showImportFile(file.name);
    }
  } catch (error) {
    if (isCurrent()) reportImportError(error instanceof SyntaxError ? "无法读取加密备份。" : error.message);
  }
}

byId("choose-import-file").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  fileInput.value = "";
  readImportFile(file);
});
byId("clear-import-file").addEventListener("click", () => {
  resetImportFile();
  importInput.focus();
});
importDialog.addEventListener("dragover", (event) => {
  if (!event.dataTransfer.types.includes("Files")) return;
  event.preventDefault();
  if (!importForm.hasAttribute("aria-busy")) importDrop.setAttribute("data-dragging", "");
});
importDialog.addEventListener("dragleave", (event) => {
  if (!importDialog.contains(event.relatedTarget)) importDrop.removeAttribute("data-dragging");
});
importDialog.addEventListener("drop", (event) => {
  importDrop.removeAttribute("data-dragging");
  if (!event.dataTransfer.files.length) return;
  event.preventDefault();
  if (event.dataTransfer.files.length > 1) return reportImportError("请每次拖入一个文件。");
  readImportFile(event.dataTransfer.files[0]);
});
filePassword.addEventListener("input", () => {
  if (!fileImport) return;
  fileImport.rows = [];
  importError.hidden = true;
  importChoices.clear();
  previewImport();
});
filePassword.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  fileButton.click();
});
fileButton.addEventListener("click", async () => {
  const selected = fileImport;
  if (!selected) return;
  importError.hidden = true;
  fileButton.disabled = true;
  const password = filePassword.value;
  try {
    const data = await api("/api/accounts/import-file/preview", { body: { password, backup: selected.backup } });
    if (!importDialog.open || selected !== fileImport || password !== filePassword.value) return;
    selected.rows = data.rows;
    importChoices.clear();
    replaceAccounts(data.accounts);
    previewImport();
  } catch (error) {
    if (importDialog.open && selected === fileImport && password === filePassword.value) reportImportError(error.message);
  } finally {
    if (selected === fileImport) fileButton.disabled = false;
  }
});

function wireDialog(name, submit, prepare, clear, trigger = `open-${name}`) {
  const dialog = byId(`${name}-dialog`);
  const form = byId(`${name}-form`);
  const errorNode = form.querySelector(".problem");
  let busy = false;
  byId(trigger).addEventListener("click", async () => {
    if (busy) return;
    form.reset();
    errorNode.hidden = true;
    if (prepare) {
      busy = true;
      try {
        if (!await prepare()) return;
      } catch (error) {
        notice(error.message, true);
        return;
      } finally {
        busy = false;
      }
    }
    if (name === "import") previewImport();
    dialog.showModal();
  });
  for (const button of form.querySelectorAll("[data-close]")) {
    button.addEventListener("click", () => { if (!busy) dialog.close(); });
  }
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    form.reset();
    errorNode.textContent = "";
    clear?.();
    if (name === "import") previewImport();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || form.querySelector('[type="submit"]')?.disabled) return;
    const values = Object.fromEntries(new FormData(form));
    const fields = [...form.elements].filter((item) => !item.disabled);
    for (const field of fields) field.disabled = true;
    form.setAttribute("aria-busy", "true");
    busy = true;
    errorNode.hidden = true;
    try {
      await submit(values);
      dialog.close();
    } catch (error) {
      errorNode.textContent = error.message;
      errorNode.hidden = false;
    } finally {
      busy = false;
      form.removeAttribute("aria-busy");
      for (const field of fields) field.disabled = false;
      if (name === "import" && dialog.open) previewImport();
    }
  });
}

wireDialog("import", async () => {
  const fromFile = Boolean(fileImport);
  const choices = Object.fromEntries(importChoices);
  const body = fromFile ? { password: filePassword.value, backup: fileImport.backup, choices } :
    { text: importInput.value, separator: delimiterMode.value === "custom" ? customDelimiter.value : "", choices };
  let data;
  try {
    data = await api(fromFile ? "/api/accounts/import-file" : "/api/accounts/import", { body });
  } catch (error) {
    if (error.status === 409) {
      importChoices.clear();
      replaceAccounts((await api("/api/accounts")).accounts);
    }
    throw error;
  }
  search.value = "";
  replaceAccounts(data.accounts);
  setView("accounts");
  if (data.replacedIds.includes(account?.id)) {
    mailRequest?.abort();
    messageRequest?.abort();
    messages = [];
    selectedMessage = undefined;
    renderMessages();
    renderReader();
    setStatus("邮箱授权已更新，点击邮箱重新取件。");
  }
  notice(`已导入 ${data.imported} 个邮箱。`);
}, () => {
  resetImportFile();
  return true;
}, resetImportFile);
wireDialog("credentials", async (values) => {
  for (const field of ["clientId", "refreshToken"]) {
    if (values[field].trim() === savedCredentials[field]) values[field] = "";
  }
  const data = await api(`/api/accounts/${credentialsId}/credentials`, { body: values });
  replaceAccounts(data.accounts);
  if (data.changed) {
    notice("已保存邮箱。");
    if (account?.id === credentialsId) fetchFolder();
  }
}, async () => {
  const selected = account;
  if (!selected) return false;
  const saved = await api(`/api/accounts/${selected.id}/credentials/view`, { body: {} });
  if (account?.id !== selected.id) return false;
  credentialsId = selected.id;
  credentialsForm.elements.email.value = selected.email;
  credentialsForm.elements.clientId.value = saved.clientId;
  savedCredentials = { ...saved, email: selected.email };
  byId("rename-hint").hidden = true;
  tokenField.value = saved.refreshToken;
  return true;
}, () => {
  savedCredentials = undefined;
  credentialsId = undefined;
});
credentialsForm.elements.email.addEventListener("input", () => {
  byId("rename-hint").hidden = normalizeEmail(credentialsForm.elements.email.value) === savedCredentials?.email;
});
wireDialog("remove-account", async () => {
  const id = credentialsId;
  const data = await api(`/api/accounts/${id}/remove`, { body: {} });
  exportSelection?.delete(id);
  if (account?.id === id) {
    mailRequest?.abort();
    messageRequest?.abort();
    messages = [];
    selectedMessage = undefined;
    renderMessages();
    renderReader();
    setStatus("从邮箱列表选择一个账号。");
    setView("accounts");
  }
  replaceAccounts(data.accounts);
  byId("credentials-dialog").close();
  notice("已移除邮箱。");
  requestAnimationFrame(() => search.focus());
}, () => {
  if (!credentialsId) return false;
  byId("remove-account-address").textContent = savedCredentials.email;
  return true;
});
wireDialog("export", async ({ password }) => {
  const backup = await api("/api/backup/export", { body: { password, ids: [...exportSelection] } });
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
  const link = element("a");
  link.href = url;
  link.download = `getmail-accounts-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  exportSelection = undefined;
  renderAccounts();
}, () => {
  byId("export-count").textContent = `导出 ${exportSelection.size} 个邮箱。`;
  return true;
}, undefined, "open-export-dialog");

const settingsDialog = byId("settings-dialog");
const settingsStatus = byId("settings-status");
const microsoftForm = byId("microsoft-settings-form");
const loginForm = byId("login-settings-form");
let settingsBusy = false;

function settingsMessage(message, problem = false) {
  settingsStatus.textContent = message;
  settingsStatus.classList.toggle("problem", problem);
}

function showSettingsTab(tab) {
  for (const [name, form] of [["microsoft", microsoftForm], ["login", loginForm]]) {
    form.hidden = name !== tab;
    byId(`settings-${name}`).setAttribute("aria-pressed", name === tab);
  }
  settingsMessage("");
}

function fillSettings(data) {
  hasOAuth = data.hasOAuth;
  loginForm.elements.username.value = data.username;
  microsoftForm.elements.redirectUri.value = data.redirectUri;
  microsoftForm.elements.clientId.value = data.clientId;
  microsoftForm.elements.clientSecret.value = "";
  byId("secret-hint").textContent = hasOAuth ? "客户端 ID 相同时，密钥留空可沿用。" : "填写 Entra 中的密钥「值」。";
  renderToken();
}

async function openSettings() {
  if (settingsBusy || settingsDialog.open) return;
  settingsBusy = true;
  try {
    fillSettings(await api("/api/settings"));
    showSettingsTab("microsoft");
    settingsDialog.showModal();
  } catch (error) {
    notice(error.message, true);
  } finally {
    settingsBusy = false;
  }
}

byId("open-settings").addEventListener("click", openSettings);
for (const tab of ["microsoft", "login"]) {
  byId(`settings-${tab}`).addEventListener("click", () => { if (!settingsBusy) showSettingsTab(tab); });
}
settingsDialog.addEventListener("cancel", (event) => { if (settingsBusy) event.preventDefault(); });
settingsDialog.addEventListener("close", () => { microsoftForm.reset(); loginForm.reset(); });
for (const [kind, form] of [["microsoft", microsoftForm], ["login", loginForm]]) {
  form.querySelector("[data-close-settings]").addEventListener("click", () => { if (!settingsBusy) settingsDialog.close(); });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (settingsBusy) return;
    settingsBusy = true;
    const save = form.querySelector("[type=submit]");
    save.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      delete values.redirectUri;
      const data = await api(`/api/settings/${kind}`, { body: values });
      if (kind === "microsoft") {
        fillSettings(data);
        settingsMessage("已保存。现在可为邮箱发起 Microsoft 授权。");
      } else {
        loginForm.reset();
        loginForm.elements.username.value = data.username;
        settingsMessage(`已更新。请用 ${data.username} 和新密码重新登录。`);
      }
    } catch (error) {
      settingsMessage(error.message, true);
    } finally {
      settingsBusy = false;
      save.disabled = false;
    }
  });
}

authorize.addEventListener("click", async () => {
  if (!account) return;
  if (!hasOAuth) {
    await openSettings();
    return;
  }
  authorize.disabled = true;
  try {
    const { url } = await api(`/api/accounts/${account.id}/authorize`, { body: {} });
    window.location.assign(url);
  } catch (error) {
    notice(error.message, true);
    authorize.disabled = false;
  }
});
refresh.addEventListener("click", fetchFolder);
byId("copy-email").addEventListener("click", async () => {
  const email = currentEmail.textContent;
  if (!email) return;
  try {
    await navigator.clipboard.writeText(email);
    notice(`已复制 ${email}。`);
  } catch {
    if (currentEmail.textContent !== email) return;
    const range = document.createRange();
    range.selectNodeContents(currentEmail);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    notice("已选中邮箱地址，请按 Ctrl+C 或使用系统复制菜单。");
  }
});
search.addEventListener("input", renderAccounts);
folders.forEach((button) => button.addEventListener("click", () => {
  folder = button.dataset.folder;
  fetchFolder();
}));
viewButtons.forEach((button) => button.addEventListener("click", () => setView(button.dataset.view)));
importInput.addEventListener("input", () => {
  importFileVersion += 1;
  showImportFile();
});
for (const input of [customDelimiter, delimiterMode]) input.addEventListener("input", () => {
  importError.hidden = true;
  importChoices.clear();
  previewImport();
});

const callback = new URLSearchParams(window.location.search);
const oauth = callback.get("oauth");
if (oauth) {
  history.replaceState(null, "", "/");
  const outcomes = {
    ok: "微软授权已保存。", cancelled: "微软授权已取消。", invalid: "授权请求已失效，请重新开始。",
    mismatch: "授权时选择的微软账号与当前邮箱不匹配。", unavailable: "暂时无法连接微软，请重试。",
    interaction: "微软需要再次确认登录。请从邮箱列表重新授权，并在微软页面选择该邮箱。",
    client: "微软未接受应用配置。请核对客户端 ID、客户端密钥和应用支持的账号类型。",
    scope: "微软未授予读取权限。请核对应用的 Mail.Read 和 User.Read 委托权限。",
    failed: "微软授权未完成，请检查应用配置后重试。"
  };
  notice(outcomes[oauth] || outcomes.failed, oauth !== "ok");
}
renderToken();
renderReader();
setStatus("从邮箱列表选择一个账号。");
try {
  const data = await api("/api/accounts");
  hasOAuth = data.hasOAuth;
  replaceAccounts(data.accounts);
  if (oauth === "ok") selectAccount(callback.get("account"));
} catch (error) {
  notice(error.message, true);
}
