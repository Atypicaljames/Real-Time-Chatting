# RGC

A modern realtime group chat web app with a clean, polished UI built using Express, Socket.io, and MongoDB.

## Features

- Real-time messaging with Socket.io
- Message persistence in MongoDB
- Responsive, professional UI with a polished sidebar layout
- Registered users list shown in the left sidebar
- Message history on connect
- Typing indicator for other participants
- Read receipts for delivered messages
- File attachments for images, documents, and more
- Voice note recording and instant sharing
- Secure user login, registration, and logout
- Send message using a paper plane icon inside the composer
- Edit or delete your own messages by clicking on them
- WhatsApp-style chat experience focused on the default General group
- Live group preview for the General conversation

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start MongoDB locally or configure a MongoDB connection string using `MONGODB_URI`.

3. Run the app:

   ```bash
   npm start
   ```

4. Open your browser at `http://127.0.0.1:3001`.

If port `3001` is already in use, set a different port before starting:

```bash
PORT=4000 npm start
```

If MongoDB is not available during startup, the app will still run using an in-memory fallback store for local testing. Message and user data will not persist after the server restarts unless MongoDB is connected.

## Environment variables

- `PORT` - Server port (default: 3001)
- `MONGODB_URI` - MongoDB connection URI (default: `mongodb://127.0.0.1:27017/realtime-chat`)
- `SESSION_SECRET` - Secret used to sign user sessions (default: `realtime-chat-secret`)
