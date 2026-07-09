const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7,
});

const PORT = process.env.PORT || 3001;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/realtime-chat';
const SESSION_SECRET = process.env.SESSION_SECRET || 'realtime-chat-secret';

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' },
});

app.use(express.json({ limit: '12mb' }));
app.use(sessionMiddleware);
app.get('/health', (req, res) => res.send('OK'));
app.use(express.static(path.join(__dirname, 'public')));

const attachmentSchema = new mongoose.Schema(
  {
    fileName: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    groupId: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    userName: { type: String, required: true, trim: true, maxlength: 50 },
    text: { type: String, trim: true, maxlength: 1000, default: '' },
    attachments: { type: [attachmentSchema], default: [] },
    readBy: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, lowercase: true, trim: true, unique: true },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
    passwordHash: { type: String, required: true },
  },
  { versionKey: false },
);

const groupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, trim: true, maxlength: 200, default: '' },
    members: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

const Message = mongoose.model('Message', messageSchema);
const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);

let dbReady = false;
let memoryDb = {
  users: [],
  groups: [],
  messages: [],
};

function createMemoryId() {
  return new mongoose.Types.ObjectId();
}

function getRecordId(record) {
  return record._id ? String(record._id) : null;
}

async function findUserByUsername(username) {
  const normalizedUsername = String(username).trim().toLowerCase();
  if (dbReady) {
    return User.findOne({ username: normalizedUsername });
  }
  return memoryDb.users.find((user) => user.username === normalizedUsername) || null;
}

async function createUserRecord({ username, displayName, passwordHash }) {
  if (dbReady) {
    return User.create({ username, displayName, passwordHash });
  }
  const newUser = {
    _id: createMemoryId(),
    username,
    displayName,
    passwordHash,
  };
  memoryDb.users.push(newUser);
  return newUser;
}

async function findAllUsers() {
  if (dbReady) {
    return User.find().sort({ displayName: 1 }).lean();
  }
  return [...memoryDb.users].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function buildUserPayload(user) {
  return {
    username: user.username,
    displayName: user.displayName,
  };
}

async function broadcastUserList() {
  try {
    const users = await findAllUsers();
    io.emit('users updated', users.map(buildUserPayload));
  } catch (error) {
    console.error('Broadcast user list failed:', error);
  }
}

async function findAllGroups() {
  if (dbReady) {
    return Group.find().sort({ createdAt: 1 }).lean();
  }
  return [...memoryDb.groups].sort((a, b) => a.createdAt - b.createdAt);
}

async function createGroupRecord({ name, description }) {
  if (dbReady) {
    return Group.create({ name, description });
  }
  const group = { _id: createMemoryId(), name, description, members: [], createdAt: new Date() };
  memoryDb.groups.push(group);
  return group;
}

async function getGroupById(groupId) {
  if (dbReady) {
    return Group.findById(groupId).lean();
  }
  return memoryDb.groups.find((group) => String(group._id) === String(groupId)) || null;
}

async function deleteGroupRecord(groupId) {
  if (dbReady) {
    await Message.deleteMany({ groupId });
    return Group.findByIdAndDelete(groupId);
  }
  memoryDb.messages = memoryDb.messages.filter((message) => String(message.groupId) !== String(groupId));
  memoryDb.groups = memoryDb.groups.filter((group) => String(group._id) !== String(groupId));
  return true;
}

async function findMessagesByGroup(groupId) {
  if (dbReady) {
    return Message.find({ groupId }).sort({ createdAt: 1 }).lean();
  }
  return memoryDb.messages
    .filter((message) => String(message.groupId) === String(groupId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

async function findMessageById(messageId) {
  if (dbReady) {
    return Message.findById(messageId);
  }
  return memoryDb.messages.find((message) => String(message._id) === String(messageId)) || null;
}

async function createMessageRecord({ groupId, userId, userName, text, attachments }) {
  if (dbReady) {
    return Message.create({ groupId, userId, userName, text, attachments });
  }
  const message = {
    _id: createMemoryId(),
    groupId: createMemoryId(groupId),
    userId: createMemoryId(userId),
    userName,
    text,
    attachments,
    readBy: [],
    createdAt: new Date(),
  };
  message.groupId = groupId;
  message.userId = userId;
  memoryDb.messages.push(message);
  return message;
}

function buildMessagePayload(message) {
  const attachments = (message.attachments || []).map((attachment, index) => ({
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    size: attachment.size,
    url: `/attachment/${message._id}/${index}`,
  }));

  return {
    _id: String(message._id),
    groupId: String(message.groupId),
    userId: String(message.userId),
    userName: message.userName,
    text: message.text,
    attachments,
    readBy: message.readBy || [],
    createdAt: message.createdAt,
  };
}

async function initDefaultGroups() {
  const groups = await findAllGroups();
  const generalGroups = groups.filter((group) => group.name === 'General');
  const otherGroups = groups.filter((group) => group.name !== 'General');

  for (const group of otherGroups) {
    await deleteGroupRecord(group._id);
  }

  if (generalGroups.length === 0) {
    await createGroupRecord({ name: 'General', description: 'Community space for everyone' });
  } else if (generalGroups.length > 1) {
    const [, ...duplicateGenerals] = generalGroups;
    for (const duplicate of duplicateGenerals) {
      await deleteGroupRecord(duplicate._id);
    }
  }
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/register', async (req, res) => {
  const { username, displayName, password } = req.body;
  if (!username || !displayName || !password) {
    return res.status(400).json({ error: 'Username, display name and password are required.' });
  }

  try {
    const normalizedUsername = String(username).trim().toLowerCase();
    const existingUser = await findUserByUsername(normalizedUsername);
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUserRecord({ username: normalizedUsername, displayName: String(displayName).trim(), passwordHash });

    req.session.userId = String(user._id);
    req.session.username = user.username;
    req.session.displayName = user.displayName;
    res.json({ user: { username: user.username, displayName: user.displayName } });
    broadcastUserList();
  } catch (error) {
    console.error('Registration failed:', error);
    res.status(500).json({ error: 'Registration failed.' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const normalizedUsername = String(username).trim().toLowerCase();
    const user = await findUserByUsername(normalizedUsername);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const validPassword = await bcrypt.compare(password, user.passwordHash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    req.session.userId = String(user._id);
    req.session.username = user.username;
    req.session.displayName = user.displayName;
    res.json({ user: { username: user.username, displayName: user.displayName } });
    broadcastUserList();
  } catch (error) {
    console.error('Login failed:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
});

app.post('/api/logout', requireAuth, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout failed:', err);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.json({ success: true });
  });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { username: req.session.username, displayName: req.session.displayName } });
});

app.get('/api/groups', requireAuth, async (req, res) => {
  try {
    const groups = await findAllGroups();
    const groupSummaries = await Promise.all(groups.map(async (group) => {
      const messages = await findMessagesByGroup(group._id);
      const lastMessage = messages.length ? messages[messages.length - 1] : null;
      return {
        _id: String(group._id),
        name: group.name,
        description: group.description,
        lastMessage: lastMessage ? {
          text: String(lastMessage.text || '').slice(0, 70),
          createdAt: lastMessage.createdAt,
          userName: lastMessage.userName,
        } : null,
        messageCount: messages.length,
      };
    }));
    res.json({ groups: groupSummaries });
  } catch (error) {
    console.error('Load groups failed:', error);
    res.status(500).json({ error: 'Unable to load groups.' });
  }
});

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    const users = await findAllUsers();
    const userList = users.map((user) => ({
      username: user.username,
      displayName: user.displayName,
    }));
    res.json({ users: userList });
  } catch (error) {
    console.error('Load users failed:', error);
    res.status(500).json({ error: 'Unable to load users.' });
  }
});

app.post('/api/groups', requireAuth, async (req, res) => {
  const { name, description } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Group name is required.' });
  }

  try {
    const group = await createGroupRecord({ name: String(name).trim(), description: String(description || '').trim() });
    res.json({ group: { _id: String(group._id), name: group.name, description: group.description } });
  } catch (error) {
    console.error('Create group failed:', error);
    res.status(500).json({ error: 'Unable to create group.' });
  }
});

app.delete('/api/groups/:groupId', requireAuth, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const group = await getGroupById(groupId);
    if (!group) {
      return res.status(404).json({ error: 'Group not found.' });
    }
    await deleteGroupRecord(groupId);
    res.json({ success: true, groupId });
  } catch (error) {
    console.error('Delete group failed:', error);
    res.status(500).json({ error: 'Unable to delete group.' });
  }
});

app.put('/api/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const messageId = req.params.messageId;
    const { text } = req.body;
    const message = await findMessageById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    if (String(message.userId) !== String(req.session.userId)) {
      return res.status(403).json({ error: 'You may only edit your own messages.' });
    }

    const trimmedText = String(text || '').trim();
    if (!trimmedText && !(message.attachments && message.attachments.length)) {
      return res.status(400).json({ error: 'Message text cannot be empty.' });
    }

    message.text = trimmedText;
    if (dbReady) {
      await message.save();
    }

    const payload = buildMessagePayload(message);
    io.to(`group_${payload.groupId}`).emit('message edited', payload);
    res.json({ message: payload });
  } catch (error) {
    console.error('Edit message failed:', error);
    res.status(500).json({ error: 'Unable to edit message.' });
  }
});

app.delete('/api/messages/:messageId', requireAuth, async (req, res) => {
  try {
    const messageId = req.params.messageId;
    const message = await findMessageById(messageId);
    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    const groupId = String(message.groupId);
    if (dbReady) {
      await Message.deleteOne({ _id: messageId });
    } else {
      memoryDb.messages = memoryDb.messages.filter((stored) => String(stored._id) !== String(messageId));
    }

    io.to(`group_${groupId}`).emit('message deleted', { messageId, groupId });
    res.json({ success: true, messageId, groupId });
  } catch (error) {
    console.error('Delete message failed:', error);
    res.status(500).json({ error: 'Unable to delete message.' });
  }
});

app.get('/attachment/:messageId/:index', async (req, res) => {
  const { messageId, index } = req.params;
  const attachmentIndex = Number(index);
  if (Number.isNaN(attachmentIndex)) {
    return res.status(400).send('Invalid attachment index');
  }

  try {
    const message = await findMessageById(messageId);
    if (!message || !message.attachments || !message.attachments[attachmentIndex]) {
      return res.status(404).send('Attachment not found');
    }

    const attachment = message.attachments[attachmentIndex];
    const dispositionType = attachment.contentType.startsWith('audio/') ? 'inline' : 'attachment';
    res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `${dispositionType}; filename="${attachment.fileName}"`);
    res.send(Buffer.from(attachment.data));
  } catch (error) {
    console.error('Attachment retrieval failed:', error);
    res.status(500).send('Unable to retrieve attachment');
  }
});

function getSession(socket) {
  return socket.request.session;
}

io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

io.use((socket, next) => {
  const session = getSession(socket);
  if (session && session.userId) {
    return next();
  }
  next(new Error('Unauthorized'));
});

io.on('connection', (socket) => {
  const session = getSession(socket);
  console.log('Client connected:', socket.id, session.username);

  socket.join('global');
  io.to('global').emit('user count', io.sockets.sockets.size);
  broadcastUserList();

  socket.on('join group', async ({ groupId }) => {
    try {
      if (socket.currentGroup) {
        socket.leave(`group_${socket.currentGroup}`);
      }
      socket.currentGroup = String(groupId);
      const groupRoom = `group_${socket.currentGroup}`;
      socket.join(groupRoom);

      const messages = await findMessagesByGroup(socket.currentGroup);
      socket.emit('group messages', messages.map(buildMessagePayload));
    } catch (error) {
      console.error('Join group failed:', error);
      socket.emit('error', { message: 'Unable to join group.' });
    }
  });

  socket.on('typing', ({ groupId }) => {
    if (!groupId) {
      return;
    }
    socket.to(`group_${groupId}`).emit('typing', { name: session.displayName, groupId });
  });

  socket.on('stop typing', ({ groupId }) => {
    if (!groupId) {
      return;
    }
    socket.to(`group_${groupId}`).emit('stop typing', { groupId });
  });

  socket.on('send message', async (payload) => {
    if (!payload?.groupId) {
      return;
    }

    const text = String(payload.text || '').trim();
    const attachments = [];
    if (payload.attachment && payload.attachment.data) {
      try {
        attachments.push({
          fileName: String(payload.attachment.fileName || 'attachment'),
          contentType: String(payload.attachment.contentType || 'application/octet-stream'),
          size: Number(payload.attachment.size || 0),
          data: Buffer.from(payload.attachment.data),
        });
      } catch (error) {
        console.error('Invalid attachment payload:', error);
      }
    }

    if (!text && attachments.length === 0) {
      return;
    }

    try {
      const message = await createMessageRecord({
        groupId: payload.groupId,
        userId: session.userId,
        userName: session.displayName,
        text,
        attachments,
      });
      const payloadMessage = buildMessagePayload(message);
      io.to(`group_${payload.groupId}`).emit('new message', payloadMessage);
    } catch (error) {
      console.error('Save message failed:', error);
      socket.emit('save error', 'Unable to save message. Please try again.');
    }
  });

  socket.on('message read', async ({ messageId, groupId }) => {
    if (!messageId || !groupId) {
      return;
    }

    try {
      const message = await findMessageById(messageId);
      if (!message || String(message.groupId) !== String(groupId)) {
        return;
      }

      if (!message.readBy.includes(session.displayName)) {
        message.readBy.push(session.displayName);
        if (dbReady) {
          await message.save();
        }
        io.to(`group_${groupId}`).emit('message read update', {
          messageId,
          readBy: message.readBy,
          groupId,
        });
      }
    } catch (error) {
      console.error('Update read receipt failed:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    io.to('global').emit('user count', io.sockets.sockets.size);
  });
});

async function startServer() {
  try {
    await mongoose.connect(MONGODB_URI);
    dbReady = true;
    console.log('MongoDB connected');
  } catch (error) {
    dbReady = false;
    console.error('MongoDB connection error:', error);
    console.log('Starting server with in-memory fallback storage. MongoDB is optional for local testing.');
  }

  await initDefaultGroups();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Realtime chat server is running on http://127.0.0.1:${PORT}`);
    if (!dbReady) {
      console.log('WARNING: using in-memory storage because MongoDB is unavailable. Data will not persist across restarts.');
    }
  });
}

startServer();
