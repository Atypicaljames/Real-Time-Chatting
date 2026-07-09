const socket = io({ autoConnect: false });

const authShell = document.getElementById('authShell');
const appShell = document.getElementById('appShell');
const userNameDisplay = document.getElementById('userNameDisplay');
const logoutButton = document.getElementById('logoutButton');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const authError = document.getElementById('authError');
const authTabs = document.querySelectorAll('.tab-button');
const tabContents = document.querySelectorAll('.tab-content');
const groupList = document.getElementById('groupList');
const userList = document.getElementById('userList');
const userCount = document.getElementById('userCount');
const groupTitle = document.getElementById('groupTitle');
const groupDescriptionText = document.getElementById('groupDescriptionText');
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const attachButton = document.getElementById('attachButton');
const recordButton = document.getElementById('recordButton');
const selectedFileName = document.getElementById('selectedFileName');
const fileInput = document.getElementById('fileInput');
const typingIndicatorEl = document.getElementById('typingIndicator');

let currentUser = null;
let activeGroupId = null;
let activeGroup = null;
let pendingAttachment = null;
let mediaRecorder = null;
let recordedChunks = [];
let typingTimeout = null;
let groups = [];
let users = [];
const defaultGroupPrompt = 'Select a group to begin';
function escapeHtml(input) {
  return String(input).replace(/[&<>\"]/g, (match) => {
    const escape = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
    };
    return escape[match] || match;
  });
}

function formatPreviewText(message) {
  if (!message) {
    return '';
  }

  const text = String(message.text || '').trim();
  if (text) {
    const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
    return `${message.userName}: ${preview}`;
  }

  return `${message.userName}: Attachment`;
}

function setError(message) {
  authError.textContent = message || '';
}

function formatTimestamp(value) {
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  const contentType = response.headers.get('Content-Type') || '';
  let data = {};
  if (contentType.includes('application/json')) {
    data = await response.json().catch(() => ({}));
  } else {
    data = { error: await response.text().catch(() => 'Request failed') };
  }

  if (!response.ok) {
    const errorMessage = data.error || `Request failed (${response.status})`;
    throw new Error(errorMessage);
  }
  return data;
}

function showAuthShell() {
  authShell.classList.remove('hidden');
  appShell.classList.add('hidden');
}

function showAppShell() {
  authShell.classList.add('hidden');
  appShell.classList.remove('hidden');
}

function setActiveTab(tabName) {
  authTabs.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  tabContents.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${tabName}Tab`);
  });
}

function updateUserList() {
  userList.innerHTML = '';
  userCount.textContent = users.length;

  users.forEach((user) => {
    const userCard = document.createElement('div');
    userCard.className = `user-card${user.username === currentUser?.username ? ' current' : ''}`;
    userCard.innerHTML = `
      <strong>${escapeHtml(user.displayName)}</strong>
      <span>${escapeHtml(user.username)}</span>
    `;
    userList.appendChild(userCard);
  });
}

function updateGroupList() {
  groupList.innerHTML = '';
  groups.forEach((group) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `group-card${group._id === activeGroupId ? ' active' : ''}`;
    const preview = group.lastMessage ? `<p>${escapeHtml(formatPreviewText(group.lastMessage))}</p>` : '';
    card.innerHTML = `
      <strong>${escapeHtml(group.name)}</strong>
      ${preview}
      <p class="group-description">${escapeHtml(group.description || 'Open group chat')}</p>
    `;
    card.addEventListener('click', () => selectGroup(group));
    groupList.appendChild(card);
  });
}

let socketHandlersBound = false;

function connectSocket() {
  if (socket.connected) {
    return;
  }

  if (!socketHandlersBound) {
    socket.on('connect', () => {
      console.log('Socket connected');
      if (activeGroupId) {
        socket.emit('join group', { groupId: activeGroupId });
      }
    });

    socket.on('group messages', (messages) => {
      renderMessages(messages);
    });

    socket.on('users updated', (updatedUsers) => {
      users = updatedUsers || [];
      updateUserList();
    });

    socket.on('message edited', (message) => {
      if (message.groupId !== activeGroupId) {
        return;
      }
      const messageEl = document.querySelector(`[data-message-id="${message._id}"]`);
      if (messageEl) {
        const textEl = messageEl.querySelector('.message-text');
        if (textEl) {
          textEl.textContent = message.text || '';
          textEl.style.display = message.text ? '' : 'none';
        }
      }
      loadGroups();
    });

    socket.on('message deleted', ({ messageId, groupId }) => {
      if (groupId !== activeGroupId) {
        return;
      }
      const messageEl = document.querySelector(`[data-message-id="${messageId}"]`);
      messageEl?.remove();
      loadGroups();
    });

    socket.on('new message', (message) => {
      if (message.groupId !== activeGroupId) {
        return;
      }
      appendMessage(message, message.userName === currentUser.displayName);
      loadGroups();
    });

    socket.on('typing', ({ name, groupId }) => {
      if (groupId !== activeGroupId) {
        return;
      }
      setTypingIndicator(`${escapeHtml(name)} is typing...`);
    });

    socket.on('stop typing', ({ groupId }) => {
      if (groupId !== activeGroupId) {
        return;
      }
      setTypingIndicator('');
    });

    socket.on('message read update', ({ messageId, readBy, groupId }) => {
      if (groupId !== activeGroupId) {
        return;
      }
      updateMessageReceipt(messageId, readBy);
    });

    socket.on('save error', (errorMessage) => {
      alert(errorMessage);
    });

    socket.on('disconnect', () => {
      console.log('Socket disconnected');
    });

    socketHandlersBound = true;
  }

  socket.connect();
}

document.addEventListener('click', (event) => {
  if (!event.target.closest('.message') && !event.target.closest('.message-actions') && !event.target.closest('.message-edit-controls')) {
    removeMessageActions();
  }
});

function createMessageElement(message, isOwnMessage = false) {
  const messageEl = document.createElement('article');
  messageEl.className = `message${isOwnMessage ? ' own' : ''}`;
  messageEl.dataset.messageId = message._id || '';

  const header = document.createElement('strong');
  header.innerHTML = `${escapeHtml(message.userName)} <span>${formatTimestamp(message.createdAt)}</span>`;

  const text = document.createElement('p');
  text.className = 'message-text';
  text.textContent = message.text || '';
  text.style.display = message.text ? '' : 'none';

  messageEl.appendChild(header);
  messageEl.appendChild(text);

  if (message.attachments?.length) {
    const attachmentsWrapper = document.createElement('div');
    attachmentsWrapper.className = 'message-attachments';

    message.attachments.forEach((attachment) => {
      if (attachment.contentType.startsWith('audio/')) {
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.src = attachment.url;
        attachmentsWrapper.appendChild(audio);
      } else {
        const link = document.createElement('a');
        link.href = attachment.url;
        link.textContent = attachment.fileName;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'attachment-link';
        attachmentsWrapper.appendChild(link);
      }
    });

    messageEl.appendChild(attachmentsWrapper);
  }


  messageEl.addEventListener('click', (event) => {
    if (
      event.target.closest('button') ||
      event.target.closest('a') ||
      event.target.closest('.message-edit-controls') ||
      event.target.closest('.edit-message-text') ||
      event.target.closest('audio') ||
      event.target.closest('input') ||
      event.target.closest('textarea')
    ) {
      return;
    }
    event.stopPropagation();
    toggleMessageActions(messageEl, message, isOwnMessage);
  });

  return messageEl;
}

function removeMessageActions() {
  const existing = document.querySelectorAll('.message-actions, .message-edit-controls');
  existing.forEach((element) => element.remove());
}

async function editMessageText(messageEl, message) {
  removeMessageActions();
  const textEl = messageEl.querySelector('.message-text');
  const existingEditor = messageEl.querySelector('.edit-message-text');
  if (existingEditor) {
    return;
  }

  const originalText = message.text || '';
  textEl.style.display = 'none';

  const textEditor = document.createElement('textarea');
  textEditor.className = 'edit-message-text';
  textEditor.value = originalText;
  textEditor.rows = 3;

  const controls = document.createElement('div');
  controls.className = 'message-edit-controls';

  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'secondary-button';
  saveButton.textContent = 'Save';

  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'secondary-button';
  cancelButton.textContent = 'Cancel';

  controls.appendChild(saveButton);
  controls.appendChild(cancelButton);
  messageEl.appendChild(textEditor);
  messageEl.appendChild(controls);

  saveButton.addEventListener('click', async () => {
    const updatedText = textEditor.value.trim();
    try {
      const response = await api(`/api/messages/${message._id}`, {
        method: 'PUT',
        body: JSON.stringify({ text: updatedText }),
      });
      message.text = response.message.text;
      textEl.textContent = response.message.text;
      textEditor.remove();
      controls.remove();
      textEl.style.display = response.message.text ? '' : 'none';
      loadGroups();
    } catch (error) {
      console.error('Unable to edit message', error);
      alert(error.message || 'Unable to update message.');
    }
  });

  cancelButton.addEventListener('click', () => {
    textEditor.remove();
    controls.remove();
    textEl.style.display = '';
  });
}

async function deleteMessage(messageEl, message) {
  const confirmed = confirm('Delete this message? This cannot be undone.');
  if (!confirmed) {
    return;
  }
  try {
    await api(`/api/messages/${message._id}`, { method: 'DELETE' });
    messageEl.remove();
    loadGroups();
  } catch (error) {
    console.error('Unable to delete message', error);
    alert(error.message || 'Unable to delete message.');
  }
}

function toggleMessageActions(messageEl, message, isOwnMessage) {
  const existing = messageEl.querySelector('.message-actions');
  if (existing) {
    existing.remove();
    return;
  }

  removeMessageActions();

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  if (isOwnMessage) {
    const editButton = document.createElement('button');
    editButton.type = 'button';
    editButton.className = 'secondary-button';
    editButton.textContent = 'Edit';
    actions.appendChild(editButton);

    editButton.addEventListener('click', (event) => {
      event.stopPropagation();
      editMessageText(messageEl, message);
    });
  }

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'secondary-button';
  deleteButton.textContent = 'Delete';
  actions.appendChild(deleteButton);
  messageEl.appendChild(actions);

  deleteButton.addEventListener('click', (event) => {
    event.stopPropagation();
    deleteMessage(messageEl, message);
  });
}

function renderMessages(messages) {
  messagesEl.innerHTML = '';
  messages.forEach((message) => {
    appendMessage(message, message.userName === currentUser.displayName, false);
  });
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(message, isOwnMessage = false, markRead = true) {
  const messageEl = createMessageElement(message, isOwnMessage);
  messagesEl.appendChild(messageEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (markRead) {
    markMessageRead(message);
  }
}

function updateMessageReceipt(messageId, readBy) {
  // Read receipts removed
}

function setTypingIndicator(message) {
  typingIndicatorEl.textContent = message;
  typingIndicatorEl.classList.toggle('visible', Boolean(message));
}

async function markMessageRead(message) {
  if (!message._id || !activeGroupId || message.userName === currentUser.displayName) {
    return;
  }
  socket.emit('message read', { messageId: message._id, groupId: activeGroupId });
}

async function selectGroup(group) {
  if (!group) {
    return;
  }

  activeGroupId = group._id;
  activeGroup = group;
  groupTitle.textContent = group.name;
  groupDescriptionText.textContent = group.description || 'Open group conversation';
  updateGroupList();
  messagesEl.innerHTML = '';
  setTypingIndicator('');

  if (!socket.connected) {
    connectSocket();
  } else {
    socket.emit('join group', { groupId: activeGroupId });
  }
}

async function loadGroups() {
  try {
    const data = await api('/api/groups');
    groups = data.groups || [];
    updateGroupList();
    if (!activeGroupId && groups.length) {
      selectGroup(groups[0]);
    }
  } catch (error) {
    console.error(error);
  }
}

async function loadUsers() {
  try {
    const data = await api('/api/users');
    users = data.users || [];
    updateUserList();
  } catch (error) {
    console.error(error);
  }
}

async function initialize() {
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    userNameDisplay.textContent = `Hi, ${escapeHtml(currentUser.displayName)}`;
    showAppShell();
    await loadUsers();
    loadGroups();
    connectSocket();
  } catch {
    showAuthShell();
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('');
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;

  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    currentUser = data.user;
    userNameDisplay.textContent = `Hi, ${escapeHtml(currentUser.displayName)}`;
    showAppShell();
    await loadUsers();
    loadGroups();
    connectSocket();
  } catch (error) {
    setError(error.message);
  }
});

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setError('');
  const username = document.getElementById('registerUsername').value.trim();
  const displayName = document.getElementById('registerDisplayName').value.trim();
  const password = document.getElementById('registerPassword').value;

  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, password }),
    });
    currentUser = data.user;
    userNameDisplay.textContent = `Hi, ${escapeHtml(currentUser.displayName)}`;
    showAppShell();
    await loadUsers();
    loadGroups();
    connectSocket();
  } catch (error) {
    setError(error.message);
  }
});

authTabs.forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
});

logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/logout', { method: 'POST' });
    if (socket.connected) {
      socket.disconnect();
    }
    currentUser = null;
    activeGroupId = null;
    groups = [];
    showAuthShell();
  } catch (error) {
    console.error(error);
  }
});


attachButton.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) {
    pendingAttachment = null;
    selectedFileName.textContent = 'No attachment selected';
    return;
  }

  const buffer = await file.arrayBuffer();
  pendingAttachment = {
    fileName: file.name,
    contentType: file.type || 'application/octet-stream',
    size: file.size,
    data: buffer,
  };
  selectedFileName.textContent = file.name;
});

recordButton.addEventListener('click', async () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    });

    mediaRecorder.addEventListener('stop', async () => {
      const audioBlob = new Blob(recordedChunks, { type: 'audio/webm' });
      const arrayBuffer = await audioBlob.arrayBuffer();
      pendingAttachment = {
        fileName: `voice-note-${Date.now()}.webm`,
        contentType: audioBlob.type,
        size: audioBlob.size,
        data: arrayBuffer,
      };
      selectedFileName.textContent = 'Voice note attached';
      recordButton.textContent = 'Record voice note';
      stream.getTracks().forEach((track) => track.stop());
    });

    mediaRecorder.start();
    selectedFileName.textContent = 'Recording...';
    recordButton.textContent = 'Stop recording';
  } catch (error) {
    console.error('Unable to record audio', error);
    alert('Microphone access is required to record voice notes.');
  }
});

messageInput.addEventListener('input', () => {
  if (!activeGroupId) {
    return;
  }
  if (messageInput.value.trim()) {
    socket.emit('typing', { groupId: activeGroupId });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('stop typing', { groupId: activeGroupId });
    }, 1200);
  } else {
    socket.emit('stop typing', { groupId: activeGroupId });
  }
});

chatForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!activeGroupId) {
    return;
  }

  const text = messageInput.value.trim();
  if (!text && !pendingAttachment) {
    return;
  }

  const payload = {
    groupId: activeGroupId,
    text,
  };
  if (pendingAttachment) {
    payload.attachment = pendingAttachment;
  }

  socket.emit('send message', payload);
  messageInput.value = '';
  pendingAttachment = null;
  selectedFileName.textContent = 'No attachment selected';
  socket.emit('stop typing', { groupId: activeGroupId });
});

async function initializeAuth() {
  try {
    const data = await api('/api/me');
    currentUser = data.user;
    userNameDisplay.textContent = `Hi, ${escapeHtml(currentUser.displayName)}`;
    showAppShell();
    await loadUsers();
    loadGroups();
    connectSocket();
  } catch {
    showAuthShell();
  }
}

initializeAuth();
