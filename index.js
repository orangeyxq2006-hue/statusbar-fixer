import { getContext, extension_settings, saveSettingsDebounced } from '../../../extensions.js';
import { substituteParams, chat, saveChatConditional } from '../../../../script.js';
import { getSortedEntries } from '../../../world-info.js';

const EXT_NAME = 'statusbar-fixer';

const DEFAULT_SETTINGS = {
    apiEndpoint: 'https://api.openai.com/v1/chat/completions',
    apiKey: '',
    model: 'gpt-4o',
    autoDetect: false,
    autoReplace: false,
    formatTemplate: '',
    worldbookKeyword: '',
    detectedBlocks: ['Snapshot', 'status', 'horae', 'horaeevent', 'Episode', 'RandomTheater'],
};

function loadSettings() {
    extension_settings[EXT_NAME] = extension_settings[EXT_NAME] || {};
    Object.assign(extension_settings[EXT_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[EXT_NAME],
    });
    return extension_settings[EXT_NAME];
}

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

function detectIssues(content, blocks) {
    const issues = [];
    for (const block of blocks) {
        const tagRegex = new RegExp(`<${block}[\\s\\S]*?>`, 'i');
        if (!tagRegex.test(content)) {
            issues.push({ type: 'missing', block });
        }
    }
    const htmlTagRegex = /<(div|table|details|summary|span|b|em|style)[^>]*>/gi;
    const closeTagRegex = /<\/(div|table|details|summary|span|b|em|style)>/gi;
    let match;
    const openTags = [];
    const closedTags = [];
    while ((match = htmlTagRegex.exec(content)) !== null) openTags.push(match[1].toLowerCase());
    while ((match = closeTagRegex.exec(content)) !== null) closedTags.push(match[1].toLowerCase());
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
3. 只输出修复后的完整状态栏部分，不要输出正文叙事内容，不要解释
4. 保持原有信息不变，只修复格式，缺失的块内容根据上下文合理补全
5. 输出格式：先输出 ===STATUSBAR_START=== 再输出修复后状态栏，最后输出 ===STATUSBAR_END===`;
}

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
    const match = text.match(/===STATUSBAR_START===([\s\S]*?)===STATUSBAR_END===/);
    if (match) return match[1].trim();
    return text.trim();
}

function splitMessageContent(content, blocks) {
    let statusStart = content.length;
    for (const block of blocks) {
        const tagRegex = new RegExp(`<${block}[\\s>]`, 'i');
        const idx = content.search(tagRegex);
        if (idx !== -1 && idx < statusStart) statusStart = idx;
    }
    if (statusStart === content.length) {
        const snapIdx = content.indexOf('<Snapshot>');
        if (snapIdx !== -1) statusStart = snapIdx;
    }
    return {
        narrative: content.substring(0, statusStart).trimEnd(),
        statusbar: content.substring(statusStart),
    };
}

async function replaceStatusBar(msgIndex, narrative, newStatusBar) {
    const ctx = getContext();
    const newContent = narrative + '\n\n' + newStatusBar;
    ctx.chat[msgIndex].mes = newContent;
    await saveChatConditional();
    const msgEl = document.querySelector(`#chat .mes[mesid="${msgIndex}"] .mes_text`);
    if (msgEl) {
        const { messageFormatting } = await import('../../../../script.js');
        msgEl.innerHTML = messageFormatting(newContent, '', false, false, msgIndex);
    }
}

function showPreviewDialog(original, fixed, onConfirm) {
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
                    <button class="sbf-b
