require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, getContentType, Browsers } = require('@whiskeysockets/baileys');
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

// --- Todoist Settings ---
const { TodoistApi } = require('@doist/todoist-sdk');
const todoistApi = process.env.TODOIST_API_KEY ? new TodoistApi(process.env.TODOIST_API_KEY) : null;

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

    telegramBot.on('callback_query', async (callbackQuery) => {
        const action = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;
        const myNumber = sock && sock.user ? sock.user.id.split(':')[0] : null;
        const myJid = myNumber ? `${myNumber}@s.whatsapp.net` : null;

        if (action.startsWith('save_contact_')) {
            const targetNumber = action.replace('save_contact_', '');
            if (pendingContacts[targetNumber]) {
                const targetName = pendingContacts[targetNumber].name;

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
        } else if (action.startsWith('calendar_yes_')) {
            const targetNumber = action.replace('calendar_yes_', '');
            if (pendingCalendarEvents[targetNumber]) {
                const eventData = pendingCalendarEvents[targetNumber];
                const link = createCalendarLink(eventData.data, eventData.title, eventData.description);
                
                await telegramBot.sendMessage(chatId, `✅ הנה הקישור להוספת הפגישה ליומן (לחץ לפתיחה):\n${link}`);
                
                if (myJid) {
                    await sock.sendMessage(myJid, { text: `✅ הנה הקישור להוספת הפגישה ליומן (לחץ לפתיחה):\n${link}` });
                }

                delete pendingCalendarEvents[targetNumber];
                if (lastPendingAction && lastPendingAction.target === targetNumber) lastPendingAction = null;
                
                telegramBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId });
            }
        } else if (action.startsWith('calendar_no_')) {
            const targetNumber = action.replace('calendar_no_', '');
            if (pendingCalendarEvents[targetNumber]) {
                delete pendingCalendarEvents[targetNumber];
                if (lastPendingAction && lastPendingAction.target === targetNumber) lastPendingAction = null;
                await telegramBot.sendMessage(chatId, `❌ בוטל. לא נוצר אירוע ביומן.`);
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
let isReconnecting = false; // דגל שמציין שחיבור מחדש מוצע או מתבצע

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
        browser: Browsers.macOS('Desktop'), // שימוש בהגדרת דפדפן רשמית ובטוחה של הספרייה
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

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('QR Code received, sending to web client.');
            qrcodeGenerator.toDataURL(qr, (err, url) => {
                io.emit('qr', url);
            });
        }
        if (connection === 'close') {
            isAgentReady = false; // איפוס הדגל בעת ניתוק
            const statusCode = lastDisconnect.error?.output?.statusCode;
            let shouldReconnect = true;

            let reason = 'an unknown error';
            if (statusCode === DisconnectReason.loggedOut) {
                reason = 'being logged out. Please re-scan the QR code.';
                shouldReconnect = false; // Do not reconnect on manual logout
            } else if (statusCode === DisconnectReason.connectionReplaced || statusCode === 428) {
                reason = 'another session taking over. Trying to reconnect automatically.';
                shouldReconnect = true; // ננסה חיבור מחדש אוטומטי
            } else if (lastDisconnect.error) {
                reason = lastDisconnect.error.message;
            }

            console.error(`Connection closed due to ${reason}. Reconnecting: ${shouldReconnect}`);
            io.emit('disconnected');
            if (shouldReconnect) {
                isReconnecting = true;
                setTimeout(connectToWhatsApp, 5000);
            }
        } else if (connection === 'open') {
            isAgentReady = true; // הסוכן מוכן לקבל הודעות חדשות
            console.log('הסוכן התחבר לוואטסאפ בהצלחה וממתין להודעות!');
            io.emit('ready');

            if (isReconnecting) {
                isReconnecting = false;
                try {
                    const myNumberBase = sock?.user?.id?.split(':')[0];
                    if (myNumberBase) {
                        const myJid = `${myNumberBase}@s.whatsapp.net`;
                        await sock.sendMessage(myJid, { text: '✅ חיבור וואטסאפ חודש בהצלחה לאחר ניתוק.' });
                    }
                } catch (err) {
                    console.error('Error sending reconnect confirmation:', err);
                }
            }
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
        if (!msg?.message) { console.log('[DEBUG] Ignored message because msg.message is null.'); return; }
        if (msg.message.protocolMessage) {
            // הודעות מערכת של וואטסאפ (לדוגמה HISTORY_SYNC_NOTIFICATION) אינן פעילות לשירות.
            return;
        }

        // --- DEBUGGING ---
        // Log only actual WhatsApp messages, not system protocol events.
        console.log('Received raw upsert event:', JSON.stringify(m, null, 2));

        const remoteJid = msg.key.remoteJid;
        const fromMe = msg.key.fromMe;
        
        // התעלמות מקבוצות וסטטוסים. LIDs מטופלים כעת.
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

        // קביעת המזהה האמיתי של השולח. עם LIDs, ה-remoteJid הוא מזהה השיחה, וה-senderPn הוא מספר הטלפון האמיתי.
        const senderJid = msg.key.senderPn || remoteJid;

        // -- Start of Message Unwrapping --
        // This block handles various message wrappers (like ephemeral messages) to extract the actual content.
        let innerMsg = msg.message;
        // Loop to unpack multiple layers of wrappers
        while (innerMsg.ephemeralMessage || innerMsg.viewOnceMessage || innerMsg.viewOnceMessageV2 || innerMsg.documentWithCaptionMessage) {
            innerMsg = innerMsg.ephemeralMessage?.message ||
                       innerMsg.viewOnceMessage?.message ||
                       innerMsg.viewOnceMessageV2?.message ||
                       innerMsg.documentWithCaptionMessage?.message;
            // If at any point unwrapping leads to a null/undefined message, break.
            if (!innerMsg) break;
        }

        // If after unwrapping, there's no valid message, ignore it.
        if (!innerMsg) {
            console.log('[DEBUG] Ignored message: unwrapping resulted in null.');
            return;
        }

        let messageType = getContentType(innerMsg);
        if (!messageType) {
            console.log('[DEBUG] Ignored message: could not determine type after unwrapping.');
            return;
        }

        const messageContent = innerMsg[messageType];
        if (!messageContent) {
            console.log(`[DEBUG] Ignored message: type "${messageType}" had no content.`);
            return;
        }
        // -- End of Message Unwrapping --

        if (messageType === 'protocolMessage' || messageType === 'senderKeyDistributionMessage') {
            console.log(`[DEBUG] Ignored system message of type: ${messageType}`);
            return;
        }

        const myNumberBase = sock.user?.id?.split(':')[0];
        if (!myNumberBase) return; // הגנה למקרה שהסוכן לא סיים אתחול לגמרי

        const myJid = `${myNumberBase}@s.whatsapp.net`;
        const senderNumber = senderJid.split('@')[0]; // שימוש במספר האמיתי של השולח
        const isSentToMe = remoteJid.startsWith(myNumberBase);

        let body = '';
        if (messageType === 'conversation') body = messageContent;
        else if (messageType === 'extendedTextMessage') body = messageContent?.text;
        else if (messageType === 'imageMessage' && messageContent?.caption) body = messageContent.caption;
        else if (messageType === 'videoMessage' && messageContent?.caption) body = messageContent.caption;
        
        const pushName = msg.pushName || senderNumber;
        const isMyContact = !!myContacts[senderJid]; // בדיקה מול המזהה האמיתי

        if ((!body || body.trim() === '') && messageType !== 'audioMessage') return;

        console.log(`[DEBUG] התקבלה הודעה מ: ${remoteJid}, אל: ${fromMe ? remoteJid : myJid}, סוג: ${messageType}, תוכן: "${body}"`);

        if (messageType === 'audioMessage' && messageContent?.ptt) {
            try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                if (buffer) {
                    const senderName = fromMe ? 'אמיר' : (myContacts[senderJid] || pushName);
                    console.log(`[DEBUG] מתמלל הודעה קולית מ-${senderName}`);
                    const media = { data: buffer.toString('base64'), mimetype: messageContent.mimetype };
                    const transcription = await transcribeAudio(media);
                    if (transcription) {
                        // שולח את התמלול לטלגרם רק אם ההודעה הגיעה ממישהו אחר (לא ממך)
                        if (telegramBot && !fromMe) {
                            await telegramBot.sendMessage(telegramChatId, `${senderName} - אמר : "${transcription.trim()}"`).catch(console.error);
                        }
                        body = transcription.trim();
                        // After transcription, treat it as a text message for further processing
                        messageType = 'conversation';
                    }
                }
            } catch (e) { console.error("שגיאה בטיפול בהודעה קולית:", e); return; }
        }

        // --- Main Logic Flow ---

        // 1. Handle messages from unknown contacts first and exit the flow.
        if (!isMyContact && !fromMe) {
            console.log(`[DEBUG] זוהתה הודעה מאיש קשר לא שמור: ${senderNumber}`);
            if (!pendingContacts[senderNumber]) {
                console.log(`[DEBUG] שלב 1: מתחיל אינטראקציה ראשונה מול ${senderNumber}, מבקש שם.`);
                pendingContacts[senderNumber] = { step: 'WAITING_FOR_NAME', originalMsg: body };
                await sock.sendMessage(remoteJid, { text: "אינך מופיע באנשי הקשר אנא שלח את שמך המלא על מנת שאשמור אותך באנשי הקשר שלי" }, { quoted: msg });
                return; // Stop processing this message, wait for the user's name.
            } else if (pendingContacts[senderNumber].step === 'WAITING_FOR_NAME') {
                const senderName = body;
                const originalMsg = pendingContacts[senderNumber].originalMsg;
                console.log(`[DEBUG] שלב 2: התקבל השם '${senderName}' מהמספר ${senderNumber}. שולח בקשת אישור לאמיר...`);
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
                } else {
                    const approvalMessage = `🔔 *הודעה ממשתמש לא מוכר!*\n\n*שם:* ${senderName}\n*הודעה מקורית:* ${originalMsg}\n\nהאם ברצונך לשמור את ${senderName}?\nהשב למטה בטקסט: *"כן"* כדי לשמור, או *"לא"* כדי לבטל.`;
                    await sock.sendMessage(myJid, { text: approvalMessage });
                }
                
                await sock.sendMessage(remoteJid, { text: "תודה, שמך נמסר. הודעתך המקורית הועברה בהצלחה לאמיר." }, { quoted: msg });
                return; // Stop processing this message (which is the name), wait for approval.
            }
        }

        // 2. Handle commands and replies sent from me to me. If it's a command, process and exit.
        if (fromMe && isSentToMe) {
            if (body.startsWith("ג'מיני:") || body.includes("🤖") || body.startsWith("✅") || body.startsWith("❌") || body.startsWith("שגיאה") || body.startsWith("🔔")) return;
            
            console.log('[DEBUG] זוהתה הודעה שנשלחה לעצמך (ערוץ פקודות).');
            const commandBody = body.toLowerCase();
            const trigger = geminiTriggers.find(t => commandBody.startsWith(t));
            const bodyExact = body.trim();
            const startsWithYesNo = body.startsWith('כן ') || body.startsWith('לא ');

            if (trigger) {
                console.log(`[DEBUG] זוהה טריגר "${trigger}". מעביר לטיפול הפונקציה.`);
                await handleGeminiCommand(body, trigger, myJid);
                return;
            }

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

                if (actionType === 'contact') {
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
                    return;
                }
            }
        }

        // 3. Mark outgoing messages to others so we don't treat them as unknown in the future
        if (fromMe && !isSentToMe) {
            const targetNum = remoteJid.split('@')[0];
            if (!pendingContacts[targetNum]) pendingContacts[targetNum] = { step: 'DONE' };
        }

        // 4. Any message that reaches this point is eligible for calendar analysis.
        if (body && body.trim() !== '') {
            if (preAnalyzeForCalendar(body)) {
                const chatName = myContacts[senderJid] || pushName || senderNumber;
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

        // 5. Check for shopping list command
        if (body && body.toLowerCase().startsWith('רשימת קניות')) {
            const listText = body.substring('רשימת קניות'.length).trim();
            if (listText) {
                const items = listText.split(',').map(item => item.trim()).filter(item => item);
                if (items.length > 0) {
                    await createShoppingList(items, senderNumber);
                } else {
                    await sock.sendMessage(remoteJid, { text: 'לא מצאתי פריטים ברשימת הקניות. נסה: "רשימת קניות: חלב, לחם, ביצים"' }, { quoted: msg });
                }
            } else {
                await sock.sendMessage(remoteJid, { text: 'איך להשתמש: "רשימת קניות: פריט1, פריט2, פריט3"' }, { quoted: msg });
            }
            return; // Stop processing this message
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
        החזר אובייקט JSON (בלבד, ללא שום טקסט נוסף) במבנה הבא:
        {
          "hasEvent": boolean,
          "year": מספר השנה המלא (למשל 2026) או null,
          "month": מספר החודש (1-12) או null,
          "day": מספר היום בחודש (1-31) או null,
          "hour": מספר השעה בפורמט 24 (0-23) או null,
          "minute": מספר הדקה (0-59) או null
        }
        שים לב:
        - נתח מונחים יחסיים כמו "מחר", "בעוד יומיים", "יום שני הבא" ביחס לתאריך הנוכחי.
        - אם צוינה רק שעה בלי תאריך, השתמש בתאריך של היום (אלא אם כן מונח יחסי כמו "מחר" מציין אחרת).
        - אם צוין רק תאריך בלי שעה, הגדר hour ו-minute כ-null (זה ייחשב אירוע של יום שלם).
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
                // ביטול זימון אם הזמן שנקבע הוא פחות משעה מהרגע הנוכחי (או בעבר)
                if (timeDiff < 60 * 60 * 1000) {
                    parsedData.hasEvent = false;
                    console.log(`[DEBUG] אירוע יומן בוטל - הזמן שזוהה הוא פחות משעה מהרגע הנוכחי או בעבר.`);
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

// --- Shopping List Function ---
async function createShoppingList(items, myNumber) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        const projectName = `רשימת קניות ${new Date().toLocaleDateString('he-IL')}`;
        const project = await todoistApi.addProject({ name: projectName });

        for (const item of items) {
            await todoistApi.addTask({
                content: item.trim(),
                projectId: project.id
            });
        }

        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, {
            text: `✅ רשימת קניות נוצרה ב-Todoist!\nפרויקט: ${projectName}\nפריטים: ${items.length}`
        });
    } catch (e) {
        console.error('שגיאה ביצירת רשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה ביצירת רשימת קניות ב-Todoist.' });
    }
}

// --- Start Server and Agent ---
connectToWhatsApp();

server.listen(3000, () => {
    console.log('Web server listening on port 3000. Open http://localhost:3000 in your browser.');
});
