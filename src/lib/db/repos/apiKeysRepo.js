import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { keyAccessFromColumns, keyAccessToColumns } from "@/shared/utils/keyAccess.js";
import { KEY_ACCESS_UNRESTRICTED } from "@/shared/constants/keyAccess.js";

const listCol = (v) => (Array.isArray(v) && v.length ? stringifyJson(v) : null);
const MAX_LIMIT = 1_000_000;

export function normalizeApiKeyLimits(data = {}) {
  const result = {};
  if (Object.hasOwn(data, "expiredAt")) {
    if (data.expiredAt === null) result.expiredAt = null;
    else if (typeof data.expiredAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(data.expiredAt) || !Number.isFinite(Date.parse(data.expiredAt))) {
      throw new TypeError("expiredAt must be null or a valid ISO date-time");
    } else result.expiredAt = new Date(data.expiredAt).toISOString();
  }
  for (const field of ["limitConcurrent", "rpm"]) {
    if (!Object.hasOwn(data, field)) continue;
    const value = data[field] ?? 0;
    if (!Number.isInteger(value) || value < 0 || value > MAX_LIMIT) {
      throw new TypeError(`${field} must be an integer from 0 to ${MAX_LIMIT}`);
    }
    result[field] = value;
  }
  return result;
}

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    isActive: row.isActive === 1 || row.isActive === true,
    expiredAt: row.expiredAt || null,
    limitConcurrent: Number(row.limitConcurrent) || 0,
    rpm: Number(row.rpm) || 0,
    createdAt: row.createdAt,
    allowedModels: parseJson(row.allowedModels, []) || [],
    allowedEndpoints: parseJson(row.allowedEndpoints, []) || [],
    access: keyAccessFromColumns(row.accessRestricted, row.accessAllow),
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

// Used by the /v1 handlers to read the presented key's access settings.
export async function getApiKeyByKey(key) {
  if (!key) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, settings = {}) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const limits = normalizeApiKeyLimits(settings);
  const apiKey = {
    id: uuidv4(),
    name,
    key: result.key,
    machineId,
    isActive: true,
    expiredAt: limits.expiredAt ?? null,
    limitConcurrent: limits.limitConcurrent ?? 0,
    rpm: limits.rpm ?? 0,
    createdAt: new Date().toISOString(),
    access: { restricted: false, allow: [] },
  };
  const cols = keyAccessToColumns(KEY_ACCESS_UNRESTRICTED);
  db.run(
    `INSERT INTO apiKeys(id, key, name, machineId, isActive, expiredAt, limitConcurrent, rpm, createdAt, accessRestricted, accessAllow) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, 1, apiKey.expiredAt, apiKey.limitConcurrent, apiKey.rpm, apiKey.createdAt, cols.accessRestricted, cols.accessAllow]
  );
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data, ...normalizeApiKeyLimits(data) };
    const cols = keyAccessToColumns(merged.access);
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, isActive = ?, expiredAt = ?, limitConcurrent = ?, rpm = ?, allowedModels = ?, allowedEndpoints = ?, accessRestricted = ?, accessAllow = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.isActive ? 1 : 0, merged.expiredAt, merged.limitConcurrent, merged.rpm, listCol(merged.allowedModels), listCol(merged.allowedEndpoints), cols.accessRestricted, cols.accessAllow, id]
    );
    result = rowToKey(db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]));
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive, expiredAt FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  const active = row.isActive === 1 || row.isActive === true;
  return active && (!row.expiredAt || Date.parse(row.expiredAt) > Date.now());
}
