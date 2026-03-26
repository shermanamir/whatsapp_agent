# whatsapp_agent

This is an intelligent WhatsApp personal assistant powered by Node.js, `whatsapp-web.js`, and Google's Gemini 2.5 Flash AI model.

## Features

*   **AI-Powered Messaging:** Send messages to your contacts using natural language commands directly from your WhatsApp (e.g., "Gemini, text John that I'll be 5 minutes late"). The agent uses Gemini Function Calling to find the contact and send the message.
*   **Unknown Contact Management:** When an unknown number messages you, the agent automatically greets them, asks for their name, and sends you a private approval request.
*   **Google Contacts Integration:** If you approve a new contact, the agent uses the Google People API to automatically save their name and number directly to your Google Contacts.
*   **Voice Message Transcription:** Automatically transcribes incoming voice messages (PTT) to text and replies in the chat so you can read what was said without listening.
*   **Voice Commands:** You can send voice notes to the agent with commands, and it will transcribe and execute them seamlessly.

## Getting Started

1.  Clone the repository and run `npm install`.
2.  Create a `.env` file with your `GEMINI_API_KEY`.
3.  Place your Google Cloud OAuth 2.0 `credentials.json` file in the root directory (required for Google Contacts sync).
4.  Run `npm start`.
5.  Scan the QR code with your WhatsApp mobile app to connect.

*Note: The first time you run the agent and approve a contact, you will be prompted to authenticate with Google via the terminal.*
