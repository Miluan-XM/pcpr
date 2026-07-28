import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as userdataUtils from './utils/userdata-utils.mjs';
import * as userContextUtils from './utils/get-context-utils.mjs';
import * as responseUtils from './utils/response-utils.mjs';
import * as webviewUtils from './utils/webview-utils.mjs'
import * as apiManager from './utils/api-manager.mjs';
/**
 * @param {vscode.ExtensionContext} context
 */

// Main function to process user request through OpenAI API.
// Returns Object of necessary information of AI's response on success, false on error.
async function main(context, currentFile, local = false) {
    try {
        const user_data = local ? userdataUtils.getLocalPlanData() : await userdataUtils.getData(context);
        const openai = new OpenAI({
            apiKey: local ? "not-needed" : user_data.apiKey,
            baseURL: user_data.baseURL
        });
        if (local && user_data.baseURL && user_data.model) {
            var completion = await openai.chat.completions.create({
                model: user_data.model,
                messages: [
                    { "role": "system", "content": userdataUtils.getSysPrompt(context.extensionPath).system_prompt },
                    { "role": "user", "content": currentFile.content }
                ],
                // stream: false,
                // stream_options: {include_usage: true}
            })
        } else if (!local && user_data.baseURL && user_data.apiKey && user_data.model) {
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
        };
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
async function web_main(context, input, chatHistory = [], local = false, ProjectStructure = "") {
    try {
        const user_data = local ? userdataUtils.getLocalPlanData() : await userdataUtils.getData(context);
        const openai = new OpenAI({
            apiKey: local ? "not-needed" : user_data.apiKey,
            baseURL: user_data.baseURL
        });
        if (user_data.baseURL && user_data.model && (local || user_data.apiKey)) {
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

var openedFiles = {};
export async function activate(context) {
    await apiManager.initProfiles(context);


    const workspaceFolders = vscode.workspace.workspaceFolders;
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
            if (user_data.baseURL && user_data.apiKey && user_data.model) {
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

    const localCheck = vscode.commands.registerCommand('pcpr.localCheck', async function () {
        try {
            const user_data = userdataUtils.getLocalPlanData();
            const currentFile = userContextUtils.getContext();
            if (user_data.baseURL && user_data.model) {
                const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
                statusBar.text = "$(sync-spin)PCPR: Local Analyzing....";
                statusBar.show();

                main(context, currentFile, true).then((result) => {
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
    context.subscriptions.push(localCheck);

    const webviewChat = vscode.commands.registerCommand('pcpr.webviewChat', async function () {
        const panel = vscode.window.createWebviewPanel(
            'pcprWebviewChat',
            'PCPR Webview',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        panel.webview.postMessage({ command: 'projectContext', data: { openedFiles } });

        let chatHistory = [];
        const scriptPath = vscode.Uri.joinPath(context.extensionUri, 'webview', 'scripts', 'main.js');
        const markedPath = vscode.Uri.joinPath(context.extensionUri, 'webview', 'scripts', 'marked.min.js');
        const stylePath = vscode.Uri.joinPath(context.extensionUri, 'webview', 'css', 'style.css');
        const scriptUri = panel.webview.asWebviewUri(scriptPath).toString();
        const markedUri = panel.webview.asWebviewUri(markedPath).toString();
        const styleUri = panel.webview.asWebviewUri(stylePath).toString();

        const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} https: data:; script-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource};">`;

        const html = webviewUtils.getWebPage(context.extensionPath, {
            SCRIPT_URI: scriptUri,
            MARKED_URI: markedUri,
            STYLE_URI: styleUri,
            CSP: cspMeta
        });
        panel.webview.html = html;

        panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'chat':
                    let totalInupt = JSON.stringify(openedFiles) + "|" + message.text;
                    const useLocal = !!message.local;
                    const response = await web_main(context, totalInupt, chatHistory, useLocal, structure);
                    chatHistory.push({ role: 'user', content: message.text });
                    if (response && response.response) {
                        chatHistory.push({ role: 'assistant', content: response.response });
                        if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
                        panel.webview.postMessage({
                            command: 'agentResponse',
                            text: response.response,
                            model: response.model,
                            usage: response.usage
                        });
                    } else {
                        panel.webview.postMessage({ command: 'agentResponse', text: 'Something went wrong.' });
                    }
                    break;
                default:
                    vscode.window.showErrorMessage("Unknown command: " + message.command);
            }
        });

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
