require('dotenv').config();

const { startBot } = require('./src/index');

startBot().catch((error) => {
  console.error('Erro fatal ao iniciar o bot.', error);
  process.exit(1);
});
