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
const LOGS_FILE = path.join(__dirname, 'data', 'logs.json');
const MANUAL_TRIGGERS_FILE = path.join(__dirname, 'data', 'manual_triggers.json');

// Produtos CS e FB
const PRODUCT_MAPPING = {
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FB'
};

// Códigos dos planos PerfectPay
const PERFECTPAY_PLANS = {
    'PPLQQMSFI': 'CS',
    'PPLQQMSFH': 'CS',
    'PPLQQM9AP': 'FB'
};

const INSTANCES = [
    'GABY01', 'GABY02', 'GABY03', 'GABY04', 'GABY05', 
    'GABY06', 'GABY07', 'GABY08', 'GABY09', 'GABY10', 
    'GABY11', 'GABY12', 'GABY13', 'GABY 14', 'GABY15'
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let conversations = new Map();
let phoneIndex = new Map();
let stickyInstances = new Map();
let pixTimeouts = new Map();
let webhookLocks = new Map();
let logs = [];
let funis = new Map();
let lastSuccessfulInstanceIndex = -1;
let phraseTriggers = new Map();
let phraseCooldowns = new Map();
let manualTriggers = new Map();
let manualTriggerCooldowns = new Map();

const LOG_LEVELS = {
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    CRITICAL: 'CRITICAL'
};

// ============ FUNIS PADRÃO ============
const defaultFunnels = {
    'CS_APROVADA': { id: 'CS_APROVADA', name: 'CS - Compra Aprovada', steps: [] },
    'CS_PIX': { id: 'CS_PIX', name: 'CS - PIX Pendente', steps: [] },
    'FB_APROVADA': { id: 'FB_APROVADA', name: 'FB - Compra Aprovada', steps: [] },
    'FB_PIX': { id: 'FB_PIX', name: 'FB - PIX Pendente', steps: [] }
};

// ============ SISTEMA DE LOGS MELHORADO ============
function addLog(type, message, data = null, level = LOG_LEVELS.INFO) {
    const log = {
        id: Date.now() + Math.random(),
        timestamp: new Date().toISOString(),
        type,
        level,
        message,
        data: data ? JSON.stringify(data) : null,
        stack: level === LOG_LEVELS.ERROR || level === LOG_LEVELS.CRITICAL ? new Error().stack : null
    };
    
    logs.unshift(log);
    if (logs.length > 5000) logs = logs.slice(0, 5000);
    
    const emoji = {
        [LOG_LEVELS.DEBUG]: '🔍',
        [LOG_LEVELS.INFO]: 'ℹ️',
        [LOG_LEVELS.WARNING]: '⚠️',
        [LOG_LEVELS.ERROR]: '❌',
        [LOG_LEVELS.CRITICAL]: '🔥'
    };
    
    console.log(`[${log.timestamp}] ${emoji[level] || ''} ${type}: ${message}`);
    if (data) console.log('  Data:', data);
}

async function saveLogsToFile() {
    try {
        await ensureDataDir();
        const recentLogs = logs.slice(0, 1000);
        await fs.writeFile(LOGS_FILE, JSON.stringify(recentLogs, null, 2));
    } catch (error) {
        console.error('Erro ao salvar logs:', error.message);
    }
}

async function loadLogsFromFile() {
    try {
        const data = await fs.readFile(LOGS_FILE, 'utf8');
        logs = JSON.parse(data);
        addLog('LOGS_LOADED', `Logs carregados: ${logs.length}`, null, LOG_LEVELS.INFO);
    } catch (error) {
        addLog('LOGS_LOAD_ERROR', 'Sem logs anteriores', null, LOG_LEVELS.DEBUG);
    }
}

// ============ SISTEMA DE LOCK COM VALIDAÇÕES ============
async function acquireWebhookLock(phoneKey, timeout = 10000) {
    const startTime = Date.now();
    let attempts = 0;
    
    while (webhookLocks.get(phoneKey)) {
        attempts++;
        if (Date.now() - startTime > timeout) {
            addLog('WEBHOOK_LOCK_TIMEOUT', `Timeout após ${attempts} tentativas`, 
                { phoneKey, waitTime: timeout }, LOG_LEVELS.WARNING);
            return false;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    webhookLocks.set(phoneKey, { 
        acquired: Date.now(), 
        stack: new Error().stack 
    });
    
    addLog('WEBHOOK_LOCK_ACQUIRED', `Lock adquirido (tentativas: ${attempts})`, 
        { phoneKey }, LOG_LEVELS.DEBUG);
    return true;
}

function releaseWebhookLock(phoneKey) {
    const lock = webhookLocks.get(phoneKey);
    webhookLocks.delete(phoneKey);
    
    if (lock) {
        const duration = Date.now() - lock.acquired;
        addLog('WEBHOOK_LOCK_RELEASED', `Lock liberado após ${duration}ms`, 
            { phoneKey, duration }, LOG_LEVELS.DEBUG);
    }
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
        addLog('DATA_SAVE', `Funis salvos: ${funnelsArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
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
        addLog('DATA_LOAD', `Funis carregados: ${funis.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Usando funis padrão', null, LOG_LEVELS.WARNING);
        return false;
    }
}

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
        addLog('PHRASES_SAVE', `Frases salvas: ${phrasesArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('PHRASES_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
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
        addLog('PHRASES_LOAD', `Frases carregadas: ${phraseTriggers.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('PHRASES_LOAD_ERROR', 'Nenhuma frase cadastrada', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

async function saveManualTriggersToFile() {
    try {
        await ensureDataDir();
        const triggersArray = Array.from(manualTriggers.entries()).map(([phrase, data]) => ({
            phrase,
            funnelId: data.funnelId,
            active: data.active,
            triggerCount: data.triggerCount
        }));
        await fs.writeFile(MANUAL_TRIGGERS_FILE, JSON.stringify(triggersArray, null, 2));
        addLog('MANUAL_TRIGGERS_SAVE', `Frases manuais salvas: ${triggersArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('MANUAL_TRIGGERS_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
    }
}

async function loadManualTriggersFromFile() {
    try {
        const data = await fs.readFile(MANUAL_TRIGGERS_FILE, 'utf8');
        const triggersArray = JSON.parse(data);
        manualTriggers.clear();
        triggersArray.forEach(item => {
            manualTriggers.set(item.phrase, {
                funnelId: item.funnelId,
                active: item.active !== false,
                triggerCount: item.triggerCount || 0
            });
        });
        addLog('MANUAL_TRIGGERS_LOAD', `Frases manuais carregadas: ${manualTriggers.size}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('MANUAL_TRIGGERS_LOAD_ERROR', 'Nenhuma frase manual cadastrada', null, LOG_LEVELS.DEBUG);
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
        
        addLog('DATA_SAVE', `Conversas salvas: ${conversationsArray.length}`, null, LOG_LEVELS.DEBUG);
    } catch (error) {
        addLog('DATA_SAVE_ERROR', `Erro: ${error.message}`, null, LOG_LEVELS.ERROR);
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
        addLog('DATA_LOAD', `Conversas carregadas: ${parsed.conversations.length}`, null, LOG_LEVELS.INFO);
        return true;
    } catch (error) {
        addLog('DATA_LOAD_ERROR', 'Nenhuma conversa anterior', null, LOG_LEVELS.DEBUG);
        return false;
    }
}

setInterval(async () => {
    await saveFunnelsToFile();
    await saveConversationsToFile();
    await savePhrasesToFile();
    await saveManualTriggersToFile();
    await saveLogsToFile();
}, 30000);

Object.values(defaultFunnels).forEach(funnel => funis.set(funnel.id, funnel));

app.use(express.json());
app.use(express.static('public'));

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

function validateConversationState(conversation, phoneKey) {
    const issues = [];
    
    if (!conversation.funnelId) {
        issues.push('Sem funnelId');
    }
    
    if (conversation.stepIndex < 0 && !conversation.pixWaiting) {
        issues.push('StepIndex negativo sem PIX waiting');
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        issues.push('Funil não encontrado: ' + conversation.funnelId);
    } else if (conversation.stepIndex >= funnel.steps.length) {
        issues.push('StepIndex maior que steps do funil');
    }
    
    if (issues.length > 0) {
        addLog('CONVERSATION_VALIDATION_FAILED', issues.join(', '), 
            { phoneKey, conversation }, LOG_LEVELS.ERROR);
        return false;
    }
    
    return true;
}

function checkPhraseTrigger(phoneKey, messageText) {
    const normalizedMessage = messageText.toLowerCase().trim();
    
    addLog('PHRASE_CHECK_START', `Mensagem normalizada: "${normalizedMessage}"`, 
        { phoneKey, original: messageText }, LOG_LEVELS.DEBUG);
    
    for (const [phrase, data] of phraseTriggers.entries()) {
        if (!data.active) {
            continue;
        }
        
        const normalizedPhrase = phrase.toLowerCase().trim();
        
        if (normalizedMessage.includes(normalizedPhrase)) {
            const cooldownKey = `${phoneKey}:${phrase}`;
            const lastTrigger = phraseCooldowns.get(cooldownKey);
            
            if (lastTrigger && (Date.now() - lastTrigger) < PHRASE_COOLDOWN) {
                const remainingTime = Math.ceil((PHRASE_COOLDOWN - (Date.now() - lastTrigger)) / (60 * 60 * 1000));
                addLog('PHRASE_COOLDOWN', `Cooldown ativo (${remainingTime}h restantes)`, 
                    { phoneKey, phrase }, LOG_LEVELS.WARNING);
                return null;
            }
            
            addLog('PHRASE_TRIGGERED', `Frase detectada: "${phrase}"`, 
                { phoneKey, funnelId: data.funnelId, messageReceived: normalizedMessage }, LOG_LEVELS.INFO);
            
            phraseCooldowns.set(cooldownKey, Date.now());
            data.triggerCount = (data.triggerCount || 0) + 1;
            phraseTriggers.set(phrase, data);
            savePhrasesToFile();
            
            return data.funnelId;
        }
    }
    
    addLog('PHRASE_NOT_FOUND', `Nenhuma frase correspondente`, 
        { phoneKey, message: normalizedMessage }, LOG_LEVELS.DEBUG);
    return null;
}

function checkManualTrigger(messageText, phoneKey) {
    const normalizedMessage = messageText.toLowerCase().trim();
    
    addLog('MANUAL_TRIGGER_CHECK', `Verificando frase manual: "${normalizedMessage}"`, 
        { original: messageText }, LOG_LEVELS.DEBUG);
    
    for (const [phrase, data] of manualTriggers.entries()) {
        if (!data.active) {
            continue;
        }
        
        const normalizedPhrase = phrase.toLowerCase().trim();
        
        if (normalizedMessage.includes(normalizedPhrase)) {
            // Verificar cooldown de 30 segundos para evitar disparos múltiplos
            const cooldownKey = `${phoneKey}:${phrase}`;
            const lastTrigger = manualTriggerCooldowns.get(cooldownKey);
            const cooldownTime = 30000; // 30 segundos
            
            if (lastTrigger && (Date.now() - lastTrigger) < cooldownTime) {
                const remainingSeconds = Math.ceil((cooldownTime - (Date.now() - lastTrigger)) / 1000);
                addLog('MANUAL_TRIGGER_COOLDOWN', `Cooldown ativo (${remainingSeconds}s restantes)`, 
                    { phoneKey, phrase }, LOG_LEVELS.WARNING);
                return null;
            }
            
            addLog('MANUAL_TRIGGER_DETECTED', `Frase manual detectada: "${phrase}"`, 
                { funnelId: data.funnelId }, LOG_LEVELS.INFO);
            
            // Registrar o disparo e atualizar cooldown
            manualTriggerCooldowns.set(cooldownKey, Date.now());
            data.triggerCount = (data.triggerCount || 0) + 1;
            manualTriggers.set(phrase, data);
            saveManualTriggersToFile();
            
            return data.funnelId;
        }
    }
    
    addLog('MANUAL_TRIGGER_NOT_FOUND', `Nenhuma frase manual correspondente`, 
        { message: normalizedMessage }, LOG_LEVELS.DEBUG);
    return null;
}

async function sendToEvolution(instanceName, endpoint, payload) {
    const url = EVOLUTION_BASE_URL + endpoint + '/' + instanceName;
    
    addLog('EVOLUTION_REQUEST', `${endpoint} via ${instanceName}`, 
        { url, payload }, LOG_LEVELS.DEBUG);
    
    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json',
                'apikey': EVOLUTION_API_KEY
            },
            timeout: 15000
        });
        
        addLog('EVOLUTION_RESPONSE_OK', `Status ${response.status}`, 
            { instanceName, endpoint }, LOG_LEVELS.DEBUG);
        
        return { ok: true, data: response.data };
    } catch (error) {
        addLog('EVOLUTION_REQUEST_FAILED', error.message, 
            { instanceName, endpoint, status: error.response?.status, 
              errorData: error.response?.data }, LOG_LEVELS.ERROR);
        
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
        addLog('AUDIO_DOWNLOAD_START', `Baixando de ${audioUrl}`, null, LOG_LEVELS.DEBUG);
        
        const audioResponse = await axios.get(audioUrl, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const base64Audio = Buffer.from(audioResponse.data, 'binary').toString('base64');
        const audioBase64 = `data:audio/mpeg;base64,${base64Audio}`;
        
        addLog('AUDIO_CONVERTED', `Base64 criado (${Math.round(base64Audio.length / 1024)}KB)`, 
            null, LOG_LEVELS.DEBUG);
        
        const result = await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioBase64,
            delay: 1200,
            encoding: true
        });
        
        if (result.ok) {
            addLog('AUDIO_SENT_PTT', 'Áudio enviado como PTT', null, LOG_LEVELS.DEBUG);
            return result;
        }
        
        addLog('AUDIO_FALLBACK_MEDIA', 'Tentando formato alternativo', null, LOG_LEVELS.WARNING);
        return await sendToEvolution(instanceName, '/message/sendMedia', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            mediatype: 'audio',
            media: audioBase64,
            mimetype: 'audio/mpeg'
        });
    } catch (error) {
        addLog('AUDIO_ERROR', error.message, { audioUrl }, LOG_LEVELS.ERROR);
        addLog('AUDIO_FALLBACK_URL', 'Usando URL direta', null, LOG_LEVELS.WARNING);
        
        return await sendToEvolution(instanceName, '/message/sendWhatsAppAudio', {
            number: remoteJid.replace('@s.whatsapp.net', ''),
            audio: audioUrl,
            delay: 1200
        });
    }
}

async function sendWithFallback(phoneKey, remoteJid, type, text, mediaUrl, isFirstMessage = false) {
    let instancesToTry = [...INSTANCES];
    const stickyInstance = stickyInstances.get(phoneKey);
    
    if (stickyInstance) {
        instancesToTry = [stickyInstance, ...INSTANCES.filter(i => i !== stickyInstance)];
        addLog('SEND_USING_STICKY', `Sticky instance: ${stickyInstance}`, 
            { phoneKey, isFirstMessage }, LOG_LEVELS.DEBUG);
    } else if (isFirstMessage) {
        const nextIndex = (lastSuccessfulInstanceIndex + 1) % INSTANCES.length;
        instancesToTry = [...INSTANCES.slice(nextIndex), ...INSTANCES.slice(0, nextIndex)];
        addLog('SEND_USING_ROTATION', `Próxima: ${instancesToTry[0]}`, 
            { phoneKey, nextIndex }, LOG_LEVELS.DEBUG);
    }
    
    let lastError = null;
    const maxAttempts = 3;
    
    for (const instanceName of instancesToTry) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                let result;
                
                if (type === 'text') {
                    result = await sendText(remoteJid, text, instanceName);
                } else if (type === 'image') {
                    result = await sendImage(remoteJid, mediaUrl, text || '', instanceName);
                } else if (type === 'video') {
                    result = await sendVideo(remoteJid, mediaUrl, text || '', instanceName);
                } else if (type === 'audio') {
                    result = await sendAudio(remoteJid, mediaUrl, instanceName);
                }
                
                if (result && result.ok) {
                    stickyInstances.set(phoneKey, instanceName);
                    if (isFirstMessage && !stickyInstance) {
                        lastSuccessfulInstanceIndex = INSTANCES.indexOf(instanceName);
                    }
                    
                    addLog('SEND_SUCCESS', `Mensagem ${type} enviada`, 
                        { phoneKey, instanceName, attempt }, LOG_LEVELS.INFO);
                    
                    return { success: true, instanceName };
                }
                
                lastError = result.error;
                addLog('SEND_ATTEMPT_FAILED', `Tentativa ${attempt}/${maxAttempts}`, 
                    { phoneKey, instanceName, error: lastError }, LOG_LEVELS.WARNING);
                
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            } catch (error) {
                lastError = error.message;
                addLog('SEND_EXCEPTION', error.message, 
                    { phoneKey, instanceName, attempt, stack: error.stack }, LOG_LEVELS.ERROR);
                
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }
    }
    
    addLog('SEND_ALL_FAILED', 'Todas instâncias falharam', 
        { phoneKey, lastError, triedInstances: instancesToTry.length }, LOG_LEVELS.CRITICAL);
    
    const conversation = conversations.get(phoneKey);
    if (conversation) {
        conversation.hasError = true;
        conversation.errorMessage = lastError;
        conversations.set(phoneKey, conversation);
    }
    
    return { success: false, error: lastError };
}

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
        source: 'kirvano'
    };
    
    conversations.set(phoneKey, conversation);
    addLog('PIX_WAITING_CREATED', `PIX em espera`, 
        { phoneKey, orderCode, productType }, LOG_LEVELS.INFO);
    
    const timeout = setTimeout(async () => {
        const conv = conversations.get(phoneKey);
        if (conv && conv.orderCode === orderCode && !conv.canceled && conv.pixWaiting) {
            addLog('PIX_TIMEOUT_TRIGGERED', 'Timeout disparado', 
                { phoneKey, orderCode }, LOG_LEVELS.INFO);
            
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
        addLog('PIX_TIMEOUT_CANCELED', 'Timeout cancelado', 
            { phoneKey, orderCode }, LOG_LEVELS.INFO);
    }
    
    let startingStep = 0;
    
    if (pixConv && pixConv.stepIndex >= 0) {
        startingStep = 3;
        addLog('TRANSFER_SKIP_SIMILAR', 'Cliente interagiu, começando passo 3', 
            { phoneKey }, LOG_LEVELS.INFO);
    } else {
        addLog('TRANSFER_FROM_BEGINNING', 'Cliente não interagiu, começando do início', 
            { phoneKey }, LOG_LEVELS.INFO);
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
        source: 'kirvano'
    };
    
    conversations.set(phoneKey, approvedConv);
    addLog('TRANSFER_PIX_TO_APPROVED', 'Transferido para funil aprovado', 
        { phoneKey, startingStep, productType }, LOG_LEVELS.INFO);
    
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
        source
    };
    
    conversations.set(phoneKey, conversation);
    addLog('FUNNEL_START', `Iniciando funil ${funnelId}`, 
        { phoneKey, orderCode, source }, LOG_LEVELS.INFO);
    
    await sendStep(phoneKey);
}

async function sendStep(phoneKey) {
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        addLog('STEP_NO_CONVERSATION', 'Conversa não encontrada', 
            { phoneKey }, LOG_LEVELS.ERROR);
        return;
    }
    
    if (!validateConversationState(conversation, phoneKey)) {
        addLog('STEP_INVALID_STATE', 'Estado inválido detectado', 
            { phoneKey, conversation }, LOG_LEVELS.ERROR);
        return;
    }
    
    if (conversation.canceled) {
        addLog('STEP_CANCELED', 'Conversa cancelada', 
            { phoneKey }, LOG_LEVELS.WARNING);
        return;
    }
    
    if (conversation.pixWaiting) {
        addLog('STEP_PIX_WAITING', 'Aguardando timeout PIX', 
            { phoneKey }, LOG_LEVELS.DEBUG);
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('STEP_FUNNEL_NOT_FOUND', `Funil ${conversation.funnelId} não existe`, 
            { phoneKey }, LOG_LEVELS.ERROR);
        return;
    }
    
    const step = funnel.steps[conversation.stepIndex];
    if (!step) {
        addLog('STEP_NOT_FOUND', `Passo ${conversation.stepIndex} não existe`, 
            { phoneKey, totalSteps: funnel.steps.length }, LOG_LEVELS.ERROR);
        return;
    }
    
    const isFirstMessage = conversation.stepIndex === 0 && !conversation.lastSystemMessage;
    
    addLog('STEP_SEND_START', `Enviando passo ${conversation.stepIndex}/${funnel.steps.length - 1}`, 
        { phoneKey, funnelId: conversation.funnelId, stepType: step.type, 
          waitForReply: step.waitForReply }, LOG_LEVELS.INFO);
    
    let result = { success: true };
    
    if (step.delayBefore && step.delayBefore > 0) {
        const delaySeconds = parseInt(step.delayBefore);
        addLog('STEP_DELAY_BEFORE', `Aguardando ${delaySeconds}s`, 
            { phoneKey }, LOG_LEVELS.DEBUG);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    }
    
    if (step.showTyping && step.type !== 'delay') {
        addLog('STEP_SHOW_TYPING', 'Mostrando digitando por 3s', 
            { phoneKey }, LOG_LEVELS.DEBUG);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    if (step.type === 'delay') {
        const delaySeconds = step.delaySeconds || 10;
        addLog('STEP_DELAY', `Delay de ${delaySeconds}s`, 
            { phoneKey }, LOG_LEVELS.DEBUG);
        await new Promise(resolve => setTimeout(resolve, delaySeconds * 1000));
    } else {
        result = await sendWithFallback(
            phoneKey, 
            conversation.remoteJid, 
            step.type, 
            step.text, 
            step.mediaUrl, 
            isFirstMessage
        );
    }
    
    if (result.success) {
        conversation.lastSystemMessage = new Date();
        
        if (step.waitForReply && step.type !== 'delay') {
            conversation.waiting_for_response = true;
            conversations.set(phoneKey, conversation);
            
            addLog('STEP_WAITING_REPLY', `Aguardando resposta do cliente`, 
                { phoneKey, stepIndex: conversation.stepIndex }, LOG_LEVELS.INFO);
        } else {
            conversations.set(phoneKey, conversation);
            
            addLog('STEP_AUTO_ADVANCE', 'Avançando automaticamente', 
                { phoneKey, currentStep: conversation.stepIndex }, LOG_LEVELS.DEBUG);
            
            await advanceConversation(phoneKey, null, 'auto');
        }
    } else {
        addLog('STEP_FAILED', 'Falha no envio', 
            { phoneKey, error: result.error, stepIndex: conversation.stepIndex }, 
            LOG_LEVELS.ERROR);
    }
}

async function advanceConversation(phoneKey, replyText, reason) {
    const conversation = conversations.get(phoneKey);
    
    if (!conversation) {
        addLog('ADVANCE_NO_CONVERSATION', 'Conversa não encontrada', 
            { phoneKey }, LOG_LEVELS.ERROR);
        return;
    }
    
    if (conversation.canceled) {
        addLog('ADVANCE_CANCELED', 'Conversa foi cancelada', 
            { phoneKey }, LOG_LEVELS.WARNING);
        return;
    }
    
    const funnel = funis.get(conversation.funnelId);
    if (!funnel) {
        addLog('ADVANCE_FUNNEL_NOT_FOUND', `Funil ${conversation.funnelId} não existe`, 
            { phoneKey }, LOG_LEVELS.ERROR);
        return;
    }
    
    const nextStepIndex = conversation.stepIndex + 1;
    
    if (nextStepIndex >= funnel.steps.length) {
        addLog('FUNNEL_END', `Funil ${conversation.funnelId} concluído`, 
            { phoneKey, totalSteps: funnel.steps.length }, LOG_LEVELS.INFO);
        
        conversation.waiting_for_response = false;
        conversation.completed = true;
        conversation.completedAt = new Date();
        conversations.set(phoneKey, conversation);
        return;
    }
    
    const previousStep = conversation.stepIndex;
    conversation.stepIndex = nextStepIndex;
    conversation.waiting_for_response = false;
    
    if (reason === 'reply') {
        conversation.lastReply = new Date();
    }
    
    conversations.set(phoneKey, conversation);
    
    addLog('STEP_ADVANCE', `${previousStep} → ${nextStepIndex}`, 
        { phoneKey, reason, totalSteps: funnel.steps.length }, LOG_LEVELS.INFO);
    
    await sendStep(phoneKey);
}

app.post('/webhook/kirvano', async (req, res) => {
    const requestId = Date.now() + Math.random();
    
    try {
        const data = req.body;
        
        addLog('KIRVANO_WEBHOOK_RECEIVED', 'Webhook Kirvano recebido', 
            { requestId, body: data }, LOG_LEVELS.INFO);
        
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
            addLog('KIRVANO_INVALID_PHONE', 'Telefone inválido', 
                { requestId, phone: customerPhone }, LOG_LEVELS.WARNING);
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
        
        addLog('KIRVANO_EVENT', `${event} - ${customerName}`, 
            { requestId, orderCode, phoneKey, method, productType }, LOG_LEVELS.INFO);
        
        const isApproved = event.includes('APPROVED') || event.includes('PAID') || status === 'APPROVED';
        const isPix = method.includes('PIX') || event.includes('PIX');
        
        if (isApproved) {
            const existingConv = conversations.get(phoneKey);
            const isPixFunnel = existingConv && (existingConv.funnelId === 'CS_PIX' || existingConv.funnelId === 'FB_PIX');
            
            if (isPixFunnel) {
                addLog('KIRVANO_PIX_TO_APPROVED', 'Cliente pagou PIX', 
                    { requestId, phoneKey, orderCode, productType }, LOG_LEVELS.INFO);
                await transferPixToApproved(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
            } else {
                addLog('KIRVANO_DIRECT_APPROVED', 'Pagamento aprovado direto', 
                    { requestId, phoneKey, orderCode, productType }, LOG_LEVELS.INFO);
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                const funnelId = productType === 'CS' ? 'CS_APROVADA' : 'FB_APROVADA';
                await startFunnel(phoneKey, remoteJid, funnelId, orderCode, customerName, productType, totalPrice, 'kirvano');
            }
        } else if (isPix && event.includes('GENERATED')) {
            addLog('KIRVANO_PIX_GENERATED', 'PIX gerado', 
                { requestId, phoneKey, orderCode, productType }, LOG_LEVELS.INFO);
            
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                addLog('KIRVANO_PIX_DUPLICATE', 'Conversa já existe', 
                    { requestId, phoneKey }, LOG_LEVELS.WARNING);
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            await createPixWaitingConversation(phoneKey, remoteJid, orderCode, customerName, productType, totalPrice);
        }
        
        res.json({ success: true, phoneKey, productType, requestId });
        
    } catch (error) {
        addLog('KIRVANO_ERROR', error.message, 
            { requestId, stack: error.stack }, LOG_LEVELS.CRITICAL);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/perfect', async (req, res) => {
    const requestId = Date.now() + Math.random();
    
    try {
        const data = req.body;
        
        addLog('PERFECTPAY_WEBHOOK_RECEIVED', 'Webhook PerfectPay recebido', 
            { requestId, body: data }, LOG_LEVELS.INFO);
        
        const planCode = data.plan?.code;
        const saleStatus = data.sale_status_enum_key;
        const saleCode = data.code || 'ORDER_' + Date.now();
        const customerName = data.customer?.full_name || 'Cliente';
        const phoneArea = data.customer?.phone_area_code || '';
        const phoneNumber = data.customer?.phone_number || '';
        const totalPrice = data.sale_amount ? `R$ ${data.sale_amount.toFixed(2)}` : 'R$ 0,00';
        
        if (!planCode || !PERFECTPAY_PLANS[planCode]) {
            addLog('PERFECTPAY_INVALID_PLAN', 'Plano não mapeado', 
                { requestId, planCode }, LOG_LEVELS.WARNING);
            return res.json({ success: false, message: 'Plano não configurado' });
        }
        
        const productType = PERFECTPAY_PLANS[planCode];
        const fullPhone = phoneArea + phoneNumber;
        const phoneKey = extractPhoneKey(fullPhone);
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('PERFECTPAY_INVALID_PHONE', 'Telefone inválido', 
                { requestId, phone: fullPhone }, LOG_LEVELS.WARNING);
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        const remoteJid = phoneToRemoteJid(fullPhone);
        registerPhone(fullPhone, phoneKey);
        
        addLog('PERFECTPAY_EVENT', `${saleStatus} - ${customerName}`, 
            { requestId, saleCode, phoneKey, planCode, productType }, LOG_LEVELS.INFO);
        
        if (saleStatus === 'approved') {
            const existingConv = conversations.get(phoneKey);
            const isPixFunnel = existingConv && (existingConv.funnelId === 'CS_PIX' || existingConv.funnelId === 'FB_PIX');
            
            if (isPixFunnel) {
                addLog('PERFECTPAY_PIX_TO_APPROVED', 'Cliente pagou PIX', 
                    { requestId, phoneKey, saleCode, productType }, LOG_LEVELS.INFO);
                await transferPixToApproved(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
            } else {
                addLog('PERFECTPAY_DIRECT_APPROVED', 'Pagamento aprovado direto', 
                    { requestId, phoneKey, saleCode, productType }, LOG_LEVELS.INFO);
                
                const pixTimeout = pixTimeouts.get(phoneKey);
                if (pixTimeout) {
                    clearTimeout(pixTimeout.timeout);
                    pixTimeouts.delete(phoneKey);
                }
                
                const funnelId = productType === 'CS' ? 'CS_APROVADA' : 'FB_APROVADA';
                await startFunnel(phoneKey, remoteJid, funnelId, saleCode, customerName, productType, totalPrice, 'perfectpay');
            }
        } else if (saleStatus === 'pending') {
            addLog('PERFECTPAY_PIX_PENDING', 'PIX pendente', 
                { requestId, phoneKey, saleCode, productType }, LOG_LEVELS.INFO);
            
            const existingConv = conversations.get(phoneKey);
            if (existingConv && !existingConv.canceled) {
                addLog('PERFECTPAY_PIX_DUPLICATE', 'Conversa já existe', 
                    { requestId, phoneKey }, LOG_LEVELS.WARNING);
                return res.json({ success: true, message: 'Conversa já existe' });
            }
            
            await createPixWaitingConversation(phoneKey, remoteJid, saleCode, customerName, productType, totalPrice);
        }
        
        res.json({ success: true, phoneKey, productType, requestId });
        
    } catch (error) {
        addLog('PERFECTPAY_ERROR', error.message, 
            { requestId, stack: error.stack }, LOG_LEVELS.CRITICAL);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/webhook/evolution', async (req, res) => {
    const requestId = Date.now() + Math.random();
    
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            addLog('EVOLUTION_NO_MESSAGE', 'Webhook sem dados', 
                { requestId }, LOG_LEVELS.DEBUG);
            return res.json({ success: true });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        const instanceName = data.instance || null;
        
        const incomingPhone = remoteJid.replace('@s.whatsapp.net', '');
        const phoneKey = extractPhoneKey(incomingPhone);
        
        addLog('EVOLUTION_MESSAGE_RECEIVED', `"${messageText.substring(0, 50)}"`, 
            { requestId, phoneKey, instanceName, fromMe }, LOG_LEVELS.INFO);
        
        if (!phoneKey || phoneKey.length !== 8) {
            addLog('EVOLUTION_INVALID_PHONE', 'PhoneKey inválido', 
                { requestId, phone: incomingPhone }, LOG_LEVELS.WARNING);
            return res.json({ success: true });
        }
        
        if (fromMe) {
            addLog('EVOLUTION_FROM_ME', 'Mensagem enviada por você', 
                { requestId, phoneKey, messageText }, LOG_LEVELS.DEBUG);
            
            const triggeredFunnelId = checkManualTrigger(messageText, phoneKey);
            
            if (triggeredFunnelId) {
                const funnel = funis.get(triggeredFunnelId);
                
                if (funnel && funnel.steps && funnel.steps.length > 0) {
                    const existingConversation = conversations.get(phoneKey);
                    
                    if (existingConversation && !existingConversation.completed && !existingConversation.canceled) {
                        addLog('MANUAL_TRIGGER_CANCEL_EXISTING', `Cancelando funil atual: ${existingConversation.funnelId}`, 
                            { requestId, phoneKey, oldFunnel: existingConversation.funnelId, newFunnel: triggeredFunnelId }, 
                            LOG_LEVELS.WARNING);
                        
                        existingConversation.canceled = true;
                        existingConversation.waiting_for_response = false;
                        conversations.set(phoneKey, existingConversation);
                        
                        if (pixTimeouts.has(phoneKey)) {
                            clearTimeout(pixTimeouts.get(phoneKey));
                            pixTimeouts.delete(phoneKey);
                            addLog('PIX_TIMEOUT_CLEARED', 'Timeout PIX cancelado', 
                                { phoneKey }, LOG_LEVELS.DEBUG);
                        }
                    }
                    
                    // CRÍTICO: Setar sticky instance ANTES de iniciar o funil
                    if (instanceName && INSTANCES.includes(instanceName)) {
                        stickyInstances.set(phoneKey, instanceName);
                        addLog('STICKY_INSTANCE_SET_MANUAL', `Sticky fixada em: ${instanceName}`, 
                            { requestId, phoneKey }, LOG_LEVELS.INFO);
                    } else if (instanceName) {
                        addLog('STICKY_INSTANCE_NOT_SET', `Instância não encontrada: "${instanceName}"`, 
                            { requestId, phoneKey, availableInstances: INSTANCES }, LOG_LEVELS.WARNING);
                    }
                    
                    addLog('MANUAL_TRIGGER_FUNNEL_START', `Disparando funil ${triggeredFunnelId}`, 
                        { requestId, phoneKey, instanceName, phrase: messageText }, LOG_LEVELS.INFO);
                    
                    await startFunnel(
                        phoneKey, 
                        remoteJid, 
                        triggeredFunnelId, 
                        'MANUAL_' + Date.now(), 
                        'Cliente', 
                        'MANUAL', 
                        '', 
                        'manual'
                    );
                    
                    return res.json({ success: true, manualTrigger: true });
                } else {
                    addLog('MANUAL_TRIGGER_FUNNEL_EMPTY', `Funil ${triggeredFunnelId} vazio`, 
                        { requestId, phoneKey }, LOG_LEVELS.ERROR);
                    return res.json({ success: false, error: 'Funil vazio' });
                }
            }
            
            return res.json({ success: true });
        }
        
        const hasLock = await acquireWebhookLock(phoneKey);
        if (!hasLock) {
            addLog('EVOLUTION_LOCK_TIMEOUT', 'Não conseguiu lock', 
                { requestId, phoneKey }, LOG_LEVELS.ERROR);
            return res.json({ success: false, message: 'Lock timeout' });
        }
        
        try {
            const conversation = findConversationByPhone(incomingPhone);
            
            if (!conversation || conversation.completed || conversation.canceled) {
                addLog('EVOLUTION_CHECK_PHRASE', 'Verificando frases-chave', 
                    { requestId, phoneKey, message: messageText }, LOG_LEVELS.DEBUG);
                
                const triggeredFunnelId = checkPhraseTrigger(phoneKey, messageText);
                
                if (triggeredFunnelId) {
                    const funnel = funis.get(triggeredFunnelId);
                    
                    if (funnel && funnel.steps && funnel.steps.length > 0) {
                        // CRÍTICO: Setar sticky instance ANTES de iniciar o funil
                        if (instanceName && INSTANCES.includes(instanceName)) {
                            stickyInstances.set(phoneKey, instanceName);
                            addLog('STICKY_INSTANCE_SET_PHRASE', `Sticky fixada em: ${instanceName}`, 
                                { requestId, phoneKey }, LOG_LEVELS.INFO);
                        } else if (instanceName) {
                            addLog('STICKY_INSTANCE_NOT_SET_PHRASE', `Instância não encontrada: "${instanceName}"`, 
                                { requestId, phoneKey, availableInstances: INSTANCES }, LOG_LEVELS.WARNING);
                        }
                        
                        addLog('PHRASE_FUNNEL_START', `Iniciando funil ${triggeredFunnelId}`, 
                            { requestId, phoneKey, instanceName }, LOG_LEVELS.INFO);
                        
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
                        addLog('PHRASE_FUNNEL_EMPTY', `Funil ${triggeredFunnelId} vazio`, 
                            { requestId, phoneKey }, LOG_LEVELS.ERROR);
                    }
                }
            }
            
            if (!conversation || conversation.canceled || !conversation.waiting_for_response) {
                addLog('EVOLUTION_NOT_WAITING', 'Não aguardando resposta', 
                    { requestId, phoneKey, hasConv: !!conversation, 
                      canceled: conversation?.canceled, 
                      waiting: conversation?.waiting_for_response }, LOG_LEVELS.DEBUG);
                return res.json({ success: true });
            }
            
            addLog('CLIENT_REPLY', `Cliente respondeu`, 
                { requestId, phoneKey, text: messageText.substring(0, 100), 
                  stepIndex: conversation.stepIndex }, LOG_LEVELS.INFO);
            
            conversation.waiting_for_response = false;
            conversation.lastReply = new Date();
            conversations.set(phoneKey, conversation);
            
            await advanceConversation(phoneKey, messageText, 'reply');
            
            res.json({ success: true });
            
        } finally {
            releaseWebhookLock(phoneKey);
        }
        
    } catch (error) {
        addLog('EVOLUTION_ERROR', error.message, 
            { requestId, stack: error.stack }, LOG_LEVELS.CRITICAL);
        releaseWebhookLock(extractPhoneKey(req.body?.data?.key?.remoteJid || ''));
        res.status(500).json({ success: false, error: error.message });
    }
});

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
            total_phrases: phraseTriggers.size,
            total_instances: INSTANCES.length,
            sticky_instances: stickyInstances.size,
            instance_distribution: instanceUsage,
            webhook_locks: webhookLocks.size,
            total_logs: logs.length
        }
    });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const level = req.query.level;
    const type = req.query.type;
    const phoneKey = req.query.phoneKey;
    
    let filteredLogs = logs;
    
    if (level) {
        filteredLogs = filteredLogs.filter(log => log.level === level);
    }
    
    if (type) {
        filteredLogs = filteredLogs.filter(log => log.type.includes(type));
    }
    
    if (phoneKey) {
        filteredLogs = filteredLogs.filter(log => 
            log.data && log.data.includes(phoneKey)
        );
    }
    
    const recentLogs = filteredLogs.slice(0, limit).map(log => ({
        id: log.id,
        timestamp: log.timestamp,
        type: log.type,
        level: log.level,
        message: log.message,
        data: log.data
    }));
    
    res.json({ 
        success: true, 
        data: recentLogs,
        total: filteredLogs.length,
        filters: { level, type, phoneKey, limit }
    });
});

app.get('/api/logs/export', (req, res) => {
    const format = req.query.format || 'json';
    const filename = `kirvano-logs-${new Date().toISOString().split('T')[0]}`;
    
    if (format === 'json') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
        res.send(JSON.stringify(logs, null, 2));
    } else if (format === 'txt') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.txt"`);
        const txtContent = logs.map(log => 
            `[${log.timestamp}] [${log.level}] ${log.type}: ${log.message}${log.data ? '\n  Data: ' + log.data : ''}`
        ).join('\n\n');
        res.send(txtContent);
    } else {
        res.status(400).json({ success: false, error: 'Formato inválido' });
    }
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
    
    if (!funnel.id.startsWith('CS_') && !funnel.id.startsWith('FB_') && !funnel.id.startsWith('PHRASE_')) {
        return res.status(400).json({ success: false, error: 'Apenas funis CS, FB e PHRASE permitidos' });
    }
    
    funis.set(funnel.id, funnel);
    addLog('FUNNEL_SAVED', `Funil ${funnel.id} salvo`, 
        { funnelId: funnel.id, steps: funnel.steps.length }, LOG_LEVELS.INFO);
    saveFunnelsToFile();
    
    res.json({ success: true, message: 'Funil salvo', data: funnel });
});

app.delete('/api/funnels/:id', (req, res) => {
    const funnelId = req.params.id;
    
    if (funnelId.startsWith('CS_') || funnelId.startsWith('FB_')) {
        return res.status(400).json({ success: false, error: 'Não pode excluir funis padrão CS/FB' });
    }
    
    if (funis.has(funnelId)) {
        funis.delete(funnelId);
        addLog('FUNNEL_DELETED', `Funil ${funnelId} excluído`, null, LOG_LEVELS.INFO);
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
            version: '5.3',
            exportDate: new Date().toISOString(),
            totalFunnels: funnelsArray.length,
            funnels: funnelsArray
        }, null, 2));
        
        addLog('FUNNELS_EXPORT', `Export: ${funnelsArray.length} funis`, null, LOG_LEVELS.INFO);
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
        addLog('FUNNELS_IMPORT', `Import: ${importedCount} importados, ${skippedCount} ignorados`, 
            null, LOG_LEVELS.INFO);
        
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
    
    addLog('PHRASE_ADDED', `Frase cadastrada: "${normalizedPhrase}"`, 
        { funnelId }, LOG_LEVELS.INFO);
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
    addLog('PHRASE_UPDATED', `Frase atualizada: "${phrase}"`, null, LOG_LEVELS.INFO);
    savePhrasesToFile();
    
    res.json({ success: true, message: 'Frase atualizada com sucesso' });
});

app.delete('/api/phrases/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (phraseTriggers.has(phrase)) {
        phraseTriggers.delete(phrase);
        addLog('PHRASE_DELETED', `Frase excluída: "${phrase}"`, null, LOG_LEVELS.INFO);
        savePhrasesToFile();
        res.json({ success: true, message: 'Frase excluída com sucesso' });
    } else {
        res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
});

app.get('/api/manual-triggers', (req, res) => {
    const triggersList = Array.from(manualTriggers.entries()).map(([phrase, data]) => ({
        phrase,
        funnelId: data.funnelId,
        active: data.active !== false,
        triggerCount: data.triggerCount || 0
    }));
    res.json({ success: true, data: triggersList });
});

app.post('/api/manual-triggers', (req, res) => {
    const { phrase, funnelId } = req.body;
    
    if (!phrase || !funnelId) {
        return res.status(400).json({ success: false, error: 'Frase e funil são obrigatórios' });
    }
    
    const normalizedPhrase = phrase.trim();
    
    if (manualTriggers.has(normalizedPhrase)) {
        return res.status(400).json({ success: false, error: 'Frase já cadastrada' });
    }
    
    if (!funis.has(funnelId)) {
        return res.status(400).json({ success: false, error: 'Funil não encontrado' });
    }
    
    manualTriggers.set(normalizedPhrase, {
        funnelId,
        active: true,
        triggerCount: 0
    });
    
    addLog('MANUAL_TRIGGER_ADDED', `Frase manual cadastrada: "${normalizedPhrase}"`, 
        { funnelId }, LOG_LEVELS.INFO);
    saveManualTriggersToFile();
    
    res.json({ success: true, message: 'Frase de disparo manual cadastrada com sucesso' });
});

app.put('/api/manual-triggers/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    const { funnelId, active } = req.body;
    
    if (!manualTriggers.has(phrase)) {
        return res.status(404).json({ success: false, error: 'Frase não encontrada' });
    }
    
    const data = manualTriggers.get(phrase);
    
    if (funnelId !== undefined) {
        if (!funis.has(funnelId)) {
            return res.status(400).json({ success: false, error: 'Funil não encontrado' });
        }
        data.funnelId = funnelId;
    }
    
    if (active !== undefined) {
        data.active = active;
    }
    
    manualTriggers.set(phrase, data);
    addLog('MANUAL_TRIGGER_UPDATED', `Frase manual atualizada: "${phrase}"`, null, LOG_LEVELS.INFO);
    saveManualTriggersToFile();
    
    res.json({ success: true, message: 'Frase de disparo manual atualizada com sucesso' });
});

app.delete('/api/manual-triggers/:phrase', (req, res) => {
    const phrase = decodeURIComponent(req.params.phrase);
    
    if (manualTriggers.has(phrase)) {
        manualTriggers.delete(phrase);
        addLog('MANUAL_TRIGGER_DELETED', `Frase manual excluída: "${phrase}"`, null, LOG_LEVELS.INFO);
        saveManualTriggersToFile();
        res.json({ success: true, message: 'Frase de disparo manual excluída com sucesso' });
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
        source: conv.source || 'kirvano'
    }));
    
    conversationsList.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ success: true, data: conversationsList });
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
        phrase_triggers_count: phraseTriggers.size,
        manual_triggers_count: manualTriggers.size,
        total_logs: logs.length,
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

app.get('/logs.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'logs.html'));
});

async function initializeData() {
    console.log('🔄 Carregando dados...');
    await loadFunnelsFromFile();
    await loadConversationsFromFile();
    await loadPhrasesFromFile();
    await loadManualTriggersFromFile();
    await loadLogsFromFile();
    console.log('✅ Inicialização concluída');
    console.log('📊 Funis:', funis.size);
    console.log('💬 Conversas:', conversations.size);
    console.log('🔑 Frases:', phraseTriggers.size);
    console.log('🎯 Frases Manuais:', manualTriggers.size);
    console.log('📋 Logs:', logs.length);
}

app.listen(PORT, async () => {
    console.log('='.repeat(70));
    console.log('🚀 KIRVANO SYSTEM V5.3 - SISTEMA COMPLETO DE FUNIS');
    console.log('='.repeat(70));
    console.log('Porta:', PORT);
    console.log('Evolution:', EVOLUTION_BASE_URL);
    console.log('Instâncias:', INSTANCES.length);
    console.log('');
    console.log('✅ NOVIDADES V5.3:');
    console.log('  1. 🆕 FRASES DE DISPARO MANUAL (você envia → dispara funil)');
    console.log('  2. ✅ ViewOnce REMOVIDO (não suportado pela Evolution API)');
    console.log('  3. ✅ Detecção de frases FLEXÍVEL (contém frase na mesma ordem)');
    console.log('  4. ✅ 15 instâncias (GABY01-GABY15)');
    console.log('  5. ✅ Sistema de logs completo e exportável');
    console.log('  6. ✅ Validações extras contra race conditions');
    console.log('');
    console.log('📡 Endpoints:');
    console.log('  POST /webhook/kirvano           - Eventos Kirvano');
    console.log('  POST /webhook/perfect           - Eventos PerfectPay');
    console.log('  POST /webhook/evolution         - Mensagens WhatsApp');
    console.log('  GET  /api/manual-triggers       - Listar frases manuais');
    console.log('  POST /api/manual-triggers       - Criar frase manual');
    console.log('  PUT  /api/manual-triggers/:id   - Atualizar frase manual');
    console.log('  DELETE /api/manual-triggers/:id - Deletar frase manual');
    console.log('');
    console.log('🌐 Frontend:');
    console.log('  http://localhost:' + PORT + '           - Dashboard principal');
    console.log('  http://localhost:' + PORT + '/logs.html - Sistema de logs');
    console.log('  http://localhost:' + PORT + '/teste.html - Simulador de testes');
    console.log('='.repeat(70));
    
    await initializeData();
});
