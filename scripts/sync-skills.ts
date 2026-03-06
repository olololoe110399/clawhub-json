import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface ClawHubSkill {
  id?: string;
  slug?: string;
  name?: string;
  updatedAt?: string;
  createdAt?: string;
  [key: string]: JsonValue | undefined;
}

interface ClawHubAPISkillsPage {
  items?: ClawHubSkill[];
  nextCursor?: string | null;
}

const BASE_URL = requiredEnv("CLAWHUB_BASE_URL").replace(/\/+$/, "");
const API_KEY = process.env.CLAWHUB_API_KEY;
const OUTPUT_DIR = process.env.CLAWHUB_OUTPUT_DIR || "data";
const LIMIT = parseNumber(process.env.CLAWHUB_LIMIT, 200);
const TIMEOUT_MS = parseNumber(process.env.CLAWHUB_TIMEOUT_MS, 20_000);
const MAX_RETRIES = parseNumber(process.env.CLAWHUB_MAX_RETRIES, 3);
const HISTORY_ENABLED = (process.env.CLAWHUB_HISTORY || "true").toLowerCase() === "true";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}. ${text}`.trim());
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;

      if (attempt < MAX_RETRIES) {
        const backoffMs = attempt * 1500;
        console.warn(`Fetch failed (attempt ${attempt}/${MAX_RETRIES}). Retrying in ${backoffMs}ms...`);
        await sleep(backoffMs);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function stableSkillKey(skill: ClawHubSkill): string {
  return String(skill.slug || skill.id || skill.name || JSON.stringify(skill));
}

function sortSkills(skills: ClawHubSkill[]): ClawHubSkill[] {
  return [...skills].sort((a, b) => {
    const slugA = String(a.slug || "");
    const slugB = String(b.slug || "");
    if (slugA !== slugB) return slugA.localeCompare(slugB);

    const idA = String(a.id || "");
    const idB = String(b.id || "");
    if (idA !== idB) return idA.localeCompare(idB);

    const nameA = String(a.name || "");
    const nameB = String(b.name || "");
    return nameA.localeCompare(nameB);
  });
}

function dedupeSkills(skills: ClawHubSkill[]): ClawHubSkill[] {
  const map = new Map<string, ClawHubSkill>();
  for (const skill of skills) {
    map.set(stableSkillKey(skill), skill);
  }
  return sortSkills(Array.from(map.values()));
}

function toTimestampSafeString(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function fetchAllSkills(): Promise<ClawHubSkill[]> {
  const allItems: ClawHubSkill[] = [];
  let cursor: string | undefined;
  let page = 0;

  while (true) {
    const apiPath = cursor
      ? `/skills?limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`
      : `/skills?limit=${LIMIT}`;

    const url = `${BASE_URL}${apiPath}`;
    const response = await fetchJson<ClawHubAPISkillsPage>(url);
    const items = Array.isArray(response.items) ? response.items : [];

    page += 1;
    allItems.push(...items);

    console.log(`Fetched page ${page}: ${items.length} items`);

    if (!response.nextCursor || items.length === 0) {
      break;
    }

    cursor = response.nextCursor;
  }

  return dedupeSkills(allItems);
}

async function saveJsonFiles(skills: ClawHubSkill[]): Promise<void> {
  const now = new Date();
  const updatedAt = now.toISOString();
  const timestamp = toTimestampSafeString(now);

  const output = {
    updatedAt,
    total: skills.length,
    items: skills,
  };

  const outDir = path.resolve(process.cwd(), OUTPUT_DIR);
  const historyDir = path.join(outDir, "history");

  await mkdir(outDir, { recursive: true });
  if (HISTORY_ENABLED) {
    await mkdir(historyDir, { recursive: true });
  }

  const latestFile = path.join(outDir, "skills.json");
  await writeFile(latestFile, JSON.stringify(output, null, 2) + "\n", "utf8");
  console.log(`Wrote latest snapshot: ${latestFile}`);

  const metadata = {
    updatedAt,
    total: skills.length,
    latest: "skills.json",
    historyEnabled: HISTORY_ENABLED,
  };
  const metadataFile = path.join(outDir, "metadata.json");
  await writeFile(metadataFile, JSON.stringify(metadata, null, 2) + "\n", "utf8");
  console.log(`Wrote metadata: ${metadataFile}`);

  if (HISTORY_ENABLED) {
    const historyFile = path.join(historyDir, `skills-${timestamp}.json`);
    await writeFile(historyFile, JSON.stringify(output, null, 2) + "\n", "utf8");
    console.log(`Wrote history snapshot: ${historyFile}`);
  }
}

async function main(): Promise<void> {
  console.log("Starting ClawHub JSON sync...");
  const skills = await fetchAllSkills();
  await saveJsonFiles(skills);
  console.log(`Done. Total unique skills: ${skills.length}`);
}

main().catch((error) => {
  console.error("Sync failed:", error);
  process.exit(1);
});
