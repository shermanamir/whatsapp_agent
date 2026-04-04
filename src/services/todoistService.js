const { todoistApi } = require('../config/config');
const fs = require('fs');

async function createShoppingList(items, myNumber, sock, listName = null) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        // אם לא צוין שם רשימה, השתמש ב"רשימת קניות" כברירת מחדל
        const defaultProjectName = 'רשימת קניות';
        const projectName = listName || defaultProjectName;

        // חפש פרויקט קיים עם השם הזה
        let project = null;
        try {
            const projects = await todoistApi.getProjects();
            project = projects.find(p => p.name === projectName);
        } catch (e) {
            console.log('לא הצלחנו לקבל רשימת פרויקטים:', e.message);
        }

        // אם הפרויקט לא קיים, צור אותו
        let isNewProject = false;
        if (!project) {
            project = await todoistApi.addProject({ name: projectName });
            isNewProject = true;
        }

        // הוסף את הפריטים לפרויקט
        let addedCount = 0;
        for (const item of items) {
            try {
                await todoistApi.addTask({
                    content: item.trim(),
                    projectId: project.id
                });
                addedCount++;
            } catch (e) {
                console.error(`שגיאה בהוספת פריט "${item}":`, e.message);
            }
        }

        // שלח הודעה למשתמש
        let message = '';
        if (isNewProject) {
            message = `✅ רשימת קניות חדשה נוצרה ב-Todoist!\n📝 רשימה: ${projectName}\n🛒 פריטים שנוספו: ${addedCount}`;
        } else {
            message = `✅ פריטים נוספו לרשימת הקניות הקיימת!\n📝 רשימה: ${projectName}\n🛒 פריטים שנוספו: ${addedCount}`;
        }

        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: message });

    } catch (e) {
        console.error('שגיאה ביצירת/עדכון רשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה ביצירת/עדכון רשימת קניות ב-Todoist.' });
    }
}

async function deleteShoppingList(listName, myNumber, sock) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        const projects = await todoistApi.getProjects();
        const project = projects.find(p => p.name === listName);

        if (!project) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `❌ לא נמצאה רשימת קניות בשם "${listName}".` });
            return;
        }

        await todoistApi.deleteProject(project.id);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `✅ רשימת הקניות "${listName}" נמחקה בהצלחה!` });

    } catch (e) {
        console.error('שגיאה במחיקת רשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה במחיקת רשימת הקניות.' });
    }
}

async function deleteAllShoppingLists(myNumber, sock) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        const projects = await todoistApi.getProjects();
        const shoppingLists = projects.filter(p => p.name.includes('רשימת קניות') || p.name.includes('קניות'));

        if (shoppingLists.length === 0) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ לא נמצאו רשימות קניות למחיקה.' });
            return;
        }

        let deletedCount = 0;
        for (const project of shoppingLists) {
            try {
                await todoistApi.deleteProject(project.id);
                deletedCount++;
            } catch (e) {
                console.error(`שגיאה במחיקת רשימה "${project.name}":`, e.message);
            }
        }

        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `✅ נמחקו ${deletedCount} רשימות קניות בהצלחה!` });

    } catch (e) {
        console.error('שגיאה במחיקת כל רשימות הקניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה במחיקת רשימות הקניות.' });
    }
}

async function deleteShoppingListItem(listName, itemName, myNumber, sock) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        const projects = await todoistApi.getProjects();
        const project = projects.find(p => p.name === listName);

        if (!project) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `❌ לא נמצאה רשימת קניות בשם "${listName}".` });
            return;
        }

        // קבל את כל המשימות בפרויקט
        const tasks = await todoistApi.getTasks({ projectId: project.id });

        // חפש משימה שתואמת את שם הפריט (חיפוש חלקי)
        const task = tasks.find(t => t.content.toLowerCase().includes(itemName.toLowerCase()));

        if (!task) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `❌ לא נמצא פריט "${itemName}" ברשימת הקניות "${listName}".` });
            return;
        }

        await todoistApi.deleteTask(task.id);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `✅ הפריט "${task.content}" נמחק מרשימת הקניות "${listName}"!` });

    } catch (e) {
        console.error('שגיאה במחיקת פריט מרשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה במחיקת הפריט מרשימת הקניות.' });
    }
}

async function getShoppingList(listName, myNumber, sock) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return null;
    }

    try {
        const projects = await todoistApi.getProjects();
        const project = projects.find(p => p.name === listName);

        if (!project) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `❌ לא נמצאה רשימת קניות בשם "${listName}".` });
            return null;
        }

        // קבל את כל המשימות בפרויקט
        const tasks = await todoistApi.getTasks({ projectId: project.id });

        if (tasks.length === 0) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `📝 רשימת הקניות "${listName}" ריקה.` });
            return null;
        }

        return {
            name: project.name,
            items: tasks.map(task => task.content)
        };

    } catch (e) {
        console.error('שגיאה בקבלת רשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה בקבלת רשימת הקניות.' });
        return null;
    }
}

async function shareShoppingList(listName, contactName, myNumber, sock) {
    if (!todoistApi) {
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ Todoist API key לא מוגדר. הוסף TODOIST_API_KEY ל-.env.' });
        return;
    }

    try {
        // קבל את הרשימה
        const shoppingList = await getShoppingList(listName, myNumber, sock);
        if (!shoppingList) return;

        // מצא את איש הקשר
        const contacts = JSON.parse(fs.readFileSync('contacts.json', 'utf8'));
        const contactEntry = Object.entries(contacts).find(([number, name]) => 
            name.toLowerCase().includes(contactName.toLowerCase()) ||
            contactName.toLowerCase().includes(name.toLowerCase())
        );

        if (!contactEntry) {
            await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: `❌ לא נמצא איש קשר בשם "${contactName}".` });
            return;
        }

        const [contactNumber, contactNameFound] = contactEntry;

        // צור הודעה עם הרשימה
        let message = `🛒 רשימת קניות: ${shoppingList.name}\n\n`;
        shoppingList.items.forEach((item, index) => {
            message += `${index + 1}. ${item}\n`;
        });
        message += `\n📱 נשלח על ידי ${sock.user?.notify || 'הסוכן שלי'}`;

        // שלח את ההודעה לאיש הקשר
        const contactJid = `${contactNumber}@s.whatsapp.net`;
        await sock.sendMessage(contactJid, { text: message });

        // אשר למשתמש
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { 
            text: `✅ רשימת הקניות "${shoppingList.name}" נשלחה בהצלחה ל-${contactNameFound}!` 
        });

    } catch (e) {
        console.error('שגיאה בשיתוף רשימת קניות:', e);
        await sock.sendMessage(`${myNumber}@s.whatsapp.net`, { text: '❌ שגיאה בשיתוף רשימת הקניות.' });
    }
}

module.exports = {
    createShoppingList,
    deleteShoppingList,
    deleteAllShoppingLists,
    deleteShoppingListItem,
    getShoppingList,
    shareShoppingList
};