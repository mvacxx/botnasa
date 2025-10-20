const path = require('node:path');
const { Collection } = require('discord.js');
const { readJson, writeJson } = require('./utils/fileStorage');
const { formatDuration } = require('./utils/parsers');

const EVENTS_FILE = path.join(__dirname, '..', 'data', 'events.json');
const EVENTS_DEFAULT = { history: [] };

class EventManager {
  constructor(client) {
    this.client = client;
    this.activeEvents = new Collection();
  }

  async init() {
    this.persisted = await readJson(EVENTS_FILE, EVENTS_DEFAULT);
  }

  async saveHistory(eventSummary) {
    if (!this.persisted) {
      this.persisted = await readJson(EVENTS_FILE, EVENTS_DEFAULT);
    }
    this.persisted.history.push(eventSummary);
    await writeJson(EVENTS_FILE, this.persisted);
  }

  listActive() {
    return Array.from(this.activeEvents.values()).map((event) => ({
      guildId: event.guildId,
      name: event.name,
      roleId: event.roleId,
      channelIds: Array.from(event.channelIds),
      startedAt: event.startedAt,
    }));
  }

  _eventKey(guildId, name) {
    return `${guildId}:${name.toLowerCase()}`;
  }

  async startEvent(guild, name, roleId, channelIds, startedBy) {
    const key = this._eventKey(guild.id, name);
    if (this.activeEvents.has(key)) {
      throw new Error(`Já existe um evento ativo com o nome "${name}".`);
    }

    const event = {
      guildId: guild.id,
      name,
      roleId,
      channelIds: new Set(channelIds),
      startedAt: new Date(),
      startedBy,
      attendance: new Collection(),
    };

    this.activeEvents.set(key, event);

    await guild.members.fetch();

    const now = Date.now();
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isVoiceBased()) {
        continue;
      }

      for (const [memberId, member] of channel.members) {
        if (member.roles.cache.has(roleId)) {
          const attendee = this._getOrCreateAttendance(event, memberId);
          attendee.joinedAt = now;
        }
      }
    }

    return event;
  }

  async endEvent(guild, name, roleIdToCheck) {
    const key = this._eventKey(guild.id, name);
    const event = this.activeEvents.get(key);
    if (!event) {
      throw new Error(`Não encontrei um evento ativo chamado "${name}".`);
    }

    if (!roleIdToCheck) {
      throw new Error('Informe um cargo válido para encerrar o evento.');
    }

    const now = Date.now();

    for (const attendee of event.attendance.values()) {
      if (attendee.joinedAt) {
        attendee.totalMs += now - attendee.joinedAt;
        attendee.joinedAt = null;
      }
    }

    await guild.members.fetch();
    const role = guild.roles.cache.get(roleIdToCheck);
    if (!role) {
      throw new Error('Não foi possível encontrar o cargo informado para verificação.');
    }

    const present = [];
    const presentIds = new Set();

    for (const [memberId, attendance] of event.attendance.entries()) {
      if (!attendance || attendance.totalMs <= 0) {
        continue;
      }

      const member = guild.members.cache.get(memberId);
      const displayName = member ? member.displayName : `ID ${memberId}`;
      const hadRoleAtEnd = role.members.has(memberId);

      present.push({
        userId: memberId,
        displayName,
        totalMs: attendance.totalMs,
        hadRoleAtEnd,
      });

      presentIds.add(memberId);
    }

    const absent = [];
    for (const [memberId, member] of role.members) {
      if (!presentIds.has(memberId)) {
        absent.push({
          userId: memberId,
          displayName: member.displayName,
        });
      }
    }

    const summary = {
      eventName: event.name,
      startedAt: event.startedAt.toISOString(),
      endedAt: new Date(now).toISOString(),
      guildId: guild.id,
      roleId: role.id,
      originalRoleId: event.roleId,
      present: present.map((entry) => ({
        userId: entry.userId,
        displayName: entry.displayName,
        totalMs: entry.totalMs,
        formattedDuration: formatDuration(entry.totalMs),
        hadRoleAtEnd: entry.hadRoleAtEnd,
      })),
      absent: absent.map((entry) => ({
        userId: entry.userId,
        displayName: entry.displayName,
      })),
    };

    await this.saveHistory(summary);
    this.activeEvents.delete(key);
    return { summary, present, absent };
  }

  handleVoiceUpdate(oldState, newState) {
    const guildId = newState.guild.id;
    const userId = newState.id;
    const interestedEvents = this._eventsForGuild(guildId);

    if (interestedEvents.size === 0) {
      return;
    }

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;
    const now = Date.now();

    for (const event of interestedEvents.values()) {
      const wasTracked = event.channelIds.has(oldChannelId);
      const isTracked = event.channelIds.has(newChannelId);

      if (wasTracked && !isTracked) {
        const attendee = event.attendance.get(userId);
        if (attendee && attendee.joinedAt) {
          attendee.totalMs += now - attendee.joinedAt;
          attendee.joinedAt = null;
        }
      }

      if (!wasTracked && isTracked) {
        const member = newState.member;
        if (member && member.roles.cache.has(event.roleId)) {
          const attendee = this._getOrCreateAttendance(event, userId);
          attendee.joinedAt = now;
        }
      }

      if (wasTracked && isTracked && oldChannelId !== newChannelId) {
        // Moving between tracked rooms keeps the same session open.
      }
    }
  }

  _eventsForGuild(guildId) {
    const events = new Collection();
    for (const [key, event] of this.activeEvents.entries()) {
      if (event.guildId === guildId) {
        events.set(key, event);
      }
    }
    return events;
  }

  _getOrCreateAttendance(event, userId) {
    if (!event.attendance.has(userId)) {
      event.attendance.set(userId, { totalMs: 0, joinedAt: null });
    }
    return event.attendance.get(userId);
  }
}

module.exports = EventManager;
