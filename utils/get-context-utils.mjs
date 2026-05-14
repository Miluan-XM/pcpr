import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import ignore from "ignore"

const COMMON_IGNORED_CONTENT = ["node_modules/",
    "vendor/",
    "venv/",
    "__pycache__/",
    "dist/",
    "build/",
    "target/",
    "out/",
    ".env",
    ".env.*",
    "!.env.example",
    "*.log",
    "npm-debug.log*",
    "yarn-debug.log*",
    "yarn-error.log*",
    ".DS_Store",
    "Thumbs.db"].join("\n");

// Get information of file that user is editing.(active text editor)
export function getContext() {
    let activated_editor = vscode.window.activeTextEditor;
    if (activated_editor) {
        let fileName = activated_editor.document.fileName.split(/[\\/]/).pop();
        let content = activated_editor.document.getText();
        return {
            fileName,
            content
        }
    }
}

// Get information of file that user is editing.(active text editor)
export function getCurrentFile() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        return {
            filePath: editor.document.uri.fsPath,
            content: editor.document.getText()
        };
    }
    return null;
}


function generateDirectoryStructureString(structureObj) {
    let result = "";
    for (const item of structureObj) {
        result += "-".repeat(item.depth) + item.name + "\n";
        if (item.type === "directory" && item.children) {
            result += generateDirectoryStructureString(item.children);
        }
    }
    return result;
}

async function generateDirectoryStructureObject(gitignorePath, ignoredPattens, rootPath, depth) {
    let structureObj = [];
    const items = await fs.promises.readdir(rootPath, { withFileTypes: true });
    for (const item of items) {
        const itemPath = path.join(rootPath, item.name);
        let relativePath = item.isDirectory() ? path.relative(gitignorePath, itemPath) + "/" : path.relative(gitignorePath, itemPath);
        if (ignoredPattens.ignores(relativePath)) {
            continue;
        }
        if (item.isDirectory()) {
            structureObj.push({
                name: item.name,
                type: "directory",
                depth: depth,
                children: await generateDirectoryStructureObject(gitignorePath, ignoredPattens, itemPath, depth + 1)
            });
        } else {
            structureObj.push({
                name: item.name,
                type: "file",
                depth: depth
            });
        }
    }
    return structureObj;
}

async function generateDirectoryStructure(rootPAthName, gitignorePath, ignoredPattens, rootPath, depth) {
    const structureObj = await generateDirectoryStructureObject(gitignorePath, ignoredPattens, rootPath, depth);
    return rootPAthName + "\n" + generateDirectoryStructureString(structureObj);
}

function getIgnoredPattens(rootPath) {
    const gitignorePath = path.join(rootPath, ".gitignore");
    if (fs.existsSync(gitignorePath)) {
        var gitignoreContent = fs.readFileSync(gitignorePath, "utf-8");
    } else {
        var gitignoreContent = COMMON_IGNORED_CONTENT;
    }
    const ig = ignore().add(gitignoreContent);
    return ig;
}

// Get workspace structure.
export async function getWorkspaceStructure(workspaceFolders) {
    if (workspaceFolders) {
        const rootPath = workspaceFolders[0].uri.fsPath;
        const rootPathName = path.basename(rootPath);
        let ignoredPattens = getIgnoredPattens(rootPath);
        const structure = await generateDirectoryStructure(rootPathName, rootPath, ignoredPattens, rootPath, 1);
        return structure;
    }
    return [];
}   
