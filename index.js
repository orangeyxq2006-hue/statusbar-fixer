(async () => {
    const { getContext, extension_settings, saveSettingsDebounced } = window.SillyTavern.getContext
        ? { 
            getContext: window.SillyTavern.getContext,
            extension_settings: window.extension_settings,
            saveSettingsDebounced: window.saveSettingsDebounced
          }
        : {
            getContext: () => window.SillyTavern?.getContext?.() ?? {},
            extension_settings: window.extension_settings ?? {},
            saveSettingsDebounced: window.saveSettingsDebounced ?? (() => {})
          };

    const EXT_NAME = 'statusbar-fixer';

    const DEFAULT_SETTINGS = {
        apiEndpoint: 'https://api.openai.com/v1/chat/completions',
        apiKey: '',
        model: 'gpt-4o',
        autoDetect: false,
        autoReplace: false,
        forceCheck: false,
        formatTemplate: '',
        worldbookKeyword: '',
        detectedBlocks: ['Snapshot', 'status', 'horae', 'horaeevent', 'Episode', 'RandomTheater'],
    };

    function loadSettings() {
        if (!window.extension_settings) return DEFAULT_SETTINGS;
        window.extension_settings[EXT_NAME] = window.extension_settings[EXT_NAME] || {};
        const s = window.extension_settings[EXT_NAME];
        for (const k of Object.keys(DEFAULT_SETTINGS)) {
            if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
        }
        return s;
    }

    function getLastAIMessage() {
        const ctx = typeof getContext === 'function' ? getContext() : (window.SillyTavern?.getContext?.() ?? {});
        const chatArr = ctx.chat ?? window.chat ?? [];
        if (!chatArr.length) return null;
        for (let i = chatArr.length - 1; i >= 0; i--) {
            const msg = chatArr[i];
            if (msg.is_user === false && msg.mes) return { index: i, content: msg.mes };
        }
        return null;
    }

    function detectIssues(content, blocks) {
        const issues = [];
        for (const block of blocks) {
            if (!new RegExp(`<${block}[\\s\\S]*?>`, 'i').test(content)) {
                issues.push({ type: 'missing', block });
            }
        }
        const tags = ['div','table','details','summary','span','b','em','style'];
        for (const tag of tags) {
            const open = (content.match(new RegExp(`<${tag}[^>]*>`, 'gi')) || []).length;
            const close = (content.match(new RegExp(`</${tag}>`, 'gi')) || []).length;
            if (open !== close) {
                issues.push({ type: 'html_broken', block: tag, detail: `<${tag}> 不匹配(开${open}闭${close})` });
            }
        }
        return issues;
    }

    function buildFixPrompt(settings, content, issues) {
        const issueDesc = issues.map(i =>
            i.type === 'missing' ? `- 缺失块: <${i.block}>` : `- HTML破损: ${i.detail}`
        ).join('\n');
        return `你是SillyTavern状态栏格式修复助手。

## 正确的状态栏格式模板
${settings.formatTemplate || '（未配置）'}

## 当前AI回复
${content}

## 检测到的问题
${issueDesc || '请综合判断'}

## 任务
1. 找出回复末尾的状态栏部分
2. 对照模板修复所有破损HTML和缺失块
3. 只输出修复后的完整状态栏，不输出正文，不解释
4. 格式：===STATUSBAR_START===
修复后内容
===STATUSBAR_END===`;
    }

    async function callAPI(settings, prompt) {
        if (!settings.apiKey || !settings.apiEndpoint) throw new Error('请先配置API Endpoint和API Key');
        const res = await fetch(settings.apiEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.apiKey}` },
            body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], temperature: 0.1, max_tokens: 4096 }),
        });
        if (!res.ok) throw new Error(`API错误 ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || '';
        const m = text.match(/===STATUSBAR_START===([\s\S]*?)===STATUSBAR_END===/);
        return m ? m[1].trim() : text.trim();
    }

    function splitContent(content, blocks) {
        let idx = content.length;
        for (const b of blocks) {
            const i = content.search(new RegExp(`<${b}[\\s>]`, 'i'));
            if (i !== -1 && i < idx) idx = i;
        }
        if (idx === content.length) {
            const i = content.indexOf('<Snapshot>');
            if (i !== -1) idx = i;
        }
        return { narrative: content.substring(0, idx).trimEnd(), statusbar: content.substring(idx) };
    }

    async function replaceMsg(index, narrative, newBar) {
        const chatArr = window.chat ?? [];
        if (!chatArr[index]) return;
        chatArr[index].mes = narrative + '\n\n' + newBar;
        if (typeof window.saveChatConditional === 'function') await window.saveChatConditional();
        const el = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
        if (el && typeof window.messageFormatting === 'function') {
            el.innerHTML = window.messageFormatting(chatArr[index].mes, '', false, false, index);
        } else if (el) {
            el.innerHTML = chatArr[index].mes;
        }
    }

    function showToast(msg, type = 'info') {
        document.querySelectorAll('.sbf-toast').forEach(e => e.remove());
        const t = document.createElement('div');
        t.className = `sbf-toast sbf-toast-${type}`;
        t.textContent = msg;
        document.body.appendChild(t);
        setTimeout(() => t.classList.add('sbf-toast-show'), 10);
        setTimeout(() => { t.classList.remove('sbf-toast-show'); setTimeout(() => t.remove(), 300); }, 3500);
    }

    function showPreview(original, fixed, onConfirm) {
        document.getElementById('sbf-preview-dialog')?.remove();
        const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').substring(0,3000);
        const d = document.createElement('div');
        d.id = 'sbf-preview-dialog';
        d.innerHTML = `<div class="sbf-overlay"><div class="sbf-dialog">
            <div class="sbf-dialog-header"><span>🔧 状态栏修复预览</span><button class="sbf-close-btn" id="sbf-close">✕</button></div>
            <div class="sbf-dialog-body">
                <div class="sbf-panel"><div class="sbf-panel-label">原始</div><div class="sbf-content sbf-original">${esc(original)}</div></div>
                <div class="sbf-arrow">→</div>
                <div class="sbf-panel"><div class="sbf-panel-label">修复后</div><div class="sbf-content sbf-fixed">${esc(fixed)}</div></div>
            </div>
            <div class="sbf-dialog-footer">
                <button class="sbf-btn sbf-btn-cancel" id="sbf-cancel">取消</button>
                <button class="sbf-btn sbf-btn-confirm" id="sbf-confirm">✅ 确认替换</button>
            </div>
        </div></div>`;
        document.body.appendChild(d);
        d.querySelector('#sbf-close').onclick = () => d.remove();
        d.querySelector('#sbf-cancel').onclick = () => d.remove();
        d.querySelector('#sbf-confirm').onclick = () => { d.remove(); onConfirm(); };
    }

    async function runFixer() {
        const settings = loadSettings();
   
