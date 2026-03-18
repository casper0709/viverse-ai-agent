document.addEventListener('DOMContentLoaded', () => {
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('user-input');
    const sendBtn = document.getElementById('send-btn');
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

    async function sendMessage(overrideMessage = null, isAutoSend = false) {
        // Fix for event listener passing PointerEvent as first arg
        const actualMessage = (overrideMessage && typeof overrideMessage === 'string') ? overrideMessage : userInput.value.trim();
        if (!actualMessage) return;

        if (!isAutoSend) {
            appendMessage('user', actualMessage);
        }
        userInput.value = '';
        userInput.style.height = 'auto';

        showTypingIndicator();
        let localHeartbeat = null;

        try {
            const payload = { message: actualMessage, history: chatHistory };
            if (savedCredentials) {
                payload.credentials = savedCredentials;
            }

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
                                pendingMessage = actualMessage; // Store intent for auto-continue
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
            chatHistory.push({ role: 'user', content: actualMessage });
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
});
