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

// ── Data Layer ──

function getAllProfile(context) {
    return context.globalState.get(KEYS.PROFILES, []);
}

async function saveProfiles(context, profiles) {
    await context.globalState.update(KEYS.PROFILES, profiles);
}

function getActiveProfileID(context) {
    return context.globalState.get(KEYS.ACTIVE_ID);
}

function findProfile(profiles, profileId) {
    return profiles.find(p => p.id === profileId) || null;
}

function getActiveProfile(context) {
    return findProfile(getAllProfile(context), getActiveProfileID(context));
}

async function saveAPIKey(context, profileId, key) {
    await context.secrets.store(KEYS.API_KEY_PREFIX + profileId, key);
}

async function getAPIKey(context, profileId) {
    return await context.secrets.get(KEYS.API_KEY_PREFIX + profileId);
}

async function deleteAPIKey(context, profileId) {
    await context.secrets.delete(KEYS.API_KEY_PREFIX + profileId);
}



// ── Core Operations ──

async function activateProfile(context, profileId) {
    const profile = findProfile(getAllProfile(context), profileId);
    if (!profile) return vscode.window.showErrorMessage('API configuration does not exist');

    const config = vscode.workspace.getConfiguration(KEYS.CONFIG);
    const modelName = getModelName(profile);

    if (profile.isLocal) {
        await config.update('localBaseURL', profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('localModel', modelName, vscode.ConfigurationTarget.Global);
    } else {
        await config.update('cloudBaseURL', profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('cloudModel', modelName, vscode.ConfigurationTarget.Global);
        const key = await getAPIKey(context, profileId);
        key ? await context.secrets.store(KEYS.API_KEY, key) : await context.secrets.delete(KEYS.API_KEY);
    }

    await context.globalState.update(KEYS.ACTIVE_ID, profileId);
    vscode.window.showInformationMessage(`Switched to: ${profile.name} / ${modelName || 'No model selected'}`);
}

async function activateModel(context, modelIndex) {
    const profile = getActiveProfile(context);
    if (!profile) return vscode.window.showErrorMessage('No active API configuration');
    if (modelIndex < 0 || modelIndex >= profile.models.length) return vscode.window.showErrorMessage('Invalid model index');

    profile.selectedModelIndex = modelIndex;
    const profiles = getAllProfile(context);
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx !== -1) { profiles[idx] = profile; await saveProfiles(context, profiles); }
    await activateProfile(context, profile.id);
}

async function addProfile(context, profile) {
    const profiles = getAllProfile(context);
    profile.id = getRandomID();
    profiles.push(profile);
    await saveProfiles(context, profiles);
    if (profiles.length === 1) await activateProfile(context, profile.id);
    return profile;
}

async function deleteProfile(context, profileId) {
    const profiles = getAllProfile(context);
    const idx = profiles.findIndex(p => p.id === profileId);
    if (idx === -1) return;

    const wasActive = _isActive(context, profileId);
    await deleteAPIKey(context, profileId);
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

async function updateProfile(context, profileId, updates) {
    const profiles = getAllProfile(context);
    const target = findProfile(profiles, profileId);
    if (!target) return;
    Object.assign(target, updates);
    await saveProfiles(context, profiles);
    if (_isActive(context, profileId)) await activateProfile(context, profileId);
}

// ── UI Components ──

export async function addApiUI(context) {
    const name = await vscode.window.showInputBox({ prompt: 'Enter provider name', ignoreFocusOut: true });
    if (!name) return;
    const baseURL = await vscode.window.showInputBox({ prompt: 'Enter base URL', ignoreFocusOut: true });
    if (!baseURL) return;

    const typeChoice = await vscode.window.showQuickPick(
        [{ label: 'Cloud', islocal: false }, { label: 'Local', islocal: true }],
        { placeHolder: 'Select API type', ignoreFocusOut: true }
    );
    if (!typeChoice) return;
    const isLocal = typeChoice.islocal;

    let apiKey = '';
    if (!isLocal) {
        const keyInput = await vscode.window.showInputBox({ prompt: 'Enter API Key', password: true, ignoreFocusOut: true });
        if (!keyInput) return;
        apiKey = keyInput;
    }

    const modelsInput = await vscode.window.showInputBox({
        prompt: 'Enter model names separate multiple with commas(,)',
        ignoreFocusOut: true,
        validateInput: v => {
            const m = v.split(',').map(s => s.trim()).filter(s => s);
            return m.length === 0 ? 'Please enter at least one model name' : null;
        }
    });
    if (!modelsInput) return;

    const models = modelsInput.split(',').map(s => s.trim()).filter(s => s).map(name => ({ name }));
    const saved = await addProfile(context, { name, baseURL, models, selectedModelIndex: 0, isLocal });

    if (!isLocal && apiKey) {
        await saveAPIKey(context, saved.id, apiKey);
        if (_isActive(context, saved.id)) await activateProfile(context, saved.id);
    }
    vscode.window.showInformationMessage(`API "${name}" added successfully!`);
}

async function buildProfileItems(context, profile) {
    const items = [
        { label: `$(symbol-key) Name: ${profile.name}`, field: 'name', description: 'Change display name' },
        { label: `$(link) Base URL: ${profile.baseURL}`, field: 'baseURL', description: 'Change API base URL' }
    ];

    if (!profile.isLocal) {
        items.push({
            label: `$(key) API Key: ${(await getAPIKey(context, profile.id)) ? 'Set' : 'Not set'}`,
            field: 'apiKey', description: 'Modify or set API Key'
        });
    }

    items.push({
        label: `$(package) Models (${profile.models.length})`,
        field: 'models',
        description: profile.models.map(m => m.name).join(', ') || 'No models'
    });

    if (profile.models.length > 1) {
        items.push({
            label: `$(check) Current model: ${getModelName(profile)}`,
            field: 'selectedModelIndex',
            description: 'Change default model'
        });
    }

    return items;
}

// Unified field editing dispatcher
async function _editField(context, profile, field) {
    const ok = { name: 'Name updated', baseURL: 'Base URL updated', apiKey: 'API Key updated', models: 'Model list updated', selectedModelIndex: 'Default model switched' };

    switch (field) {
        case 'name': {
            const v = await vscode.window.showInputBox({ prompt: 'Enter new name', value: profile.name, ignoreFocusOut: true });
            if (v !== undefined) await updateProfile(context, profile.id, { name: v });
            break;
        }
        case 'baseURL': {
            const v = await vscode.window.showInputBox({
                prompt: 'Enter new Base URL', value: profile.baseURL, ignoreFocusOut: true,
                validateInput: v => (v.startsWith('http://') || v.startsWith('https://')) ? null : 'URL must start with http:// or https://'
            });
            if (v !== undefined) await updateProfile(context, profile.id, { baseURL: v });
            break;
        }
        case 'apiKey': {
            const v = await vscode.window.showInputBox({ prompt: 'Enter new API Key (leave empty to delete)', password: true, ignoreFocusOut: true });
            if (v !== undefined) {
                v === '' ? await deleteAPIKey(context, profile.id) : await saveAPIKey(context, profile.id, v);
                if (_isActive(context, profile.id)) await activateProfile(context, profile.id);
            }
            break;
        };
        case 'models': {
            const v = await vscode.window.showInputBox({
                prompt: 'Enter model names, separated by commas(,)',
                value: profile.models.map(m => m.name).join(','), ignoreFocusOut: true,
                validateInput: v => { const m = v.split(',').map(s => s.trim()).filter(s => s); return m.length === 0 ? 'At least one model required' : null; }
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
            const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select default model', ignoreFocusOut: true });
            if (picked) {
                await updateProfile(context, profile.id, { selectedModelIndex: picked.modelIndex });
                if (_isActive(context, profile.id)) await activateProfile(context, profile.id);
            }
            break;
        }
    }
    if (ok[field]) vscode.window.showInformationMessage(ok[field]);
}

export async function editApiUI(context, profileId) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('No API configuration to edit');

    if (!profileId) {
        const picked = await vscode.window.showQuickPick(
            profiles.map(p => ({ label: p.name, description: p.baseURL, profileId: p.id })),
            { placeHolder: 'Select API configuration to edit', ignoreFocusOut: true }
        )
        if (!picked) return;
        profileId = picked.profileId;
    }

    const profile = findProfile(profiles, profileId);
    if (!profile) return vscode.window.showErrorMessage('API configuration not found');

    const items = await buildProfileItems(context, profile);
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select field to modify', ignoreFocusOut: true });
    if (picked) await _editField(context, profile, picked.field);
}



export async function deleteApiUI(context, profileId) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('No API configuration to delete');

    if (!profileId) {
        const picked = await vscode.window.showQuickPick(
            profiles.map(p => ({ label: p.name, description: p.baseURL, profileId: p.id })),
            { placeHolder: 'Select API configuration to delete', ignoreFocusOut: true }
        );
        if (!picked) return;
        profileId = picked.profileId;
    }

    const p = findProfile(profiles, profileId);
    if (!p) return vscode.window.showErrorMessage('API configuration not found');

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to delete "${p.name}"? This action cannot be undone.`, { modal: true }, 'Delete'
    );
    if (confirm !== 'Delete') return;

    await deleteProfile(context, profileId);
    vscode.window.showInformationMessage('Deleted: ' + p.name);
}

async function _selectProfileUI(context, profileId) {
    const profile = findProfile(getAllProfile(context), profileId);
    const modelName = getModelName(profile);

    const items = [
        { label: '$(edit) Edit', action: 'edit' },
        {
            label: `$(list-unordered) Switch model${profile.models.length > 1 ? '' : ' (only one model)'}`,
            description: profile.models.length > 1 ? `Current: ${modelName}` : '', action: 'switchModel'
        },
        { label: '$(trash) Delete', action: 'delete' }
    ];

    const picked = await vscode.window.showQuickPick(items, { placeHolder: `Actions for "${profile.name}"`, ignoreFocusOut: true });
    if (!picked) return;

    const actions = {
        // activate: () => activateProfile(context, profileId),
        edit: () => editApiUI(context, profile.id),
        switchModel: () => switchModelUI(context, profile),
        delete: () => deleteApiUI(context, profile.id)
    };
    await actions[picked.action]();
}

export async function switchApiUI(context) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) return vscode.window.showInformationMessage('No API configuration available. Please add one first (PCPR: Add API)');

    const activeId = getActiveProfileID(context);
    const items = profiles.map(p => ({
        label: (p.id === activeId ? '$(circle-filled) ' : '$(circle-outline) ') + p.name,
        description: getModelName(p) || 'No model selected',
        detail: `${p.baseURL}  |  ${p.isLocal ? 'Local' : 'Cloud'}`,
        profileId: p.id
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select API configuration to use', matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true
    });
    if (picked) await activateProfile(context, picked.profileId);
}

async function switchModelUI(context, profile) {
    const items = profile.models.map((m, i) => ({
        label: (i === profile.selectedModelIndex ? '$(circle-filled) ' : '$(circle-outline) ') + m.name, modelIndex: i
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Select model to use', ignoreFocusOut: true });
    if (picked) await activateModel(context, picked.modelIndex);
}

export async function manageApisUI(context) {
    const makeItems = () => {
        const items = [{ label: '$(add) Add new API', detail: 'Create a new API configuration', action: 'add' }];
        const profiles = getAllProfile(context);
        if (profiles.length === 0) return items;

        items.push({ label: '-----', description: '', detail: '', action: 'sep' });
        for (const p of profiles) {
            items.push({
                label: (_isActive(context, p.id) ? '$(circle-filled) ' : '$(circle-outline) ') + p.name,
                description: getModelName(p) || 'No model selected',
                detail: `${p.baseURL}  |  ${p.isLocal ? 'Local' : 'Cloud'}`,
                action: 'select', profileId: p.id
            });
        }
        return items;
    };

    while (true) {
        const picked = await vscode.window.showQuickPick(makeItems(), {
            placeHolder: 'Select a profile to manage, or add a new API',
            matchOnDescription: true, matchOnDetail: true, ignoreFocusOut: true
        });
        if (!picked) return;
        if (picked.action === 'add') { await addApiUI(context); continue; }
        if (picked.action === 'sep') continue;
        if (picked.action === 'select') {
            await activateProfile(context, picked.profileId);
            await _selectProfileUI(context, picked.profileId);
            continue;
        };
    }
}

