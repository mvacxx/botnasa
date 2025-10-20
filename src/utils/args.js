function splitArgs(input) {
  const regex = /"([^"]*)"|'([^']*)'|\S+/g;
  const args = [];
  let match;
  while ((match = regex.exec(input)) !== null) {
    args.push(match[1] ?? match[2] ?? match[0]);
  }
  return args;
}

module.exports = { splitArgs };
