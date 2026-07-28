import fs from "fs";
import path from "path";
import * as vscode from "vscode";

// Gets system prompt.
export function getSysPrompt(extensionPath) {
    let filePath = path.join(extensionPath, "./config/system_prompt.json");
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
        return false;
    }
}

// Gets current configuraion.
// Returns Object of configuration on success, false on error.
export async function getData(context) {
    try {
        const config = vscode.workspace.getConfiguration('pcpr');
        const apiKey = await context.secrets.get('pcpr.apiKey');
        const cloudConfig = {
            baseURL: config.get("cloudBaseURL"),
            apiKey: apiKey,
            model: config.get("cloudModel")
        };
        return cloudConfig;
    } catch (err) {
        vscode.window.showErrorMessage("getData Error: " + String(err));
        return false;
    }
}

// Gets current local plan configuraion.
// Returns Object of configuration on success, false on error.
export function getLocalPlanData() {
    try {
        const config = vscode.workspace.getConfiguration('pcpr');
        const localConfig = {
            baseURL: config.get("localBaseURL"),
            model: config.get("localModel")
        };
        return localConfig;
    } catch (err) {
        vscode.window.showErrorMessage("getLocalPlanData Error: " + String(err));
        return false;
    }
}
