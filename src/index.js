require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const EventManager = require('./eventManager');
const ReactionRoleManager = require('./reactionRoleManager');
const TicketManager = require('./ticketManager');
const { extractId, formatDuration } = require('./utils/parsers');
const { splitArgs } = require('./utils/args');

const configPath = path.join(__dirname, '..', 'config', 'config.json');
const defaultConfig = {
  prefix: '!',
  defaultReportChannelId: '',
  tickets: { supportRoleId: '', categoryId: '' },
};
const config = fs.existsSync(configPath)
  ? { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  : defaultConfig;

config.tickets = { ...defaultConfig.tickets, ...(config.tickets ?? {}) };

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
});

const eventManager = new EventManager(client);
const reactionRoleManager = new ReactionRoleManager(client);
const ticketManager = new TicketManager(client);
const eventCreationSessions = new Map();
const eventStopSessions = new Map();
const warnSessions = new Map();
const reactionRoleSessions = new Map();

const MAX_ASSISTANT_MESSAGE_LENGTH = 1024;
const TICKET_CLOSE_DELAY_MS = 10_000;

async function bootstrap() {
  await eventManager.init();
  await reactionRoleManager.init();
  await ticketManager.init();
}

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  eventManager.handleVoiceUpdate(oldState, newState);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const pendingWarnSession = findWarnAttachmentSession(message);
  if (pendingWarnSession && message.attachments?.size) {
    const handled = await handleWarnAttachmentMessage(message, pendingWarnSession);
    if (handled) {
      return;
    }
  }

  if (!message.content.startsWith(config.prefix)) return;

  const withoutPrefix = message.content.slice(config.prefix.length).trim();
  const [command, ...rest] = splitArgs(withoutPrefix);
  if (!command) return;

  try {
    switch (command.toLowerCase()) {
      case 'event':
        await handleEventCommand(message, rest);
        break;
      case 'reaction-role':
        await handleReactionRoleCommand(message, rest);
        break;
      case 'warn':
        await handleWarnCommand(message, rest);
        break;
      case 'ticket':
        await handleTicketCommand(message, rest);
        break;
      case 'help':
        await handleHelpCommand(message);
        break;
      default:
        await message.reply(
          `Comando não reconhecido. Use \`${config.prefix}help\` para ver a lista de comandos disponíveis.`,
        );
    }
  } catch (error) {
    console.error(error);
    await message.reply(`❌ Ocorreu um erro: ${error.message}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.inGuild()) return;

  const isRelevantInteraction =
    (typeof interaction.isButton === 'function' && interaction.isButton()) ||
    (typeof interaction.isRoleSelectMenu === 'function' && interaction.isRoleSelectMenu()) ||
    (typeof interaction.isChannelSelectMenu === 'function' && interaction.isChannelSelectMenu()) ||
    (typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu()) ||
    (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit());

  if (!isRelevantInteraction) {
    return;
  }

  const customId = interaction.customId || '';

  try {
    if (customId.startsWith('eventStart:')) {
      await handleEventStartInteraction(interaction);
    } else if (customId.startsWith('eventStop:')) {
      await handleEventStopInteraction(interaction);
    } else if (customId.startsWith('warn:')) {
      await handleWarnInteraction(interaction);
    } else if (customId.startsWith('reactionRoleCreate:')) {
      await handleReactionRoleCreationInteraction(interaction);
    } else if (customId.startsWith('ticket:')) {
      await handleTicketInteraction(interaction);
    }
  } catch (error) {
    console.error('Erro ao lidar com interação:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Ocorreu um erro: ${error.message}`, ephemeral: true });
    }
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a reação adicionada.', error);
      return;
    }
  }
  if (reaction.message.partial) {
    try {
      await reaction.message.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a mensagem da reação adicionada.', error);
      return;
    }
  }
  await reactionRoleManager.handleReactionAdd(reaction, user);
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.partial) {
    try {
      await reaction.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a reação removida.', error);
      return;
    }
  }
  if (reaction.message.partial) {
    try {
      await reaction.message.fetch();
    } catch (error) {
      console.error('Não foi possível carregar a mensagem da reação removida.', error);
      return;
    }
  }
  await reactionRoleManager.handleReactionRemove(reaction, user);
});

client.on('channelDelete', async (channel) => {
  if (!channel.guild) return;

  try {
    await ticketManager.handleChannelDeletion(channel.guild.id, channel.id);
  } catch (error) {
    console.error('Erro ao limpar ticket após remoção do canal.', error);
  }
});

async function handleEventCommand(message, args) {
  const subcommand = args.shift();
  if (!subcommand) {
    await message.reply('Use `event start`, `event stop` ou `event list`.');
    return;
  }

  switch (subcommand.toLowerCase()) {
    case 'start':
      await startEvent(message, args);
      break;
    case 'stop':
      await stopEvent(message, args);
      break;
    case 'list':
      await listEvents(message);
      break;
    default:
      await message.reply('Subcomando de evento desconhecido.');
  }
}

async function startEvent(message, args) {
  if (args.length < 3) {
    await startInteractiveEvent(message);
    return;
  }

  const eventName = args.shift().trim();
  const roleId = extractId(args.shift());
  const requestedChannelIds = args.map((value) => extractId(value)).filter(Boolean);

  const channelIds = [];
  for (const channelId of requestedChannelIds) {
    const channel = message.guild.channels.cache.get(channelId) || await message.guild.channels.fetch(channelId).catch(() => null);
    if (channel && channel.isVoiceBased()) {
      channelIds.push(channelId);
    }
  }

  if (!roleId || channelIds.length === 0) {
    await message.reply('Informe um cargo válido e pelo menos um canal de voz.');
    return;
  }

  const event = await eventManager.startEvent(message.guild, eventName, roleId, channelIds, message.author.id);
  await message.reply(`✅ Evento "${event.name}" iniciado para o cargo <@&${roleId}>.`);
}

async function stopEvent(message, args) {
  if (args.length < 2) {
    await startInteractiveEventStop(message);
    return;
  }

  const roleArgument = args.pop();
  const roleId = extractId(roleArgument);
  const eventName = args.join(' ').trim();

  if (!eventName) {
    await message.reply('Informe o nome do evento entre aspas. Ex: `event stop "Nome do Evento" <cargo>`');
    return;
  }

  if (!roleId) {
    await message.reply('Informe um cargo válido para verificar as presenças.');
    return;
  }

  const result = await endEventAndSendReport(
    message.guild,
    message.channelId,
    eventName,
    roleId,
    message.member || message.author,
  );

  if (result.dmChannel) {
    await message.reply('✅ Evento encerrado. O relatório foi enviado no seu privado.');
  } else if (result.fallbackChannel) {
    await message.reply(
      `⚠️ Não foi possível enviar o relatório por mensagem direta. Ele foi publicado em <#${result.fallbackChannel.id}>.`,
    );
  }
}

async function listEvents(message) {
  const events = eventManager.listActive().filter((event) => event.guildId === message.guild.id);
  if (events.length === 0) {
    await message.reply('Não há eventos ativos neste servidor.');
    return;
  }

  const lines = events.map((event) => {
    const started = Math.floor(new Date(event.startedAt).getTime() / 1000);
    const channels = event.channelIds.map((id) => `<#${id}>`).join(', ');
    return `• **${event.name}** — Cargo: <@&${event.roleId}> — Canais: ${channels} — Iniciado em <t:${started}:f>`;
  });

  await message.reply(lines.join('\n'));
}

async function handleTicketCommand(message, args) {
  if (!message.guild) {
    await message.reply('Este comando só pode ser usado dentro de um servidor.');
    return;
  }

  const [firstArg, ...restArgs] = args;
  const normalized = typeof firstArg === 'string' ? firstArg.toLowerCase() : null;

  if (!firstArg) {
    await openTicketFromMessage(message, []);
    return;
  }

  switch (normalized) {
    case 'open':
      await openTicketFromMessage(message, restArgs);
      return;
    case 'close':
      await closeTicketCommand(message);
      return;
    case 'panel':
      await createTicketPanel(message, restArgs);
      return;
    default:
      await openTicketFromMessage(message, [firstArg, ...restArgs]);
      return;
  }
}

async function openTicketFromMessage(message, reasonParts) {
  const reason = Array.isArray(reasonParts) ? reasonParts.join(' ').trim() : '';
  await openTicketWithContext({
    guild: message.guild,
    user: message.author,
    reason,
    sendReply: (payload) => message.reply(payload),
  });
}

async function openTicketWithContext({ guild, user, reason, sendReply }) {
  if (!guild) {
    await sendReply('Este comando só pode ser usado dentro de um servidor.');
    return;
  }

  const supportRoleId = config.tickets?.supportRoleId;

  if (!supportRoleId) {
    await sendReply('Configure o campo `tickets.supportRoleId` em `config/config.json` antes de abrir tickets.');
    return;
  }

  const supportRole =
    guild.roles.cache.get(supportRoleId) || (await guild.roles.fetch(supportRoleId).catch(() => null));

  if (!supportRole) {
    await sendReply('Não encontrei o cargo configurado para atender os tickets.');
    return;
  }

  const existingChannel = await ticketManager.findExistingChannel(guild, user.id);
  if (existingChannel) {
    await sendReply(`Você já possui um ticket aberto em ${existingChannel}.`);
    return;
  }

  let parent = null;
  const categoryId = config.tickets?.categoryId;
  if (categoryId) {
    parent =
      guild.channels.cache.get(categoryId) || (await guild.channels.fetch(categoryId).catch(() => null));
    if (!parent || parent.type !== ChannelType.GuildCategory) {
      await sendReply('A categoria configurada para tickets não foi encontrada ou não é uma categoria válida.');
      return;
    }
  }

  const limitedReason = typeof reason === 'string' ? reason.slice(0, 1024) : '';

  let channel;
  try {
    const permissionOverwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      {
        id: supportRoleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
    ];

    const topicUserTag = user.tag ?? user.username ?? user.id;

    const channelOptions = {
      name: buildTicketChannelName(user),
      type: ChannelType.GuildText,
      topic: `Ticket aberto por ${topicUserTag} (${user.id})`,
      permissionOverwrites,
    };

    if (parent) {
      channelOptions.parent = parent;
    }

    channel = await guild.channels.create(channelOptions);
  } catch (error) {
    console.error('Erro ao criar canal de ticket:', error);
    await sendReply('❌ Não foi possível criar o canal do ticket. Verifique as permissões do bot.');
    return;
  }

  try {
    await ticketManager.registerTicket(guild.id, user.id, channel.id);
  } catch (error) {
    console.error('Erro ao registrar ticket:', error);
    await channel.delete('Falha ao registrar ticket').catch(() => {});
    await sendReply('❌ Não foi possível registrar o ticket. Tente novamente mais tarde.');
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Ticket de suporte')
    .setDescription('Descreva seu pedido ou problema e aguarde um membro da equipe.')
    .setColor(0x5865f2)
    .addFields({ name: 'Aberto por', value: `<@${user.id}>`, inline: true })
    .setTimestamp(new Date());

  if (supportRoleId) {
    embed.addFields({ name: 'Equipe responsável', value: `<@&${supportRoleId}>`, inline: true });
  }

  if (limitedReason) {
    embed.addFields({ name: 'Resumo inicial', value: limitedReason });
  }

  const closeButton = new ButtonBuilder()
    .setCustomId(`ticket:close:${user.id}`)
    .setLabel('Encerrar ticket')
    .setStyle(ButtonStyle.Danger);

  const allowedMentions = { users: [user.id] };
  if (supportRoleId) {
    allowedMentions.roles = [supportRoleId];
  }

  try {
    const contentParts = [`<@${user.id}> ticket aberto.`];
    if (supportRoleId) {
      contentParts.push(`<@&${supportRoleId}>`);
    }

    await channel.send({
      content: contentParts.join(' '),
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(closeButton)],
      allowedMentions,
    });

    await sendReply(`🎟️ Seu ticket foi aberto em ${channel}.`);
  } catch (error) {
    console.error('Erro ao finalizar configuração do ticket:', error);
    await ticketManager
      .clearTicket(guild.id, user.id)
      .catch((clearError) => console.error('Falha ao limpar ticket após erro.', clearError));
    await channel.delete('Falha ao enviar mensagem inicial do ticket').catch(() => {});
    await sendReply('❌ Ocorreu um erro ao preparar o ticket. Tente novamente mais tarde.');
  }
}

async function openTicketFromInteraction(interaction) {
  await interaction.deferReply({ ephemeral: true });

  await openTicketWithContext({
    guild: interaction.guild,
    user: interaction.user,
    reason: '',
    sendReply: (payload) => interaction.editReply(payload),
  });
}

async function createTicketPanel(message, args) {
  if (!message.channel || !message.channel.isTextBased()) {
    await message.reply('Execute este comando em um canal de texto para criar o painel de tickets.');
    return;
  }

  const member = message.member;
  if (!member?.permissions?.has(PermissionFlagsBits.ManageChannels)) {
    await message.reply('Você precisa da permissão de gerenciar canais para criar o painel de tickets.');
    return;
  }

  const supportRoleId = config.tickets?.supportRoleId;

  if (!supportRoleId) {
    await message.reply('Configure o campo `tickets.supportRoleId` em `config/config.json` antes de criar o painel.');
    return;
  }

  const supportRole =
    message.guild.roles.cache.get(supportRoleId) ||
    (await message.guild.roles.fetch(supportRoleId).catch(() => null));

  if (!supportRole) {
    await message.reply('Não encontrei o cargo configurado para atender os tickets.');
    return;
  }

  const customDescription = Array.isArray(args) ? args.join(' ').trim() : '';
  if (customDescription.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    await message.reply(
      `A descrição do painel deve ter no máximo ${MAX_ASSISTANT_MESSAGE_LENGTH} caracteres.`,
    );
    return;
  }

  const description =
    customDescription ||
    'Clique no botão abaixo para abrir um ticket privado com a equipe de suporte.';

  const button = new ButtonBuilder().setCustomId('ticket:open').setLabel('Abrir Ticket').setStyle(ButtonStyle.Primary);

  const embed = new EmbedBuilder()
    .setTitle('Central de suporte')
    .setDescription(description)
    .setColor(0x5865f2)
    .addFields({ name: 'Equipe responsável', value: `<@&${supportRoleId}>` })
    .setTimestamp(new Date());

  await message.channel.send({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(button)],
    allowedMentions: { parse: [] },
  });

  await message.reply('✅ Painel de tickets criado neste canal.');
}

async function closeTicketCommand(message) {
  if (!message.guild) {
    await message.reply('Este comando só pode ser usado dentro de um servidor.');
    return;
  }

  const ownerId = ticketManager.getTicketOwnerByChannel(message.guild.id, message.channel.id);
  if (!ownerId) {
    await message.reply('Este canal não corresponde a um ticket criado pelo bot.');
    return;
  }

  const supportRoleId = config.tickets?.supportRoleId;
  const member = message.member;
  const isOwner = message.author.id === ownerId;
  const hasSupportRole = Boolean(supportRoleId && member?.roles?.cache?.has(supportRoleId));

  if (!isOwner && !hasSupportRole) {
    await message.reply('Apenas o autor do ticket ou o cargo configurado pode encerrá-lo.');
    return;
  }

  const acknowledgement = await message.reply('Fechando o ticket...');
  const result = await closeTicketChannel(message.channel, ownerId, message.author.id);

  if (result.ok) {
    await acknowledgement.edit('Ticket encerrado. Este canal será removido em instantes.');
  } else {
    await acknowledgement.edit(
      `❌ Não foi possível encerrar o ticket: ${result.error?.message ?? 'erro desconhecido'}.`,
    );
  }
}

async function handleTicketInteraction(interaction) {
  const [, action, ownerId] = interaction.customId.split(':');

  switch (action) {
    case 'open':
      await openTicketFromInteraction(interaction);
      break;
    case 'close':
      await handleTicketCloseInteraction(interaction, ownerId);
      break;
    default:
      break;
  }
}

async function handleTicketCloseInteraction(interaction, ownerId) {
  if (!interaction.channel || !interaction.channel.isTextBased()) {
    await interaction.reply({ content: 'Não foi possível identificar este ticket.', ephemeral: true });
    return;
  }

  const supportRoleId = config.tickets?.supportRoleId;
  const member = interaction.member;
  const isOwner = ownerId && interaction.user.id === ownerId;
  const hasSupportRole = Boolean(supportRoleId && member?.roles?.cache?.has(supportRoleId));

  if (!isOwner && !hasSupportRole) {
    await interaction.reply({
      content: 'Apenas o autor do ticket ou o cargo configurado pode encerrá-lo.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const result = await closeTicketChannel(interaction.channel, ownerId, interaction.user.id);
  if (result.ok) {
    await interaction.editReply('Ticket encerrado. Este canal será removido em instantes.');
  } else {
    await interaction.editReply(
      `❌ Não foi possível encerrar o ticket: ${result.error?.message ?? 'erro desconhecido'}.`,
    );
  }
}

async function closeTicketChannel(channel, ownerId, closedById) {
  try {
    if (ownerId) {
      try {
        const removed = await ticketManager.clearTicket(channel.guild.id, ownerId);
        if (!removed) {
          await ticketManager.clearTicketByChannel(channel.guild.id, channel.id);
        }
      } catch (error) {
        console.error('Erro ao atualizar registro do ticket ao encerrar.', error);
      }
    } else {
      try {
        await ticketManager.clearTicketByChannel(channel.guild.id, channel.id);
      } catch (error) {
        console.error('Erro ao limpar ticket ao encerrar.', error);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('Ticket encerrado')
      .setDescription(`Encerrado por <@${closedById}>.`)
      .setColor(0xed4245)
      .setTimestamp(new Date());

    if (ownerId) {
      embed.addFields({ name: 'Participante', value: `<@${ownerId}>`, inline: true });
    }

    await channel.send({
      embeds: [embed],
      allowedMentions: { users: [closedById, ownerId].filter(Boolean) },
    });

    setTimeout(() => {
      channel.delete('Ticket encerrado').catch((error) => {
        console.error('Erro ao remover canal do ticket encerrado.', error);
      });
    }, TICKET_CLOSE_DELAY_MS);

    return { ok: true };
  } catch (error) {
    console.error('Erro ao encerrar ticket:', error);
    return { ok: false, error };
  }
}

function buildTicketChannelName(user) {
  const base = typeof user.username === 'string' ? user.username : 'usuario';
  const normalized = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

  const suffix = user.id ? user.id.slice(-4) : Math.random().toString(36).slice(-4);
  const prefix = normalized ? normalized.slice(0, 16) : 'ticket';

  return `ticket-${prefix}-${suffix}`;
}

async function endEventAndSendReport(guild, fallbackChannelId, eventName, roleId, requester) {
  const { summary, present, absent } = await eventManager.endEvent(guild, eventName, roleId);
  const { attachment, fileName } = buildEventReportDocument(summary, present, absent, guild);

  const targetUser = requester?.user ?? requester;
  let dmChannel = null;

  if (targetUser && typeof targetUser.createDM === 'function') {
    try {
      dmChannel = await targetUser.createDM();
      await dmChannel.send({
        content: `Aqui está o relatório do evento **${summary.eventName}**.`,
        files: [{ attachment, name: fileName }],
      });
    } catch (error) {
      console.error('Não foi possível enviar o relatório por DM:', error);
      dmChannel = null;
    }
  }

  if (dmChannel) {
    return { summary, present, absent, dmChannel };
  }

  let fallbackChannel = null;
  if (config.defaultReportChannelId) {
    fallbackChannel =
      guild.channels.cache.get(config.defaultReportChannelId) ||
      (await guild.channels.fetch(config.defaultReportChannelId).catch(() => null));
  }

  if (!fallbackChannel || !fallbackChannel.isTextBased()) {
    fallbackChannel =
      guild.channels.cache.get(fallbackChannelId) ||
      (await guild.channels.fetch(fallbackChannelId).catch(() => null));
  }

  if (!fallbackChannel || !fallbackChannel.isTextBased()) {
    throw new Error(
      'Não foi possível enviar o relatório por mensagem direta nem encontrar um canal de texto para publicação.',
    );
  }

  await fallbackChannel.send({
    content: `Não foi possível enviar o relatório do evento **${summary.eventName}** por mensagem direta. Segue o documento:`,
    files: [{ attachment, name: fileName }],
    allowedMentions: { users: [] },
  });

  return { summary, present, absent, dmChannel: null, fallbackChannel };
}

function buildEventReportDocument(summary, present, absent, guild) {
  const lines = [];
  lines.push(`Relatório do evento: ${summary.eventName}`);
  lines.push(`Servidor: ${guild?.name || 'Desconhecido'} (ID: ${guild?.id || 'n/d'})`);
  lines.push(`Cargo verificado: ${summary.roleId ? `ID ${summary.roleId}` : 'não informado'}`);
  if (summary.originalRoleId && summary.originalRoleId !== summary.roleId) {
    lines.push(`Cargo monitorado no início: ID ${summary.originalRoleId}`);
  }
  lines.push(`Início: ${new Date(summary.startedAt).toLocaleString('pt-BR')}`);
  lines.push(`Fim: ${new Date(summary.endedAt).toLocaleString('pt-BR')}`);
  lines.push('');

  lines.push(`Presentes (${present.length})`);
  if (present.length > 0) {
    for (const entry of present) {
      const roleSuffix = entry.hadRoleAtEnd ? '' : ' (sem o cargo no encerramento)';
      lines.push(`- ${entry.displayName} — ${formatDuration(entry.totalMs)}${roleSuffix}`);
    }
  } else {
    lines.push('- Nenhum membro com o cargo participou.');
  }

  lines.push('');
  lines.push(`Faltas (${absent.length})`);
  if (absent.length > 0) {
    for (const entry of absent) {
      lines.push(`- ${entry.displayName}`);
    }
  } else {
    lines.push('- Todos os membros com o cargo participaram.');
  }

  lines.push('');
  lines.push('Observações automáticas:');
  lines.push(
    '- Este documento foi gerado automaticamente com base na presença em canais de voz monitorados durante o período do evento.',
  );

  const content = lines.join('\n');
  const normalizedName = summary.eventName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const fileName = `relatorio-${normalizedName || 'evento'}.doc`;

  return { attachment: Buffer.from(content, 'utf8'), fileName };
}

async function handleEventStartInteraction(interaction) {
  const [, action, sessionId] = interaction.customId.split(':');
  const session = eventCreationSessions.get(sessionId);

  const ok = await ensureInteractiveSession(interaction, session, eventCreationSessions, {
    restartHint: 'Use `!event start` novamente para criar um evento.',
  });
  if (!ok) {
    return;
  }

  try {
    switch (action) {
      case 'setName':
        await showEventNameModal(interaction, session);
        break;
      case 'role':
        await handleRoleSelection(interaction, session);
        break;
      case 'channels':
        await handleChannelSelection(interaction, session);
        break;
      case 'confirm':
        await confirmEventCreation(interaction, session);
        break;
      case 'cancel':
        await cancelEventCreation(interaction, session);
        break;
      case 'modal':
        await handleEventNameSubmission(interaction, session);
        break;
      default:
        break;
    }
  } catch (error) {
    console.error('Erro ao lidar com interação do evento:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: `❌ Ocorreu um erro: ${error.message}`, ephemeral: true });
    }
  }
}

async function handleHelpCommand(message) {
  const prefix = config.prefix;
  const lines = [
    '**Comandos disponíveis:**',
    `• \`${prefix}event start\` — abre o assistente interativo para configurar um evento.`,
    `• \`${prefix}event start "Nome" @Cargo #Sala...\` — inicia o rastreamento de um evento.`,
    `• \`${prefix}event stop\` — abre o assistente interativo para encerrar um evento ativo.`,
    `• \`${prefix}event stop "Nome" @Cargo\` — encerra o evento e gera o relatório para o cargo informado.`,
    `• \`${prefix}event list\` — lista os eventos ativos.`,
    `• \`${prefix}reaction-role create\` — abre o assistente para publicar mensagem com cargo por reação.`,
    `• \`${prefix}reaction-role create #canal 😃 @Cargo "Mensagem"\` — cria atribuição de cargo por reação.`,
    `• \`${prefix}reaction-role remove <messageId>\` — remove a atribuição de cargo por reação.`,
    `• \`${prefix}warn\` — abre o assistente para enviar um aviso.`,
    `• \`${prefix}warn #canal "Mensagem"\` — envia um aviso para o canal informado.`,
    `• \`${prefix}ticket panel [mensagem]\` — publica um painel com botão "Abrir Ticket" no canal atual.`,
    `• \`${prefix}ticket open [motivo]\` — cria um canal privado com a equipe configurada para suporte.`,
    `• \`${prefix}ticket close\` — encerra o ticket atual (execute dentro do canal do ticket).`,
  ];

  await message.reply(lines.join('\n'));
}

async function handleReactionRoleCommand(message, args) {
  const subcommand = args.shift();
  if (!subcommand) {
    await message.reply('Use `reaction-role create` ou `reaction-role remove`.');
    return;
  }

  switch (subcommand.toLowerCase()) {
    case 'create':
      await createReactionRole(message, args);
      break;
    case 'remove':
      await removeReactionRole(message, args);
      break;
    default:
      await message.reply('Subcomando de reação desconhecido.');
  }
}

async function createReactionRole(message, args) {
  if (args.length < 4) {
    await startInteractiveReactionRoleCreation(message);
    return;
  }

  const channelId = extractId(args.shift());
  const emoji = args.shift();
  const roleId = extractId(args.shift());
  const messageContentRaw = args.join(' ');
  if (messageContentRaw.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    await message.reply(
      `A mensagem deve ter no máximo ${MAX_ASSISTANT_MESSAGE_LENGTH} caracteres para criar a reação com cargo.`,
    );
    return;
  }
  const messageContent = messageContentRaw;

  if (!channelId || !emoji || !roleId) {
    await message.reply('Confira se canal, emoji e cargo foram informados corretamente.');
    return;
  }

  const channel = await message.guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await message.reply('O canal informado não é um canal de texto.');
    return;
  }

  await reactionRoleManager.createReactionRole({
    channel,
    emoji,
    roleId,
    messageContent,
  });

  await message.reply('Mensagem de reação criada com sucesso.');
}

async function removeReactionRole(message, args) {
  if (args.length < 1) {
    await message.reply('Uso: `reaction-role remove <messageId>`');
    return;
  }

  const messageId = args[0];
  await reactionRoleManager.removeReactionRole(messageId);
  await message.reply('Reação de cargo removida.');
}

async function handleWarnCommand(message, args) {
  if (args.length < 2) {
    await startInteractiveWarn(message);
    return;
  }

  const channelId = extractId(args.shift());
  const contentRaw = args.join(' ');
  if (contentRaw.length > MAX_ASSISTANT_MESSAGE_LENGTH) {
    await message.reply(
      `O aviso deve ter no máximo ${MAX_ASSISTANT_MESSAGE_LENGTH} caracteres para ser enviado.`,
    );
    return;
  }
  const content = contentRaw;
  const channel = await message.guild.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    await message.reply('Informe um canal de texto válido.');
    return;
  }

  await channel.send({ content });
  if (channel.id !== message.channel.id) {
    await message.reply('Aviso enviado.');
  }
}

function generateSessionId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function startInteractiveEvent(message) {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    userId: message.author.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: null,
    eventName: '',
    roleId: null,
    channelIds: [],
    createdAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
  };

  const reply = await message.reply({
    content: `<@${session.userId}> vamos configurar o evento!`,
    embeds: [buildEventSetupEmbed(session)],
    components: buildEventSetupComponents(session),
    allowedMentions: { users: [session.userId] },
  });

  session.messageId = reply.id;
  eventCreationSessions.set(sessionId, session);
}

function buildEventSetupEmbed(session) {
  const expiresTimestamp = Math.floor(session.expiresAt / 1000);
  const roleValue = session.roleId ? `<@&${session.roleId}>` : 'Selecione um cargo monitorado.';
  const channelValue = session.channelIds.length
    ? session.channelIds.map((channelId) => `<#${channelId}>`).join(', ')
    : 'Selecione pelo menos um canal de voz.';

  return new EmbedBuilder()
    .setTitle('Assistente de evento')
    .setDescription(
      `Defina o nome, cargo monitorado e canais de voz. Esta configuração expira <t:${expiresTimestamp}:R>. ` +
        'Somente você pode interagir com estes controles.',
    )
    .addFields(
      {
        name: 'Nome do evento',
        value: session.eventName ? `**${session.eventName}**` : 'Clique em **Definir nome** para informar o título do evento.',
      },
      { name: 'Cargo monitorado', value: roleValue },
      { name: 'Canais monitorados', value: channelValue },
    )
    .setColor(0x5865f2)
    .setTimestamp();
}

function buildEventSetupComponents(session) {
  const rows = [];

  const nameButton = new ButtonBuilder()
    .setCustomId(`eventStart:setName:${session.id}`)
    .setLabel(session.eventName ? 'Alterar nome' : 'Definir nome')
    .setStyle(ButtonStyle.Primary);

  const confirmButton = new ButtonBuilder()
    .setCustomId(`eventStart:confirm:${session.id}`)
    .setLabel('Iniciar evento')
    .setStyle(ButtonStyle.Success)
    .setDisabled(!session.eventName || !session.roleId || session.channelIds.length === 0);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`eventStart:cancel:${session.id}`)
    .setLabel('Cancelar')
    .setStyle(ButtonStyle.Secondary);

  rows.push(new ActionRowBuilder().addComponents(nameButton, confirmButton, cancelButton));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`eventStart:role:${session.id}`)
    .setPlaceholder(session.roleId ? 'Cargo selecionado' : 'Selecione um cargo')
    .setMinValues(1)
    .setMaxValues(1);

  if (session.roleId) {
    roleSelect.setDefaultRoles([session.roleId]);
  }

  rows.push(new ActionRowBuilder().addComponents(roleSelect));

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`eventStart:channels:${session.id}`)
    .setPlaceholder(
      session.channelIds.length > 0 ? 'Canais selecionados' : 'Selecione um ou mais canais de voz',
    )
    .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
    .setMinValues(1)
    .setMaxValues(10);

  if (session.channelIds.length > 0) {
    channelSelect.setDefaultChannels(session.channelIds);
  }

  rows.push(new ActionRowBuilder().addComponents(channelSelect));

  return rows;
}

async function showEventNameModal(interaction, session) {
  if (typeof interaction.showModal !== 'function') return;

  const modal = new ModalBuilder().setCustomId(`eventStart:modal:${session.id}`).setTitle('Nome do evento');
  const textInput = new TextInputBuilder()
    .setCustomId('eventName')
    .setLabel('Qual é o nome do evento?')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(100)
    .setRequired(true);

  if (session.eventName) {
    textInput.setValue(session.eventName);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleEventNameSubmission(interaction, session) {
  const eventName = interaction.fields.getTextInputValue('eventName').trim();
  if (!eventName) {
    await interaction.reply({ content: 'Informe um nome válido para o evento.', ephemeral: true });
    return;
  }

  session.eventName = eventName;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos configurar o evento!`,
      embeds: [buildEventSetupEmbed(session)],
      components: buildEventSetupComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({ content: `Nome atualizado para **${eventName}**.`, ephemeral: true });
}

async function handleRoleSelection(interaction, session) {
  const selected = interaction.values?.[0];
  if (!selected) {
    await interaction.reply({ content: 'Selecione um cargo válido.', ephemeral: true });
    return;
  }

  session.roleId = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos configurar o evento!`,
    embeds: [buildEventSetupEmbed(session)],
    components: buildEventSetupComponents(session),
    allowedMentions: { users: [] },
  });
}

async function handleChannelSelection(interaction, session) {
  const selected = interaction.values || [];
  if (!selected.length) {
    await interaction.reply({ content: 'Selecione pelo menos um canal de voz.', ephemeral: true });
    return;
  }

  session.channelIds = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos configurar o evento!`,
    embeds: [buildEventSetupEmbed(session)],
    components: buildEventSetupComponents(session),
    allowedMentions: { users: [] },
  });
}

async function confirmEventCreation(interaction, session) {
  if (!session.eventName || !session.roleId || session.channelIds.length === 0) {
    await interaction.reply({
      content: 'Defina nome, cargo monitorado e canais antes de iniciar o evento.',
      ephemeral: true,
    });
    return;
  }

  try {
    await eventManager.startEvent(
      interaction.guild,
      session.eventName,
      session.roleId,
      session.channelIds,
      session.userId,
    );
  } catch (error) {
    await interaction.reply({ content: `❌ Não foi possível iniciar: ${error.message}`, ephemeral: true });
    return;
  }

  eventCreationSessions.delete(session.id);

  const startedEmbed = new EmbedBuilder()
    .setTitle(`Evento iniciado: ${session.eventName}`)
    .setDescription('O rastreamento foi iniciado com sucesso.')
    .addFields(
      { name: 'Cargo monitorado', value: `<@&${session.roleId}>` },
      { name: 'Canais', value: session.channelIds.map((channelId) => `<#${channelId}>`).join(', ') },
    )
    .setColor(0x57f287)
    .setTimestamp(new Date());

  await interaction.update({
    content: `<@${session.userId}> evento iniciado!`,
    embeds: [startedEmbed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });

  if (typeof interaction.followUp === 'function') {
    await interaction.followUp({
      content: '✅ Evento iniciado com sucesso. Use `!event stop "Nome" @Cargo` quando terminar.',
      ephemeral: true,
    });
  }
}

async function cancelEventCreation(interaction, session) {
  eventCreationSessions.delete(session.id);

  const embed = new EmbedBuilder()
    .setTitle('Configuração cancelada')
    .setDescription('O assistente de criação de evento foi cancelado.')
    .setColor(0xed4245)
    .setTimestamp();

  await interaction.update({
    content: `<@${session.userId}> assistente cancelado.`,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });
}

async function startInteractiveEventStop(message) {
  const events = eventManager.listActive().filter((event) => event.guildId === message.guild.id);
  if (events.length === 0) {
    await message.reply('Não há eventos ativos para encerrar neste servidor.');
    return;
  }

  if (events.length > 25) {
    await message.reply(
      'Há muitos eventos ativos para listar aqui. Use `!event stop "Nome" @Cargo` informando o evento manualmente.',
    );
    return;
  }

  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    userId: message.author.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    events,
    selectedEventIndex: null,
    roleId: null,
  };

  const reply = await message.reply({
    content: `<@${session.userId}> vamos encerrar um evento ativo.`,
    embeds: [buildEventStopEmbed(session)],
    components: buildEventStopComponents(session),
    allowedMentions: { users: [] },
  });

  session.messageId = reply.id;
  eventStopSessions.set(session.id, session);
}

function buildEventStopEmbed(session) {
  const embed = new EmbedBuilder()
    .setTitle('Encerrar evento')
    .setDescription('Selecione o evento ativo e o cargo para gerar o relatório de presença.')
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  const selectedEvent =
    session.selectedEventIndex !== null ? session.events[session.selectedEventIndex] : null;
  embed.addFields(
    {
      name: 'Evento selecionado',
      value: selectedEvent ? `**${selectedEvent.name}**` : 'Nenhum evento selecionado.',
    },
    {
      name: 'Cargo para verificar presenças',
      value: session.roleId ? `<@&${session.roleId}>` : 'Nenhum cargo selecionado.',
    },
  );

  if (selectedEvent) {
    const channels = selectedEvent.channelIds.map((id) => `<#${id}>`).join(', ');
    embed.addFields({ name: 'Canais monitorados', value: channels || 'Nenhum canal registrado.' });
  }

  return embed;
}

function buildEventStopComponents(session) {
  const rows = [];

  const eventSelect = new StringSelectMenuBuilder()
    .setCustomId(`eventStop:event:${session.id}`)
    .setPlaceholder('Selecione o evento a encerrar')
    .setMinValues(1)
    .setMaxValues(1);

  session.events.forEach((event, index) => {
    const option = new StringSelectMenuOptionBuilder()
      .setLabel(event.name.length > 100 ? `${event.name.slice(0, 97)}...` : event.name)
      .setValue(String(index));

    const descriptionParts = [];
    descriptionParts.push(event.roleId ? 'Cargo monitorado definido' : 'Cargo original desconhecido');
    descriptionParts.push(`Salas: ${event.channelIds.length}`);
    option.setDescription(descriptionParts.join(' | ').slice(0, 100));

    if (session.selectedEventIndex === index) {
      option.setDefault(true);
    }

    eventSelect.addOptions(option);
  });

  rows.push(new ActionRowBuilder().addComponents(eventSelect));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`eventStop:role:${session.id}`)
    .setPlaceholder('Selecione o cargo para verificar as presenças')
    .setMinValues(1)
    .setMaxValues(1);

  if (session.roleId) {
    roleSelect.setDefaultRoles([session.roleId]);
  }

  rows.push(new ActionRowBuilder().addComponents(roleSelect));

  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`eventStop:confirm:${session.id}`)
      .setLabel('Encerrar evento')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`eventStop:cancel:${session.id}`)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );

  rows.push(buttons);

  return rows;
}

async function handleEventStopInteraction(interaction) {
  const [, action, sessionId] = interaction.customId.split(':');
  const session = eventStopSessions.get(sessionId);

  const ok = await ensureInteractiveSession(interaction, session, eventStopSessions, {
    restartHint: 'Use `!event stop` novamente para encerrar um evento.',
  });
  if (!ok) {
    return;
  }

  switch (action) {
    case 'event':
      await handleEventStopSelection(interaction, session);
      break;
    case 'role':
      await handleEventStopRoleSelection(interaction, session);
      break;
    case 'confirm':
      await confirmEventStop(interaction, session);
      break;
    case 'cancel':
      await cancelEventStop(interaction, session);
      break;
    default:
      break;
  }
}

async function handleEventStopSelection(interaction, session) {
  const value = interaction.values?.[0];
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index >= session.events.length) {
    await interaction.reply({ content: 'Selecione um evento válido.', ephemeral: true });
    return;
  }

  session.selectedEventIndex = index;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos encerrar um evento ativo.`,
    embeds: [buildEventStopEmbed(session)],
    components: buildEventStopComponents(session),
    allowedMentions: { users: [] },
  });
}

async function handleEventStopRoleSelection(interaction, session) {
  const selected = interaction.values?.[0];
  if (!selected) {
    await interaction.reply({ content: 'Selecione um cargo válido.', ephemeral: true });
    return;
  }

  session.roleId = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos encerrar um evento ativo.`,
    embeds: [buildEventStopEmbed(session)],
    components: buildEventStopComponents(session),
    allowedMentions: { users: [] },
  });
}

async function confirmEventStop(interaction, session) {
  const selectedEvent =
    session.selectedEventIndex !== null ? session.events[session.selectedEventIndex] : null;
  if (!selectedEvent) {
    await interaction.reply({ content: 'Selecione um evento antes de confirmar.', ephemeral: true });
    return;
  }

  if (!session.roleId) {
    await interaction.reply({ content: 'Escolha um cargo para verificar as presenças.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await endEventAndSendReport(
      interaction.guild,
      session.channelId,
      selectedEvent.name,
      session.roleId,
      interaction.member || interaction.user,
    );

    eventStopSessions.delete(session.id);

    const embed = new EmbedBuilder()
      .setTitle('Evento encerrado')
      .setDescription(`O evento **${selectedEvent.name}** foi encerrado.`)
      .addFields({ name: 'Cargo verificado', value: `<@&${session.roleId}>` })
      .setColor(0x57f287)
      .setTimestamp(new Date());

    if (result.dmChannel) {
      embed.addFields({ name: 'Relatório', value: 'Enviado por mensagem direta.' });
    } else if (result.fallbackChannel) {
      embed.addFields({ name: 'Relatório', value: `<#${result.fallbackChannel.id}>` });
    }

    await interaction.message.edit({
      content: `<@${session.userId}> evento encerrado.`,
      embeds: [embed],
      components: [],
      allowedMentions: { users: [session.userId] },
    });

    if (result.dmChannel) {
      await interaction.editReply({
        content: '✅ Evento encerrado. O relatório foi enviado por mensagem direta.',
      });
    } else if (result.fallbackChannel) {
      const sameChannel = result.fallbackChannel.id === session.channelId;
      const acknowledgement = sameChannel
        ? '✅ Evento encerrado. Não foi possível enviar por DM, então o relatório foi publicado nesta sala.'
        : `✅ Evento encerrado. Não foi possível enviar por DM, então o relatório foi publicado em <#${result.fallbackChannel.id}>.`;
      await interaction.editReply({ content: acknowledgement });
    }
  } catch (error) {
    console.error('Erro ao encerrar evento interativamente:', error);
    await interaction.editReply({ content: `❌ Não foi possível encerrar o evento: ${error.message}` });
  }
}

async function cancelEventStop(interaction, session) {
  eventStopSessions.delete(session.id);

  const embed = new EmbedBuilder()
    .setTitle('Encerramento cancelado')
    .setDescription('O assistente para encerrar o evento foi cancelado.')
    .setColor(0xed4245)
    .setTimestamp(new Date());

  await interaction.update({
    content: `<@${session.userId}> assistente cancelado.`,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });
}

async function startInteractiveWarn(message) {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    userId: message.author.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 10 * 60 * 1000,
    targetChannelId: null,
    messageContent: '',
    roleIds: [],
    image: null,
    awaitingAttachment: false,
  };

  const reply = await message.reply({
    content: `<@${session.userId}> vamos preparar um aviso.`,
    embeds: [buildWarnEmbed(session)],
    components: buildWarnComponents(session),
    allowedMentions: { users: [] },
  });

  session.messageId = reply.id;
  warnSessions.set(session.id, session);
}

function buildWarnEmbed(session) {
  const embed = new EmbedBuilder()
    .setTitle('Enviar aviso')
    .setDescription('Escolha o canal e defina a mensagem que será enviada.')
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  embed.addFields(
    {
      name: 'Canal alvo',
      value: session.targetChannelId ? `<#${session.targetChannelId}>` : 'Nenhum canal selecionado.',
    },
    {
      name: 'Mensagem',
      value: session.messageContent
        ? session.messageContent.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH)
        : 'Nenhuma mensagem definida.',
    },
    {
      name: 'Cargos mencionados',
      value:
        session.roleIds && session.roleIds.length > 0
          ? session.roleIds.map((roleId) => `<@&${roleId}>`).join(', ')
          : 'Nenhum cargo selecionado.',
    },
    {
      name: 'Imagem',
      value: session.awaitingAttachment
        ? 'Aguardando envio da imagem...'
        : session.image
        ? `[${session.image.name}](${session.image.url})`
        : 'Nenhuma imagem selecionada.',
    },
  );

  if (session.image?.url) {
    embed.setImage(session.image.url);
  }

  return embed;
}

function buildWarnComponents(session) {
  const rows = [];

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`warn:channel:${session.id}`)
    .setPlaceholder('Selecione o canal para enviar o aviso')
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  if (session.targetChannelId) {
    channelSelect.setDefaultChannels([session.targetChannelId]);
  }

  rows.push(new ActionRowBuilder().addComponents(channelSelect));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`warn:roles:${session.id}`)
    .setPlaceholder(
      session.roleIds && session.roleIds.length > 0
        ? 'Cargos selecionados'
        : 'Selecione cargos para mencionar',
    )
    .setMinValues(0)
    .setMaxValues(10);

  if (session.roleIds && session.roleIds.length > 0) {
    roleSelect.setDefaultRoles(session.roleIds);
  }

  rows.push(new ActionRowBuilder().addComponents(roleSelect));

  const actionButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`warn:setMessage:${session.id}`)
      .setLabel('Editar mensagem')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`warn:addImage:${session.id}`)
      .setLabel('Adicionar imagem')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(Boolean(session.awaitingAttachment)),
    new ButtonBuilder()
      .setCustomId(`warn:removeImage:${session.id}`)
      .setLabel('Remover imagem')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!session.image),
    new ButtonBuilder()
      .setCustomId(`warn:confirm:${session.id}`)
      .setLabel('Enviar aviso')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`warn:cancel:${session.id}`)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );

  rows.push(actionButtons);

  return rows;
}

function buildWarnContent(session) {
  const mentionText = session.roleIds && session.roleIds.length > 0
    ? session.roleIds.map((roleId) => `<@&${roleId}>`).join(' ')
    : '';

  if (!mentionText) {
    return session.messageContent;
  }

  if (!session.messageContent) {
    return mentionText;
  }

  return `${mentionText}\n${session.messageContent}`;
}

async function handleWarnInteraction(interaction) {
  const [, action, sessionId] = interaction.customId.split(':');
  const session = warnSessions.get(sessionId);

  const ok = await ensureInteractiveSession(interaction, session, warnSessions, {
    restartHint: 'Use `!warn` novamente para enviar um aviso.',
  });
  if (!ok) {
    return;
  }

  switch (action) {
    case 'channel':
      await handleWarnChannelSelection(interaction, session);
      break;
    case 'roles':
      await handleWarnRoleSelection(interaction, session);
      break;
    case 'setMessage':
      await showWarnMessageModal(interaction, session);
      break;
    case 'addImage':
      await requestWarnImage(interaction, session);
      break;
    case 'removeImage':
      await clearWarnImage(interaction, session);
      break;
    case 'confirm':
      await confirmWarn(interaction, session);
      break;
    case 'cancel':
      await cancelWarn(interaction, session);
      break;
    case 'modal':
      await handleWarnMessageSubmission(interaction, session);
      break;
    default:
      break;
  }
}

async function handleWarnChannelSelection(interaction, session) {
  const selected = interaction.values?.[0];
  if (!selected) {
    await interaction.reply({ content: 'Selecione um canal válido.', ephemeral: true });
    return;
  }

  session.targetChannelId = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos preparar um aviso.`,
    embeds: [buildWarnEmbed(session)],
    components: buildWarnComponents(session),
    allowedMentions: { users: [] },
  });
}

async function handleWarnRoleSelection(interaction, session) {
  const roleIds = Array.isArray(interaction.values) ? interaction.values : [];

  session.roleIds = roleIds;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos preparar um aviso.`,
    embeds: [buildWarnEmbed(session)],
    components: buildWarnComponents(session),
    allowedMentions: { users: [] },
  });
}

async function showWarnMessageModal(interaction, session) {
  if (typeof interaction.showModal !== 'function') return;

  const modal = new ModalBuilder().setCustomId(`warn:modal:${session.id}`).setTitle('Mensagem do aviso');
  const textInput = new TextInputBuilder()
    .setCustomId('warnMessage')
    .setLabel('Qual mensagem deseja enviar?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(MAX_ASSISTANT_MESSAGE_LENGTH);

  if (session.messageContent) {
    textInput.setValue(session.messageContent.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH));
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleWarnMessageSubmission(interaction, session) {
  const messageContent = interaction.fields
    .getTextInputValue('warnMessage')
    .trim()
    .slice(0, MAX_ASSISTANT_MESSAGE_LENGTH);
  if (!messageContent) {
    await interaction.reply({ content: 'Informe uma mensagem válida.', ephemeral: true });
    return;
  }

  session.messageContent = messageContent;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos preparar um aviso.`,
      embeds: [buildWarnEmbed(session)],
      components: buildWarnComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({ content: 'Mensagem atualizada.', ephemeral: true });
}

async function confirmWarn(interaction, session) {
  if (!session.targetChannelId) {
    await interaction.reply({ content: 'Selecione um canal antes de enviar o aviso.', ephemeral: true });
    return;
  }

  if (!session.messageContent) {
    await interaction.reply({ content: 'Defina a mensagem do aviso antes de enviar.', ephemeral: true });
    return;
  }

  if (session.awaitingAttachment) {
    await interaction.reply({
      content: 'Envie a imagem solicitada ou cancele a seleção antes de enviar o aviso.',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel =
      interaction.guild.channels.cache.get(session.targetChannelId) ||
      (await interaction.guild.channels.fetch(session.targetChannelId).catch(() => null));

    if (!channel || !channel.isTextBased()) {
      throw new Error('Não foi possível acessar o canal selecionado.');
    }

    const payload = { content: buildWarnContent(session), allowedMentions: { roles: session.roleIds || [] } };
    if (session.image?.url) {
      payload.files = [new AttachmentBuilder(session.image.url, { name: session.image.name })];
    }

    await channel.send(payload);

    warnSessions.delete(session.id);

    const embed = new EmbedBuilder()
      .setTitle('Aviso enviado')
      .setDescription('O aviso foi enviado com sucesso.')
      .addFields({ name: 'Canal', value: `<#${channel.id}>` })
      .setColor(0x57f287)
      .setTimestamp(new Date());

    await interaction.message.edit({
      content: `<@${session.userId}> aviso enviado.`,
      embeds: [embed],
      components: [],
      allowedMentions: { users: [session.userId] },
    });

    await interaction.editReply({ content: '✅ Aviso publicado com sucesso.' });
  } catch (error) {
    console.error('Erro ao enviar aviso interativamente:', error);
    await interaction.editReply({ content: `❌ Não foi possível enviar o aviso: ${error.message}` });
  }
}

async function cancelWarn(interaction, session) {
  warnSessions.delete(session.id);

  const embed = new EmbedBuilder()
    .setTitle('Envio cancelado')
    .setDescription('O assistente de aviso foi cancelado.')
    .setColor(0xed4245)
    .setTimestamp(new Date());

  await interaction.update({
    content: `<@${session.userId}> assistente cancelado.`,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });
}

function findWarnAttachmentSession(message) {
  for (const session of warnSessions.values()) {
    if (
      session.awaitingAttachment &&
      session.guildId === message.guild.id &&
      session.channelId === message.channel.id &&
      session.userId === message.author.id
    ) {
      return session;
    }
  }

  return null;
}

async function handleWarnAttachmentMessage(message, session) {
  const attachment = message.attachments.find((item) => {
    if (!item) return false;
    const contentType = item.contentType || '';
    if (contentType.startsWith('image/')) return true;
    return /\.(png|jpe?g|gif|webp)$/i.test(item.name || '');
  });

  if (!attachment) {
    await message.reply('Envie uma imagem válida para anexar ao aviso.');
    return true;
  }

  session.image = {
    url: attachment.url,
    name: attachment.name || 'imagem.png',
  };
  session.awaitingAttachment = false;
  session.updatedAt = Date.now();

  const sessionMessage = await fetchSessionMessage(message.guild, session);
  if (sessionMessage) {
    await sessionMessage.edit({
      content: `<@${session.userId}> vamos preparar um aviso.`,
      embeds: [buildWarnEmbed(session)],
      components: buildWarnComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await message.reply('✅ Imagem adicionada ao aviso.');

  return true;
}

async function requestWarnImage(interaction, session) {
  session.awaitingAttachment = true;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos preparar um aviso.`,
      embeds: [buildWarnEmbed(session)],
      components: buildWarnComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({
    content: 'Envie a imagem desejada neste canal. Ela substituirá qualquer imagem selecionada anteriormente.',
    ephemeral: true,
  });
}

async function clearWarnImage(interaction, session) {
  if (!session.image) {
    await interaction.reply({ content: 'Nenhuma imagem foi selecionada.', ephemeral: true });
    return;
  }

  session.image = null;
  session.awaitingAttachment = false;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos preparar um aviso.`,
      embeds: [buildWarnEmbed(session)],
      components: buildWarnComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({ content: 'Imagem removida do aviso.', ephemeral: true });
}

async function startInteractiveReactionRoleCreation(message) {
  const sessionId = generateSessionId();
  const session = {
    id: sessionId,
    userId: message.author.id,
    guildId: message.guild.id,
    channelId: message.channel.id,
    messageId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60 * 1000,
    targetChannelId: null,
    roleId: null,
    emoji: '',
    messageContent: '',
  };

  const reply = await message.reply({
    content: `<@${session.userId}> vamos configurar a reação com cargo.`,
    embeds: [buildReactionRoleEmbed(session)],
    components: buildReactionRoleComponents(session),
    allowedMentions: { users: [] },
  });

  session.messageId = reply.id;
  reactionRoleSessions.set(session.id, session);
}

function buildReactionRoleEmbed(session) {
  const embed = new EmbedBuilder()
    .setTitle('Criar cargo por reação')
    .setDescription('Informe o canal, a mensagem, o emoji e o cargo que será atribuído.')
    .setColor(0x5865f2)
    .setTimestamp(new Date());

  embed.addFields(
    { name: 'Canal', value: session.targetChannelId ? `<#${session.targetChannelId}>` : 'Nenhum canal selecionado.' },
    { name: 'Cargo', value: session.roleId ? `<@&${session.roleId}>` : 'Nenhum cargo selecionado.' },
    { name: 'Emoji', value: session.emoji || 'Nenhum emoji definido.' },
    {
      name: 'Mensagem',
      value: session.messageContent
        ? session.messageContent.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH)
        : 'Nenhuma mensagem definida.',
    },
  );

  return embed;
}

function buildReactionRoleComponents(session) {
  const rows = [];

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId(`reactionRoleCreate:channel:${session.id}`)
    .setPlaceholder('Selecione o canal da mensagem')
    .setMinValues(1)
    .setMaxValues(1)
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);

  if (session.targetChannelId) {
    channelSelect.setDefaultChannels([session.targetChannelId]);
  }

  rows.push(new ActionRowBuilder().addComponents(channelSelect));

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId(`reactionRoleCreate:role:${session.id}`)
    .setPlaceholder('Selecione o cargo que será atribuído')
    .setMinValues(1)
    .setMaxValues(1);

  if (session.roleId) {
    roleSelect.setDefaultRoles([session.roleId]);
  }

  rows.push(new ActionRowBuilder().addComponents(roleSelect));

  const configureButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`reactionRoleCreate:setEmoji:${session.id}`)
      .setLabel('Definir emoji')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`reactionRoleCreate:setMessage:${session.id}`)
      .setLabel('Editar mensagem')
      .setStyle(ButtonStyle.Primary),
  );

  rows.push(configureButtons);

  const confirmButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`reactionRoleCreate:confirm:${session.id}`)
      .setLabel('Criar')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reactionRoleCreate:cancel:${session.id}`)
      .setLabel('Cancelar')
      .setStyle(ButtonStyle.Secondary),
  );

  rows.push(confirmButtons);

  return rows;
}

async function handleReactionRoleCreationInteraction(interaction) {
  const [, action, sessionId] = interaction.customId.split(':');
  const session = reactionRoleSessions.get(sessionId);

  const ok = await ensureInteractiveSession(interaction, session, reactionRoleSessions, {
    restartHint: 'Use `!reaction-role create` novamente para configurar a reação.',
  });
  if (!ok) {
    return;
  }

  switch (action) {
    case 'channel':
      await handleReactionRoleChannelSelection(interaction, session);
      break;
    case 'role':
      await handleReactionRoleRoleSelection(interaction, session);
      break;
    case 'setEmoji':
      await showReactionRoleEmojiModal(interaction, session);
      break;
    case 'setMessage':
      await showReactionRoleMessageModal(interaction, session);
      break;
    case 'confirm':
      await confirmReactionRoleCreation(interaction, session);
      break;
    case 'cancel':
      await cancelReactionRoleCreation(interaction, session);
      break;
    case 'emojiModal':
      await handleReactionRoleEmojiSubmission(interaction, session);
      break;
    case 'messageModal':
      await handleReactionRoleMessageSubmission(interaction, session);
      break;
    default:
      break;
  }
}

async function handleReactionRoleChannelSelection(interaction, session) {
  const selected = interaction.values?.[0];
  if (!selected) {
    await interaction.reply({ content: 'Selecione um canal válido.', ephemeral: true });
    return;
  }

  session.targetChannelId = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos configurar a reação com cargo.`,
    embeds: [buildReactionRoleEmbed(session)],
    components: buildReactionRoleComponents(session),
    allowedMentions: { users: [] },
  });
}

async function handleReactionRoleRoleSelection(interaction, session) {
  const selected = interaction.values?.[0];
  if (!selected) {
    await interaction.reply({ content: 'Selecione um cargo válido.', ephemeral: true });
    return;
  }

  session.roleId = selected;
  session.updatedAt = Date.now();

  await interaction.update({
    content: `<@${session.userId}> vamos configurar a reação com cargo.`,
    embeds: [buildReactionRoleEmbed(session)],
    components: buildReactionRoleComponents(session),
    allowedMentions: { users: [] },
  });
}

async function showReactionRoleEmojiModal(interaction, session) {
  if (typeof interaction.showModal !== 'function') return;

  const modal = new ModalBuilder()
    .setCustomId(`reactionRoleCreate:emojiModal:${session.id}`)
    .setTitle('Emoji da reação');

  const textInput = new TextInputBuilder()
    .setCustomId('reactionEmoji')
    .setLabel('Informe o emoji que será usado na reação')
    .setStyle(TextInputStyle.Short)
    .setMaxLength(20)
    .setRequired(true);

  if (session.emoji) {
    textInput.setValue(session.emoji);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleReactionRoleEmojiSubmission(interaction, session) {
  const emoji = interaction.fields.getTextInputValue('reactionEmoji').trim();
  if (!emoji) {
    await interaction.reply({ content: 'Informe um emoji válido.', ephemeral: true });
    return;
  }

  session.emoji = emoji;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos configurar a reação com cargo.`,
      embeds: [buildReactionRoleEmbed(session)],
      components: buildReactionRoleComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({ content: 'Emoji atualizado.', ephemeral: true });
}

async function showReactionRoleMessageModal(interaction, session) {
  if (typeof interaction.showModal !== 'function') return;

  const modal = new ModalBuilder()
    .setCustomId(`reactionRoleCreate:messageModal:${session.id}`)
    .setTitle('Mensagem da reação');

  const textInput = new TextInputBuilder()
    .setCustomId('reactionMessage')
    .setLabel('Qual mensagem o bot deve enviar?')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(MAX_ASSISTANT_MESSAGE_LENGTH)
    .setRequired(true);

  if (session.messageContent) {
    textInput.setValue(session.messageContent.slice(0, MAX_ASSISTANT_MESSAGE_LENGTH));
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleReactionRoleMessageSubmission(interaction, session) {
  const messageContent = interaction.fields
    .getTextInputValue('reactionMessage')
    .trim()
    .slice(0, MAX_ASSISTANT_MESSAGE_LENGTH);
  if (!messageContent) {
    await interaction.reply({ content: 'Informe uma mensagem válida.', ephemeral: true });
    return;
  }

  session.messageContent = messageContent;
  session.updatedAt = Date.now();

  const message = await fetchSessionMessage(interaction.guild, session);
  if (message) {
    await message.edit({
      content: `<@${session.userId}> vamos configurar a reação com cargo.`,
      embeds: [buildReactionRoleEmbed(session)],
      components: buildReactionRoleComponents(session),
      allowedMentions: { users: [] },
    });
  }

  await interaction.reply({ content: 'Mensagem atualizada.', ephemeral: true });
}

async function confirmReactionRoleCreation(interaction, session) {
  if (!session.targetChannelId) {
    await interaction.reply({ content: 'Selecione um canal para publicar a mensagem.', ephemeral: true });
    return;
  }

  if (!session.roleId) {
    await interaction.reply({ content: 'Escolha o cargo que será atribuído.', ephemeral: true });
    return;
  }

  if (!session.emoji) {
    await interaction.reply({ content: 'Defina o emoji que os membros devem reagir.', ephemeral: true });
    return;
  }

  if (!session.messageContent) {
    await interaction.reply({ content: 'Escreva a mensagem que será enviada.', ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel =
      interaction.guild.channels.cache.get(session.targetChannelId) ||
      (await interaction.guild.channels.fetch(session.targetChannelId).catch(() => null));

    if (!channel || !channel.isTextBased()) {
      throw new Error('Não foi possível acessar o canal selecionado.');
    }

    const message = await reactionRoleManager.createReactionRole({
      channel,
      emoji: session.emoji,
      roleId: session.roleId,
      messageContent: session.messageContent,
    });

    reactionRoleSessions.delete(session.id);

    const embed = new EmbedBuilder()
      .setTitle('Reação criada')
      .setDescription('A mensagem de reação foi publicada com sucesso.')
      .addFields(
        { name: 'Canal', value: `<#${channel.id}>` },
        { name: 'Cargo', value: `<@&${session.roleId}>` },
        { name: 'Emoji', value: session.emoji },
        { name: 'Mensagem publicada', value: `[Abrir mensagem](${message.url})` },
      )
      .setColor(0x57f287)
      .setTimestamp(new Date());

    await interaction.message.edit({
      content: `<@${session.userId}> configuração concluída.`,
      embeds: [embed],
      components: [],
      allowedMentions: { users: [session.userId] },
    });

    await interaction.editReply({ content: '✅ Reação configurada com sucesso.' });
  } catch (error) {
    console.error('Erro ao criar reação de cargo interativamente:', error);
    await interaction.editReply({ content: `❌ Não foi possível criar a reação: ${error.message}` });
  }
}

async function cancelReactionRoleCreation(interaction, session) {
  reactionRoleSessions.delete(session.id);

  const embed = new EmbedBuilder()
    .setTitle('Configuração cancelada')
    .setDescription('O assistente de cargo por reação foi cancelado.')
    .setColor(0xed4245)
    .setTimestamp(new Date());

  await interaction.update({
    content: `<@${session.userId}> assistente cancelado.`,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });
}

async function ensureInteractiveSession(interaction, session, sessionMap, { restartHint }) {
  const hint = restartHint || 'Inicie novamente o assistente.';

  if (!session) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: `Esta configuração não está mais disponível. ${hint}`, ephemeral: true });
    }
    return false;
  }

  if (interaction.user.id !== session.userId) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Somente quem iniciou esta configuração pode usar estes controles.',
        ephemeral: true,
      });
    }
    return false;
  }

  if (Date.now() > session.expiresAt) {
    sessionMap.delete(session.id);
    await disableSessionMessage(interaction.guild, session, `Configuração expirada. ${hint}`);
    if (interaction.isRepliable()) {
      await interaction.reply({ content: `Esta configuração expirou. ${hint}`, ephemeral: true });
    }
    return false;
  }

  return true;
}

async function disableSessionMessage(guild, session, reason) {
  const message = await fetchSessionMessage(guild, session);
  if (!message) return;

  const embed = new EmbedBuilder()
    .setTitle('Assistente encerrado')
    .setDescription(reason)
    .setColor(0xfaa61a)
    .setTimestamp();

  await message.edit({
    content: `<@${session.userId}>`,
    embeds: [embed],
    components: [],
    allowedMentions: { users: [session.userId] },
  });
}

async function fetchSessionMessage(guild, session) {
  if (!guild) return null;

  const channel =
    guild.channels.cache.get(session.channelId) || (await guild.channels.fetch(session.channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) {
    return null;
  }

  const message = await channel.messages.fetch(session.messageId).catch(() => null);
  return message;
}

bootstrap()
  .then(() => {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      throw new Error('Defina a variável de ambiente DISCORD_TOKEN com o token do bot.');
    }
    return client.login(token);
  })
  .catch((error) => {
    console.error('Falha ao inicializar o bot.', error);
    process.exit(1);
  });
