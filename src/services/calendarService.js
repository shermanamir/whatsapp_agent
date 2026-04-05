const { genAI } = require('../config/config');

function preAnalyzeForCalendar(text) {
    const keywords = ['מחר', 'היום', 'שעה', 'ב-', 'בבוקר', 'בערב', 'בצהריים', 'יום', 'שבוע', 'פגישה'];
    const regex = new RegExp(keywords.join('|') + '|\\d{1,2}[\\/\\.:]\\d{1,2}', 'i');
    return regex.test(text);
}

async function analyzeForCalendarEvent(text) {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const now = new Date();
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-pro",
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
            console.error(`שגיאה בניתוח יומן (נסיון ${attempt + 1}/${maxRetries}):`, e);
            if (e.status === 429 && attempt < maxRetries - 1) {
                const delay = Math.pow(2, attempt) * 1000; // Exponential backoff: 1s, 2s, 4s
                console.log(`ממתין ${delay}ms לפני נסיון נוסף...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                attempt++;
            } else {
                return { hasEvent: false };
            }
        }
    }
    return { hasEvent: false };
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

module.exports = {
    preAnalyzeForCalendar,
    analyzeForCalendarEvent,
    createCalendarLink
};