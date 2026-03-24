document.addEventListener('DOMContentLoaded', () => {
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
    const attachBtn = document.getElementById('attach-btn');
    const mediaInput = document.getElementById('media-input');
    const attachmentPreview = document.getElementById('attachment-preview');
    const attachmentCount = document.getElementById('attachment-count');
    const templateSelect = document.getElementById('template-select');
    const templateMeta = document.getElementById('template-meta');
    const refreshTemplatesBtn = document.getElementById('refresh-templates-btn');
    const templateGenerateBtn = document.getElementById('template-generate-btn');
    const lowerPreview = document.getElementById('lower-preview');
    const worldIframe = document.getElementById('world-iframe');
    const closePreviewBtn = document.getElementById('close-preview');
    const openExternalBtn = document.getElementById('open-external-preview');
    
    // Credentials
    const emailInput = document.getElementById('viverse-email');
    const passwordInput = document.getElementById('viverse-password');
    const saveCredsBtn = document.getElementById('save-credentials-btn');
    const credsStatus = document.getElementById('credentials-status');

    let chatHistory = [];
    let activeWorldUrl = "";
    let savedCredentials = null;
    let pendingMessage = "";
    let pendingAttachments = [];
    let templatesCatalog = [];

    const MAX_ATTACHMENTS = 4;
    const MAX_FILE_SIZE = 12 * 1024 * 1024;
    const MAX_TOTAL_FILE_SIZE = 48 * 1024 * 1024;
    const ALLOWED_PREFIXES = ['image/', 'video/'];
    const DOC_MIME_BY_EXT = {
        pdf: 'application/pdf',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        txt: 'text/plain',
        md: 'text/markdown',
        json: 'application/json',
        csv: 'text/csv'
    };

    function scrollToBottom() {
        const threshold = 50;
        const isAtBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < threshold;
        if (isAtBottom) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    function appendMessage(role, content = "") {
        const safeContent = content || "";
        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${role}`;
        bubble.innerHTML = marked.parse(safeContent);
        chatMessages.appendChild(bubble);
        scrollToBottom();
    }

    function updateAttachmentUI() {
        attachmentPreview.innerHTML = '';
        if (!pendingAttachments.length) {
            attachmentPreview.classList.add('hidden');
            attachmentCount.classList.add('hidden');
            attachmentCount.textContent = '0 files';
            return;
        }

        attachmentPreview.classList.remove('hidden');
        attachmentCount.classList.remove('hidden');
        attachmentCount.textContent = `${pendingAttachments.length} file${pendingAttachments.length > 1 ? 's' : ''}`;

        pendingAttachments.forEach((file, index) => {
            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'attachment-pill';
            pill.innerHTML = `<span class="attachment-pill-name">${file.name}</span><span class="attachment-pill-remove">×</span>`;
            pill.addEventListener('click', () => {
                pendingAttachments.splice(index, 1);
                updateAttachmentUI();
            });
            attachmentPreview.appendChild(pill);
        });
    }

    function inferMimeType(file) {
        const original = (file.type || '').toLowerCase();
        if (original) return original;
        const name = String(file.name || '').toLowerCase();
        const ext = name.includes('.') ? name.split('.').pop() : '';
        return DOC_MIME_BY_EXT[ext] || '';
    }

    function isSupportedMedia(file) {
        const mimeType = inferMimeType(file);
        if (!mimeType) return false;
        if (ALLOWED_PREFIXES.some((prefix) => mimeType.startsWith(prefix))) return true;
        return Object.values(DOC_MIME_BY_EXT).includes(mimeType);
    }

    function totalPendingBytes() {
        return pendingAttachments.reduce((sum, item) => {
            const base64Len = String(item?.dataBase64 || '').length;
            const bytes = Math.floor((base64Len * 3) / 4);
            return sum + bytes;
        }, 0);
    }

    function toAttachment(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = String(reader.result || '');
                const marker = 'base64,';
                const idx = result.indexOf(marker);
                if (idx === -1) {
                    reject(new Error(`Failed to parse file: ${file.name}`));
                    return;
                }
                resolve({
                    name: file.name,
                    mimeType: inferMimeType(file),
                    dataBase64: result.slice(idx + marker.length)
                });
            };
            reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
            reader.readAsDataURL(file);
        });
    }

    function showTypingIndicator() {
        const indicator = document.createElement('div');
        indicator.className = 'typing-indicator';
        indicator.id = 'typing-indicator';
        indicator.innerHTML = '<div class="dot"></div><div class="dot"></div><div class="dot"></div>';
        chatMessages.appendChild(indicator);
        scrollToBottom();
    }

    function removeTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) indicator.remove();
    }

    function selectedTemplate() {
        const id = String(templateSelect?.value || '').trim();
        if (!id) return null;
        return templatesCatalog.find((item) => String(item.id) === id) || null;
    }

    function renderTemplateMeta() {
        const chosen = selectedTemplate();
        if (!chosen) {
            templateMeta.textContent = 'No template selected. Agent will run normal generation flow.';
            return;
        }
        const tags = Array.isArray(chosen.tags) && chosen.tags.length ? chosen.tags.join(', ') : 'none';
        const caps = Array.isArray(chosen.capabilities) && chosen.capabilities.length ? chosen.capabilities.join(', ') : 'none';
        templateMeta.textContent = `Genre: ${chosen.genre || 'N/A'} | Tags: ${tags} | Capabilities: ${caps}`;
    }

    async function loadTemplates() {
        try {
            templateMeta.textContent = 'Loading templates...';
            const res = await fetch('/api/ai/templates');
            const data = await res.json();
            templatesCatalog = Array.isArray(data?.templates) ? data.templates : [];
            const selected = String(templateSelect.value || '');
            templateSelect.innerHTML = '<option value="">No template (free generation)</option>';
            templatesCatalog.forEach((item) => {
                const option = document.createElement('option');
                option.value = item.id;
                option.textContent = `${item.name}${item.genre ? ` · ${item.genre}` : ''}`;
                templateSelect.appendChild(option);
            });
            if (selected && templatesCatalog.some((item) => item.id === selected)) {
                templateSelect.value = selected;
            }
            renderTemplateMeta();
        } catch (error) {
            templateMeta.textContent = `Failed to load templates: ${error.message}`;
        }
    }

    function applyTemplateContextToMessage(message = '') {
        const chosen = selectedTemplate();
        if (!chosen) return message;
        if (String(message || '').includes('Template Mode Enabled.')) return message;
        return [
            `Template Mode Enabled.`,
            `Template ID: ${chosen.id}`,
            `Template Name: ${chosen.name}`,
            `Please generate using this template unless I explicitly request another template.`,
            '',
            `User Request:`,
            message
        ].join('\n');
    }

    async function sendMessage(overrideMessage = null, isAutoSend = false) {
        // Fix for event listener passing PointerEvent as first arg
        const actualMessage = (overrideMessage && typeof overrideMessage === 'string') ? overrideMessage : userInput.value.trim();
        const requestMessageRaw = actualMessage || 'Please analyze the attached media.';
        const requestMessage = applyTemplateContextToMessage(requestMessageRaw);
        if (!actualMessage && pendingAttachments.length === 0) return;

        if (!isAutoSend) {
            const attachmentLabel = pendingAttachments.length
                ? `\n\nAttached media:\n${pendingAttachments.map((a) => `- ${a.name}`).join('\n')}`
                : '';
            const chosen = selectedTemplate();
            const templateTag = chosen ? `\n\nTemplate: ${chosen.id}` : '';
            appendMessage('user', `${actualMessage || '(media only)'}${templateTag}${attachmentLabel}`);
        }
        userInput.value = '';
        userInput.style.height = 'auto';

        showTypingIndicator();
        let localHeartbeat = null;

        try {
            const payload = { message: requestMessage, history: chatHistory };
            if (pendingAttachments.length) {
                payload.attachments = [...pendingAttachments];
            }
            if (savedCredentials) {
                payload.credentials = savedCredentials;
            }

            pendingAttachments = [];
            updateAttachmentUI();

            const response = await fetch('/api/ai/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                removeTypingIndicator();
                appendMessage('system', `Error: ${response.statusText}`);
                return;
            }

            // Create a bubble for the agent response
            const bubble = document.createElement('div');
            bubble.className = `message-bubble agent streaming`;
            
            // Container for status logs (collapsible or scrollable)
            const statusContainer = document.createElement('div');
            statusContainer.className = 'status-logs';
            statusContainer.innerHTML = '<div class="status-line"><span class="status-icon">⏳</span> Thinking...</div>';
            
            // Container for final text
            const textContainer = document.createElement('div');
            textContainer.className = 'agent-text';
            
            bubble.appendChild(statusContainer);
            bubble.appendChild(textContainer);
            chatMessages.appendChild(bubble);

            let accumulatedText = "";
            let receivedFirstChunk = false;
            let localHeartbeatCount = 0;
            localHeartbeat = setInterval(() => {
                localHeartbeatCount += 1;
                const waitLine = document.createElement('div');
                waitLine.className = 'status-line';
                waitLine.innerHTML = `<span class="status-icon">⏱️</span> Still working... (${localHeartbeatCount * 8}s)`;
                statusContainer.appendChild(waitLine);
                statusContainer.scrollTop = statusContainer.scrollHeight;
                scrollToBottom();
            }, 8000);

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        if (!receivedFirstChunk) {
                            receivedFirstChunk = true;
                            removeTypingIndicator();
                        }
                        const dataStr = line.substring(6).trim();
                        if (dataStr === '[DONE]') continue;
                        
                        try {
                            const parsed = JSON.parse(dataStr);
                            
                            if (parsed.type === 'status') {
                                const statusLine = document.createElement('div');
                                statusLine.className = 'status-line';
                                statusLine.innerHTML = `<span class="status-icon">⚡</span> ${parsed.content}`;
                                statusContainer.appendChild(statusLine);
                                // Auto-scroll status container
                                statusContainer.scrollTop = statusContainer.scrollHeight;
                                scrollToBottom();
                            } else if (parsed.type === 'text') {
                                accumulatedText += parsed.content;
                                textContainer.innerHTML = marked.parse(accumulatedText);
                                scrollToBottom();
                            } else if (parsed.type === 'error') {
                                const errorLine = document.createElement('div');
                                errorLine.className = 'status-line error';
                                errorLine.innerHTML = `⚠️ Error: ${parsed.content}`;
                                statusContainer.appendChild(errorLine);
                            } else if (parsed.type === 'action' && parsed.action === 'require_credentials') {
                                pendingMessage = requestMessage; // Store intent for auto-continue
                                const accountPanel = document.querySelector('.account-panel');
                                accountPanel.classList.add('visible');
                                accountPanel.classList.remove('highlight');
                                // trigger reflow
                                void accountPanel.offsetWidth;
                                accountPanel.classList.add('highlight');
                                
                                // optionally auto-focus the email input
                                document.getElementById('viverse-email').focus();
                            }
                        } catch (e) {
                            console.warn("Failed to parse stream chunk:", dataStr);
                        }
                    }
                }
            }

            clearInterval(localHeartbeat);
            bubble.classList.remove('streaming');
            removeTypingIndicator();
            chatHistory.push({ role: 'user', content: requestMessage });
            chatHistory.push({ role: 'assistant', content: accumulatedText });

        } catch (error) {
            removeTypingIndicator();
            if (localHeartbeat) clearInterval(localHeartbeat);
            appendMessage('system', 'Connection error: ' + error.message);
        }
    }

    function openWorldPreview(url) {
        activeWorldUrl = url;
        worldIframe.src = url;
        lowerPreview.classList.remove('collapsed');
    }

    function closeWorldPreview() {
        lowerPreview.classList.add('collapsed');
        worldIframe.src = 'about:blank';
        activeWorldUrl = "";
    }

    // Event Listeners
    sendBtn.addEventListener('click', sendMessage);
    attachBtn.addEventListener('click', () => mediaInput.click());
    refreshTemplatesBtn.addEventListener('click', loadTemplates);
    templateSelect.addEventListener('change', renderTemplateMeta);
    templateGenerateBtn.addEventListener('click', () => {
        const chosen = selectedTemplate();
        if (!chosen) {
            appendMessage('system', 'Select a template first.');
            return;
        }
        userInput.value = `Create a new app using template '${chosen.id}'. Keep template structure intact and implement requested features.`;
        userInput.dispatchEvent(new Event('input'));
        userInput.focus();
    });
    mediaInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const file of files) {
            if (pendingAttachments.length >= MAX_ATTACHMENTS) {
                appendMessage('system', `Attachment limit reached (${MAX_ATTACHMENTS}).`);
                break;
            }
            if (!isSupportedMedia(file)) {
                appendMessage('system', `Unsupported file type: ${file.name} (supported: image/video/pdf/doc/docx/txt/md/json/csv)`);
                continue;
            }
            if (file.size > MAX_FILE_SIZE) {
                appendMessage('system', `File too large: ${file.name} (max 12MB each).`);
                continue;
            }
            try {
                const attachment = await toAttachment(file);
                const nextTotal = totalPendingBytes() + Math.floor((String(attachment.dataBase64 || '').length * 3) / 4);
                if (nextTotal > MAX_TOTAL_FILE_SIZE) {
                    appendMessage('system', `Attachments total exceeds 48MB. Skip: ${file.name}`);
                    continue;
                }
                pendingAttachments.push(attachment);
            } catch (err) {
                appendMessage('system', err.message || `Failed to attach ${file.name}`);
            }
        }
        mediaInput.value = '';
        updateAttachmentUI();
    });
    userInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Auto-resize textarea
    userInput.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
    });

    closePreviewBtn.addEventListener('click', closeWorldPreview);
    openExternalBtn.addEventListener('click', () => {
        if (activeWorldUrl) window.open(activeWorldUrl, '_blank');
    });

    // Intercept links
    document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href) {
            const url = link.href;

            // Detect VIVERSE World URLs
            const isWorld = url.includes('worlds.viverse.com') || url.includes('/world/');

            if (isWorld) {
                e.preventDefault();
                // Ensure ?full3d= is appended
                const finalUrl = url.includes('?') ? (url.includes('full3d=') ? url : `${url}&full3d=`) : `${url}?full3d=`;
                openWorldPreview(finalUrl);
            } else {
                // Force other links to open in new tab
                link.target = "_blank";
            }
        }
    });

    // Handle saving credentials
    saveCredsBtn.addEventListener('click', () => {
        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        
        if (email && password) {
            savedCredentials = { email, password };
            saveCredsBtn.classList.add('saved');
            saveCredsBtn.textContent = 'Saved';
            credsStatus.classList.remove('hidden');

            if (pendingMessage) {
                setTimeout(() => {
                    const accountPanel = document.querySelector('.account-panel');
                    accountPanel.classList.remove('visible'); // Hide after save
                    sendMessage(pendingMessage, true);
                    pendingMessage = "";
                }, 500); // Slight delay for visual feedback
            }
        } else {
            savedCredentials = null;
            saveCredsBtn.classList.remove('saved');
            saveCredsBtn.textContent = 'Save Credentials';
            credsStatus.classList.add('hidden');
        }
    });

    userInput.focus();
    loadTemplates();
});
