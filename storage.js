import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);

function seal(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

function unseal(encoded, key, context) {
  const data = Buffer.from(encoded, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString("utf8"));
}

export function openStore(directory, key) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, "accounts.sqlite"));
  db.exec("PRAGMA busy_timeout = 3000; CREATE TABLE IF NOT EXISTS vault (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)");
  const read = db.prepare("SELECT data FROM vault WHERE id = 1");
  const write = db.prepare("UPDATE vault SET data = ? WHERE id = 1");
  const context = "getmail:vault:1";
  db.prepare("INSERT OR IGNORE INTO vault (id, data) VALUES (1, ?)").run(seal([], key, context));
  const all = () => unseal(read.get().data, key, context);
  all();
  db.exec("CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)");
  const readSettings = db.prepare("SELECT data FROM settings WHERE id = 1");
  const writeSettings = db.prepare("INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data");
  const settingsContext = "getmail:settings:1";
  return {
    all,
    loadSettings() {
      const row = readSettings.get();
      return row ? unseal(row.data, key, settingsContext) : {};
    },
    saveSettings(settings) {
      writeSettings.run(seal(settings, key, settingsContext));
    },
    change(edit) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const accounts = all();
        const result = edit(accounts);
        write.run(seal(accounts, key, context));
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export async function exportBackup(accounts, password) {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 32);
  return { format: "getmail-backup", version: 1, salt: salt.toString("base64"), data: seal(accounts, key, "getmail:backup:1") };
}

export async function readBackup(backup, password) {
  if (backup?.format !== "getmail-backup" || backup.version !== 1 ||
      typeof backup.salt !== "string" || typeof backup.data !== "string") throw new Error("Backup format");
  const salt = Buffer.from(backup.salt, "base64");
  if (salt.length !== 16) throw new Error("Backup salt");
  const key = await deriveKey(password, salt, 32);
  return unseal(backup.data, key, "getmail:backup:1");
}
