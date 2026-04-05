const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, getContentType, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeGenerator = require('qrcode');

let sock;
let isAgentReady = false;
let isReconnecting = false;

async function connectToWhatsApp(io) {
    const sessionDir = process.env.SESSION_DIR || 'auth_info_baileys';
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // שליפת הגרסה העדכנית ביותר של וואטסאפ כדי למנוע דחיית חיבור
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'), // חזרה לדפדפן רשמי - וואטסאפ חוסמת שמות מותאמים אישית
        keepAliveIntervalMs: 30000 // שליחת אות חיים כל 30 שניות למניעת ניתוקים
    });

    // האזנה ושמירה של אנשי קשר לקובץ מקומי קליל
    sock.ev.on('contacts.upsert', (contacts) => {
        // This will be handled in the main file
    });
    sock.ev.on('contacts.update', (updates) => {
        // This will be handled in the main file
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
                setTimeout(() => connectToWhatsApp(io), 5000);
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
        }
    });

    return sock;
}

async function sendMessageToContact(contactNameOrPhone, message, myContacts) {
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

function getIsAgentReady() {
    return isAgentReady;
}

function setIsAgentReady(ready) {
    isAgentReady = ready;
}

module.exports = {
    connectToWhatsApp,
    sendMessageToContact,
    getIsAgentReady,
    setIsAgentReady
};