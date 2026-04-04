#!/bin/bash

echo "🤖 בודק התקנת סוכן וואטסאפ AI..."
echo "=================================="

# Check Node.js version
echo "📦 בודק גרסת Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js לא מותקן. אנא התקן Node.js 18 או גבוה יותר מ-https://nodejs.org"
    exit 1
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ גרסת Node.js נמוכה מדי ($NODE_VERSION). נדרש Node.js 18 או גבוה יותר."
    exit 1
fi
echo "✅ Node.js $NODE_VERSION מותקן"

# Check npm
echo "📦 בודק npm..."
if ! command -v npm &> /dev/null; then
    echo "❌ npm לא מותקן"
    exit 1
fi
echo "✅ npm מותקן"

# Check if .env exists
echo "🔧 בודק קובץ .env..."
if [ ! -f ".env" ]; then
    echo "⚠️  קובץ .env לא נמצא"
    if [ -f ".env.example" ]; then
        echo "📋 מעתיק .env.example ל-.env..."
        cp .env.example .env
        echo "✅ הועתק. אנא ערוך את .env עם המפתחות שלך"
    else
        echo "❌ קובץ .env.example לא נמצא"
        exit 1
    fi
else
    echo "✅ קובץ .env קיים"
fi

# Check if credentials.json exists
echo "🔑 בודק קובץ credentials.json..."
if [ ! -f "credentials.json" ]; then
    echo "⚠️  קובץ credentials.json לא נמצא"
    echo "📋 צור קובץ credentials.json עם אישורי Google Cloud:"
    echo "   1. היכנס ל-https://console.cloud.google.com/apis/credentials"
    echo "   2. צור OAuth 2.0 credentials"
    echo "   3. הורד את credentials.json ושם אותו בתיקייה זו"
else
    echo "✅ קובץ credentials.json קיים"
fi

# Install dependencies
echo "📦 מתקין תלויות..."
if npm install; then
    echo "✅ תלויות הותקנו בהצלחה"
else
    echo "❌ שגיאה בהתקנת תלויות"
    exit 1
fi

# Create auth directory
echo "📁 יוצר תיקיית אימות..."
mkdir -p auth_info_baileys
echo "✅ תיקיית auth_info_baileys נוצרה"

echo ""
echo "🎉 בדיקת ההתקנה הושלמה!"
echo ""
echo "📋 השלבים הבאים:"
echo "   1. ערוך את קובץ .env עם המפתחות שלך"
echo "   2. וודא ש-credentials.json קיים"
echo "   3. הרץ 'npm start' כדי להתחיל"
echo "   4. פתח http://localhost:3000/setup לבדוק סטטוס"
echo ""
echo "📖 למדריך מלא: קרא את README.md"
echo "🆘 לעזרה: פתח issue ב-GitHub"