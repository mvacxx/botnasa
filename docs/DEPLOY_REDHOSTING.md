# Implantação do bot na RedHosting

Estas instruções assumem que você contratou um plano de hospedagem na [RedHosting](https://redhosting.com.br/) com suporte a Node.js, acesso SSH e gerenciamento de processos (ex.: PM2). Caso tenha contratado um plano compartilhado convencional, peça ao suporte a habilitação do ambiente Node antes de continuar.

## 1. Preparar o ambiente

1. Acesse o painel da RedHosting e verifique a versão do Node.js disponível. Ajuste o projeto para a versão suportada, se necessário.
2. Solicite ao suporte a criação de um usuário SSH e anote host, porta e senha/chave.
3. No seu computador, conecte-se ao servidor:
   ```bash
   ssh usuario@host.redhosting.com.br -p PORTA
   ```

## 2. Obter o código do bot

Dentro do servidor, escolha um diretório para manter o código (por exemplo, `~/apps/botnasa`) e faça o deploy de uma destas formas:

- **Git clone (recomendado):**
  ```bash
  mkdir -p ~/apps
  cd ~/apps
  git clone https://seu-repositorio.git botnasa
  cd botnasa
  ```
- **Upload de arquivo zip:** compacte o projeto localmente, envie via SFTP/FTP e descompacte no diretório desejado.

## 3. Configurar variáveis e arquivos de ambiente

1. Copie os arquivos de configuração de exemplo:
   ```bash
   cp config/config.example.json config/config.json
   ```
2. Edite `config/config.json` e inclua os IDs de cargos, categorias e demais opções do seu servidor.
3. Crie o arquivo `.env` com o token do bot e outros segredos:
   ```bash
   cat <<'ENV' > .env
   DISCORD_TOKEN=seu_token_aqui
   ENV
   ```
   **Importante:** mantenha este arquivo fora de sistemas de controle de versão públicos.

## 4. Instalar dependências

Certifique-se de estar no diretório do projeto (`~/apps/botnasa`) e execute:
```bash
npm install --production
```

Se o plano não permitir uso direto do `npm`, solicite ao suporte a instalação ou utilize o painel de aplicações Node.js (se disponível) para instalar as dependências.

## 5. Executar o bot com PM2

1. Instale o PM2 globalmente (se o ambiente permitir):
   ```bash
   npm install -g pm2
   ```
2. Inicie o bot:
   ```bash
   pm2 start src/index.js --name botnasa
   ```
3. Salve a configuração para reiniciar automaticamente após reboot:
   ```bash
   pm2 save
   pm2 startup
   ```
   Siga as instruções exibidas para concluir o processo de startup.

Caso não seja possível instalar o PM2, verifique se o painel da RedHosting possui um gerenciador de aplicativos Node.js. Normalmente basta apontar para o arquivo de entrada (`src/index.js`), informar a versão do Node e definir variáveis de ambiente.

## 6. Atualizações futuras

Para publicar atualizações:

1. Conecte-se via SSH e entre no diretório do projeto:
   ```bash
   cd ~/apps/botnasa
   ```
2. Obtenha as alterações (exemplo usando Git):
   ```bash
   git pull origin main
   npm install --production
   ```
3. Reinicie o processo:
   ```bash
   pm2 restart botnasa
   ```

## 7. Monitoramento e logs

- Veja o status:
  ```bash
  pm2 status
  ```
- Acompanhe logs em tempo real:
  ```bash
  pm2 logs botnasa
  ```
- Para parar o bot temporariamente:
  ```bash
  pm2 stop botnasa
  ```

Se ocorrerem erros específicos do ambiente RedHosting, abra um chamado no suporte incluindo os logs (`pm2 logs`) e detalhes do erro.

## 8. Segurança e boas práticas

- Nunca faça commit do arquivo `.env` ou de tokens do bot.
- Utilize um usuário dedicado sem privilégios administrativos para executar o bot.
- Atualize o Node.js e as dependências periodicamente.
- Configure alertas no Discord ou em ferramentas externas para saber quando o bot estiver offline.

Seguindo os passos acima, o bot deve iniciar automaticamente e permanecer online na infraestrutura da RedHosting.
