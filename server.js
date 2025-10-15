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
const PHRASE_COOLDOWN = 24 * 60 * 60 * 1000; // 24 horas para frases-chave
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'funnels.json');
const CONVERSATIONS_FILE = path.join(__dirname, 'data', 'conversations.json');
const PHRASES_FILE = path.join(__dirname, 'data', 'phrases.json');

// Produtos CS e FB
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FB'
};

// Instâncias Evolution (12 instâncias)
const INSTANCES = ['GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 'GABY06', 'GABY07', 'GABY08', 'GABY09', 'GABY10', 'GABY11', 'GABY12'];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;

// 🆕 NOVO: Sistema de frases-chave
let phraseTriggers = new Map(); // Armazena frases e funis associados
let phraseCooldowns = new Map(); // Controla cooldown de 24h por telefone+frase

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': {
        id: 'CS_APROVADA',
        name: 'CS - Compra Aprovada',
        steps: []
    },
    'CS_PIX': {
        id: 'CS_PIX',
        name: 'CS - PIX Pendente',
        steps: []
    },
    'FB_APROVADA': {
        id: 'FB_APROVADA',
        name: 'FB - Compra Aprovada',
        steps: []
    },
    'FB_PIX': {
        id: 'FB_PIX',
        name: 'FB - PIX Pendente',
        steps: []
    }
};

// ============ SISTEMA DE LOCK SIMPLIFICADO (APENAS WEBHOOK) ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const startTime = Date.now();
    while (webhookLocks.get(phoneKey)) {
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout esperando lock webhook para ${phoneKey}`);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    webhookLocks.set(phoneKey, true);
    addLog('WEBHOOK_LOCK_ACQUIRED', `Lock webhook adquirido para ${phoneKey}`);
    return true;
}

function releaseWebhookLock(phoneKey) {
    webhookLocks.delete(phoneKey);
    addLog('WEBHOOK_LOCK_RELEASED', `Lock webhook liberado para ${phoneKey}`);
}

// ============ PERSISTÊNCIA DE DADOS ============
async function ensureDataDir() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
    } catch (error) {
        console.log('Pasta data já existe');
    }
}

async function saveFunnelsToFile() {
    try {
        await ensureDataDir();
        const funnelsArray = Array.from(funis.values());
        await fs.writeFile(DATA_FILE, JSON.stringify(funnelsArray, null, 2));
        addLog('DATA_SAVE', 'Funis salvos: ' + funnelsArray.length);
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
            if (funnel.id.startsWith('CS_') || funnel.id.startsWith('FB_') || funnel.id.startsWith('PHRASE_')) {
                funis.set(funnel.id, funnel);
            }
        });
        addLog('DATA_LOAD', 'Funis carregados: ' + funis.size);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Usando funis padrão');
        return false;
    }
}

// 🆕 NOVO: Persistência de frases-chave
async function savePhrasesToFile() {
    try {
        await ensureDataDir();
        const phrasesArray = Array.from(phraseTriggers.entries()).map(([phrase, data]) => ({
            phrase,
            funnelId: data.funnelId,
            active: data.active,
            triggerCount: data.triggerCount
        }));
        await fs.writeFile(PHRASES_FILE, JSON.stringify(phrasesArray, null, 2));
        addLog('PHRASES_SAVE', 'Frases salvas: ' + phrasesArray.length);
    } catch (error) {
        addLog('PHRASES_SAVE_ERROR', 'Erro ao salvar frases: ' + error.message);
    }
}

async function loadPhrasesFromFile() {
    try {
        const data = await fs.readFile(PHRASES_FILE, 'utf8');
        const phrasesArray = JSON.parse(data);
        phraseTriggers.clear();
        phrasesArray.forEach(item => {
            phraseTriggers.set(item.phrase, {
                funnelId: item.funnelId,
                active: item.active !== false,
                triggerCount: item.triggerCount || 0
            });
        });
        addLog('PHRASES_LOAD', 'Frases carregadas: ' + phraseTriggers.size);
        return true;
    } catch (error) {
        addLog('PHRASES_LOAD_ERROR', 'Nenhuma frase cadastrada');
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
        
        await fs.writeFile(CONVERSATIONS_FILE, JSON.stringify({
            conversations: conversationsArray,
            phoneIndex: Array.from(phoneIndex.entries()),
            stickyInstances: Array.from(stickyInstances.entries())
        }, null, 2));
        
        addLog('DATA_SAVE', 'Conversas salvas: ' + conversationsArray.length);
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
            conversations.set(conv.phoneKey, {
                ...conv,
                createdAt: new Date(conv.createdAt),
                lastSystemMessage: conv.lastSystemMessage ? new Date(conv.lastSystemMessage) : null,
                lastReply: conv.lastReply ? new Date(conv.lastReply) : null,
                completedAt: conv.completedAt ? new Date(conv.completedAt) : null,
                canceledAt: conv.canceledAt ? new Date(conv.canceledAt) : null
            });
        });
        phoneIndex.clear();
        parsed.phoneIndex.forEach(([key, value]) => phoneIndex.set(key, value));
        stickyInstances.clear();
        parsed.stickyInstances.forEach(([key, value]) => stickyInstances.set(key, value));
        addLog('DATA_LOAD', 'Conversas carregadas: ' + parsed.conversations.length);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior');
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
    await savePhrasesToFile(); // 🆕 NOVO: Salvar frases também
}, 30000);

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

// ============ MIDDLEWARES ============
app.use(express.json());
app.use(express.static('public'));

// ============ FUNÇÕES AUXILIARES ============
function extractPhoneKey(phone) {
    if (!phone) return '';
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.slice(-8);
}

function registerPhone(fullPhone, phoneKey) {
    if (!phoneKey || phoneKey.length !== 8) return;
    const cleaned = fullPhone.replace(/\D/g, '');
    phoneIndex.set(cleaned, phoneKey);
    if (cleaned.startsWith('55')) {
        phoneIndex.set(cleaned.substring(2), phoneKey);
    }
    if (!cleaned.startsWith('55')) {
        phoneIndex.set('55' + cleaned, phoneKey);
    }
}

function findConversationByPhone(phone) {
    const phoneKey = extractPhoneKey(phone);
    if (!phoneKey || phoneKey.length !== 8) return null;
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        registerPhone(phone, phoneKey);
    }
    return conversation;
}

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
    return '[MENSAGEM]';
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
    if (logs.length > 1000) logs = logs.slice(0, 1000);
    console.log('[' + log.timestamp.toISOString() + '] ' + type + ': ' + message);
}

// 🆕 NOVO: Função para detectar frase-chave
function checkPhraseTrigger(phoneKey, messageText) {
    const normalizedMessage = messageText.toLowerCase().trim();
    
    addLog('PHRASE_CHECK_START', `Normalizando mensagem: "${normalizedMessage}"`, { phoneKey });
    
    for (const [phrase, data] of phraseTriggers.entries()) {
        if (!data.active) {
            addLog('PHRASE_SKIP_INACTIVE', `Frase inativa: "${phrase}"`, { phoneKey });
            continue;
        }
        
        const normalizedPhrase = phrase.toLowerCase().trim();
        
        addLog('PHRASE_COMPARING', `Comparando "${normalizedMessage}" com "${normalizedPhrase}"`, { phoneKey, match: normalizedMessage === normalizedPhrase });
        
        if (normalizedMessage === normalizedPhrase) {
            // Verificar cooldown
            const cooldownKey = `${phoneKey}:${phrase}`;
            const lastTrigger = phraseCooldowns.get(cooldownKey);
            
            if (lastTrigger && (Date.now() - lastTrigger) < PHRASE_COOLDOWN) {
                addLog('PHRASE_COOLDOWN', `Cooldown ativo para "${phrase}"`, { phoneKey });
                return null;
            }
            
            // Frase detectada!
            addLog('PHRASE_TRIGGERED', `Frase detectada: "${phrase}"`, { phoneKey, funnelId: data.funnelId });
            
            // Atualizar cooldown e contador
            phraseCooldowns.set(cooldownKey, Date.now());
            data.triggerCount = (data.triggerCount || 0) + 1;
            phraseTriggers.set(phrase, data);
            savePhrasesToFile();
            
            return data.funnelId;
        }
    }
    
    addLog('PHRASE_NOT_FOUND', `Nenhuma frase correspondente para: "${normalizedMessage}"`, { phoneKey });
    return null;
}

// ============ EVOLUTION API ============
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
    return await sendToEvolution(instanceName, '/message/sendText', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
    });
}

async function sendImage(remoteJid, imageUrl, caption, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendMedia', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'image',
        media: imageUrl,
        caption: caption || ''
    });
}

async function sendVideo(remoteJid, videoUrl, caption, instanceName) {
    return await sendToEvolution(instanceName, '/message/sendMedia', {
        number: remoteJid.replace('@s.whatsapp.net', ''),
        mediatype: 'video',
        media: videoUrl,
        caption: caption || ''
    });
}

async function sendAudio(remoteJid, audioUrl, instanceName) {
    try {
        addLog('AUDIO_DOWNLOAD_START', `Baixando áudio de ${audioUrl}`);
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        addLog('AUDIO_CONVERTED', `Áudio convertido para base64 (${Math.round(base64Audio.length / 1024)}KB)`);
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64,
            delay: 1200,
            encoding: true
        });
        if (result.ok) {
            addLog('AUDIO_SENT_PTT', `Áudio enviado como PTT com sucesso`);
            return result;
        }
        addLog('AUDIO_FALLBACK_MEDIA', `Tentando formato alternativo`);
        return await sendToEvolution(instanceName, '/message/sendMedia', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            mediatype: 'audio',
            media: audioBase64,
            mimetype: 'audio/mpeg'
        });
    } catch (error) {
        addLog('AUDIO_ERROR', `Erro ao processar áudio: ${error.message}`);
        addLog('AUDIO_FALLBACK_URL', `Usando fallback com URL direta`);
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl,
            delay: 1200
        });
    }
}

// ============ ENVIO COM RETRY ============
async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    let instancesToTry = [...INSTANCES];
    const stickyInstance = stickyInstances.get(phoneKey);
    
    // 🆕 CORREÇÃO: Se já tem sticky instance, SEMPRE usa ela primeiro (mesmo em primeira mensagem)
    if (stickyInstance) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
        addLog('SEND_USING_STICKY', `Usando sticky instance: ${stickyInstance}`, { phoneKey, isFirstMessage });
    } else if (isFirstMessage) {
        // Só faz rodízio se NÃO tiver sticky instance
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        instancesToTry = [...INSTANCES.slice(nextIndex), ...INSTANCES.slice(0, nextIndex)];
        addLog('SEND_USING_ROTATION', `Usando rodízio, próxima: ${instancesToTry[0]}`, { phoneKey });
    }
    
    let lastError = null;
    const maxAttempts = 3;
    
    for (const instanceName of instancesToTry) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let result;
                
                if (type === 'text') result = await sendText(remoteJid, text, instanceName);
                else if (type === 'image') result = await sendImage(remoteJid, mediaUrl, text || '', instanceName);
                else if (type === 'video') result = await sendVideo(remoteJid, mediaUrl, text || '', instanceName);
                else if (type === 'audio') result = await sendAudio(remoteJid, mediaUrl, instanceName);
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    if (isFirstMessage && !stickyInstance) {
                        // Só atualiza o índice se for rodízio (não tinha sticky)
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    addLog('SEND_SUCCESS', `Mensagem enviada via ${instanceName}`, { phoneKey, type });
                    return { success: true, instanceName };
                }
                
                lastError = result.error;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                lastError = error.message;
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    
    addLog('SEND_ALL_FAILED', `Falha total no envio para ${phoneKey}`, { lastError });
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = lastError;
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: lastError };
}

// ============ ORQUESTRAÇÃO - SEM LOCKS INTERNOS ============

async function createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const funnelId = productType === 'CS' ? 'CS_PIX' : 'FB_PIX';
    
    const conversation = {
        phoneKey,
        remoteJid,
        funnelId,
        stepIndex: -1,
        orderCode,
        customerName,
        productType,
        amount,
        waiting_for_response: false,
        pixWaiting: true,
        createdAt: new Date(),
        lastSystemMessage: null,
        lastReply: null,
        canceled: false,
        completed: false,
        source: 'kirvano' // 🆕 NOVO: identificar origem
    };
    
    conversations.set(phoneKey, conversation);
    addLog('PIX_WAITING_CREATED', `PIX em espera para ${phoneKey}`, { orderCode, productType });
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', `Timeout PIX disparado para ${phoneKey}`, { orderCode });
            conv.pixWaiting = false;
            conv.stepIndex = 0;
            conversations.set(phoneKey, conv);
            await sendStep(phoneKey);
        }
        pixTimeouts.delete(phoneKey);
    }, PIX_TIMEOUT);
    
    pixTimeouts.set(phoneKey, { timeout, orderCode, createdAt: new Date() });
}

async function transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, amount) {
    const pixConv = conversations.get(phoneKey);
    
    if (pixConv) {
        pixConv.canceled = true;
        pixConv.canceledAt = new Date();
        pixConv.cancelReason = 'PAYMENT_APPROVED';
        conversations.set(phoneKey, pixConv);
    }
    
    const pixTimeout = pixTimeouts.get(phoneKey);
    if (pixTimeout) {
        clearTimeout(pixTimeout.timeout);
        pixTimeouts.delete(phoneKey);
        addLog('PIX_TIMEOUT_CANCELED', `Timeout cancelado para ${phoneKey}`, { orderCode });
    }
    
    let startingStep = 0;
    
    if (pixConv && pixConv.stepIndex >= 0) {
        startingStep = 3;
        addLog('TRANSFER_SKIP_SIMILAR', `Cliente já interagiu, começando passo 3`, { phoneKey });
    } else {
        addLog('TRANSFER_FROM_BEGINNING', `Cliente não interagiu, começando passo 0`, { phoneKey });
    }
    
    const funnelId = productType === 'CS' ? 'CS_APROVADA' : 'FB_APROVADA';
    
    const approvedConv = {
        phoneKey,
        remoteJid,
        funnelId,
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
        previousFunnel: productType === 'CS' ? 'CS_PIX' : 'FB_PIX',
        source: 'kirvano' // 🆕 NOVO: identificar origem
    };
    
    conversations.set(phoneKey, approvedConv);
    addLog('TRANSFER_PIX_TO_APPROVED', `Transferido para APROVADA`, { phoneKey, startingStep, productType });
    
    await sendStep(phoneKey);
}

async function startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, amount, source = 'kirvano') {
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
        completed: false,
        source // 🆕 NOVO: identificar origem (kirvano ou phrase)
    };
    
    conversations.set(phoneKey, conversation);
    addLog('FUNNEL_START', `Iniciando ${funnelId} para ${phoneKey}`, { orderCode, source });
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.canceled) {
        addLog('STEP_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', `Aguardando timeout PIX`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) return;
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}`, { 
        phoneKey,
        funnelId: conversation.funnelId,
        stepType: step.type
    });
    
    let result = { success: true };
    
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s antes de enviar`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping && step.type !== 'delay') {
        addLog('STEP_SHOW_TYPING', `Mostrando "digitando..." por 3s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `Delay de ${delaySeconds}s`, { phoneKey });
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else {
        result = await sendWithFallback(phoneKey, conversation.remoteJid, step.type, step.text, step.mediaUrl, isFirstMessage);
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            addLog('STEP_WAITING_REPLY', `Aguardando resposta passo ${conversation.stepIndex}`, { phoneKey });
        } else {
            conversations.set(phoneKey, conversation);
            addLog('STEP_AUTO_ADVANCE', `Avançando automaticamente passo ${conversation.stepIndex}`, { phoneKey });
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', `Falha no envio`, { phoneKey, error: result.error });
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    if (!conversation) return;
    
    if (conversation.canceled) {
        addLog('ADVANCE_CANCELED', `Conversa cancelada`, { phoneKey });
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) return;
    
    const nextStepIndex = conversation.stepIndex + 1;
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído`, { phoneKey });
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
    addLog('STEP_ADVANCE', `Avançando para passo ${nextStepIndex}`, { phoneKey, reason });
    
    await sendStep(phoneKey);
}

// ============ WEBHOOKS ============
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
        
        const phoneKey = extractPhoneKey(customerPhone);
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(customerPhone);
        registerPhone(customerPhone, phoneKey);
        
        const products = data.products || [];
        let productType = 'CS';
        
        for (const product of products) {
            if (product.offer_id && PRODUCT_MAPPING[product.offer_id]) {
                productType = PRODUCT_MAPPING[product.offer_id];
                break;
            }
        }
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, { orderCode, phoneKey, method, productType });
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const existingConv = conversations.get(phoneKey);
            const isPixFunnel = existingConv && (existingConv.funnelId === 'CS_PIX' || existingConv.funnelId === 'FB_PIX');
            
            if (isPixFunnel) {
                addLog('KIRVANO_PIX_TO_APPROVED', `Cliente pagou PIX`, { phoneKey, orderCode, productType });
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            } else {
                addLog('KIRVANO_DIRECT_APPROVED', `Pagamento aprovado direto`, { phoneKey, orderCode, productType });
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                const funnelId = productType === 'CS' ? 'CS_APROVADA' : 'FB_APROVADA';
                await startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, totalPrice, 'kirvano');
            }
        } else if (isPix && event.includes('GENERATED')) {
            addLog('KIRVANO_PIX_GENERATED', `PIX gerado, aguardando 7min`, { phoneKey, orderCode, productType });
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                addLog('KIRVANO_PIX_DUPLICATE', `Conversa já existe`, { phoneKey });
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
        }
        
        res.json({ success: true, phoneKey, productType });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        
        // 🆕 NOVO: Detectar qual instância recebeu a mensagem
        const instanceName = data.instance || null;
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            return res.json({ success: true });
        }
        
        if (fromMe) {
            return res.json({ success: true });
        }
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationByPhone(incomingPhone);
            
            // 🆕 DEBUG: Log da mensagem recebida
            addLog('WEBHOOK_MESSAGE_RECEIVED', `Mensagem: "${messageText}" | Instância: ${instanceName}`, { phoneKey });
            
            // 🆕 NOVO: Verificar frase-chave APENAS se não estiver em conversa ativa
            if (!conversation || conversation.completed || conversation.canceled) {
                addLog('WEBHOOK_CHECK_PHRASE', `Verificando frases-chave para: "${messageText}"`, { phoneKey, totalPhrases: phraseTriggers.size });
                
                const triggeredFunnelId = checkPhraseTrigger(phoneKey, messageText);
                
                if (triggeredFunnelId) {
                    const funnel = funis.get(triggeredFunnelId);
                    
                    if (funnel && funnel.steps && funnel.steps.length > 0) {
                        addLog('PHRASE_FUNNEL_START', `Iniciando funil por frase via ${instanceName}`, { phoneKey, funnelId: triggeredFunnelId });
                        
                        // 🆕 NOVO: Definir sticky instance ANTES de iniciar o funil
                        if (instanceName && INSTANCES.includes(instanceName)) {
                            stickyInstances.set(phoneKey, instanceName);
                            addLog('STICKY_INSTANCE_SET', `Sticky instance definida: ${instanceName}`, { phoneKey });
                        }
                        
                        await startFunnel(
                            phoneKey, 
                            remoteJid, 
                            triggeredFunnelId, 
                            'PHRASE_' + Date.now(), 
                            'Cliente', 
                            'PHRASE', 
                            '', 
                            'phrase'
                        );
                        return res.json({ success: true, triggered: true });
                    } else {
                        addLog('PHRASE_FUNNEL_EMPTY', `Funil ${triggeredFunnelId} está vazio`, { phoneKey });
                    }
                }
            }
            
            // Processar resposta de conversa existente
            if (!conversation || conversation.canceled || !conversation.waiting_for_response) {
                addLog('WEBHOOK_NOT_WAITING', `Não aguardando resposta`, { phoneKey });
                return res.json({ success: true });
            }
            
            addLog('CLIENT_REPLY', `Resposta recebida`, { phoneKey, text: messageText.substring(0, 50) });
            
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            await advanceConversation(phoneKey, messageText, 'reply');
            
            res.json({ success: true });
            
        } finally {
            releaseWebhookLock(phoneKey);
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message);
        releaseWebhookLock(phoneKey);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ API ENDPOINTS ============

app.get('/api/dashboard', (req, res) => {
    const instanceUsage = {};
    INSTANCES.forEach(inst => instanceUsage[inst] = 0);
    stickyInstances.forEach(instance => {
        if (instanceUsage[instance] !== undefined) instanceUsage[instance]++;
    });
    
    let activeCount = 0, waitingCount = 0, completedCount = 0, canceledCount = 0, errorCount = 0;
    
    conversations.forEach(conv => {
        if (conv.completed) completedCount++;
        else if (conv.canceled) canceledCount++;
        else if (conv.hasError) errorCount++;
        else if (conv.waiting_for_response) waitingCount++;
        else activeCount++;
    });
    
    res.json({
        success: true,
        data: {
            active_conversations: activeCount,
            waiting_responses: waitingCount,
            completed_conversations: completedCount,
            canceled_conversations: canceledCount,
            error_conversations: errorCount,
            pending_pix: pixTimeouts.size,
            total_funnels: funis.size,
            total_phrases: phraseTriggers.size, // 🆕 NOVO
            total_instances: INSTANCES.length,
            sticky_instances: stickyInstances.size,
            instance_distribution: instanceUsage,
            webhook_locks: webhookLocks.size
        }
    });
});

app.get('/api/funnels', (req, res) => {
    const funnelsList = Array.from(funis.values()).map(funnel => ({
        ...funnel,
        isDefault: funnel.id.startsWith('CS_') || funnel.id.startsWith('FB_'),
        stepCount: funnel.steps.length
    }));
    res.json({ success: true, data: funnelsList });
});

app.post('/api/funnels', (req, res) => {
    const funnel = req.body;
    
    if (!funnel.id || !funnel.name || !funnel.steps) {
        return res.status(400).json({ success: false, error: 'Campos obrigatórios faltando' });
    }
    
    // 🆕 NOVO: Aceitar também funis PHRASE_
    if (!funnel.id.startsWith('CS_') && !funnel.id.startsWith('FB_') && !funnel.id.startsWith('PHRASE_')) {
        return res.status(400).json({ success: false, error: 'Apenas funis CS, FB e PHRASE permitidos' });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', 'Funil salvo: ' + funnel.id);
    saveFunnelsToFile();
    
    res.json({ success: true, message: 'Funil salvo', data: funnel });
});

app.delete('/api/funnels/:id', (req, res) => {
    const funnelId = req.params.id;
    
    // Não permitir excluir funis padrão CS e FB
    if (funnelId.startsWith('CS_') || funnelId.startsWith('FB_')) {
        return res.status(400).json({ success: false, error: 'Não pode excluir funis padrão CS/FB' });
    }
    
    if (funis.has(funnelId)) {
        funis.delete(funnelId);
        addLog('FUNNEL_DELETED', 'Funil excluído: ' + funnelId);
        saveFunnelsToFile();
        res.json({ success: true, message: 'Funil excluído' });
    } else {
        res.status(404).json({ success: false, error: 'Funil não encontrado' });
    }
});

app.get('/api/funnels/export', (req, res) => {
    try {
        const funnelsArray = Array.from(funis.values());
        const filename = `kirvano-funis-${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(JSON.stringify({
            version: '5.0',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        }, null, 2));
        
        addLog('FUNNELS_EXPORT', `Export: ${funnelsArray.length} funis`);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/funnels/import', (req, res) => {
    try {
        const importData = req.body;
        
        if (!importData.funnels || !Array.isArray(importData.funnels)) {
            return res.status(400).json({ success: false, error: 'Arquivo inválido' });
        }
        
        let importedCount = 0, skippedCount = 0;
        
        importData.funnels.forEach(funnel => {
            if (funnel.id && funnel.name && funnel.steps && 
                (funnel.id.startsWith('CS_') || funnel.id.startsWith('FB_') || funnel.id.startsWith('PHRASE_'))) {
                funis.set(funnel.id, funnel);
                importedCount++;
            } else {
                skippedCount++;
            }
        });
        
        saveFunnelsToFile();
        addLog('FUNNELS_IMPORT', `Import: ${importedCount} importados, ${skippedCount} ignorados`);
        
        res.json({ 
            success: true, 
            imported: importedCount,
            skipped: skippedCount,
            total: importData.funnels.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 🆕 NOVO: API Endpoints para Frases-Chave
app.get('/api/phrases', (req, res) => {
    const phrasesList = Array.from(phraseTriggers.entries()).map(([phrase, data]) => ({
        phrase,
        funnelId: data.funnelId,
        active: data.active !== false,
        triggerCount: data.triggerCount || 0
    }));
    res.json({ success: true, data: phrasesList });
});

app.post('/api/phrases', (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Frase e funil são obrigatórios' });
    }
    
    const normalizedPhrase = phrase.trim();
    
    if (phraseTriggers.has(normalizedPhrase)) {
        return res.status(400).json({ success: false, error: 'Frase já cadastrada' });
    }
    
    if (!funis.has(funnelId)) {
        return res.status(400).json({ success: false, error: 'Funil não encontrado' });
    }
    
    phraseTriggers.set(normalizedPhrase, {
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    addLog('PHRASE_ADDED', `Frase cadastrada: "${normalizedPhrase}"`, { funnelId });
    savePhrasesToFile();
    
    res.json({ success: true, message: 'Frase cadastrada com sucesso' });
});

app.put('/api/phrases/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    const { funnelId, active } = req.body;
    
    if (!phraseTriggers.has(phrase)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    const data = phraseTriggers.get(phrase);
    
    if (funnelId !== undefined) {
        if (!funis.has(funnelId)) {
            return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        }
        data.funnelId = funnelId;
    }
    
    if (active !== undefined) {
        data.active = active;
    }
    
    phraseTriggers.set(phrase, data);
    addLog('PHRASE_UPDATED', `Frase atualizada: "${phrase}"`);
    savePhrasesToFile();
    
    res.json({ success: true, message: 'Frase atualizada com sucesso' });
});

app.delete('/api/phrases/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (phraseTriggers.has(phrase)) {
        phraseTriggers.delete(phrase);
        addLog('PHRASE_DELETED', `Frase excluída: "${phrase}"`);
        savePhrasesToFile();
        res.json({ success: true, message: 'Frase excluída com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
});

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
        transferredFromPix: conv.transferredFromPix || false,
        source: conv.source || 'kirvano' // 🆕 NOVO
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    const recentLogs = logs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        message: log.message
    }));
    
    res.json({ success: true, data: recentLogs });
});

app.get('/api/debug/evolution', async (req, res) => {
    const debugInfo = {
        evolution_base_url: EVOLUTION_BASE_URL,
        evolution_api_key_configured: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI',
        evolution_api_key_length: EVOLUTION_API_KEY !== 'SUA_API_KEY_AQUI' ? EVOLUTION_API_KEY.length : 0,
        instances: INSTANCES,
        active_conversations: conversations.size,
        sticky_instances_count: stickyInstances.size,
        pix_timeouts_active: pixTimeouts.size,
        webhook_locks_active: webhookLocks.size,
        phrase_triggers_count: phraseTriggers.size, // 🆕 NOVO
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/teste.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'teste.html'));
});

// ============ INICIALIZAÇÃO ============
async function initializeData() {
    console.log('🔄 Carregando dados...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadPhrasesFromFile(); // 🆕 NOVO
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('🔑 Frases:', phraseTriggers.size); // 🆕 NOVO
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO SYSTEM V5.0 - SISTEMA COMPLETO DE FUNIS');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('✅ NOVIDADES V5.0:');
    console.log('  1. ✅ Funis CS e FB (Kirvano webhook)');
    console.log('  2. ✅ Funis por Frase-Chave (anúncios diretos)');
    console.log('  3. ✅ Cooldown de 24h por frase+telefone');
    console.log('  4. ✅ Editor simplificado (5 blocos)');
    console.log('  5. ✅ Áudio PTT Base64 funcionando');
    console.log('  6. ✅ Sistema 100% unificado');
    console.log('  7. ✅ Detecção inteligente de frases (case-insensitive)');
    console.log('  8. ✅ Contador de acionamentos por frase');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /webhook/kirvano       - Eventos Kirvano');
    console.log('  POST /webhook/evolution     - Mensagens WhatsApp');
    console.log('  GET  /api/funnels           - Listar funis');
    console.log('  POST /api/funnels           - Criar/editar funil');
    console.log('  GET  /api/phrases           - Listar frases-chave');
    console.log('  POST /api/phrases           - Cadastrar frase');
    console.log('  PUT  /api/phrases/:phrase   - Editar frase');
    console.log('  DELETE /api/phrases/:phrase - Excluir frase');
    console.log('');
    console.log('🌐 Frontend: http://localhost:' + PORT);
    console.log('='.repeat(70));
    
    await initializeData();
});
