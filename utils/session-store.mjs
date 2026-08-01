import * as fs from "fs";
import * as path from "path";

const FILE_NAME = 'sessions.json';
const DEFAULT_SESSION_NAME = '新对话';

let filePath = null;
let cache = null;
let currentProjectPath = null;

const getRandomID = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;

function getCache() {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        cache = JSON.parse(raw);
    } catch (error) {
        cache = {
            sessions: [],
            activeSessions: {}
        };
    }
    if (!cache.activeSessions) {
        cache.activeSessions = {};
    }
    if (!Array.isArray(cache.sessions)) {
        cache.sessions = [];
    }
    return cache;
}

function getProjectSessions() {
    return cache.sessions.filter(function (s) {
        return s.projectPath === currentProjectPath;
    });
}

function setActiveSessionId(id) {
    cache.activeSessions[currentProjectPath] = id;
}

function saveCache() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
}

export function initSessions(storageDir, projectPath) {
    filePath = path.join(storageDir, FILE_NAME);
    currentProjectPath = projectPath === undefined ? null : projectPath;
    getCache();

    // 兼容旧版本数据：没有 projectPath 的会话归入当前项目
    let migrated = false;
    for (const s of cache.sessions) {
        if (!s.projectPath) {
            s.projectPath = currentProjectPath;
            migrated = true;
        }
    }
    // 兼容旧版本：activeSessionId 迁移为当前项目的激活会话
    if (cache.activeSessionId) {
        if (!cache.activeSessions[currentProjectPath]) {
            cache.activeSessions[currentProjectPath] = cache.activeSessionId;
        }
        delete cache.activeSessionId;
        migrated = true;
    }

    let projectSessions = getProjectSessions();
    if (projectSessions.length === 0) {
        const newSession = {
            id: getRandomID(),
            name: DEFAULT_SESSION_NAME,
            projectPath: currentProjectPath,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        cache.sessions.push(newSession);
        setActiveSessionId(newSession.id);
        saveCache();
    } else {
        const validIds = projectSessions.map(s => s.id);
        if (!validIds.includes(cache.activeSessions[currentProjectPath])) {
            setActiveSessionId(projectSessions[0].id);
            saveCache();
        }
    }
    if (migrated) {
        saveCache();
    }
}

export function getSessionsList() {
    const list = getProjectSessions().map(function (s) {
        return {
            id: s.id,
            name: s.name,
            projectPath: s.projectPath,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length
        };
    });
    return list;
}

export function getActiveSessionId() {
    return cache.activeSessions[currentProjectPath];
}

export function findSessionById(id) {
    const session = getProjectSessions().find(function (s) {
        return s.id === id;
    });
    return session;
}

export function getActiveSessionMessages() {
    const activeId = getActiveSessionId();
    const targetSession = findSessionById(activeId);
    if ((!targetSession) || (!activeId)) {
        return [];
    }

    return [...targetSession.messages];
}

export function createNewSession() {
    const newSession = {
        id: getRandomID(),
        name: DEFAULT_SESSION_NAME,
        projectPath: currentProjectPath,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    cache.sessions.push(newSession);
    setActiveSessionId(newSession.id);
    saveCache();

    return newSession;
}

export function switchSession(id) {
    const targetSession = findSessionById(id);
    if (!targetSession) {
        console.error("No such session");
        return;
    }
    setActiveSessionId(id);
    saveCache();
}

export function deleteSession(id) {
    const targetSession = findSessionById(id);
    if (!targetSession) {
        console.error("No such session");
        return;
    }
    const targetIndex = cache.sessions.indexOf(targetSession);
    cache.sessions.splice(targetIndex, 1);

    if (targetSession.id === cache.activeSessions[currentProjectPath]) {
        const projectSessions = getProjectSessions();
        if (projectSessions.length > 0) {
            setActiveSessionId(projectSessions[0].id);
        } else {
            createNewSession();
        }
    }
    saveCache();
}

export function saveMessages(id, messages) {
    const targetSession = findSessionById(id);
    if (!targetSession) {
        console.error("No such session");
        return;
    }

    targetSession.messages = messages;
    targetSession.updatedAt = Date.now();
    saveCache();
}

export function renameSession(id, newName) {
    const targetSession = findSessionById(id);
    if (!targetSession) {
        console.error("No such session");
        return;
    }
    targetSession.name = newName;
    saveCache();
}
