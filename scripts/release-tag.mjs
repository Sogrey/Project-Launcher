/**
 * 按 package.json 的 version 打 annotated tag 并推送到 origin。
 * 同步 src-tauri/tauri.conf.json 与 Cargo.toml 版本，避免安装包版本与 tag 不一致。
 *
 * 用法：npm run release:tag
 * 环境：RELEASE_TAG_SKIP_PUSH=1 只打本地 tag 不推送
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipPush = process.env.RELEASE_TAG_SKIP_PUSH === "1";
const APP_NAME = "Project Launcher";

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

function writeJson(rel, data) {
  writeFileSync(join(root, rel), `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitOk(...args) {
  try {
    git(...args);
    return true;
  } catch {
    return false;
  }
}

/** Parse path from `git status --porcelain` line (handles CRLF / renames). */
function porcelainPath(line) {
  const cleaned = line.replace(/\r$/, "");
  const rest = cleaned.slice(3);
  const arrow = rest.indexOf(" -> ");
  const path = (arrow >= 0 ? rest.slice(arrow + 4) : rest)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^"|"$/g, "");
  return path;
}

const pkg = readJson("package.json");
const version = String(pkg.version ?? "").trim();
if (!/^\d+\.\d+\.\d+([.-].+)?$/.test(version)) {
  console.error(`[release:tag] invalid package.json version: ${version}`);
  process.exit(1);
}

const tag = `v${version}`;
console.log(`[release:tag] version=${version} tag=${tag}`);

const tauriPath = "src-tauri/tauri.conf.json";
const tauri = readJson(tauriPath);
if (tauri.version !== version) {
  tauri.version = version;
  writeJson(tauriPath, tauri);
  console.log(`[release:tag] synced ${tauriPath} → ${version}`);
}

const cargoPath = "src-tauri/Cargo.toml";
const cargoRaw = readFileSync(join(root, cargoPath), "utf8");
const cargoNext = cargoRaw.replace(
  /^version\s*=\s*"[^"]*"/m,
  `version = "${version}"`,
);
if (cargoNext !== cargoRaw) {
  writeFileSync(join(root, cargoPath), cargoNext, "utf8");
  console.log(`[release:tag] synced ${cargoPath} → ${version}`);
}

const dirty = git("status", "--porcelain");
if (dirty) {
  const onlyVersion = dirty
    .split(/\r?\n/)
    .filter(Boolean)
    .every((line) => {
      const f = porcelainPath(line);
      return f === tauriPath || f === cargoPath;
    });
  if (!onlyVersion) {
    console.error(
      "[release:tag] working tree has unrelated changes; commit or stash first:\n" +
        dirty,
    );
    process.exit(1);
  }
  git("add", tauriPath, cargoPath);
  git("commit", "-m", `chore: bump version to ${version}`);
  console.log(`[release:tag] committed version bump`);
}

if (gitOk("rev-parse", "-q", "--verify", `refs/tags/${tag}`)) {
  console.error(`[release:tag] tag already exists locally: ${tag}`);
  process.exit(1);
}

git("tag", "-a", tag, "-m", `${APP_NAME} ${tag}`);
console.log(`[release:tag] created ${tag}`);

if (skipPush) {
  console.log("[release:tag] RELEASE_TAG_SKIP_PUSH=1 — skip push");
  process.exit(0);
}

git("push", "origin", "HEAD");
git("push", "origin", tag);
console.log(`[release:tag] pushed HEAD and ${tag} → origin`);
console.log(
  "[release:tag] CI release workflow should start: Actions → release",
);
