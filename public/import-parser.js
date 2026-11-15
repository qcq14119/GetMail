export const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~\-]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
export const clientIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export const normalizeEmail = (value) => value.trim().toLowerCase();

function readFields(fields, separator = "") {
  const [email, password = "", third = "", fourth = "", ...tail] = fields;
  const clientId = fields.length >= 4 ? third : "";
  // A recognized Client ID fixes the first three column boundaries. The token can contain the separator.
  const tokenColumn = clientIdPattern.test(clientId.trim());
  const extra = tokenColumn ? [] : tail;
  const refreshToken = fields.length === 3 ? third : tokenColumn ? [fourth, ...tail].join(separator) : fourth;
  const valid = emailPattern.test(normalizeEmail(email)) && !extra.length &&
    (fields.length < 4 || (clientIdPattern.test(clientId.trim()) && refreshToken.trim()));
  return { email, password, clientId, refreshToken, extra, valid: Boolean(valid) };
}

function automaticFields(line) {
  const candidates = [];
  let hasBoundary = false;
  for (const run of line.slice(0, 270).matchAll(/-{3,}/g)) {
    const address = line.slice(0, run.index);
    if (!emailPattern.test(normalizeEmail(address))) continue;
    hasBoundary = true;
    for (const length of [3, 4]) {
      if (run[0].length < length) continue;
      const separator = "-".repeat(length);
      const fields = [address, ...line.slice(run.index + length).split(separator)];
      const candidate = readFields(fields, separator);
      if (candidate.valid) candidates.push({ candidate, length, run, fieldCount: fields.length });
    }
  }
  // A matching Client ID makes a four-field interpretation more specific than a bare password.
  const complete = candidates.filter(({ candidate }) => candidate.clientId);
  if (complete.length === 1) return complete[0].candidate;
  if (complete.length === 0) {
    const matching = candidates.filter(({ length, run }) => run[0].length === length);
    const first = matching[0];
    if (first && !/^[a-z0-9-]+\.[a-z0-9-]+/i.test(line.slice(first.run.index + first.length)) &&
        (matching.length === 1 || matching.slice(1).every((item) => item.length === first.length && item.fieldCount < first.fieldCount))) {
      return first.candidate;
    }
  }
  return { ...readFields([line]), ambiguous: hasBoundary };
}

export function parseImport(text, separator, existing = []) {
  const seen = new Set(existing.map(normalizeEmail));
  return text.split(/\r\n|\n|\r/).flatMap((line, index) => {
    if (!line.trim()) return [];
    const row = separator ? readFields(line.split(separator), separator) : automaticFields(line);
    const email = normalizeEmail(row.email);
    const included = row.valid && !row.ambiguous && !seen.has(email);
    if (included) seen.add(email);
    return [{ ...row, line: index + 1, included }];
  });
}

export function groupImportRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.valid || row.ambiguous) continue;
    const email = normalizeEmail(row.email);
    if (!groups.has(email)) groups.set(email, []);
    groups.get(email).push(row);
  }
  return groups;
}
