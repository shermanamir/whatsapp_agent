require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const qrcodeGenerator = require('qrcode');

const SCOPES = ['https://www.googleapis.com/auth/contacts'];
const TOKEN_PATH = 'token.json';

// --- Gemini Settings ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- Telegram Settings ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;
if (telegramToken && telegramChatId) {
    telegramBot = new TelegramBot(telegramToken, { polling: true });

    telegramBot.on('callback_query', (callbackQuery) => {
        const action = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        if (action.startsWith('save_contact_')) {
            const targetNumber = action.replace('save_contact_', '');
            if (pendingContacts[targetNumber]) {
                const targetName = pendingContacts[targetNumber].name;
                const myNumber = sock && sock.user ? sock.user.id.split(':')[0] : null;

                if (myNumber) {
                    telegramBot.sendMessage(chatId, `✅ מתחיל תהליך שמירה של ${targetName} לאנשי הקשר בגוגל...`);
                    authorizeAndSaveContact(targetName, targetNumber, myNumber);
                }
                pendingContacts[targetNumber].step = 'DONE';
                telegramBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
            }
        } else if (action.startsWith('ignore_contact_')) {
            const targetNumber = action.replace('ignore_contact_', '');
            if (pendingContacts[targetNumber]) {
                pendingContacts[targetNumber].step = 'DONE';
                telegramBot.sendMessage(chatId, `❌ השמירה בוטלה.`);
                telegramBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
            }
        }
    });
}

// --- In-memory Stores ---
const pendingContacts = {};
const pendingCalendarEvents = {};
let lastPendingAction = null;

const geminiTriggers = ['גמיני', "ג'ימיני", "ג׳ימיני", "ג'מיני", "ג׳מיני"];

// --- Web Server Settings ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

let sock;
const CONTACTS_FILE = './contacts.json';
let myContacts = {};
if (fs.existsSync(CONTACTS_FILE)) {
    try {
        myContacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
    } catch (e) { console.error('Error loading contacts:', e); }
}
const saveContacts = () => fs.writeFileSync(CONTACTS_FILE, JSON.stringify(myContacts));

// דגל שמונע עיבוד הודעות לפני שהסוכן מוכן ומחובר באופן מלא
let isAgentReady = false;

// --- Google Functions ---
function authorizeAndSaveContact(contactName, contactNumber, myNumber) {
    fs.readFile('credentials.json', (err, content) => {
        if (err) {
            console.log('Error loading client secret file:', err);
            sock.sendMessage(myNumber + '@s.whatsapp.net', { text: '❌ שגיאה: לא נמצא קובץ credentials.json. לא ניתן לשמור את איש הקשר לגוגל.' });
            return;
        }
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        fs.readFile(TOKEN_PATH, (err, token) => {
            if (err) {
                const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
                console.log(`\n\n=== נדרש אימות חד-פעמי מול גוגל! ===`);
                console.log(`1. היכנס לקישור הבא בדפדפן ואשר את האפליקציה:`);
                console.log(authUrl);
                console.log(`2. לאחר האישור, תועבר לדף (ייתכן שיראה שגיאה כמו localhost). העתק משורת הכתובת את הערך של ה- 'code='`);
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl.question('הדבק את הקוד כאן ולחץ Enter: ', (code) => {
                    rl.close();
                    oAuth2Client.getToken(code, (err, token) => {
                        if (err) return console.error('Error retrieving access token', err);
                        oAuth2Client.setCredentials(token);
                        fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => { if (err) console.error(err); });
                        saveToGoogleContacts(oAuth2Client, contactName, contactNumber, myNumber);
                    });
                });
                return;
            }
            oAuth2Client.setCredentials(JSON.parse(token));
            saveToGoogleContacts(oAuth2Client, contactName, contactNumber, myNumber);
        });
    });
}

function saveToGoogleContacts(auth, contactName, contactNumber, myNumber) {
    const service = google.people({ version: 'v1', auth });
    service.people.createContact({
        requestBody: {
            names: [{ givenName: contactName }],
            phoneNumbers: [{ value: `+${contactNumber}` }]
        }
    }, (err, res) => {
        if (err) {
            console.error('API Error:', err.message);
            sock.sendMessage(myNumber + '@s.whatsapp.net', { text: `❌ שגיאה בשמירת איש הקשר לגוגל.` });
            return;
        }
        console.log(`איש הקשר ${contactName} נשמר בהצלחה לגוגל!`);
        sock.sendMessage(myNumber + '@s.whatsapp.net', { text: `✅ איש הקשר *${contactName}* נשמר בהצלחה לחשבון הגוגל שלך (Google Contacts)! תוך מספר שניות הוא יסתנכרן עם הטלפון.` });
    });
}

// --- Gemini Tools ---
const tools = [
    {
        functionDeclarations: [
            {
                name: "sendWhatsappMessage",
                description: "שולח הודעת וואטסאפ לאיש קשר או למספר טלפון.",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        contactNameOrPhone: {
                            type: "STRING",
                            description: "שם איש הקשר בדיוק כפי שהמשתמש כתב אותו (כולל כינויים כמו 'אשתי האהובה', 'אבא' וכו') או מספר טלפון.",
                        },
                        message: {
                            type: "STRING",
                            description: "תוכן ההודעה לשליחה.",
                        },
                    },
                    required: ["contactNameOrPhone", "message"],
                },
            },
        ],
    },
];

// --- Express Endpoints ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// --- Main WhatsApp Connection Logic ---
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    // שליפת הגרסה העדכנית ביותר של וואטסאפ כדי למנוע דחיית חיבור
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['WhatsApp Agent', 'Chrome', '1.0.0'],
        keepAliveIntervalMs: 30000 // שליחת אות חיים כל 30 שניות למניעת ניתוקים
    });
    
    // האזנה ושמירה של אנשי קשר לקובץ מקומי קליל
    sock.ev.on('contacts.upsert', (contacts) => {
        let changed = false;
        for (const contact of contacts) {
            if (contact.name || contact.notify) {
                myContacts[contact.id] = contact.name || contact.notify;
                changed = true;
            }
        }
        if (changed) saveContacts();
    });
    sock.ev.on('contacts.update', (updates) => {
        let changed = false;
        for (const update of updates) {
            if (update.name || update.notify) {
                myContacts[update.id] = update.name || update.notify;
                changed = true;
            }
        }
        if (changed) saveContacts();
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Code received, sending to web client.');
            qrcodeGenerator.toDataURL(qr, (err, url) => {
                io.emit('qr', url);
            });
        }
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Client disconnected due to error:', lastDisconnect.error?.message || lastDisconnect.error);
            console.log('Reconnecting in 3 seconds:', shouldReconnect);
            io.emit('disconnected');
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000); // הוספנו השהיה של 3 שניות למניעת לולאה אינסופית
        } else if (connection === 'open') {
            isAgentReady = true; // הסוכן מוכן לקבל הודעות חדשות
            console.log('הסוכן התחבר לוואטסאפ בהצלחה וממתין להודעות!');
            io.emit('ready');
        }
    });

    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        // התעלמות מכל הודעה שהגיעה לפני שהחיבור הושלם
        if (!isAgentReady) return;

        const msg = m.messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        
        // התעלמות מקבוצות, סטטוסים ומזהי מערכת פנימיים (@lid)
        if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@lid') || remoteJid === 'status@broadcast') return;

        const messageType = Object.keys(msg.message)[0];
        if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') return;

        const myNumberBase = sock.user.id.split(':')[0];
        const myJid = `${myNumberBase}@s.whatsapp.net`;
        const senderNumber = remoteJid.split('@')[0];
        const isSentToMe = remoteJid.startsWith(myNumberBase);

        let body = '';
        if (messageType === 'conversation') body = msg.message.conversation;
        else if (messageType === 'extendedTextMessage') body = msg.message.extendedTextMessage.text;
        
        const pushName = msg.pushName || senderNumber;
        const isMyContact = !!myContacts[remoteJid];

        if ((!body || body.trim() === '') && messageType !== 'audioMessage') return;

        console.log(`[DEBUG] התקבלה הודעה מ: ${remoteJid}, אל: ${fromMe ? remoteJid : myJid}, תוכן: "${body}"`);

        if (messageType === 'audioMessage' && msg.message.audioMessage.ptt) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                if (buffer) {
                    const senderName = fromMe ? 'אמיר' : (myContacts[remoteJid] || pushName);
                    console.log(`[DEBUG] מתמלל הודעה קולית מ-${senderName}`);
                    const media = { data: buffer.toString('base64'), mimetype: msg.message.audioMessage.mimetype };
                    const transcription = await transcribeAudio(media);
                    if (transcription) {
                        // שולח את התמלול לטלגרם רק אם ההודעה הגיעה ממישהו אחר (לא ממך)
                        if (telegramBot && !fromMe) {
                            await telegramBot.sendMessage(telegramChatId, `${senderName} - אמר : "${transcription.trim()}"`).catch(console.error);
                        }
                        body = transcription.trim();
                    }
                }
            } catch (e) { console.error("שגיאה בטיפול בהודעה קולית:", e); return; }
        }

        if (fromMe) {
            if (isSentToMe) {
                if (body.startsWith("ג'מיני:") || body.includes("🤖") || body.startsWith("✅") || body.startsWith("❌") || body.startsWith("שגיאה") || body.startsWith("🔔")) return;
                console.log('[DEBUG] זוהתה הודעה שנשלחה לעצמך (ערוץ פקודות).');
                
                const commandBody = body.toLowerCase();
                const trigger = geminiTriggers.find(t => commandBody.startsWith(t));
                const bodyExact = body.trim();
                const startsWithYesNo = body.startsWith('כן ') || body.startsWith('לא ');

                if (bodyExact === 'כן' || bodyExact === 'לא' || startsWithYesNo) {
                    const parts = body.split(' ');
                    const decision = parts[0];
                    let targetNumber = parts[1];
                    let actionType = 'contact';
                    
                    if (targetNumber === 'יומן') { actionType = 'calendar'; targetNumber = null; }
                    else if (!targetNumber && lastPendingAction) { targetNumber = lastPendingAction.target; actionType = lastPendingAction.type; }

                    if (actionType === 'calendar') {
                        if (!targetNumber) {
                            const pendingKeys = Object.keys(pendingCalendarEvents);
                            if (pendingKeys.length > 0) targetNumber = pendingKeys[pendingKeys.length - 1];
                        }
                        if (targetNumber && pendingCalendarEvents[targetNumber]) {
                            if (decision === 'כן') {
                                const eventData = pendingCalendarEvents[targetNumber];
                                const link = createCalendarLink(eventData.data, eventData.title, eventData.description);
                                await sock.sendMessage(myJid, { text: `✅ הנה הקישור להוספת הפגישה ליומן (לחץ לפתיחה):\n${link}` });
                            } else if (decision === 'לא') {
                                await sock.sendMessage(myJid, { text: `❌ בוטל. לא אצור קישור לפגישה.` });
                            }
                            delete pendingCalendarEvents[targetNumber];
                        }
                        if (lastPendingAction && lastPendingAction.type === 'calendar') lastPendingAction = null;
                        return;
                    }

                    if (!targetNumber) {
                        const pendingKeys = Object.keys(pendingContacts).filter(k => pendingContacts[k].step === 'WAITING_FOR_APPROVAL');
                        if (pendingKeys.length > 0) targetNumber = pendingKeys[pendingKeys.length - 1];
                    }
                    
                    if (targetNumber && pendingContacts[targetNumber]) {
                        if (decision === 'כן') {
                            const targetName = pendingContacts[targetNumber].name;
                            console.log(`מתחיל תהליך שמירה אוטומטית לגוגל עבור: ${targetName} (${targetNumber})`);
                            await sock.sendMessage(myJid, { text: `מתחיל תהליך שמירה של ${targetName} לאנשי הקשר שלך בגוגל...` });
                            authorizeAndSaveContact(targetName, targetNumber, myNumberBase);
                        } else if (decision === 'לא') {
                            await sock.sendMessage(myJid, { text: `❌ ההודעה טופלה ולא נשמר איש קשר.` });
                        }
                        pendingContacts[targetNumber].step = 'DONE';
                    }
                    if (lastPendingAction && lastPendingAction.type === 'contact') lastPendingAction = null;
                } else if (trigger) {
                    console.log(`[DEBUG] זוהה טריגר "${trigger}". מעביר לטיפול הפונקציה.`);
                    await handleGeminiCommand(body, trigger, myJid);
                }
            }
            
            if (!isSentToMe) {
                const targetNum = remoteJid.split('@')[0];
                if (!pendingContacts[targetNum]) pendingContacts[targetNum] = { step: 'DONE' };
            }
        }

        // נבדוק אם זו הודעת פקודה מפורשת כדי לדלג על היומן
        // ולא נחסום הודעות טקסט רגילות או מתומללות
        let skipCalendar = false;
        if (fromMe && isSentToMe) {
            // Skip calendar analysis only for explicit commands like "Gemini..." or "yes/no"
            const isCommand = geminiTriggers.some(t => body.toLowerCase().startsWith(t)) || /^(כן|לא)/.test(body.trim());
            if (isCommand) skipCalendar = true;
        }
        if (!isMyContact && !fromMe) {
            console.log(`[DEBUG] זוהתה הודעה מאיש קשר לא שמור: ${senderNumber}`);
            if (!pendingContacts[senderNumber]) {
                console.log(`[DEBUG] שלב 1: מתחיל אינטראקציה ראשונה מול ${senderNumber}, מבקש שם.`);
                skipCalendar = true;
                pendingContacts[senderNumber] = { step: 'WAITING_FOR_NAME', originalMsg: body };
                await sock.sendMessage(remoteJid, { text: "אינך מופיע באנשי הקשר שלי אנא שלח את שמך המלא על מנת שאשמור אותך באנשי הקשר שלי" }, { quoted: msg });
            } else if (pendingContacts[senderNumber].step === 'WAITING_FOR_NAME') {
                const senderName = body;
                const originalMsg = pendingContacts[senderNumber].originalMsg;
                console.log(`[DEBUG] שלב 2: התקבל השם '${senderName}' מהמספר ${senderNumber}. שולח בקשת אישור לאמיר...`);
                skipCalendar = true;
                pendingContacts[senderNumber].step = 'WAITING_FOR_APPROVAL';
                pendingContacts[senderNumber].name = senderName;
                lastPendingAction = { type: 'contact', target: senderNumber };

                if (telegramBot) {
                    const options = {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    { text: '✅ שמור לאנשי קשר', callback_data: `save_contact_${senderNumber}` },
                                    { text: '❌ התעלם', callback_data: `ignore_contact_${senderNumber}` }
                                ]
                            ]
                        }
                    };
                    const tgMsg = `🔔 הודעה ממשתמש לא מוכר בוואטסאפ!\n\nשם: ${senderName}\nמספר: +${senderNumber}\nהודעה: ${originalMsg}\n\nהאם לשמור לאנשי קשר?`;
                    await telegramBot.sendMessage(telegramChatId, tgMsg, options).catch(console.error);
                    console.log(`[DEBUG] נשלחה בקשת אישור לשמירה בטלגרם עם כפתורים.`);
                } else {
                    const approvalMessage = `🔔 *הודעה ממשתמש לא מוכר!*\n\n*שם:* ${senderName}\n*הודעה מקורית:* ${originalMsg}\n\nהאם ברצונך לשמור את ${senderName}?\nהשב למטה בטקסט: *"כן"* כדי לשמור, או *"לא"* כדי לבטל.`;
                    await sock.sendMessage(myJid, { text: approvalMessage });
                    console.log(`[DEBUG] נשלחה הודעת אישור לשמירה למספר של אמיר: ${myJid}`);
                }
                
                await sock.sendMessage(remoteJid, { text: "תודה, שמך נמסר. הודעתך המקורית הועברה בהצלחה לאמיר." }, { quoted: msg });
            }
        }

        if (!skipCalendar && body && body.trim() !== '') {
            if (preAnalyzeForCalendar(body)) {
                const chatName = myContacts[remoteJid] || pushName || senderNumber;
                const eventData = await analyzeForCalendarEvent(body);
                if (eventData && eventData.hasEvent) {
                    const eventTitle = fromMe ? `פגישה עם ${chatName}` : `${chatName} זימן פגישה`;
                    pendingCalendarEvents[senderNumber] = { data: eventData, title: eventTitle, description: body };
                    lastPendingAction = { type: 'calendar', target: senderNumber };
                    
                    if (telegramBot) {
                        const options = {
                            reply_markup: {
                                inline_keyboard: [
                                    [
                                        { text: '✅ הוסף ליומן', callback_data: `calendar_yes_${senderNumber}` },
                                        { text: '❌ התעלם', callback_data: `calendar_no_${senderNumber}` }
                                    ]
                                ]
                            }
                        };
                        const directionText = fromMe ? `ששלחת ל-${chatName}` : `מ-${chatName}`;
                        const tgMsg = `📅 זיהוי אירוע ליומן!\n\nהודעה ${directionText}:\n"${body}"\n\nהאם תרצה לקבוע פגישה ביומן לאותו מועד?`;
                        await telegramBot.sendMessage(telegramChatId, tgMsg, options).catch(console.error);
                    } else {
                        const directionText = fromMe ? `ששלחת ל-${chatName}` : `מ-${chatName}`;
                        const askMsg = `📅 *זיהוי אירוע ליומן!*\n\nהודעה ${directionText}:\n"${body}"\n\nהאם תרצה לקבוע פגישה ביומן לאותו מועד?\nהשב *"כן"* כדי לקבל קישור להוספה מהירה ליומן גוגל, או *"לא"* כדי להתעלם.`;
                        await sock.sendMessage(myJid, { text: askMsg });
                    }
                }
            }
        }
    });
}

async function handleGeminiCommand(body, trigger, jid) {
    const prompt = body.substring(trigger.length).replace(/^,/, '').trim();
    console.log(`מעביר לג'מיני את הפקודה: "${prompt}"`);
    await sock.sendMessage(jid, { text: `מעבד את בקשתך לג'מיני... 🤖` });

    try {
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            tools: tools,
            systemInstruction: "אתה עוזר חכם בוואטסאפ. כשהמשתמש מבקש לשלוח הודעה למישהו (גם אם השם נשמע כמו כינוי כגון 'אשתי האהובה', 'אחי' וכו'), אל תשאל שאלות הבהרה! פשוט הפעל את הפונקציה sendWhatsappMessage והעבר אליה את השם המדויק שהמשתמש כתב."
        });
        const chat = model.startChat({ tools: tools });
        const result = await chat.sendMessage(prompt);
        const call = result.response.functionCalls()?.[0];

        if (call) {
            if (call.name === 'sendWhatsappMessage') {
                const { contactNameOrPhone, message } = call.args;
                const success = await sendMessageToContact(contactNameOrPhone, message);
                if (success) {
                    await sock.sendMessage(jid, { text: `✅ הודעה נשלחה בהצלחה אל: ${contactNameOrPhone}` });
                } else {
                    await sock.sendMessage(jid, { text: `❌ לא נמצא איש קשר שמור בשם '${contactNameOrPhone}'. לא ניתן היה לשלוח את ההודעה.` });
                }
            }
        } else {
            const textResponse = result.response.text();
            await sock.sendMessage(jid, { text: `ג'מיני:\n${textResponse}` });
        }
    } catch (e) {
        console.error("שגיאה בתקשורת עם ג'מיני:", e);
        await sock.sendMessage(jid, { text: `שגיאה בעיבוד הבקשה מול ג'מיני.` });
    }
}

async function sendMessageToContact(contactNameOrPhone, message) {
    const isPhoneNumber = /^[\+\d\s\-]+$/.test(contactNameOrPhone);

    if (isPhoneNumber) {
        let cleanNumber = contactNameOrPhone.replace(/\D/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '972' + cleanNumber.substring(1);
        }
        await sock.sendMessage(`${cleanNumber}@s.whatsapp.net`, { text: message });
        return true;
    }

    const searchName = contactNameOrPhone.toLowerCase().trim();

    const targetContactId = Object.keys(myContacts).find(id => {
        if (id.endsWith('@g.us')) return false;
        const name = myContacts[id];
        return name && name.toLowerCase().includes(searchName);
    });

    if (targetContactId) {
        await sock.sendMessage(targetContactId, { text: message });
        return true;
    }

    return false;
}

async function transcribeAudio(media) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = "תמלל את ההודעה הקולית הבאה בעברית בצורה מדויקת. אל תוסיף הקדמות או תוספות, רק את המלל שנאמר.";
        const audioPart = {
            inlineData: {
                data: media.data,
                mimeType: media.mimetype
            }
        };
        const result = await model.generateContent([prompt, audioPart]);
        return result.response.text();
    } catch (e) {
        console.error("שגיאה בתמלול מג'מיני:", e);
        return null;
    }
}

// --- Calendar Helper Functions ---
function preAnalyzeForCalendar(text) {
    const keywords = ['מחר', 'היום', 'שעה', 'ב-', 'בבוקר', 'בערב', 'בצהריים', 'יום', 'שבוע', 'פגישה'];
    const regex = new RegExp(keywords.join('|') + '|\\d{1,2}[\\/\\.:]\\d{1,2}', 'i');
    return regex.test(text);
}

async function analyzeForCalendarEvent(text) {
    try {
        const now = new Date();
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });
        const prompt = `
        התאריך והשעה הנוכחיים: ${now.toISOString()}.
        נתח את ההודעה הבאה:
        "${text}"
        האם ההודעה מציעה לקבוע פגישה, או מציינת תאריך/שעה ספציפיים (לדוגמה: "מחר ב-10", "ביום שני", "נדבר ב-15:00")?
        החזר JSON (ללא שום טקסט נוסף):
        {
          "hasEvent": boolean,
          "year": מספר השנה המלא (למשל 2026) או null,
          "month": מספר החודש (1-12) או null,
          "day": מספר היום בחודש (1-31) או null,
          "hour": מספר השעה בפורמט 24 (0-23) או null,
          "minute": מספר הדקה (0-59) או null
        }
        שים לב:
        - אם צוינה רק שעה בלי תאריך, השתמש בתאריך של היום.
        - אם צוין רק תאריך בלי שעה, הגדר hour ו-minute כ-null.
        `;
        const result = await model.generateContent(prompt);
        let rawText = result.response.text();
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        const parsedData = JSON.parse(rawText);
        
        if (parsedData.hasEvent) {
            let startDate = new Date();
            let isAllDay = false;

            if (parsedData.year && parsedData.month && parsedData.day) {
                startDate.setFullYear(parsedData.year, parsedData.month - 1, parsedData.day);
            }
            if (parsedData.hour !== null && parsedData.minute !== null) {
                startDate.setHours(parsedData.hour, parsedData.minute, 0, 0);
            } else {
                isAllDay = true;
            }

            if (!isAllDay) {
                const timeDiff = startDate.getTime() - now.getTime();
                // ביטול זימון אם הזמן שנקבע הוא פחות משעה מעכשיו (או בעבר)
                if (timeDiff < 60 * 60 * 1000) {
                    parsedData.hasEvent = false;
                    console.log(`[DEBUG] אירוע יומן בוטל - הזמן שזוהה קרוב מדי (פחות משעה) או בעבר.`);
                }
            }
        }
        
        return parsedData;
    } catch (e) {
        console.error("שגיאה בניתוח יומן:", e);
        return { hasEvent: false };
    }
}

function createCalendarLink(eventData, title, description) {
    let startDate = new Date();
    let isAllDay = false;

    if (eventData.year && eventData.month && eventData.day) {
        startDate.setFullYear(eventData.year, eventData.month - 1, eventData.day);
    }
    if (eventData.hour !== null && eventData.minute !== null) {
        startDate.setHours(eventData.hour, eventData.minute, 0, 0);
    } else {
        isAllDay = true;
    }

    let endDate = new Date(startDate);
    if (isAllDay) endDate.setDate(endDate.getDate() + 1);
    else endDate.setHours(endDate.getHours() + 1);

    const format = (d, allday) => {
        const pad = n => n.toString().padStart(2, '0');
        const str = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
        return allday ? str : `${str}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    };

    const dates = `${format(startDate, isAllDay)}/${format(endDate, isAllDay)}`;
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&details=${encodeURIComponent(description)}&dates=${dates}`;
}

// --- Start Server and Agent ---
connectToWhatsApp();

server.listen(3000, () => {
    console.log('Web server listening on port 3000. Open http://localhost:3000 in your browser.');
});
