// Precedence: defaults < user config (~/.config/arkui-sem/config.json or ARKUI_SEM_CONFIG; API keys go here)
// < project .opencode/arkui-sem.json (no secrets) < env (ARKUI_SEM_*, DEEPSEEK_API_KEY, …) < plugin options.
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

export interface Credentials {
  deepseekApiKey?: string;
  deepseekBaseUrl?: string;
  typesafeApiKey?: string;
  layaBaseUrl?: string;
  layaModel?: string;
  cloudflareAccountId?: string;
  cloudflareApiToken?: string;
  openrouterApiKey?: string;
  openrouterBaseUrl?: string;
}

export interface Settings {
  backend: string;
  /** On session.idle, send one follow-up while confident findings remain. */
  gate: boolean;
  thresholds: { finding: number; question: number };
  judgeTimeoutMs: number;
  dataDir: string;
  credentials: Credentials;
  sources: string[];
  warnings: string[];
}

export interface ConfigFile {
  backend?: string;
  gate?: boolean;
  findingThreshold?: number;
  questionThreshold?: number;
  judgeTimeoutMs?: number;
  dataDir?: string;
  deepseek?: { apiKey?: string; baseUrl?: string };
  typesafe?: { apiKey?: string };
  laya?: { baseUrl?: string; model?: string };
  cloudflare?: { accountId?: string; apiToken?: string };
  openrouter?: { apiKey?: string; baseUrl?: string };
}

const SCHEMA: Record<string, "string" | "boolean" | "number" | Record<string, "string">> = {
  $schema: "string",
  backend: "string",
  gate: "boolean",
  findingThreshold: "number",
  questionThreshold: "number",
  judgeTimeoutMs: "number",
  dataDir: "string",
  deepseek: { apiKey: "string", baseUrl: "string" },
  typesafe: { apiKey: "string" },
  laya: { baseUrl: "string", model: "string" },
  cloudflare: { accountId: "string", apiToken: "string" },
  openrouter: { apiKey: "string", baseUrl: "string" },
};
const SECRET_KEYS = new Set(["deepseek.apiKey", "typesafe.apiKey", "cloudflare.apiToken", "openrouter.apiKey"]);

export const userConfigPath = () => process.env.ARKUI_SEM_CONFIG ?? join(homedir(), ".config", "arkui-sem", "config.json");
export const projectConfigPath = (projectDir: string) => join(projectDir, ".opencode", "arkui-sem.json");

/** Invalid entries are dropped with a warning, never thrown. */
function readConfig(path: string, scope: "user" | "project", warnings: string[]): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    warnings.push(`${path}: not valid JSON (${(e as Error).message}); ignored`);
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`${path}: expected a JSON object; ignored`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const expected = SCHEMA[key];
    if (!expected) { warnings.push(`${path}: unknown key "${key}"`); continue; }
    if (typeof expected === "string") {
      if (typeof value === expected) out[key] = value;
      else warnings.push(`${path}: "${key}" should be a ${expected}`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) { warnings.push(`${path}: "${key}" should be an object`); continue; }
    const section: Record<string, string> = {};
    for (const [sub, subValue] of Object.entries(value)) {
      if (!expected[sub]) { warnings.push(`${path}: unknown key "${key}.${sub}"`); continue; }
      if (typeof subValue !== "string") { warnings.push(`${path}: "${key}.${sub}" should be a string`); continue; }
      section[sub] = subValue;
      if (scope === "project" && SECRET_KEYS.has(`${key}.${sub}`)) {
        warnings.push(`${path}: "${key}.${sub}" is a secret in a project file that may be committed; move it to ${userConfigPath()}`);
      }
    }
    out[key] = section;
  }
  return out as ConfigFile;
}

const env = (key: string) => { const v = process.env[key]; return v === undefined || v === "" ? undefined : v; };
const num = (v: unknown) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? undefined : Number(v));
const bool = (v: unknown) => (v === undefined || v === "" ? undefined : v !== false && v !== "false" && v !== "0");
const first = <T>(...values: (T | undefined)[]) => values.find((v) => v !== undefined);

export function loadSettings(options: Record<string, unknown> = {}, projectDir: string = process.cwd()): Settings {
  const warnings: string[] = [];
  const sources: string[] = [];
  const read = (path: string, scope: "user" | "project") => {
    const c = readConfig(path, scope, warnings);
    if (c) sources.push(path);
    return c ?? {};
  };
  const user = read(userConfigPath(), "user");
  const project = read(projectConfigPath(projectDir), "project");
  const o = options as ConfigFile;

  return {
    backend: first(o.backend, env("ARKUI_SEM_BACKEND"), project.backend, user.backend) ?? "clef",
    gate: first(bool(o.gate), bool(env("ARKUI_SEM_GATE")), project.gate, user.gate) ?? true,
    thresholds: {
      finding: first(num(o.findingThreshold), num(env("ARKUI_SEM_FINDING_THRESHOLD")), project.findingThreshold, user.findingThreshold) ?? 0.8,
      question: first(num(o.questionThreshold), num(env("ARKUI_SEM_QUESTION_THRESHOLD")), project.questionThreshold, user.questionThreshold) ?? 0.5,
    },
    judgeTimeoutMs: first(num(o.judgeTimeoutMs), num(env("ARKUI_SEM_JUDGE_TIMEOUT_MS")), project.judgeTimeoutMs, user.judgeTimeoutMs) ?? 8000,
    dataDir: first(o.dataDir, env("ARKUI_SEM_DATA_DIR"), project.dataDir, user.dataDir) ?? join(homedir(), ".cache", "arkui-sem"),
    credentials: {
      deepseekApiKey: first(o.deepseek?.apiKey, env("DEEPSEEK_API_KEY"), project.deepseek?.apiKey, user.deepseek?.apiKey),
      deepseekBaseUrl: first(o.deepseek?.baseUrl, env("DEEPSEEK_BASE_URL"), project.deepseek?.baseUrl, user.deepseek?.baseUrl),
      typesafeApiKey: first(o.typesafe?.apiKey, env("TYPESAFE_API_KEY"), project.typesafe?.apiKey, user.typesafe?.apiKey),
      layaBaseUrl: first(o.laya?.baseUrl, env("LAYA_BASE_URL"), project.laya?.baseUrl, user.laya?.baseUrl),
      layaModel: first(o.laya?.model, env("LAYA_MODEL"), project.laya?.model, user.laya?.model),
      cloudflareAccountId: first(o.cloudflare?.accountId, env("CLOUDFLARE_ACCOUNT_ID"), project.cloudflare?.accountId, user.cloudflare?.accountId),
      cloudflareApiToken: first(o.cloudflare?.apiToken, env("CLOUDFLARE_API_TOKEN"), project.cloudflare?.apiToken, user.cloudflare?.apiToken),
      openrouterApiKey: first(o.openrouter?.apiKey, env("OPENROUTER_API_KEY"), project.openrouter?.apiKey, user.openrouter?.apiKey),
      openrouterBaseUrl: first(o.openrouter?.baseUrl, env("OPENROUTER_BASE_URL"), project.openrouter?.baseUrl, user.openrouter?.baseUrl),
    },
    sources,
    warnings,
  };
}

export const cachePath = (s: Settings) => join(s.dataDir, "judgments.json");

const mask = (v?: string) => (v === undefined ? undefined : v.length <= 8 ? "****" : `${v.slice(0, 3)}…${v.slice(-4)}`);

/** For display; secrets masked. */
export function describeSettings(s: Settings): Record<string, unknown> {
  const c = s.credentials;
  return {
    backend: s.backend, gate: s.gate, thresholds: s.thresholds, judgeTimeoutMs: s.judgeTimeoutMs, dataDir: s.dataDir,
    credentials: {
      deepseekApiKey: mask(c.deepseekApiKey), deepseekBaseUrl: c.deepseekBaseUrl,
      typesafeApiKey: mask(c.typesafeApiKey),
      layaBaseUrl: c.layaBaseUrl, layaModel: c.layaModel,
      cloudflareAccountId: c.cloudflareAccountId, cloudflareApiToken: mask(c.cloudflareApiToken),
      openrouterApiKey: mask(c.openrouterApiKey), openrouterBaseUrl: c.openrouterBaseUrl,
    },
    sources: s.sources, warnings: s.warnings,
  };
}

export const CONFIG_TEMPLATE: ConfigFile = {
  backend: "clef",
  gate: true,
  findingThreshold: 0.8,
  questionThreshold: 0.5,
  judgeTimeoutMs: 8000,
  cloudflare: { accountId: "REPLACE_ME", apiToken: "REPLACE_ME" },
};

export function initUserConfig(): { path: string; created: boolean } {
  const path = userConfigPath();
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600 });
  return { path, created: true };
}
