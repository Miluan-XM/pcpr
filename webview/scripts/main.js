const vscode = acquireVsCodeApi();
const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const localPlanToggle = document.getElementById('local-plan-toggle');
localPlanToggle.checked = true;
const loadingSpinner = document.getElementById('loading-spinner');
if (loadingSpinner) loadingSpinner.style.display = 'none';
const sessionSelector = document.getElementById('session-selector');
const newSessionBtn = document.getElementById('new-session-btn');
const deleteSessionBtn = document.getElementById('delete-session-btn');
const renameSessionBtn = document.getElementById('rename-session-btn');

let isStreaming = false;
let projectContext = null;
let currentActiveSessionId = null;

function setSessionControlsDisabled(disabled) {
    sessionSelector.disabled = disabled;
    newSessionBtn.disabled = disabled;
    deleteSessionBtn.disabled = disabled;
    renameSessionBtn.disabled = disabled;
}

function appendMessage(content, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.textContent = content;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function appendAssistantMessage(content) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message assistant';
    msgDiv.innerHTML = marked.parse(content);
    chatContainer.appendChild(msgDiv);
}

function updateSessionList(list,activeId){
    if(!sessionSelector){
        return;
    }
    sessionSelector.innerHTML='';
    list.forEach(s => {
        const option=document.createElement('option');
        option.value=s.id;
        option.textContent=s.name;
        if(s.id===activeId){
            option.selected=true;
        }
        sessionSelector.appendChild(option);
    });
}



function loadMessages(messages){
    const chatContainer=document.getElementById('chat-container');
    if(!chatContainer){
        return;
    }
    chatContainer.innerHTML='';
    messages.forEach(m => {
        if(m.role==='user'){
            appendMessage(m.content,'user');
        }else if(m.role==='assistant'){
            appendAssistantMessage(m.content);
        }
    });
}


function streamAgentMessage(text) {
    let i = 0;
    isStreaming = true;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message agent';

    // Info container for model and usage
    const infoDiv = document.createElement('div');
    infoDiv.className = 'agent-info';
    infoDiv.style.fontSize = '0.75em';
    infoDiv.style.color = '#aaa';
    infoDiv.style.marginBottom = '2px';
    msgDiv.appendChild(infoDiv);

    // Content container for streaming text
    const contentDiv = document.createElement('div');
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    function typeChar() {
        if (i <= text.length) {
            if (window.marked && typeof window.marked.parse === 'function') {
                contentDiv.innerHTML = window.marked.parse(text.slice(0, i));
            } else {
                contentDiv.textContent = text.slice(0, i);
            }
            chatContainer.scrollTop = chatContainer.scrollHeight;
            i++;
            setTimeout(typeChar, 18);
        } else {
            isStreaming = false;
            sendBtn.disabled = false;
            setSessionControlsDisabled(false);
        }
    }
    typeChar();
}

sendBtn.addEventListener('click', () => {
    sendUserMessage();
});

newSessionBtn.addEventListener('click', function () {
    vscode.postMessage({ command: 'createSession' });
});

deleteSessionBtn.addEventListener('click', function () {
    const activeId = sessionSelector.value;
    if (activeId) {
        vscode.postMessage({ command: 'deleteSession', sessionId: activeId });
    }
});

sessionSelector.addEventListener('change', function () {
    vscode.postMessage({ command: 'switchSession', sessionId: sessionSelector.value });
});

renameSessionBtn.addEventListener('click', function () {
    const activeId = sessionSelector ? sessionSelector.value : null;
    if (!activeId) {
        return;
    }
    vscode.postMessage({ command: 'renameSession', sessionId: activeId });
});

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUserMessage();
    }
});

function sendUserMessage() {
    const content = chatInput.value.trim();
    if (!content || isStreaming) return;
    isStreaming = true;
    appendMessage(content, 'user');
    chatInput.value = '';
    sendBtn.disabled = true;
    setSessionControlsDisabled(true);
    if (loadingSpinner) loadingSpinner.style.display = 'flex';
    const useLocal = localPlanToggle && localPlanToggle.checked;
    vscode.postMessage({ command: 'chat', text: content, local: useLocal });
}

window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'projectContext':
            projectContext = message.data;
            try {
                const fileCount = projectContext.openedFiles ? Object.keys(projectContext.openedFiles).length : 0;
                // appendMessage(`dev: Project loaded: ${fileCount} opened file(s) recorded.`, 'agent');
            } catch (e) {
                console.error(e);
            }
            break;
        case 'agentResponse':
            if (loadingSpinner) loadingSpinner.style.display = 'none';
            try {
                if (message.text) {
                    streamAgentMessage(message.text);
                    // Find the last agent message and fill infoDiv
                    setTimeout(() => {
                        const agentMessages = chatContainer.getElementsByClassName('message agent');
                        if (agentMessages.length > 0) {
                            const lastAgentMsg = agentMessages[agentMessages.length - 1];
                            const infoDiv = lastAgentMsg.querySelector('.agent-info');
                            if (infoDiv) {
                                let infoText = '';
                                if (message.model) infoText += `Model: ${message.model}`;
                                if (message.usage !== undefined) infoText += `${infoText ? ' | ' : ''}Tokens: ${message.usage}`;
                                infoDiv.textContent = infoText;
                            }
                        }
                    }, 10);
                } else {
                    sendBtn.disabled = false;
                    setSessionControlsDisabled(false);
                }
            } catch (e) {
                console.error(e);
                sendBtn.disabled = false;
                setSessionControlsDisabled(false);
            }
            break;
        case 'sessionState':
            updateSessionList(message.sessions, message.activeSessionId);
            // 只有激活会话变化时才重渲染消息，避免打断正在流式输出的回复
            if (message.activeSessionId !== currentActiveSessionId) {
                currentActiveSessionId = message.activeSessionId;
                loadMessages(message.messages);
            }
            break;
        default:
            break;
    }
});

// 通知扩展 Webview 已加载完成，扩展此时再下发初始数据
vscode.postMessage({ command: 'ready' });
