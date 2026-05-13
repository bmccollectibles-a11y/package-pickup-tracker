const path = process.argv[2];
const baseUrl = process.env.CRON_BASE_URL || "https://bmcpackages.com";

if (!path || !path.startsWith("/")) {
  console.error("Usage: node scripts/cron-request.mjs /api/path");
  process.exit(1);
}

const url = new URL(path, baseUrl);
const response = await fetch(url, { method: "POST" });
const text = await response.text();

if (!response.ok) {
  console.error(`Cron request failed: ${response.status} ${response.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log(text);
