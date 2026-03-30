require('dotenv').config(); // טוען משתני סביבה מקובץ .env
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
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

// --- הגדרות Gemini ---
// ודא שיצרת קובץ .env עם המפתח שלך תחת השם GEMINI_API_KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- הגדרות Telegram ---
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramChatId = process.env.TELEGRAM_CHAT_ID;
let telegramBot = null;
if (telegramToken && telegramChatId) {
    telegramBot = new TelegramBot(telegramToken, {polling: true}); // הפעלנו האזנה כדי שנוכל ללחוץ על כפתורים

    // מאזין ללחיצות על כפתורים בטלגרם (Inline Keyboard)
    telegramBot.on('callback_query', (callbackQuery) => {
        const action = callbackQuery.data;
        const chatId = callbackQuery.message.chat.id;
        const messageId = callbackQuery.message.message_id;

        if (action.startsWith('save_contact_')) {
            const targetNumber = action.replace('save_contact_', '');
            if (pendingContacts[targetNumber]) {
                const targetName = pendingContacts[targetNumber].name;
                const myNumber = client.info && client.info.wid ? client.info.wid._serialized : null;
                
                if (myNumber) {
                    telegramBot.sendMessage(chatId, `✅ מתחיל תהליך שמירה של ${targetName} לאנשי הקשר בגוגל...`);
                    authorizeAndSaveContact(targetName, targetNumber, myNumber); // קורא לפונקציה הקיימת ששומרת לגוגל
                }
                pendingContacts[targetNumber].step = 'DONE';
                telegramBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); // מעלים את הכפתורים אחרי הלחיצה
            }
        } else if (action.startsWith('ignore_contact_')) {
            const targetNumber = action.replace('ignore_contact_', '');
            if (pendingContacts[targetNumber]) {
                pendingContacts[targetNumber].step = 'DONE';
                telegramBot.sendMessage(chatId, `❌ השמירה בוטלה.`);
                telegramBot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: messageId }); // מעלים את הכפתורים
            }
        }
    });
}

// מאגר זמני לשמירת מצב השיחה מול מספקים לא מוכרים
const pendingContacts = {};
const pendingCalendarEvents = {}; // מאגר לאירועי יומן שממתינים לאישור
let lastPendingAction = null; // מנגנון חכם שזוכר מה הדבר האחרון שהסוכן שאל (יומן או איש קשר)

const geminiTriggers = ['גמיני', "ג'ימיני", "ג׳ימיני", "ג'מיני", "ג׳מיני"]; // מילות טריגר להפעלת ג'מיני

// --- הגדרות שרת Web ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const client = new Client({
    authStrategy: new LocalAuth({ clientId: "main-user" }), // הוספת clientId כדי לתמוך בריבוי משתמשים בעתיד
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

let agentReadyTimestamp = null;

// --- פונקציות גוגל (אימות ושמירת אנשי קשר) ---
function authorizeAndSaveContact(contactName, contactNumber, myNumber) {
    fs.readFile('credentials.json', (err, content) => {
        if (err) {
            console.log('Error loading client secret file:', err);
            client.sendMessage(myNumber, '❌ שגיאה: לא נמצא קובץ credentials.json. לא ניתן לשמור את איש הקשר לגוגל.');
            return;
        }
        const credentials = JSON.parse(content);
        const {client_secret, client_id, redirect_uris} = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        fs.readFile(TOKEN_PATH, (err, token) => {
            if (err) {
                // רק אם אין טוקן (בפעם הראשונה), מבקשים מהמשתמש ליצור אותו דרך הטרמינל
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
    const service = google.people({version: 'v1', auth});
    service.people.createContact({
        requestBody: {
            names: [{ givenName: contactName }],
            phoneNumbers: [{ value: `+${contactNumber}` }]
        }
    }, (err, res) => {
        if (err) {
            console.error('API Error:', err.message);
            client.sendMessage(myNumber, `❌ שגיאה בשמירת איש הקשר לגוגל.`);
            return;
        }
        console.log(`איש הקשר ${contactName} נשמר בהצלחה לגוגל!`);
        client.sendMessage(myNumber, `✅ איש הקשר *${contactName}* נשמר בהצלחה לחשבון הגוגל שלך (Google Contacts)! תוך מספר שניות הוא יסתנכרן עם הטלפון.`);
    });
}

// --- כלים עבור Gemini (Function Calling) ---
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

// --- הגדרת נקודות קצה (Endpoints) לשרת ---
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

client.on('qr', (qr) => {
    console.log('QR Code received, sending to web client.');
    qrcodeGenerator.toDataURL(qr, (err, url) => {
        io.emit('qr', url); // שולח את ה-QR כ-URL של תמונה לדפדפן
    });
});

client.on('ready', () => {
    agentReadyTimestamp = Math.floor(Date.now() / 1000);
    console.log('הסוכן התחבר לוואטסאפ בהצלחה וממתין להודעות!');
    io.emit('ready'); // מודיע לדפדפן שהחיבור הצליח
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    io.emit('disconnected');
});

client.on('message_create', async msg => { // שינוי חשוב: מאזין גם להודעות שאתה שולח
    // התעלמות מהודעות ישנות שהתקבלו לפני שהסוכן הופעל
    if (agentReadyTimestamp && msg.timestamp < agentReadyTimestamp) return;

    // התעלמות מעדכוני סטטוס, הודעות מערכת, וכתובות פנימיות של וואטסאפ (כמו @lid)
    // נוספה התעלמות מהודעות מערכת על שינוי מפתח הצפנה (e2e_notification, protocol וכו')
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.from.includes('@lid') || msg.to.includes('@lid') || msg.type === 'e2e_notification' || msg.type === 'protocol' || msg.type === 'notification_template') return;

    // התעלמות מוחלטת מהודעות של קבוצות (זיהוי לפי סיומת @g.us)
    if (msg.from.endsWith('@g.us') || msg.to.endsWith('@g.us')) return;

    // התעלמות מהודעות ריקות ללא טקסט וללא מדיה
    if ((!msg.body || msg.body.trim() === '') && !msg.hasMedia) return;

    // גיבוי למניעת שגיאות: אם אין טקסט אבל יש מדיה, נגדיר כמחרוזת ריקה
    msg.body = msg.body || '';

    const contact = await msg.getContact();
    // myNumber מזהה את המספר שמחובר כעת לוואטסאפ (שלך)
    const myNumber = client.info.wid._serialized;
    const senderNumber = contact.number;

    // נוסיף לוג כדי לראות כל הודעה שנכנסת
    console.log(`[DEBUG] התקבלה הודעה מ: ${msg.from}, אל: ${msg.to}, תוכן: "${msg.body}"`);

    // --- טיפול בהודעות קוליות (Push To Talk) ---
    if (msg.hasMedia && msg.type === 'ptt') {
        try {
            const media = await msg.downloadMedia();
            if (media) {
                const senderName = msg.from === myNumber ? 'אמיר' : (contact.name || contact.number);
                console.log(`[DEBUG] מתמלל הודעה קולית מ-${senderName}`);
                const transcription = await transcribeAudio(media);
                if (transcription) {
                    // שליחה לטלגרם בלבד - ללא הודעות בוואטסאפ או פקודות לג'מיני
                    if (telegramBot) {
                        await telegramBot.sendMessage(telegramChatId, `${senderName} - אמר : "${transcription.trim()}"`);
                    }
                    // מעדכנים את גוף ההודעה כדי לאפשר זיהוי תאריכים בהמשך
                    msg.body = transcription.trim();
                }
            }
        } catch (e) { console.error("שגיאה בטיפול בהודעה קולית:", e); return; }
        // לא עושים return כללי כדי שהטקסט המתומלל ימשיך ללוגיקת זיהוי יומן בסוף!
    }

    // ----- לוגיקה להודעות שאתה שולח לעצמך (פקודות לסוכן) -----
    // התנאי בודק שההודעה נשלחה ממך אל עצמך, כדי שהסוכן לא יגיב להודעות שאתה שולח לאחרים
    if (msg.from === myNumber) {
        // אם ההודעה ממך, בדוק אם היא נשלחה אליך (ערוץ פקודות)
        if (msg.to === myNumber) {
            // הגנה מפני לולאה אינסופית: מתעלם מהודעות שהסוכן עצמו שולח חזרה
            if (msg.body.startsWith("ג'מיני:") || 
                msg.body.includes("🤖") || 
                msg.body.startsWith("✅") || 
                msg.body.startsWith("❌") || 
                msg.body.startsWith("שגיאה") ||
                msg.body.startsWith("🔔")) {
                return;
            }

            console.log('[DEBUG] זוהתה הודעה שנשלחה לעצמך (ערוץ פקודות).');

            const commandBody = msg.body.toLowerCase();
            const trigger = geminiTriggers.find(t => commandBody.startsWith(t));

            const bodyExact = msg.body.trim();
            const startsWithYesNo = msg.body.startsWith('כן ') || msg.body.startsWith('לא ');

            if (bodyExact === 'כן' || bodyExact === 'לא' || startsWithYesNo) {
                const parts = msg.body.split(' ');
                const decision = parts[0];
                let targetNumber = parts[1];

                let actionType = 'contact'; // ברירת מחדל
                if (targetNumber === 'יומן') {
                    actionType = 'calendar';
                    targetNumber = null;
                } else if (!targetNumber && lastPendingAction) {
                    // אם ענית רק "כן", נשתמש בפעולה האחרונה שהסוכן ביקש עליה אישור
                    targetNumber = lastPendingAction.target;
                    actionType = lastPendingAction.type;
                }

                // --- לוגיקת יומן ---
                if (actionType === 'calendar') {
                    if (!targetNumber) {
                        const pendingKeys = Object.keys(pendingCalendarEvents);
                        if (pendingKeys.length > 0) targetNumber = pendingKeys[pendingKeys.length - 1];
                    }

                    if (targetNumber && pendingCalendarEvents[targetNumber]) {
                        if (decision === 'כן') {
                            const eventData = pendingCalendarEvents[targetNumber];
                            const link = createCalendarLink(eventData.data, eventData.title, eventData.description);
                            await client.sendMessage(myNumber, `✅ הנה הקישור להוספת הפגישה ליומן (לחץ לפתיחה):\n${link}`);
                        } else if (decision === 'לא') {
                            await client.sendMessage(myNumber, `❌ בוטל. לא אצור קישור לפגישה.`);
                        }
                        delete pendingCalendarEvents[targetNumber];
                    }
                    if (lastPendingAction && lastPendingAction.type === 'calendar') lastPendingAction = null;
                    return; // מסיימים כאן ללוגיקת היומן
                }

                // --- לוגיקת שמירת איש קשר (הקיימת) ---
                if (!targetNumber) { // גיבוי אם אין lastPendingAction
                    const pendingKeys = Object.keys(pendingContacts).filter(k => pendingContacts[k].step === 'WAITING_FOR_APPROVAL');
                    if (pendingKeys.length > 0) {
                        targetNumber = pendingKeys[pendingKeys.length - 1]; // לוקח את האחרון ברשימה
                    }
                }

                if (targetNumber && pendingContacts[targetNumber]) {
                    if (decision === 'כן') {
                        const targetName = pendingContacts[targetNumber].name;
                        
                        console.log(`מתחיל תהליך שמירה אוטומטית לגוגל עבור: ${targetName} (${targetNumber})`);
                        await client.sendMessage(myNumber, `מתחיל תהליך שמירה של ${targetName} לאנשי הקשר שלך בגוגל...`);
                        
                        // קריאה לפונקציה החדשה ששומרת לגוגל
                        authorizeAndSaveContact(targetName, targetNumber, myNumber);
                        
                    } else if (decision === 'לא') {
                        console.log(`לא שומר איש קשר: ${targetNumber}`);
                        await client.sendMessage(myNumber, `❌ ההודעה טופלה ולא נשמר איש קשר.`);
                    }
                    // סימון שהשיחה טופלה במקום מחיקה, כדי שההודעה האוטומטית לא תישלח לו שוב בהמשך
                    pendingContacts[targetNumber].step = 'DONE';
                }
                if (lastPendingAction && lastPendingAction.type === 'contact') lastPendingAction = null;
            } else if (trigger) {
                console.log(`[DEBUG] זוהה טריגר "${trigger}". מעביר לטיפול הפונקציה.`);
                await handleGeminiCommand(msg, trigger);
            }
        }
        
        // הגנה נוספת: אם אמיר שולח הודעה יזומה למספר כלשהו, נסמן אותו במאגר 
        // כדי שאם הוא יענה (והוא לא שמור באנשי הקשר), הסוכן לא ישגע אותו בבקשת שם
        if (msg.to !== myNumber) {
            const targetNum = msg.to.split('@')[0];
            if (!pendingContacts[targetNum]) pendingContacts[targetNum] = { step: 'DONE' };
        }

        // חשוב: אנחנו עוצרים כאן כדי שהסוכן לא ינתח הודעות שאתה שולח לאנשים אחרים
        return;
    }

    // ----- לוגיקה לאנשי קשר לא שמורים (לא מוכרים) -----
    let skipCalendar = false;
    if (!contact.isMyContact) {
        console.log(`[DEBUG] זוהתה הודעה מאיש קשר לא שמור: ${senderNumber}`);
        if (!pendingContacts[senderNumber]) {
            // שלב 1: איש קשר חדש לחלוטין שמייצר אינטראקציה ראשונה
            console.log(`[DEBUG] שלב 1: מתחיל אינטראקציה ראשונה מול ${senderNumber}, מבקש שם.`);
            skipCalendar = true; // מדלגים על זיהוי יומן כי אנחנו ממתינים לשם
            pendingContacts[senderNumber] = {
                step: 'WAITING_FOR_NAME',
                originalMsg: msg.body
            };
            await msg.reply("אינך מופיע באנשי הקשר שלי אנא שלח את שמך המלא על מנת שאשמור אותך באנשי הקשר שלי"); // נשארה רק ההודעה המעודכנת
            
        } else if (pendingContacts[senderNumber].step === 'WAITING_FOR_NAME') {
            // שלב 2: התקבל שם משתמש, כעת הסוכן מעביר הכל לאמיר
            const senderName = msg.body;
            const originalMsg = pendingContacts[senderNumber].originalMsg;
            console.log(`[DEBUG] שלב 2: התקבל השם '${senderName}' מהמספר ${senderNumber}. שולח בקשת אישור לאמיר...`);
            
            skipCalendar = true; // עדיין לא לנתח הודעה זו ליומן
            pendingContacts[senderNumber].step = 'WAITING_FOR_APPROVAL';
            pendingContacts[senderNumber].name = senderName;
            lastPendingAction = { type: 'contact', target: senderNumber }; // מעדכנים את ההמתנה

            if (telegramBot) {
                const options = {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '✅ שמור לאנשי קשר', callback_data: `save_contact_${senderNumber}` },
                                { text: '❌ התעלם', callback_data: `ignore_contact_${senderNumber}` }
                            ]
                        ]
                    }
                };
                const tgMsg = `🔔 *הודעה ממשתמש לא מוכר בוואטסאפ!*\n\n*שם:* ${senderName}\n*מספר:* +${senderNumber}\n*הודעה:* ${originalMsg}\n\nהאם לשמור לאנשי קשר?`;
                await telegramBot.sendMessage(telegramChatId, tgMsg, options);
                console.log(`[DEBUG] נשלחה בקשת אישור לשמירה בטלגרם עם כפתורים.`);
            } else {
                // גיבוי לוואטסאפ במקרה שאין טלגרם
                const approvalMessage = `🔔 *הודעה ממשתמש לא מוכר!*\n\n*שם:* ${senderName}\n*הודעה מקורית:* ${originalMsg}\n\nהאם ברצונך לשמור את ${senderName}?\nהשב למטה בטקסט: *"כן"* כדי לשמור, או *"לא"* כדי לבטל.`;
                await client.sendMessage(myNumber, approvalMessage);
                console.log(`[DEBUG] נשלחה הודעת אישור לשמירה למספר של אמיר: ${myNumber}`);
            }
            
            await msg.reply("תודה, שמך נמסר. הודעתך המקורית הועברה בהצלחה לאמיר.");
        }
    }

    // --- זיהוי אוטומטי של תאריכים ופגישות ליומן ---
    if (!skipCalendar && msg.body && msg.body.trim() !== '') {
        // שלב מקדים: בודקים אם יש סיכוי בכלל שיש פה תאריך כדי לא להעמיס על ה-API
        if (preAnalyzeForCalendar(msg.body)) {
            const senderName = contact.name || senderNumber;
            const eventData = await analyzeForCalendarEvent(msg.body);
            if (eventData && eventData.hasEvent) {
                pendingCalendarEvents[senderNumber] = {
                    data: eventData,
                    title: `${senderName} זימן פגישה`,
                    description: msg.body
                };
                lastPendingAction = { type: 'calendar', target: senderNumber };
                
                const askMsg = `📅 *זיהוי אירוע ליומן!*\n\nהודעה מ-${senderName}:\n"${msg.body}"\n\nהאם תרצה לקבוע פגישה ביומן לאותו מועד?\nהשב *"כן"* כדי לקבל קישור להוספה מהירה ליומן גוגל, או *"לא"* כדי להתעלם.`;
                await client.sendMessage(myNumber, askMsg);
            }
        }
    }
});

async function handleGeminiCommand(msg, trigger) {
    // מנקה את הפקודה מהטריגר בצורה חכמה
    const prompt = msg.body.substring(trigger.length).replace(/^,/, '').trim(); // מסיר את הטריגר, פסיק אם קיים, ורווחים

    console.log(`מעביר לג'מיני את הפקודה: "${prompt}"`);
    await msg.reply(`מעבד את בקשתך לג'מיני... 🤖`);

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
                    await client.sendMessage(msg.from, `✅ הודעה נשלחה בהצלחה אל: ${contactNameOrPhone}`);
                } else {
                    await client.sendMessage(msg.from, `❌ לא נמצא איש קשר שמור בשם '${contactNameOrPhone}'. לא ניתן היה לשלוח את ההודעה.`);
                }
            }
        } else {
            // אם ג'מיני לא קרא לפונקציה, נשלח את תגובת הטקסט שלו
            const textResponse = result.response.text();
            await client.sendMessage(msg.from, `ג'מיני:\n${textResponse}`);
        }
    } catch (e) {
        console.error("שגיאה בתקשורת עם ג'מיני:", e);
        await client.sendMessage(msg.from, `שגיאה בעיבוד הבקשה מול ג'מיני.`);
    }
}

async function sendMessageToContact(contactNameOrPhone, message) {
    // בודק אם הקלט הוא מספר טלפון (מאפשר רווחים, מקפים ופלוס)
    const isPhoneNumber = /^[\+\d\s\-]+$/.test(contactNameOrPhone);
    
    if (isPhoneNumber) {
        let cleanNumber = contactNameOrPhone.replace(/\D/g, '');
        if (cleanNumber.startsWith('0')) {
            cleanNumber = '972' + cleanNumber.substring(1); // המרה לקידומת בינלאומית
        }
        const numberId = `${cleanNumber}@c.us`;
        await client.sendMessage(numberId, message);
        return true;
    }

    // אם זה שם, מחפשים את איש הקשר (חיפוש גמיש - מכיל את המילה)
    const contacts = await client.getContacts();
    const searchName = contactNameOrPhone.toLowerCase().trim();
    
    const targetContact = contacts.find(c => {
        // מתעלם מקבוצות, מאנשים שלא שמורים, ומאנשי קשר ללא שם
        if (c.isGroup || !c.isMyContact || !c.name) return false;
        // בודק אם השם המבוקש מוכל בשם השמור (למשל "עומריקו" ימצא את "עומריקו מהעבודה")
        return c.name.toLowerCase().includes(searchName);
    });

    if (targetContact) {
        await client.sendMessage(targetContact.id._serialized, message);
        return true;
    }

    return false; // איש הקשר לא נמצא
}

async function transcribeAudio(media) {
    try {
        // חזרנו למודל ה-Flash המהיר והזמין בוודאות בחשבון שלך
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

// --- פונקציות עזר לזיהוי וליצירת קישור יומן ---
function preAnalyzeForCalendar(text) {
    // בודק מילות מפתח ודפוסים נפוצים לפני ששולחים ל-API היקר
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
        return JSON.parse(rawText);
    } catch(e) {
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
    else endDate.setHours(endDate.getHours() + 1); // פגישה סטנדרטית של שעה

    const format = (d, allday) => {
        const pad = n => n.toString().padStart(2, '0');
        const str = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`;
        return allday ? str : `${str}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    };

    const dates = `${format(startDate, isAllDay)}/${format(endDate, isAllDay)}`;
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&details=${encodeURIComponent(description)}&dates=${dates}`;
}

// --- הפעלת השרת והסוכן ---
client.initialize();

server.listen(3000, () => {
    console.log('Web server listening on port 3000. Open http://localhost:3000 in your browser.');
});