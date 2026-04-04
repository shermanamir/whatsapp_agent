const { todoistApi } = require('../config/config');

async function createShoppingList(items, myNumber, sock) {
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

module.exports = {
    createShoppingList
};