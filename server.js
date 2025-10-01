const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs').promises;
const app = express();

// ============ CONFIGURAÇÕES ============
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');

// Produto único CS
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'CS'
};

// Instâncias Evolution (fallback sequencial)
const INSTANCES = ['GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 'GABY06', 'GABY07', 'GABY08', 'GABY09'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map(); // Chave: últimos 8 dígitos
let phoneIndex = new Map(); // Índice: número completo -> últimos 8 dígitos
let idempotencyCache = new Map();
let stickyInstances = new Map(); // Chave: últimos 8 dígitos
let pixTimeouts = new Map(); // Chave: últimos 8 dígitos
let processingLocks = new Map(); // Novo: Lock por phoneKey
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// ============ FUNIS PADRÃO (APENAS CS) ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Parabéns! Seu pedido foi aprovado. Bem-vindo ao CS!',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pela resposta! Agora me confirma se recebeu o acesso ao curso por email?',
                waitForReply: true
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Perfeito! Lembre-se de acessar nossa plataforma. Qualquer dúvida, estamos aqui!'
            },
            {
                id: 'step_4',
                type: 'delay',
                delaySeconds: 420 // 7 minutos
            },
            {
                id: 'step_5',
                type: 'text',
                text: 'Já está conseguindo acessar o conteúdo? Precisa de alguma ajuda?',
                waitForReply: true
            },
            {
                id: 'step_6',
                type: 'text',
                text: 'Ótimo! Aproveite o conteúdo e bons estudos!'
            },
            {
                id: 'step_7',
                type: 'delay',
                delaySeconds: 1500 // 25 minutos
            },
            {
                id: 'step_8',
                type: 'text',
                text: 'Lembre-se de que nosso suporte está sempre disponível para ajudar você!'
            }
        ]
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: [
            {
                id: 'step_1',
                type: 'text',
                text: 'Seu PIX foi gerado! Aguardamos o pagamento para liberar o acesso ao CS.',
                waitForReply: true
            },
            {
                id: 'step_2',
                type: 'text',
                text: 'Obrigado pelo contato! Me confirma que está com dificuldades no pagamento?',
                waitForReply: true
            },
            {
                id: 'step_3',
                type: 'text',
                text: 'Se precisar de ajuda com o pagamento, nossa equipe está disponível!'
            },
            {
                id: 'step_4',
                type: 'delay',
                delaySeconds: 1500 // 25 minutos
            },
            {
                id: 'step_5',
                type: 'text',
                text: 'Ainda não identificamos seu pagamento. Lembre-se que o PIX tem validade limitada.'
            },
            {
                id: 'step_6',
                type: 'delay',
                delaySeconds: 1500 // 25 minutos
            },
            {
                id: 'step_7',
                type: 'text',
                text: 'PIX vencido! Entre em contato conosco para gerar um novo.'
            }
        ]
    }
};

// ============ SISTEMA DE LOCK PARA EVITAR RACE CONDITIONS ============
async function acquireLock(phoneKey, timeout = 5000) {
    const startTime = Date.now();
    
    while (processingLocks.get(phoneKey)) {
        if (Date.now() - startTime > timeout) {
            addLog('LOCK_TIMEOUT', `Timeout esperando lock para ${phoneKey}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    processingLocks.set(phoneKey, true);
    return true;
}

function releaseLock(phoneKey) {
    processingLocks.delete(phoneKey);
}

// ============ PERSISTÊNCIA DE DADOS ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe ou erro ao criar:', error.message);
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos em arquivo: ' + funnelsArray.length + ' funis');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar funis: ' + error.message);
    }
}

async function loadFunnelsFromFile() {
    try {
        const data = await fs.readFile(DATA_FILE, 'utf8');
        const funnelsArray = JSON.parse(data);
        
        funis.clear();
        
        funnelsArray.forEach(funnel => {
            if (funnel.id.startsWith('CS_')) {
                funis.set(funnel.id, funnel);
            }
        });
        
        addLog('DATA_LOAD', 'Funis carregados do arquivo: ' + funis.size + ' funis');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Erro ao carregar funis (usando padrões): ' + error.message);
        return false;
    }
}

async function saveConversationsToFile() {
    try {
        await ensureDataDir();
        const conversationsArray = Array.from(conversations.entries()).map(([key, value]) => ({
            phoneKey: key,
            ...value,
            createdAt: value.createdAt.toISOString(),
            lastSystemMessage: value.lastSystemMessage ? value.lastSystemMessage.toISOString() : null,
            lastReply: value.lastReply ? value.lastReply.toISOString() : null,
            completedAt: value.completedAt ? value.completedAt.toISOString() : null,
            canceledAt: value.canceledAt ? value.canceledAt.toISOString() : null
        }));
        
        const phoneIndexArray = Array.from(phoneIndex.entries());
        const stickyInstancesArray = Array.from(stickyInstances.entries());
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: phoneIndexArray,
            stickyInstances: stickyInstancesArray
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length + ' conversas');
    } catch (error) {
        addLog('DATA_SAVE_ERROR', 'Erro ao salvar conversas: ' + error.message);
    }
}

async function loadConversationsFromFile() {
    try {
        const data = await fs.readFile(CONVERSATIONS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        conversations.clear();
        parsed.conversations.forEach(conv => {
            const conversation = {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null,
                completedAt: conv.completedAt ? new Date(conv.completedAt) : null,
                canceledAt: conv.canceledAt ? new Date(conv.canceledAt) : null
            };
            conversations.set(conv.phoneKey, conversation);
        });
        
        phoneIndex.clear();
        parsed.phoneIndex.forEach(([key, value]) => {
            phoneIndex.set(key, value);
        });
        
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => {
            stickyInstances.set(key, value);
        });
        
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length + ' conversas');
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior encontrada: ' + error.message);
        return false;
    }
}

// Auto-save periódico
setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
}, 30000);

// Inicializar funis padrão
Object.values(defaultFunnels).forEach(funnel => {
    funis.set(funnel.id, funnel);
});

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============

// Extrair últimos 8 dígitos
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    const key = cleaned.slice(-8);
    
    addLog('PHONE_KEY', `Extraído chave: ${key} do número: ${phone}`, { 
        original: phone, 
        cleaned: cleaned,
        key: key 
    });
    
    return key;
}

// Registrar telefone no índice
function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    
    const cleaned = fullPhone.replace(/\D/g, '');
    phoneIndex.set(cleaned, phoneKey);
    
    // Registrar variações comuns
    if (cleaned.startsWith('55')) {
        phoneIndex.set(cleaned.substring(2), phoneKey);
    }
    if (!cleaned.startsWith('55')) {
        phoneIndex.set('55' + cleaned, phoneKey);
    }
    
    addLog('PHONE_REGISTER', `Registrado: ${cleaned} -> ${phoneKey}`, {
        variations: Array.from(phoneIndex.keys()).filter(k => phoneIndex.get(k) === phoneKey)
    });
}

// Buscar conversa por qualquer formato de telefone
function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    
    if (!phoneKey || phoneKey.length !== 8) {
        addLog('CONVERSATION_SEARCH_ERROR', 'Chave de telefone inválida', { phone, phoneKey });
        return null;
    }
    
    const conversation = conversations.get(phoneKey);
    
    if (conversation) {
        addLog('CONVERSATION_FOUND', `Conversa encontrada para chave: ${phoneKey}`, { 
            phone,
            phoneKey,
            funnelId: conversation.funnelId,
            stepIndex: conversation.stepIndex
        });
        
        registerPhone(phone, phoneKey);
    } else {
        addLog('CONVERSATION_NOT_FOUND', `Nenhuma conversa para chave: ${phoneKey}`, { 
            phone,
            phoneKey
        });
    }
    
    return conversation;
}

// Criar RemoteJid para Evolution API
function phoneToRemoteJid(phone) {
    const cleaned = phone.replace(/\D/g, '');
    
    let formatted = cleaned;
    
    if (!formatted.startsWith('55')) {
        formatted = '55' + formatted;
    }
    
    if (formatted.length === 12) {
        const ddd = formatted.substring(2, 4);
        const numero = formatted.substring(4);
        formatted = '55' + ddd + '9' + numero;
    }
    
    return formatted + '@s.whatsapp.net';
}

function extractMessageText(message) {
    if (!message) return '';
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.audioMessage) return '[AUDIO]';
    if (message.documentMessage) return '[DOCUMENTO]';
    if (message.stickerMessage) return '[STICKER]';
    if (message.locationMessage) return '[LOCALIZAÇÃO]';
    if (message.contactMessage) return '[CONTATO]';
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    return '[MENSAGEM]';
}

function checkIdempotency(key, ttl = 5 * 60 * 1000) {
    const now = Date.now();
    
    // Limpar cache antigo
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > ttl) {
            idempotencyCache.delete(k);
        }
    }
    
    if (idempotencyCache.has(key)) return true;
    idempotencyCache.set(key, now);
    return false;
}

function addLog(type, message, data = null) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        type,
        message,
        data
    };
    logs.unshift(log);
    if (logs.length > 1000) {
        logs = logs.slice(0, 1000);
    }
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// ============ EVOLUTION API ADAPTER ============
async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        return { ok: true, data: response.data };
    } catch (error) {
        return { 
            ok: false, 
            error: error.response?.data || error.message,
            status: error.response?.status
        };
    }
}

async function sendText(remoteJid, text, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
    };
    return await sendToEvolution(instanceName, '/message/sendText', payload);
}

async function sendImage(remoteJid, imageUrl, caption, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'image',
        media: imageUrl,
        caption: caption || ''
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

async function sendVideo(remoteJid, videoUrl, caption, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'video',
        media: videoUrl,
        caption: caption || ''
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

async function sendAudio(remoteJid, audioUrl, instanceName) {
    const payload = {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'audio',
        media: audioUrl
    };
    return await sendToEvolution(instanceName, '/message/sendMedia', payload);
}

// ============ ENVIO COM STICKY INSTANCE E RETRY ============
async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    let instancesToTry = [...INSTANCES];
    
    // Sticky instance: usar sempre a mesma para o cliente
    const stickyInstance = stickyInstances.get(phoneKey);
    
    if (stickyInstance && !isFirstMessage) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
        
        addLog('STICKY_INSTANCE_USED', `Usando instância fixa ${stickyInstance} para ${phoneKey}`, {
            stickyInstance,
            isFirstMessage
        });
    } else if (isFirstMessage) {
        const nextInstanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        
        instancesToTry = [
            ...INSTANCES.slice(nextInstanceIndex),
            ...INSTANCES.slice(0, nextInstanceIndex)
        ];
        
        addLog('INSTANCE_DISTRIBUTION', `Nova conversa para ${INSTANCES[nextInstanceIndex]}`, { 
            phoneKey,
            nextIndex: nextInstanceIndex
        });
    }
    
    let lastError = null;
    let attempts = 0;
    const maxAttempts = 3; // Tentar até 3 vezes por instância
    
    for (let i = 0; i < instancesToTry.length; i++) {
        const instanceName = instancesToTry[i];
        
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                attempts++;
                addLog('SEND_ATTEMPT', `${instanceName} tentativa ${attempt}/${maxAttempts} para ${phoneKey}`, { 
                    type, 
                    isFirstMessage,
                    totalAttempts: attempts
                });
                
                let result;
                
                if (type === 'text') {
                    result = await sendText(remoteJid, text, instanceName);
                } else if (type === 'image') {
                    result = await sendImage(remoteJid, mediaUrl, '', instanceName);
                } else if (type === 'image+text') {
                    result = await sendImage(remoteJid, mediaUrl, text, instanceName);
                } else if (type === 'video') {
                    result = await sendVideo(remoteJid, mediaUrl, '', instanceName);
                } else if (type === 'video+text') {
                    result = await sendVideo(remoteJid, mediaUrl, text, instanceName);
                } else if (type === 'audio') {
                    result = await sendAudio(remoteJid, mediaUrl, instanceName);
                }
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    
                    if (isFirstMessage) {
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    
                    addLog('SEND_SUCCESS', `Mensagem enviada via ${instanceName} na tentativa ${attempt}`, { 
                        phoneKey, 
                        type,
                        isFirstMessage,
                        stickyInstance: instanceName
                    });
                    
                    return { success: true, instanceName };
                } else {
                    lastError = result.error;
                    addLog('SEND_FAILED', `${instanceName} falhou tentativa ${attempt}: ${JSON.stringify(lastError)}`, { phoneKey, type });
                    
                    if (attempt < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 2000)); // Aguardar 2s entre tentativas
                    }
                }
            } catch (error) {
                lastError = error.message;
                addLog('SEND_ERROR', `${instanceName} erro tentativa ${attempt}: ${error.message}`, { phoneKey, type });
                
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    
    // Se chegou aqui, todas as tentativas falharam
    addLog('SEND_ALL_FAILED', `Todas as instâncias e tentativas falharam para ${phoneKey}`, { 
        lastError,
        totalAttempts: attempts
    });
    
    // Marcar conversa como com problema
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = lastError;
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO DE FUNIS CORRIGIDA ============

// CORREÇÃO 1: Função para criar conversa PIX em espera
async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId: 'CS_PIX',
        stepIndex: -1, // IMPORTANTE: -1 indica que ainda não começou
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        pixWaiting: true, // Flag indicando que está esperando timeout
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    
    addLog('PIX_WAITING_CREATED', `Conversa PIX criada em modo espera para ${phoneKey}`, { 
        orderCode, 
        willStartAt: new Date(Date.now() + PIX_TIMEOUT).toISOString() 
    });
    
    // Configurar timeout de 7 minutos
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', `Timeout PIX disparado para ${phoneKey}, iniciando funil`, { orderCode });
            
            // Iniciar funil PIX do passo 0
            conv.pixWaiting = false;
            conv.stepIndex = 0;
            conversations.set(phoneKey, conv);
            
            await sendStep(phoneKey);
        }
        pixTimeouts.delete(phoneKey);
    }, PIX_TIMEOUT);
    
    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
    
    addLog('PIX_TIMEOUT_SET', `Timeout PIX configurado para ${phoneKey} (7 minutos)`, { orderCode });
}

// CORREÇÃO 2: Transferir de PIX para APROVADA corretamente
async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const pixConversation = conversations.get(phoneKey);
    
    if (pixConversation) {
        // Cancelar conversa PIX
        pixConversation.canceled = true;
        pixConversation.canceledAt = new Date();
        pixConversation.cancelReason = 'PAYMENT_APPROVED';
        conversations.set(phoneKey, pixConversation);
        
        addLog('PIX_CONVERSATION_CANCELED', `Conversa PIX cancelada para transferência`, { phoneKey, orderCode });
    }
    
    // Cancelar timeout PIX se existir
    const pixTimeout = pixTimeouts.get(phoneKey);
    if (pixTimeout) {
        clearTimeout(pixTimeout.timeout);
        pixTimeouts.delete(phoneKey);
        addLog('PIX_TIMEOUT_CANCELED', `Timeout PIX cancelado para ${phoneKey}`, { orderCode });
    }
    
    // Determinar em qual passo começar o funil APROVADA
    let startingStep = 0;
    
    // Se já havia começado a interagir no funil PIX, pular mensagens similares
    if (pixConversation && pixConversation.stepIndex >= 0) {
        // Já recebeu mensagens do PIX, começar do passo 3 do APROVADA
        startingStep = 3;
        addLog('TRANSFER_SKIP_SIMILAR', `Pulando para passo 3 do APROVADA (mensagens similares)`, { phoneKey });
    }
    
    // Criar nova conversa APROVADA
    const approvedConversation = {
        phoneKey,
        remoteJid,
        funnelId: 'CS_APROVADA',
        stepIndex: startingStep,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false,
        transferredFromPix: true,
        previousFunnel: 'CS_PIX'
    };
    
    // Manter sticky instance se existir
    const stickyInstance = stickyInstances.get(phoneKey);
    if (stickyInstance) {
        addLog('TRANSFER_KEEP_STICKY', `Mantendo instância ${stickyInstance} na transferência`, { phoneKey });
    }
    
    conversations.set(phoneKey, approvedConversation);
    
    addLog('TRANSFER_PIX_TO_APPROVED', `Cliente transferido de PIX para APROVADA`, { 
        phoneKey, 
        orderCode,
        startingStep,
        hadInteraction: pixConversation && pixConversation.stepIndex >= 0
    });
    
    // Iniciar envio do funil APROVADA
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount) {
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: 0,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false
    };
    
    conversations.set(phoneKey, conversation);
    addLog('FUNNEL_START', `Iniciando funil ${funnelId} para ${phoneKey}`, { orderCode, productType });
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    // Adquirir lock para evitar race condition
    const hasLock = await acquireLock(phoneKey);
    if (!hasLock) {
        addLog('STEP_LOCK_FAILED', `Não foi possível adquirir lock para ${phoneKey}`);
        return;
    }
    
    try {
        const conversation = conversations.get(phoneKey);
        if (!conversation) {
            addLog('STEP_NO_CONVERSATION', `Nenhuma conversa encontrada para ${phoneKey}`);
            return;
        }
        
        // Verificar se conversa foi cancelada
        if (conversation.canceled) {
            addLog('STEP_CANCELED', `Tentativa de envio em conversa cancelada: ${conversation.funnelId}`, { phoneKey });
            return;
        }
        
        // Se está em modo de espera PIX, não enviar
        if (conversation.pixWaiting) {
            addLog('STEP_PIX_WAITING', `Conversa em espera PIX, não enviando`, { phoneKey });
            return;
        }
        
        const funnel = funis.get(conversation.funnelId);
        if (!funnel) {
            addLog('STEP_NO_FUNNEL', `Funil não encontrado: ${conversation.funnelId}`, { phoneKey });
            return;
        }
        
        const step = funnel.steps[conversation.stepIndex];
        if (!step) {
            addLog('STEP_NOT_FOUND', `Passo ${conversation.stepIndex} não encontrado no funil ${conversation.funnelId}`, { phoneKey });
            return;
        }
        
        const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
        
        addLog('STEP_SEND_START', `Iniciando envio do passo ${conversation.stepIndex} do funil ${conversation.funnelId}`, { 
            step: step.id,
            type: step.type,
            isFirstMessage,
            phoneKey,
            waitForReply: step.waitForReply
        });
        
        // DELAY ANTES (se configurado)
        if (step.delayBefore && step.delayBefore > 0) {
            addLog('STEP_DELAY_BEFORE', `Aguardando ${step.delayBefore}s antes do passo ${conversation.stepIndex}`);
            await new Promise(resolve => setTimeout(resolve, step.delayBefore * 1000));
        }
        
        // MOSTRAR DIGITANDO (se configurado)
        if (step.showTyping) {
            await sendTypingIndicator(phoneKey, conversation.remoteJid);
        }
        
        let result = { success: true };
        
        // PROCESSAR TIPO DO PASSO
        if (step.type === 'delay') {
            const delaySeconds = step.delaySeconds || 10;
            addLog('STEP_DELAY', `Executando delay de ${delaySeconds}s no passo ${conversation.stepIndex}`);
            await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
            
        } else if (step.type === 'typing') {
            const typingSeconds = step.typingSeconds || 3;
            addLog('STEP_TYPING', `Mostrando digitando por ${typingSeconds}s no passo ${conversation.stepIndex}`);
            await sendTypingIndicator(phoneKey, conversation.remoteJid, typingSeconds);
            
        } else {
            // Enviar mensagem real
            result = await sendWithFallback(phoneKey, conversation.remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
        }
        
        if (result.success) {
            conversation.lastSystemMessage = new Date();
            
            // Se deve aguardar resposta
            if (step.waitForReply && step.type !== 'delay' && step.type !== 'typing') {
                conversation.waiting_for_response = true;
                conversations.set(phoneKey, conversation);
                
                addLog('STEP_WAITING_REPLY', `Passo ${conversation.stepIndex} aguardando resposta`, { 
                    funnelId: conversation.funnelId,
                    phoneKey
                });
                
            } else {
                // Avançar automaticamente
                conversations.set(phoneKey, conversation);
                
                addLog('STEP_AUTO_ADVANCE', `Passo ${conversation.stepIndex} avançando automaticamente`, { 
                    funnelId: conversation.funnelId,
                    phoneKey
                });
                
                await advanceConversation(phoneKey, null, 'auto');
            }
            
            addLog('STEP_SUCCESS', `Passo ${conversation.stepIndex} executado com sucesso`, {
                funnelId: conversation.funnelId,
                phoneKey
            });
        } else {
            addLog('STEP_FAILED', `Falha no envio do passo: ${result.error}`, { 
                conversation,
                phoneKey
            });
        }
        
    } finally {
        releaseLock(phoneKey);
    }
}

async function sendTypingIndicator(phoneKey, remoteJid, durationSeconds = 3) {
    const instanceName = stickyInstances.get(phoneKey) || INSTANCES[0];
    
    try {
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'composing'
        });
        
        addLog('TYPING_START', `Iniciando digitação para ${phoneKey} por ${durationSeconds}s`);
        
        await new Promise(resolve => setTimeout(resolve, durationSeconds * 1000));
        
        await sendToEvolution(instanceName, '/chat/sendPresence', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            presence: 'paused'
        });
        
        addLog('TYPING_END', `Finalizando digitação para ${phoneKey}`);
        
    } catch (error) {
        addLog('TYPING_ERROR', `Erro ao enviar digitação: ${error.message}`, { phoneKey });
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const hasLock = await acquireLock(phoneKey);
    if (!hasLock) {
        addLog('ADVANCE_LOCK_FAILED', `Não foi possível adquirir lock para avançar ${phoneKey}`);
        return;
    }
    
    try {
        const conversation = conversations.get(phoneKey);
        if (!conversation) {
            addLog('ADVANCE_ERROR', `Tentativa de avançar conversa inexistente: ${phoneKey}`);
            return;
        }
        
        // Verificar se conversa foi cancelada
        if (conversation.canceled) {
            addLog('ADVANCE_CANCELED', `Tentativa de avanço em conversa cancelada: ${conversation.funnelId}`, { 
                phoneKey, 
                reason 
            });
            return;
        }
        
        const funnel = funis.get(conversation.funnelId);
        if (!funnel) {
            addLog('ADVANCE_ERROR', `Funil não encontrado: ${conversation.funnelId}`, { phoneKey });
            return;
        }
        
        addLog('ADVANCE_START', 'Iniciando avanço da conversa', {
            phoneKey: phoneKey,
            currentStep: conversation.stepIndex,
            funnelId: conversation.funnelId,
            reason: reason
        });
        
        // Avançar para o próximo passo
        const nextStepIndex = conversation.stepIndex + 1;
        
        if (nextStepIndex >= funnel.steps.length) {
            addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído para ${phoneKey}`, {
                totalSteps: funnel.steps.length,
                finalStep: conversation.stepIndex
            });
            
            conversation.waiting_for_response = false;
            conversation.completed = true;
            conversation.completedAt = new Date();
            conversations.set(phoneKey, conversation);
            return;
        }
        
        conversation.stepIndex = nextStepIndex;
        conversation.waiting_for_response = false;
        
        if (reason === 'reply') {
            conversation.lastReply = new Date();
        }
        
        conversations.set(phoneKey, conversation);
        
        addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex}`, { 
            phoneKey,
            funnelId: conversation.funnelId,
            previousStep: conversation.stepIndex - 1,
            nextStep: nextStepIndex,
            reason: reason
        });
        
        // Enviar próximo passo (sem lock, pois sendStep tem seu próprio lock)
        releaseLock(phoneKey);
        await sendStep(phoneKey);
        
    } catch (error) {
        addLog('ADVANCE_ERROR', `Erro ao avançar conversa: ${error.message}`, { phoneKey });
    } finally {
        releaseLock(phoneKey);
    }
}

// ============ WEBHOOKS CORRIGIDOS ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        const event = String(data.event || '').toUpperCase();
        const status = String(data.status || data.payment_status || '').toUpperCase();
        const method = String(data.payment?.method || data.payment_method || '').toUpperCase();
        
        const saleId = data.sale_id || data.checkout_id;
        const orderCode = saleId || 'ORDER_' + Date.now();
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        // Extrair chave do telefone (últimos 8 dígitos)
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('KIRVANO_INVALID_PHONE', 'Telefone inválido recebido', { customerPhone });
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        // Criar remoteJid normalizado
        const remoteJid = phoneToRemoteJid(customerPhone);
        
        // Registrar telefone no índice
        registerPhone(customerPhone, phoneKey);
        
        // Produto sempre CS agora
        const productType = 'CS';
        
        addLog('KIRVANO_EVENT', `${event} - ${productType} - ${customerName}`, { 
            orderCode, 
            phoneKey,
            customerPhone,
            remoteJid,
            method,
            status
        });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            // VENDA APROVADA
            addLog('KIRVANO_APPROVED', `Venda aprovada para ${phoneKey}`, { orderCode, method });
            
            // Verificar se tem conversa PIX ativa
            const existingConversation = conversations.get(phoneKey);
            
            if (existingConversation && existingConversation.funnelId === 'CS_PIX') {
                // Cliente estava no funil PIX e pagou - TRANSFERIR
                addLog('KIRVANO_PIX_TO_APPROVED', `Cliente ${phoneKey} pagou PIX, transferindo para APROVADA`, { 
                    orderCode,
                    wasInPixFunnel: true,
                    pixStep: existingConversation.stepIndex
                });
                
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
                
            } else {
                // Cliente pagou direto (cartão ou PIX muito rápido)
                addLog('KIRVANO_DIRECT_APPROVED', `Cliente ${phoneKey} pagamento direto aprovado`, { orderCode, method });
                
                // Cancelar qualquer timeout PIX existente
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                    addLog('PIX_TIMEOUT_CANCELED', `Timeout PIX cancelado (pagamento aprovado)`, { phoneKey, orderCode });
                }
                
                // Iniciar funil APROVADA do início
                await startFunnel(phoneKey, remoteJid, 'CS_APROVADA', orderCode, customerName, productType, totalPrice);
            }
            
        } else if (isPix && event.includes('GENERATED')) {
            // PIX GERADO - NÃO ENVIAR NADA, APENAS AGUARDAR
            addLog('KIRVANO_PIX_GENERATED', `PIX gerado para ${phoneKey}, aguardando 7 minutos`, { orderCode });
            
            // Verificar se já tem conversa ativa
            const existingConversation = conversations.get(phoneKey);
            
            if (existingConversation && !existingConversation.canceled) {
                addLog('KIRVANO_PIX_DUPLICATE', `Cliente ${phoneKey} já tem conversa ativa, ignorando novo PIX`, { 
                    orderCode,
                    existingFunnel: existingConversation.funnelId,
                    existingOrder: existingConversation.orderCode
                });
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            // Criar conversa em modo de espera
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            
        } else {
            addLog('KIRVANO_UNKNOWN', `Evento desconhecido: ${event}`, { orderCode, phoneKey });
        }
        
        res.json({ success: true, message: 'Processado', phoneKey });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// WEBHOOK EVOLUTION CORRIGIDO
app.post('/webhook/evolution', async (req, res) => {
    console.log('===== WEBHOOK EVOLUTION RECEBIDO =====');
    console.log(JSON.stringify(req.body, null, 2));
    
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            addLog('WEBHOOK_IGNORED', 'Webhook sem dados de mensagem');
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageId = messageData.key.id;
        const messageText = extractMessageText(messageData.message);
        
        // Extrair telefone do remoteJid
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('WEBHOOK_INVALID_PHONE', 'Telefone inválido no webhook', { remoteJid });
            return res.json({ success: true });
        }
        
        addLog('WEBHOOK_DETAILS', 'Processando mensagem', { 
            remoteJid, 
            fromMe, 
            phoneKey,
            messageText: messageText.substring(0, 100),
            messageId
        });
        
        if (fromMe) {
            addLog('WEBHOOK_FROM_ME', 'Mensagem enviada por nós ignorada', { phoneKey });
            return res.json({ success: true });
        }
        
        // Adquirir lock para evitar race condition
        const hasLock = await acquireLock(phoneKey, 10000);
        if (!hasLock) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout esperando lock para processar resposta de ${phoneKey}`);
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            // Buscar conversa
            const conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation) {
                addLog('WEBHOOK_NO_CONVERSATION', 'Mensagem sem conversa ativa', { phoneKey });
                return res.json({ success: true });
            }
            
            if (conversation.canceled) {
                addLog('WEBHOOK_CANCELED_CONVERSATION', 'Mensagem em conversa cancelada', { 
                    phoneKey,
                    funnelId: conversation.funnelId
                });
                return res.json({ success: true });
            }
            
            if (!conversation.waiting_for_response) {
                addLog('WEBHOOK_NOT_WAITING', 'Conversa não está aguardando resposta', { 
                    phoneKey,
                    funnelId: conversation.funnelId,
                    stepIndex: conversation.stepIndex
                });
                return res.json({ success: true });
            }
            
            // Registrar resposta do cliente
            addLog('CLIENT_REPLY', 'Resposta do cliente recebida', { 
                phoneKey,
                text: messageText.substring(0, 100),
                step: conversation.stepIndex,
                funnelId: conversation.funnelId
            });
            
            // Marcar que não está mais aguardando resposta ANTES de avançar
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            // Liberar lock antes de avançar (pois advanceConversation tem seu próprio lock)
            releaseLock(phoneKey);
            
            // Avançar conversa
            await advanceConversation(phoneKey, messageText, 'reply');
            
        } finally {
            releaseLock(phoneKey);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, { body: req.body });
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

// Dashboard
app.get('/api/dashboard', (req, res) => {
    const instanceUsage = {};
    INSTANCES.forEach(inst => {
        instanceUsage[inst] = 0;
    });
    
    stickyInstances.forEach((instance) => {
        if (instanceUsage[instance] !== undefined) {
            instanceUsage[instance]++;
        }
    });
    
    const nextInstanceIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
    const nextInstance = INSTANCES[nextInstanceIndex];
    
    // Contar conversas por status
    let activeCount = 0;
    let waitingCount = 0;
    let completedCount = 0;
    let canceledCount = 0;
    let errorCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.canceled) canceledCount++;
        else if (conv.hasError) errorCount++;
        else if (conv.waiting_for_response) waitingCount++;
        else activeCount++;
    });
    
    const stats = {
        active_conversations: activeCount,
        waiting_responses: waitingCount,
        completed_conversations: completedCount,
        canceled_conversations: canceledCount,
        error_conversations: errorCount,
        pending_pix: pixTimeouts.size,
        total_funnels: funis.size,
        total_instances: INSTANCES.length,
        sticky_instances: stickyInstances.size,
        last_successful_instance: lastSuccessfulInstanceIndex >= 0 ? INSTANCES[lastSuccessfulInstanceIndex] : 'Nenhuma',
        next_instance_in_queue: nextInstance,
        instance_distribution: instanceUsage,
        conversations_per_instance: Math.round(conversations.size / INSTANCES.length),
        processing_locks: processingLocks.size
    };
    
    res.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString()
    });
});

// Funis
app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id === 'CS_APROVADA' || funnel.id === 'CS_PIX',
        stepCount: funnel.steps.length
    }));
    
    res.json({
        success: true,
        data: funnelsList
    });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ 
            success: false, 
            error: 'ID, nome e passos são obrigatórios' 
        });
    }
    
    // Apenas aceitar funis CS
    if (!funnel.id.startsWith('CS_')) {
        return res.status(400).json({ 
            success: false, 
            error: 'Apenas funis CS são permitidos' 
        });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id);
    
    saveFunnelsToFile();
    
    res.json({ 
        success: true, 
        message: 'Funil salvo com sucesso',
        data: funnel
    });
});

// Export de funis
app.get('/api/funnels/export', (req, res) => {
    try {
        const funnelsArray = Array.from(funis.values());
        const exportData = {
            version: '2.0',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        };
        
        const filename = `kirvano-funis-backup-${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify(exportData, null, 2));
        
        addLog('FUNNELS_EXPORT', `Export realizado: ${funnelsArray.length} funis`, { filename });
        
    } catch (error) {
        addLog('FUNNELS_EXPORT_ERROR', 'Erro no export: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Import de funis
app.post('/api/funnels/import', (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.funnels || !Array.isArray(importData.funnels)) {
            return res.status(400).json({ 
                success: false, 
                error: 'Arquivo de backup inválido' 
            });
        }
        
        const { funnels } = importData;
        let importedCount = 0;
        let skippedCount = 0;
        
        funnels.forEach(funnel => {
            if (funnel.id && funnel.name && funnel.steps && funnel.id.startsWith('CS_')) {
                funis.set(funnel.id, funnel);
                importedCount++;
                addLog('FUNNEL_IMPORTED', `Funil importado: ${funnel.id}`);
            } else {
                skippedCount++;
                addLog('FUNNEL_IMPORT_SKIP', `Funil inválido ignorado: ${funnel.id || 'sem ID'}`);
            }
        });
        
        saveFunnelsToFile();
        
        addLog('FUNNELS_IMPORT_COMPLETE', `Import concluído: ${importedCount} importados, ${skippedCount} ignorados`);
        
        res.json({ 
            success: true, 
            message: `Import concluído com sucesso!`,
            imported: importedCount,
            skipped: skippedCount,
            total: funnels.length
        });
        
    } catch (error) {
        addLog('FUNNELS_IMPORT_ERROR', 'Erro no import: ' + error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Conversas
app.get('/api/conversations', (req, res) => {
    const conversationsList = Array.from(conversations.entries()).map(([phoneKey, conv]) => ({
        id: phoneKey,
        phone: conv.remoteJid.replace('@s.whatsapp.net', ''),
        phoneKey: phoneKey,
        customerName: conv.customerName,
        productType: conv.productType,
        funnelId: conv.funnelId,
        stepIndex: conv.stepIndex,
        waiting_for_response: conv.waiting_for_response,
        pixWaiting: conv.pixWaiting || false,
        createdAt: conv.createdAt,
        lastSystemMessage: conv.lastSystemMessage,
        lastReply: conv.lastReply,
        orderCode: conv.orderCode,
        amount: conv.amount,
        stickyInstance: stickyInstances.get(phoneKey),
        canceled: conv.canceled || false,
        completed: conv.completed || false,
        hasError: conv.hasError || false,
        errorMessage: conv.errorMessage,
        transferredFromPix: conv.transferredFromPix || false
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({
        success: true,
        data: conversationsList
    });
});

// Logs
app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({
        success: true,
        data: recentLogs
    });
});

// Debug Evolution
app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY.length,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        last_successful_instance: lastSuccessfulInstanceIndex >= 0 ? INSTANCES[lastSuccessfulInstanceIndex] : 'Nenhuma',
        phone_index_size: phoneIndex.size,
        pix_timeouts_active: pixTimeouts.size,
        processing_locks_active: processingLocks.size,
        test_results: []
    };
    
    try {
        const testInstance = INSTANCES[0];
        const url = EVOLUTION_BASE_URL + '/message/sendText/' + testInstance;
        
        const response = await axios.post(url, {
            number: '5511999999999',
            text: 'teste'
        }, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 10000,
            validateStatus: () => true
        });
        
        debugInfo.test_results.push({
            instance: testInstance,
            url: url,
            status: response.status,
            response: response.data
        });
        
    } catch (error) {
        debugInfo.test_results.push({
            instance: INSTANCES[0],
            error: error.message,
            code: error.code
        });
    }
    
    res.json(debugInfo);
});

// ============ SERVIR FRONTEND ============
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/teste.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teste.html'));
});

// Inicialização
async function initializeData() {
    console.log('🔄 Carregando dados persistidos...');
    
    const funnelsLoaded = await loadFunnelsFromFile();
    if (!funnelsLoaded) {
        console.log('📋 Usando funis padrão');
    }
    
    const conversationsLoaded = await loadConversationsFromFile();
    if (!conversationsLoaded) {
        console.log('💬 Nenhuma conversa anterior encontrada');
    }
    
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis carregados:', funis.size);
    console.log('💬 Conversas ativas:', conversations.size);
    console.log('📱 Índice de telefones:', phoneIndex.size);
}

// ============ INICIALIZAÇÃO ============
app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO SYSTEM V3.0 - VERSÃO CORRIGIDA');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('API Key configurada:', EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI');
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('✅ CORREÇÕES IMPLEMENTADAS:');
    console.log('  ✔️ PIX aguarda 7 minutos antes de enviar mensagens');
    console.log('  ✔️ Transferência PIX → APROVADA funcionando');
    console.log('  ✔️ Sistema de locks para evitar race conditions');
    console.log('  ✔️ Respostas de clientes processadas corretamente');
    console.log('  ✔️ Retry automático com múltiplas tentativas');
    console.log('  ✔️ Logs detalhados e estruturados');
    console.log('  ✔️ Tratamento de todos tipos de mensagem');
    console.log('  ✔️ Sticky instances mantidas');
    console.log('  ✔️ Distribuição round-robin balanceada');
    console.log('');
    console.log('📊 MELHORIAS:');
    console.log('  • Lock por conversa (evita processamento simultâneo)');
    console.log('  • 3 tentativas por instância antes de falhar');
    console.log('  • Detecção de conversas com erro');
    console.log('  • PIX em modo espera (pixWaiting flag)');
    console.log('  • Transferência inteligente entre funis');
    console.log('');
    console.log('📡 API Endpoints:');
    console.log('  GET  /api/dashboard        - Estatísticas detalhadas');
    console.log('  GET  /api/funnels          - Listar funis');
    console.log('  POST /api/funnels          - Criar/editar funil');
    console.log('  GET  /api/conversations    - Listar conversas');
    console.log('  GET  /api/logs             - Logs recentes');
    console.log('  GET  /api/debug/evolution  - Debug Evolution API');
    console.log('');
    console.log('📨 Webhooks:');
    console.log('  POST /webhook/kirvano      - Eventos Kirvano');
    console.log('  POST /webhook/evolution    - Respostas clientes');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('🧪 Testes: http://localhost:' + PORT + '/teste.html');
    console.log('='.repeat(70));
    
    await initializeData();
});
