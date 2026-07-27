import * as vscode from 'vscode';

/**
 * @typedef {Object} Profile
 * @property {string} id - 唯一标识
 * @property {string} name - 显示名称
 * @property {string} baseURL - API 基础 URL
 * @property {Array<{name: string}>} models - 模型列表
 * @property {number} selectedModelIndex - 当前选中的模型索引
 * @property {boolean} isLocal - 是否为本地 API
 */



/**
 * 获得随机的id
 * @returns 生成的随机字符串id
 */
function getRandomID(){
    const timePart=Date.now().toString(36);

    const temp=Math.random().toString(36);
    const RandomPart=temp.substring(2,10);
    const id =`${timePart}-${RandomPart}`;
    return id;
}

/**
 * 获得profile
 * @param {} context 扩展上下文
 * @returns {} profiles 数组
 */


export function getAllProfile(context){
    const profiles=context.globalState.get('pcpr.apiProfiles',[]);
    return profiles;
}

/**
 * 将 profiles 保存到 context 的 globalState 中
 * @param {*} context 扩展上下文
 * @param {*} profiles 配置数组
 */

export async function saveProfiles(context,profiles){
    await context.globalState.update('pcpr.apiProfiles',profiles);
}


/**
 * 获取当前激活的 Profile 的 id
 * @param {*} context 扩展上下文
 * @returns id
 */
export function getActiveProfileID(context){
    const activeID = context.globalState.get('pcpr.activeProfileId');
    return activeID;
}

/**
 * 在 profiles 数组中查找指定 id 的 profile
 * @param {Array} profiles 配置数组
 * @param {string} profileID 要查找的 profile id
 * @returns {Object|null} 找到的 profile 对象，未找到则返回 null
 */
export function findProfile(profiles,profileID){
    const target=profiles.find(function(profile){
        return profile.id===profileID;
    })
    if(target===undefined){
        return null
    }else {
        return target;
    }
}


/**
 * 获取当前激活的 profile 对象信息
 * @param {*} context 扩展上下文
 * @returns {Object|null} 当前激活的 profile 对象，没有激活则返回 null
 */

export function getActiveProfile(context){
    const profiles=getAllProfile(context);
    const activeID=getActiveProfileID(context);
    const target=profiles.find(function(profile){
        return profile.id===activeID;
    })

    if(target===undefined){
        return null
    }else {
        return target;
    }
}
/**
 * 将输入的 API Key 按照 id 加密存储
 * @param {*} context 扩展上下文
 * @param {*} profileID 配置 id
 * @param {*} key 用户输入的 API Key
 */
export async function saveAPIKey(context,profileID,key){
    const KeyID='pcpr.apiKey.'+profileID;
    await context.secrets.store(KeyID,key);
}
/**
 * 根据 id 获取存储的 API Key
 * @param {*} context 扩展上下文
 * @param {*} profileID 配置 id
 * @returns {string|null} 存储的 API Key
 */
export async function getAPIKey(context,profileID) {
    const KeyID='pcpr.apiKey.'+profileID;
    const Key=await context.secrets.get(KeyID);
    return Key;
}
/**
 * 根据提供的 id 删除对应的 API Key
 * @param {*} context 扩展上下文
 * @param {*} profileID 配置 id
 */
export async function deleteAPIKey(context,profileID){
    const KeyID='pcpr.apiKey.'+profileID;
    await context.secrets.delete(KeyID);
}



/**
 * 激活指定 id 的 profile，将其配置写入 VS Code Settings 和 Secrets
 * @param {*} context 扩展上下文
 * @param {string} profileID 要激活的 profile id
 */
export async function activateProfile(context,profileID){
    const profiles=getAllProfile(context);
    const target_profile=findProfile(profiles,profileID);
    if(!target_profile){
        vscode.window.showErrorMessage('API 配置不存在');
        return;
    }

    const config=vscode.workspace.getConfiguration('pcpr');
    const selectedModel=target_profile.models[target_profile.selectedModelIndex];
    // 获取模型名称
    let modelName='';
    if(selectedModel){
        modelName=selectedModel.name;
    }else {
        modelName='';
    }
    // 分云端和本地更改配置
    if(target_profile.isLocal){
        // 本地
        await config.update('localBaseURL',target_profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('localModel',modelName, vscode.ConfigurationTarget.Global);
    }else {
        // 云端
        await config.update('cloudBaseURL',target_profile.baseURL, vscode.ConfigurationTarget.Global);
        await config.update('cloudModel',modelName, vscode.ConfigurationTarget.Global);

        const key=await getAPIKey(context,profileID);
        if(key){
            await context.secrets.store('pcpr.apiKey',key);
        }else{
            await context.secrets.delete('pcpr.apiKey');
        }

    }

    await context.globalState.update('pcpr.activeProfileId',profileID);
    const message ='已切换到:'  + target_profile.name +  ' / ' + (modelName || '未选择模型');
    vscode.window.showInformationMessage(message);
}

export async function activateModel(context,modelIndex){
    const profile = getActiveProfile(context);
    if (!profile) {
        vscode.window.showErrorMessage('没有激活的 API 配置');
        return;
    }
    if (modelIndex < 0 || modelIndex >= profile.models.length) {
        vscode.window.showErrorMessage('无效的模型索引');
        return;
    }
    const profiles = getAllProfile(context);
    profile.selectedModelIndex = modelIndex;
    const idx = profiles.findIndex(p => p.id === profile.id);
    if (idx !== -1) {
        profiles[idx] = profile;
        await saveProfiles(context, profiles);
    }
    await activateProfile(context, profile.id);
}

/**
 * 添加新的 API profile
 * @param {*} context 扩展上下文
 * @param {Object} profile 要添加的 profile 对象
 * @returns {Object} 添加后的 profile 对象（包含新生成的 id）
 */
export async function addProfile(context,profile) {
    const profiles=getAllProfile(context);
    profile.id=getRandomID();
    profiles.push(profile);
    await saveProfiles(context,profiles);
    if(profiles.length===1){
        await activateProfile(context,profile.id);
    }
    return profile;
}


/**
 * 删除指定 id 的 API profile
 * @param {*} context 扩展上下文
 * @param {string} profileID 要删除的 profile id
 */
export async function deleteProfile(context,profileID) {
    const profiles=getAllProfile(context);
    const target_profile=findProfile(profiles,profileID);
    if(!target_profile){
        return;
    }
    
    const target_index=profiles.findIndex(profile=>profile.id===profileID);

    const isActive=(getActiveProfileID(context)===profileID);
    await deleteAPIKey(context,profileID);
    profiles.splice(target_index,1);

    if(isActive){
        if(profiles.length>0){
            await activateProfile(context,profiles[0].id);
        }else{
            await context.globalState.update('pcpr.activeProfileId', undefined);
            await context.secrets.delete('pcpr.apiKey');

            const config = vscode.workspace.getConfiguration('pcpr');
            await config.update('cloudBaseURL', '', vscode.ConfigurationTarget.Global);
            await config.update('cloudModel', '', vscode.ConfigurationTarget.Global);
            await config.update('localBaseURL', '', vscode.ConfigurationTarget.Global);
            await config.update('localModel', '', vscode.ConfigurationTarget.Global);
            }
    }
}

/**
 * 更新指定 id 的 profile 字段
 * @param {*} context 扩展上下文
 * @param {string} profileID 要更新的 profile id
 * @param {Object} updates 要更新的字段对象
 */
export async function updateProfile(context,profileID,updates){
    const profiles=getAllProfile(context);
    const target_profile=findProfile(profiles,profileID);
    if(!target_profile){
        return;
    }
    Object.assign(target_profile,updates);
    await saveProfiles(context,profiles);
    if(getActiveProfileID(context)===profileID){
        await activateProfile(context,profileID);
    }
}

/**
 * 初始化 API profiles，从旧版 VS Code 配置迁移
 * @param {*} context 扩展上下文
 */
export async function initProfiles(context){
    const profiles=getAllProfile(context);
    if(profiles.length>0){
        return;
    }
    const config = vscode.workspace.getConfiguration('pcpr');
    const cloudBaseURL = config.get('cloudBaseURL', '');
    const cloudModel = config.get('cloudModel', '');
    const localBaseURL = config.get('localBaseURL', '');
    const localModel = config.get('localModel', '');

    const defaultProfiles=[];
    if((cloudBaseURL!== '')|| cloudModel!==''){
        const cloudProfile={
            id: getRandomID(),                  
            name: '默认云端',
            baseURL: cloudBaseURL || '',
            models: cloudModel ? [{ name: cloudModel }] : [],
            selectedModelIndex: 0,
            isLocal: false
        }
        defaultProfiles.push(cloudProfile);
    }

    if((localBaseURL!== '')||(localModel!=='')){
        const localProfile = {
            id: getRandomID(),
            name: '默认本地',
            baseURL: localBaseURL || 'http://localhost:11434/v1/',
            models: localModel ? [{ name: localModel }] : [],
            selectedModelIndex: 0,
            isLocal: true
        };
        defaultProfiles.push(localProfile);
    }

    if(defaultProfiles.length>0){
        await saveProfiles(context,defaultProfiles);
        await activateProfile(context,defaultProfiles[0].id);
        vscode.window.showInformationMessage('已从旧版配置迁移 API 设置');
    }else{
        vscode.window.showInformationMessage('请先添加 API 配置 (命令: PCPR: Add API)');
    }
}

/**
 * 通过 UI 交互添加新的 API profile
 * @param {*} context 扩展上下文
 */
export async function addApiUI(context){
    const name=await vscode.window.showInputBox({
        prompt:'输入供应商名称',
        ignoreFocusOut: true
    })
    if(!name){
        return;
    }


    const baseURL=await vscode.window.showInputBox({
        prompt:'输入baseURL',
        ignoreFocusOut: true
    })
    if(!baseURL){
        return;
    }

    const typeItems=[
        {label:'云端',islocal: false},
        {label:'本地',islocal: true}
    ]
    const typeChoice = await vscode.window.showQuickPick(typeItems, {
        placeHolder: '请选择 API 类型',
        ignoreFocusOut: true
    });
    if(!typeChoice){
        return;
    }
    const islocal=typeChoice.islocal;
    let apiKey = '';
    if (!islocal) {
        const keyInput = await vscode.window.showInputBox({
        prompt: '请输入 API Key',
        password: true,            
        ignoreFocusOut: true
        });
        if (!keyInput) {
        return;
        }
        apiKey = keyInput;
    }

    const modelsInput = await vscode.window.showInputBox({
    prompt: '请输入模型名称（多个用英文逗号分隔，最多 3 个）',
    ignoreFocusOut: true,
    validateInput: function (value) {
      // 去掉首尾空格并分割
      const models = value.split(',').map(function (m) {
        return m.trim();
      }).filter(function (m) {
        return m !== '';
      });
      if (models.length === 0) {
        return '请至少输入一个模型名称';
      }
      if (models.length > 3) {
        return '最多只能添加 3 个模型';
      }
      return null;
    }
  });
    if (!modelsInput) {
        return;
    }

    // 解析模型数组
    const modelNames = modelsInput.split(',').map(function (m) {
        return m.trim();
    }).filter(function (m) {
        return m !== '';
    });
    // 转换成 Profile 要求的对象数组
    const models = modelNames.map(function (name) {
        return { name: name };
    });

    const newProfile={
        name:name,
        baseURL: baseURL,
        models: models,
        selectedModelIndex: 0, 
        isLocal: islocal
    }
    const savedProfile=await addProfile(context,newProfile);
    if((!islocal)&&apiKey){
        await saveAPIKey(context,savedProfile.id,apiKey);
        if(getActiveProfileID(context)===savedProfile.id){
            await activateProfile(context,savedProfile.id);
        }
    }

    vscode.window.showInformationMessage('API "' + name + '" 添加成功！');
}


export async function buildProfileItems(context,profile){
    const items=[];
    items.push({
        label: `$(symbol-key) 名称: ${profile.name}`,
        field: 'name',
        description: '修改显示名称'
    });
    items.push({
        label: `$(link) Base URL: ${profile.baseURL}`,
        field: 'baseURL',
        description: '修改 API 基础地址'
    });
    const isLocal=profile.isLocal;
    if(!isLocal){
        const haveKey=!(!(await getAPIKey(context,profile.id)));
        items.push({
            label: `$(key) API Key: ${haveKey ? '已设置' : '未设置'}`,
            field: 'apiKey',
            description: '修改或设置 API Key'
        })
    }
      const modelNames = profile.models.map(m => m.name).join(', ');
        items.push({
            label: `$(package) 模型列表 (${profile.models.length}个)`,
            field: 'models',
            description: modelNames || '无模型'
        });

    if (profile.models.length > 1) {
        const currentModel = profile.models[profile.selectedModelIndex]?.name || '';
        items.push({
        label: `$(check) 当前模型: ${currentModel}`,
        field: 'selectedModelIndex',
        description: '更改默认使用的模型'
        });
    }

    return items;

}

async function editNameUI(context, profile) {
  const newName = await vscode.window.showInputBox({
    prompt: '输入新名称',
    value: profile.name,
    ignoreFocusOut: true
  });
  if (newName !== undefined) {
    await updateProfile(context, profile.id, { name: newName });
    vscode.window.showInformationMessage('名称已更新');
  }
}

async function editBaseURLUI(context, profile) {
  const newURL = await vscode.window.showInputBox({
    prompt: '输入新的 Base URL',
    value: profile.baseURL,
    ignoreFocusOut: true,
    validateInput: function (value) {
      if (!value.startsWith('http://') && !value.startsWith('https://')) {
        return 'URL 必须以 http:// 或 https:// 开头';
      }
      return null;
    }
  });
  if (newURL !== undefined) {
    await updateProfile(context, profile.id, { baseURL: newURL });
    vscode.window.showInformationMessage('Base URL 已更新');
  }
}

async function editApiKeyUI(context, profile) {
  const newKey = await vscode.window.showInputBox({
    prompt: '输入新的 API Key（留空则删除）',
    password: true,
    ignoreFocusOut: true
  });
  if (newKey !== undefined) {
    if (newKey === '') {
      await deleteAPIKey(context, profile.id);
    } else {
      await saveAPIKey(context, profile.id, newKey);
    }
    if (getActiveProfileID(context) === profile.id) {
      await activateProfile(context, profile.id);
    }
    vscode.window.showInformationMessage('API Key 已更新');
  }
}

async function editModelsUI(context,profile){
    const modelString=profile.models.map(m=>m.name).join(',');
    const newModelsInput = await vscode.window.showInputBox({
        prompt: '输入模型名称，用英文逗号分隔（最多3个）',
        value: modelString,
        ignoreFocusOut: true,
        validateInput: function (value) {
        const models = value.split(',').map(s => s.trim()).filter(s => s);
        if (models.length === 0) return '至少需要一个模型';
        if (models.length > 3) return '最多 3 个模型';
        return null;
        }
    });
    if (newModelsInput !== undefined) {
        const modelNames = newModelsInput.split(',').map(s => s.trim()).filter(s => s);
        const newModels = modelNames.map(name => ({ name: name }));
        let newIndex = profile.selectedModelIndex;
        if (newIndex >= newModels.length) newIndex = 0;
        await updateProfile(context, profile.id, {
        models: newModels,
        selectedModelIndex: newIndex
        });
        vscode.window.showInformationMessage('模型列表已更新');
  }
}

async function editSelectedModelUI(context, profile) {
  const modelItems = profile.models.map(function (model, index) {
    const isSelected = index === profile.selectedModelIndex;
    return {
      label: (isSelected ? '$(circle-filled) ' : '$(circle-outline) ') + model.name,
      description: '',
      modelIndex: index
    };
  });
  const pickedModel = await vscode.window.showQuickPick(modelItems, {
    placeHolder: '选择默认模型',
    ignoreFocusOut: true
  });
  if (pickedModel) {
    await updateProfile(context, profile.id, { selectedModelIndex: pickedModel.modelIndex });
    if (getActiveProfileId(context) === profile.id) {
      await activateProfile(context, profile.id);
    }
    vscode.window.showInformationMessage('默认模型已切换');
  }
}
export async function editApiUI(context,profileID){
    const profiles=getAllProfile(context);
    if(profiles.length===0){
        vscode.window.showInformationMessage('没有可编辑的 API 配置');
        return;
    }
    if(!profileID){
        const profileItems=profiles.map(function(p){
            return {
                label: p.name, 
                description: p.baseURL, 
                profileID: p.id 
            }
        })
        const picked=await vscode.window.showQuickPick(profileItems, {
            placeHolder: '选择要编辑的 API 配置',
            ignoreFocusOut: true
        });
        if(!picked){
            return;
        }
        profileID=picked.profileID;
    }
    const profile=findProfile(profiles,profileID);
    if(!profile){
        vscode.window.showErrorMessage('未找到该 API 配置');
        return;
    }

    const items=buildProfileItems(context,profile);
    const pickedField = await vscode.window.showQuickPick(items, {
        placeHolder: '选择要修改的字段',
        ignoreFocusOut: true
    });

    if(!pickedField){
        return;
    }
    switch(pickedField.field){
        case 'name':
            await editNameUI(context,profile);
            break;
        case 'baseURL':
            await editBaseURLUI(context,profile);
            break;
        case 'apiKey':
            await editApiKeyUI(context,profile);
            break;
        case 'models':
            await editModelsUI(context, profile);
            break;
        case 'selectedModelIndex':
            await editSelectedModelUI(context,profile);
            break;
    }
}



export async function deleteApiUI(context, profileId) {
    const profiles = getAllProfile(context);
    if (profiles.length === 0) {
        vscode.window.showInformationMessage('没有可删除的 API 配置');
        return;
    }


    if (!profileId) {
        const profileItems = profiles.map(function (p) {
        return { label: p.name, description: p.baseURL, profileId: p.id };
        });
        const picked = await vscode.window.showQuickPick(profileItems, {
        placeHolder: '选择要删除的 API 配置',
        ignoreFocusOut: true
        });
        if (!picked) return;
        profileId = picked.profileId;
    }

    const targetProfile = findProfile(profiles, profileId);
    if (!targetProfile) {
        vscode.window.showErrorMessage('未找到该 API 配置');
        return;
    }


    const confirm = await vscode.window.showWarningMessage(
        `确定删除 "${targetProfile.name}" 吗？此操作不可恢复。`,
        { modal: true },
        '确定删除'
    );
    if (confirm !== '确定删除') {
        return;
    }

    await deleteProfile(context, profileId);
    vscode.window.showInformationMessage('已删除: ' + targetProfile.name);
}



async function selectProfileUI(context,profileID) {
    const profiles=getAllProfile(context);
    const profile=findProfile(profiles,profileID);

    const subItems=[];

    subItems.push({
        label: '$(arrow-right) 切换到此 API',
        description: '',
        action: 'activate'
    });

    subItems.push({
        label: '$(edit) 编辑',
        description: '',
        action: 'edit'
    });


    const currentModelName = profile.models[profile.selectedModelIndex]?.name || '未选择';

    if (profile.models.length > 1) {
        subItems.push({
        label: '$(list-unordered) 切换模型',
        description: `当前：${currentModelName}`,
        action: 'switchModel'
        });
    } else {
        subItems.push({
        label: '$(list-unordered) 切换模型 (只有一个模型)',
        description: '',
        action: 'switchModel'
        });
    }

    subItems.push({
        label: '$(trash) 删除',
        description: '',
        action: 'delete'
    });

    const picked = await vscode.window.showQuickPick(subItems, {
        placeHolder: `对 "${profile.name}" 进行操作`,
        ignoreFocusOut: true
    });

    if(!picked){
        return;
    }
    switch(picked.action){
        case 'activate':
            await activateProfile(context,profileID);
            break;
        case 'edit':
            await editApiUI(context, profile.id);
            break;
        case 'switchModel':
            await switchModelUI(context,profile);
            break;
        case 'delete':
            await deleteApiUI(context,profile.id);
            break;
    }
}



export async function switchApiUI(context) {
  const profiles = getAllProfiles(context);

  if (profiles.length === 0) {
    vscode.window.showInformationMessage('没有可用的 API 配置，请先添加 (PCPR: Add API)');
    return;
  }

  const activeId = getActiveProfileID(context);
  const items = profiles.map(function (profile) {
    const modelName = profile.models[profile.selectedModelIndex]?.name || '未选择模型';
    const isActive = profile.id === activeId;
    const typeLabel = profile.isLocal ? '本地' : '云端';

    return {
      label: (isActive ? '$(circle-filled) ' : '$(circle-outline) ') + profile.name,
      description: modelName,
      detail: profile.baseURL + '  |  ' + typeLabel,
      profileId: profile.id
    };
  });


  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: '选择要使用的 API 配置',
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true
  });


  if (!selected) {
    return;
  }

  await activateProfile(context, selected.profileId);
}

export async function switchModelUI(context,profile){
    const modelItems=profile.models.map(function(model,index){
        const isSelected=(index===profile.selectedModelIndex);
        return {
                label: (isSelected ? '$(circle-filled) ' : '$(circle-outline) ') + model.name,
                description: '',
                modelIndex: index
        }
    })

    const pickedModel = await vscode.window.showQuickPick(modelItems, {
        placeHolder: '选择要使用的模型',
        ignoreFocusOut: true
    });
    if(pickedModel){
        await activateModel(context,pickedModel.modelIndex);
    }
}
export async function manageApisUI(context){
    while(1){
        const profiles=getAllProfile(context);
        const activeID=getActiveProfileID(context);
        const mainItems=[];

        mainItems.push({
                label: '$(add) 添加新的 API',
                description: '',
                detail: '创建一个新的 API 配置',
                action: 'add'
        })

        if(profiles.length>0){
            // 打印当前 profile 的信息
            mainItems.push({
                label: '-------',
                description: '',
                detail: '',
                action: 'separator'
            })
            for(const profile of profiles){
                let isActive=0;
                if(getActiveProfileID(context)===profile.id){
                    isActive=1;
                }
                const modelName=profile.models[profile.selectedModelIndex]?.name||'No model selected';
                const typeLabel = profile.isLocal ? '本地' : '云端';

                 mainItems.push({
                    label: (isActive ? '$(circle-filled) ' : '$(circle-outline) ') + profile.name,
                    description: modelName,
                    detail: `${profile.baseURL}  |  ${typeLabel}`,
                    action: 'selectProfile',
                    profileId: profile.id
                });
            }
        }
        const picked = await vscode.window.showQuickPick(mainItems, {
            placeHolder: '选择一个 Profile 进行操作，或选择添加新的 API',
            matchOnDescription: true,
            matchOnDetail: true,
            ignoreFocusOut: true
        });
        if(!picked){
            return;
        }

        if(picked.action==='add'){
            await addApiUI(context);
            continue;
        }

        if(picked.action==='separator'){
            continue;
        }

        if(picked.action==='selectProfile'){
            await selectProfileUI(context,picked.profileId);
            continue;
        }
    }
}

