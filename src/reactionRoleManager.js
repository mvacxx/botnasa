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

    const normalizedEmoji = typeof emoji === 'string' ? emoji.trim() : emoji;
    if (!normalizedEmoji) {
      throw new Error('Emoji inválido informado.');
    }

    const message = await targetChannel.send({ content: messageContent });
    await message.react(normalizedEmoji);

    this.cache.set(message.id, {
      guildId: targetChannel.guild.id,
      channelId: targetChannel.id,
      roleId,
      emoji: normalizedEmoji,
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

    const guild = await this._resolveGuild(reaction, data);
    if (!guild) return;

    let member;
    try {
      member = await guild.members.fetch(user.id);
    } catch (error) {
      console.error('Não foi possível localizar o membro para adicionar o cargo automático.', error);
      return;
    }

    try {
      await member.roles.add(data.roleId, 'Reação adicionada ao cargo automático');
    } catch (error) {
      console.error('Falha ao atribuir cargo pela reação automática.', error);
    }
  }

  async handleReactionRemove(reaction, user) {
    if (user.bot) return;
    const data = this.cache.get(reaction.message.id);
    if (!data) return;

    const emojiMatches = this._reactionMatches(reaction, data.emoji);
    if (!emojiMatches) return;

    const guild = await this._resolveGuild(reaction, data);
    if (!guild) return;

    let member;
    try {
      member = await guild.members.fetch(user.id);
    } catch (error) {
      console.error('Não foi possível localizar o membro para remover o cargo automático.', error);
      return;
    }

    try {
      await member.roles.remove(data.roleId, 'Reação removida do cargo automático');
    } catch (error) {
      console.error('Falha ao remover cargo pela reação automática.', error);
    }
  }

  _reactionMatches(reaction, expectedEmoji) {
    if (!reaction.emoji) return false;
    if (reaction.emoji.id) {
      return reaction.emoji.id === expectedEmoji || reaction.emoji.toString() === expectedEmoji;
    }
    return reaction.emoji.name === expectedEmoji;
  }

  async _resolveGuild(reaction, data) {
    if (reaction?.message?.guild) {
      return reaction.message.guild;
    }

    const guildId = data?.guildId;
    if (!guildId) {
      return null;
    }

    const cached = this.client.guilds.cache.get(guildId);
    if (cached) {
      return cached;
    }

    try {
      return await this.client.guilds.fetch(guildId);
    } catch (error) {
      console.error('Não foi possível obter a guild para a reação automática.', error);
      return null;
    }
  }
}

module.exports = ReactionRoleManager;
