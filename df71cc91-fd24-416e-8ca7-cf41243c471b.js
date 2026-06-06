// StatusBar Fixer - SillyTavern Extension
// 状态栏修复器

import { getContext, extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import { substituteParams, chat, saveChatConditional } from '../../../../script.js';
import { getSortedEntries } from '../../../world-info.js';

const EXT_NAME = 'statusbar-fixer';

// 默认设置
const DEFAULT_SETTINGS = {
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o',
    autoDetect: false,      // false = 手动触发，true = 每次AI回复后自动检测
    autoReplace: false,     // false = 预览确认，true = 直接替换（不推荐）
    formatTemplate: '',     // 用户粘贴的格式模板
    worldbookKeyword: '',   // 世界书中格式定义entry的关键词（可选）
    detectedBlocks: [       // 需要检测的块名列表
        'Snapshot', 'status', 'horae', 'horaeevent', 'Episode', 'RandomTheater'
    ],
};

// 加载设置
function loadSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    Object.assign(extension_settings[EXT_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[EXT_NAME],
    });
    return extension_settings[EXT_NAME];
}

// 从世界书中提取格式定义（通过关键词匹配entry）
function getWorldbookFormatEntries(keyword) {
    if (!keyword) return '';
    try {
        const entries = getSortedEntries();
        if (!entries || !entries.length) return '';
        const matched = entries.filter(e => {
            const keys = Array.isArray(e.key) ? e.key : [e.key];
            return keys.some(k => k && k.includes(keyword));
        });
        return matched.map(e => e.content || '').join('\n\n');
    } catch (e) {
        console.warn('[StatusBar Fixer] 读取世界书失败:', e);
        return '';
    }
}

// 获取最后一条AI消息
function getLastAIMessage() {
    const ctx = getContext();
    if (!ctx || !ctx.chat || ctx.chat.length === 0) return null;
    for (let i = ctx.chat.length - 1; i >= 0; i--) {
        const msg = ctx.chat[i];
        if (msg.is_user === false && msg.mes) {
            return { index: i, content: msg.mes };
        }
    }
    return null;
}

// 检测消息中缺失或破损的块
function detectIssues(content, blocks) {
    const issues = [];

    // 检测块是否存在
    for (const block of blocks) {
        const tagRegex = new RegExp(`<${block}[\\s\\S]*?>`, 'i');
        if (!tagRegex.test(content)) {
            issues.push({ type: 'missing', block });
        }
    }

    // 检测HTML结构问题（未闭合标签、裸露标签文字等）
    const htmlTagRegex = /<(div|table|details|summary|span|b|em|style)[^>]*>/gi;
    let match;
    const openTags = [];
    const closeTagRegex = /<\/(div|table|details|summary|span|b|em|style)>/gi;
    const closedTags = [];

    while ((match = htmlTagRegex.exec(content)) !== null) openTags.push(match[1].toLowerCase());
    while ((match = closeTagRegex.exec(content)) !== null) closedTags.push(match[1].toLowerCase());

    // 简单计数检查
    const tagCounts = {};
    for (const t of openTags) tagCounts[t] = (tagCounts[t] || 0) + 1;
    for (const t of closedTags) tagCounts[t] = (tagCounts[t] || 0) - 1;

    for (const [tag, count] of Object.entries(tagCounts)) {
        if (count !== 0) {
            issues.push({ type: 'html_broken', block: tag, detail: `<${tag}> 开闭标签数量不匹配(差${count})` });
        }
    }

    return issues;
}

// 构建发送给修复API的prompt
function buildFixPrompt(settings, originalContent, issues) {
    const worldbookContent = getWorldbookFormatEntries(settings.worldbookKeyword);
    const issueDesc = issues.map(i => {
        if (i.type === 'missing') return `- 缺失块: <${i.block}>`;
        if (i.type === 'html_broken') return `- HTML破损: ${i.detail}`;
        return `- 未知问题: ${JSON.stringify(i)}`;
    }).join('\n');

    return `你是一个SillyTavern状态栏格式修复助手。

## 正确的状态栏格式模板
${settings.formatTemplate || '（未配置，请根据世界书内容推断）'}

## 世界书中的格式定义（如有）
${worldbookContent || '（未找到相关世界书条目）'}

## 当前AI回复（原始内容）
${originalContent}

## 检测到的问题
${issueDesc || '无自动检测到的结构问题，请综合判断'}

## 你的任务
1. 仔细分析原始内容，找出状态栏部分（通常在回复末尾）
2. 对照格式模板，修复所有破损的HTML结构和缺失的块
3. **只输出修复后的完整状态栏部分**，不要输出正文叙事内容，不要解释
4. 保持原有信息不变，只修复格式，缺失的块内容根据上下文合理补全
5. 输出格式：先输出 ===STATUSBAR_START=== 再输出修复后状态栏，最后输出 ===STATUSBAR_END===`;
}

// 调用第三方API
async function callFixAPI(settings, prompt) {
    if (!settings.apiKey || !settings.apiEndpoint) {
        throw new Error('请先在插件设置中配置API Endpoint和API Key');
    }

    const response = await fetch(settings.apiEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
            model: settings.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 4096,
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`API请求失败 (${response.status}): ${err}`);
    }

    const data = await response.json();
    const text = data.choices?.[0]?.message?.content || '';
    
    // 提取状态栏部分
    const match = text.match(/===STATUSBAR_START===([\s\S]*?)===STATUSBAR_END===/);
    if (match) return match[1].trim();
    
    // 如果没有标记，返回全部内容
    return text.trim();
}

// 从原始消息中分离正文和状态栏
function splitMessageContent(content, blocks) {
    // 尝试找到第一个状态栏块的位置
    let statusStart = content.length;
    for (const block of blocks) {
        const tagRegex = new RegExp(`<${block}[\\s>]`, 'i');
        const idx = content.search(tagRegex);
        if (idx !== -1 && idx < statusStart) {
            statusStart = idx;
        }
    }

    if (statusStart === content.length) {
        // 没找到任何块，尝试找<Snapshot>
        const snapIdx = content.indexOf('<Snapshot>');
        if (snapIdx !== -1) statusStart = snapIdx;
    }

    return {
        narrative: content.substring(0, statusStart).trimEnd(),
        statusbar: content.substring(statusStart),
    };
}

// 替换消息中的状态栏
async function replaceStatusBar(msgIndex, narrative, newStatusBar) {
    const ctx = getContext();
    const newContent = narrative + '\n\n' + newStatusBar;
    ctx.chat[msgIndex].mes = newContent;
    await saveChatConditional();
    
    // 刷新渲染
    const msgEl = document.querySelector(`#chat .mes[mesid="${msgIndex}"] .mes_text`);
    if (msgEl) {
        const { messageFormatting } = await import('../../../../script.js');
        msgEl.innerHTML = messageFormatting(newContent, '', false, false, msgIndex);
    }
}

// 显示预览对话框
function showPreviewDialog(original, fixed, onConfirm) {
    // 移除旧的对话框
    document.getElementById('sbf-preview-dialog')?.remove();

    const dialog = document.createElement('div');
    dialog.id = 'sbf-preview-dialog';
    dialog.innerHTML = `
        <div class="sbf-overlay">
            <div class="sbf-dialog">
                <div class="sbf-dialog-header">
                    <span>🔧 状态栏修复预览</span>
                    <button class="sbf-close-btn" id="sbf-close">✕</button>
                </div>
                <div class="sbf-dialog-body">
                    <div class="sbf-panel">
                        <div class="sbf-panel-label">原始状态栏</div>
                        <div class="sbf-content sbf-original">${escapeHtmlForPreview(original)}</div>
                    </div>
                    <div class="sbf-arrow">→</div>
                    <div class="sbf-panel">
                        <div class="sbf-panel-label">修复后状态栏</div>
                        <div class="sbf-content sbf-fixed">${escapeHtmlForPreview(fixed)}</div>
                    </div>
                </div>
                <div class="sbf-dialog-footer">
                    <button class="sbf-btn sbf-btn-cancel" id="sbf-cancel">取消</button>
                    <button class="sbf-btn sbf-btn-confirm" id="sbf-confirm">✅ 确认替换</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    document.getElementById('sbf-close').addEventListener('click', () => dialog.remove());
    document.getElementById('sbf-cancel').addEventListener('click', () => dialog.remove());
    document.getElementById('sbf-confirm').addEventListener('click', () => {
        dialog.remove();
        onConfirm();
    });
}

function escapeHtmlForPreview(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .substring(0, 3000) + (str.length > 3000 ? '\n...(内容过长已截断)' : '');
}

// 显示toast提示
function showToast(msg, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `sbf-toast sbf-toast-${type}`;
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('sbf-toast-show'), 10);
    setTimeout(() => {
        toast.classList.remove('sbf-toast-show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// 主修复流程
async function runFixer() {
    const settings = loadSettings();
    const btn = document.getElementById('sbf-fix-btn');
    if (btn) {
        btn.textContent = '⏳ 检测中...';
        btn.disabled = true;
    }

    try {
        const lastMsg = getLastAIMessage();
        if (!lastMsg) {
            showToast('没有找到AI回复', 'error');
            return;
        }

        const issues = detectIssues(lastMsg.content, settings.detectedBlocks);
        
        if (issues.length === 0 && !settings.forceCheck) {
            showToast('✅ 未检测到格式问题', 'success');
            return;
        }

        showToast(`🔍 发现 ${issues.length} 个问题，正在调用API修复...`, 'info');

        const prompt = buildFixPrompt(settings, lastMsg.content, issues);
        const fixedStatusBar = await callFixAPI(settings, prompt);

        const { narrative, statusbar: originalStatusBar } = splitMessageContent(
            lastMsg.content,
            settings.detectedBlocks
        );

        if (settings.autoReplace) {
            await replaceStatusBar(lastMsg.index, narrative, fixedStatusBar);
            showToast('✅ 状态栏已自动替换', 'success');
        } else {
            showPreviewDialog(originalStatusBar, fixedStatusBar, async () => {
                await replaceStatusBar(lastMsg.index, narrative, fixedStatusBar);
                showToast('✅ 状态栏已替换', 'success');
            });
        }
    } catch (err) {
        console.error('[StatusBar Fixer]', err);
        showToast(`❌ 修复失败: ${err.message}`, 'error');
    } finally {
        if (btn) {
            btn.textContent = '🔧 修复状态栏';
            btn.disabled = false;
        }
    }
}

// 构建设置面板HTML
function buildSettingsHTML(settings) {
    const blocksStr = (settings.detectedBlocks || []).join(', ');
    return `
        <div id="sbf-settings" class="sbf-settings-panel">
            <h3>🔧 状态栏修复器设置</h3>

            <div class="sbf-section">
                <label>API Endpoint</label>
                <input type="text" id="sbf-api-endpoint" value="${settings.apiEndpoint}"
                    placeholder="https://api.openai.com/v1/chat/completions" />
                <small>支持任何兼容OpenAI格式的API（Gemini OpenAI兼容层、DeepSeek、本地Ollama等）</small>
            </div>

            <div class="sbf-section">
                <label>API Key</label>
                <input type="password" id="sbf-api-key" value="${settings.apiKey}"
                    placeholder="sk-..." />
            </div>

            <div class="sbf-section">
                <label>模型名称</label>
                <input type="text" id="sbf-model" value="${settings.model}"
                    placeholder="gpt-4o / gemini-2.0-flash / deepseek-chat" />
            </div>

            <div class="sbf-section">
                <label>世界书关键词（可选）</label>
                <input type="text" id="sbf-wb-keyword" value="${settings.worldbookKeyword}"
                    placeholder="例如：状态栏格式 / statusbar_format" />
                <small>插件会自动从世界书中找到包含该关键词的entry，作为格式参考喂给AI</small>
            </div>

            <div class="sbf-section">
                <label>格式模板（直接粘贴你的状态栏格式定义）</label>
                <textarea id="sbf-format-template" rows="10"
                    placeholder="把你预设或世界书里写的状态栏格式说明粘贴到这里...">${settings.formatTemplate}</textarea>
                <small>优先级高于世界书关键词匹配，建议把完整格式定义粘贴在此</small>
            </div>

            <div class="sbf-section">
                <label>需要检测的块名（逗号分隔）</label>
                <input type="text" id="sbf-blocks" value="${blocksStr}"
                    placeholder="Snapshot, status, horae, horaeevent" />
                <small>插件会检测这些XML块是否存在于AI回复中</small>
            </div>

            <div class="sbf-section sbf-toggles">
                <label class="sbf-toggle-label">
                    <input type="checkbox" id="sbf-auto-detect" ${settings.autoDetect ? 'checked' : ''} />
                    每次AI回复后自动检测
                </label>
                <label class="sbf-toggle-label">
                    <input type="checkbox" id="sbf-auto-replace" ${settings.autoReplace ? 'checked' : ''} />
                    直接替换（不预览确认）
                </label>
                <label class="sbf-toggle-label">
                    <input type="checkbox" id="sbf-force-check" ${settings.forceCheck ? 'checked' : ''} />
                    强制修复（即使未检测到问题也调用API）
                </label>
            </div>

            <button id="sbf-save-btn" class="sbf-btn sbf-btn-confirm">💾 保存设置</button>
        </div>
    `;
}

// 保存设置
function saveSettings() {
    const settings = extension_settings[EXT_NAME];
    settings.apiEndpoint = document.getElementById('sbf-api-endpoint')?.value || settings.apiEndpoint;
    settings.apiKey = document.getElementById('sbf-api-key')?.value || settings.apiKey;
    settings.model = document.getElementById('sbf-model')?.value || settings.model;
    settings.worldbookKeyword = document.getElementById('sbf-wb-keyword')?.value || '';
    settings.formatTemplate = document.getElementById('sbf-format-template')?.value || '';
    settings.autoDetect = document.getElementById('sbf-auto-detect')?.checked || false;
    settings.autoReplace = document.getElementById('sbf-auto-replace')?.checked || false;
    settings.forceCheck = document.getElementById('sbf-force-check')?.checked || false;

    const blocksRaw = document.getElementById('sbf-blocks')?.value || '';
    settings.detectedBlocks = blocksRaw.split(',').map(s => s.trim()).filter(Boolean);

    saveSettingsDebounced();
    showToast('✅ 设置已保存', 'success');
}

// 自动检测钩子
function hookAutoDetect() {
    // 监听ST的消息渲染事件
    document.addEventListener('sillytavern_message_rendered', () => {
        const settings = loadSettings();
        if (settings.autoDetect) {
            const lastMsg = getLastAIMessage();
            if (!lastMsg) return;
            const issues = detectIssues(lastMsg.content, settings.detectedBlocks);
            if (issues.length > 0) {
                showToast(`⚠️ 检测到 ${issues.length} 个状态栏格式问题，点击修复按钮处理`, 'warning');
                // 高亮修复按钮
                const btn = document.getElementById('sbf-fix-btn');
                if (btn) btn.classList.add('sbf-btn-alert');
            }
        }
    });
}

// 初始化插件
jQuery(async () => {
    const settings = loadSettings();

    // 注入设置面板到ST扩展设置区域
    const settingsContainer = document.getElementById('extensions_settings2') 
        || document.getElementById('extensions_settings');
    
    if (settingsContainer) {
        const wrapper = document.createElement('div');
        wrapper.id = 'sbf-wrapper';
        wrapper.innerHTML = buildSettingsHTML(settings);
        settingsContainer.appendChild(wrapper);

        document.getElementById('sbf-save-btn')?.addEventListener('click', saveSettings);
    }

    // 注入修复按钮到ST工具栏（消息输入区域旁边）
    const toolbar = document.getElementById('send_but_sheld') 
        || document.getElementById('rightSendForm');

    if (toolbar) {
        const fixBtn = document.createElement('div');
        fixBtn.id = 'sbf-fix-btn-wrapper';
        fixBtn.innerHTML = `
            <button id="sbf-fix-btn" title="修复最后一条AI回复中的状态栏格式">
                🔧
            </button>
        `;
        toolbar.insertBefore(fixBtn, toolbar.firstChild);
        document.getElementById('sbf-fix-btn')?.addEventListener('click', runFixer);
    }

    hookAutoDetect();

    console.log('[StatusBar Fixer] 插件已加载');
});
