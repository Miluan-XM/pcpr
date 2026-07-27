import * as vscode from 'vscode';

const KEYS = {
    PROFILES: 'pcpr.apiProfiles',
    ACTIVE_ID: 'pcpr.activeProfileId',
    API_KEY: 'pcpr.apiKey',
    API_KEY_PREFIX: 'pcpr.apiKey.',
    CONFIG: 'pcpr'
};

const getRandomID = () => `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 10)}`;
const getModelName = p => p.models[p.selectedModelIndex]?.name || '';
const _isActive = (context, id) => getActiveProfileID(context) === id;

// ── 数据层 ──

export function getAllProfile(context) {
    return context.globalState.get(KEYS.PROFILES, []);
}

export async function saveProfiles(context, profiles) {
    await context.globalState.update(KEYS.PROFILES, profiles);
}

export function getActiveProfileID(context) {
    return context.globalState.get(KEYS.ACTIVE_ID);
}

export function findProfile(profiles, profileID) {
    return profiles.find(p => p.id === profileID) || null;
}

export function getActiveProfile(context) {
    return findProfile(getAllProfile(context), getActiveProfileID(context));
}

export async function saveAPIKey(context, profileID, key) {
    await context.secrets.store(KEYS.API_KEY_PREFIX + profileID, key);
}

export async function getAPIKey(context, profileID) {
    return await context.secrets.get(KEYS.API_KEY_PREFIX + profileID);
}

export async function deleteAPIKey(context, profileID) {
    await context.secrets.delete(KEYS.API_KEY_PREFIX + profileID);
}



// ── 核心操作 ──

export async function activateProfile(context, profileID) {
    const profile = findProfile(getAllProfile(context), profileID);
    if (!profile) return vscode.window.showErrorMessage('API 配置不存在');

    const config = vscode.workspace.getConfiguration(KEYS.CONFIG);
    const modelName = getModelName(profile);

    if (profile.isLocal) {
        await config.update('localBaseURL', profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('localModel', modelName, vscode.ConfigurationTarget.Global);
    } else {
        await config.update('cloudBaseURL', profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('cloudModel', modelName, vscode.ConfigurationTarget.Global);
        const key = await getAPIKey(context, profileID);
        key ? await context.secrets.store(KEYS.API_KEY, key) : await context.secrets.delete(KEYS.API_KEY);
    }

    await context.globalState.update(KEYS.ACTIVE_ID, profileID);
    vscode.window.showInformationMessage(`已切换到: ${profile.name} / ${modelName || '未选择模型'}`);
}

export async function activateModel(context, modelIndex) {
    const profile = getActiveProfile(context);
    if (!profile) return vscode.window.showErrorMessage('没有激活的 API 配置');
    if (modelIndex < 0 || modelIndex >= profile.models.length) return vscode.window.showErrorMessage('无效的模型索引');

    profile.selectedModelIndex = modelIndex;
    const profiles = getAllProfile(context);
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx !== -1) { profiles[idx] = profile; await saveProfiles(context, profiles); }
    await activateProfile(context, profile.id);
}

export async function addProfile(context, profile) {
    const profiles = getAllProfile(context);
    profile.id = getRandomID();
    profiles.push(profile);
    await saveProfiles(context, profiles);
    if (profiles.length === 1) await activateProfile(context, profile.id);
    return profile;
}

export async function deleteProfile(context, profileID) {
    const profiles = getAllProfile(context);
    const idx = profiles.findIndex(p => p.id === profileID);
    if (idx === -1) return;

    const wasActive = _isActive(context, profileID);
    await deleteAPIKey(context, profileID);
    profiles.splice(idx, 1);
    await saveProfiles(context, profiles);

    if (wasActive) {
        if (profiles.length > 0) {
            await activateProfile(context, profiles[0].id);
        } else {
            await context.globalState.update(KEYS.ACTIVE_ID, undefined);
            await context.secrets.delete(KEYS.API_KEY);
            const config = vscode.workspace.getConfiguration(KEYS.CONFIG);
            for (const k of ['cloudBaseURL', 'cloudModel', 'localBaseURL', 'localModel'])
                await config.update(k, '', vscode.ConfigurationTarget.Global);
        }
    }
}

export async function updateProfile(context, profileID, updates) {
    const profiles = getAllProfile(context);
    const target = findProfile(profiles, profileID);
    if (!target) return;
    Object.assign(target, updates);
    await saveProfiles(context, profiles);
    if (_isActive(context, profileID)) await activateProfile(context, profileID);
}

// ── 初始化 / 迁移 ──

export async function initProfiles(context) {
    if (getAllProfile(context).length > 0) return;

    const config = vscode.workspace.getConfiguration(KEYS.CONFIG);
    const cloudURL = config.get('cloudBaseURL', ''), cloudModel = config.get('cloudModel', '');
    const localURL = config.get('localBaseURL', ''), localModel = config.get('localModel', '');
    const defaults = [];

    if (cloudURL || cloudModel) {
        defaults.push({
            id: getRandomID(), name: '默认云端', baseURL: cloudURL || '',
            models: cloudModel ? [{ name: cloudModel }] : [], selectedModelIndex: 0, isLocal: false
        });
    }
    if (localURL || localModel) {
        defaults.push({
            id: getRandomID(), name: '默认本地', baseURL: localURL || 'http://localhost:11434/v1/',
            models: localModel ? [{ name: localModel }] : [], selectedModelIndex: 0, isLocal: true
        });
    }

    if (defaults.length > 0) {
        await saveProfiles(context, defaults);
        await activateProfile(context, defaults[0].id);
        vscode.window.showInformationMessage('已从旧版配置迁移 API 设置');
    } else {
        vscode.window.showInformationMessage('请先添加 API 配置 (命令: PCPR: Add API)');
    }
}

// ── UI 组件 ──

export async function addApiUI(context) {
    const name = await vscode.window.showInputBox({ prompt: '输入供应商名称', ignoreFocusOut: true });
    if (!name) return;
    const baseURL = await vscode.window.showInputBox({ prompt: '输入baseURL', ignoreFocusOut: true });
    if (!baseURL) return;

    const typeChoice = await vscode.window.showQuickPick(
        [{ label: '云端', islocal: false }, { label: '本地', islocal: true }],
        { placeHolder: '请选择 API 类型', ignoreFocusOut: true }
    );
    if (!typeChoice) return;
    const isLocal = typeChoice.islocal;

    let apiKey = '';
    if (!isLocal) {
        const keyInput = await vscode.window.showInputBox({ prompt: '请输入 API Key', password: true, ignoreFocusOut: true });
        if (!keyInput) return;
        apiKey = keyInput;
    }

    const modelsInput = await vscode.window.showInputBox({
        prompt: '请输入模型名称（多个用英文逗号分隔，最多 3 个）',
        ignoreFocusOut: true,
        validateInput: v => {
            const m = v.split(',').map(s => s.trim()).filter(s => s);
            return m.length === 0 ? '请至少输入一个模型名称' : m.length > 3 ? '最多只能添加 3 个模型' : null;
        }
    });
    if (!modelsInput) return;

    const models = modelsInput.split(',').map(s => s.trim()).filter(s => s).map(name => ({ name }));
    const saved = await addProfile(context, { name, baseURL, models, selectedModelIndex: 0, isLocal });

    if (!isLocal && apiKey) {
        await saveAPIKey(context, saved.id, apiKey);
        if (_isActive(context, saved.id)) await activateProfile(context, saved.id);
    }
    vscode.window.showInformationMessage(`API "${name}" 添加成功！`);
}

export async function buildProfileItems(context, profile) {
    const items = [
        { label: `$(symbol-key) 名称: ${profile.name}`, field: 'name', description: '修改显示名称' },
        { label: `$(link) Base URL: ${profile.baseURL}`, field: 'baseURL', description: '修改 API 基础地址' }
    ];

    if (!profile.isLocal) {
        items.push({
            label: `$(key) API Key: ${(await getAPIKey(context, profile.id)) ? '已设置' : '未设置'}`,
            field: 'apiKey', description: '修改或设置 API Key'
        });
    }

    items.push({
        label: `$(package) 模型列表 (${profile.models.length}个)`,
        field: 'models',
        description: profile.models.map(m => m.name).join(', ') || '无模型'
    });

    if (profile.models.length > 1) {
        items.push({
            label: `$(check) 当前模型: ${getModelName(profile)}`,
            field: 'selectedModelIndex',
            description: '更改默认使用的模型'
        });
    }

    return items;
}

// 统一的字段编辑分发
async function _editField(context, profile, field) {
    const ok = { name: '名称已更新', baseURL: 'Base URL 已更新', apiKey: 'API Key 已更新', models: '模型列表已更新', selectedModelIndex: '默认模型已切换' };

    switch (field) {
        case 'name': {
            const v = await vscode.window.showInputBox({ prompt: '输入新名称', value: profile.name, ignoreFocusOut: true });
            if (v !== undefined) await updateProfile(context, profile.id, { name: v });
            break;
        }
        case 'baseURL': {
            const v = await vscode.window.showInputBox({
                prompt: '输入新的 Base URL', value: profile.baseURL, ignoreFocusOut: true,
                validateInput: v => (v.startsWith('http://') || v.startsWith('https://')) ? null : 'URL 必须以 http:// 或 https:// 开头'
            });
            if (v !== undefined) await updateProfile(context, profile.id, { baseURL: v });
            break;
        }
        case 'apiKey': {
            const v = await vscode.window.showInputBox({ prompt: '输入新的 API Key（留空则删除）', password: true, ignoreFocusOut: true });
            if (v !== undefined) {
                v === '' ? await deleteAPIKey(context, profile.id) : await saveAPIKey(context, profile.id, v);
                if (_isActive(context, profile.id)) await activateProfile(context, profile.id);
            }
            break;
        }
        case 'models': {
            const v = await vscode.window.showInputBox({
                prompt: '输入模型名称，用英文逗号分隔（最多3个）',
                value: profile.models.map(m => m.name).join(','), ignoreFocusOut: true,
                validateInput: v => { const m = v.split(',').map(s => s.trim()).filter(s => s); return m.length === 0 ? '至少需要一个模型' : m.length > 3 ? '最多 3 个模型' : null; }
            });
            if (v !== undefined) {
                const newModels = v.split(',').map(s => s.trim()).filter(s => s).map(n => ({ name: n }));
                await updateProfile(context, profile.id, {
                    models: newModels, selectedModelIndex: Math.min(profile.selectedModelIndex, newModels.length - 1)
                });
            }
            break;
        }
        case 'selectedModelIndex': {
            const items = profile.models.map((m, i) => ({
                label: (i === profile.selectedModelIndex ? '$(circle-filled) ' : '$(circle-outline) ') + m.name, modelIndex: i
            }));
            const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择默认模型', ignoreFocusOut: true });
            if (picked) {
                await updateProfile(context, profile.id, { selectedModelIndex: picked.modelIndex });
                if (_isActive(context, profile.id)) await activateProfile(context, profile.id);
            }
            break;
        }
    }
    if (ok[field]) vscode.window.showInformationMessage(ok[field]);
}

export async function editApiUI(context, profileID) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('没有可编辑的 API 配置');

    if (!profileID) {
        const picked = await vscode.window.showQuickPick(
            profiles.map(p => ({ label: p.name, description: p.baseURL, profileID: p.id })),
            { placeHolder: '选择要编辑的 API 配置', ignoreFocusOut: true }
        );
        if (!picked) return;
        profileID = picked.profileID;
    }

    const profile = findProfile(profiles, profileID);
    if (!profile) return vscode.window.showErrorMessage('未找到该 API 配置');

    const items = await buildProfileItems(context, profile);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要修改的字段', ignoreFocusOut: true });
    if (picked) await _editField(context, profile, picked.field);
}



export async function deleteApiUI(context, profileId) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('没有可删除的 API 配置');

    if (!profileId) {
        const picked = await vscode.window.showQuickPick(
            profiles.map(p => ({ label: p.name, description: p.baseURL, profileId: p.id })),
            { placeHolder: '选择要删除的 API 配置', ignoreFocusOut: true }
        );
        if (!picked) return;
        profileId = picked.profileId;
    }

    const p = findProfile(profiles, profileId);
    if (!p) return vscode.window.showErrorMessage('未找到该 API 配置');

    const confirm = await vscode.window.showWarningMessage(
        `确定删除 "${p.name}" 吗？此操作不可恢复。`, { modal: true }, '确定删除'
    );
    if (confirm !== '确定删除') return;

    await deleteProfile(context, profileId);
    vscode.window.showInformationMessage('已删除: ' + p.name);
}

async function _selectProfileUI(context, profileID) {
    const profile = findProfile(getAllProfile(context), profileID);
    const modelName = getModelName(profile);

    const items = [
        { label: '$(arrow-right) 切换到此 API', action: 'activate' },
        { label: '$(edit) 编辑', action: 'edit' },
        {
            label: `$(list-unordered) 切换模型${profile.models.length > 1 ? '' : ' (只有一个模型)'}`,
            description: profile.models.length > 1 ? `当前：${modelName}` : '', action: 'switchModel'
        },
        { label: '$(trash) 删除', action: 'delete' }
    ];

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `对 "${profile.name}" 进行操作`, ignoreFocusOut: true });
    if (!picked) return;

    const actions = {
        activate: () => activateProfile(context, profileID),
        edit: () => editApiUI(context, profile.id),
        switchModel: () => switchModelUI(context, profile),
        delete: () => deleteApiUI(context, profile.id)
    };
    await actions[picked.action]();
}

export async function switchApiUI(context) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('没有可用的 API 配置，请先添加 (PCPR: Add API)');

    const activeId = getActiveProfileID(context);
    const items = profiles.map(p => ({
        label: (p.id === activeId ? '$(circle-filled) ' : '$(circle-outline) ') + p.name,
        description: getModelName(p) || '未选择模型',
        detail: `${p.baseURL}  |  ${p.isLocal ? '本地' : '云端'}`,
        profileId: p.id
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要使用的 API 配置', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true
    });
    if (picked) await activateProfile(context, picked.profileId);
}

export async function switchModelUI(context, profile) {
    const items = profile.models.map((m, i) => ({
        label: (i === profile.selectedModelIndex ? '$(circle-filled) ' : '$(circle-outline) ') + m.name, modelIndex: i
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: '选择要使用的模型', ignoreFocusOut: true });
    if (picked) await activateModel(context, picked.modelIndex);
}

export async function manageApisUI(context) {
    const makeItems = () => {
        const items = [{ label: '$(add) 添加新的 API', detail: '创建一个新的 API 配置', action: 'add' }];
        const profiles = getAllProfile(context);
        if (profiles.length === 0) return items;

        items.push({ label: '-----', description: '', detail: '', action: 'sep' });
        for (const p of profiles) {
            items.push({
                label: (_isActive(context, p.id) ? '$(circle-filled) ' : '$(circle-outline) ') + p.name,
                description: getModelName(p) || 'No model selected',
                detail: `${p.baseURL}  |  ${p.isLocal ? '本地' : '云端'}`,
                action: 'select', profileId: p.id
            });
        }
        return items;
    };

    for (;;) {
        const picked = await vscode.window.showQuickPick(makeItems(), {
            placeHolder: '选择一个 Profile 进行操作，或选择添加新的 API',
            matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true
        });
        if (!picked) return;
        if (picked.action === 'add') { await addApiUI(context); continue; }
        if (picked.action === 'sep') continue;
        if (picked.action === 'select') { await _selectProfileUI(context, picked.profileId); continue; }
    }
}

