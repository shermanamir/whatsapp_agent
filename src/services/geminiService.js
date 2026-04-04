const { genAI, tools } = require('../config/config');

async function handleGeminiCommand(body, trigger, jid, sock, sendMessageToContact) {
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

module.exports = {
    handleGeminiCommand,
    transcribeAudio
};