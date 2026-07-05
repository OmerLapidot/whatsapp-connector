// Load / mutate / check the send allow-list (a JSON array of chat ids).
// The special entry '*' allows every chat. All mutations here are batch:
// callers gate ONE approval per batch, then apply it in ONE write.
const fs = require('fs');

function loadAllowlist(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function saveAllowlist(filePath, ids) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ids, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function isAllowed(ids, chatId) {
  return ids.includes('*') || ids.includes(chatId);
}

function addManyToAllowlist(filePath, chatIds) {
  const ids = loadAllowlist(filePath);
  for (const id of chatIds) if (!ids.includes(id)) ids.push(id);
  saveAllowlist(filePath, ids);
  return ids;
}

function removeManyFromAllowlist(filePath, chatIds) {
  const ids = loadAllowlist(filePath).filter((id) => !chatIds.includes(id));
  saveAllowlist(filePath, ids);
  return ids;
}

module.exports = { loadAllowlist, saveAllowlist, isAllowed, addManyToAllowlist, removeManyFromAllowlist };
