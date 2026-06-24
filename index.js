require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');
const { authenticator } = require('otplib');

// --- ржХрзНрж░рзНржпрж╛рж╢ ржкрзНрж░рзЛржЯрзЗржХрж╢ржи ---
process.on('unhandledRejection', (reason) => { console.error('Unhandled Rejection:', reason); });
process.on('uncaughtException', (err) => { console.error('Uncaught Exception:', err.message); });

// --- Express Server (For Webhook & Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_URL = process.env.SERVER_URL; 

app.use(express.json());
app.get('/', (req, res) => res.send('Premium Fire OTP Bot v24.0 (Broadcast Fix & Change Number) is Running!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- MongoDB Setup ---
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://mdwld2005_db_user:L8W7tzuYEkJgOuNr@firexotpbot.7hhtdlf.mongodb.net/?appName=FireXotpbot";

mongoose.connect(MONGO_URI)
  .then(() => console.log('тЬЕ MongoDB Connected Successfully!'))
  .catch(err => console.error('тЭМ MongoDB Connection Error:', err));

// --- Mongoose Schemas ---
const UserSchema = new mongoose.Schema({
    id: String,
    first_name: String,
    username: String,
    total_numbers: { type: Number, default: 0 },
    total_otps: { type: Number, default: 0 },
    today_otps: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },
    today_balance: { type: Number, default: 0 },
    last_active_date: String,
    banned: { type: Boolean, default: false },
    joined: String,
    two_fa: { type: Array, default: [] }
});
const User = mongoose.model('User', UserSchema);

const SettingSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    data: mongoose.Schema.Types.Mixed
});
const Setting = mongoose.model('Setting', SettingSchema);

const EarningSchema = new mongoose.Schema({
    user_id: String,
    num_id: String,
    date: String
});
const Earning = mongoose.model('Earning', EarningSchema);

const WithdrawSchema = new mongoose.Schema({
    wd_id: String,
    user_id: String,
    amount: Number,
    method: String,
    account: String,
    status: { type: String, default: 'pending' },
    date: String
});
const Withdraw = mongoose.model('Withdraw', WithdrawSchema);

// --- ржХржиржлрж┐ржЧрж╛рж░рзЗрж╢ржи ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const OTP_GROUP_ID = "OtphomeGroup";
const PAYMENT_GROUP_ID = "-1002939166490"; 
const NUMBER_EXPIRY_MS = 15 * 60 * 1000; 

let bot;
if (SERVER_URL) {
    bot = new TelegramBot(BOT_TOKEN);
    bot.setWebHook(`${SERVER_URL}/bot${BOT_TOKEN}`);
    app.post(`/bot${BOT_TOKEN}`, (req, res) => {
        bot.processUpdate(req.body);
        res.sendStatus(200);
    });
    console.log(`тЬЕ Webhook set to ${SERVER_URL}`);
} else {
    bot = new TelegramBot(BOT_TOKEN, { polling: true });
    bot.on('polling_error', (err) => console.log("Polling Error:", err.message));
    console.log(`тЪая╕П Polling mode activated.`);
}

let botUsername = "";
bot.getMe().then(me => { botUsername = me.username; });

let adminState = {};
let userState = {};

// ==========================================
// ЁЯФе DUAL PANEL API SETUP (FIXED ROUTES)
// ==========================================
const PANELS = {
    stexsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tness/@public/api' },
    voltxsms: { baseUrl: 'https://api.2oo9.cloud/MXS47FLFX0U/tnevs/@public/api' }
};

let panelKeys = { stexsms: "MKMGV6W3B12", voltxsms: "" }; 

async function loadPanelKeys() {
    try {
        const doc = await Setting.findOne({ key: 'panel_keys' });
        if (doc && doc.data) {
            panelKeys.stexsms = doc.data.stexsms || "MKMGV6W3B12";
            panelKeys.voltxsms = doc.data.voltxsms || "";
        }
    } catch(e) {}
}

async function savePanelKey(panel, key) {
    panelKeys[panel] = key.trim();
    await Setting.findOneAndUpdate({ key: 'panel_keys' }, { data: panelKeys }, { upsert: true });
}

async function panelRequest(method, endpoint, data = null, panelName = 'stexsms') {
    const key = panelKeys[panelName];
    if (!key) throw new Error(`NO_API_KEY_${panelName}`);
    
    const cleanKey = key.trim();
    const url = `${PANELS[panelName].baseUrl}${endpoint}`;
    
    const headers = { 
        'mauthapi': cleanKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    
    try {
        if(method === 'post') {
            return await axios.post(url, data, { headers, timeout: 15000 });
        } else {
            return await axios.get(url, { headers, timeout: 15000 });
        }
    } catch (e) { throw e; }
}

// ==========================================
// ЁЯЪА CONFIG & STATE MANAGERS 
// ==========================================
const activeNumbers = new Map(); 
const deliveredOtps = new Set();
const seenConsoleHits = new Set();
const userLastSession = new Map(); 

setInterval(() => {
    const now = Date.now();
    for (let [number, data] of activeNumbers.entries()) {
        if (now - data.createdAt > NUMBER_EXPIRY_MS) {
            activeNumbers.delete(number);
            updateGlobalStats('failed');
        }
    }
}, 60000);

function getLocDate() {
    let today = new Date();
    let offset = today.getTimezoneOffset() * 60000;
    return (new Date(today - offset)).toISOString().split('T')[0];
}

async function getAppConfig() {
    try {
        let doc = await Setting.findOne({ key: 'app_config' });
        let config = doc && doc.data ? doc.data : {};
        if (config.per_otp_rate === undefined) config.per_otp_rate = 5;
        if (config.min_withdraw === undefined) config.min_withdraw = 50;
        if (config.pay_methods === undefined) config.pay_methods = ['Binance'];
        if (config.reward_system === undefined) config.reward_system = true;
        if (config.stexsms_on === undefined) config.stexsms_on = true;     
        if (config.voltxsms_on === undefined) config.voltxsms_on = true;   
        if (config.force_start === undefined) config.force_start = false;  
        if (config.global_feed_on === undefined) config.global_feed_on = true; 
        return config;
    } catch(e) { 
        return { per_otp_rate: 5, min_withdraw: 50, pay_methods: ['Binance'], reward_system: true, stexsms_on: true, voltxsms_on: true, force_start: false, global_feed_on: true }; 
    }
}
async function saveAppConfig(data) { await Setting.findOneAndUpdate({ key: 'app_config' }, { data }, { upsert: true }); }

async function ensureUser(user) {
    if (!user || !user.id) return null;
    try {
        const today = getLocDate();
        let u = await User.findOne({ id: String(user.id) });
        if (!u) {
            u = new User({ id: String(user.id), first_name: user.first_name || 'User', username: user.username || 'N/A', joined: new Date().toISOString(), last_active_date: today });
            await u.save();
        } else {
            if (u.last_active_date !== today) { u.today_otps = 0; u.today_balance = 0; u.last_active_date = today; await u.save(); }
        }
        return u;
    } catch(e) { return null; }
}

async function updateUserStat(userId, type) {
    try { if (type === 'number') await User.findOneAndUpdate({ id: String(userId) }, { $inc: { total_numbers: 1 } }); } catch(e){}
}
async function updateGlobalStats(type) {
    try {
        let update = {};
        if (type === 'pending') update = { 'data.pending': 1 };
        if (type === 'success') { update = { 'data.success': 1, 'data.pending': -1 }; }
        if (type === 'failed') { update = { 'data.failed': 1, 'data.pending': -1 }; }
        await Setting.findOneAndUpdate({ key: 'global_stats' }, { $inc: update }, { upsert: true });
    } catch(e){}
}

async function loadRanges() {
    try { const doc = await Setting.findOne({ key: 'platforms' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
}
async function saveRanges(data) {
    try { await Setting.findOneAndUpdate({ key: 'platforms' }, { data }, { upsert: true }); } catch(e){}
}

async function updateTraffic(plat, country) {
    try {
        const trafficKey = `${getPlatIcon(plat)} ${plat.toUpperCase()} - ${country.split(' ')[0]}`;
        const updateStr = `data.${trafficKey}`;
        await Setting.findOneAndUpdate({ key: 'traffic' }, { $inc: { [updateStr]: 1 } }, { upsert: true });
    } catch(e){}
}
async function getTraffic() {
    try { const doc = await Setting.findOne({ key: 'traffic' }); return doc && doc.data ? doc.data : {}; } catch(e){ return {}; }
}
async function get2FA(chatId) {
    try { const u = await User.findOne({ id: String(chatId) }); return u && u.two_fa ? u.two_fa : []; } catch(e){ return []; }
}
async function save2FA(chatId, two_fa_list) {
    try { await User.findOneAndUpdate({ id: String(chatId) }, { two_fa: two_fa_list }); } catch(e){}
}

function getPlatIcon(plat) {
    let p = plat.toLowerCase();
    if(p.includes('insta')) return 'ЁЯУ╖';
    if(p.includes('face')) return 'ЁЯФ╡';
    if(p.includes('whats')) return 'ЁЯЯв';
    if(p.includes('tele')) return 'тЬИя╕П';
    if(p.includes('goog')) return 'ЁЯФ┤';
    return 'ЁЯТм';
}

function getCountryByCode(range) {
    if (!range) return "Global";
    const cleanRange = String(range).replace('+', '');
    const codeMap = {
        '224': 'ЁЯЗмЁЯЗ│ Guinea', '229': 'ЁЯЗзЁЯЗп Benin', '225': 'ЁЯЗиЁЯЗо Ivory Coast', '234': 'ЁЯЗ│ЁЯЗм Nigeria',
        '237': 'ЁЯЗиЁЯЗ▓ Cameroon', '221': 'ЁЯЗ╕ЁЯЗ│ Senegal', '228': 'ЁЯЗ╣ЁЯЗм Togo', '223': 'ЁЯЗ▓ЁЯЗ▒ Mali',
        '226': 'ЁЯЗзЁЯЗл Burkina Faso', '243': 'ЁЯЗиЁЯЗй DR Congo', '242': 'ЁЯЗиЁЯЗм Congo', '227': 'ЁЯЗ│ЁЯЗк Niger',
        '212': 'ЁЯЗ▓ЁЯЗж Morocco', '254': 'ЁЯЗ░ЁЯЗк Kenya', '233': 'ЁЯЗмЁЯЗн Ghana', '20':  'ЁЯЗкЁЯЗм Egypt',
        '27':  'ЁЯЗ┐ЁЯЗж South Africa', '880': 'ЁЯЗзЁЯЗй Bangladesh', '91':  'ЁЯЗоЁЯЗ│ India', '92':  'ЁЯЗ╡ЁЯЗ░ Pakistan',
        '44':  'ЁЯЗмЁЯЗз UK', '1':   'ЁЯЗ║ЁЯЗ╕ USA/Canada'
    };
    const prefixes = Object.keys(codeMap).sort((a, b) => b.length - a.length);
    for (let p of prefixes) {
        if (cleanRange.startsWith(p)) return codeMap[p];
    }
    return "Global";
}

function getMainMenu(chatId) {
    let kb = [
        [{ text: "ЁЯУ▒ GET NUMBER", style: "success" }],
        [{ text: "ЁЯУб LIVE RANGE", style: "primary" }, { text: "ЁЯУК TRAFFIC", style: "primary" }],
        [{ text: "ЁЯФР 2FA AUTHENTICATOR", style: "danger" }, { text: "ЁЯСд ACCOUNT", style: "primary" }],
        [{ text: "ЁЯОз SUPPORT", style: "primary" }]
    ];
    if (chatId === ADMIN_ID) kb.push([{ text: "ЁЯЫая╕П ADMIN PANEL", style: "danger" }]);
    return { reply_markup: { keyboard: kb, resize_keyboard: true } };
}

function getAdminMenu() {
    return {
        inline_keyboard: [
            [{ text: "ЁЯМР Manage Sites", callback_data: "adm_sites", style: "primary" }, { text: "тЪЩя╕П Manage Ranges", callback_data: "adm_ranges", style: "primary" }],
            [{ text: "ЁЯУК Dashboard", callback_data: "adm_dash", style: "primary" }, { text: "ЁЯУв Broadcast", callback_data: "adm_broadcast", style: "primary" }],
            [{ text: "ЁЯСе Manage Users", callback_data: "adm_users", style: "primary" }, { text: "ЁЯТ│ Payment Settings", callback_data: "adm_paycfg", style: "success" }],
            [{ text: "тЪЩя╕П Bot Settings (ON/OFF)", callback_data: "adm_bot_settings", style: "danger" }, { text: "ЁЯФС Manage API Keys", callback_data: "adm_apikey", style: "danger" }]
        ]
    };
}

function extractOTP(msg) {
    if (!msg) return "Code Not Found";
    msg = String(msg).trim();
    if (/^\d{4,8}$/.test(msg)) return msg; 
    const match = msg.match(/(?:\d[\s-]*){4,8}/);
    if (match && match[0]) {
        let digits = match[0].replace(/\D/g, ''); 
        if (digits.length >= 4 && digits.length <= 8) return digits;
    }
    return msg; 
}

function detectLang(text) {
    if (!text) return 'English';
    if (/[\u0980-\u09FF]/.test(text)) return 'Bengali';
    if (/[\u0400-\u04FF]/.test(text)) return 'Russian';
    if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
    return 'English';
}

async function isUserSubscribed(chatId) {
    if (chatId === ADMIN_ID) return true;
    const channels = ['@developer_walid', '@fireotp_method', OTP_GROUP_ID];
    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') return false;
        } catch (e) { return false; }
    }
    return true;
}

async function checkForceSub(chatId) {
    if (chatId === ADMIN_ID) return true;
    const channels = ['@developer_walid', '@fireotp_method', OTP_GROUP_ID];
    let isSubscribed = true;
    let buttons = [];

    for (let ch of channels) {
        try {
            const member = await bot.getChatMember(ch, chatId);
            if (member.status === 'left' || member.status === 'kicked') {
                isSubscribed = false;
                buttons.push([{ text: `ЁЯУв Join Channel`, url: `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
            }
        } catch (e) {
            isSubscribed = false;
            buttons.push([{ text: `ЁЯУв Join Channel`, url: `https://t.me/${ch.replace('@', '')}`, style: "danger" }]);
        }
    }

    if (!isSubscribed) {
        buttons.push([{ text: "тЬЕ Joined (Check Again)", callback_data: "check_joined", style: "success" }]);
        bot.sendMessage(chatId, "тЪая╕П *ржмржЯ ржмрзНржпржмрж╣рж╛рж░ ржХрж░рждрзЗ ржирж┐ржЪрзЗрж░ ржЪрзНржпрж╛ржирзЗрж▓ржЧрзБрж▓рзЛрждрзЗ ржЬрзЯрзЗржи ржХрж░рзБржи:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
        return false;
    }
    return true;
}

// ЁЯЯв Fast Number Generation
async function generateNewNumber(chatId, plat, country, panelNameInput = null, rangeValInput = null, msgIdToEdit = null) {
    const config = await getAppConfig();
    const ranges = await loadRanges(); 
    let rangeVal = rangeValInput;
    let panelName = panelNameInput;

    if (!rangeValInput || !panelNameInput) {
        const rangeData = ranges[plat]?.[country];
        if (!rangeData) {
            const errTxt = "тЭМ *рж╕рж╛рж░рзНржнрж╛рж░рзЗ ржПржЗ ржорзБрж╣рзВрж░рзНрждрзЗ ржХрзЛржирзЛ рж░рзЗржЮрзНржЬ ржирзЗржЗред*";
            if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
            else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
            return;
        }
        rangeVal = typeof rangeData === 'string' ? rangeData : rangeData.range;
        panelName = typeof rangeData === 'string' ? 'stexsms' : (rangeData.panel || 'stexsms');
    }

    if (panelName === 'stexsms' && !config.stexsms_on) {
        const errTxt = "тЭМ *рж╕рж╛рж░рзНржнрж╛рж░ ржЖржкржбрзЗржЯ ржЪрж▓ржЫрзЗред*"; // User clean msg
        if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
        return;
    }
    if (panelName === 'voltxsms' && !config.voltxsms_on) {
        const errTxt = "тЭМ *рж╕рж╛рж░рзНржнрж╛рж░ ржЖржкржбрзЗржЯ ржЪрж▓ржЫрзЗред*"; // User clean msg
        if (msgIdToEdit) bot.editMessageText(errTxt, {chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown'}).catch(()=>{});
        else bot.sendMessage(chatId, errTxt, {parse_mode: 'Markdown'});
        return;
    }
    
    let cleanRange = rangeVal.trim();
    if (cleanRange.toUpperCase().includes('XXX')) {
        cleanRange = cleanRange.replace(/XXX/ig, ''); 
    }

    try {
        const res = await panelRequest('post', '/getnum', { rid: cleanRange }, panelName);
        
        if (res.data && res.data.meta && res.data.meta.status === 'ok') {
            const fullPhone = res.data.data.full_number;
            const strippedPhone = fullPhone.replace('+', ''); 
            
            let sentMsg;
            const boxNumber = `тХФтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЧ\nтХС ЁЯУ▒ \`Wait for auto OTP...\`\nтХЪтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЭ`;
            const platDisplay = `${getPlatIcon(plat)} ${plat.charAt(0).toUpperCase() + plat.slice(1)}`;
            
            // ЁЯЯв UI Clean: No Panel Source for users
            const text = `ЁЯУ▒ *Platform:* ${platDisplay}\nЁЯМН *Country:* ${country}\n\n${boxNumber}`;
            
            const actionMarkup = { 
                inline_keyboard: [
                    [{ text: `ЁЯУ▒ ${fullPhone}`, copy_text: { text: fullPhone }, style: "primary" }],
                    [{ text: "ЁЯФБ Change Number", callback_data: `change_${strippedPhone}`, style: "danger" }]
                ] 
            };

            if (msgIdToEdit) {
                await bot.editMessageText(text, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown', reply_markup: actionMarkup }).catch(()=>{});
                sentMsg = { message_id: msgIdToEdit };
            } else {
                sentMsg = await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: actionMarkup });
            }

            activeNumbers.set(strippedPhone, {
                chatId: chatId,
                plat: plat,
                country: country,
                panel: panelName,
                createdAt: Date.now(),
                msgId: sentMsg.message_id
            });

            updateUserStat(chatId, 'number');
            updateGlobalStats('pending');
            
        } else {
            let outTxt = "тЭМ *ржирж╛ржорзНржмрж╛рж░ рж╕рзНржЯржХрзЗ ржирзЗржЗ ржмрж╛ рж░рзЗржЮрзНржЬ ржнрзБрж▓ ржжрзЗржУрзЯрж╛ рж╣рзЯрзЗржЫрзЗ!*";
            if (chatId === ADMIN_ID) outTxt = `тЪая╕П *Admin Debug:* Number Not Allocated.\nAPI Response: \`${JSON.stringify(res.data)}\``;

            if (msgIdToEdit) bot.editMessageText(outTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{});
            else bot.sendMessage(chatId, outTxt, { parse_mode: 'Markdown' });
        }
    } catch (error) { 
        let errTxt = "тЪая╕П *рж╕рж╛рж░рзНржнрж╛рж░ рж╕рж╛ржорзЯрж┐ржХ ржмрзНржпрж╕рзНржд ржЖржЫрзЗред ржПржХржЯрзБ ржкрж░ ржЖржмрж╛рж░ ржЪрзЗрж╖рзНржЯрж╛ ржХрж░рзБржиред*";
        
        if (chatId === ADMIN_ID) {
            if (error.message && error.message.startsWith('NO_API_KEY')) {
                errTxt = `ЁЯЪл *API Key Missing:* ${panelName.toUpperCase()} ржПрж░ API Key рж╕рзЗржЯ ржХрж░рж╛ ржирзЗржЗ!`;
            } else if (error.response) {
                errTxt = `тЪая╕П *Admin API Error (${error.response.status}):*\n\`${JSON.stringify(error.response.data)}\`\n\nЁЯУМ *API Key ржЕржержмрж╛ Range ID ржЪрзЗржХ ржХрж░рзБржиред*`;
            } else {
                errTxt = `тЪая╕П *Admin Network Error:* \`${error.message}\``;
            }
        }

        if (msgIdToEdit) bot.editMessageText(errTxt, { chat_id: chatId, message_id: msgIdToEdit, parse_mode: 'Markdown' }).catch(()=>{}); 
        else bot.sendMessage(chatId, errTxt, { parse_mode: 'Markdown' });
    }
}

// ==========================================
// ЁЯФД BACKGROUND TASKS (SUPER FAST POLLING)
// ==========================================

let isPollingOTP = false;
setInterval(async () => {
    if (activeNumbers.size === 0 || isPollingOTP) return;
    isPollingOTP = true;
    const config = await getAppConfig();
    
    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/success-otp', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const otps = res.data.data.otps || [];
                
                for (let otpData of otps) {
                    const otpId = String(otpData.otp_id);
                    const number = otpData.number;
                    
                    if (deliveredOtps.has(otpId)) continue;
                    
                    if (activeNumbers.has(number)) {
                        const session = activeNumbers.get(number);
                        deliveredOtps.add(otpId);
                        
                        userLastSession.set(session.chatId, { plat: session.plat, country: session.country, panel: session.panel });

                        const otpCode = extractOTP(otpData.message);
                        const detectedLang = detectLang(otpData.message);
                        
                        let earningText = "";

                        if (config.reward_system !== false) {
                            let earnedAmount = config.per_otp_rate || 0;
                            await Earning.create({ num_id: otpId, user_id: String(session.chatId), date: getLocDate() });
                            
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                uDoc.balance = parseFloat((uDoc.balance + earnedAmount).toFixed(2));
                                uDoc.today_balance = parseFloat((uDoc.today_balance + earnedAmount).toFixed(2));
                                uDoc.total_otps += 1;
                                uDoc.today_otps += 1;
                                await uDoc.save();
                                earningText = `\n\nЁЯОЙ *Congratulations! Boss*\nЁЯТ░ *Earned:* \`${parseFloat(earnedAmount.toFixed(2))}\` рз│\nЁЯТ│ *Total Balance:* \`${parseFloat(uDoc.balance.toFixed(2))}\` рз│`;
                            }
                        } else {
                            const uDoc = await User.findOne({ id: String(session.chatId) });
                            if(uDoc) {
                                uDoc.total_otps += 1;
                                uDoc.today_otps += 1;
                                await uDoc.save();
                            }
                        }

                        updateGlobalStats('success');
                        updateTraffic(session.plat, session.country);
                        
                        const safePhoneText = `ЁЯУ▒ +${number}`;
                        bot.editMessageReplyMarkup({ 
                            inline_keyboard: [[{ text: safePhoneText, copy_text: { text: `+${number}` }, style: "primary" }]] 
                        }, { chat_id: session.chatId, message_id: session.msgId }).catch(()=>{});

                        const formatPhone = '+' + number;
                        const platDisplay = `${getPlatIcon(session.plat)} ${session.plat.charAt(0).toUpperCase() + session.plat.slice(1)}`;
                        const boxNumber = `тХФтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЧ\nтХС ЁЯУ▒ \`${formatPhone}\` тХС LN- ${detectedLang}\nтХЪтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХРтХЭ`;
                        
                        const safeSid = (session.plat || 'App').replace(/[^a-zA-Z0-9]/g, '');
                        const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${number}_${safeSid}`;

                        const otpMarkup = { 
                            inline_keyboard: [
                                [{ text: ` ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                [
                                    { text: "ЁЯФД Get New Number", callback_data: "get_new_num", style: "success" },
                                    { text: "ЁЯТм OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}`, style: "primary" }
                                ]
                            ] 
                        };
                        
                        bot.sendMessage(session.chatId, `ЁЯОЙ *New OTP Received* ЁЯОЙ\n\nЁЯУ▒ *Platform:* ${platDisplay}\nЁЯМН *Country:* ${session.country}\n\n${boxNumber}${earningText}`, { parse_mode: 'Markdown', reply_markup: otpMarkup }).catch(()=>{});
                        
                        if (!config.global_feed_on) {
                            const groupMsg = `ЁЯОЙ *New OTP Received* ЁЯОЙ\n\nЁЯУ▒ *Platform:* ${session.plat}\nЁЯМН *Country:* ${session.country}\nЁЯОп *Number:* \`${number}\`\n\nЁЯТм *SMS:* \`${otpData.message}\``;
                            const groupMarkup = { 
                                inline_keyboard: [
                                    [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                    [{ text: "ЁЯЪА Get Number From This Range", url: deepLinkUrl, style: "primary" }]
                                ] 
                            };
                            bot.sendMessage(OTP_GROUP_ID, groupMsg, {parse_mode: 'Markdown', reply_markup: groupMarkup}).catch(()=>{});
                        }

                        activeNumbers.delete(number);
                    }
                }
            }
        } catch(e) { }
    }
    isPollingOTP = false;
}, 1000); 

let isPollingFeed = false;
setInterval(async () => {
    if (isPollingFeed) return;
    isPollingFeed = true;
    
    const config = await getAppConfig();
    
    if (!config.global_feed_on) {
        isPollingFeed = false;
        return;
    }

    const rangesDb = await loadRanges();

    for (const pName of ['stexsms', 'voltxsms']) {
        if (pName === 'stexsms' && !config.stexsms_on) continue;
        if (pName === 'voltxsms' && !config.voltxsms_on) continue;
        if (!panelKeys[pName]) continue;
        
        try {
            const res = await panelRequest('get', '/console', null, pName);
            if (res.data && res.data.meta && res.data.meta.status === 'ok') {
                const hits = res.data.data.hits || [];
                
                for(let hit of hits.reverse()) {
                    const uniqueId = `${pName}_${hit.time}_${hit.range}_${hit.message.substring(0,5)}`;
                    
                    if(!seenConsoleHits.has(uniqueId)) {
                        seenConsoleHits.add(uniqueId);
                        
                        if(seenConsoleHits.size > 1500) { 
                            const firstItem = seenConsoleHits.values().next().value;
                            seenConsoleHits.delete(firstItem);
                        }
                        
                        const otpCode = extractOTP(hit.message);
                        
                        let consoleCountry = getCountryByCode(hit.range);
                        for (const [plat, countries] of Object.entries(rangesDb)) {
                            for (const [cName, data] of Object.entries(countries)) {
                                let rVal = typeof data === 'string' ? data : data.range;
                                if (rVal === hit.range || rVal.replace(/XXX/ig, '') === hit.range.replace(/XXX/ig, '')) {
                                    consoleCountry = cName;
                                }
                            }
                        }

                        let displaySid = hit.sid || 'Unknown';
                        const lowerMsg = hit.message.toLowerCase();
                        if (lowerMsg.includes('instagram') || lowerMsg.includes('ig code')) displaySid = 'Instagram';
                        else if (lowerMsg.includes('facebook') || lowerMsg.includes('fb')) displaySid = 'Facebook';
                        else if (lowerMsg.includes('whatsapp') || lowerMsg.includes('wa')) displaySid = 'WhatsApp';
                        else if (lowerMsg.includes('telegram') || lowerMsg.includes('tg')) displaySid = 'Telegram';
                        else if (lowerMsg.includes('google') || lowerMsg.includes('gmail') || lowerMsg.includes('g-')) displaySid = 'Google';
                        else if (lowerMsg.includes('tiktok')) displaySid = 'TikTok';

                        const safeSid = displaySid.replace(/[^a-zA-Z0-9]/g, '');
                        const deepLinkUrl = `https://t.me/${botUsername}?start=gn_${pName}_${hit.range}_${safeSid}`;

                        const msg = `ЁЯОЙ *New OTP Received* ЁЯОЙ\n\nЁЯУ▒ *Platform:* ${displaySid}\nЁЯМН *Country:* ${consoleCountry}\nЁЯОп *Number:* \`${hit.range}\`\n\nЁЯТм *SMS:* \`${hit.message}\``;
                        const markup = { 
                            inline_keyboard: [
                                [{ text: `  ${otpCode}`, copy_text: { text: otpCode }, style: "success" }],
                                [{ text: "ЁЯЪА Get Number From This Range", url: deepLinkUrl, style: "primary" }] 
                            ] 
                        };
                        
                        bot.sendMessage(OTP_GROUP_ID, msg, {parse_mode: 'Markdown', reply_markup: markup}).catch(()=>{});
                    }
                }
            }
        } catch(e) {}
    }
    isPollingFeed = false;
}, 6000);


// --- Commands & Messages ---
bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const param = match[1].trim();
    
    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "ЁЯЪл *You are banned from using this bot.*", { parse_mode: 'Markdown' });
    if (!(await checkForceSub(chatId))) return;

    if (param.startsWith('gn_')) {
        const parts = param.split('_');
        if(parts.length >= 4) {
           const pName = parts[1];
           const reqRange = parts[2];
           const platName = parts.slice(3).join(' ');
           
           let foundCountry = getCountryByCode(reqRange);
           const ranges = await loadRanges();
           for (const [p, countries] of Object.entries(ranges)) {
               for (const [c, data] of Object.entries(countries)) {
                   let r = typeof data === 'string' ? data : data.range;
                   if (r === reqRange || r.replace(/XXX/ig, '') === reqRange.replace(/XXX/ig, '')) {
                       foundCountry = c;
                   }
               }
           }
           
           bot.sendMessage(chatId, "ЁЯЪА *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
               generateNewNumber(chatId, platName, foundCountry, pName, reqRange, sentMsg.message_id);
           });
           return;
        }
    }

    const welcomeMsg = ` ЁЯТР*WELCOME TO FIRE OTP BOT*\n\nЁЯСЛ Hello, *${msg.from.first_name}*!\n\nЁЯЪА _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\nЁЯСЗ Please choose an option from the menu below:`;
    bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    if (text.startsWith('/')) return;

    const config = await getAppConfig();
    let checkU = await User.findOne({ id: String(chatId) });
    
    if (config.force_start && !checkU && text !== '/start') {
        return bot.sendMessage(chatId, "тЪая╕П *ржмржЯржЯрж┐ ржмрзНржпржмрж╣рж╛рж░ ржХрж░рждрзЗ ржкрзНрж░ржержорзЗ /start ржмрж╛ржЯржирзЗ ржХрзНрж▓рж┐ржХ ржХрж░рзБржи!*", { parse_mode: 'Markdown' });
    }

    const u = await ensureUser(msg.from);
    if (u && u.banned) return bot.sendMessage(chatId, "ЁЯЪл *You are banned.*", { parse_mode: 'Markdown' });

    const menuButtons = ["ЁЯУ▒ GET NUMBER", "ЁЯУб LIVE RANGE", "ЁЯУК TRAFFIC", "ЁЯФР 2FA AUTHENTICATOR", "ЁЯСд ACCOUNT", "ЁЯОз SUPPORT", "ЁЯЫая╕П ADMIN PANEL"];
    if (menuButtons.some(btn => text.includes(btn))) {
        if(adminState[chatId]) delete adminState[chatId];
        if(userState[chatId]) delete userState[chatId];
    }
    
    // --- USER STATE MACHINE ---
    if (userState[chatId]) {
        const state = userState[chatId];
        if (state.action === 'wait_2fa_secret') {
            const secret = text.trim().replace(/\s+/g, '').toUpperCase();
            try {
                authenticator.generate(secret); 
                const saved2fa = await get2FA(chatId);
                saved2fa.push({ secret: secret, added: new Date().toISOString() });
                await save2FA(chatId, saved2fa);
                bot.sendMessage(chatId, `тЬЕ *2FA Secret рж╕ржлрж▓ржнрж╛ржмрзЗ рж╕рзЗржн рж╣рзЯрзЗржЫрзЗ!*`, { parse_mode: 'Markdown' });
            } catch (e) { 
                bot.sendMessage(chatId, `тЭМ *ржнрзБрж▓ ржмрж╛ ржЗржиржнрзНржпрж╛рж▓рж┐ржб 2FA рж╕рж┐ржХрзНрж░рзЗржЯ ржХрзЛржб!*`, { parse_mode: 'Markdown' }); 
            }
            delete userState[chatId]; return;
        }
        else if (state.action === 'wait_wd_id') {
            state.account_id = text.trim();
            state.action = 'wait_wd_amount';
            bot.sendMessage(chatId, `тЬЕ *Method:* ${state.method}\nтЬЕ *Account/ID:* \`${state.account_id}\`\n\nЁЯТ░ *ржПржмрж╛рж░ ржХржд ржЯрж╛ржХрж╛ ржЙржЗржержбрзНрж░ ржХрж░рждрзЗ ржЪрж╛ржи рждрж╛ рж▓рж┐ржЦрзБржи:*`, { parse_mode: 'Markdown' });
            return;
        }
        else if (state.action === 'wait_wd_amount') {
            const amount = parseFloat(text.trim());
            if (isNaN(amount) || amount <= 0) return bot.sendMessage(chatId, "тЭМ *Please enter a valid amount.*", { parse_mode: 'Markdown' });
            
            try {
                const config = await getAppConfig();
                const userDoc = await User.findOne({ id: String(chatId) });
                
                if (amount < config.min_withdraw) return bot.sendMessage(chatId, `тЪая╕П *Minimum Withdraw is ${config.min_withdraw} рз│*`, { parse_mode: 'Markdown' });
                if (amount > userDoc.balance) return bot.sendMessage(chatId, "тЭМ *Insufficient Balance!*", { parse_mode: 'Markdown' });

                userDoc.balance = parseFloat((userDoc.balance - amount).toFixed(2));
                await userDoc.save();

                const wd_id = Math.random().toString(36).substring(2, 10).toUpperCase();
                await Withdraw.create({ wd_id: wd_id, user_id: String(chatId), amount: amount, method: state.method, account: state.account_id, date: getLocDate() });

                bot.sendMessage(chatId, `тЬЕ *Withdraw Request Submitted!*\n\nЁЯТ░ *Amount:* \`${amount}\` рз│\nЁЯТ│ *Method:* ${state.method}\n\n_Please wait for admin approval._`, { parse_mode: 'Markdown' });

                const wdGroupMsg = `ЁЯФФ *NEW WITHDRAW REQUEST*\n\nЁЯСд *User ID:* \`${chatId}\`\nЁЯТ│ *Method:* ${state.method}\nЁЯПж *Account/ID:* \`${state.account_id}\`\nЁЯТ░ *Amount:* \`${amount}\` рз│\n\n_Select an action below:_`;
                const wdMarkup = { inline_keyboard: [[ { text: "тЬЕ Approve", callback_data: `wd_appr_${wd_id}`, style: "success" }, { text: "тЭМ Cancel", callback_data: `wd_canc_${wd_id}`, style: "danger" } ]]};
                bot.sendMessage(PAYMENT_GROUP_ID, wdGroupMsg, { parse_mode: 'Markdown', reply_markup: wdMarkup }).catch(()=>{});
            } catch (e) { bot.sendMessage(chatId, "тЭМ Error processing request."); }
            delete userState[chatId]; return;
        }
    }

    // --- ADMIN STATE MACHINE ---
    if (adminState[chatId]) {
        const state = adminState[chatId];

        if (state.action === 'wait_site_add') {
            const ranges = await loadRanges();
            if (!ranges[text]) ranges[text] = {};
            await saveRanges(ranges);
            bot.sendMessage(chatId, `тЬЕ рж╕рж╛ржЗржЯ *${getPlatIcon(text)} ${text}* ржпрзБржХрзНржд рж╣рзЯрзЗржЫрзЗ!`, { parse_mode: 'Markdown' });
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_country_name') {
            state.country = text;
            bot.sendMessage(chatId, `тЬЕ Country: ${text}\n\nЁЯУМ ржПржмрж╛рж░ ржХрзЛржи ржкрзНржпрж╛ржирзЗрж▓ ржерзЗржХрзЗ рж░рзЗржЮрзНржЬ ржЕрзНржпрж╛ржб ржХрж░ржмрзЗржи рждрж╛ рж╕рж┐рж▓рзЗржХрзНржЯ ржХрж░рзБржи:`, {
                reply_markup: { inline_keyboard: [
                    [{ text: "тЪЩя╕П Stexsms", callback_data: "setpan_stexsms" }, { text: "тЪЩя╕П Voltxsms", callback_data: "setpan_voltxsms" }]
                ]}
            });
            return; 
        }
        else if (state.action === 'wait_range_val') {
            const ranges = await loadRanges();
            if (!ranges[state.platform]) ranges[state.platform] = {};
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `тЬЕ *${state.platform}* ржПрж░ ржЬржирзНржп рж░рзЗржЮрзНржЬ рж╕рзЗржн рж╣рзЯрзЗржЫрзЗ! (Panel: ${state.panel})`, { parse_mode: 'Markdown' });
            
            // ЁЯЯв FIX: Broadcast to Users (Range hidden, only platform/country shown)
            const platDisplay = `${getPlatIcon(state.platform)} ${state.platform.charAt(0).toUpperCase() + state.platform.slice(1)}`;
            const broadcastMsg = `ЁЯУв *NEW NUMBER ADDED!* ЁЯФе\n\nЁЯУ▒ *Platform:* ${platDisplay}\nЁЯМН *Country:* ${state.country}\n\nЁЯЪА _ржПржЦржиржЗ /start ржжрж┐рзЯрзЗ Number ржирж┐рзЯрзЗ ржХрж╛ржЬ рж╢рзБрж░рзБ ржХрж░рзБржи!_`;
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {}

            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_range_edit') {
            const ranges = await loadRanges();
            ranges[state.platform][state.country] = { range: text, panel: state.panel };
            await saveRanges(ranges);
            bot.sendMessage(chatId, `тЬЕ Range updated successfully! (Panel: ${state.panel})`);
            
            // ЁЯЯв FIX: Broadcast to Users
            const platDisplay = `${getPlatIcon(state.platform)} ${state.platform.charAt(0).toUpperCase() + state.platform.slice(1)}`;
            const broadcastMsg = `ЁЯУв *NEW NUMBER UPDATED!* ЁЯФе\n\nЁЯУ▒ *Platform:* ${platDisplay}\nЁЯМН *Country:* ${state.country}\n\nЁЯЪА _ржПржЦржиржЗ /start ржжрж┐рзЯрзЗ Number ржирж┐рзЯрзЗ ржХрж╛ржЬ рж╢рзБрж░рзБ ржХрж░рзБржи!_`;
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, broadcastMsg, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {}

            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_apikey_add') {
            const newKey = text.trim();
            try {
                await savePanelKey(state.panel, newKey);
                bot.sendMessage(chatId, `тЬЕ *${state.panel.toUpperCase()} API Key saved successfully!*`, { parse_mode: 'Markdown' });
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_broadcast_notice') {
            bot.sendMessage(chatId, "тЬЕ *Broadcasting...*", { parse_mode: 'Markdown' });
            try {
                const users = await User.find({});
                users.forEach(usr => bot.sendMessage(usr.id, `ЁЯУв *Notice from Admin:*\n\n${text}`, { parse_mode: 'Markdown' }).catch(()=>{}));
            } catch (e) {} delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_otp_rate') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val >= 0) {
                const config = await getAppConfig(); config.per_otp_rate = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `тЬЕ *OTP Rate updated to ${val} рз│*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "тЭМ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_min_wd') {
            const val = parseFloat(text.trim());
            if(!isNaN(val) && val > 0) {
                const config = await getAppConfig(); config.min_withdraw = val; await saveAppConfig(config);
                bot.sendMessage(chatId, `тЬЕ *Min Withdraw updated to ${val} рз│*`, { parse_mode: 'Markdown' });
            } else bot.sendMessage(chatId, "тЭМ Invalid amount");
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_pay_method_add') {
            const m = text.trim();
            if(m) {
                const config = await getAppConfig(); 
                if(!config.pay_methods.includes(m)) { config.pay_methods.push(m); await saveAppConfig(config); }
                bot.sendMessage(chatId, `тЬЕ *Payment Method '${m}' added!*`, { parse_mode: 'Markdown' });
            }
            delete adminState[chatId]; return;
        }
        else if (state.action === 'wait_manage_userid') {
            const uid = text.trim();
            const targetUser = await User.findOne({ id: String(uid) });
            if (!targetUser) { bot.sendMessage(chatId, "тЭМ *User not found!*", { parse_mode: 'Markdown' }); } 
            else {
                const msgText = `ЁЯСд *USER DETAILS*\n\nID: \`${targetUser.id}\`\nName: ${targetUser.first_name}\nUsername: ${targetUser.username}\n\nЁЯТ░ *Total Bal:* \`${parseFloat(targetUser.balance.toFixed(2))}\` рз│\n\nЁЯУК *Total OTPs:* \`${targetUser.total_otps}\`\nЁЯЪл *Status:* ${targetUser.banned ? 'BANNED' : 'ACTIVE'}`;
                const markup = { inline_keyboard: [[{ text: targetUser.banned ? "тЬЕ Unban User" : "ЁЯЪл Ban User", callback_data: `adm_togban_${targetUser.id}`, style: targetUser.banned ? "success" : "danger" }]]};
                bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
            }
            delete adminState[chatId]; return;
        }
    }

    if (!(await checkForceSub(chatId))) return;

    try {
        if (text === "ЁЯЫая╕П ADMIN PANEL" && chatId === ADMIN_ID) {
            bot.sendMessage(chatId, "ЁЯЫа *Admin Control Panel*\n\nSelect an option below:", { parse_mode: 'Markdown', reply_markup: getAdminMenu() });
        }
        else if (text === "ЁЯУ▒ GET NUMBER") {
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const [plat, countries] of Object.entries(ranges)) {
                if (Object.keys(countries).length > 0) {
                    row.push({ text: `${getPlatIcon(plat)} ${plat.toUpperCase()}`, callback_data: `u_site_${plat}`, style: "primary" });
                    if (row.length === 2) { inlineKeyboard.push(row); row = []; }
                }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            if (inlineKeyboard.length === 0) return bot.sendMessage(chatId, "тЪая╕П *ржХрзЛржирзЛ рж╕рж╛ржЗржЯ ржмрж╛ ржирж╛ржорзНржмрж╛рж░ рж╕рзНржЯржХрзЗ ржирзЗржЗред*", { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, "ЁЯУМ *Select a Platform:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (text === "ЁЯУб LIVE RANGE") {
            bot.sendMessage(chatId, "ЁЯУб *Click below to check Live Ranges & Realtime Global OTP feed:*", { 
                parse_mode: 'Markdown', 
                reply_markup: { inline_keyboard: [[{ text: "ЁЯФе Go To Live OTP Group", url: `https://t.me/${OTP_GROUP_ID.replace('@', '')}` }]] } 
            });
        }
        else if (text === "ЁЯУК TRAFFIC") {
            const traffic = await getTraffic();
            if (Object.keys(traffic).length === 0) return bot.sendMessage(chatId, "тЪая╕П *ржПржЦржиржУ ржХрзЛржирзЛ ржЯрзНрж░рж╛ржлрж┐ржХ ржбрж╛ржЯрж╛ ржирзЗржЗред*", { parse_mode: 'Markdown' });
            let sorted = Object.entries(traffic).sort((a, b) => b[1] - a[1]);
            let msgText = "ЁЯУК *BOT OTP TRAFFIC*\n\n";
            sorted.forEach(([key, count], index) => { msgText += `*${index + 1}.* ${key} тЮФ \`${count} OTPs\`\n`; });
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
        }
        else if (text === "ЁЯСд ACCOUNT") {
            const uData = await ensureUser(msg.from);
            const config = await getAppConfig();
            let balText = `ЁЯТ░ *Total Balance:* \`${parseFloat(uData.balance.toFixed(2))}\` рз│\nЁЯТ╕ *Today Earnings:* \`${parseFloat(uData.today_balance.toFixed(2))}\` рз│`;
            if (config.reward_system === false) balText = "";

            const msgText = `ЁЯСд *USER ACCOUNT*\n\nЁЯФЦ *ID:* \`${uData.id}\`\nЁЯСд *Name:* ${uData.first_name}\n\n${balText}\n\nЁЯУК *Total OTPs:* \`${uData.total_otps}\`\nЁЯУИ *Today OTPs:* \`${uData.today_otps}\``;
            
            let markup = { inline_keyboard: [] };
            if (config.reward_system !== false) {
                markup.inline_keyboard.push([{ text: "ЁЯТ╡ Withdraw Funds", callback_data: "wd_start", style: "success" }]);
            }
            bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown', reply_markup: markup });
        }
        else if (text === "ЁЯФР 2FA AUTHENTICATOR") {
            const saved2fa = await get2FA(chatId);
            let markup = { inline_keyboard: [[{ text: "тЮХ Add New 2FA Secret", callback_data: "add_2fa", style: "primary" }]] };
            if (saved2fa.length === 0) { 
                bot.sendMessage(chatId, "ЁЯФР *2FA Authenticator*\n\nржЖржкржирж╛рж░ ржХрзЛржирзЛ 2FA ржЕрзНржпрж╛ржХрж╛ржЙржирзНржЯ ржирзЗржЗред", { parse_mode: 'Markdown', reply_markup: markup }); 
            } else { 
                saved2fa.forEach((item, index) => {
                    let shortKey = item.secret.substring(0, 5) + '...';
                    markup.inline_keyboard.unshift([
                        { text: `ЁЯФС Key: ${shortKey}`, callback_data: `get_2fa_${index}`, style: "success" },
                        { text: `ЁЯЧСя╕П Delete`, callback_data: `del_2fa_${index}`, style: "danger" }
                    ]);
                });
                bot.sendMessage(chatId, "ЁЯФР *2FA Authenticator*\n\nржЖржкржирж╛рж░ рж╕рзЗржн ржХрж░рж╛ 2FA ржЕрзНржпрж╛ржХрж╛ржЙржирзНржЯржЧрзБрж▓рзЛ ржирж┐ржЪрзЗ ржжрзЗржУрзЯрж╛ рж╣рж▓рзЛ:", { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
        else if (text === "ЁЯОз SUPPORT") {
            bot.sendMessage(chatId, "ЁЯОз *SUPPORT CENTER*\n\nржмржЯ ржмрзНржпржмрж╣рж╛рж░ ржХрж░рждрзЗ рж╕ржорж╕рзНржпрж╛ рж╣рж▓рзЗ ржЕрзНржпрж╛ржбржорж┐ржиржХрзЗ ржорзЗрж╕рзЗржЬ ржжрж┐ржи:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "ЁЯСитАНЁЯТ╗ Contact Admin", url: `tg://user?id=${ADMIN_ID}`, style: "primary" }]] } });
        }
    } catch (e) {
        bot.sendMessage(chatId, "тЪая╕П *рж╕рж╛рж░рзНржнрж╛рж░ рждрзНрж░рзБржЯрж┐!*", { parse_mode: 'Markdown' });
    }
});

// --- Callbacks ---
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msgId = query.message.message_id;

    if (data === "check_joined") {
        const subbed = await isUserSubscribed(chatId);
        if (subbed) {
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            const u = await ensureUser(query.from);
            const welcomeMsg = ` ЁЯТР*WELCOME TO FIRE OTP BOT*\n\nЁЯСЛ Hello, *${u.first_name}*!\n\nЁЯЪА _Get unlimited virtual numbers and instant OTPs for any platform in seconds._\n\nЁЯСЗ Please choose an option from the menu below:`;
            bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown', ...getMainMenu(chatId) });
        } else {
            bot.sendMessage(chatId, "тЪая╕П *ржЖржкржирж┐ ржПржЦржиржУ рж╕ржмржЧрзБрж▓рзЛ ржЪрзНржпрж╛ржирзЗрж▓рзЗ ржЬрзЯрзЗржи ржХрж░рзЗржиржирж┐!*", { parse_mode: 'Markdown' });
        }
        bot.answerCallbackQuery(query.id).catch(()=>{});
        return;
    }

    bot.answerCallbackQuery(query.id).catch(()=>{});

    try {
        if (data === "admin_main" && chatId === ADMIN_ID) {
            bot.editMessageText("ЁЯЫа *Admin Control Panel*\n\nSelect an option below:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: getAdminMenu() }).catch(()=>{});
        }
        
        else if (data === "adm_bot_settings" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let kb = [
                [{ text: `тЪЩя╕П Stexsms: ${config.stexsms_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_stexsms" }],
                [{ text: `тЪЩя╕П Voltxsms: ${config.voltxsms_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_voltxsms" }],
                [{ text: `ЁЯЪА Force /start: ${config.force_start ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_forcestart" }],
                [{ text: `ЁЯМР Global Live OTP: ${config.global_feed_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_globalfeed" }],
                [{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText("тЪЩя╕П *Bot Settings*\n\nржкрзНржпрж╛ржирзЗрж▓ ржПржмржВ ржЕржирзНржпрж╛ржирзНржп рж╕рзЗржЯрж┐ржВрж╕ ржЕржи/ржЕржл ржХрж░рзБржи:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith("tog_") && chatId === ADMIN_ID) {
            const key = data.split('_')[1];
            const config = await getAppConfig();
            if (key === 'stexsms') config.stexsms_on = !config.stexsms_on;
            if (key === 'voltxsms') config.voltxsms_on = !config.voltxsms_on;
            if (key === 'forcestart') config.force_start = !config.force_start;
            if (key === 'globalfeed') config.global_feed_on = !config.global_feed_on;
            await saveAppConfig(config);

            let kb = [
                [{ text: `тЪЩя╕П Stexsms: ${config.stexsms_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_stexsms" }],
                [{ text: `тЪЩя╕П Voltxsms: ${config.voltxsms_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_voltxsms" }],
                [{ text: `ЁЯЪА Force /start: ${config.force_start ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_forcestart" }],
                [{ text: `ЁЯМР Global Live OTP: ${config.global_feed_on ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "tog_globalfeed" }],
                [{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText("тЪЩя╕П *Bot Settings*\n\nржкрзНржпрж╛ржирзЗрж▓ ржПржмржВ ржЕржирзНржпрж╛ржирзНржп рж╕рзЗржЯрж┐ржВрж╕ ржЕржи/ржЕржл ржХрж░рзБржи:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }

        else if (data === "adm_apikey" && chatId === ADMIN_ID) {
            let msgText = `ЁЯФС *Panel API Keys:*\n\n`;
            msgText += `*Stexsms:* \`${panelKeys.stexsms ? panelKeys.stexsms.substring(0, 8) + '...' : 'Not Set'}\`\n`;
            msgText += `*Voltxsms:* \`${panelKeys.voltxsms ? panelKeys.voltxsms.substring(0, 8) + '...' : 'Not Set'}\`\n`;
            
            let inlineKeyboard = [
                [{ text: "тЬПя╕П Set Stexsms Key", callback_data: "set_key_stexsms", style: "primary" }, { text: "тЬПя╕П Set Voltxsms Key", callback_data: "set_key_voltxsms", style: "primary" }],
                [{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msgText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } }).catch(()=>{});
        }
        else if (data.startsWith("set_key_") && chatId === ADMIN_ID) {
            const panelName = data.split('_')[2];
            adminState[chatId] = { action: 'wait_apikey_add', panel: panelName };
            bot.sendMessage(chatId, `тЬПя╕П *${panelName.toUpperCase()} Panel* ржПрж░ API Key ржЯрж┐ ржкрзЗрж╕рзНржЯ ржХрж░рзБржи:`, { parse_mode: 'Markdown' });
        }

        else if (data.startsWith('setpan_') && chatId === ADMIN_ID) {
            const panel = data.split('_')[1];
            if (adminState[chatId] && adminState[chatId].country) {
                adminState[chatId].panel = panel;
                adminState[chatId].action = 'wait_range_val';
                bot.editMessageText(`тЬЕ Panel: ${panel.toUpperCase()}\n\nтЬПя╕П ржПржмрж╛рж░ рж░рзЗржЮрзНржЬ ржЯрж╛ржЗржк ржХрж░рзБржи (ржпрзЗржоржи: 26134 ржмрж╛ 22501XXX):`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }
        else if (data.startsWith('edpan_') && chatId === ADMIN_ID) {
            const p = data.split('_')[1];
            if(adminState[chatId] && adminState[chatId].platform) {
                adminState[chatId].panel = p;
                adminState[chatId].action = 'wait_range_edit';
                bot.editMessageText(`тЬЕ Panel: ${p.toUpperCase()}\n\nтЬПя╕П ржПржмрж╛рж░ ржирждрзБржи рж░рзЗржЮрзНржЬ ржЯрж╛ржЗржк ржХрж░рзБржи:`, {chat_id: chatId, message_id: msgId}).catch(()=>{});
            }
        }

        else if (data === "adm_dash" && chatId === ADMIN_ID) {
            const totalUsers = await User.countDocuments();
            const statDoc = await Setting.findOne({ key: 'global_stats' });
            const gStats = statDoc && statDoc.data ? statDoc.data : { success: 0, pending: 0, failed: 0 };
            const dashText = `ЁЯУК *BOT DASHBOARD*\n\nЁЯСе *Total Users:* \`${totalUsers}\`\n\nЁЯУИ *Order Stats:*\nтЬЕ Success: \`${gStats.success || 0}\`\nтП│ Pending: \`${gStats.pending || 0}\`\nтЭМ Failed: \`${gStats.failed || 0}\``;
            bot.editMessageText(dashText, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]] }}).catch(()=>{});
        }
        else if (data === "adm_broadcast" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_broadcast_notice' };
            bot.sendMessage(chatId, "тЬПя╕П *рж╕ржм ржЗржЙржЬрж╛рж░ржжрзЗрж░ ржкрж╛ржарж╛ржирзЛрж░ ржЬржирзНржп ржорзЗрж╕рзЗржЬржЯрж┐ рж▓рж┐ржЦрзБржи:*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_users" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_manage_userid' };
            bot.sendMessage(chatId, "тЬПя╕П *Enter User ID to manage:*", { parse_mode: 'Markdown' });
        }
        else if (data.startsWith('adm_togban_') && chatId === ADMIN_ID) {
            const targetId = data.split('_')[2];
            const targetUser = await User.findOne({ id: String(targetId) });
            if (targetUser) {
                targetUser.banned = !targetUser.banned;
                await targetUser.save();
                bot.editMessageText(`тЬЕ *User ${targetUser.banned ? 'BANNED' : 'UNBANNED'} successfully!*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
        }
        else if (data === "adm_userlist" && chatId === ADMIN_ID) {
            const users = await User.find({});
            let userList = "ЁЯСе *USER LIST*\n\nID | Name | Bal\n-----------------------\n";
            users.forEach(u => { userList += `${u.id} | ${u.first_name || 'N/A'} | ${u.balance || 0}\n`; });
            const buffer = Buffer.from(userList, 'utf-8');
            bot.sendDocument(chatId, buffer, {}, { filename: 'users.txt', contentType: 'text/plain' }).catch(()=>{});
        }
        
        else if (data === "adm_paycfg" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let msg = `ЁЯТ│ *Payment Settings*\n\nЁЯТ░ *Per OTP Earning:* \`${config.per_otp_rate}\` рз│\nЁЯУЙ *Min Withdraw:* \`${config.min_withdraw}\` рз│\n\nЁЯТ│ *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            let kb = [
                [{ text: `ЁЯОБ Reward System: ${config.reward_system ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "adm_tog_reward", style: "primary" }],
                [{ text: "тЬПя╕П Edit Earning/OTP", callback_data: "adm_edit_otprate", style: "primary" }, { text: "тЬПя╕П Edit Min Withdraw", callback_data: "adm_edit_minwd", style: "primary" }],
                [{ text: "тЮХ Add Method", callback_data: "adm_add_paym", style: "success" }, { text: "ЁЯЧСя╕П Delete Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data === "adm_tog_reward" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            config.reward_system = !config.reward_system;
            await saveAppConfig(config);
            let msg = `ЁЯТ│ *Payment Settings*\n\nЁЯТ░ *Per OTP Earning:* \`${config.per_otp_rate}\` рз│\nЁЯУЙ *Min Withdraw:* \`${config.min_withdraw}\` рз│\n\nЁЯТ│ *Methods:* ${config.pay_methods.join(', ') || 'None'}`;
            let kb = [
                [{ text: `ЁЯОБ Reward System: ${config.reward_system ? "ON ЁЯЯв" : "OFF ЁЯФ┤"}`, callback_data: "adm_tog_reward", style: "primary" }],
                [{ text: "тЬПя╕П Edit Earning/OTP", callback_data: "adm_edit_otprate", style: "primary" }, { text: "тЬПя╕П Edit Min Withdraw", callback_data: "adm_edit_minwd", style: "primary" }],
                [{ text: "тЮХ Add Method", callback_data: "adm_add_paym", style: "success" }, { text: "ЁЯЧСя╕П Delete Method", callback_data: "adm_del_paym", style: "danger" }],
                [{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]
            ];
            bot.editMessageText(msg, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data === "adm_edit_otprate" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_otp_rate' }; bot.sendMessage(chatId, "тЬПя╕П *Enter new earning per OTP (рз│):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_edit_minwd" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_min_wd' }; bot.sendMessage(chatId, "тЬПя╕П *Enter new minimum withdraw limit (рз│):*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_add_paym" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_pay_method_add' }; bot.sendMessage(chatId, "тЬПя╕П *Enter new payment method name:*", { parse_mode: 'Markdown' });
        }
        else if (data === "adm_del_paym" && chatId === ADMIN_ID) {
            const config = await getAppConfig();
            let kb = [];
            config.pay_methods.forEach(m => { kb.push([{ text: `ЁЯЧСя╕П ${m}`, callback_data: `admdel_m_${m}`, style: "danger" }]); });
            kb.push([{ text: "ЁЯФЩ Back", callback_data: "adm_paycfg", style: "primary" }]);
            bot.editMessageText("ЁЯУМ *Select method to delete:*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } }).catch(()=>{});
        }
        else if (data.startsWith('admdel_m_') && chatId === ADMIN_ID) {
            const m = data.split('admdel_m_')[1];
            const config = await getAppConfig();
            config.pay_methods = config.pay_methods.filter(x => x !== m);
            await saveAppConfig(config);
            bot.editMessageText(`тЬЕ Deleted '${m}'`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "ЁЯФЩ Back", callback_data: "adm_paycfg", style: "danger" }]] } }).catch(()=>{});
        }
        
        else if (data === "adm_sites" && chatId === ADMIN_ID) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `тЭМ Delete ${getPlatIcon(plat)} ${plat}`, callback_data: `del_site_${plat}`, style: "danger" }]);
            }
            inlineKeyboard.push([{ text: "тЮХ Add New Site", callback_data: "add_site", style: "success" }]);
            inlineKeyboard.push([{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("ЁЯМР *Manage Sites*\n\nрж╕рж╛ржЗржЯ ржбрж┐рж▓рж┐ржЯ ржХрж░рждрзЗ ржХрзНрж░рж╕рзЗ ржХрзНрж▓рж┐ржХ ржХрж░рзБржи:", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data === "add_site" && chatId === ADMIN_ID) {
            adminState[chatId] = { action: 'wait_site_add' }; 
            bot.sendMessage(chatId, "тЬПя╕П ржирждрзБржи рж╕рж╛ржЗржЯрзЗрж░ ржирж╛ржо ржжрж┐ржи:");
        }
        else if (data.startsWith('del_site_') && chatId === ADMIN_ID) {
            const plat = data.split('del_site_')[1];
            const ranges = await loadRanges() || {};
            if(ranges[plat]) { delete ranges[plat]; await saveRanges(ranges); }
            bot.editMessageText(`тЬЕ ${plat} ржбрж┐рж▓рж┐ржЯ ржХрж░рж╛ рж╣рзЯрзЗржЫрзЗред`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "ЁЯФЩ Back", callback_data: "adm_sites", style: "danger" }]] } }).catch(()=>{});
        }
        else if (data === "adm_ranges" && chatId === ADMIN_ID) {
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            for (const plat of Object.keys(ranges)) {
                inlineKeyboard.push([{ text: `${getPlatIcon(plat)} ${plat}`, callback_data: `ar_p_${plat}`, style: "primary" }]);
            }
            inlineKeyboard.push([{ text: "ЁЯФЩ Back", callback_data: "admin_main", style: "danger" }]);
            bot.editMessageText("тЪЩя╕П *Select Site to Manage Ranges*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_p_') && chatId === ADMIN_ID) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges() || {};
            let inlineKeyboard = [];
            if (ranges[plat]) {
                for (const country of Object.keys(ranges[plat])) { inlineKeyboard.push([{ text: `ЁЯМН ${country}`, callback_data: `ar_c_${plat}_${country}`, style: "primary" }]); }
            }
            inlineKeyboard.push([{ text: "тЮХ Add Country & Range", callback_data: `ar_add_${plat}`, style: "success" }]);
            inlineKeyboard.push([{ text: "ЁЯФЩ Back", callback_data: "adm_ranges", style: "danger" }]);
            bot.editMessageText(`тЪЩя╕П *Manage Countries: ${getPlatIcon(plat)} ${plat}*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_add_') && chatId === ADMIN_ID) {
            const plat = data.split('_').slice(2).join('_');
            adminState[chatId] = { action: 'wait_country_name', platform: plat };
            bot.sendMessage(chatId, "тЬПя╕П ржирждрзБржи ржХрж╛ржирзНржЯрзНрж░рж┐рж░ ржирж╛ржо ржУ ржлрзНрж▓рзНржпрж╛ржЧ ржжрж┐ржи (ржпрзЗржоржи: ЁЯЗзЁЯЗй Bangladesh):");
        }
        else if (data.startsWith('ar_c_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            const rangeData = ranges[plat]?.[country];
            
            const currentRange = typeof rangeData === 'string' ? rangeData : (rangeData ? rangeData.range : "Not set");
            const currentPanel = typeof rangeData === 'string' ? 'stexsms' : (rangeData ? rangeData.panel : "stexsms");
            
            let inlineKeyboard = [
                [{ text: "тЬПя╕П Edit Range", callback_data: `ar_ed_${plat}_${country}`, style: "primary" }, { text: "тЭМ Delete Country", callback_data: `ar_del_${plat}_${country}`, style: "danger" }],
                [{ text: "ЁЯФЩ Back", callback_data: `ar_p_${plat}`, style: "danger" }]
            ];
            bot.editMessageText(`тЪЩя╕П *Platform:* ${plat}\nЁЯМН *Country:* ${country}\nЁЯФМ *Panel:* ${currentPanel.toUpperCase()}\nЁЯФв *Current Range:* \`${currentRange}\``, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('ar_ed_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            adminState[chatId] = { action: 'wait_range_edit_panel', platform: plat, country: country };
            
            bot.editMessageText(`ЁЯУМ ржХрзЛржи ржкрзНржпрж╛ржирзЗрж▓рзЗрж░ рж░рзЗржЮрзНржЬ ржЖржкржбрзЗржЯ ржХрж░ржмрзЗржи?`, { chat_id: chatId, message_id: msgId, reply_markup: {
                inline_keyboard: [[{text: "Stexsms", callback_data:"edpan_stexsms"}, {text: "Voltxsms", callback_data:"edpan_voltxsms"}]]
            }}).catch(()=>{});
        }
        else if (data.startsWith('ar_del_') && chatId === ADMIN_ID) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            const ranges = await loadRanges() || {};
            if (ranges[plat] && ranges[plat][country]) { delete ranges[plat][country]; await saveRanges(ranges); }
            bot.editMessageText(`тЬЕ ржХрж╛ржирзНржЯрзНрж░рж┐ ржУ рж░рзЗржЮрзНржЬ ржбрж┐рж▓рж┐ржЯ ржХрж░рж╛ рж╣рзЯрзЗржЫрзЗред`, { chat_id: chatId, message_id: msgId, reply_markup: { inline_keyboard: [[{ text: "ЁЯФЩ Back", callback_data: `ar_p_${plat}`, style: "danger" }]] } }).catch(()=>{});
        }

        // --- Withdraw Controls ---
        else if (data === "wd_start") {
            const config = await getAppConfig();
            if (config.reward_system === false) {
                bot.sendMessage(chatId, "тЪая╕П Reward system is currently disabled.");
                return;
            }
            let methods = config.pay_methods || [];
            if(methods.length === 0) {
                bot.sendMessage(chatId, "тЪая╕П No payment methods available.");
                return;
            }
            let inlineKeyboard = [];
            methods.forEach(m => { inlineKeyboard.push([{ text: `ЁЯТ│ ${m}`, callback_data: `wd_m_${m}`, style: "primary" }]); });
            bot.sendMessage(chatId, "ЁЯУМ *Select Payment Method:*", { parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard } });
        }
        else if (data.startsWith('wd_m_')) {
            const method = data.split('wd_m_')[1];
            userState[chatId] = { action: 'wait_wd_id', method: method };
            bot.sendMessage(chatId, `тЬПя╕П *ржЖржкржирж╛рж░ ${method} Account ID / Number ржжрж┐ржи:*`, { parse_mode: 'Markdown' });
        }

        // --- User 2FA Controls ---
        else if (data === "add_2fa") {
            userState[chatId] = { action: 'wait_2fa_secret' };
            bot.sendMessage(chatId, "тЬПя╕П *ржЖржкржирж╛рж░ 2FA Secret Key (Base32 format) ржЯрж┐ ржкрж╛ржарж╛ржи:*", { parse_mode: 'Markdown' });
        }
        else if (data.startsWith('get_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                const token = authenticator.generate(saved2fa[index].secret);
                const markup = { inline_keyboard: [[{ text: `  ${token}`, copy_text: { text: token }, style: "success" }]] };
                bot.sendMessage(chatId, `ЁЯФР *Live 2FA OTP Code:*\n\n\`${token}\``, { parse_mode: 'Markdown', reply_markup: markup });
            }
        }
        else if (data.startsWith('del_2fa_')) {
            const index = parseInt(data.split('_')[2]);
            const saved2fa = await get2FA(chatId);
            if (saved2fa[index]) {
                saved2fa.splice(index, 1); await save2FA(chatId, saved2fa);
                bot.editMessageText("тЬЕ *2FA Secret ржбрж┐рж▓рж┐ржЯ ржХрж░рж╛ рж╣рзЯрзЗржЫрзЗ!*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
            }
        }

        // --- User Fast Number Flows ---
        else if (data.startsWith('u_site_')) {
            const plat = data.split('_').slice(2).join('_');
            const ranges = await loadRanges();
            let inlineKeyboard = []; let row = [];
            for (const country of Object.keys(ranges[plat] || {})) {
                row.push({ text: country, callback_data: `u_cntry_${plat}_${country}`, style: "primary" });
                if (row.length === 2) { inlineKeyboard.push(row); row = []; }
            }
            if (row.length > 0) inlineKeyboard.push(row);
            bot.editMessageText(`ЁЯУМ *Select Country for ${getPlatIcon(plat)} ${plat.toUpperCase()}:*`, { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown', reply_markup: { inline_keyboard: inlineKeyboard }}).catch(()=>{});
        }
        else if (data.startsWith('u_cntry_')) {
            const parts = data.split('_'); const plat = parts[2]; const country = parts.slice(3).join('_');
            bot.deleteMessage(chatId, msgId).catch(()=>{});
            await generateNewNumber(chatId, plat, country, null, null, null);
        }
        
        // ЁЯЯв NEW: Change Number directly fetches a new one from the same range
        else if (data.startsWith('change_')) {
            const num = data.split('_')[1];
            const session = activeNumbers.get(num);
            
            if (session && session.chatId === chatId) {
                const plat = session.plat;
                const country = session.country;
                const panel = session.panel;
                
                activeNumbers.delete(num);
                bot.editMessageText("тЭМ *Number Cancelled. Generating New...*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{});
                
                await generateNewNumber(chatId, plat, country, panel, null, msgId);
            } else { 
                bot.editMessageText("тЭМ *Session Expired or Already Processed.*", { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }).catch(()=>{}); 
            }
        }
        else if (data === "get_new_num") {
            const lastSession = userLastSession.get(chatId);
            if (lastSession) {
                bot.sendMessage(chatId, "ЁЯЪА *Generating requested number...*", {parse_mode: 'Markdown'}).then(sentMsg => {
                    generateNewNumber(chatId, lastSession.plat, lastSession.country, lastSession.panel, null, sentMsg.message_id);
                });
            } else {
                bot.sendMessage(chatId, "ЁЯУМ *Session expired. Go to GET NUMBER from menu to start again.*", { parse_mode: 'Markdown' });
            }
        }
    } catch(e) { 
        console.error("Callback Error:", e);
    }
});

Promise.all([loadPanelKeys()]).then(() => {
    console.log("ЁЯФС DB Settings Loaded. Default APIs injected.");
});

console.log("ЁЯЪА V24.0 Broadcast & Change Num Fixed Successfully!");
