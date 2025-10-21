require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
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
const { extractId, formatDuration } = require('./utils/parsers');
const { splitArgs } = require('./utils/args');

const configPath = path.join(__dirname, '..', 'config', 'config.json');
const defaultConfig = { prefix: '!', defaultReportChannelId: '' };
const config = fs.existsSync(configPath)
  ? { ...defaultConfig, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) }
  : defaultConfig;

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
const eventCreationSessions = new Map();
const eventStopSessions = new Map();
const warnSessions = new Map();
const reactionRoleSessions = new Map();

async function bootstrap() {
  await eventManager.init();
  await reactionRoleManager.init();
}

client.once('ready', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  eventManager.handleVoiceUpdate(oldState, newState);
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
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

  const { targetChannel } = await endEventAndSendReport(message.guild, message.channelId, eventName, roleId);

  if (targetChannel.id !== message.channel.id) {
    await message.reply(`Relatório enviado para <#${targetChannel.id}>.`);
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

async function endEventAndSendReport(guild, fallbackChannelId, eventName, roleId) {
  const { summary, present, absent } = await eventManager.endEvent(guild, eventName, roleId);
  const embed = buildEventReportEmbed(summary, present, absent);

  let targetChannel = null;
  if (config.defaultReportChannelId) {
    targetChannel =
      guild.channels.cache.get(config.defaultReportChannelId) ||
      (await guild.channels.fetch(config.defaultReportChannelId).catch(() => null));
  }

  if (!targetChannel || !targetChannel.isTextBased()) {
    targetChannel =
      guild.channels.cache.get(fallbackChannelId) ||
      (await guild.channels.fetch(fallbackChannelId).catch(() => null));
  }

  if (!targetChannel || !targetChannel.isTextBased()) {
    throw new Error('Não foi possível encontrar um canal de texto para enviar o relatório.');
  }

  await targetChannel.send({ embeds: [embed] });

  return { summary, present, absent, embed, targetChannel };
}

function buildEventReportEmbed(summary, present, absent) {
  const embed = new EmbedBuilder()
    .setTitle(`Relatório do evento: ${summary.eventName}`)
    .setDescription(
      `Início: <t:${Math.floor(new Date(summary.startedAt).getTime() / 1000)}:f>\n` +
        `Fim: <t:${Math.floor(new Date(summary.endedAt).getTime() / 1000)}:f>`,
    )
    .addFields(
      {
        name: `Presentes (${present.length})`,
        value:
          present.length > 0
            ? present
                .map((entry) => {
                  const suffix = entry.hadRoleAtEnd ? '' : ' _(sem o cargo no encerramento)_';
                  return `• ${entry.displayName} — ${formatDuration(entry.totalMs)}${suffix}`;
                })
                .join('\n')
            : 'Nenhum membro com o cargo participou.',
      },
      {
        name: `Faltas (${absent.length})`,
        value:
          absent.length > 0
            ? absent.map((entry) => `• ${entry.displayName}`).join('\n')
            : 'Todos os membros com o cargo participaram.',
      },
    )
    .setTimestamp(new Date(summary.endedAt));

  if (summary.originalRoleId && summary.originalRoleId !== summary.roleId) {
    embed.addFields({ name: 'Cargo monitorado no início', value: `<@&${summary.originalRoleId}>` });
  }

  return embed;
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
  const messageContent = args.join(' ');

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
  const content = args.join(' ');
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
    const { targetChannel } = await endEventAndSendReport(
      interaction.guild,
      session.channelId,
      selectedEvent.name,
      session.roleId,
    );

    eventStopSessions.delete(session.id);

    const embed = new EmbedBuilder()
      .setTitle('Evento encerrado')
      .setDescription(`O evento **${selectedEvent.name}** foi encerrado e o relatório foi publicado.`)
      .addFields(
        { name: 'Cargo verificado', value: `<@&${session.roleId}>` },
        { name: 'Relatório', value: `<#${targetChannel.id}>` },
      )
      .setColor(0x57f287)
      .setTimestamp(new Date());

    await interaction.message.edit({
      content: `<@${session.userId}> evento encerrado.`,
      embeds: [embed],
      components: [],
      allowedMentions: { users: [session.userId] },
    });

    const acknowledgement =
      targetChannel.id === session.channelId
        ? '✅ Evento encerrado e relatório publicado nesta sala.'
        : `✅ Evento encerrado. O relatório foi publicado em <#${targetChannel.id}>.`;

    await interaction.editReply({ content: acknowledgement });
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
      value: session.messageContent ? session.messageContent.slice(0, 1024) : 'Nenhuma mensagem definida.',
    },
  );

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

  const actionButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`warn:setMessage:${session.id}`)
      .setLabel('Editar mensagem')
      .setStyle(ButtonStyle.Primary),
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
    case 'setMessage':
      await showWarnMessageModal(interaction, session);
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

async function showWarnMessageModal(interaction, session) {
  if (typeof interaction.showModal !== 'function') return;

  const modal = new ModalBuilder().setCustomId(`warn:modal:${session.id}`).setTitle('Mensagem do aviso');
  const textInput = new TextInputBuilder()
    .setCustomId('warnMessage')
    .setLabel('Qual mensagem deseja enviar?')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(1500);

  if (session.messageContent) {
    textInput.setValue(session.messageContent);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleWarnMessageSubmission(interaction, session) {
  const messageContent = interaction.fields.getTextInputValue('warnMessage').trim();
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

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel =
      interaction.guild.channels.cache.get(session.targetChannelId) ||
      (await interaction.guild.channels.fetch(session.targetChannelId).catch(() => null));

    if (!channel || !channel.isTextBased()) {
      throw new Error('Não foi possível acessar o canal selecionado.');
    }

    await channel.send({ content: session.messageContent });

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
      value: session.messageContent ? session.messageContent.slice(0, 1024) : 'Nenhuma mensagem definida.',
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
    .setMaxLength(1500)
    .setRequired(true);

  if (session.messageContent) {
    textInput.setValue(session.messageContent);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(textInput));
  await interaction.showModal(modal);
}

async function handleReactionRoleMessageSubmission(interaction, session) {
  const messageContent = interaction.fields.getTextInputValue('reactionMessage').trim();
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
