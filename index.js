require('dotenv').config(); // טוען משתני סביבה מקובץ .env
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');

const SCOPES = ['https://www.googleapis.com/auth/contacts'];
const TOKEN_PATH = 'token.json';

// --- הגדרות Gemini ---
// ודא שיצרת קובץ .env עם המפתח שלך תחת השם GEMINI_API_KEY
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// מאגר זמני לשמירת מצב השיחה מול מספקים לא מוכרים
const pendingContacts = {};

const geminiTriggers = ['גמיני', "ג'ימיני", "ג׳ימיני", "ג'מיני", "ג׳מיני"]; // מילות טריגר להפעלת ג'מיני

const client = new Client({
    authStrategy: new LocalAuth(),
});

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

client.on('qr', (qr) => {
    console.log('הסוכן מוכן לחיבור! אנא סרוק את הברקוד עם אפליקציית הוואטסאפ שלך בטלפון:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('הסוכן התחבר לוואטסאפ בהצלחה וממתין להודעות!');
});

client.on('message_create', async msg => { // שינוי חשוב: מאזין גם להודעות שאתה שולח
    // התעלמות מעדכוני סטטוס, הודעות מערכת, וכתובות פנימיות של וואטסאפ (כמו @lid)
    if (msg.isStatus || msg.from === 'status@broadcast' || msg.from.includes('@lid') || msg.to.includes('@lid')) return;

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
                if (msg.from !== myNumber) {
                    // הודעה מאדם אחר - נתמלל ונשלח אליך
                    const senderName = contact.name || contact.number;
                    console.log(`[DEBUG] מתמלל הודעה קולית מ-${senderName}`);
                    const transcription = await transcribeAudio(media);
                    if (transcription) {
                        await msg.reply(`🎤 *תמלול (אוטומטי):*\n\n"${transcription.trim()}"`);
                    }
                } else if (msg.to === myNumber) {
                    // הודעה לעצמך - פקודה קולית לג'מיני
                    console.log(`[DEBUG] מפענח פקודה קולית ששלחת לעצמך`);
                    await client.sendMessage(myNumber, `🤖 מתמלל את הפקודה הקולית שלך...`);
                    const transcription = await transcribeAudio(media);
                    if (transcription) {
                        await client.sendMessage(myNumber, `🗣️ זיהיתי שאמרת: "${transcription.trim()}"\nמעביר לג'מיני...`);
                        msg.body = transcription.trim(); // משקרים לפונקציה של ג'מיני כאילו זו הודעת טקסט רגילה
                        await handleGeminiCommand(msg, ""); // הפעלה ללא טריגר מיוחד (העברת הטקסט במלואו)
                    }
                }
            }
        } catch (e) { console.error("שגיאה בטיפול בהודעה קולית:", e); }
        return; // עוצרים כאן כדי לא להמשיך לנתח הודעות קוליות כטקסט רגיל
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

                // אם לא סופק מספר, מחפשים את איש הקשר האחרון שממתין לאישור
                if (!targetNumber) {
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

    // מתעלמים מהודעות של קבוצות
    if (contact.isGroup) return;

    // ----- לוגיקה לאנשי קשר לא שמורים (לא מוכרים) -----
    if (!contact.isMyContact) {
        console.log(`[DEBUG] זוהתה הודעה מאיש קשר לא שמור: ${senderNumber}`);
        if (!pendingContacts[senderNumber]) {
            // שלב 1: איש קשר חדש לחלוטין שמייצר אינטראקציה ראשונה
            console.log(`[DEBUG] שלב 1: מתחיל אינטראקציה ראשונה מול ${senderNumber}, מבקש שם.`);
            pendingContacts[senderNumber] = {
                step: 'WAITING_FOR_NAME',
                originalMsg: msg.body
            };
            await msg.reply("מספר הטלפון שלך לא נמצא ברשימת אנשי הקשר של אמיר, אנא שלח את שמך המלא.");
            
        } else if (pendingContacts[senderNumber].step === 'WAITING_FOR_NAME') {
            // שלב 2: התקבל שם משתמש, כעת הסוכן מעביר הכל לאמיר
            const senderName = msg.body;
            const originalMsg = pendingContacts[senderNumber].originalMsg;
            console.log(`[DEBUG] שלב 2: התקבל השם '${senderName}' מהמספר ${senderNumber}. שולח בקשת אישור לאמיר...`);
            
            pendingContacts[senderNumber].step = 'WAITING_FOR_APPROVAL';
            pendingContacts[senderNumber].name = senderName;

            // שולח הודעה לוואטסאפ של הסוכן/שלך בשבילך
            const approvalMessage = `🔔 *הודעה ממשתמש לא מוכר!*\n\n*שם:* ${senderName}\n*הודעה מקורית:* ${originalMsg}\n\nהאם ברצונך לשמור את ${senderName}?\nהשב למטה בטקסט: *"כן"* כדי לשמור, או *"לא"* כדי לבטל.`;
            await client.sendMessage(myNumber, approvalMessage);
            console.log(`[DEBUG] נשלחה הודעת אישור לשמירה למספר של אמיר: ${myNumber}`);
            
            await msg.reply("תודה, שמך נמסר. הודעתך המקורית הועברה בהצלחה לאמיר.");
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

client.initialize();