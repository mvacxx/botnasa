function extractId(value = '') {
  if (!value) return null;
  const mentionMatch = value.match(/^(?:<[@#&!]{0,2})(\d+)>?$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }
  return value;
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((unit) => unit.toString().padStart(2, '0'))
    .join(':');
}

module.exports = {
  extractId,
  formatDuration,
};
