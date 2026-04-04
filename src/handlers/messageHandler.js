const { getContentType, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { telegramBot, TELEGRAM_CHAT_ID, geminiTriggers } = require('../config/config');
const { handleGeminiCommand, transcribeAudio } = require('../services/geminiService');
const { preAnalyzeForCalendar, analyzeForCalendarEvent, createCalendarLink } = require('../services/calendarService');
const { createShoppingList, deleteShoppingList, deleteAllShoppingLists, deleteShoppingListItem, getShoppingList, shareShoppingList } = require('../services/todoistService');
const { authorizeAndSaveContact } = require('../services/googleService');
const { sendMessageToContact } = require('../services/whatsappService');

let pendingContacts = {};
let pendingCalendarEvents = {};
let lastPendingAction = null;

function setupTelegramCallbacks(sock) {
    if (!telegramBot) return;

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
                    authorizeAndSaveContact(targetName, targetNumber, myNumber, sock);
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

async function handleMessage(sock, m, myContacts, saveContacts) {
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
                        await telegramBot.sendMessage(TELEGRAM_CHAT_ID, `${senderName} - אמר : "${transcription.trim()}"`).catch(console.error);
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
            await sock.sendMessage(remoteJid, { text: "אינך מופיע באנשי הקשר שלי אנא שלח את שמך המלא על מנת שאשמור אותך באנשי הקשר שלי" }, { quoted: msg });
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
                await telegramBot.sendMessage(TELEGRAM_CHAT_ID, tgMsg, options).catch(console.error);
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
            await handleGeminiCommand(body, trigger, myJid, sock, (contact, message) => sendMessageToContact(contact, message, myContacts));
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
                        authorizeAndSaveContact(targetName, targetNumber, myNumberBase, sock);
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
                    await telegramBot.sendMessage(TELEGRAM_CHAT_ID, tgMsg, options).catch(console.error);
                } else {
                    const directionText = fromMe ? `ששלחת ל-${chatName}` : `מ-${chatName}`;
                    const askMsg = `📅 *זיהוי אירוע ליומן!*\n\nהודעה ${directionText}:\n"${body}"\n\nהאם תרצה לקבוע פגישה ביומן לאותו מועד?\nהשב *"כן"* כדי לקבל קישור להוספה מהירה ליומן גוגל, או *"לא"* כדי להתעלם.`;
                    await sock.sendMessage(myJid, { text: askMsg });
                }
            }
        }
    }

    // 5. Check for shopping list commands
    if (body) {
        const lowerBody = body.toLowerCase();

        // Delete all shopping lists
        if (lowerBody === 'מחק את כל רשימות הקניות' || lowerBody === 'תמחק את כל רשימות הקניות') {
            await deleteAllShoppingLists(senderNumber, sock);
            return;
        }

        // Delete specific shopping list
        const deleteListMatch = body.match(/^(?:ת)?מחק רשימת קניות(?: \[([^\]]+)\])?$/i);
        if (deleteListMatch) {
            const listName = deleteListMatch[1] || 'רשימת קניות';
            await deleteShoppingList(listName, senderNumber, sock);
            return;
        }

        // Delete item from shopping list
        const deleteItemMatch = body.match(/^(?:ת)?מחק מרשימת קניות(?: \[([^\]]+)\])?:\s*(.+)$/i);
        if (deleteItemMatch) {
            const listName = deleteItemMatch[1] || 'רשימת קניות';
            const itemName = deleteItemMatch[2].trim();
            await deleteShoppingListItem(listName, itemName, senderNumber, sock);
            return;
        }

        // Share shopping list with contact
        const shareMatch = body.match(/^(?:ת)?שתף רשימת קניות(?: \[([^\]]+)\])? עם (.+)$/i);
        if (shareMatch) {
            const listName = shareMatch[1] || 'רשימת קניות';
            const contactName = shareMatch[2].trim();
            await shareShoppingList(listName, contactName, senderNumber, sock);
            return;
        }

        // Create/Add to shopping list
        if (lowerBody.startsWith('רשימת קניות')) {
            const listText = body.substring('רשימת קניות'.length).trim();

            // בדוק אם יש שם רשימה ספציפי בפורמט [שם]
            let listName = null;
            let itemsText = listText;

            const bracketMatch = listText.match(/^\[([^\]]+)\]:\s*(.+)$/);
            if (bracketMatch) {
                listName = bracketMatch[1].trim();
                itemsText = bracketMatch[2].trim();
            } else if (listText.startsWith(':')) {
                itemsText = listText.substring(1).trim();
            }

            if (itemsText) {
                const items = itemsText.split(',').map(item => item.trim()).filter(item => item);
                if (items.length > 0) {
                    await createShoppingList(items, senderNumber, sock, listName);
                } else {
                    const example = listName
                        ? `רשימת קניות [${listName}]: חלב, לחם, ביצים`
                        : 'רשימת קניות: חלב, לחם, ביצים';
                    await sock.sendMessage(remoteJid, { text: `לא מצאתי פריטים ברשימת הקניות. נסה: "${example}"` }, { quoted: msg });
                }
            } else {
                const example = listName
                    ? `רשימת קניות [${listName}]: פריט1, פריט2, פריט3`
                    : 'רשימת קניות: פריט1, פריט2, פריט3';
                await sock.sendMessage(remoteJid, { text: `איך להשתמש: "${example}"` }, { quoted: msg });
            }
            return; // Stop processing this message
        }
    }
}

module.exports = {
    setupTelegramCallbacks,
    handleMessage
};