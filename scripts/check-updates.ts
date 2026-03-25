import path from "node:path";
import fs from "fs/promises";
import { execSync } from "node:child_process";

async function getLatestRelease(repo: string) {
  try {
    const cmd = `gh api repos/${repo}/releases/latest --jq .tag_name`;
    return execSync(cmd).toString().trim();
  } catch (e) {
    console.error(`Failed to get release for ${repo}: ${e}`);
    return null;
  }
}

async function updateApp(appId: string) {
  const appPath = path.join(process.cwd(), "apps", appId);
  const configPath = path.join(appPath, "config.json");
  const composePath = path.join(appPath, "docker-compose.json");

  const configContent = await fs.readFile(configPath, "utf-8");
  const config = JSON.parse(configContent);

  const sourceUrl = config.source;
  if (!sourceUrl || !sourceUrl.includes("github.com")) return;

  const repo = sourceUrl.replace("https://github.com/", "");
  const latestVersion = await getLatestRelease(repo);

  if (!latestVersion || latestVersion === config.version) {
    console.log(`${appId}: Up to date (${config.version})`);
    return;
  }

  console.log(`${appId}: Updating ${config.version} -> ${latestVersion}`);

  // Update config.json
  config.version = latestVersion;
  config.updated_at = new Date().getTime();
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  // Update docker-compose.json
  let composeContent = await fs.readFile(composePath, "utf-8");
  const imageRegex = new RegExp(`(image": ".*:)([^"]+)`, 'g');
  composeContent = composeContent.replace(imageRegex, `$1${latestVersion}`);
  await fs.writeFile(composePath, composeContent);

  console.log(`${appId}: Successfully updated.`);
}

async function run() {
  const appsDir = path.join(process.cwd(), "apps");
  const apps = await fs.readdir(appsDir);
  
  for (const app of apps) {
    const stat = await fs.stat(path.join(appsDir, app));
    if (stat.isDirectory()) {
      await updateApp(app);
    }
  }
}

run();
