const vscode = acquireVsCodeApi();
const chatContainer = document.getElementById('chat-container');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const loadingSpinner = document.getElementById('loading-spinner');
if (loadingSpinner) loadingSpinner.style.display = 'none';
const sessionSelector = document.getElementById('session-selector');
const newSessionBtn = document.getElementById('new-session-btn');
const deleteSessionBtn = document.getElementById('delete-session-btn');
const renameSessionBtn = document.getElementById('rename-session-btn');
const stopBtn = document.getElementById('stop-btn');

let isStreaming = false;
let generationCancelled = false;
let typingTimer = null;
let typingState = null;
let projectContext = null;
let currentActiveSessionId = null;

function setSessionControlsDisabled(disabled) {
    sessionSelector.disabled = disabled;
    newSessionBtn.disabled = disabled;
    deleteSessionBtn.disabled = disabled;
    renameSessionBtn.disabled = disabled;
}

// 统一管理忙碌状态：busy=true 时隐藏“发送”并让“停止”占据其位置
function setBusy(busy) {
    isStreaming = busy;
    sendBtn.disabled = busy;
    sendBtn.style.display = busy ? 'none' : '';
    if (stopBtn) stopBtn.style.display = busy ? 'inline-block' : 'none';
    setSessionControlsDisabled(busy);
}

function appendMessage(content, sender) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${sender}`;
    msgDiv.textContent = content;
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

function formatAgentInfo(model, usage) {
    let infoText = '';
    if (model) infoText += `Model: ${model}`;
    if (usage !== undefined && usage !== null) infoText += `${infoText ? ' | ' : ''}Tokens: ${usage}`;
    return infoText;
}

function appendAssistantMessage(content, info) {
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message agent';
    if (info) {
        const infoDiv = document.createElement('div');
        infoDiv.className = 'agent-info';
        infoDiv.textContent = info;
        msgDiv.appendChild(infoDiv);
    }
    const contentDiv = document.createElement('div');
    if (window.marked && typeof window.marked.parse === 'function') {
        contentDiv.innerHTML = marked.parse(content);
    } else {
        contentDiv.textContent = content;
    }
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;
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
            appendAssistantMessage(m.content, formatAgentInfo(m.model, m.usage));
        }
    });
}


function renderInto(contentDiv, mdText) {
    if (window.marked && typeof window.marked.parse === 'function') {
        contentDiv.innerHTML = window.marked.parse(mdText);
    } else {
        contentDiv.textContent = mdText;
    }
}

function streamAgentMessage(text, info) {
    isStreaming = true;
    const msgDiv = document.createElement('div');
    msgDiv.className = 'message agent';

    // Info container for model and usage
    const infoDiv = document.createElement('div');
    infoDiv.className = 'agent-info';
    infoDiv.textContent = info || '';
    msgDiv.appendChild(infoDiv);

    // Content container for streaming text
    const contentDiv = document.createElement('div');
    msgDiv.appendChild(contentDiv);
    chatContainer.appendChild(msgDiv);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    const state = { contentDiv: contentDiv, fullText: text || '', i: 0 };
    typingState = state;

    function typeChar() {
        if (state.i <= state.fullText.length) {
            renderInto(state.contentDiv, state.fullText.slice(0, state.i));
            chatContainer.scrollTop = chatContainer.scrollHeight;
            state.i++;
            typingTimer = setTimeout(typeChar, 8);
        } else {
            typingTimer = null;
            typingState = null;
            setBusy(false);
        }
    }
    typeChar();
}

// “停止”按钮：等待期间中止请求；逐字输出阶段停止动画并直接显示已收到的全文
function stopGeneration() {
    if (!isStreaming) return;
    generationCancelled = true;
    if (loadingSpinner) loadingSpinner.style.display = 'none';
    if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
    }
    if (typingState) {
        renderInto(typingState.contentDiv, typingState.fullText);
        chatContainer.scrollTop = chatContainer.scrollHeight;
        typingState = null;
    }
    vscode.postMessage({ command: 'stop' });
    setBusy(false);
}

if (stopBtn) stopBtn.addEventListener('click', stopGeneration);

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
    generationCancelled = false;
    setBusy(true);
    appendMessage(content, 'user');
    chatInput.value = '';
    if (loadingSpinner) loadingSpinner.style.display = 'flex';
    vscode.postMessage({ command: 'chat', text: content });
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
                if (generationCancelled) {
                    // 已点击“停止”：忽略迟到的完整回复，恢复输入
                    setBusy(false);
                } else if (message.text) {
                    streamAgentMessage(message.text, formatAgentInfo(message.model, message.usage));
                } else {
                    setBusy(false);
                }
            } catch (e) {
                console.error(e);
                setBusy(false);
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
