// Polyfill para Object.hasOwn (compatibilidade com Node < 16)
if (!Object.hasOwn) {
  Object.hasOwn = function (obj, prop) {
    return Object.prototype.hasOwnProperty.call(obj, prop);
  };
}

// ==================== CONFIGURAÇÃO DE REDE (DNS IPv4 FIRST) ====================
// Garante que o Node.js priorize IPv4 para evitar erros de ETIMEDOUT na Render ao acessar api.telegram.org
const dns = require('dns');
if (dns.setDefaultResultOrder) {
  dns.setDefaultResultOrder('ipv4first');
}

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const express = require('express');
const fs = require('fs');
const path = require('path');

const bot = new Telegraf(process.env.BOT_TOKEN);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Rota raiz para manter o serviço ativo na Render
app.get('/', (req, res) => {
  res.status(200).send('🤖 Bot Financeiro MeuFi rodando com sucesso!');
});

// Endpoint de verificação de saúde para serviços de monitoramento (UptimeRobot, cron-job, etc.)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date() });
});

// Suporte a Webhook caso configurado
app.use(bot.webhookCallback('/webhook'));

app.listen(PORT, () => {
  console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`);
});

// ==================== 1. CONEXÃO COM O MONGODB ATLAS ====================
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

if (!MONGO_URI) {
  console.error('❌ ERRO CRÍTICO: MONGO_URI não definida no arquivo .env!');
}

mongoose.set('strictQuery', false);

mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('✅ Conectado com sucesso ao MongoDB Atlas!');
  })
  .catch((err) => {
    console.error('❌ Erro na conexão com o MongoDB Atlas:', err);
  });

// ==================== 2. SCHEMA E MODELO DO MONGOOSE ====================
const UserSchema = new mongoose.Schema({
  chatId: {
    type: String,
    required: true,
    unique: true
  },
  renda: {
    type: Number,
    default: 0
  },
  limiteGeral: {
    type: Number,
    default: 0
  },
  limitesCategorias: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  contasFixas: [
    {
      nome: { type: String, required: true },
      valor: { type: Number, required: true },
      categoria: { type: String, required: true }
    }
  ],
  transacoes: [
    {
      id: { type: Number, default: Date.now },
      tipo: { type: String, required: true },
      valor: { type: Number, required: true },
      categoria: { type: String, required: true },
      descricao: { type: String, default: 'Sem descrição' },
      data: { type: Date, default: Date.now }
    }
  ],
  relatorioConfig: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  }
}, {
  timestamps: true
});

const User = mongoose.model('User', UserSchema);

// ==================== 3. CONFIGURAÇÕES E ESTADOS GERAIS ====================
const DB_FILE = path.join(__dirname, 'db.json');

// Armazena o estado temporário de conversas interativas por usuário (chatId)
const userStates = {};

// Categorias Pré-definidas e Mapeamento de Palavras-Chave
const REGRAS_CATEGORIAS = [
  {
    nome: 'Investimento ou Dinheiro Guardado',
    tipo: 'investimento',
    palavrasChave: ['investimento', 'investi', 'guardei', 'poupanca', 'cdb', 'tesouro', 'fii', 'acoes', 'cripto', 'reserva']
  },
  {
    nome: 'FastFood',
    tipo: 'gasto',
    palavrasChave: ['mcdonalds', 'mc', 'burger king', 'bk', 'ifood', 'habibs', 'subway', 'pizza', 'lanche', 'hamburguer', 'sushi', 'outback']
  },
  {
    nome: 'Contas de casa',
    tipo: 'gasto',
    palavrasChave: ['luz', 'agua', 'internet', 'aluguel', 'condominio', 'gas', 'iptu', 'enel', 'sabesp', 'net', 'claro', 'vivo']
  },
  {
    nome: 'Cartão de Credito',
    tipo: 'gasto',
    palavrasChave: ['fatura', 'cartao', 'credito', 'nubank', 'itau', 'bradesco', 'c6', 'inter']
  },
  {
    nome: 'Entreterimento',
    tipo: 'gasto',
    palavrasChave: ['cinema', 'filme', 'netflix', 'spotify', 'steam', 'jogo', 'show', 'teatro', 'ingresso', 'nintendo', 'psn', 'xbox']
  }
];

// ==================== HELPER DE FORMATAÇÃO E RESPOSTA MARKDOWN ====================
// Converte **negrito** duplo em *negrito* simples (padrão oficial do Telegram Markdown)
// e garante que todas as mensagens com formatação sejam enviadas corretamente
function formatarMarkdown(texto) {
  if (!texto) return '';
  return texto.replace(/\*\*(.*?)\*\*/g, '*$1*');
}

async function replyMD(ctx, texto, extra = {}) {
  const formatado = formatarMarkdown(texto);
  try {
    return await ctx.replyWithMarkdown(formatado, extra);
  } catch (err) {
    // Fallback limpo sem caracteres que possam quebrar a renderização
    return await ctx.reply(texto.replace(/[\*_`]/g, ''), extra).catch(() => {});
  }
}

async function editMD(ctx, texto, extra = {}) {
  const formatado = formatarMarkdown(texto);
  try {
    return await ctx.editMessageText(formatado, { parse_mode: 'Markdown', ...extra });
  } catch (err) {
    if (err.description && err.description.includes('message is not modified')) return;
    return await ctx.editMessageText(texto.replace(/[\*_`]/g, ''), extra).catch(() => {});
  }
}

// ==================== 4. BUSCA E INICIALIZAÇÃO DO PERFIL (getUserProfile) ====================
async function getUserProfile(chatId) {
  const idStr = String(chatId);
  let profile = await User.findOne({ chatId: idStr });

  if (!profile) {
    let initialData = {
      chatId: idStr,
      renda: 0,
      limiteGeral: 0,
      limitesCategorias: {},
      contasFixas: [],
      transacoes: [],
      relatorioConfig: null
    };

    // Migração automática de dados legados do db.json (caso existam)
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const localDB = JSON.parse(raw);
        if (localDB.usuarios && localDB.usuarios[idStr]) {
          const old = localDB.usuarios[idStr];
          initialData.renda = old.renda || 0;
          initialData.limiteGeral = old.limiteGeral || 0;
          initialData.limitesCategorias = old.limitesCategorias || {};
          initialData.contasFixas = old.contasFixas || [];
          initialData.transacoes = old.transacoes || [];
          initialData.relatorioConfig = old.relatorioConfig || null;
        }
      }
    } catch (_) {}

    profile = new User(initialData);
    await profile.save();
  }

  // Garantias defensivas
  if (!profile.contasFixas) profile.contasFixas = [];
  if (!profile.limitesCategorias) profile.limitesCategorias = {};
  if (!profile.transacoes) profile.transacoes = [];

  return profile;
}

// Categorização Inteligente
function categorizarMensagem(texto) {
  const textoMinusculo = texto.toLowerCase();
  for (const regra of REGRAS_CATEGORIAS) {
    const encontrou = regra.palavrasChave.some(palavra => textoMinusculo.includes(palavra));
    if (encontrou) {
      return { categoria: regra.nome, tipo: regra.tipo };
    }
  }
  return { categoria: 'Despesa', tipo: 'gasto' };
}

// Extrai e interpreta dados de uma Conta Fixa a partir de texto livre
function extrairDadosContaFixa(texto) {
  const regexValor = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
  const match = texto.match(regexValor);
  if (!match) return null;

  let valorStr = match[1];
  if (valorStr.includes('.') && valorStr.includes(',')) {
    valorStr = valorStr.replace(/\./g, '').replace(',', '.');
  } else if (valorStr.includes(',')) {
    valorStr = valorStr.replace(',', '.');
  } else if (valorStr.includes('.')) {
    const partes = valorStr.split('.');
    if (partes.length === 2 && partes[1].length === 3) {
      valorStr = partes.join('');
    }
  }
  const valor = parseFloat(valorStr);
  if (isNaN(valor) || valor <= 0) return null;

  const antes = texto.slice(0, match.index).trim();
  const depois = texto.slice(match.index + match[0].length).trim();

  let nome = '';
  let categoria = '';

  const categoriasConhecidas = [
    'Contas de casa',
    'Cartão de Credito',
    'FastFood',
    'Entreterimento',
    'Investimento ou Dinheiro Guardado',
    'Despesa'
  ];

  if (antes && depois) {
    nome = antes;
    const catEncontrada = categoriasConhecidas.find(c => c.toLowerCase() === depois.toLowerCase());
    categoria = catEncontrada || depois;
  } else {
    const textoDesc = antes || depois;
    if (!textoDesc) {
      nome = 'Conta Fixa';
      categoria = 'Contas de casa';
    } else {
      let encontrouCat = false;
      for (const cat of categoriasConhecidas) {
        const regexCat = new RegExp('(^|\\s+)' + cat + '$', 'i');
        if (regexCat.test(textoDesc)) {
          const m = textoDesc.match(regexCat);
          const pos = textoDesc.lastIndexOf(m[0]);
          const possivelNome = textoDesc.substring(0, pos).trim();
          if (possivelNome) {
            nome = possivelNome;
            categoria = cat;
            encontrouCat = true;
            break;
          }
        }
      }

      if (!encontrouCat) {
        nome = textoDesc;
        const autoCat = categorizarMensagem(nome);
        categoria = autoCat.categoria;
      }
    }
  }

  if (!nome) nome = 'Conta Fixa';
  nome = nome.charAt(0).toUpperCase() + nome.slice(1);

  return { nome, valor, categoria };
}

// Filtro de Transações por Período
function filtrarTransacoesPorPeriodo(transacoes, periodo) {
  const agora = new Date();
  
  return transacoes.filter(t => {
    const dataTransacao = new Date(t.data);
    
    if (periodo === 'diario') {
      return dataTransacao.toDateString() === agora.toDateString();
    }
    if (periodo === 'semanal') {
      const umaSemanaAtras = new Date();
      umaSemanaAtras.setDate(agora.getDate() - 7);
      return dataTransacao >= umaSemanaAtras;
    }
    if (periodo === 'mensal') {
      return (
        dataTransacao.getMonth() === agora.getMonth() &&
        dataTransacao.getFullYear() === agora.getFullYear()
      );
    }
    if (periodo === 'trimestral') {
      const tresMesesAtras = new Date();
      tresMesesAtras.setMonth(agora.getMonth() - 3);
      return dataTransacao >= tresMesesAtras;
    }
    return true; // geral
  });
}

// Calcula soma de Contas Fixas
function obterTotalContasFixas(userProfile, categoriaFiltro = null) {
  if (!userProfile.contasFixas || userProfile.contasFixas.length === 0) return 0;
  return userProfile.contasFixas.reduce((acc, conta) => {
    if (categoriaFiltro && conta.categoria) {
      if (conta.categoria.toLowerCase().trim() !== categoriaFiltro.toLowerCase().trim()) return acc;
    }
    return acc + conta.valor;
  }, 0);
}

// Verifica percentuais de limites e retorna alerta se necessário
function verificarAlertasDeLimite(userProfile, categoriaLancamento) {
  let avisos = [];
  const transacoesMes = filtrarTransacoesPorPeriodo(userProfile.transacoes, 'mensal');
  const totalGastosMes = transacoesMes
    .filter(t => t.tipo === 'gasto')
    .reduce((sum, t) => sum + t.valor, 0) + obterTotalContasFixas(userProfile);

  // 1. Checagem do Limite Geral
  if (userProfile.limiteGeral > 0) {
    const limite = userProfile.limiteGeral;
    const restante = limite - totalGastosMes;
    const percentualRestante = (restante / limite) * 100;

    if (restante < 0) {
      avisos.push(`⚠️ *ALERTA CRÍTICO (Limite Geral):* Você ultrapassou seu limite mensal geral em R$ ${Math.abs(restante).toFixed(2)}!`);
    } else if (percentualRestante <= 5) {
      avisos.push(`🚨 *ATENÇÃO (Limite Geral):* Restam apenas *${percentualRestante.toFixed(1)}%* (R$ ${restante.toFixed(2)}) do seu limite geral!`);
    } else if (percentualRestante <= 10) {
      avisos.push(`⚠️ *ATENÇÃO (Limite Geral):* Restam apenas *${percentualRestante.toFixed(1)}%* (R$ ${restante.toFixed(2)}) do seu limite geral!`);
    } else if (percentualRestante <= 20) {
      avisos.push(`💡 *AVISO (Limite Geral):* Você já atingiu 80% do limite geral. Restam *${percentualRestante.toFixed(1)}%* (R$ ${restante.toFixed(2)}).`);
    }
  }

  // 2. Checagem do Limite de Categoria
  const limiteCat = userProfile.limitesCategorias ? userProfile.limitesCategorias[categoriaLancamento] : null;
  if (limiteCat && limiteCat > 0) {
    const gastosCat = transacoesMes
      .filter(t => t.tipo === 'gasto' && t.categoria === categoriaLancamento)
      .reduce((sum, t) => sum + t.valor, 0) + obterTotalContasFixas(userProfile, categoriaLancamento);

    const restanteCat = limiteCat - gastosCat;
    const percentualRestanteCat = (restanteCat / limiteCat) * 100;

    if (restanteCat < 0) {
      avisos.push(`⚠️ *ALERTA DE CATEGORIA:* Você estourou o limite da categoria *${categoriaLancamento}* em R$ ${Math.abs(restanteCat).toFixed(2)}!`);
    } else if (percentualRestanteCat <= 5) {
      avisos.push(`🚨 *ATENÇÃO (${categoriaLancamento}):* Restam apenas *${percentualRestanteCat.toFixed(1)}%* (R$ ${restanteCat.toFixed(2)}) para esta categoria!`);
    } else if (percentualRestanteCat <= 10) {
      avisos.push(`⚠️ *ATENÇÃO (${categoriaLancamento}):* Restam apenas *${percentualRestanteCat.toFixed(1)}%* (R$ ${restanteCat.toFixed(2)}) para esta categoria!`);
    } else if (percentualRestanteCat <= 20) {
      avisos.push(`💡 *AVISO (${categoriaLancamento}):* Restam *${percentualRestanteCat.toFixed(1)}%* (R$ ${restanteCat.toFixed(2)}) para a categoria *${categoriaLancamento}*.`);
    }
  }

  return avisos.length > 0 ? `\n\n${avisos.join('\n\n')}` : '';
}

// Gera o Relatório e Extrato Formatado
function gerarRelatorioFormatado(userProfile, transacoesFiltradas, tituloPeriodo) {
  let totalGastosLancamentos = 0;
  let totalInvestimentos = 0;
  const gastosPorCategoria = {};

  transacoesFiltradas.forEach(t => {
    if (t.tipo === 'gasto') {
      totalGastosLancamentos += t.valor;
      gastosPorCategoria[t.categoria] = (gastosPorCategoria[t.categoria] || 0) + t.valor;
    } else {
      totalInvestimentos += t.valor;
    }
  });

  const totalContasFixas = obterTotalContasFixas(userProfile);
  const totalGastosGeral = totalGastosLancamentos + totalContasFixas;

  let resposta = `📊 *Relatório / Extrato (${tituloPeriodo})*\n\n`;

  if (totalGastosGeral > 0) {
    resposta += `🔴 *Total de Gastos (Variáveis):* R$ ${totalGastosLancamentos.toFixed(2)}\n`;
    if (totalContasFixas > 0) {
      resposta += `📌 *Contas Fixas:* R$ ${totalContasFixas.toFixed(2)}\n`;
      if (userProfile.contasFixas && userProfile.contasFixas.length > 0) {
        userProfile.contasFixas.forEach(c => {
          resposta += `   • ${c.nome}: R$ ${c.valor.toFixed(2)} (${c.categoria})\n`;
        });
      }
    }
    resposta += `📉 *GASTO TOTAL CONSOLIDADO:* R$ ${totalGastosGeral.toFixed(2)}\n\n`;

    resposta += `📁 *Resumo por Categoria (Gastos Variáveis):*\n`;
    let maiorCategoria = '';
    let maiorValor = -1;

    for (const [categoria, valor] of Object.entries(gastosPorCategoria)) {
      const porcentagem = totalGastosLancamentos > 0 ? ((valor / totalGastosLancamentos) * 100).toFixed(1) : '0.0';
      resposta += `• _${categoria}_: R$ ${valor.toFixed(2)} (${porcentagem}%)\n`;

      if (valor > maiorValor) {
        maiorValor = valor;
        maiorCategoria = categoria;
      }
    }

    if (maiorCategoria) {
      resposta += `\n💡 *Destaque:* Seu maior gasto variável foi em *${maiorCategoria}* (R$ ${maiorValor.toFixed(2)}).\n`;
    }
  } else {
    resposta += `🔴 *Total de Gastos:* R$ 0.00\n`;
  }

  if (totalInvestimentos > 0) {
    resposta += `\n🟢 *Total Investido/Guardado:* R$ ${totalInvestimentos.toFixed(2)}\n`;
  }

  // Cálculo da Renda Mensal
  if (userProfile.renda > 0) {
    resposta += `\n💵 *Cálculo da Renda Mensal:*\n`;
    resposta += `• Renda Cadastrada: R$ ${userProfile.renda.toFixed(2)}\n`;
    const saldoRenda = userProfile.renda - totalGastosGeral;

    if (saldoRenda >= 0) {
      resposta += `✅ *Saldo Restante da Renda:* R$ ${saldoRenda.toFixed(2)}\n`;
    } else {
      resposta += `🚨 *ALERTA:* Você ultrapassou sua renda em *R$ ${Math.abs(saldoRenda).toFixed(2)}*!\n`;
    }
  }

  // Status do Limite Geral
  if (userProfile.limiteGeral > 0) {
    resposta += `\n🎯 *Status do Limite Geral:*\n`;
    resposta += `• Limite Definido: R$ ${userProfile.limiteGeral.toFixed(2)}\n`;
    const saldoLimite = userProfile.limiteGeral - totalGastosGeral;

    if (saldoLimite >= 0) {
      const perc = ((saldoLimite / userProfile.limiteGeral) * 100).toFixed(1);
      resposta += `🔹 Restam R$ ${saldoLimite.toFixed(2)} (${perc}% do limite geral)\n`;
    } else {
      resposta += `⚠️ Ultrapassou o limite geral em R$ ${Math.abs(saldoLimite).toFixed(2)}\n`;
    }
  }

  return resposta;
}

// Guia de Ajuda
const textoAjuda = 
`📖 *Guia Completo - Organizador Financeiro*

Basta me mandar uma mensagem com o *valor* e a *descrição* que eu categorizo automaticamente!

*Exemplos:*
• \`45.90 mcdonalds\` ➔ FastFood
• \`120 luz\` ➔ Contas de casa
• \`250 fatura do nubank\` ➔ Cartão de Credito
• \`150 guardei no cdb\` ➔ Investimento

⚙️ *Comandos de Configuração:*
• /menu - Abre o Menu Principal interativo com todas as opções.
• /renda [valor] - Define sua renda mensal (Ex: \`/renda 3500\`).
• /limite - Painel para definir limite geral ou por categoria.
• /contasfixas - Cadastra e gerencia suas contas fixas do mês.
• /extrato - Visualiza o extrato de gastos por período.
• /relatorio - Gerencia automações e relatórios periódicos.
• /limpar - Zera todo o seu histórico.
• /ajuda ou /help - Exibe este guia.`;

// ==================== COMANDOS BÁSICOS ====================
bot.start(async (ctx) => {
  try {
    delete userStates[ctx.chat.id];
    await getUserProfile(ctx.chat.id);
    await replyMD(
      ctx,
      `👋 Olá, ${ctx.from.first_name}! Eu sou o seu *Organizador Financeiro*.\n\n` +
      `Envie o valor gasto e sua descrição (ex: \`35.50 ifood\`).\n` +
      `Defina sua renda fixa mensal, adicione seus limites de gastos e veja o resumo com um relatório completo!\n` +
      `Se precisar de ajuda, digite /help ou /ajuda para acessar o guia completo do bot!`
    );
    await enviarMenuPrincipal(ctx, false);
  } catch (err) {
    console.error('Erro no bot.start:', err);
  }
});

// Comandos de Ajuda (/ajuda e /help)
const enviarAjuda = async (ctx) => {
  try {
    delete userStates[ctx.chat.id];
    const menuAjudaVoltar = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);
    await replyMD(ctx, textoAjuda, menuAjudaVoltar);
  } catch (err) {
    console.error('Erro ao enviar ajuda:', err);
  }
};

bot.command('ajuda', enviarAjuda);
bot.command('help', enviarAjuda);
bot.help(enviarAjuda);

// ==================== FUNÇÃO DO MENU PRINCIPAL ====================
async function enviarMenuPrincipal(ctx, editMode = false) {
  const menuBotoes = Markup.inlineKeyboard([
    [Markup.button.callback('💵 Cadastrar / Ver Renda', 'menu_renda')],
    [Markup.button.callback('🎯 Gerenciar Limites', 'menu_limite')],
    [Markup.button.callback('📌 Contas Fixas', 'menu_contas')],
    [Markup.button.callback('📊 Extrato', 'menu_extrato'), Markup.button.callback('📈 Relatórios', 'menu_relatorio')],
    [Markup.button.callback('🗑️ Limpar Histórico', 'menu_limpar'), Markup.button.callback('❓ Ajuda', 'menu_ajuda')]
  ]);

  const textoMensagem = '🤖 *Organizador Financeiro - Menu Principal*\n\nEscolha uma opção abaixo:';

  if (editMode) {
    return editMD(ctx, textoMensagem, menuBotoes);
  } else {
    return replyMD(ctx, textoMensagem, menuBotoes);
  }
}

// ==================== AÇÕES DOS BOTÕES DO MENU PRINCIPAL ====================
bot.action('menu_renda', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    userStates[chatId] = { acao: 'esperando_renda' };
    
    const atual = profile.renda > 0 ? `R$ ${profile.renda.toFixed(2)}` : 'Não informada';
    const menuVoltar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]]);
    
    await editMD(
      ctx,
      `💵 *Renda Mensal Atual:* ${atual}\n\nPor favor, digite o valor da sua nova renda mensal no chat (Ex: \`5000\`):`, 
      menuVoltar
    );
  } catch (err) {
    console.error('Erro no menu_renda:', err);
  }
});

bot.action('menu_limite', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    let textoResumo = `🎯 *Painel de Limites de Gastos*\n\n`;
    textoResumo += `• *Limite Geral Mensal:* ${profile.limiteGeral > 0 ? `R$ ${profile.limiteGeral.toFixed(2)}` : 'Não definido'}\n\n`;
    textoResumo += `📁 *Limites por Categoria:*\n`;

    const categoriasGasto = REGRAS_CATEGORIAS.filter(r => r.tipo === 'gasto').map(r => r.nome).concat(['Despesa']);
    let temLimiteCat = false;
    
    for (const cat of categoriasGasto) {
      const val = profile.limitesCategorias ? profile.limitesCategorias[cat] : null;
      if (val > 0) {
        textoResumo += `• _${cat}_: R$ ${val.toFixed(2)}\n`;
        temLimiteCat = true;
      }
    }
    if (!temLimiteCat) textoResumo += `_(Nenhum limite por categoria definido)_\n`;

    const menuLimite = Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Definir Limite Geral', 'lim_set_geral')],
      [Markup.button.callback('📁 Definir Limite por Categoria', 'lim_set_cat')],
      [Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]
    ]);

    await editMD(ctx, textoResumo, menuLimite);
  } catch (err) {
    console.error('Erro no menu_limite:', err);
  }
});

// Menu Contas Fixas - Chama diretamente o menu completo com opções de gerenciamento/edição
bot.action('menu_contas', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    await exibirMenuContasFixas(ctx, true);
  } catch (err) {
    console.error('Erro no menu_contas:', err);
  }
});

bot.action('menu_extrato', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const menuExtratoComVoltar = Markup.inlineKeyboard([
      [Markup.button.callback('📅 Diário', 'ext_diario'), Markup.button.callback('📆 Semanal', 'ext_semanal')],
      [Markup.button.callback('🗓️ Mensal', 'ext_mensal'), Markup.button.callback('📈 Trimestral', 'ext_trimestral')],
      [Markup.button.callback('📋 Extrato Geral (Desde o início)', 'ext_geral')],
      [Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]
    ]);
    await editMD(ctx, '🔍 *Escolha o período do extrato que deseja visualizar:*', menuExtratoComVoltar);
  } catch (err) {
    console.error('Erro no menu_extrato:', err);
  }
});

bot.action('menu_relatorio', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    const config = profile.relatorioConfig;

    let textoStatus = config 
      ? `⚙️ *Configuração Atual:*\n• Frequência: _${config.frequencia}_\n• Horário: _${config.horario}h_\n${config.diaEspecifico ? `• Dia/Opção: _${config.diaEspecifico}_\n` : ''}`
      : `⚠️ Você ainda não configurou um relatório automático.`;

    const menuRelatorio = Markup.inlineKeyboard([
      [Markup.button.callback('🛠️ Configurar / Editar Período', 'rel_config_inicio')],
      [Markup.button.callback('⚡ Gerar Relatório Forçado (Agora)', 'rel_forcar')],
      [Markup.button.callback('📋 Ver Configuração Atual', 'rel_ver_config')],
      [Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]
    ]);

    await editMD(ctx, `📊 *Painel de Relatórios Periódicos*\n\n${textoStatus}\n\nO que você deseja fazer?`, menuRelatorio);
  } catch (err) {
    console.error('Erro no menu_relatorio:', err);
  }
});

bot.action('menu_limpar', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    profile.transacoes = [];
    profile.relatorioConfig = null;
    profile.markModified('relatorioConfig');
    profile.renda = 0;
    profile.limiteGeral = 0;
    profile.limitesCategorias = {};
    profile.markModified('limitesCategorias');
    profile.contasFixas = [];
    profile.markModified('contasFixas');
    await profile.save();

    const menuVoltar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]]);
    await editMD(ctx, '🗑️ *Histórico limpo com sucesso!* Suas transações, limites, contas fixas e renda foram resetados.', menuVoltar);
    setTimeout(() => enviarMenuPrincipal(ctx, true), 2000);
  } catch (err) {
    console.error('Erro no menu_limpar:', err);
  }
});

bot.action('menu_ajuda', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const menuAjudaVoltar = Markup.inlineKeyboard([
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);
    await editMD(ctx, textoAjuda, menuAjudaVoltar);
  } catch (err) {
    console.error('Erro no menu_ajuda:', err);
  }
});

bot.action('menu_voltar', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    delete userStates[ctx.chat.id];
    await enviarMenuPrincipal(ctx, true);
  } catch (err) {
    console.error('Erro no menu_voltar:', err);
  }
});

bot.command('menu', async (ctx) => {
  try {
    delete userStates[ctx.chat.id];
    await enviarMenuPrincipal(ctx, false);
  } catch (err) {
    console.error('Erro no bot.command menu:', err);
  }
});

// ==================== 1. RENDA MENSAL (/renda) ====================
bot.command('renda', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    userStates[chatId] = { acao: 'esperando_renda' };

    const atual = profile.renda > 0 ? `R$ ${profile.renda.toFixed(2)}` : 'Não informada';
    const menuVoltar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]]);
    await replyMD(
      ctx,
      `💵 *Renda Mensal Atual:* ${atual}\n\n` +
      `Por favor, digite o valor da sua nova renda mensal (Ex: \`5000\` ou \`3500.00\`):`,
      menuVoltar
    );
  } catch (err) {
    console.error('Erro no /renda:', err);
  }
});

// ==================== COMANDO /LIMPAR (Zerar Histórico) ====================
bot.command('limpar', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    profile.transacoes = [];
    profile.relatorioConfig = null;
    profile.markModified('relatorioConfig');
    profile.renda = 0;
    profile.limiteGeral = 0;
    profile.limitesCategorias = {};
    profile.markModified('limitesCategorias');
    profile.contasFixas = [];
    profile.markModified('contasFixas');
    await profile.save();

    const menuVoltar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]]);
    return replyMD(ctx, '🗑️ *Histórico limpo com sucesso!* Suas transações, limites, contas fixas e renda foram resetados.', menuVoltar);
  } catch (err) {
    console.error('Erro no /limpar:', err);
  }
});

// ==================== 2. LIMITE DE GASTOS (/limite) ====================
bot.command('limite', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    let textoResumo = `🎯 *Painel de Limites de Gastos*\n\n`;
    textoResumo += `• *Limite Geral Mensal:* ${profile.limiteGeral > 0 ? `R$ ${profile.limiteGeral.toFixed(2)}` : 'Não definido'}\n\n`;
    textoResumo += `📁 *Limites por Categoria:*\n`;

    const categoriasGasto = REGRAS_CATEGORIAS.filter(r => r.tipo === 'gasto').map(r => r.nome).concat(['Despesa']);
    let temLimiteCat = false;
    
    for (const cat of categoriasGasto) {
      const val = profile.limitesCategorias ? profile.limitesCategorias[cat] : null;
      if (val > 0) {
        textoResumo += `• _${cat}_: R$ ${val.toFixed(2)}\n`;
        temLimiteCat = true;
      }
    }
    if (!temLimiteCat) textoResumo += `_(Nenhum limite por categoria definido)_\n`;

    const menuLimite = Markup.inlineKeyboard([
      [Markup.button.callback('🎯 Definir Limite Geral', 'lim_set_geral')],
      [Markup.button.callback('📁 Definir Limite por Categoria', 'lim_set_cat')],
      [Markup.button.callback('🔙 Voltar ao Menu', 'menu_voltar')]
    ]);

    await replyMD(ctx, textoResumo, menuLimite);
  } catch (err) {
    console.error('Erro no /limite:', err);
  }
});

bot.action('lim_set_geral', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    userStates[chatId] = { acao: 'esperando_limite_geral' };
    const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar / Voltar', 'menu_limite')]]);
    await replyMD(ctx, '🎯 Digite o valor para o seu *Limite Geral Mensal* (ex: `2000`):', menuCancelar);
  } catch (err) {
    console.error('Erro no lim_set_geral:', err);
  }
});

bot.action('lim_set_cat', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const categoriasGasto = REGRAS_CATEGORIAS.filter(r => r.tipo === 'gasto').map(r => r.nome).concat(['Despesa']);
    const botoes = categoriasGasto.map(cat => [Markup.button.callback(cat, `catlim_${cat}`)]);
    botoes.push([Markup.button.callback('🔙 Voltar aos Limites', 'menu_limite')]);
    await editMD(ctx, '📁 *Escolha a categoria* que receberá o limite:', Markup.inlineKeyboard(botoes));
  } catch (err) {
    console.error('Erro no lim_set_cat:', err);
  }
});

bot.action(/^catlim_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const catEscolhida = ctx.match[1];
    userStates[chatId] = { acao: 'esperando_limite_categoria', categoria: catEscolhida };
    const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar / Voltar', 'menu_limite')]]);
    await replyMD(ctx, `📁 Digite o valor do limite para a categoria *${catEscolhida}* (ex: \`400\`):`, menuCancelar);
  } catch (err) {
    console.error('Erro no catlim:', err);
  }
});

// ==================== 3. CONTAS FIXAS (/contasfixas) ====================
bot.command('contasfixas', async (ctx) => {
  try {
    await exibirMenuContasFixas(ctx, false);
  } catch (err) {
    console.error('Erro no /contasfixas:', err);
  }
});

async function exibirMenuContasFixas(ctx, isEdit = false) {
  const chatId = ctx.chat.id;
  const profile = await getUserProfile(chatId);

  let texto = `📌 *Suas Contas Fixas Mensais:*\n\n`;
  const botoes = [];

  if (!profile.contasFixas || profile.contasFixas.length === 0) {
    texto += `_(Nenhuma conta fixa cadastrada ainda)_\n`;
  } else {
    let total = 0;
    profile.contasFixas.forEach((c, idx) => {
      total += c.valor;
      texto += `${idx + 1}. *${c.nome}*: R$ ${c.valor.toFixed(2)} (${c.categoria})\n`;
      botoes.push([Markup.button.callback(`⚙️ Gerenciar: ${c.nome}`, `cf_gerenciar_${idx}`)]);
    });
    texto += `\n💰 *Total de Contas Fixas:* R$ ${total.toFixed(2)}`;
  }

  botoes.push([Markup.button.callback('➕ Adicionar Conta Fixa', 'cf_add')]);
  if (profile.contasFixas && profile.contasFixas.length > 0) {
    botoes.push([Markup.button.callback('🗑️ Limpar Todas', 'cf_clear')]);
  }
  botoes.push([Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]);

  const keyboard = Markup.inlineKeyboard(botoes);

  if (isEdit) {
    await editMD(ctx, texto, keyboard);
  } else {
    await replyMD(ctx, texto, keyboard);
  }
}

// Adicionar Nova Conta Fixa
bot.action('cf_add', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    userStates[chatId] = { acao: 'esperando_conta_fixa' };
    const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar / Voltar', 'cf_voltar_lista')]]);
    await replyMD(
      ctx,
      '📌 Digite o *nome*, *valor* e a *categoria* da conta fixa na mesma mensagem.\n\n' +
      '*Exemplos:*\n' +
      '• `Aluguel 1200 Contas de casa`\n' +
      '• `Internet 100`\n' +
      '• `Netflix 55.90 Entreterimento`\n\n' +
      '_(Dica: se não informar a categoria, eu tentarei identificar automaticamente!)_',
      menuCancelar
    );
  } catch (err) {
    console.error('Erro no cf_add:', err);
  }
});

// Limpar Todas as Contas Fixas
bot.action('cf_clear', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    profile.contasFixas = [];
    profile.markModified('contasFixas');
    await profile.save();
    await replyMD(ctx, '✅ *Todas as contas fixas foram removidas!*');
    await exibirMenuContasFixas(ctx, false);
  } catch (err) {
    console.error('Erro no cf_clear:', err);
  }
});

// Sub-menu para Gerenciar uma Conta Fixa Específica (Editar/Excluir)
bot.action(/^cf_gerenciar_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    const conta = profile.contasFixas ? profile.contasFixas[index] : null;

    if (!conta) {
      return replyMD(ctx, '⚠️ Conta fixa não encontrada.');
    }

    const texto = `⚙️ *Gerenciar Conta Fixa:*\n\n📌 *Nome:* ${conta.nome}\n💰 *Valor:* R$ ${conta.valor.toFixed(2)}\n📁 *Categoria:* ${conta.categoria}\n\nO que deseja alterar?`;
    
    const menuGerenciar = Markup.inlineKeyboard([
      [Markup.button.callback('✏️ Editar Nome', `cf_edit_nome_${index}`)],
      [Markup.button.callback('💵 Editar Valor', `cf_edit_valor_${index}`)],
      [Markup.button.callback('📁 Editar Categoria', `cf_edit_cat_${index}`)],
      [Markup.button.callback('🗑️ Excluir esta Conta', `cf_del_${index}`)],
      [Markup.button.callback('🔙 Voltar para Contas Fixas', 'cf_voltar_lista')]
    ]);

    await editMD(ctx, texto, menuGerenciar);
  } catch (err) {
    console.error('Erro no cf_gerenciar:', err);
  }
});

// Ação: Iniciar Edição da Categoria
bot.action(/^cf_edit_cat_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const categorias = ['Contas de casa', 'Cartão de Credito', 'FastFood', 'Entreterimento', 'Despesa'];
    const botoes = categorias.map(cat => [Markup.button.callback(cat, `cf_setcat_${index}_${cat}`)]);
    botoes.push([Markup.button.callback('🔙 Voltar', `cf_gerenciar_${index}`)]);

    await editMD(ctx, '📁 *Escolha a nova categoria para a conta fixa:*', Markup.inlineKeyboard(botoes));
  } catch (err) {
    console.error('Erro no cf_edit_cat:', err);
  }
});

bot.action(/^cf_setcat_(\d+)_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const novaCat = ctx.match[2];
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    if (profile.contasFixas && profile.contasFixas[index]) {
      profile.contasFixas[index].categoria = novaCat;
      profile.markModified('contasFixas');
      await profile.save();
      await replyMD(ctx, `✅ Categoria da conta *${profile.contasFixas[index].nome}* alterada para *${novaCat}*!`);
    }
    await exibirMenuContasFixas(ctx, false);
  } catch (err) {
    console.error('Erro no cf_setcat:', err);
  }
});

// Ação: Iniciar Edição do Nome
bot.action(/^cf_edit_nome_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id;
    userStates[chatId] = { acao: 'esperando_editar_nome_conta_fixa', index };
    const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar', `cf_gerenciar_${index}`)]]);
    await replyMD(ctx, '✏️ Digite o *novo nome / descrição* para esta conta fixa:', menuCancelar);
  } catch (err) {
    console.error('Erro no cf_edit_nome:', err);
  }
});

// Ação: Iniciar Edição do Valor
bot.action(/^cf_edit_valor_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id;
    userStates[chatId] = { acao: 'esperando_editar_valor_conta_fixa', index };
    const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar', `cf_gerenciar_${index}`)]]);
    await replyMD(ctx, '💵 Digite o *novo valor* para esta conta fixa (Ex: `1250.00`):', menuCancelar);
  } catch (err) {
    console.error('Erro no cf_edit_valor:', err);
  }
});

// Ação: Excluir Conta Fixa Individual
bot.action(/^cf_del_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const index = parseInt(ctx.match[1]);
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    if (profile.contasFixas && profile.contasFixas[index]) {
      const removida = profile.contasFixas.splice(index, 1)[0];
      profile.markModified('contasFixas');
      await profile.save();
      await replyMD(ctx, `✅ A conta fixa *${removida.nome}* foi excluída!`);
    }
    await exibirMenuContasFixas(ctx, false);
  } catch (err) {
    console.error('Erro no cf_del:', err);
  }
});

// Botão para voltar à lista de contas fixas
bot.action('cf_voltar_lista', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    delete userStates[ctx.chat.id];
    await exibirMenuContasFixas(ctx, true);
  } catch (err) {
    console.error('Erro no cf_voltar_lista:', err);
  }
});

// ==================== EXTRATO E RELATÓRIO ====================
const menuExtrato = Markup.inlineKeyboard([
  [Markup.button.callback('📅 Diário', 'ext_diario'), Markup.button.callback('📆 Semanal', 'ext_semanal')],
  [Markup.button.callback('🗓️ Mensal', 'ext_mensal'), Markup.button.callback('📈 Trimestral', 'ext_trimestral')],
  [Markup.button.callback('📋 Extrato Geral (Desde o início)', 'ext_geral')],
  [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
]);

bot.command('extrato', async (ctx) => {
  try {
    await replyMD(ctx, '🔍 *Escolha o período do extrato que deseja visualizar:*', menuExtrato);
  } catch (err) {
    console.error('Erro no /extrato:', err);
  }
});

bot.action(/^ext_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const periodo = ctx.match[1];
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);

    const titulos = {
      diario: 'Diário (Hoje)',
      semanal: 'Semanal (Últimos 7 dias)',
      mensal: 'Mensal (Mês Atual)',
      trimestral: 'Trimestral (Últimos 3 meses)',
      geral: 'Extrato Geral (Desde o início)'
    };

    const transacoesFiltradas = filtrarTransacoesPorPeriodo(profile.transacoes, periodo);
    const resultado = gerarRelatorioFormatado(profile, transacoesFiltradas, titulos[periodo]);

    const menuRetornoExtrato = Markup.inlineKeyboard([
      [Markup.button.callback('🔍 Ver Outro Período', 'menu_extrato')],
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);

    await editMD(ctx, resultado, menuRetornoExtrato);
  } catch (err) {
    console.error('Erro no ext_ action:', err);
  }
});

bot.command('relatorio', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    const config = profile.relatorioConfig;

    let textoStatus = config 
      ? `⚙️ *Configuração Atual:*\n• Frequência: _${config.frequencia}_\n• Horário: _${config.horario}h_\n${config.diaEspecifico ? `• Dia/Opção: _${config.diaEspecifico}_\n` : ''}`
      : `⚠️ Você ainda não configurou um relatório automático.`;

    const menuRelatorio = Markup.inlineKeyboard([
      [Markup.button.callback('🛠️ Configurar / Editar Período', 'rel_config_inicio')],
      [Markup.button.callback('⚡ Gerar Relatório Forçado (Agora)', 'rel_forcar')],
      [Markup.button.callback('📋 Ver Configuração Atual', 'rel_ver_config')],
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);

    await replyMD(ctx, `📊 *Painel de Relatórios Periódicos*\n\n${textoStatus}\n\nO que você deseja fazer?`, menuRelatorio);
  } catch (err) {
    console.error('Erro no /relatorio:', err);
  }
});

bot.action('rel_config_inicio', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    userStates[chatId] = {}; 

    const menuFrequencia = Markup.inlineKeyboard([
      [Markup.button.callback('📅 Diário', 'freq_diario'), Markup.button.callback('📆 Semanal', 'freq_semanal')],
      [Markup.button.callback('🗓️ Mensal', 'freq_mensal'), Markup.button.callback('📈 Trimestral', 'freq_trimestral')],
      [Markup.button.callback('🔙 Voltar aos Relatórios', 'menu_relatorio')]
    ]);

    await editMD(ctx, '🛠️ *Configuração de Relatório*\n\nEscolha a frequência desejada:', menuFrequencia);
  } catch (err) {
    console.error('Erro no rel_config_inicio:', err);
  }
});

bot.action(/^freq_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const frequencia = ctx.match[1];
    userStates[chatId] = { frequencia };

    if (frequencia === 'diario') return pedirHorario(ctx);
    if (frequencia === 'semanal') {
      const menuDias = Markup.inlineKeyboard([
        [Markup.button.callback('Segunda-feira', 'dia_seg'), Markup.button.callback('Terça-feira', 'dia_ter')],
        [Markup.button.callback('Quarta-feira', 'dia_qua'), Markup.button.callback('Quinta-feira', 'dia_qui')],
        [Markup.button.callback('Sexta-feira', 'dia_sex'), Markup.button.callback('Sábado', 'dia_sab')],
        [Markup.button.callback('Domingo', 'dia_dom')],
        [Markup.button.callback('🔙 Voltar', 'rel_config_inicio')]
      ]);
      return editMD(ctx, '📆 *Relatório Semanal*\n\nQual dia da semana você quer receber?', menuDias);
    }
    if (frequencia === 'mensal') {
      const menuMensal = Markup.inlineKeyboard([
        [Markup.button.callback('Último dia do mês', 'mes_ultimo')],
        [Markup.button.callback('1º dia do mês seguinte', 'mes_primeiro')],
        [Markup.button.callback('🔙 Voltar', 'rel_config_inicio')]
      ]);
      return editMD(ctx, '🗓️ *Relatório Mensal*\n\nEscolha a regra de fechamento:', menuMensal);
    }
    if (frequencia === 'trimestral') {
      const menuTrimestral = Markup.inlineKeyboard([
        [Markup.button.callback('Último dia do trimestre', 'tri_ultimo')],
        [Markup.button.callback('1º dia do próximo trimestre', 'tri_primeiro')],
        [Markup.button.callback('🔙 Voltar', 'rel_config_inicio')]
      ]);
      return editMD(ctx, '📈 *Relatório Trimestral*\n\nEscolha a regra de fechamento:', menuTrimestral);
    }
  } catch (err) {
    console.error('Erro no freq_ action:', err);
  }
});

bot.action(/^dia_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const diasMap = { seg: 'Segunda-feira', ter: 'Terça-feira', qua: 'Quarta-feira', qui: 'Quinta-feira', sex: 'Sexta-feira', sab: 'Sábado', dom: 'Domingo' };
    if (!userStates[chatId]) userStates[chatId] = {};
    userStates[chatId].diaEspecifico = diasMap[ctx.match[1]];
    await pedirHorario(ctx);
  } catch (err) {
    console.error('Erro no dia_ action:', err);
  }
});

bot.action(/^mes_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    if (!userStates[chatId]) userStates[chatId] = {};
    userStates[chatId].diaEspecifico = ctx.match[1] === 'ultimo' ? 'Último dia do mês' : '1º dia do mês seguinte';
    await pedirHorario(ctx);
  } catch (err) {
    console.error('Erro no mes_ action:', err);
  }
});

bot.action(/^tri_(.+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    if (!userStates[chatId]) userStates[chatId] = {};
    userStates[chatId].diaEspecifico = ctx.match[1] === 'ultimo' ? 'Último dia do trimestre' : '1º dia do próximo trimestre';
    await pedirHorario(ctx);
  } catch (err) {
    console.error('Erro no tri_ action:', err);
  }
});

async function pedirHorario(ctx) {
  const menuHorarios = Markup.inlineKeyboard([
    [Markup.button.callback('06:00', 'hora_6'), Markup.button.callback('12:00', 'hora_12')],
    [Markup.button.callback('18:00', 'hora_18'), Markup.button.callback('00:00', 'hora_0')],
    [Markup.button.callback('🔙 Voltar', 'rel_config_inicio')]
  ]);
  await editMD(ctx, '⏰ *Escolha o horário* para receber o relatório:', menuHorarios);
}

bot.action(/^hora_(\d+)$/, async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const horario = ctx.match[1];
    
    if (!userStates[chatId]) {
      const menuSessao = Markup.inlineKeyboard([[Markup.button.callback('🔙 Voltar aos Relatórios', 'menu_relatorio')]]);
      return editMD(ctx, '⚠️ Sessão expirada. Acesse o menu de relatórios novamente.', menuSessao);
    }

    userStates[chatId].horario = horario;

    const profile = await getUserProfile(chatId);
    profile.relatorioConfig = userStates[chatId];
    profile.markModified('relatorioConfig');
    await profile.save();

    const menuPosConfig = Markup.inlineKeyboard([
      [Markup.button.callback('📈 Painel de Relatórios', 'menu_relatorio')],
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);

    await editMD(
      ctx,
      `✅ *Relatório configurado com sucesso!*\n\n` +
      `• Frequência: *${profile.relatorioConfig.frequencia}*\n` +
      `${profile.relatorioConfig.diaEspecifico ? `• Regra/Dia: *${profile.relatorioConfig.diaEspecifico}*\n` : ''}` +
      `• Horário: *${profile.relatorioConfig.horario}h*`,
      menuPosConfig
    );
    delete userStates[chatId];
  } catch (err) {
    console.error('Erro no hora_ action:', err);
  }
});

bot.action('rel_ver_config', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    const config = profile.relatorioConfig;

    const menuBotoes = Markup.inlineKeyboard([
      [Markup.button.callback('🛠️ Configurar / Editar', 'rel_config_inicio')],
      [Markup.button.callback('📈 Painel de Relatórios', 'menu_relatorio')],
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);

    if (!config) {
      return editMD(ctx, '⚠️ Nenhum relatório configurado ainda.', menuBotoes);
    }

    await editMD(
      ctx,
      `📋 *Sua Configuração de Relatório:*\n\n` +
      `• Frequência: *${config.frequencia}*\n` +
      `${config.diaEspecifico ? `• Dia/Opção: *${config.diaEspecifico}*\n` : ''}` +
      `• Horário: *${config.horario}h*`,
      menuBotoes
    );
  } catch (err) {
    console.error('Erro no rel_ver_config:', err);
  }
});

bot.action('rel_forcar', async (ctx) => {
  try {
    await ctx.answerCbQuery().catch(() => {});
    const chatId = ctx.chat.id;
    const profile = await getUserProfile(chatId);
    const config = profile.relatorioConfig;

    const periodoMapeado = config ? config.frequencia : 'mensal';
    const transacoesFiltradas = filtrarTransacoesPorPeriodo(profile.transacoes, periodoMapeado);
    const resultado = gerarRelatorioFormatado(profile, transacoesFiltradas, `Forçado - ${periodoMapeado}`);

    const menuRetornoRelatorio = Markup.inlineKeyboard([
      [Markup.button.callback('📈 Painel de Relatórios', 'menu_relatorio')],
      [Markup.button.callback('🔙 Voltar ao Menu Principal', 'menu_voltar')]
    ]);

    await editMD(ctx, `⚡ *Relatório Forçado Gerado!*\n\n` + resultado, menuRetornoRelatorio);
  } catch (err) {
    console.error('Erro no rel_forcar:', err);
  }
});

// ==================== PROCESSADOR DE MENSAGENS E ESTADOS ====================
bot.on('text', async (ctx) => {
  try {
    const texto = ctx.message.text;
    const chatId = ctx.chat.id;

    // Ignora comandos que começam com barra (já tratados individualmente pelos bot.command)
    if (texto.startsWith('/')) return;

    // Trata respostas de menus interativos (Captura de Renda, Limites e Contas Fixas)
    if (userStates[chatId] && userStates[chatId].acao) {
      const acao = userStates[chatId].acao;
      const profile = await getUserProfile(chatId);

      // 1. Renda Mensal
      if (acao === 'esperando_renda') {
        const val = parseFloat(texto.replace(',', '.'));
        if (isNaN(val) || val < 0) return replyMD(ctx, '⚠️ Informe um número válido para a renda!');
        profile.renda = val;
        await profile.save();
        delete userStates[chatId];
        
        await replyMD(ctx, `✅ *Renda mensal atualizada com sucesso!*\n💰 Nova Renda: R$ ${val.toFixed(2)}`);
        return enviarMenuPrincipal(ctx, false);
      }

      // 2. Limite Geral
      if (acao === 'esperando_limite_geral') {
        const val = parseFloat(texto.replace(',', '.'));
        if (isNaN(val) || val < 0) return replyMD(ctx, '⚠️ Informe um número válido para o limite!');
        profile.limiteGeral = val;
        await profile.save();
        delete userStates[chatId];
        
        await replyMD(ctx, `✅ *Limite Geral mensal definido para R$ ${val.toFixed(2)}!*`);
        return enviarMenuPrincipal(ctx, false);
      }

      // 3. Limite por Categoria
      if (acao === 'esperando_limite_categoria') {
        const val = parseFloat(texto.replace(',', '.'));
        const cat = userStates[chatId].categoria;
        if (isNaN(val) || val < 0) return replyMD(ctx, '⚠️ Informe um número válido!');
        if (!profile.limitesCategorias) profile.limitesCategorias = {};
        profile.limitesCategorias[cat] = val;
        profile.markModified('limitesCategorias');
        await profile.save();
        delete userStates[chatId];
        
        await replyMD(ctx, `✅ *Limite da categoria _${cat}_ definido para R$ ${val.toFixed(2)}!*`);
        return enviarMenuPrincipal(ctx, false);
      }

      // 4. Adicionar Nova Conta Fixa
      if (acao === 'esperando_conta_fixa') {
        const dados = extrairDadosContaFixa(texto);
        if (!dados) {
          const menuCancelar = Markup.inlineKeyboard([[Markup.button.callback('🔙 Cancelar', 'cf_voltar_lista')]]);
          return replyMD(ctx, '⚠️ Não identifiquei o valor ou nome da conta fixa!\nPor favor, envie no formato: `Nome Valor Categoria` (Ex: `Aluguel 1200 Contas de casa` ou `Internet 100`).', menuCancelar);
        }

        if (!profile.contasFixas) profile.contasFixas = [];
        profile.contasFixas.push({
          nome: dados.nome,
          valor: dados.valor,
          categoria: dados.categoria
        });
        profile.markModified('contasFixas');
        await profile.save();
        delete userStates[chatId];

        await replyMD(
          ctx,
          `✅ *Conta fixa cadastrada com sucesso!*\n\n` +
          `📌 *Nome:* ${dados.nome}\n` +
          `💰 *Valor:* R$ ${dados.valor.toFixed(2)}\n` +
          `📁 *Categoria:* ${dados.categoria}`
        );
        return exibirMenuContasFixas(ctx, false);
      }

      // 5.1 Editar Nome da Conta Fixa
      if (acao === 'esperando_editar_nome_conta_fixa') {
        const index = userStates[chatId].index;
        const novoNome = texto.trim();
        
        if (!novoNome) return replyMD(ctx, '⚠️ Por favor, digite um nome válido!');

        if (profile.contasFixas && profile.contasFixas[index]) {
          profile.contasFixas[index].nome = novoNome;
          profile.markModified('contasFixas');
          await profile.save();
          delete userStates[chatId];
          await replyMD(ctx, `✅ Nome da conta alterado para *${novoNome}*!`);
          return exibirMenuContasFixas(ctx, false);
        } else {
          delete userStates[chatId];
          return replyMD(ctx, '⚠️ Conta fixa não encontrada.');
        }
      }

      // 5.2 Editar Valor da Conta Fixa
      if (acao === 'esperando_editar_valor_conta_fixa') {
        const index = userStates[chatId].index;
        const regexV = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
        const matchV = texto.match(regexV);
        let novoValor = NaN;
        if (matchV) {
          let vStr = matchV[1];
          if (vStr.includes('.') && vStr.includes(',')) vStr = vStr.replace(/\./g, '').replace(',', '.');
          else if (vStr.includes(',')) vStr = vStr.replace(',', '.');
          novoValor = parseFloat(vStr);
        } else {
          novoValor = parseFloat(texto.replace(',', '.'));
        }

        if (isNaN(novoValor) || novoValor <= 0) {
          return replyMD(ctx, '⚠️ Por favor, digite um valor numérico válido maior que zero (Ex: `1250.00`)!');
        }

        if (profile.contasFixas && profile.contasFixas[index]) {
          profile.contasFixas[index].valor = novoValor;
          profile.markModified('contasFixas');
          await profile.save();
          delete userStates[chatId];
          await replyMD(ctx, `✅ Valor da conta *${profile.contasFixas[index].nome}* alterado para *R$ ${novoValor.toFixed(2)}*!`);
          return exibirMenuContasFixas(ctx, false);
        } else {
          delete userStates[chatId];
          return replyMD(ctx, '⚠️ Conta fixa não encontrada.');
        }
      }
    }

    // Lançamento diário padrão de gastos/investimentos (quando não está em nenhum menu interativo)
    const regexValor = /(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)/i;
    const match = texto.match(regexValor);

    if (!match) {
      return replyMD(ctx, '⚠️ Não identifiquei um valor! Ex: `45.90 mercado` ou utilize /menu.');
    }

    let valorStr = match[1];
    if (valorStr.includes('.') && valorStr.includes(',')) {
      valorStr = valorStr.replace(/\./g, '').replace(',', '.');
    } else if (valorStr.includes(',')) {
      valorStr = valorStr.replace(',', '.');
    } else if (valorStr.includes('.')) {
      const partes = valorStr.split('.');
      if (partes.length === 2 && partes[1].length === 3) {
        valorStr = partes.join('');
      }
    }
    const valor = parseFloat(valorStr);
    const descricao = texto.replace(match[0], '').trim() || 'Sem descrição';
    const { categoria, tipo } = categorizarMensagem(descricao);

    const profile = await getUserProfile(chatId);

    const novaTransacao = {
      id: Date.now(),
      tipo,
      valor,
      categoria,
      descricao,
      data: new Date()
    };

    profile.transacoes.push(novaTransacao);
    profile.markModified('transacoes');
    await profile.save();

    // Checa alertas de limites (20%, 10%, 5% ou estouro)
    const textoAlerta = tipo === 'gasto' ? verificarAlertasDeLimite(profile, categoria) : '';

    const icone = tipo === 'investimento' ? '🚀' : '✅';
    await replyMD(
      ctx,
      `${icone} *Lançamento registrado!*\n\n` +
      `💰 *Valor:* R$ ${valor.toFixed(2)}\n` +
      `📁 *Categoria:* ${categoria}\n` +
      `📝 *Descrição:* ${descricao}` +
      textoAlerta
    );
    
    return enviarMenuPrincipal(ctx, false);
  } catch (err) {
    console.error('Erro no bot.on(text):', err);
    replyMD(ctx, '⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente ou use /menu.').catch(() => {});
  }
});

// ==================== INICIALIZAÇÃO DO BOT (POLLING / WEBHOOK) ====================
async function startBot() {
  const isRender = !!process.env.RENDER_EXTERNAL_URL;
  const useWebhook = process.env.USE_WEBHOOK === 'true' && isRender;

  if (useWebhook) {
    const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log(`🤖 Bot iniciado com sucesso via WEBHOOK em: ${webhookUrl}`);
    } catch (err) {
      console.error('❌ Erro ao configurar Webhook no Telegram:', err);
    }
  } else {
    try {
      // Remove webhooks legados se houver para evitar conflitos de getUpdates
      await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => {});
      bot.launch().catch(err => {
        console.error('❌ Erro no bot.launch (Long Polling):', err);
        setTimeout(startBot, 5000);
      });
      console.log('🤖 Bot financeiro com MongoDB Atlas rodando via Long Polling!');
    } catch (err) {
      console.error('❌ Erro ao inicializar Long Polling:', err);
      // Tentativa automática de reconexão após 5 segundos em caso de oscilação transitória de rede
      setTimeout(startBot, 5000);
    }
  }
}

startBot();

process.once('SIGINT', () => {
  mongoose.connection.close();
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  mongoose.connection.close();
  bot.stop('SIGTERM');
});
