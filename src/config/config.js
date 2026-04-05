require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');
const TelegramBot = require('node-telegram-bot-api');
const { TodoistApi } = require('@doist/todoist-sdk');
const fs = require('fs');

// --- Environment Variables ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const TODOIST_API_KEY = process.env.TODOIST_API_KEY;

// --- Google Settings ---
const SCOPES = ['https://www.googleapis.com/auth/contacts'];
const TOKEN_PATH = 'token.json';

// --- Gemini Settings ---
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// --- Telegram Settings ---
let telegramBot = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    telegramBot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
}

// --- Todoist Settings ---
const todoistApi = TODOIST_API_KEY ? new TodoistApi(TODOIST_API_KEY) : null;

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

// --- Constants ---
const CONTACTS_FILE = process.env.CONTACTS_FILE || './contacts.json';
const geminiTriggers = ['גמיני', "ג'ימיני", "ג׳ימיני", "ג'מיני", "ג׳מיני"];

module.exports = {
    GEMINI_API_KEY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
    TODOIST_API_KEY,
    SCOPES,
    TOKEN_PATH,
    genAI,
    telegramBot,
    todoistApi,
    tools,
    CONTACTS_FILE,
    geminiTriggers
};