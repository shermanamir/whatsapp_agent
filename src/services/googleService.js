const { google } = require('googleapis');
const fs = require('fs');
const readline = require('readline');
const { SCOPES, TOKEN_PATH } = require('../config/config');

function authorizeAndSaveContact(contactName, contactNumber, myNumber, sock) {
    fs.readFile('credentials.json', (err, content) => {
        if (err) {
            console.log('Error loading client secret file:', err);
            sock.sendMessage(myNumber + '@s.whatsapp.net', { text: '❌ שגיאה: לא נמצא קובץ credentials.json. לא ניתן לשמור את איש הקשר לגוגל.' });
            return;
        }
        const credentials = JSON.parse(content);
        const { client_secret, client_id, redirect_uris } = credentials.installed;
        const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

        fs.readFile(TOKEN_PATH, (err, token) => {
            if (err) {
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
                        saveToGoogleContacts(oAuth2Client, contactName, contactNumber, myNumber, sock);
                    });
                });
                return;
            }
            oAuth2Client.setCredentials(JSON.parse(token));
            saveToGoogleContacts(oAuth2Client, contactName, contactNumber, myNumber, sock);
        });
    });
}

function saveToGoogleContacts(auth, contactName, contactNumber, myNumber, sock) {
    const service = google.people({ version: 'v1', auth });
    service.people.createContact({
        requestBody: {
            names: [{ givenName: contactName }],
            phoneNumbers: [{ value: `+${contactNumber}` }]
        }
    }, (err, res) => {
        if (err) {
            console.error('API Error:', err.message);
            sock.sendMessage(myNumber + '@s.whatsapp.net', { text: `❌ שגיאה בשמירת איש הקשר לגוגל.` });
            return;
        }
        console.log(`איש הקשר ${contactName} נשמר בהצלחה לגוגל!`);
        sock.sendMessage(myNumber + '@s.whatsapp.net', { text: `✅ איש הקשר *${contactName}* נשמר בהצלחה לחשבון הגוגל שלך (Google Contacts)! תוך מספר שניות הוא יסתנכרן עם הטלפון.` });
    });
}

module.exports = {
    authorizeAndSaveContact,
    saveToGoogleContacts
};