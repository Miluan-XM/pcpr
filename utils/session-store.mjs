import * as fs from "fs";
import * as path from "path";

const FILE_NAME = 'sessions.json';
const DEFAULT_SESSION_NAME = '新对话';

let filePath = null;
let cache = null;

const getRandomID = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;

function getCache() {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        cache = JSON.parse(raw);
    } catch (error) {
        cache = {
            sessions: [],
            activeSessionId: null
        };
    }
    return cache;
}

function saveCache() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(cache, null, 2), 'utf-8');
}

export function initSessions(workspaceRoot) {
    filePath = path.join(workspaceRoot, FILE_NAME);
    getCache();
    if ((!(cache.sessions)) || (cache.sessions.length === 0)) {
        const newSession = {
            id: getRandomID(),
            name: DEFAULT_SESSION_NAME,
            messages: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        cache.sessions = [newSession];
        cache.activeSessionId = newSession.id;
        saveCache();
    } else {
        const validIds = cache.sessions.map(s => s.id);
        const isLaw = validIds.includes(cache.activeSessionId);
        if (!isLaw) {
            cache.activeSessionId = cache.sessions[0].id;
            saveCache();
        }
    }
}

export function getSessionsList() {
    const list = cache.sessions.map(function (s) {
        return {
            id: s.id,
            name: s.name,
            updatedAt: s.updatedAt,
            messageCount: s.messages.length
        };
    });
    return list;
}

export function getActiveSessionId() {
    return cache.activeSessionId;
}

export function findSessionById(id) {
    const session = cache.sessions.find(function (s) {
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
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    cache.sessions.push(newSession);
    cache.activeSessionId = newSession.id;
    saveCache();

    return newSession;
}

export function switchSession(id) {
    const targetSession = findSessionById(id);
    if (!targetSession) {
        console.error("No such session");
        return;
    }
    cache.activeSessionId = id;
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

    if (targetSession.id === cache.activeSessionId) {
        if (cache.sessions.length > 0) {
            cache.activeSessionId = cache.sessions[0].id;
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
