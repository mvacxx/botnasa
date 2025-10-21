# Documentação do bot de eventos

Este documento descreve o funcionamento de cada módulo do bot, bem como os comandos disponíveis para os administradores do servidor.

## Configuração geral

- **Token do bot:** defina a variável de ambiente `DISCORD_TOKEN` no arquivo `.env`.
- **Prefixo de comandos:** ajustável em `config/config.json` (padrão `!`).
- **Canal padrão para relatórios:** `defaultReportChannelId` no mesmo arquivo é usado como fallback caso o envio por mensagem direta falhe e o bot precise publicar o documento em um canal.

## Módulos principais

### `EventManager`
Responsável por controlar o ciclo de vida dos eventos de presença.

- **startEvent(guild, name, roleId, channelIds, startedBy):** cria um evento ativo para um cargo e uma lista de salas de voz. Todos os membros que já estiverem conectados aos canais de voz monitorados terão seu tempo contabilizado a partir do momento de criação.
- **handleVoiceUpdate(oldState, newState):** ouve as mudanças de voz dos usuários e registra automaticamente o tempo conectado para cada evento ativo. Usuários precisam possuir o cargo monitorado para terem o tempo registrado.
- **endEvent(guild, name, roleIdToCheck):** encerra o evento, calcula o tempo total dos participantes, identifica quem faltou entre os membros do cargo informado no encerramento e salva um histórico em `data/events.json`.
- **listActive():** retorna uma lista dos eventos ativos com cargo, canais monitorados e horário de início.

### `ReactionRoleManager`
Cuida das mensagens que atribuem cargos por reação.

- **createReactionRole({ channel, emoji, roleId, messageContent }):** publica uma mensagem no canal escolhido, adiciona a reação configurada e registra a associação entre a mensagem, o emoji e o cargo.
- **removeReactionRole(messageId):** remove a associação registrada sem apagar a mensagem original.
- **handleReactionAdd / handleReactionRemove:** concedem ou removem o cargo automaticamente quando um usuário (não bot) adiciona ou remove a reação configurada.
- As configurações são persistidas em `data/reaction-roles.json`.

### `Comandos do bot`

> Utilize sempre o prefixo configurado (por padrão `!`). Argumentos com espaços podem ser envolvidos por aspas duplas.

#### `event start`
- **Função:** abre um assistente interativo diretamente no chat para configurar um novo evento.
- **Como funciona:** ao digitar apenas `event start`, o bot responderá com uma mensagem contendo botões e seletores para:
  - Definir o nome do evento por meio de um modal.
  - Escolher o cargo que terá a presença monitorada.
  - Selecionar um ou mais canais de voz (ou palco) que farão parte do evento.
- **Confirmação:** após preencher todas as etapas, clique em **Iniciar evento** para ativar o rastreamento sem precisar digitar os argumentos manualmente.
- **Expiração:** o assistente expira automaticamente após alguns minutos de inatividade; nesse caso, execute o comando novamente.

#### `event start "Nome do Evento" <cargo> <canal ...>`
- **Função:** inicia o rastreamento de presença para o cargo informado em um ou mais canais de voz.
- **Parâmetros:**
  - `"Nome do Evento"`: título livre para identificar o evento.
  - `<cargo>`: menção (`@Cargo`) ou ID numérica do cargo a ser monitorado.
  - `<canal ...>`: um ou mais canais de voz (menção `#Sala` ou ID) que serão observados.
- **Comportamento:** valida os canais informados, ativa o evento e começa a contabilizar o tempo de todos os membros do cargo que entrarem nas salas.

#### `event stop`
- **Função:** abre um assistente interativo para encerrar um evento ativo sem precisar informar argumentos manualmente.
- **Como funciona:**
  - Selecione qual evento ativo deve ser encerrado.
  - Escolha o cargo que será usado para verificar presenças e faltas (pode ser diferente do cargo original monitorado).
  - Confirme para que o bot gere o relatório e envie o documento por mensagem direta; se o envio falhar, o arquivo será publicado no canal padrão ou no canal onde o comando foi usado.
- **Expiração:** assim como no assistente de criação, a sessão expira após alguns minutos de inatividade.

#### `event stop "Nome do Evento" <cargo>`
- **Função:** encerra o evento e gera um relatório usando o cargo informado para verificar quem faltou.
- **Resultado:** o bot gera um documento (`.doc`) com o resumo do evento (horários, presentes com duração formatada e faltas) e envia o arquivo por mensagem direta para o administrador que encerrou o evento.
- **Observação:** se o envio por DM falhar (por exemplo, porque o administrador bloqueia mensagens diretas do servidor), o bot publica o documento no canal configurado em `defaultReportChannelId` ou, se vazio, no canal em que o comando foi executado.

#### `event list`
- **Função:** mostra os eventos atualmente ativos no servidor, incluindo cargo monitorado, canais observados e horário de início.

#### `help`
- **Função:** lista rapidamente todos os comandos disponíveis e um resumo do uso esperado.

#### `reaction-role create <canal> <emoji> <cargo> "Mensagem"`
- **Função:** cria uma mensagem interativa para autoatribuição de cargo.
- **Parâmetros:**
  - `<canal>`: menção ou ID de um canal de texto onde a mensagem será publicada.
  - `<emoji>`: emoji (padrão ou personalizado) que os usuários devem reagir.
  - `<cargo>`: cargo a ser atribuído.
  - `"Mensagem"`: conteúdo textual da mensagem publicada (até 1024 caracteres).
- **Comportamento:** o bot envia a mensagem, adiciona a reação e armazena a configuração. Ao reagir, os membros recebem o cargo automaticamente; ao remover a reação, o cargo é retirado.

#### `reaction-role remove <messageId>`
- **Função:** remove a configuração de reação associada a uma mensagem previamente criada.
- **Parâmetros:**
  - `<messageId>`: ID da mensagem registrada no sistema de reação.

#### `reaction-role create`
- **Função:** inicia um assistente interativo para configurar uma nova mensagem com cargo por reação.
- **Como funciona:**
  - Escolha o canal de texto onde a mensagem será publicada.
  - Defina a mensagem a ser enviada (limite de 1024 caracteres) e o emoji que os usuários devem reagir.
  - Selecione o cargo que será atribuído automaticamente.
  - Confirme para que o bot publique a mensagem, reaja com o emoji e salve a configuração.
- **Expiração:** a sessão também expira após alguns minutos sem interação; execute o comando novamente caso isso ocorra.

#### `warn <canal> "Mensagem"`
- **Função:** envia um aviso para o canal informado.
- **Parâmetros:**
  - `<canal>`: menção ou ID do canal de texto.
  - `"Mensagem"`: conteúdo do aviso (até 1024 caracteres).
- **Comportamento:** o bot publica a mensagem e confirma a entrega no canal onde o comando foi usado (se diferente).

#### `warn`
- **Função:** abre um assistente interativo para enviar um aviso sem precisar informar argumentos manualmente.
- **Como funciona:**
  - Selecione o canal de destino.
  - Preencha o conteúdo do aviso em um modal (limite de 1024 caracteres para atender à API do Discord).
  - Confirme para que o bot publique a mensagem no canal escolhido.
- **Expiração:** sessões inativas são canceladas automaticamente; execute o comando novamente para reiniciar.

## Persistência de dados

- `data/events.json`: armazena o histórico de eventos encerrados, permitindo consulta posterior.
- `data/reaction-roles.json`: salva as configurações de cargos por reação.

Os arquivos reais são criados automaticamente na primeira execução. Modelos de referência estão disponíveis como `data/events.template.json` e `data/reaction-roles.template.json`.

## Boas práticas de uso

- Garanta que o bot tenha permissões para **Gerenciar cargos**, **Ler histórico de mensagens**, **Enviar mensagens**, **Gerenciar mensagens** e **Ver canais de voz**.
- Para relatórios confiáveis, instrua os membros a manterem o cargo correto antes de entrarem na chamada.
- Eventos podem ser iniciados para múltiplas salas simultaneamente; os participantes que se moverem entre as salas monitoradas continuarão tendo o tempo registrado sem interrupção.
