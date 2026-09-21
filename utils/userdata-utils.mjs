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

// Gets active API configuration.
// Returns Object of configuration, or Object with undefined fields if none is active.
export async function getData(context) {
    try {
        const profiles = context.globalState.get('pcpr.apiProfiles', []);
        const activeId = context.globalState.get('pcpr.activeProfileId');
        const profile = profiles.find(p => p.id === activeId);
        if (!profile) {
            return { baseURL: undefined, apiKey: undefined, model: undefined };
        }
        const apiKey = await context.secrets.get('pcpr.apiKey.' + profile.id);
        return {
            baseURL: profile.baseURL,
            apiKey: apiKey,
            model: profile.models[profile.selectedModelIndex]?.name
        };
    } catch (err) {
        vscode.window.showErrorMessage("getData Error: " + String(err));
        return false;
    }
}
