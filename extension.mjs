import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as userdataUtils from './utils/userdata-utils.mjs';
import * as userContextUtils from './utils/get-context-utils.mjs';
import * as responseUtils from './utils/response-utils.mjs';
import * as webviewUtils from './utils/webview-utils.mjs';
import * as apiManager from './utils/api-manager.mjs';
import * as sessionStore from './utils/session-store.mjs';
/**
 * @param {vscode.ExtensionContext} context
 */

// Main function to process user request through OpenAI API.
// Returns Object of necessary information of AI's response on success, false on error.
async function main(context, currentFile) {
    try {
        const user_data = await userdataUtils.getData(context);
        const openai = new OpenAI({
            apiKey: user_data.apiKey || "not-needed",
            baseURL: user_data.baseURL
        });
        if (user_data.baseURL && user_data.model) {
            var completion = await openai.chat.completions.create({
                model: user_data.model,
                messages: [
                    { "role": "system", "content": userdataUtils.getSysPrompt(context.extensionPath).system_prompt },
                    { "role": "user", "content": currentFile.content }
                ],
                // stream: false,
                // stream_options: {include_usage: true}
            });
        } else {
            vscode.window.showWarningMessage("API is not set, please set your APIs(PCPR: Add API)");
            return false;
        }
        return {
            "date": new Date().toLocaleString(),
            "file": currentFile.fileName,
            "model": user_data.model,
            "usage": completion.usage.total_tokens,
            "response": completion.choices[0].message.content
        };
    } catch (error) {
        vscode.window.showErrorMessage("Response Error: " + String(error));
        return false;
    }
}

// Main function to process user request from webview through OpenAI API.
// Returns Object of necessary information of AI's response on success, false on error.
async function web_main(context, input, chatHistory = [], ProjectStructure = "") {
    try {
        const user_data = await userdataUtils.getData(context);
        const openai = new OpenAI({
            apiKey: user_data.apiKey || "not-needed",
            baseURL: user_data.baseURL
        });
        if (user_data.baseURL && user_data.model) {
            const messages = [];
            let sysPrompt = userdataUtils.getSysPrompt(context.extensionPath).system_prompt_web;
            sysPrompt += ProjectStructure ? "<c>The structure of user's project is:\n" + ProjectStructure + "</c>" : "";
            messages.push({ role: 'system', content: sysPrompt });
            if (Array.isArray(chatHistory) && chatHistory.length > 0) {
                for (const item of chatHistory) {
                    messages.push({ role: item.role, content: item.content });
                }
            }
            messages.push({ role: 'user', content: input });

            const completion = await openai.chat.completions.create({
                model: user_data.model,
                messages: messages
            });

            return {
                // date: new Date().toLocaleString(),
                model: user_data.model,
                usage: completion.usage ? completion.usage.total_tokens : 0,
                response: completion.choices[0].message.content
            };
        } else {
            vscode.window.showWarningMessage("API is not set, please set your APIs(PCPR: Add API)");
            return false;
        }
    } catch (error) {
        vscode.window.showErrorMessage("Webview Error: " + String(error));
        return false;
    }
}

// 侧边栏聊天视图 Provider（WebviewView），承载原 createWebviewPanel 的聊天逻辑
class PCPRWebviewProvider {
    constructor(context, structure) {
        this.context = context;
        this.structure = structure;
    }

    resolveWebviewView(webviewView) {
        const webview = webviewView.webview;
        webview.options = { enableScripts: true };

        const scriptPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'scripts', 'main.js');
        const markedPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'scripts', 'marked.min.js');
        const stylePath = vscode.Uri.joinPath(this.context.extensionUri, 'webview', 'css', 'style.css');
        const scriptUri = webview.asWebviewUri(scriptPath).toString();
        const markedUri = webview.asWebviewUri(markedPath).toString();
        const styleUri = webview.asWebviewUri(stylePath).toString();

        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; script-src ${webview.cspSource}; style-src ${webview.cspSource};">`;

        webview.html = webviewUtils.getWebPage(this.context.extensionPath, {
            SCRIPT_URI: scriptUri,
            MARKED_URI: markedUri,
            STYLE_URI: styleUri,
            CSP: cspMeta
        });

        webview.onDidReceiveMessage(async (message) => {
            try {
                switch (message.command) {
                    case 'ready':
                        // Webview 加载完成后才下发初始数据（提前 postMessage 会被丢弃）
                        webview.postMessage({ command: 'projectContext', data: { openedFiles } });
                        webview.postMessage({
                            command: 'sessionState',
                            sessions: sessionStore.getSessionsList(),
                            messages: sessionStore.getActiveSessionMessages(),
                            activeSessionId: sessionStore.getActiveSessionId()
                        });
                        break;
                    case 'chat': {
                        // 发送前快照会话，防止请求期间切换导致回复存错会话
                        const sessionId = sessionStore.getActiveSessionId();
                        const history = sessionStore.getActiveSessionMessages();
                        history.push({ role: 'user', content: message.text });

                        const totalInput = JSON.stringify(openedFiles) + "|" + message.text;
                        // 只把最近 20 条作为模型上下文，完整历史仍全部入库
                        const response = await web_main(this.context, totalInput, history.slice(-20), this.structure);

                        if (response && response.response) {
                            history.push({
                                role: 'assistant',
                                content: response.response,
                                model: response.model,
                                usage: response.usage
                            });
                            sessionStore.saveMessages(sessionId, history);

                            // 第一条用户消息自动作为会话名称
                            const userMessages = history.filter(m => m.role === 'user');
                            if (userMessages.length === 1) {
                                const newName = message.text.trim().substring(0, 20);
                                sessionStore.renameSession(sessionId, newName);
                            }

                            // 只刷新列表，不回传 messages，避免打断正在流式输出的回复
                            webview.postMessage({
                                command: 'sessionState',
                                sessions: sessionStore.getSessionsList(),
                                activeSessionId: sessionStore.getActiveSessionId()
                            });
                            webview.postMessage({
                                command: 'agentResponse',
                                text: response.response,
                                model: response.model,
                                usage: response.usage
                            });
                        } else {
                            // 即使请求失败也保留用户消息
                            sessionStore.saveMessages(sessionId, history);
                            webview.postMessage({ command: 'agentResponse', text: 'Something went wrong.' });
                        }
                        break;
                    }
                    case 'createSession': {
                        const newSession = sessionStore.createNewSession();
                        const messages = sessionStore.getActiveSessionMessages();
                        webview.postMessage({
                            command: 'sessionState',
                            sessions: sessionStore.getSessionsList(),
                            activeSessionId: newSession.id,
                            messages: messages
                        });
                        break;
                    }
                    case 'switchSession': {
                        sessionStore.switchSession(message.sessionId);
                        webview.postMessage({
                            command: 'sessionState',
                            sessions: sessionStore.getSessionsList(),
                            activeSessionId: sessionStore.getActiveSessionId(),
                            messages: sessionStore.getActiveSessionMessages()
                        });
                        break;
                    }
                    case 'deleteSession': {
                        const target = sessionStore.findSessionById(message.sessionId);
                        const confirmDelete = await vscode.window.showWarningMessage(
                            `确定删除会话「${target ? target.name : '当前会话'}」？此操作不可恢复。`,
                            { modal: true },
                            '删除'
                        );
                        if (confirmDelete === '删除') {
                            sessionStore.deleteSession(message.sessionId);
                            webview.postMessage({
                                command: 'sessionState',
                                sessions: sessionStore.getSessionsList(),
                                activeSessionId: sessionStore.getActiveSessionId(),
                                messages: sessionStore.getActiveSessionMessages()
                            });
                        }
                        break;
                    }
                    case 'renameSession': {
                        const target = sessionStore.findSessionById(message.sessionId);
                        const newName = await vscode.window.showInputBox({
                            prompt: '输入新的会话名称',
                            value: target ? target.name : '',
                            validateInput: (v) => (v && v.trim() !== '') ? undefined : '会话名称不能为空'
                        });
                        if (newName && newName.trim() !== '') {
                            sessionStore.renameSession(message.sessionId, newName.trim());
                            webview.postMessage({
                                command: 'sessionState',
                                sessions: sessionStore.getSessionsList(),
                                activeSessionId: sessionStore.getActiveSessionId()
                            });
                        }
                        break;
                    }
                    default:
                        vscode.window.showErrorMessage("Unknown command: " + message.command);
                }
            } catch (error) {
                vscode.window.showErrorMessage(`Message handler error: ${String(error)}`);
                if (message.command === 'chat') {
                    webview.postMessage({ command: 'agentResponse', text: `处理消息时出错：${String(error)}` });
                }
            }
        });
    }
}

var openedFiles = {};
export async function activate(context) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const projectPath = workspaceFolders?.[0]?.uri?.fsPath || null;
    // 会话数据直接存放在插件自己的目录里（不依赖 VS Code 存储 API），每个会话用 projectPath 关联项目
    sessionStore.initSessions(context.extensionPath, projectPath);
    var structure = await userContextUtils.getWorkspaceStructure(workspaceFolders);

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Listen to file open events to add opened files into openedFiles object that is used to provide project context in webview chat.
    const docOpenListener = vscode.workspace.onDidOpenTextDocument(async (document) => {
        await sleep(100);
        if (document.uri.scheme === 'file' && document.languageId !== 'markdown' && document.languageId !== 'plaintext' && document.languageId !== 'ignore' && document.languageId !== 'code-text-binary' && document.languageId !== 'log') {
            var count = 0;
            while (!userContextUtils.getCurrentFile().filePath && count < 10) {
                await sleep(100);
                count++;
            }
        } else {
            return false;
        }
        if (count < 10) {
            const currentFile = userContextUtils.getCurrentFile();
            if (!Object.keys(openedFiles).includes(currentFile.filePath)) {
                openedFiles[currentFile.filePath] = currentFile.content;
            }
        }
    });
    context.subscriptions.push(docOpenListener);

    // keep openedFiles updated when documents change.
    const docChangeListener = vscode.workspace.onDidChangeTextDocument(async (e) => {
        try {
            const doc = e.document;
            if (doc && doc.uri && doc.uri.scheme === 'file' && openedFiles[doc.uri.fsPath] !== undefined) {
                openedFiles[doc.uri.fsPath] = doc.getText();
            }
        } catch (err) {
            vscode.window.showErrorMessage(`docChangeListener error: ${String(err)}`);
        }
    });
    context.subscriptions.push(docChangeListener);

    // keep openedFiles updated when documents are deleted.
    const docDeleteListener = vscode.workspace.onDidDeleteFiles(async (e) => {
        try {
            for (const file of e.files) {
                if (file && file.fsPath && openedFiles[file.fsPath] !== undefined) {
                    delete openedFiles[file.fsPath];
                }
            }
        } catch (err) {
            vscode.window.showErrorMessage(`docDeleteListener error: ${String(err)}`);
        }
    });
    context.subscriptions.push(docDeleteListener);

    // populate openedFiles from currently visible editors at activation
    try {
        for (const editor of vscode.window.visibleTextEditors) {
            const doc = editor.document;
            if (doc && doc.uri && doc.uri.scheme === 'file' && doc.languageId !== 'markdown' && doc.languageId !== 'plaintext' && doc.languageId !== 'ignore' && doc.languageId !== 'code-text-binary' && doc.languageId !== 'log') {
                openedFiles[doc.uri.fsPath] = doc.getText();
            }
        }
    } catch (err) {
        vscode.window.showErrorMessage(`init openedFiles error: ${String(err)}`);
    }

    const checkCode = vscode.commands.registerCommand('pcpr.checkCode', async function () {
        try {
            const user_data = await userdataUtils.getData(context);
            const currentFile = userContextUtils.getContext();
            if (user_data.baseURL && user_data.model) {
                const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
                statusBar.text = "$(sync-spin)PCPR: Analyzing....";
                statusBar.show();

                main(context, currentFile).then((result) => {
                    if (result) {
                        responseUtils.showResponse(result).then((err) => {
                            if (err) {
                                return;
                            }
                        }).catch((err) => {
                            vscode.window.showErrorMessage(`show Error: ${String(err)}`);
                        });
                    }

                    statusBar.hide();
                });

            } else {
                vscode.window.showWarningMessage("API is not set, please set your APIs(PCPR: Add API)");
            }
        } catch (err) {
            vscode.window.showErrorMessage(String(err));
        }

    })
    context.subscriptions.push(checkCode);

    // 注册侧边栏聊天视图（WebviewView）
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('pcpr.webviewChat', new PCPRWebviewProvider(context, structure))
    );

    // 注册 webviewChat 打开 web 聊天窗口的命令
    const webviewChat = vscode.commands.registerCommand('pcpr.webviewChat', function () {
        vscode.commands.executeCommand('pcpr.webviewChat.focus');
    });
    context.subscriptions.push(webviewChat);


    // 添加 API
    const addApi = vscode.commands.registerCommand('pcpr.addApi', async function () {
        await apiManager.addApiUI(context);
    });
    context.subscriptions.push(addApi);

    // 切换 API
    const switchApi = vscode.commands.registerCommand('pcpr.switchApi', async function () {
        await apiManager.switchApiUI(context);
    });
    context.subscriptions.push(switchApi);

    // 管理 API
    const manageApis = vscode.commands.registerCommand('pcpr.manageApis', async function () {
        await apiManager.manageApisUI(context);
    });
    context.subscriptions.push(manageApis);

    // 编辑 API
    const editApi = vscode.commands.registerCommand('pcpr.editApi', async function () {
        await apiManager.editApiUI(context);
    });
    context.subscriptions.push(editApi);

    // 删除 API
    const deleteApi = vscode.commands.registerCommand('pcpr.deleteApi', async function () {
        await apiManager.deleteApiUI(context);
    });
    context.subscriptions.push(deleteApi);
}

export function deactivate() { }
