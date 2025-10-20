const fs = require('node:fs/promises');
const path = require('node:path');

async function ensureFile(filePath, defaultValue) {
  try {
    await fs.access(filePath);
  } catch (error) {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

async function readJson(filePath, defaultValue) {
  await ensureFile(filePath, defaultValue);
  const raw = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error(`Failed to parse JSON from ${filePath}. Resetting to default.`, error);
    await fs.writeFile(filePath, JSON.stringify(defaultValue, null, 2));
    return JSON.parse(JSON.stringify(defaultValue));
  }
}

async function writeJson(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

module.exports = {
  readJson,
  writeJson,
};
