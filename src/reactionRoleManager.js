const path = require('node:path');
const { readJson, writeJson } = require('./utils/fileStorage');
const { extractId } = require('./utils/parsers');

const STORAGE_FILE = path.join(__dirname, '..', 'data', 'reaction-roles.json');
const STORAGE_DEFAULT = { messages: {} };

class ReactionRoleManager {
  constructor(client) {
    this.client = client;
    this.cache = new Map();
  }

  async init() {
    const data = await readJson(STORAGE_FILE, STORAGE_DEFAULT);
    this.cache = new Map(Object.entries(data.messages));
  }

  async persist() {
    const data = { messages: Object.fromEntries(this.cache) };
    await writeJson(STORAGE_FILE, data);
  }

  async createReactionRole({ channel, emoji, roleId, messageContent }) {
    const targetChannel = typeof channel === 'string'
      ? await this.client.channels.fetch(extractId(channel))
      : channel;
    if (!targetChannel || !targetChannel.isTextBased()) {
      throw new Error('Canal inválido para reação de cargo.');
    }

    const role = targetChannel.guild.roles.cache.get(roleId);
    if (!role) {
      throw new Error('Cargo informado não foi encontrado.');
    }

    const message = await targetChannel.send({ content: messageContent });
    await message.react(emoji);

    this.cache.set(message.id, {
      guildId: targetChannel.guild.id,
      channelId: targetChannel.id,
      roleId,
      emoji,
    });
    await this.persist();
    return message;
  }

  async removeReactionRole(messageId) {
    if (!this.cache.has(messageId)) {
      throw new Error('Não encontrei uma configuração de reação para essa mensagem.');
    }
    this.cache.delete(messageId);
    await this.persist();
  }

  async handleReactionAdd(reaction, user) {
    if (user.bot) return;
    const data = this.cache.get(reaction.message.id);
    if (!data) return;

    const emojiMatches = this._reactionMatches(reaction, data.emoji);
    if (!emojiMatches) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    await member.roles.add(data.roleId, 'Reação adicionada ao cargo automático');
  }

  async handleReactionRemove(reaction, user) {
    if (user.bot) return;
    const data = this.cache.get(reaction.message.id);
    if (!data) return;

    const emojiMatches = this._reactionMatches(reaction, data.emoji);
    if (!emojiMatches) return;

    const guild = reaction.message.guild;
    const member = await guild.members.fetch(user.id);
    await member.roles.remove(data.roleId, 'Reação removida do cargo automático');
  }

  _reactionMatches(reaction, expectedEmoji) {
    if (!reaction.emoji) return false;
    if (reaction.emoji.id) {
      return reaction.emoji.id === expectedEmoji || reaction.emoji.toString() === expectedEmoji;
    }
    return reaction.emoji.name === expectedEmoji;
  }
}

module.exports = ReactionRoleManager;
