import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as userdataUtils from './userdata-utils.mjs';

// ── Constants ──

const CONFIG_SECTION = 'pcpr.inlineCompletion';

// Only documents from these uri schemes are completed. Everything else
// (output panel, debug console, diff editors, ...) is ignored on purpose.
const ALLOWED_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

// Guard rails so a single request can never blow up the model context.
const MAX_DOCUMENT_LINES = 100000;
const MAX_DOCUMENT_CHARS = 2000000;
const MAX_STRUCTURE_CHARS = 4000;
const MAX_OPEN_FILES = 40;
const MAX_HEADER_LINES = 40;

// Small cache so an unchanged cursor position is served without a round trip.
const CACHE_LIMIT = 30;

// Languages that never get inline completions by default. Users can override
// this list through the pcpr.inlineCompletion.disabledLanguages setting.
const DEFAULT_DISABLED_LANGUAGES = [
    'plaintext', 'log', 'ignore', 'code-text-binary', 'scminput',
    'git-commit', 'git-rebase', 'diff', 'output', 'search-result'
];

const DEFAULT_OPTIONS = {
    enabled: true,
    debounceMs: 250,
    maxPrefixCharacters: 6000,
    maxSuffixCharacters: 2000,
    maxCompletionLines: 20,
    maxTokens: 1024,
    includeProjectStructure: true,
    disabledLanguages: DEFAULT_DISABLED_LANGUAGES
};

// Hard ceiling for the automatic maxTokens escalation below. It is a constant
// on purpose: retries can never grow past it.
const MAX_TOKEN_LIMIT = 20480;

// model id -> token budget that actually produced code. Reasoning models
// otherwise need the slower second attempt on every single keystroke.
const learnedTokenBudget = new Map();

// ── Logging ──

let outputChannel = null;
let warnedMissingApi = false;

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('PCPR Inline Completion');
    }
    return outputChannel;
}

// Everything the provider does is logged so "nothing appears" can be diagnosed
// from the PCPR Inline Completion output channel.
function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    try {
        getOutputChannel().appendLine(line);
    } catch (_err) {
        // the channel may already be disposed
    }
    console.log(`[PCPR inline] ${message}`);
}

function disposeOutputChannel() {
    if (outputChannel) {
        try {
            outputChannel.dispose();
        } catch (_err) {
            // ignore
        }
        outputChannel = null;
    }
}

// ── Options ──

// Read the settings on every request so changes apply without a reload.
function readOptions() {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const disabled = config.get('disabledLanguages', DEFAULT_OPTIONS.disabledLanguages);
    return {
        enabled: config.get('enabled', DEFAULT_OPTIONS.enabled) !== false,
        debounceMs: clampNumber(config.get('debounceMs', DEFAULT_OPTIONS.debounceMs), 0, 5000, DEFAULT_OPTIONS.debounceMs),
        maxPrefixCharacters: clampNumber(config.get('maxPrefixCharacters', DEFAULT_OPTIONS.maxPrefixCharacters), 200, 40000, DEFAULT_OPTIONS.maxPrefixCharacters),
        maxSuffixCharacters: clampNumber(config.get('maxSuffixCharacters', DEFAULT_OPTIONS.maxSuffixCharacters), 0, 40000, DEFAULT_OPTIONS.maxSuffixCharacters),
        maxCompletionLines: clampNumber(config.get('maxCompletionLines', DEFAULT_OPTIONS.maxCompletionLines), 1, 200, DEFAULT_OPTIONS.maxCompletionLines),
        maxTokens: clampNumber(config.get('maxTokens', DEFAULT_OPTIONS.maxTokens), 16, MAX_TOKEN_LIMIT, DEFAULT_OPTIONS.maxTokens),
        includeProjectStructure: config.get('includeProjectStructure', DEFAULT_OPTIONS.includeProjectStructure) !== false,
        disabledLanguages: Array.isArray(disabled) ? disabled : DEFAULT_OPTIONS.disabledLanguages
    };
}

function clampNumber(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.floor(num)));
}

// ── Helpers ──

// Cancellable sleep: resolves early (without throwing) as soon as the token is
// cancelled, so a new keystroke never waits for the debounce of an old request.
function delay(ms, token) {
    return new Promise((resolve) => {
        let finished = false;
        let timer;
        let subscription;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            if (subscription) subscription.dispose();
            resolve();
        };
        timer = setTimeout(finish, ms);
        if (token.isCancellationRequested) {
            finish();
            return;
        }
        subscription = token.onCancellationRequested(finish);
        if (token.isCancellationRequested) finish();
    });
}

function isAbortError(error) {
    if (!error) return false;
    const message = error.message || String(error);
    return error.name === 'AbortError' || error.code === 'ABORT_ERR' || /abort/i.test(message);
}

function getIndentationInfo() {
    const editor = vscode.window.activeTextEditor;
    const options = editor ? editor.options : undefined;
    const insertSpaces = options && options.insertSpaces !== undefined ? options.insertSpaces !== false : true;
    let tabSize = options && options.tabSize !== undefined ? Number(options.tabSize) : 4;
    if (!Number.isFinite(tabSize) || tabSize <= 0) tabSize = 4;
    return insertSpaces ? `${tabSize} spaces` : 'tab';
}

function truncateProjectStructure(structure) {
    if (!structure) return '';
    const text = String(structure);
    if (text.length <= MAX_STRUCTURE_CHARS) return text;
    return text.slice(0, MAX_STRUCTURE_CHARS) + '\n...(truncated)';
}

// Short "file:line (language)" label used in the log output.
function describePosition(document, position) {
    let file = document.uri.toString();
    try {
        file = vscode.workspace.asRelativePath(document.uri, false) || document.fileName;
    } catch (_err) {
        // keep the uri
    }
    return `${file}:${position.line + 1} (${document.languageId})`;
}

// ── Prompt building ──

// Collect the snippet of the document around the cursor plus the extra context
// (project structure, open files, file header) used to ground the completion.
function buildRequest(document, position, options, deps) {
    const text = document.getText();
    const offset = document.offsetAt(position);

    let prefix = text.slice(0, offset);
    let suffix = text.slice(offset);

    // Keep the end of the prefix (the code right before the cursor matters most)
    // and the beginning of the suffix.
    let prefixTruncated = false;
    if (prefix.length > options.maxPrefixCharacters) {
        prefix = prefix.slice(-options.maxPrefixCharacters);
        prefixTruncated = true;
    }
    if (suffix.length > options.maxSuffixCharacters) {
        suffix = suffix.slice(0, options.maxSuffixCharacters);
    }

    const relativePath = vscode.workspace.asRelativePath(document.uri, false) || document.fileName;
    const sections = [];

    sections.push(
        '<file_info>\n' +
        `path: ${relativePath}\n` +
        `language: ${document.languageId}\n` +
        `cursor: line ${position.line + 1} of ${document.lineCount}\n` +
        `indentation: ${getIndentationInfo()}\n` +
        '</file_info>'
    );

    if (options.includeProjectStructure && deps && typeof deps.structure === 'function') {
        const structure = truncateProjectStructure(deps.structure());
        if (structure) sections.push('<project_structure>\n' + structure + '\n</project_structure>');
    }

    const openFiles = deps && typeof deps.openFiles === 'function' ? deps.openFiles() : [];
    if (Array.isArray(openFiles) && openFiles.length > 0) {
        const list = openFiles
            .slice(0, MAX_OPEN_FILES)
            .map((file) => vscode.workspace.asRelativePath(file, false))
            .join('\n');
        sections.push('<open_files>\n' + list + '\n</open_files>');
    }

    // When the prefix was cut, imports and top level declarations were lost, so
    // send the beginning of the file separately.
    if (prefixTruncated) {
        const header = text.split(/\r?\n/).slice(0, MAX_HEADER_LINES).join('\n');
        if (header.trim()) sections.push('<file_header>\n' + header + '\n</file_header>');
    }

    // The cursor is exactly on the boundary between these two blocks.
    sections.push('<code_before_cursor>\n' + prefix + '</code_before_cursor>');
    sections.push('<code_after_cursor>' + suffix + '\n</code_after_cursor>');
    sections.push('<task>\nInsert the completion at the cursor, which is exactly the boundary between <code_before_cursor> and <code_after_cursor>. Return raw code only.\n</task>');

    return { prompt: sections.join('\n\n'), prefix, suffix };
}

// ── Response cleanup ──

// The tags used to structure the prompt in buildRequest. Models sometimes echo
// them back and they must never end up in the inserted code.
// Only these exact names are removed, so real markup such as <div> or <T> in
// the edited file is left untouched.
const PROMPT_TAGS = [
    'code_before_cursor', 'code_after_cursor',
    'file_info', 'file_header', 'project_structure', 'open_files', 'task',
    'identity', 'output_rules', 'context_usage'
];

const PROMPT_TAG_PATTERN = new RegExp(`<\\/?\\s*(?:${PROMPT_TAGS.join('|')})\\s*\\/?>`, 'gi');
const PROMPT_TAG_ONLY_LINE_PATTERN = new RegExp(`^[ \\t]*<\\/?\\s*(?:${PROMPT_TAGS.join('|')})\\s*\\/?>[ \\t]*$`, 'i');

// Remove the prompt markup from a model answer. A line that contains nothing
// but a tag disappears entirely, an inline tag is simply cut out.
function stripPromptTags(text) {
    if (!text) return '';
    const kept = String(text)
        .split(/\r?\n/)
        .filter((line) => !PROMPT_TAG_ONLY_LINE_PATTERN.test(line));
    return kept.join('\n').replace(PROMPT_TAG_PATTERN, '').replace(/[ \t]+$/gm, '');
}

// Turn the model answer into the exact text that should be inserted.
function sanitizeCompletion(raw, options) {
    if (raw === null || raw === undefined) return '';
    let text = String(raw);

    // A model that wrapped the answer in a fence is still usable.
    const fenced = text.match(/^\s*```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
    if (fenced) text = fenced[1];

    // Drop anything that follows a fence (usually chatty explanation).
    text = text.replace(/\r?\n[ \t]*```[\s\S]*$/, '');

    // Strip the prompt markup, then normalise the blanks it may leave behind.
    text = stripPromptTags(text);
    text = text.replace(/^(?:[ \t]*\r?\n)+/, '');
    text = text.replace(/[ \t]+$/, '');

    const lines = text.split(/\r?\n/);
    if (lines.length > options.maxCompletionLines) {
        text = lines.slice(0, options.maxCompletionLines).join('\n');
    }
    return text;
}

// Models sometimes restate the beginning of the current line.
function stripDuplicatedPrefix(completion, prefix) {
    if (!completion || !prefix) return completion;
    const lineStart = prefix.lastIndexOf('\n') + 1;
    const currentLine = prefix.slice(lineStart);
    if (currentLine.trim().length >= 2 && completion.startsWith(currentLine) && completion.length > currentLine.length) {
        return completion.slice(currentLine.length);
    }
    return completion;
}

// Models sometimes re-emit text that already follows the cursor, which would
// duplicate it once the ghost text is accepted.
// Never let this cleanup turn a real completion into nothing.
function stripDuplicatedSuffix(completion, suffix) {
    if (!completion || !suffix) return completion;
    let text = completion;
    if (suffix.startsWith('\n') && text.endsWith('\n')) {
        text = text.replace(/\n+$/, '');
    }
    const max = Math.min(text.length, suffix.length);
    for (let len = max; len >= 2; len--) {
        if (suffix.startsWith(text.slice(text.length - len))) {
            const stripped = text.slice(0, text.length - len);
            // The whole answer was just an echo of the following code: that is
            // not a completion at all, so return '' and let the caller drop it.
            if (stripped.trim() === '') return '';
            return stripped;
        }
    }
    return text;
}

// ── Model request ──

async function requestCompletion(context, prompt, options, signal) {
    const userData = await userdataUtils.getData(context);
    if (!userData || !userData.baseURL || !userData.model) {
        log('no API configured (baseURL/model missing) - run "PCPR: Add API" or "PCPR: Switch API"');
        if (!warnedMissingApi) {
            warnedMissingApi = true;
            vscode.window.showWarningMessage(
                'PCPR inline completion needs an API. Run "PCPR: Add API" / "PCPR: Switch API".',
                'Manage APIs'
            ).then((choice) => {
                if (choice === 'Manage APIs') vscode.commands.executeCommand('pcpr.manageApis');
            });
        }
        return null;
    }

    const openai = new OpenAI({
        apiKey: userData.apiKey || 'not-needed',
        baseURL: userData.baseURL
    });

    const sysPrompt = userdataUtils.getSysPrompt(context.extensionPath);
    const systemPrompt = (sysPrompt && (sysPrompt['inline-completion'] || sysPrompt.inline_completion)) || '';
    if (!systemPrompt) log('warning: "inline-completion" prompt missing from config/system_prompt.json');

    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
    ];

    // Start from the budget this model already proved it needs, so the slow
    // second attempt happens at most once per model and not on every keystroke.
    const budget = Math.max(options.maxTokens, learnedTokenBudget.get(userData.model) || 0);
    if (budget > options.maxTokens) {
        log(`using the remembered max_tokens ${budget} for model "${userData.model}"`);
    }

    const started = Date.now();
    let answer = await createCompletion(openai, userData.model, messages, budget, signal);

    // A reasoning model can burn the whole max_tokens budget on its hidden
    // reasoning and return an empty message (finish_reason "length"). Retry
    // ONCE with a bigger budget (never more, never above MAX_TOKEN_LIMIT).
    if (answer.content.trim() === '' && answer.finishReason === 'length' && budget < MAX_TOKEN_LIMIT) {
        const bigger = Math.min(Math.max(budget * 4, 1024), MAX_TOKEN_LIMIT);
        log(`the model used all ${budget} tokens without producing code, retrying once with max_tokens ${bigger}`);
        answer = await createCompletion(openai, userData.model, messages, bigger, signal);
        if (answer.content.trim() !== '') {
            // Remember it for this model so later requests are not slowed down.
            learnedTokenBudget.set(userData.model, bigger);
            log(`remembering max_tokens ${bigger} for model "${userData.model}"`);
        } else {
            log('the retry returned nothing either - giving up (check the model, it may not be usable for inline completion)');
        }
    }

    log(`model "${userData.model}" answered in ${Date.now() - started}ms`);
    return answer;
}

// One chat completion call. Returns the message content plus enough detail to
// explain an empty answer.
async function createCompletion(openai, model, messages, maxTokens, signal) {
    const params = { model, messages, temperature: 0.1 };
    if (maxTokens > 0) params.max_tokens = maxTokens;

    let completion;
    try {
        completion = await openai.chat.completions.create(params, { signal });
    } catch (error) {
        if (isAbortError(error)) throw error;
        // Some OpenAI compatible endpoints reject optional parameters.
        log(`request with temperature/max_tokens failed (${error && error.message ? error.message : error}), retrying without them`);
        completion = await openai.chat.completions.create({ model, messages }, { signal });
    }

    const choice = completion && completion.choices && completion.choices[0];
    if (!choice) return { content: '', finishReason: 'no-choices', reasoningLength: 0 };

    const message = choice.message || {};
    const content = message.content || '';
    // Reasoning models expose their thinking separately.
    const reasoning = message.reasoning_content || message.reasoning || '';
    const reasoningTokens = completion.usage
        && completion.usage.completion_tokens_details
        && completion.usage.completion_tokens_details.reasoning_tokens;

    if (!content.trim() && (reasoning || reasoningTokens)) {
        log(`the model returned ${reasoningTokens !== undefined ? `${reasoningTokens} reasoning tokens` : `${String(reasoning).length} chars of reasoning`} and no code`);
    }

    return {
        content,
        finishReason: choice.finish_reason || 'unknown',
        reasoningLength: String(reasoning).length
    };
}

// ── Provider ──

/**
 * Inline (ghost text) completion provider backed by the configured LLM.
 *
 * Cancellation is handled on two levels:
 *  - the VS Code CancellationToken cancels the request when the user keeps
 *    typing, moves the cursor, dismisses the suggestion with Esc or a newer
 *    request supersedes this one;
 *  - an internal AbortController aborts the in-flight HTTP call and is always
 *    aborted before a new request starts.
 */
export class PCPRInlineCompletionProvider {
    /**
     * @param {vscode.ExtensionContext} context
     * @param {() => string} getStructure Returns the current project structure string.
     * @param {() => string[]} getOpenFiles Returns the paths of the currently opened files.
     */
    constructor(context, getStructure, getOpenFiles) {
        this.context = context;
        this.getStructure = typeof getStructure === 'function' ? getStructure : () => '';
        this.getOpenFiles = typeof getOpenFiles === 'function' ? getOpenFiles : () => [];
        this.activeController = null;
        this.cache = new Map();
    }

    dispose() {
        this.abortActive();
        this.cache.clear();
    }

    abortActive() {
        if (this.activeController) {
            try {
                this.activeController.abort();
            } catch (_err) {
                // the request may already be finished
            }
            this.activeController = null;
        }
    }

    remember(key, value) {
        if (this.cache.has(key)) this.cache.delete(key);
        this.cache.set(key, value);
        while (this.cache.size > CACHE_LIMIT) {
            this.cache.delete(this.cache.keys().next().value);
        }
    }

    /**
     * Decide whether this document/position should be completed at all.
     * Considering file type, language, editor state and trigger kind.
     * @returns {string} a human readable reason to skip, or '' when completion should run.
     */
    shouldSkip(document, options, context, text) {
        if (!document || document.isClosed) return 'document is closed';
        if (!ALLOWED_SCHEMES.has(document.uri.scheme)) return `unsupported scheme "${document.uri.scheme}"`;
        if (options.disabledLanguages.includes(document.languageId)) return `language "${document.languageId}" is in disabledLanguages`;
        if (document.lineCount > MAX_DOCUMENT_LINES) return `document has too many lines (${document.lineCount})`;
        if (text.length > MAX_DOCUMENT_CHARS) return `document is too large (${text.length} chars)`;
        // Nothing to infer from in an empty document.
        if (text.trim() === '') return 'document is empty';

        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === document) {
            // Multi cursor or an active selection is not supported.
            if (editor.selections && editor.selections.length > 1) return 'multiple cursors';
            if (editor.selection && !editor.selection.isEmpty) return 'there is an active selection';
        }

        // Do not fight with the suggest widget on automatic triggers.
        if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic && context.selectedCompletionInfo) {
            return 'the suggest widget is open';
        }

        return '';
    }

    /**
     * @param {vscode.TextDocument} document
     * @param {vscode.Position} position
     * @param {vscode.InlineCompletionContext} context
     * @param {vscode.CancellationToken} token
     */
    async provideInlineCompletionItems(document, position, context, token) {
        try {
            if (token.isCancellationRequested) return null;

            const options = readOptions();
            if (!options.enabled) return null;

            const text = document.getText();
            const skipReason = this.shouldSkip(document, options, context, text);
            if (skipReason) {
                log(`skip ${describePosition(document, position)}: ${skipReason}`);
                return null;
            }

            const trigger = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic ? 'automatic' : 'invoke';

            // Debounce automatic triggers so a burst of keystrokes only fires
            // one request. Explicit invocations are served immediately.
            if (trigger === 'automatic') {
                await delay(options.debounceMs, token);
                if (token.isCancellationRequested) {
                    log(`keystroke during the ${options.debounceMs}ms debounce - no request sent`);
                    return null;
                }
            }

            const offset = document.offsetAt(position);
            const cacheKey = `${document.uri.toString()}|${document.version}|${offset}`;
            const cached = this.cache.get(cacheKey);
            if (cached !== undefined) {
                log(`cache hit ${describePosition(document, position)} (${trigger})`);
                return this.buildResult(cached, position);
            }

            // A new request supersedes any request still in flight.
            this.abortActive();

            const controller = new AbortController();
            this.activeController = controller;
            const cancellation = token.onCancellationRequested(() => {
                try {
                    controller.abort();
                } catch (_err) {
                    // ignore
                }
            });

            let raw;
            const request = buildRequest(document, position, options, {
                structure: this.getStructure,
                openFiles: this.getOpenFiles
            });
            log(`request ${describePosition(document, position)} (${trigger}, ${request.prefix.length} chars before / ${request.suffix.length} chars after the cursor)`);
            try {
                raw = await requestCompletion(this.context, request.prompt, options, controller.signal);
            } finally {
                cancellation.dispose();
                if (this.activeController === controller) this.activeController = null;
            }

            // The user kept typing / dismissed the suggestion.
            if (token.isCancellationRequested) {
                log('cancelled by the editor (keystroke, cursor move or Esc)');
                return null;
            }
            if (raw === null || raw === undefined) return null;

            const restored = JSON.stringify(raw.content.slice(0, 160));
            log(`raw answer (${raw.finishReason}, ${raw.content.length} chars): ${restored}${raw.content.length > 160 ? '...' : ''}`);
            if (raw.content.trim() === '') {
                if (raw.finishReason === 'length') {
                    log('-> the model used its whole token budget without returning code (typical of reasoning models); raise pcpr.inlineCompletion.maxTokens or pick a non-reasoning model');
                } else {
                    log('-> the model returned an empty answer, nothing to show');
                }
                return null;
            }
            if (raw.finishReason === 'length') {
                log('-> the answer hit maxTokens and may be cut off; raise pcpr.inlineCompletion.maxTokens if needed');
            }

            const sanitized = sanitizeCompletion(raw.content, options);
            const deduplicated = stripDuplicatedPrefix(sanitized, request.prefix);
            const completion = stripDuplicatedSuffix(deduplicated, request.suffix);
            if (completion !== sanitized) {
                log('-> removed text that duplicated the code around the cursor');
            }

            // Completions that are only whitespace are useless.
            if (!completion || completion.trim() === '') {
                log('model returned nothing usable - no ghost text shown');
                return null;
            }

            log(`showing ${completion.length} chars: ${JSON.stringify(completion.slice(0, 60))}${completion.length > 60 ? '...' : ''}`);
            this.remember(cacheKey, completion);
            return this.buildResult(completion, position);
        } catch (error) {
            // Cancellation is a normal outcome, never surface it as an error.
            if (isAbortError(error) || token.isCancellationRequested) {
                log('request aborted');
                return null;
            }
            log(`ERROR ${error && error.stack ? error.stack : String(error)}`);
            console.error('[PCPR] inline completion failed:', error);
            return null;
        }
    }

    buildResult(text, position) {
        const range = new vscode.Range(position, position);
        const item = new vscode.InlineCompletionItem(text, range);
        item.filterText = '';
        return new vscode.InlineCompletionList([item]);
    }
}

// Document selector used when registering the provider.
export const INLINE_COMPLETION_SELECTOR = [
    { scheme: 'file' },
    { scheme: 'untitled' },
    { scheme: 'vscode-remote' }
];

/**
 * Explain why inline completion may not be working. Everything is written to
 * the "PCPR Inline Completion" output channel and a short summary is shown.
 * @param {vscode.ExtensionContext} context
 */
export async function showInlineCompletionStatus(context) {
    const options = readOptions();
    const editorSetting = vscode.workspace.getConfiguration('editor').get('inlineSuggest.enabled');
    const inlineSuggestEnabled = editorSetting !== false;

    const userData = await userdataUtils.getData(context);
    const hasApi = !!(userData && userData.baseURL && userData.model);
    const sysPrompt = userdataUtils.getSysPrompt(context.extensionPath);
    const hasPrompt = !!(sysPrompt && (sysPrompt['inline-completion'] || sysPrompt.inline_completion));

    const editor = vscode.window.activeTextEditor;
    const language = editor ? editor.document.languageId : '(no active editor)';
    const languageDisabled = editor ? options.disabledLanguages.includes(editor.document.languageId) : false;

    const lines = [
        `pcpr.inlineCompletion.enabled : ${options.enabled}`,
        `editor.inlineSuggest.enabled   : ${inlineSuggestEnabled}${inlineSuggestEnabled ? '' : '  <-- inline suggestions are disabled in VS Code settings!'}`,
        `API configured                 : ${hasApi}${hasApi ? ` (${userData.model} @ ${userData.baseURL})` : '  <-- run "PCPR: Add API" / "PCPR: Switch API"!'}`,
        `inline-completion prompt       : ${hasPrompt}${hasPrompt ? '' : '  <-- config/system_prompt.json is missing the key!'}`,
        `active language                : ${language}${languageDisabled ? '  <-- this language is in pcpr.inlineCompletion.disabledLanguages!' : ''}`,
        `debounceMs / maxTokens         : ${options.debounceMs} / ${options.maxTokens}`
    ];
    for (const line of lines) log(line);

    const broken = !options.enabled || !inlineSuggestEnabled || !hasApi || !hasPrompt || languageDisabled;
    const summary = broken
        ? 'PCPR inline completion is not ready - see the "PCPR Inline Completion" output channel.'
        : 'PCPR inline completion is ready. Type in an editor and pause, or run "Trigger Inline Suggestion".';
    const choice = await vscode.window.showInformationMessage(summary, 'Show Output');
    if (choice === 'Show Output') getOutputChannel().show(true);
}

/**
 * Create and register the inline completion provider.
 * @param {vscode.ExtensionContext} context
 * @param {() => string} getStructure
 * @param {() => string[]} getOpenFiles
 * @returns {PCPRInlineCompletionProvider}
 */
export function registerInlineCompletion(context, getStructure, getOpenFiles) {
    const provider = new PCPRInlineCompletionProvider(context, getStructure, getOpenFiles);
    context.subscriptions.push(
        vscode.languages.registerInlineCompletionItemProvider(INLINE_COMPLETION_SELECTOR, provider)
    );
    context.subscriptions.push(provider);
    context.subscriptions.push({ dispose: disposeOutputChannel });
    log(`provider registered for ${INLINE_COMPLETION_SELECTOR.map((s) => s.scheme).join(', ')}`);
    return provider;
}
