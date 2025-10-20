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
    (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit());

  if (!isRelevantInteraction) {
    return;
  }

  const customId = interaction.customId || '';
  if (!customId.startsWith('eventStart:')) {
    return;
  }

  const [, action, sessionId] = customId.split(':');
  const session = eventCreationSessions.get(sessionId);

  if (!session) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Esta configuração expirou. Use `!event start` novamente para criar um evento.',
        ephemeral: true,
      });
    }
    return;
  }

  if (interaction.user.id !== session.userId) {
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Somente quem iniciou a configuração pode interagir com estes controles.',
        ephemeral: true,
      });
    }
    return;
  }

  if (Date.now() > session.expiresAt) {
    eventCreationSessions.delete(session.id);
    await disableSessionMessage(interaction.guild, session, 'Configuração expirada. Inicie novamente com `!event start`.');
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: 'Esta configuração expirou. Use `!event start` novamente para criar um evento.',
        ephemeral: true,
      });
    }
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
    await message.reply('Uso: `event stop "Nome do Evento" <cargo>`');
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

  const { summary, present, absent } = await eventManager.endEvent(message.guild, eventName, roleId);

  const embed = new EmbedBuilder()
    .setTitle(`Relatório do evento: ${summary.eventName}`)
    .setDescription(`Início: <t:${Math.floor(new Date(summary.startedAt).getTime() / 1000)}:f>\nFim: <t:${Math.floor(new Date(summary.endedAt).getTime() / 1000)}:f>`)
    .addFields(
      {
        name: `Presentes (${present.length})`,
        value: present.length > 0
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
        value: absent.length > 0
          ? absent.map((entry) => `• ${entry.displayName}`).join('\n')
          : 'Todos os membros com o cargo participaram.',
      },
    )
    .setTimestamp(new Date(summary.endedAt));

  if (summary.originalRoleId && summary.originalRoleId !== summary.roleId) {
    embed.addFields({
      name: 'Cargo monitorado no início',
      value: `<@&${summary.originalRoleId}>`,
    });
  }

  const targetChannelId = config.defaultReportChannelId || message.channelId;
  const targetChannel = message.guild.channels.cache.get(targetChannelId) || message.channel;
  await targetChannel.send({ embeds: [embed] });
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

async function handleHelpCommand(message) {
  const prefix = config.prefix;
  const lines = [
    '**Comandos disponíveis:**',
    `• \`${prefix}event start\` — abre o assistente interativo para configurar um evento.`,
    `• \`${prefix}event start "Nome" @Cargo #Sala...\` — inicia o rastreamento de um evento.`,
    `• \`${prefix}event stop "Nome" @Cargo\` — encerra o evento e gera o relatório para o cargo informado.`,
    `• \`${prefix}event list\` — lista os eventos ativos.`,
    `• \`${prefix}reaction-role create #canal 😃 @Cargo "Mensagem"\` — cria atribuição de cargo por reação.`,
    `• \`${prefix}reaction-role remove <messageId>\` — remove a atribuição de cargo por reação.`,
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
    await message.reply('Uso: `reaction-role create <canal> <emoji> <cargo> "Mensagem"`');
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
    await message.reply('Uso: `warn <canal> "Mensagem"`');
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
