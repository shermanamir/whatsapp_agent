const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');

// Import services and handlers
const { connectToWhatsApp, getIsAgentReady, setIsAgentReady } = require('./services/whatsappService');
const { setupTelegramCallbacks, handleMessage } = require('./handlers/messageHandler');
const { CONTACTS_FILE } = require('./config/config');

// --- In-memory Stores ---
let myContacts = {};
if (fs.existsSync(CONTACTS_FILE)) {
    try {
        myContacts = JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf-8'));
    } catch (e) { console.error('Error loading contacts:', e); }
}
const saveContacts = () => fs.writeFileSync(CONTACTS_FILE, JSON.stringify(myContacts));

// --- Web Server Settings ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Express Endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'setup.html'));
});

app.get('/api/status', (req, res) => {
    const fs = require('fs');
    const path = require('path');

    // Check environment variables
    const envStatus = {
        GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
        TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
        TELEGRAM_CHAT_ID: !!process.env.TELEGRAM_CHAT_ID,
        TODOIST_API_KEY: !!process.env.TODOIST_API_KEY
    };

    // Check files
    const credentialsPath = path.join(__dirname, '..', 'credentials.json');
    const authPath = path.join(__dirname, '..', 'auth_info_baileys', 'creds.json');
    const contactsPath = path.join(__dirname, '..', 'contacts.json');

    const fileStatus = {
        credentials: fs.existsSync(credentialsPath),
        auth: fs.existsSync(authPath),
        contacts: fs.existsSync(contactsPath)
    };

    // Check WhatsApp connection
    const isConnected = getIsAgentReady();

    res.json({
        environment: envStatus,
        files: fileStatus,
        whatsapp: {
            connected: isConnected
        },
        timestamp: new Date().toISOString()
    });
});

// --- Start Server and Agent ---
async function startApp() {
    const sock = await connectToWhatsApp(io);

    // Setup contacts handling
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

    // Setup message handling
    sock.ev.on('messages.upsert', async m => {
        if (m.type !== 'notify') return;
        // התעלמות מכל הודעה שהגיעה לפני שהחיבור הושלם
        if (!getIsAgentReady()) return;

        await handleMessage(sock, m, myContacts, saveContacts);
    });

    // Setup Telegram callbacks
    setupTelegramCallbacks(sock);
}

startApp();

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Web server listening on port ${PORT}. Open http://localhost:${PORT} in your browser.`);
});
