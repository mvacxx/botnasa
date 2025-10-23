const path = require('node:path');
const { readJson, writeJson } = require('./utils/fileStorage');

class TicketManager {
  constructor(client) {
    this.client = client;
    this.filePath = path.join(__dirname, '..', 'data', 'tickets.json');
    this.tickets = {};
  }

  async init() {
    this.tickets = await readJson(this.filePath, {});
  }

  async registerTicket(guildId, userId, channelId) {
    if (!this.tickets[guildId]) {
      this.tickets[guildId] = {};
    }

    const previous = this.tickets[guildId][userId] || null;
    this.tickets[guildId][userId] = channelId;

    try {
      await writeJson(this.filePath, this.tickets);
    } catch (error) {
      if (previous) {
        this.tickets[guildId][userId] = previous;
      } else {
        delete this.tickets[guildId][userId];
        if (Object.keys(this.tickets[guildId]).length === 0) {
          delete this.tickets[guildId];
        }
      }
      throw error;
    }
  }

  getOpenTicket(guildId, userId) {
    return this.tickets[guildId]?.[userId] ?? null;
  }

  getTicketOwnerByChannel(guildId, channelId) {
    const guildTickets = this.tickets[guildId];
    if (!guildTickets) return null;

    for (const [userId, storedChannelId] of Object.entries(guildTickets)) {
      if (storedChannelId === channelId) {
        return userId;
      }
    }

    return null;
  }

  async clearTicket(guildId, userId) {
    const guildTickets = this.tickets[guildId];
    if (!guildTickets || !guildTickets[userId]) {
      return false;
    }

    const previous = guildTickets[userId];
    delete guildTickets[userId];
    if (Object.keys(guildTickets).length === 0) {
      delete this.tickets[guildId];
    }

    try {
      await writeJson(this.filePath, this.tickets);
      return true;
    } catch (error) {
      if (!this.tickets[guildId]) {
        this.tickets[guildId] = {};
      }
      this.tickets[guildId][userId] = previous;
      throw error;
    }
  }

  async clearTicketByChannel(guildId, channelId) {
    const ownerId = this.getTicketOwnerByChannel(guildId, channelId);
    if (!ownerId) {
      return null;
    }

    const removed = await this.clearTicket(guildId, ownerId);
    return removed ? ownerId : null;
  }

  async findExistingChannel(guild, userId) {
    const channelId = this.getOpenTicket(guild.id, userId);
    if (!channelId) {
      return null;
    }

    const channel =
      guild.channels.cache.get(channelId) || (await guild.channels.fetch(channelId).catch(() => null));

    if (!channel) {
      try {
        await this.clearTicket(guild.id, userId);
      } catch (error) {
        console.error('Falha ao limpar ticket inexistente.', error);
      }
      return null;
    }

    return channel;
  }

  async handleChannelDeletion(guildId, channelId) {
    try {
      await this.clearTicketByChannel(guildId, channelId);
    } catch (error) {
      console.error('Erro ao limpar ticket após a exclusão do canal.', error);
    }
  }
}

module.exports = TicketManager;
