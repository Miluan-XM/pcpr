import * as fs from "fs";
import * as path from "path";

/**
 * 全局缓存对象，对应 `sessions.json` 的内存镜像。
 * 
 * @type {{
 *   sessions: Array<{
 *     id: string,
 *     name: string,
 *     projectPath: string | null,
 *     messages: Array<{role: string, content: string}>,
 *     createdAt: number,
 *     updatedAt: number
 *   }>,
 *   activeSessions: { [projectPath: string]: string }
 * }}
 * 
 * @property {Object[]} sessions - 所有会话实体数组
 * @property {string} sessions[].id - 会话唯一标识
 * @property {string} sessions[].name - 会话名称
 * @property {string|null} sessions[].projectPath - 所属项目根目录，null 表示无工作区
 * @property {Array} sessions[].messages - 消息历史，元素格式 {role: 'user'|'assistant', content: string}
 * @property {number} sessions[].createdAt - 创建时间戳
 * @property {number} sessions[].updatedAt - 最后更新时间戳
 * @property {Object<string, string>} activeSessions - 各项目当前激活的会话 ID，键为项目路径
 */



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
