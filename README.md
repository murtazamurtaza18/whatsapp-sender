# WhatsApp Sender Service

Node.js service for sending WhatsApp messages using whatsapp-web.js.

## 🚀 Quick Start

### Local Development

```bash
# Install dependencies
npm install

# Start service
npm start

# Or with custom port
PORT=3003 npm start
```

### Environment Variables

- `PORT` - Server port (default: 3003, Render sets this automatically)
- `WHATSAPP_CORS_ORIGIN` - Allowed CORS origin (default: https://marketing.aispectraa.com)
- `WHATSAPP_API_KEY` - API key for authentication (optional)
- `WHATSAPP_MESSAGE_LIMIT` - Daily message limit per user (default: 1000)
- `WHATSAPP_CONCURRENT_MESSAGES` - Concurrent messages (default: 3)
- `WHATSAPP_MESSAGE_DELAY` - Delay between messages in ms (default: 500)

## 📦 Deployment to Render.com

See `RENDER_DEPLOYMENT_GUIDE.md` in the root directory for complete instructions.

### Quick Deploy Steps:

1. Push this folder to GitHub
2. Create new Web Service on Render.com
3. Connect GitHub repository
4. Set environment variables
5. Deploy!

## 🔌 API Endpoints

- `GET /health` - Health check
- `GET /session?userId=X` - Get session status/QR code
- `POST /reset` - Reset session (body: `{"userId": "X"}`)
- `POST /logout` - Logout session (body: `{"userId": "X"}`)
- `POST /send-bulk` - Send bulk messages (body: `{"userId": "X", "recipients": [...]}`)

## 📝 Notes

- Sessions are stored in `sessions/` directory
- Message counters in `message_counters.json`
- Service uses Puppeteer to control WhatsApp Web
- Requires Node.js 18+

