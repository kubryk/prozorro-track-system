import axios from 'axios';

const API_BASE = 'http://localhost:3000/search';
const EXTRACTION_API_BASE = 'http://localhost:3000/contract-extractions';
const API_KEY = 'your_secure_api_key_for_bot_and_dashboard';
const TAKE = 20;
const EDRPOU_PATTERN = /^\d{8}(\d{2})?$/;
const extractionCache = new Map();
const contractDetailCache = new Map();
const contractAuditReportCache = new Map();
const DETAIL_SECTION_STORAGE_PREFIX = 'contract-detail-section';

const TYPE_CONFIG = {
    tenders: {
        defaultRole: 'customer',
        defaultStatus: '',
        defaultDateType: 'dateModified',
        defaultSort: 'default',
        roleMode: 'multi',
        statusMode: 'multi',
        roleOptions: [
            { value: 'customer', label: 'Замовник' },
            { value: 'supplier', label: 'Постачальник' },
        ],
        statusOptions: [
            { value: 'active', label: 'Активні' },
            { value: 'complete', label: 'Завершені' },
            { value: 'unsuccessful', label: 'Неуспішні' },
        ],
        dateOptions: [
            { value: 'dateModified', label: 'Оновлено' },
            { value: 'dateCreated', label: 'Створено' },
            { value: 'tenderPeriodStart', label: 'Початок прийому пропозицій' },
            { value: 'tenderPeriodEnd', label: 'Завершення прийому пропозицій' },
            { value: 'enquiryPeriodStart', label: 'Початок уточнень' },
            { value: 'enquiryPeriodEnd', label: 'Завершення уточнень' },
            { value: 'auctionPeriodStart', label: 'Аукціон' },
            { value: 'awardPeriodStart', label: 'Кваліфікація' },
        ],
        sortOptions: [
            { value: 'default', label: 'Актуальні спочатку' },
            { value: 'dateCreatedDesc', label: 'Дата публікації: новіші' },
            { value: 'dateCreatedAsc', label: 'Дата публікації: старіші' },
            { value: 'amountDesc', label: 'Сума: більші' },
            { value: 'amountAsc', label: 'Сума: менші' },
        ],
    },
    contracts: {
        defaultRole: 'supplier',
        defaultStatus: '',
        defaultDateType: 'dateSigned',
        defaultSort: 'default',
        roleMode: 'multi',
        statusMode: 'multi',
        roleOptions: [
            { value: 'supplier', label: 'Постачальник' },
            { value: 'customer', label: 'Замовник' },
        ],
        statusOptions: [
            { value: 'active', label: 'Активні' },
            { value: 'complete', label: 'Завершені' },
            { value: 'terminated', label: 'Розірвані' },
        ],
        dateOptions: [
            { value: 'dateSigned', label: 'Підписано' },
            { value: 'dateModified', label: 'Оновлено' },
        ],
        sortOptions: [
            { value: 'default', label: 'Новіші спочатку' },
            { value: 'dateSignedDesc', label: 'Дата підписання: новіші' },
            { value: 'dateSignedAsc', label: 'Дата підписання: старіші' },
            { value: 'amountDesc', label: 'Сума: більші' },
            { value: 'amountAsc', label: 'Сума: менші' },
        ],
    },
};

let currentType = 'tenders';
let currentPage = 0;
let hasSearched = false;
let detailAutoRefreshTimer = null;
let detailAutoRefreshContractRef = '';
let promptSettingsState = [];
let promptSettingsLoaded = false;
let promptSettingsSaving = false;
let promptSettingsStatusMessage = '';
let promptSettingsStatusType = '';

const els = {
    appContainer: document.querySelector('.app-container'),
    edrpou: document.getElementById('edrpou'),
    role: document.getElementById('role'),
    roleSelect: document.getElementById('role-select'),
    roleMulti: document.getElementById('role-multi'),
    status: document.getElementById('status'),
    statusSelect: document.getElementById('status-select'),
    statusMulti: document.getElementById('status-multi'),
    dateFrom: document.getElementById('dateFrom'),
    dateTo: document.getElementById('dateTo'),
    priceFrom: document.getElementById('priceFrom'),
    priceTo: document.getElementById('priceTo'),
    dateType: document.getElementById('dateType'),
    sort: document.getElementById('sort'),
    searchBtn: document.getElementById('search-btn'),
    clearFilters: document.getElementById('clear-filters'),
    activeFilters: document.getElementById('active-filters'),
    searchSection: document.getElementById('search-section'),
    resultsInfo: document.getElementById('results-info'),
    resultsGrid: document.getElementById('results-grid'),
    contractDetailView: document.getElementById('contract-detail-view'),
    auditReportView: document.getElementById('audit-report-view'),
    promptSettingsView: document.getElementById('prompt-settings-view'),
    resultsCount: document.getElementById('results-count'),
    loading: document.getElementById('loading'),
    pagination: document.getElementById('pagination'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    pageInfo: document.getElementById('page-info'),
    toggleTenders: document.getElementById('toggle-tenders'),
    toggleContracts: document.getElementById('toggle-contracts'),
    statsBar: document.getElementById('stats-bar'),
    statsLoading: document.getElementById('stats-loading'),
    statTenders: document.getElementById('stat-tenders'),
    statContracts: document.getElementById('stat-contracts'),
    lastSync: document.getElementById('last-sync'),
    promptSettingsBtn: document.getElementById('prompt-settings-btn'),
};

function init() {
    applyTypeConfig(currentType, { forceReset: true });
    setupEventListeners();
    renderActiveFilters();
    fetchStats();
    handleRoute();
}

function setupEventListeners() {
    window.addEventListener('hashchange', handleRoute);

    els.promptSettingsBtn?.addEventListener('click', openPromptSettingsRoute);

    els.searchBtn.addEventListener('click', () => {
        currentPage = 0;
        performSearch();
    });

    els.toggleTenders.addEventListener('click', () => switchType('tenders'));
    els.toggleContracts.addEventListener('click', () => switchType('contracts'));

    els.prevBtn.addEventListener('click', () => {
        if (currentPage === 0) {
            return;
        }

        currentPage -= 1;
        performSearch();
    });

    els.nextBtn.addEventListener('click', () => {
        currentPage += 1;
        performSearch();
    });

    els.sort.addEventListener('change', () => {
        currentPage = 0;
        if (hasSearched) {
            performSearch();
        }
    });

    els.roleSelect.addEventListener('change', () => {
        els.role.value = els.roleSelect.value;
        handleFiltersChanged();
    });

    els.statusSelect.addEventListener('change', () => {
        els.status.value = els.statusSelect.value;
        handleFiltersChanged();
    });

    els.roleMulti.addEventListener('click', handleChoiceClick);
    els.statusMulti.addEventListener('click', handleChoiceClick);

    els.clearFilters.addEventListener('click', () => {
        clearAllFilters();
        if (hasSearched) {
            performSearch();
        }
    });

    els.activeFilters.addEventListener('click', (event) => {
        const button = event.target.closest('[data-filter-remove]');
        if (!button) {
            return;
        }

        const key = button.dataset.filterRemove;
        const value = button.dataset.filterValue;
        clearFilter(key, value);
        if (hasSearched) {
            performSearch();
        }
    });

    els.resultsGrid.addEventListener('click', async (event) => {
        const contractOpenButton = event.target.closest('[data-contract-open]');
        if (contractOpenButton) {
            const contractRef = contractOpenButton.dataset.contractOpen;
            if (contractRef) {
                openContractDetailRoute(contractRef);
            }
            return;
        }

        const toggleButton = event.target.closest('[data-extraction-toggle]');
        if (toggleButton) {
            const contractRef = toggleButton.dataset.extractionToggle;
            if (contractRef) {
                await handleExtractionToggle(contractRef);
            }
            return;
        }

        const runButton = event.target.closest('[data-extraction-run]');
        if (runButton) {
            const contractRef = runButton.dataset.extractionRun;
            if (contractRef) {
                await handleExtractionRun(contractRef);
            }
            return;
        }

        const refreshButton = event.target.closest('[data-extraction-refresh]');
        if (refreshButton) {
            const contractRef = refreshButton.dataset.extractionRefresh;
            if (contractRef) {
                await fetchAndRenderExtraction(contractRef, { forceRefresh: true, openPanel: true });
            }
        }
    });

    els.contractDetailView.addEventListener('click', async (event) => {
        const backButton = event.target.closest('[data-back-to-results]');
        if (backButton) {
            closeContractDetailRoute();
            return;
        }

        const toggleSectionButton = event.target.closest('[data-detail-section-toggle]');
        if (toggleSectionButton) {
            handleDetailSectionToggle(toggleSectionButton);
            return;
        }

        const runButton = event.target.closest('[data-detail-extraction-run]');
        if (runButton) {
            const contractRef = runButton.dataset.detailExtractionRun;
            if (contractRef) {
                await runDetailExtraction(contractRef);
            }
            return;
        }

        const refreshButton = event.target.closest('[data-detail-extraction-refresh]');
        if (refreshButton) {
            const contractRef = refreshButton.dataset.detailExtractionRefresh;
            if (contractRef) {
                await renderContractDetailPage(contractRef, { forceRefresh: true });
            }
            return;
        }

        const aiRefreshButton = event.target.closest('[data-detail-ai-refresh]');
        if (aiRefreshButton) {
            const contractRef = aiRefreshButton.dataset.detailAiRefresh;
            if (contractRef) {
                await renderContractDetailPage(contractRef, { forceRefresh: true });
            }
            return;
        }

        const aiAuditRefreshButton = event.target.closest('[data-detail-ai-audit-refresh]');
        if (aiAuditRefreshButton) {
            const contractRef = aiAuditRefreshButton.dataset.detailAiAuditRefresh;
            if (contractRef) {
                await renderContractDetailPage(contractRef, { forceRefresh: true });
            }
            return;
        }

        const reportButton = event.target.closest('[data-open-audit-report]');
        if (reportButton) {
            const contractRef = reportButton.dataset.openAuditReport;
            if (contractRef) {
                openContractAuditReportRoute(contractRef);
            }
            return;
        }
    });

    els.auditReportView?.addEventListener('click', async (event) => {
        const backButton = event.target.closest('[data-back-to-contract]');
        if (backButton) {
            const contractRef = backButton.dataset.backToContract;
            if (contractRef) {
                openContractDetailRouteInline(contractRef);
            } else {
                closeContractDetailRoute();
            }
            return;
        }

        const refreshButton = event.target.closest('[data-audit-report-refresh]');
        if (refreshButton) {
            const contractRef = refreshButton.dataset.auditReportRefresh;
            if (contractRef) {
                await renderContractAuditReportPage(contractRef, { forceRefresh: true });
            }
        }
    });

    els.promptSettingsView?.addEventListener('click', async (event) => {
        const backButton = event.target.closest('[data-back-from-prompts]');
        if (backButton) {
            closePromptSettingsRoute();
            return;
        }

        const saveButton = event.target.closest('[data-prompt-save]');
        if (saveButton) {
            await savePromptSettings();
            return;
        }

        const saveSingleButton = event.target.closest('[data-prompt-save-single]');
        if (saveSingleButton) {
            await savePromptSettings([saveSingleButton.dataset.promptSaveSingle]);
            return;
        }

        const resetAllButton = event.target.closest('[data-prompt-reset-all]');
        if (resetAllButton) {
            resetAllPromptSettingsToDefault();
            return;
        }

        const restoreTrigger = event.target.closest('[data-prompt-reset]');
        if (restoreTrigger) {
            restorePromptSettingToDefault(restoreTrigger.dataset.promptReset);
        }
    });

    [
        els.edrpou,
        els.dateFrom,
        els.dateTo,
        els.priceFrom,
        els.priceTo,
        els.dateType,
    ].forEach((element) => {
        const eventName = element.type === 'text' || element.type === 'number' ? 'input' : 'change';
        element.addEventListener(eventName, handleFiltersChanged);
    });

    [
        els.edrpou,
        els.dateFrom,
        els.dateTo,
        els.priceFrom,
        els.priceTo,
    ].forEach((element) => {
        element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') {
                return;
            }

            currentPage = 0;
            performSearch();
        });
    });
}

function switchType(type) {
    if (type === currentType) {
        return;
    }

    currentType = type;
    currentPage = 0;

    els.toggleTenders.classList.toggle('active', type === 'tenders');
    els.toggleContracts.classList.toggle('active', type === 'contracts');

    applyTypeConfig(type, { forceReset: true });
    renderActiveFilters();

    if (hasSearched) {
        performSearch();
    }
}

function handleRoute() {
    if (isPromptSettingsRoute()) {
        setAppMode('prompt-settings');
        renderPromptSettingsPage({ loading: !promptSettingsLoaded });
        if (!promptSettingsLoaded) {
            void loadPromptSettings();
        }
        return;
    }

    const reportContractRef = getContractAuditReportRefFromRoute();

    if (reportContractRef) {
        setAppMode('audit-report');
        renderContractAuditReportPage(reportContractRef);
        return;
    }

    const contractRef = getContractRefFromRoute();

    if (contractRef) {
        setAppMode('contract-detail');
        renderContractDetailPage(contractRef);
        return;
    }

    setAppMode('search');
}

function getContractRefFromRoute() {
    const normalizedHash = window.location.hash.replace(/^#\/?/, '');

    if (!normalizedHash.startsWith('contract/')) {
        return '';
    }

    return decodeURIComponent(normalizedHash.slice('contract/'.length));
}

function getContractAuditReportRefFromRoute() {
    const normalizedHash = window.location.hash.replace(/^#\/?/, '');

    if (!normalizedHash.startsWith('contract-report/')) {
        return '';
    }

    return decodeURIComponent(normalizedHash.slice('contract-report/'.length));
}

function isPromptSettingsRoute() {
    const normalizedHash = window.location.hash.replace(/^#\/?/, '');
    return normalizedHash === 'prompt-settings';
}

function openContractDetailRoute(contractRef) {
    const targetHash = `#contract/${encodeURIComponent(contractRef)}`;
    const targetUrl = `${window.location.pathname}${window.location.search}${targetHash}`;
    window.open(targetUrl, '_blank', 'noopener');
}

function openContractDetailRouteInline(contractRef) {
    window.location.hash = `#contract/${encodeURIComponent(contractRef)}`;
}

function openContractAuditReportRoute(contractRef) {
    window.location.hash = `#contract-report/${encodeURIComponent(contractRef)}`;
}

function closeContractDetailRoute() {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    handleRoute();
}

function openPromptSettingsRoute() {
    window.location.hash = '#prompt-settings';
}

function closePromptSettingsRoute() {
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
    handleRoute();
}

function setAppMode(mode) {
    const showDetail = mode !== 'search';

    if (mode !== 'contract-detail') {
        clearDetailAutoRefresh();
    }

    els.appContainer?.classList.toggle('detail-mode', showDetail);
    els.appContainer?.classList.toggle('plain-report-mode', mode === 'audit-report');
    document.body.classList.toggle('plain-report-mode', mode === 'audit-report');
    els.searchSection.classList.toggle('hidden', showDetail);
    els.resultsInfo.classList.toggle('hidden', showDetail);
    els.resultsGrid.classList.toggle('hidden', showDetail);
    els.pagination.classList.toggle('hidden', showDetail || !hasSearched);
    els.contractDetailView.classList.toggle('hidden', mode !== 'contract-detail');
    els.auditReportView.classList.toggle('hidden', mode !== 'audit-report');
    els.promptSettingsView.classList.toggle('hidden', mode !== 'prompt-settings');
}

function applyTypeConfig(type, { forceReset = false } = {}) {
    const config = TYPE_CONFIG[type];

    renderSelectOptions(els.dateType, config.dateOptions, forceReset ? config.defaultDateType : els.dateType.value || config.defaultDateType);
    renderSelectOptions(els.sort, config.sortOptions, forceReset ? config.defaultSort : els.sort.value || config.defaultSort);
    renderSelectOptions(els.roleSelect, config.roleOptions, config.defaultRole);
    renderSelectOptions(els.statusSelect, config.statusOptions, config.defaultStatus);
    renderChoiceButtons(els.roleMulti, config.roleOptions, 'role');
    renderChoiceButtons(els.statusMulti, config.statusOptions.filter((option) => option.value), 'status');

    if (forceReset) {
        els.role.value = config.defaultRole;
        els.status.value = config.defaultStatus;
    }

    syncRoleControl();
    syncStatusControl();
}

function renderSelectOptions(select, options, value) {
    select.innerHTML = options.map((option) => `
        <option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>
    `).join('');

    const hasValue = options.some((option) => option.value === value);
    select.value = hasValue ? value : options[0]?.value ?? '';
}

function renderChoiceButtons(container, options, group) {
    container.innerHTML = options.map((option) => `
        <button
            type="button"
            class="choice-chip"
            data-group="${escapeHtml(group)}"
            data-value="${escapeHtml(option.value)}"
        >${escapeHtml(option.label)}</button>
    `).join('');
}

async function loadPromptSettings({ forceRefresh = false } = {}) {
    if (promptSettingsLoaded && !forceRefresh) {
        renderPromptSettingsPage();
        return;
    }

    setPromptSettingsStatus('Завантажую промпти...', 'loading');
    renderPromptSettingsPage({ loading: true });

    try {
        const response = await axios.get(`${EXTRACTION_API_BASE}/prompt-settings`, {
            headers: {
                'X-API-KEY': API_KEY,
            },
        });

        promptSettingsState = Array.isArray(response?.data?.templates)
            ? response.data.templates
            : [];
        promptSettingsLoaded = true;
        setPromptSettingsStatus('', '');
        renderPromptSettingsPage();
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Не вдалося завантажити AI промпти';
        setPromptSettingsStatus(message, 'error');
        renderPromptSettingsPage();
    }
}

function renderPromptSettingsPage({ loading = false } = {}) {
    const contentHtml = loading
        ? `
            <div class="document-extraction-loading">
                <span class="inline-spinner"></span>
                <span>Завантажую шаблони промптів...</span>
            </div>
        `
        : createPromptSettingsGroupsHtml();

    els.promptSettingsView.innerHTML = `
        <div class="contract-detail-shell glass prompt-settings-shell">
            <div class="contract-detail-head">
                <button type="button" class="btn btn-secondary btn-sm" data-back-from-prompts>Назад</button>
            </div>
            <div class="prompt-settings-page-head">
                <div>
                    <h2>AI промпти</h2>
                    <p>Глобальні шаблони для витягу позицій і аудиту договорів.</p>
                </div>
            </div>
            ${createPromptSettingsStatusHtml()}
            <div id="prompt-settings-list" class="prompt-settings-list">
                ${contentHtml}
            </div>
            <div class="prompt-settings-footer">
                <button class="btn btn-ghost" type="button" data-prompt-reset-all>Скинути все до стандарту</button>
            </div>
        </div>
    `;
}

function createPromptSettingsGroupsHtml() {
    const groups = new Map();

    promptSettingsState.forEach((template) => {
        const group = template?.group || 'Інше';
        const templates = groups.get(group) || [];
        templates.push(template);
        groups.set(group, templates);
    });

    return [...groups.entries()].map(([group, templates]) => `
        <section class="prompt-settings-group">
            <h3>${escapeHtml(group)}</h3>
            <div class="prompt-settings-group-list">
                ${createPromptTemplatePairsHtml(templates)}
            </div>
        </section>
    `).join('');
}

function createPromptTemplatePairsHtml(templates) {
    const pairs = new Map();
    const order = [];

    templates.forEach((template) => {
        const pairKey = getPromptTemplatePairKey(template.key);

        if (!pairs.has(pairKey)) {
            pairs.set(pairKey, {});
            order.push(pairKey);
        }

        const pair = pairs.get(pairKey);
        const role = getPromptTemplateRole(template.key);

        if (role === 'system' || role === 'user') {
            pair[role] = template;
        } else {
            pair.single = template;
        }
    });

    return order.map((pairKey) => {
        const pair = pairs.get(pairKey);

        if (!pair) {
            return '';
        }

        if (pair.single) {
            return `
                <div class="prompt-template-pair prompt-template-pair-single">
                    ${createPromptTemplateHtml(pair.single)}
                </div>
            `;
        }

        return `
            <div class="prompt-template-pair" data-prompt-pair="${escapeHtml(pairKey)}">
                ${pair.system ? createPromptTemplateHtml(pair.system, { role: 'system' }) : ''}
                ${pair.user ? createPromptTemplateHtml(pair.user, { role: 'user' }) : ''}
            </div>
        `;
    }).join('');
}

function createPromptSettingsStatusHtml() {
    if (!promptSettingsStatusMessage) {
        return '';
    }

    return `
        <div class="prompt-settings-status prompt-settings-status-${escapeHtml(promptSettingsStatusType || 'info')}">
            ${escapeHtml(promptSettingsStatusMessage)}
        </div>
    `;
}

function createPromptTemplateHtml(template, options = {}) {
    const role = options.role || getPromptTemplateRole(template?.key);
    const placeholders = Array.isArray(template?.placeholders) ? template.placeholders : [];
    const roleLabel = role === 'system' ? 'System' : role === 'user' ? 'User' : null;
    const title = roleLabel || template.label || template.key;

    return `
        <article class="prompt-template-card" data-prompt-key="${escapeHtml(template.key)}">
            <div class="prompt-template-toolbar">
                <button type="button" class="btn btn-ghost btn-sm" data-prompt-reset="${escapeHtml(template.key)}">Стандартний</button>
            </div>
            <div class="prompt-template-head">
                <h4>${escapeHtml(title)}</h4>
                <p>${escapeHtml(template.description || '')}</p>
            </div>
            ${placeholders.length > 0 ? `
                <div class="prompt-template-placeholders">
                    ${placeholders.map((placeholder) => `<span class="header-chip">${escapeHtml(placeholder)}</span>`).join('')}
                </div>
            ` : ''}
            <textarea class="prompt-template-textarea" data-prompt-textarea="${escapeHtml(template.key)}">${escapeHtmlTextarea(template.value || '')}</textarea>
            <div class="prompt-template-footer">
                <button type="button" class="btn btn-primary btn-sm" data-prompt-save-single="${escapeHtml(template.key)}" ${promptSettingsSaving ? 'disabled' : ''}>Зберегти</button>
            </div>
        </article>
    `;
}

function getPromptTemplateRole(key) {
    if (typeof key !== 'string') {
        return null;
    }

    if (key.endsWith('_system')) {
        return 'system';
    }

    if (key.endsWith('_user')) {
        return 'user';
    }

    return null;
}

function getPromptTemplatePairKey(key) {
    if (typeof key !== 'string') {
        return 'other';
    }

    return key.replace(/_(system|user)$/, '');
}

function restorePromptSettingToDefault(key) {
    const template = promptSettingsState.find((item) => item.key === key);
    const textarea = els.promptSettingsView.querySelector(`[data-prompt-textarea="${CSS.escape(key)}"]`);

    if (!template || !textarea) {
        return;
    }

    textarea.value = template.defaultValue || '';
    setPromptSettingsStatus('Шаблон повернуто до стандартного значення. Не забудь зберегти.', 'info');
}

function resetAllPromptSettingsToDefault() {
    promptSettingsState.forEach((template) => {
        const textarea = els.promptSettingsView.querySelector(
            `[data-prompt-textarea="${CSS.escape(template.key)}"]`,
        );

        if (textarea) {
            textarea.value = template.defaultValue || '';
        }
    });

    setPromptSettingsStatus('Усі промпти повернуті до стандартних значень. Не забудь зберегти.', 'info');
}

async function savePromptSettings(keys = null) {
    if (promptSettingsSaving) {
        return;
    }

    const keysSet = Array.isArray(keys) && keys.length > 0
        ? new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))
        : null;

    const templates = promptSettingsState
    .filter((template) => !keysSet || keysSet.has(template.key))
    .map((template) => {
        const textarea = els.promptSettingsView.querySelector(
            `[data-prompt-textarea="${CSS.escape(template.key)}"]`,
        );
        const content = typeof textarea?.value === 'string' ? textarea.value : template.value || '';
        const normalizedContent = content.trim();
        const normalizedDefault = typeof template.defaultValue === 'string' ? template.defaultValue.trim() : '';

        return {
            key: template.key,
            content,
            reset: normalizedContent === normalizedDefault,
        };
    });

    if (!templates.length) {
        return;
    }

    promptSettingsState = promptSettingsState.map((template) => {
        const nextTemplate = templates.find((item) => item.key === template.key);

        return nextTemplate
            ? {
                ...template,
                value: nextTemplate.content,
                isCustom: !nextTemplate.reset,
            }
            : template;
    });

    promptSettingsSaving = true;
    const isSingleSave = templates.length === 1;
    setPromptSettingsStatus(
        isSingleSave ? 'Зберігаю промпт...' : 'Зберігаю промпти...',
        'loading',
    );
    renderPromptSettingsPage();

    try {
        const response = await axios.put(
            `${EXTRACTION_API_BASE}/prompt-settings`,
            { templates },
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        promptSettingsState = Array.isArray(response?.data?.templates)
            ? response.data.templates
            : promptSettingsState;
        promptSettingsLoaded = true;
        setPromptSettingsStatus(
            isSingleSave ? 'Промпт збережено.' : 'Промпти збережено.',
            'success',
        );
        renderPromptSettingsPage();
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Не вдалося зберегти AI промпти';
        setPromptSettingsStatus(message, 'error');
        renderPromptSettingsPage();
    } finally {
        promptSettingsSaving = false;
        renderPromptSettingsPage();
    }
}

function setPromptSettingsStatus(message, type) {
    promptSettingsStatusMessage = message || '';
    promptSettingsStatusType = type || '';
}

function handleChoiceClick(event) {
    const button = event.target.closest('.choice-chip');
    if (!button) {
        return;
    }

    const { group, value } = button.dataset;

    if (group === 'role') {
        toggleRoleChoice(value);
        return;
    }

    if (group === 'status') {
        toggleStatusChoice(value);
    }
}

function toggleRoleChoice(value) {
    const config = TYPE_CONFIG[currentType];
    const allowedValues = config.roleOptions.map((option) => option.value);
    const selectedValues = parseMultiValue(els.role.value).filter((item) => allowedValues.includes(item));
    const isSelected = selectedValues.includes(value);

    let nextValues = selectedValues;

    if (isSelected) {
        if (selectedValues.length === 1) {
            return;
        }
        nextValues = selectedValues.filter((item) => item !== value);
    } else {
        nextValues = [...selectedValues, value];
    }

    els.role.value = sortByOptions(nextValues, config.roleOptions).join(',');
    syncRoleControl();
    handleFiltersChanged();
}

function toggleStatusChoice(value) {
    const config = TYPE_CONFIG[currentType];
    const allowedValues = config.statusOptions.map((option) => option.value).filter(Boolean);
    const selectedValues = parseMultiValue(els.status.value).filter((item) => allowedValues.includes(item));
    const isSelected = selectedValues.includes(value);
    const nextValues = isSelected
        ? selectedValues.filter((item) => item !== value)
        : [...selectedValues, value];

    els.status.value = sortByOptions(nextValues, config.statusOptions).join(',');
    syncStatusControl();
    handleFiltersChanged();
}

function syncRoleControl() {
    const config = TYPE_CONFIG[currentType];
    const allowedValues = config.roleOptions.map((option) => option.value);

    if (config.roleMode === 'multi') {
        const values = parseMultiValue(els.role.value).filter((value) => allowedValues.includes(value));
        const normalizedValues = values.length > 0 ? sortByOptions(values, config.roleOptions) : [config.defaultRole];

        els.role.value = normalizedValues.join(',');
        els.roleSelect.value = normalizedValues[0];
        els.roleSelect.classList.add('hidden');
        els.roleMulti.classList.remove('hidden');

        updateChoiceGroupState(els.roleMulti, normalizedValues);
        return;
    }

    const value = allowedValues.includes(els.role.value) ? els.role.value : config.defaultRole;
    els.role.value = value;
    els.roleSelect.value = value;
    els.roleSelect.classList.remove('hidden');
    els.roleMulti.classList.add('hidden');
}

function syncStatusControl() {
    const config = TYPE_CONFIG[currentType];
    const allowedValues = config.statusOptions.map((option) => option.value);

    if (config.statusMode === 'multi') {
        const values = parseMultiValue(els.status.value).filter((value) => allowedValues.includes(value));
        els.status.value = sortByOptions(values, config.statusOptions).join(',');
        els.statusSelect.classList.add('hidden');
        els.statusMulti.classList.remove('hidden');
        updateChoiceGroupState(els.statusMulti, values);
        return;
    }

    const value = allowedValues.includes(els.status.value) ? els.status.value : config.defaultStatus;
    els.status.value = value;
    els.statusSelect.value = value;
    els.statusSelect.classList.remove('hidden');
    els.statusMulti.classList.add('hidden');
}

function updateChoiceGroupState(container, values) {
    const selectedValues = new Set(values);
    const buttons = container.querySelectorAll('.choice-chip');

    buttons.forEach((button) => {
        button.classList.toggle('active', selectedValues.has(button.dataset.value));
    });
}

function handleFiltersChanged() {
    currentPage = 0;
    renderActiveFilters();
}

function clearAllFilters() {
    const config = TYPE_CONFIG[currentType];

    els.edrpou.value = '';
    els.role.value = config.defaultRole;
    els.status.value = config.defaultStatus;
    els.dateFrom.value = '';
    els.dateTo.value = '';
    els.priceFrom.value = '';
    els.priceTo.value = '';
    els.dateType.value = config.defaultDateType;
    els.sort.value = config.defaultSort;
    currentPage = 0;

    syncRoleControl();
    syncStatusControl();
    renderActiveFilters();
}

function clearFilter(key, value) {
    const config = TYPE_CONFIG[currentType];

    switch (key) {
        case 'edrpou':
            els.edrpou.value = '';
            break;
        case 'role':
            if (config.roleMode === 'multi' && value) {
                const nextValues = parseMultiValue(els.role.value).filter((item) => item !== value);
                els.role.value = (nextValues.length > 0 ? sortByOptions(nextValues, config.roleOptions) : [config.defaultRole]).join(',');
            } else {
                els.role.value = config.defaultRole;
            }
            syncRoleControl();
            break;
        case 'status':
            if (config.statusMode === 'multi' && value) {
                els.status.value = sortByOptions(
                    parseMultiValue(els.status.value).filter((item) => item !== value),
                    config.statusOptions,
                ).join(',');
            } else {
                els.status.value = config.defaultStatus;
            }
            syncStatusControl();
            break;
        case 'dateFrom':
            els.dateFrom.value = '';
            break;
        case 'dateTo':
            els.dateTo.value = '';
            break;
        case 'priceFrom':
            els.priceFrom.value = '';
            break;
        case 'priceTo':
            els.priceTo.value = '';
            break;
        default:
            break;
    }

    currentPage = 0;
    renderActiveFilters();
}

function getActiveFilters() {
    const filters = [];
    const config = TYPE_CONFIG[currentType];

    if (els.edrpou.value) {
        filters.push({
            key: 'edrpou',
            label: `ЄДРПОУ: ${els.edrpou.value}`,
        });
    }

    const roleValues = parseMultiValue(els.role.value);
    const roleLabels = roleValues
        .map((value) => getOptionLabel(config.roleOptions, value))
        .filter(Boolean);

    if (config.roleMode === 'multi') {
        const isDefaultOnly = roleValues.length === 1 && roleValues[0] === config.defaultRole;
        if (!isDefaultOnly) {
            roleValues.forEach((value, index) => {
                filters.push({
                    key: 'role',
                    value,
                    label: `Роль: ${roleLabels[index]}`,
                });
            });
        }
    } else if (els.role.value !== config.defaultRole) {
        filters.push({
            key: 'role',
            label: `Роль: ${getOptionLabel(config.roleOptions, els.role.value)}`,
        });
    }

    if (config.statusMode === 'multi') {
        parseMultiValue(els.status.value).forEach((value) => {
            filters.push({
                key: 'status',
                value,
                label: `Статус: ${getOptionLabel(config.statusOptions, value)}`,
            });
        });
    } else if (els.status.value) {
        filters.push({
            key: 'status',
            label: `Статус: ${getOptionLabel(config.statusOptions, els.status.value)}`,
        });
    }

    if (els.dateFrom.value) {
        filters.push({
            key: 'dateFrom',
            label: `${getSelectedDateLabel()} від: ${formatDateOnly(els.dateFrom.value)}`,
        });
    }

    if (els.dateTo.value) {
        filters.push({
            key: 'dateTo',
            label: `${getSelectedDateLabel()} до: ${formatDateOnly(els.dateTo.value)}`,
        });
    }

    if (els.priceFrom.value) {
        filters.push({
            key: 'priceFrom',
            label: `Сума від: ${formatNumber(els.priceFrom.value)}`,
        });
    }

    if (els.priceTo.value) {
        filters.push({
            key: 'priceTo',
            label: `Сума до: ${formatNumber(els.priceTo.value)}`,
        });
    }

    return filters;
}

function renderActiveFilters() {
    const filters = getActiveFilters();

    if (filters.length === 0) {
        els.activeFilters.innerHTML = '<span class="filter-pill filter-pill-muted">Фільтри не застосовані</span>';
        els.clearFilters.disabled = true;
        return;
    }

    els.activeFilters.innerHTML = filters.map((filter) => `
        <span class="filter-pill">
            <span>${escapeHtml(filter.label)}</span>
            <button
                type="button"
                class="filter-pill-remove"
                aria-label="Видалити фільтр"
                data-filter-remove="${escapeHtml(filter.key)}"
                data-filter-value="${escapeHtml(filter.value ?? '')}"
            >×</button>
        </span>
    `).join('');
    els.clearFilters.disabled = false;
}

async function performSearch() {
    const edrpou = els.edrpou.value.trim();

    if (edrpou && !EDRPOU_PATTERN.test(edrpou)) {
        alert('ЄДРПОУ має містити 8 або 10 цифр');
        return;
    }

    try {
        showLoading(true);

        const response = await axios.get(`${API_BASE}/${currentType}`, {
            params: {
                edrpou: edrpou || undefined,
                role: els.role.value || undefined,
                status: els.status.value || undefined,
                dateFrom: els.dateFrom.value || undefined,
                dateTo: els.dateTo.value || undefined,
                priceFrom: els.priceFrom.value || undefined,
                priceTo: els.priceTo.value || undefined,
                dateType: els.dateType.value || undefined,
                sort: els.sort.value || undefined,
                skip: currentPage * TAKE,
                take: TAKE,
            },
            headers: { 'X-API-KEY': API_KEY },
        });

        hasSearched = true;
        renderResults(response.data);
    } catch (error) {
        console.error('Search error:', error);
        els.resultsCount.textContent = 'Помилка пошуку';
        els.resultsGrid.innerHTML = `
            <div class="empty-state">
                <p style="color: #ef4444">Помилка при запиті до сервера. Перевірте підключення.</p>
            </div>
        `;
        els.pagination.classList.add('hidden');
    } finally {
        showLoading(false);
    }
}

async function fetchStats() {
    setStatsLoading(true);

    try {
        const response = await axios.get(`${API_BASE}/stats`, {
            headers: { 'X-API-KEY': API_KEY },
        });

        const { tenders, contracts, lastSync } = response.data;

        els.statTenders.textContent = Number(tenders || 0).toLocaleString('uk-UA');
        els.statContracts.textContent = Number(contracts || 0).toLocaleString('uk-UA');

        if (lastSync) {
            const date = new Date(lastSync);
            els.lastSync.textContent = `Синхронізовано: ${date.toLocaleString('uk-UA')}`;
        } else {
            els.lastSync.textContent = 'Синхронізація триває';
        }

        els.statsBar.style.opacity = '1';
    } catch (error) {
        console.error('Stats fetch error:', error);
        els.lastSync.textContent = 'Не вдалося завантажити статистику';
    } finally {
        setStatsLoading(false);
    }
}

function renderResults(payload) {
    const items = Array.isArray(payload?.data) ? payload.data : [];
    const total = Number(payload?.total || 0);

    els.resultsCount.innerHTML = buildResultsCount(payload, total);

    if (items.length === 0) {
        els.resultsGrid.innerHTML = '<div class="empty-state"><p>Нічого не знайдено</p></div>';
        els.pagination.classList.add('hidden');
        return;
    }

    els.resultsGrid.innerHTML = items.map((item) => createCard(item)).join('');

    const totalPages = Math.max(1, Math.ceil(total / TAKE));
    els.pageInfo.textContent = `Сторінка ${currentPage + 1} з ${totalPages}`;
    els.prevBtn.disabled = currentPage === 0;
    els.nextBtn.disabled = (currentPage + 1) * TAKE >= total;
    els.pagination.classList.toggle('hidden', total <= TAKE);

    window.scrollTo({ top: 300, behavior: 'smooth' });
}

function buildResultsCount(payload, total) {
    if (currentType === 'tenders') {
        const countHtml = `Знайдено <span class="highlight">${formatNumber(total)}</span> тендерів`;
        if (typeof payload?.relatedContractTotal === 'number') {
            return `${countHtml} і <span class="highlight">${formatNumber(payload.relatedContractTotal)}</span> контрактів`;
        }
        return countHtml;
    }

    const countHtml = `Знайдено <span class="highlight">${formatNumber(total)}</span> контрактів`;
    if (typeof payload?.relatedTenderTotal === 'number') {
        return `${countHtml}, пов'язаних із <span class="highlight">${formatNumber(payload.relatedTenderTotal)}</span> тендерами`;
    }
    return countHtml;
}

function createCard(item) {
    const isContract = currentType === 'contracts';
    const id = isContract ? item.contractID : item.tenderID;
    const contractRef = isContract ? item.id : null;
    const title = isContract ? item.tender?.title || 'Без назви' : item.title || 'Без назви';
    const customerName = isContract ? item.tender?.customerName : item.customerName;
    const customerEdrpou = isContract ? item.tender?.customerEdrpou : item.customerEdrpou;
    const status = item.status || 'unknown';
    const amount = formatAmount(item.amount);
    const currency = item.currency || item.tender?.currency || 'UAH';

    const detailsHtml = isContract
        ? createContractDetails(item, customerName, customerEdrpou, currency)
        : createTenderDetails(item, customerName, customerEdrpou);

    return `
        <article class="result-card glass" ${isContract ? `data-contract-card="${escapeHtml(contractRef || '')}"` : ''}>
            <div class="card-header">
                <div>
                    <span class="tender-id">${escapeHtml(id || '—')}</span>
                </div>
                <span class="badge badge-${getBadgeClass(status)}">${escapeHtml(status)}</span>
            </div>
            <h3 class="card-title">${escapeHtml(title)}</h3>
            ${detailsHtml}
            ${isContract ? createExtractionBlock(contractRef) : ''}
            <div class="card-footer">
                <div class="amount">
                    ${amount}
                    <span class="amount-currency">${escapeHtml(currency)}</span>
                </div>
                <div class="card-actions">
                    ${isContract ? `
                        <button
                            type="button"
                            class="btn btn-primary btn-sm"
                            data-contract-open="${escapeHtml(contractRef || '')}"
                        >Сторінка контракту</button>
                        <button
                            type="button"
                            class="btn btn-secondary btn-sm"
                            data-extraction-toggle="${escapeHtml(contractRef || '')}"
                        >Документи</button>
                    ` : ''}
                    <a
                        href="${escapeHtml(getExternalLink(isContract, id))}"
                        target="_blank"
                        rel="noopener noreferrer"
                        class="btn btn-secondary btn-sm"
                    >На Prozorro</a>
                </div>
            </div>
        </article>
    `;
}

function createExtractionBlock(contractRef) {
    if (!contractRef) {
        return '';
    }

    return `
        <section class="document-extraction hidden" data-extraction-panel="${escapeHtml(contractRef)}">
            <div class="document-extraction-body">
                <div class="document-extraction-empty">
                    Натисни "Документи", щоб переглянути витяг із договору.
                </div>
            </div>
        </section>
    `;
}

function createContractDetails(item, customerName, customerEdrpou, currency) {
    const tenderStatus = item.tender?.status || 'unknown';
    const amountNet = item.amountNet ? `${formatAmount(item.amountNet)} ${escapeHtml(currency)}` : '—';
    const vatLabel = item.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ';

    return `
        <div class="card-details-grid">
            ${createDetailItem('Постачальник', `${item.supplierName || '—'} (${item.supplierEdrpou || '—'})`)}
            ${createDetailItem('Замовник', `${customerName || '—'} (${customerEdrpou || '—'})`)}
            ${createDetailItem('Сума Net', amountNet)}
            ${createDetailItem('ПДВ', vatLabel)}
            ${createDetailItem('Підписано', formatDateTime(item.dateSigned))}
            ${createDetailItem('Змінено', formatDateTime(item.dateModified))}
        </div>
        <div class="contracts-section">
            <span class="detail-label">Тендер-основа</span>
            <div class="mini-contracts-list">
                <a
                    href="${escapeHtml(getExternalLink(false, item.tender?.tenderID))}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mini-contract"
                >
                    <div class="mini-contract-main">
                        <span class="mini-supplier">${escapeHtml(item.tender?.tenderID || '—')}</span>
                        <span class="mini-status badge-sm badge-${getBadgeClass(tenderStatus)}">${escapeHtml(tenderStatus)}</span>
                    </div>
                    <span class="mini-amount mini-link-hint">Перейти до тендеру</span>
                </a>
            </div>
        </div>
    `;
}

function createTenderDetails(item, customerName, customerEdrpou) {
    const contracts = Array.isArray(item.contracts) ? item.contracts : [];
    const selectedDateType = els.dateType.value;
    const isSpecialDate = selectedDateType !== 'dateModified' && selectedDateType !== 'dateCreated';
    const specialDateLabel = getSelectedDateLabel();
    const contractsHtml = contracts.map((contract) => `
        <a
            href="${escapeHtml(getExternalLink(true, contract.contractID))}"
            target="_blank"
            rel="noopener noreferrer"
            class="mini-contract"
        >
            <div class="mini-contract-main">
                <span class="mini-supplier">${escapeHtml(contract.supplierName || '—')}</span>
                <span class="mini-status badge-sm badge-${getBadgeClass(contract.status || '')}">${escapeHtml(contract.status || '—')}</span>
            </div>
            <span class="mini-amount">${formatAmount(contract.amount)} UAH</span>
        </a>
    `).join('');

    return `
        <div class="card-details-grid">
            ${createDetailItem('Замовник', `${customerName || '—'} (${customerEdrpou || '—'})`)}
            ${createDetailItem('Створено', formatDateTime(item.dateCreated))}
            ${createDetailItem('Змінено', formatDateTime(item.dateModified))}
            ${isSpecialDate ? createDetailItem(specialDateLabel, formatDateTime(item[selectedDateType]), 'highlight-date') : ''}
        </div>
        ${contracts.length > 0 ? `
            <div class="contracts-section">
                <span class="detail-label">Контракти (${contracts.length})</span>
                <div class="mini-contracts-list">${contractsHtml}</div>
            </div>
        ` : ''}
    `;
}

function createDetailItem(label, value, className = '') {
    const classes = ['detail-item', className].filter(Boolean).join(' ');

    return `
        <div class="${classes}">
            <span class="detail-label">${escapeHtml(label)}</span>
            <span class="detail-val">${escapeHtml(value)}</span>
        </div>
    `;
}

function getBadgeClass(status) {
    const normalizedStatus = String(status).toLowerCase();

    if (normalizedStatus.includes('complete')) {
        return 'complete';
    }

    if (normalizedStatus.includes('unsuccessful') || normalizedStatus.includes('terminated') || normalizedStatus.includes('cancelled')) {
        return 'unsuccessful';
    }

    if (normalizedStatus.includes('active')) {
        return 'active';
    }

    return 'active';
}

function showLoading(show) {
    els.loading.classList.toggle('hidden', !show);
    els.searchBtn.disabled = show;
    els.sort.disabled = show;
    els.resultsGrid.style.opacity = show ? '0.5' : '1';
}

async function handleExtractionToggle(contractRef) {
    const panel = getExtractionPanel(contractRef);
    if (!panel) {
        return;
    }

    const willOpen = panel.classList.contains('hidden');

    document.querySelectorAll('[data-extraction-panel]').forEach((element) => {
        if (element.dataset.extractionPanel !== contractRef) {
            element.classList.add('hidden');
        }
    });

    if (!willOpen) {
        panel.classList.add('hidden');
        return;
    }

    panel.classList.remove('hidden');

    const cached = extractionCache.get(contractRef);
    if (cached?.resultHtml && !cached.needsRefresh) {
        renderExtractionHtml(contractRef, cached.resultHtml);
        return;
    }

    await fetchAndRenderExtraction(contractRef, { openPanel: true });
}

async function handleExtractionRun(contractRef) {
    setExtractionLoading(contractRef, 'Запускаю повний аналіз документів...');

    try {
        const response = await axios.post(
            `${EXTRACTION_API_BASE}/contracts/${encodeURIComponent(contractRef)}/run`,
            {},
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        contractAuditReportCache.delete(contractRef);
        contractDetailCache.delete(contractRef);

        extractionCache.set(contractRef, {
            ...(extractionCache.get(contractRef) || {}),
            status: response.data,
            needsRefresh: true,
        });

        renderExtractionStatus(contractRef, response.data);
    } catch (error) {
        renderExtractionError(contractRef, error);
    }
}

async function fetchAndRenderExtraction(contractRef, { forceRefresh = false, openPanel = false } = {}) {
    const cached = extractionCache.get(contractRef);

    if (!forceRefresh && cached?.status && !cached.needsRefresh) {
        renderExtractionStatus(contractRef, cached.status);
        return;
    }

    setExtractionLoading(contractRef, 'Завантажую статус аналізу документів...');

    try {
        const response = await axios.get(
            `${EXTRACTION_API_BASE}/contracts/${encodeURIComponent(contractRef)}/status`,
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        extractionCache.set(contractRef, {
            status: response.data,
            resultHtml: null,
            needsRefresh: ['queued', 'waiting', 'active', 'processing', 'delayed'].includes(response.data?.state),
        });

        if (openPanel) {
            getExtractionPanel(contractRef)?.classList.remove('hidden');
        }

        renderExtractionStatus(contractRef, response.data);
    } catch (error) {
        renderExtractionError(contractRef, error);
    }
}

function renderExtractionStatus(contractRef, status) {
    const html = buildExtractionStatusHtml(contractRef, status);

    extractionCache.set(contractRef, {
        ...(extractionCache.get(contractRef) || {}),
        status,
        resultHtml: html,
        needsRefresh: ['queued', 'waiting', 'active', 'processing', 'delayed'].includes(status?.state),
    });

    renderExtractionHtml(contractRef, html);
}

function buildExtractionStatusHtml(contractRef, status) {
    if (!status) {
        return `
            <div class="document-extraction-empty">
                Дані про витяг недоступні.
            </div>
        `;
    }

    const state = status.state || 'idle';
    const result = status.result;

    if (state === 'idle') {
        return `
            <div class="document-extraction-head">
                <div>
                    <span class="detail-label">Витяг з документів</span>
                    <p class="document-extraction-meta">Ще не запускався для цього контракту.</p>
                </div>
                <button type="button" class="btn btn-primary btn-sm" data-extraction-run="${escapeHtml(contractRef)}">Запустити аналіз</button>
            </div>
        `;
    }

    if (['queued', 'waiting', 'active', 'processing', 'delayed'].includes(state)) {
        return `
            <div class="document-extraction-head">
                <div>
                    <span class="detail-label">Витяг з документів</span>
                    <p class="document-extraction-meta">Обробка триває. Онови стан через кілька секунд.</p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" data-extraction-refresh="${escapeHtml(contractRef)}">Оновити</button>
            </div>
            <div class="document-extraction-loading">
                <span class="inline-spinner"></span>
                <span>${escapeHtml(getExtractionStateLabel(state))}</span>
            </div>
        `;
    }

    if (state === 'failed') {
        return `
            <div class="document-extraction-head">
                <div>
                    <span class="detail-label">Витяг з документів</span>
                    <p class="document-extraction-meta document-extraction-error">${escapeHtml(status.failureReason || 'Не вдалося обробити документ')}</p>
                </div>
                <div class="document-extraction-actions">
                    <button type="button" class="btn btn-secondary btn-sm" data-extraction-refresh="${escapeHtml(contractRef)}">Оновити</button>
                    <button type="button" class="btn btn-primary btn-sm" data-extraction-run="${escapeHtml(contractRef)}">Запустити аналіз ще раз</button>
                </div>
            </div>
        `;
    }

    const documents = Array.isArray(result?.documents) ? result.documents : [];
    const documentsWithText = documents.filter((document) => typeof document?.extractedText === 'string' && document.extractedText.trim().length > 0).length;
    const documentsHtml = documents.length > 0
        ? documents.map((document) => createExtractedDocumentHtml(document)).join('')
        : `<div class="document-extraction-empty">Не знайшов витягнутих даних для цього контракту.</div>`;

    return `
        <div class="document-extraction-head">
            <div>
                <span class="detail-label">Витяг з документів</span>
                <p class="document-extraction-meta">
                    Оброблено ${formatNumber(result?.processedDocuments || 0)} документів з ${formatNumber(result?.relevantDocuments || 0)} релевантних.
                </p>
                <p class="document-extraction-meta">
                    Текст знайдено у ${formatNumber(documentsWithText)} документах. Після цього AI автоматично запускає витяг позицій і аудит.
                </p>
            </div>
            <div class="document-extraction-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-extraction-refresh="${escapeHtml(contractRef)}">Оновити</button>
                <button type="button" class="btn btn-primary btn-sm" data-extraction-run="${escapeHtml(contractRef)}">Перезапустити аналіз</button>
            </div>
        </div>
        <div class="document-extraction-docs">
            ${documentsHtml}
        </div>
    `;
}

function normalizeDocumentMatchValue(value) {
    return String(value || '').trim().toLowerCase();
}

function mergeContractDocuments(sourceDocuments, extractedDocuments) {
    const usedExtractedDocuments = new Set();

    const merged = sourceDocuments.map((sourceDocument) => {
        const sourceUrl = normalizeDocumentMatchValue(sourceDocument?.url);
        const sourceTitle = normalizeDocumentMatchValue(sourceDocument?.title);

        const extractedDocument = extractedDocuments.find((candidate) => {
            if (usedExtractedDocuments.has(candidate)) {
                return false;
            }

            const candidateUrl = normalizeDocumentMatchValue(candidate?.url);
            const candidateTitle = normalizeDocumentMatchValue(candidate?.title);

            return (sourceUrl && candidateUrl && sourceUrl === candidateUrl)
                || (sourceTitle && candidateTitle && sourceTitle === candidateTitle);
        }) || null;

        if (extractedDocument) {
            usedExtractedDocuments.add(extractedDocument);
        }

        return { sourceDocument, extractedDocument };
    });

    const extractionOnlyDocuments = extractedDocuments
        .filter((document) => !usedExtractedDocuments.has(document))
        .map((extractedDocument) => ({ sourceDocument: null, extractedDocument }));

    return [...merged, ...extractionOnlyDocuments];
}

function createContractDocumentHtml({ sourceDocument, extractedDocument }, extractionState) {
    const title = sourceDocument?.title || extractedDocument?.title || 'Документ';
    const url = sourceDocument?.url || extractedDocument?.url || '#';
    const documentMetaParts = [
        sourceDocument?.format || sourceDocument?.documentType || extractedDocument?.mimeType || '',
        sourceDocument?.datePublished ? `Опубліковано: ${formatDateTime(sourceDocument.datePublished)}` : '',
    ].filter(Boolean).join(' · ');
    const extractedText = typeof extractedDocument?.extractedText === 'string' ? extractedDocument.extractedText.trim() : '';
    const extractionMethod = extractedDocument?.extractionMethod ? getDocumentExtractionMethodLabel(extractedDocument.extractionMethod) : null;
    const isExtractionRunning = ['queued', 'waiting', 'active', 'processing', 'delayed'].includes(extractionState);

    let statusBadgeHtml = '<span class="badge badge-muted">Без витягу</span>';
    if (isExtractionRunning && !extractedDocument) {
        statusBadgeHtml = '<span class="badge badge-active">В обробці</span>';
    } else if (extractedDocument?.error) {
        statusBadgeHtml = '<span class="badge badge-unsuccessful">Помилка</span>';
    } else if (extractionMethod) {
        statusBadgeHtml = `<span class="badge badge-${getDocumentExtractionMethodBadgeClass(extractedDocument.extractionMethod)}">${escapeHtml(extractionMethod)}</span>`;
    }

    return `
        <article class="document-card">
            <div class="document-card-head">
                <div>
                    <div class="document-card-title-row">
                        <h4>${escapeHtml(title)}</h4>
                        ${statusBadgeHtml}
                    </div>
                    ${documentMetaParts ? `<p class="document-extraction-meta">${escapeHtml(documentMetaParts)}</p>` : ''}
                    <p class="document-extraction-meta">
                        ${extractedDocument
                            ? `${extractedText ? `Текст витягнуто: ${formatNumber(extractedText.length)} символів.` : 'Текст не витягнуто.'}`
                            : (isExtractionRunning ? 'Документ очікує завершення витягу.' : 'Для цього документа ще немає витягнутих даних.')}
                    </p>
                </div>
                <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">PDF</a>
            </div>
            ${extractedDocument?.error ? `
                <p class="document-extraction-error">${escapeHtml(extractedDocument.error)}</p>
            ` : ''}
            ${extractedText ? `
                <details class="document-text-preview">
                    <summary>Показати витягнутий текст</summary>
                    <pre>${escapeHtml(extractedText)}</pre>
                </details>
            ` : ''}
        </article>
    `;
}

function createExtractedDocumentHtml(document) {
    return createContractDocumentHtml(
        { sourceDocument: null, extractedDocument: document },
        'completed',
    );
}

function createMetaListItem(label, value) {
    return `
        <div class="meta-list-item">
            <span class="meta-list-label">${escapeHtml(label)}</span>
            <span class="meta-list-value">${escapeHtml(value)}</span>
        </div>
    `;
}

function setExtractionLoading(contractRef, message) {
    renderExtractionHtml(contractRef, `
        <div class="document-extraction-loading">
            <span class="inline-spinner"></span>
            <span>${escapeHtml(message)}</span>
        </div>
    `);
}

function renderExtractionHtml(contractRef, html) {
    const panel = getExtractionPanel(contractRef);
    const body = panel?.querySelector('.document-extraction-body');

    if (!body) {
        return;
    }

    body.innerHTML = html;
    panel.classList.remove('hidden');
}

function renderExtractionError(contractRef, error) {
    const message = error?.response?.data?.message || error?.message || 'Не вдалося завантажити витяг з документів';

    renderExtractionHtml(contractRef, `
        <div class="document-extraction-head">
            <div>
                <span class="detail-label">Витяг з документів</span>
                <p class="document-extraction-meta document-extraction-error">${escapeHtml(message)}</p>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-extraction-refresh="${escapeHtml(contractRef)}">Спробувати ще раз</button>
        </div>
    `);
}

function getExtractionPanel(contractRef) {
    return document.querySelector(`[data-extraction-panel="${CSS.escape(contractRef)}"]`);
}

function getExtractionStateLabel(state) {
    const map = {
        queued: 'У черзі',
        waiting: 'Очікує на обробку',
        active: 'Обробляється',
        processing: 'Обробляється',
        delayed: 'Відкладено',
    };

    return map[state] || 'Обробляється';
}

function isActiveProcessState(state) {
    return ['queued', 'waiting', 'active', 'processing', 'delayed'].includes(state);
}

function getProcessStepStatusView(step, status) {
    const state = status?.state || 'idle';
    const result = status?.result || null;

    if (step === 'extraction') {
        if (state === 'idle') {
            return { label: 'Не запускалось', badgeClass: 'muted', meta: 'Ще не запускалось.' };
        }
        if (isActiveProcessState(state)) {
            return { label: 'В процесі', badgeClass: 'active', meta: 'Йде обробка документів.' };
        }
        if (state === 'failed') {
            return { label: 'Помилка', badgeClass: 'unsuccessful', meta: status?.failureReason || 'Не вдалося обробити документи.' };
        }
        if (state === 'completed') {
            return { label: 'Завершено', badgeClass: 'complete', meta: `${formatNumber(result?.processedDocuments || 0)} документів.` };
        }
        if (state === 'completed_text') {
            return { label: 'Лише текст', badgeClass: 'warning', meta: 'Текст є, таблиць замало.' };
        }
        if (state === 'completed_no_tables') {
            return { label: 'Без таблиць', badgeClass: 'warning', meta: 'Таблиці не знайдено.' };
        }
        if (state === 'no_contract_documents') {
            return { label: 'Без документів', badgeClass: 'warning', meta: 'У Prozorro немає документів.' };
        }
        if (state === 'no_relevant_documents') {
            return { label: 'Немає релевантних', badgeClass: 'warning', meta: 'Не знайдено придатних документів.' };
        }
        if (state === 'requires_mistral_config') {
            return { label: 'Потрібен OCR', badgeClass: 'unsuccessful', meta: 'Потрібен Mistral OCR.' };
        }
    }

    if (step === 'ai-extraction') {
        const items = Array.isArray(result?.items) ? result.items : [];
        const documentCount = countDocumentDerivedAiItems(items);
        const fallbackCount = Math.max(items.length - documentCount, 0);

        if (state === 'idle') {
            return { label: 'Не запускалось', badgeClass: 'muted', meta: 'Очікує документи.' };
        }
        if (isActiveProcessState(state)) {
            return { label: 'В процесі', badgeClass: 'active', meta: 'Gemini збирає позиції.' };
        }
        if (state === 'failed') {
            return { label: 'Помилка', badgeClass: 'unsuccessful', meta: status?.failureReason || 'Не вдалося виконати AI витяг.' };
        }
        if (state === 'completed') {
            return { label: 'Завершено', badgeClass: 'complete', meta: `${formatNumber(documentCount)} позицій з документів.` };
        }
        if (state === 'completed_api_fallback_only') {
            return { label: 'Лише API', badgeClass: 'warning', meta: `${formatNumber(fallbackCount || items.length)} позицій тільки з API.` };
        }
        if (state === 'completed_no_items') {
            return { label: 'Без позицій', badgeClass: 'warning', meta: 'Позиції не знайдено.' };
        }
        if (state === 'no_extracted_text') {
            return { label: 'Немає тексту', badgeClass: 'warning', meta: 'Спершу потрібен витяг тексту.' };
        }
        if (state === 'requires_gemini_config') {
            return { label: 'Потрібен Gemini', badgeClass: 'unsuccessful', meta: 'Потрібен Gemini API key.' };
        }
    }

    if (step === 'ai-audit') {
        if (state === 'idle') {
            return { label: 'Не запускалось', badgeClass: 'muted', meta: 'Очікує позиції.' };
        }
        if (isActiveProcessState(state)) {
            return { label: 'В процесі', badgeClass: 'active', meta: 'Gemini оцінює ризики.' };
        }
        if (state === 'failed') {
            return { label: 'Помилка', badgeClass: 'unsuccessful', meta: status?.failureReason || 'Не вдалося виконати AI аудит.' };
        }
        if (state === 'completed') {
            return { label: 'Завершено', badgeClass: 'complete', meta: `${formatNumber(result?.itemsAudited || 0)} позицій перевірено.` };
        }
        if (state === 'completed_no_items') {
            return { label: 'Без результату', badgeClass: 'warning', meta: 'Немає валідних позицій.' };
        }
        if (state === 'no_items_to_audit') {
            return { label: 'Немає позицій', badgeClass: 'warning', meta: 'Немає що перевіряти.' };
        }
        if (state === 'no_document_items_to_audit') {
            return { label: 'Немає позицій з документів', badgeClass: 'warning', meta: 'Лише API fallback.' };
        }
        if (state === 'requires_gemini_config') {
            return { label: 'Потрібен Gemini', badgeClass: 'unsuccessful', meta: 'Потрібен Gemini API key.' };
        }
    }

    return { label: 'Невідомо', badgeClass: 'muted', meta: 'Стан тимчасово недоступний.' };
}

function buildDetailProcessSection(contractRef, latestExtraction, latestAiExtraction, latestAiAudit) {
    const extractionStatus = getProcessStepStatusView('extraction', latestExtraction);
    const aiExtractionStatus = getProcessStepStatusView('ai-extraction', latestAiExtraction);
    const aiAuditStatus = getProcessStepStatusView('ai-audit', latestAiAudit);
    const extractionState = latestExtraction?.state || 'idle';
    const aiExtractionState = latestAiExtraction?.state || 'idle';
    const aiAuditState = latestAiAudit?.state || 'idle';
    const isBusy = [extractionState, aiExtractionState, aiAuditState].some((state) => isActiveProcessState(state));
    const hasAnyRun = Boolean(latestExtraction || latestAiExtraction || latestAiAudit);
    const primaryActionLabel = hasAnyRun ? 'Перезапустити аналіз' : 'Почати аналіз';
    const introText = isBusy
        ? 'Аналіз триває.'
        : 'Документи -> позиції -> аудит';

    return `
        <div class="detail-process-content">
            <div class="document-extraction-head">
                <div>
                    <p class="document-extraction-meta">${introText}</p>
                </div>
                <div class="document-extraction-actions">
                    ${latestAiAudit?.state === 'completed' ? `<button type="button" class="btn btn-secondary btn-sm" data-open-audit-report="${escapeHtml(contractRef)}">Сторінка звіту</button>` : ''}
                    ${isBusy ? `<button type="button" class="btn btn-secondary btn-sm" data-detail-extraction-refresh="${escapeHtml(contractRef)}">Оновити</button>` : ''}
                    ${!isBusy ? `<button type="button" class="btn btn-primary btn-sm" data-detail-extraction-run="${escapeHtml(contractRef)}">${primaryActionLabel}</button>` : ''}
                </div>
            </div>
            <div class="process-status-grid">
                ${createProcessStatusCardHtml('1. Документи', extractionStatus)}
                ${createProcessStatusCardHtml('2. Позиції', aiExtractionStatus)}
                ${createProcessStatusCardHtml('3. Аудит', aiAuditStatus)}
            </div>
        </div>
    `;
}

function createProcessStatusCardHtml(title, status) {
    return `
        <div class="process-status-card is-${escapeHtml(status.badgeClass)}">
            <div class="process-status-head">
                <span class="process-status-title">${escapeHtml(title)}</span>
                <span class="badge badge-${escapeHtml(status.badgeClass)}">${escapeHtml(status.label)}</span>
            </div>
            <p class="process-status-meta">${escapeHtml(status.meta || '—')}</p>
        </div>
    `;
}

function buildDetailUsageSection(processingUsage) {
    const total = processingUsage?.total || null;

    if (!total) {
        return `
            <div class="usage-empty">
                Дані про токени, OCR сторінки і вартість з'являться після запуску аналізу.
            </div>
        `;
    }

    const stageCards = [
        {
            title: 'Документи',
            summary: processingUsage?.extraction || null,
            meta: 'PDF text / Mistral OCR',
        },
        {
            title: 'Витяг позицій',
            summary: processingUsage?.aiExtraction || null,
            meta: 'Gemini extraction',
        },
        {
            title: 'Аудит',
            summary: processingUsage?.aiAudit || null,
            meta: 'Grounded + structured + final',
        },
    ];

    return `
        <div class="usage-overview">
            <div class="usage-totals-grid">
                ${createUsageTotalCardHtml('Estimated cost', formatUsdValue(total.totalEstimatedCostUsd))}
                ${createUsageTotalCardHtml('Input tokens', formatNumber(total.totalPromptTokens))}
                ${createUsageTotalCardHtml('Output tokens', formatNumber(total.totalOutputTokens))}
                ${createUsageTotalCardHtml('OCR сторінок', formatNumber(total.totalProcessedPages))}
            </div>

            <div class="usage-stage-grid">
                ${stageCards.map((stage) => createUsageStageCardHtml(stage.title, stage.summary, stage.meta)).join('')}
            </div>
        </div>
    `;
}

function createUsageTotalCardHtml(label, value) {
    return `
        <div class="usage-total-card">
            <span class="usage-total-label">${escapeHtml(label)}</span>
            <strong class="usage-total-value">${escapeHtml(value)}</strong>
        </div>
    `;
}

function createUsageStageCardHtml(title, summary, meta) {
    if (!summary) {
        return `
            <div class="usage-stage-card">
                <div class="usage-stage-head">
                    <span class="usage-stage-title">${escapeHtml(title)}</span>
                </div>
                <p class="usage-stage-meta">${escapeHtml(meta)}</p>
                <p class="usage-stage-empty">Ще немає даних.</p>
            </div>
        `;
    }

    return `
        <div class="usage-stage-card">
            <div class="usage-stage-head">
                <span class="usage-stage-title">${escapeHtml(title)}</span>
                <span class="badge badge-muted">${escapeHtml(formatUsdValue(summary.totalEstimatedCostUsd))}</span>
            </div>
            <p class="usage-stage-meta">${escapeHtml(meta)}</p>
            <div class="usage-stage-stats">
                ${createUsageStatHtml('Input', formatNumber(summary.totalPromptTokens))}
                ${createUsageStatHtml('Output', formatNumber(summary.totalOutputTokens))}
                ${createUsageStatHtml('OCR сторінок', formatNumber(summary.totalProcessedPages))}
                ${createUsageStatHtml('Grounded search', formatNumber(summary.totalGroundedSearchRequests))}
            </div>
        </div>
    `;
}

function createUsageStatHtml(label, value) {
    return `
        <div class="usage-stat-item">
            <span class="usage-stat-label">${escapeHtml(label)}</span>
            <span class="usage-stat-value">${escapeHtml(value)}</span>
        </div>
    `;
}

function getDetailSectionStorageKey(contractRef, sectionKey) {
    return `${DETAIL_SECTION_STORAGE_PREFIX}:${contractRef}:${sectionKey}`;
}

function isDetailSectionExpanded(contractRef, sectionKey, defaultExpanded = true) {
    try {
        const stored = window.localStorage.getItem(getDetailSectionStorageKey(contractRef, sectionKey));
        if (stored === null) {
            return defaultExpanded;
        }

        return stored === '1';
    } catch {
        return defaultExpanded;
    }
}

function setDetailSectionExpanded(contractRef, sectionKey, expanded) {
    try {
        window.localStorage.setItem(getDetailSectionStorageKey(contractRef, sectionKey), expanded ? '1' : '0');
    } catch {
        // noop
    }
}

function getDetailSectionToggleLabel(expanded) {
    return expanded ? 'Згорнути' : 'Розгорнути';
}

function buildDetailSection({
    contractRef,
    sectionKey,
    title,
    bodyHtml,
    subtle = false,
    headerAsideHtml = '',
    defaultExpanded = true,
    rootDataAttrsHtml = '',
}) {
    const expanded = isDetailSectionExpanded(contractRef, sectionKey, defaultExpanded);

    return `
        <section class="contract-detail-section${subtle ? ' subtle' : ''}${expanded ? '' : ' is-collapsed'}" data-detail-section="${escapeHtml(sectionKey)}" data-detail-section-contract="${escapeHtml(contractRef)}" ${rootDataAttrsHtml}>
            <div class="section-header compact">
                <h3>${escapeHtml(title)}</h3>
                <div class="section-header-actions">
                    ${headerAsideHtml}
                    <button
                        type="button"
                        class="section-toggle-button"
                        data-detail-section-toggle="${escapeHtml(sectionKey)}"
                        data-detail-section-contract="${escapeHtml(contractRef)}"
                        aria-expanded="${expanded ? 'true' : 'false'}"
                    >
                        <span class="section-toggle-label">${getDetailSectionToggleLabel(expanded)}</span>
                        <span class="section-toggle-icon" aria-hidden="true">▾</span>
                    </button>
                </div>
            </div>
            <div class="detail-section-body"${expanded ? '' : ' hidden'}>
                ${bodyHtml}
            </div>
        </section>
    `;
}

function getDocumentExtractionMethodLabel(method) {
    const map = {
        'pdf-text': 'PDF text',
        'mistral-ocr': 'Mistral OCR',
    };

    return map[method] || 'Невідомий метод';
}

function getDocumentExtractionMethodBadgeClass(method) {
    const map = {
        'pdf-text': 'complete',
        'mistral-ocr': 'active',
    };

    return map[method] || 'unsuccessful';
}

async function renderContractDetailPage(contractRef, { forceRefresh = false } = {}) {
    if (!forceRefresh && contractDetailCache.has(contractRef)) {
        renderContractDetail(contractDetailCache.get(contractRef));
        return;
    }

    els.contractDetailView.innerHTML = `
        <div class="contract-detail-shell glass">
            <div class="document-extraction-loading">
                <span class="inline-spinner"></span>
                <span>Завантажую сторінку контракту...</span>
            </div>
        </div>
    `;

    try {
        const response = await axios.get(
            `${EXTRACTION_API_BASE}/contracts/${encodeURIComponent(contractRef)}/details`,
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        contractDetailCache.set(contractRef, response.data);
        renderContractDetail(response.data);
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Не вдалося завантажити сторінку контракту';

        els.contractDetailView.innerHTML = `
            <div class="contract-detail-shell glass">
                <div class="contract-detail-head">
                    <button type="button" class="btn btn-secondary btn-sm" data-back-to-results>Назад до списку</button>
                </div>
                <div class="document-extraction-empty">
                    <p class="document-extraction-error">${escapeHtml(message)}</p>
                </div>
            </div>
        `;
    }
}

async function renderContractAuditReportPage(contractRef, { forceRefresh = false } = {}) {
    if (!forceRefresh && contractAuditReportCache.has(contractRef)) {
        renderContractAuditReport(contractAuditReportCache.get(contractRef));
        return;
    }

    els.auditReportView.innerHTML = `
        <article class="contract-detail-shell glass">
            <div class="document-extraction-loading">
                <span class="inline-spinner"></span>
                <span>Завантажую звіт аудиту...</span>
            </div>
        </article>
    `;

    try {
        const response = await axios.get(
            `${EXTRACTION_API_BASE}/contracts/${encodeURIComponent(contractRef)}/report`,
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        contractAuditReportCache.set(contractRef, response.data);
        renderContractAuditReport(response.data);
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Не вдалося завантажити звіт аудиту';

        els.auditReportView.innerHTML = `
            <article class="contract-detail-shell glass">
                <div class="contract-detail-head">
                    <div class="contract-page-actions contract-page-actions-top">
                        <button type="button" class="btn btn-secondary btn-sm" data-back-to-contract="${escapeHtml(contractRef)}">Назад до контракту</button>
                    </div>
                    <div class="contract-detail-title-block">
                        <h2>Звіт аудиту</h2>
                    </div>
                </div>
                <p>${escapeHtml(message)}</p>
            </article>
        `;
    }
}

function handleDetailSectionToggle(button) {
    const section = button.closest('[data-detail-section]');
    const body = section?.querySelector('.detail-section-body');
    const contractRef = button.dataset.detailSectionContract;
    const sectionKey = button.dataset.detailSectionToggle;

    if (!section || !body || !contractRef || !sectionKey) {
        return;
    }

    const nextExpanded = section.classList.contains('is-collapsed');

    section.classList.toggle('is-collapsed', !nextExpanded);
    body.hidden = !nextExpanded;
    button.setAttribute('aria-expanded', nextExpanded ? 'true' : 'false');

    const label = button.querySelector('.section-toggle-label');
    if (label) {
        label.textContent = getDetailSectionToggleLabel(nextExpanded);
    }

    setDetailSectionExpanded(contractRef, sectionKey, nextExpanded);
}

function renderContractDetail(payload) {
    const contract = payload?.contract || {};
    const tender = payload?.tender || {};
    const sourceContract = payload?.sourceContract || null;
    const latestExtraction = payload?.latestExtraction || null;
    const latestAiExtraction = payload?.latestAiExtraction || null;
    const latestAiAudit = payload?.latestAiAudit || null;
    const processingUsage = payload?.processingUsage || null;
    const sourceDocuments = Array.isArray(payload?.sourceDocuments) ? payload.sourceDocuments : [];
    const currency = contract.currency || tender.currency || 'UAH';
    const contractRef = contract.contractID || contract.id;
    const title = tender.title || 'Без назви контракту';
    const sourceItems = Array.isArray(sourceContract?.items) ? sourceContract.items : [];
    const apiItemsCount = sourceItems.length > 0
        ? sourceItems.length
        : (Array.isArray(payload?.resolvedItems) ? payload.resolvedItems.length : 0);
    const extractedAiItems = Array.isArray(latestAiExtraction?.result?.items)
        ? latestAiExtraction.result.items
        : [];
    const documentItemsCount = countDocumentDerivedAiItems(extractedAiItems);
    const shouldRefresh = shouldAutoRefreshContractDetail(
        latestExtraction,
        latestAiExtraction,
        latestAiAudit,
    );
    const contractMetaBodyHtml = `
        <div class="meta-list">
            ${createMetaListItem('ID', contract.contractID || contract.id || '—')}
            ${createMetaListItem('Постачальник', `${contract.supplierName || '—'} (${contract.supplierEdrpou || '—'})`)}
            ${createMetaListItem('Замовник', `${tender.customerName || '—'} (${tender.customerEdrpou || '—'})`)}
            ${createMetaListItem('Сума контракту', formatMoneyValue(contract.amount, currency))}
            ${createMetaListItem('Сума Net', formatMoneyValue(contract.amountNet, currency))}
            ${createMetaListItem('ПДВ', contract.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ')}
            ${createMetaListItem('Підписано', formatDateTime(contract.dateSigned))}
            ${createMetaListItem('Створено', formatDateTime(contract.dateCreated))}
            ${createMetaListItem('Змінено', formatDateTime(contract.dateModified))}
            ${sourceContract ? createMetaListItem('Contract number', sourceContract.contractNumber || '—') : ''}
            ${sourceContract ? createMetaListItem('Період від', formatDateTime(sourceContract.period?.startDate)) : ''}
            ${sourceContract ? createMetaListItem('Період до', formatDateTime(sourceContract.period?.endDate)) : ''}
        </div>
        <div class="contract-page-actions sidebar-actions">
            <a
                href="${escapeHtml(getExternalLink(true, contract.contractID))}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-secondary btn-sm"
            >Контракт у Prozorro</a>
        </div>
    `;
    const tenderMetaBodyHtml = `
        <div class="meta-list">
            ${createMetaListItem('ID тендеру', tender.tenderID || '—')}
            ${createMetaListItem('Сума тендеру', formatMoneyValue(tender.amount, tender.currency || 'UAH'))}
            ${createMetaListItem('Створено тендер', formatDateTime(tender.dateCreated))}
            ${createMetaListItem('Оновлено тендер', formatDateTime(tender.dateModified))}
        </div>
        <div class="contract-page-actions sidebar-actions">
            <a
                href="${escapeHtml(getExternalLink(false, tender.tenderID))}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-secondary btn-sm"
            >Тендер у Prozorro</a>
        </div>
    `;

    els.contractDetailView.innerHTML = `
        <article class="contract-detail-shell glass">
            <div class="contract-detail-head">
                <div class="contract-page-actions contract-page-actions-top">
                    <button type="button" class="btn btn-secondary btn-sm" data-back-to-results>Назад до списку</button>
                </div>
                <div class="contract-detail-title-block">
                    <h2>${escapeHtml(title)}</h2>
                </div>
            </div>

            <div class="contract-detail-layout">
                <div class="contract-detail-main">
                    ${buildDetailSection({
                        contractRef,
                        sectionKey: 'process',
                        title: 'Статус обробки',
                        bodyHtml: buildDetailProcessSection(contractRef, latestExtraction, latestAiExtraction, latestAiAudit),
                    })}

                    ${buildDetailSection({
                        contractRef,
                        sectionKey: 'usage',
                        title: 'Використання AI/OCR',
                        subtle: true,
                        headerAsideHtml: processingUsage?.total
                            ? `<span class="badge badge-muted">${escapeHtml(formatUsdValue(processingUsage.total.totalEstimatedCostUsd))}</span>`
                            : '',
                        bodyHtml: buildDetailUsageSection(processingUsage),
                    })}

                    ${buildDetailSection({
                        contractRef,
                        sectionKey: 'positions',
                        title: 'Позиції',
                        bodyHtml: buildDetailAiExtractionSection(contractRef, latestAiExtraction, latestAiAudit),
                        headerAsideHtml: `
                            <span class="document-extraction-meta">З документів: ${escapeHtml(formatNumber(documentItemsCount))}</span>
                            <span class="document-extraction-meta">В API: ${escapeHtml(formatNumber(apiItemsCount))}</span>
                        `,
                    })}

                    ${buildDetailSection({
                        contractRef,
                        sectionKey: 'documents',
                        title: 'Документи',
                        headerAsideHtml: `<span class="document-extraction-meta">${formatNumber(sourceDocuments.length)} документів</span>`,
                        bodyHtml: buildDetailDocumentsSection(contractRef, sourceDocuments, latestExtraction),
                    })}

                </div>
            </div>

            <div class="contract-detail-secondary-grid">
                ${buildDetailSection({
                    contractRef,
                    sectionKey: 'contract-meta',
                    title: 'Контракт',
                    subtle: true,
                    headerAsideHtml: `<span class="badge badge-${getBadgeClass(contract.status || '')}">${escapeHtml(contract.status || '—')}</span>`,
                    bodyHtml: contractMetaBodyHtml,
                })}

                ${buildDetailSection({
                    contractRef,
                    sectionKey: 'tender-meta',
                    title: 'Тендер',
                    subtle: true,
                    headerAsideHtml: `<span class="badge badge-${getBadgeClass(tender.status || '')}">${escapeHtml(tender.status || '—')}</span>`,
                    bodyHtml: tenderMetaBodyHtml,
                })}
            </div>
        </article>
    `;

    scheduleDetailAutoRefresh(contractRef, shouldRefresh);
}

function renderContractAuditReport(payload) {
    const contract = payload?.contract || {};
    const reportDocument = payload?.reportDocument || null;
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const contractRef = contract.contractID || contract.id || '';
    const generatedAt = formatDateTime(reportDocument?.generatedAt);
    const blocks = Array.isArray(reportDocument?.blocks) ? reportDocument.blocks : [];

    if (!reportDocument) {
        els.auditReportView.innerHTML = `
            <article>
                <p>
                    <button type="button" data-back-to-contract="${escapeHtml(contractRef)}">Назад до контракту</button>
                    <button type="button" data-audit-report-refresh="${escapeHtml(contractRef)}">Оновити</button>
                </p>
                <h1>Звіт аудиту</h1>
                <p>Звіт аудиту ще недоступний. Спершу заверши аналіз договору.</p>
            </article>
        `;
        return;
    }

    els.auditReportView.innerHTML = `
        <article>
            <p>
                <button type="button" data-back-to-contract="${escapeHtml(contractRef)}">Назад до контракту</button>
                <button type="button" data-audit-report-refresh="${escapeHtml(contractRef)}">Оновити</button>
            </p>
            <h1>Звіт аудиту договору</h1>
            <p>${escapeHtml(contract.contractID || contract.id || '—')}</p>
            ${generatedAt !== '—' ? `<p>${escapeHtml(generatedAt)}</p>` : ''}
            ${blocks.map((block) => createAuditReportBlockHtml(block, items)).join('')}
        </article>
    `;
}

function shouldAutoRefreshContractDetail(latestExtraction, latestAiExtraction, latestAiAudit) {
    const activeStates = ['queued', 'waiting', 'active', 'processing', 'delayed'];
    const extractionState = latestExtraction?.state || 'idle';
    const aiExtractionState = latestAiExtraction?.state || 'idle';
    const aiAuditState = latestAiAudit?.state || 'idle';

    if (activeStates.includes(extractionState) || activeStates.includes(aiExtractionState) || activeStates.includes(aiAuditState)) {
        return true;
    }

    if (
        ['completed', 'completed_text', 'completed_no_tables', 'completed_no_items'].includes(extractionState) &&
        !latestAiExtraction
    ) {
        return true;
    }

    if (
        ['completed', 'completed_no_items', 'completed_api_fallback_only'].includes(aiExtractionState) &&
        !latestAiAudit
    ) {
        return true;
    }

    return false;
}

function scheduleDetailAutoRefresh(contractRef, shouldRefresh) {
    clearDetailAutoRefresh();

    if (!shouldRefresh) {
        return;
    }

    detailAutoRefreshContractRef = contractRef;
    detailAutoRefreshTimer = window.setTimeout(() => {
        if (!detailAutoRefreshContractRef) {
            return;
        }

        renderContractDetailPage(detailAutoRefreshContractRef, { forceRefresh: true });
    }, 3500);
}

function clearDetailAutoRefresh() {
    if (detailAutoRefreshTimer) {
        window.clearTimeout(detailAutoRefreshTimer);
        detailAutoRefreshTimer = null;
    }

    detailAutoRefreshContractRef = '';
}

function isDocumentDerivedAiItem(item) {
    return item?.source === 'document';
}

function countDocumentDerivedAiItems(items) {
    return Array.isArray(items)
        ? items.filter((item) => isDocumentDerivedAiItem(item)).length
        : 0;
}

async function runDetailExtraction(contractRef) {
    try {
        await axios.post(
            `${EXTRACTION_API_BASE}/contracts/${encodeURIComponent(contractRef)}/run`,
            {},
            {
                headers: {
                    'X-API-KEY': API_KEY,
                },
            },
        );

        contractDetailCache.delete(contractRef);
        extractionCache.delete(contractRef);
        contractAuditReportCache.delete(contractRef);
        await renderContractDetailPage(contractRef, { forceRefresh: true });
    } catch (error) {
        const message = error?.response?.data?.message || error?.message || 'Не вдалося запустити витяг';

        const statusContainer = els.contractDetailView.querySelector('.detail-extraction-content');
        if (statusContainer) {
            statusContainer.innerHTML = `
                <div class="document-extraction-empty">
                    <p class="document-extraction-error">${escapeHtml(message)}</p>
                </div>
            `;
        }
    }
}

function buildDetailDocumentsSection(contractRef, sourceDocuments, latestExtraction) {
    const hasExtractionRun = Boolean(latestExtraction);
    const state = latestExtraction?.state || 'idle';
    const result = latestExtraction?.result || null;
    const extractedDocuments = Array.isArray(result?.documents) ? result.documents : [];
    const mergedDocuments = mergeContractDocuments(sourceDocuments, extractedDocuments);
    const documentsWithText = extractedDocuments.filter((document) => typeof document?.extractedText === 'string' && document.extractedText.trim().length > 0).length;
    const detectedTables = extractedDocuments.reduce(
        (sum, document) => sum + (Array.isArray(document?.tables) ? document.tables.length : 0),
        0,
    );
    const documentsHtml = mergedDocuments.length > 0
        ? mergedDocuments.map((document) => createContractDocumentHtml(document, state)).join('')
        : `<div class="document-extraction-empty">Документи контракту в джерелі не знайдені або тимчасово недоступні.</div>`;

    let summaryHtml = `
        <p class="document-extraction-meta">
            У контракті доступно ${formatNumber(sourceDocuments.length)} документів.
        </p>
    `;

    if (!hasExtractionRun) {
        summaryHtml += `
            <p class="document-extraction-meta">Аналіз ще не запускався.</p>
        `;
    } else if (['queued', 'waiting', 'active', 'processing', 'delayed'].includes(state)) {
        summaryHtml += `
            <div class="document-extraction-loading inline">
                <span class="inline-spinner"></span>
                <span>${escapeHtml(getExtractionStateLabel(state))}</span>
            </div>
        `;
    } else if (state === 'failed') {
        summaryHtml += `
            <p class="document-extraction-error">${escapeHtml(latestExtraction.failureReason || 'Не вдалося обробити документи')}</p>
        `;
    } else {
        summaryHtml += `
            <p class="document-extraction-meta">
                Текст знайдено у ${formatNumber(documentsWithText)} документах, таблиць знайдено ${formatNumber(detectedTables)}.
            </p>
        `;
    }

    return `
        <div class="detail-extraction-content detail-documents-content">
            <div class="document-extraction-head">
                <div>
                    ${summaryHtml}
                </div>
            </div>
            <div class="document-extraction-docs">
                ${documentsHtml}
            </div>
        </div>
    `;
}

function buildDetailAiExtractionSection(contractRef, latestAiExtraction, latestAiAudit) {
    if (!latestAiExtraction) {
        return `
            <div class="detail-ai-extraction-content">
                <div class="document-extraction-head">
                    <div>
                        <p class="document-extraction-meta">AI витяг ще не запускався. Запусти загальний аналіз у блоці "Документи".</p>
                    </div>
                </div>
            </div>
        `;
    }

    const state = latestAiExtraction.state || 'idle';
    const result = latestAiExtraction.result;

    if (state === 'processing') {
        return `
            <div class="detail-ai-extraction-content">
                <div class="document-extraction-head">
                    <div class="document-extraction-loading inline">
                        <span class="inline-spinner"></span>
                        <span>Gemini обробляє витягнутий текст...</span>
                    </div>
                </div>
            </div>
        `;
    }

    if (state === 'failed') {
        return `
            <div class="detail-ai-extraction-content">
                <div class="document-extraction-head">
                    <div>
                        <p class="document-extraction-error">${escapeHtml(latestAiExtraction.failureReason || 'Не вдалося виконати AI витяг')}</p>
                    </div>
                </div>
            </div>
        `;
    }

    if (state === 'requires_gemini_config') {
        return `
            <div class="detail-ai-extraction-content">
                <div class="document-extraction-head">
                    <div>
                        <p class="document-extraction-error">Потрібно додати <code>GEMINI_API_KEY</code> в env.</p>
                    </div>
                </div>
            </div>
        `;
    }

    if (state === 'no_extracted_text') {
        return `
            <div class="detail-ai-extraction-content">
                <div class="document-extraction-head">
                    <div>
                        <p class="document-extraction-meta">Спершу треба виконати витяг з документів, щоб з'явився текст для AI.</p>
                    </div>
                </div>
            </div>
        `;
    }

    const items = Array.isArray(result?.items) ? result.items : [];
    const mergedItems = mergeAiExtractionWithAudit(items, latestAiAudit);
    const auditControlsHtml = buildInlineAuditControls(latestAiAudit, items);
    const contractAuditHtml = buildContractFinalAuditHtml(latestAiAudit);
    const auditReferencesHtml = buildInlineAuditReferences(latestAiAudit);
    const headerHtml = auditControlsHtml
        ? `
            <div class="document-extraction-head">
                <div>
                    ${auditControlsHtml}
                </div>
            </div>
        `
        : '';

    return `
        <div class="detail-ai-extraction-content">
            ${headerHtml}
            ${contractAuditHtml}
            ${items.length > 0 ? `
                <div class="contract-items-table-wrap">
                    <table class="contract-items-table ai-items-table">
                        <thead>
                            <tr>
                                <th scope="col">Назва</th>
                                <th scope="col">Ризик</th>
                                <th scope="col">Ринкова ціна</th>
                                <th scope="col">Завищення</th>
                                <th scope="col">Ціна за од.</th>
                                <th scope="col">Сума</th>
                                <th scope="col">Кількість</th>
                                <th scope="col">Одиниця</th>
                                <th scope="col">Валюта</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${mergedItems.map((item) => createAiExtractedItemRowHtml(item)).join('')}
                        </tbody>
                    </table>
                </div>
            ` : `
                <div class="document-extraction-empty">AI не знайшов структурованих позицій у витягнутому тексті.</div>
            `}
            ${auditReferencesHtml}
        </div>
    `;
}

function buildContractFinalAuditHtml(latestAiAudit) {
    const state = latestAiAudit?.state || 'idle';
    const analysis = state === 'completed' ? latestAiAudit?.result?.contractAnalysis : null;

    if (!analysis) {
        return '';
    }

    const procurementInfo = analysis.procurementInfo || {};
    const dataAvailability = analysis.dataAvailability || {};
    const financialPricing = analysis.financialPricing || {};
    const marketAnalytics = analysis.marketAnalytics || {};
    const conclusion = analysis.conclusion || {};
    const procurementLines = [
        buildAuditReportLine('ID договору', procurementInfo.identifier),
        buildAuditReportLine('Дата підписання', procurementInfo.dateSigned),
        buildAuditReportLine('Замовник', procurementInfo.customer),
        buildAuditReportLine('Постачальники', procurementInfo.contractor),
        procurementInfo.procurementSubject
            ? buildAuditReportLine('Предмет закупівлі', procurementInfo.procurementSubject)
            : '',
    ].filter(Boolean).join('');

    return `
        <section class="contract-final-audit">
            <section class="audit-report-section">
                <h4>Блок 1. Загальна інформація про договір</h4>
                <div class="audit-report-body">
                    ${procurementInfo.title ? buildAuditReportLine('Назва', procurementInfo.title) : ''}
                    ${procurementLines}
                </div>
            </section>
            <section class="audit-report-section">
                <h4>Блок 2. Доступність даних</h4>
                <div class="audit-report-body">
                    ${buildAuditReportList('Надані документи', dataAvailability.providedDocuments)}
                    ${buildAuditReportList('Відсутні критичні документи', dataAvailability.missingCriticalDocuments)}
                </div>
            </section>
            <section class="audit-report-section">
                <h4>Блок 3. Фінансово-ціновий аналіз</h4>
                <div class="audit-report-body">
                    ${buildAuditReportText('Загальна вартість', financialPricing.totalCost)}
                    ${buildAuditReportText('Ціна за одиницю', financialPricing.unitPrice)}
                    ${buildAuditReportText('Ключові елементи ціни', financialPricing.keyPriceElements)}
                </div>
            </section>
            <section class="audit-report-section">
                <h4>Блок 4. Ринкова аналітика</h4>
                <div class="audit-report-body">
                    ${buildAuditReportText('Орієнтовна ринкова ціна', marketAnalytics.estimatedMarketPrice)}
                    ${buildAuditReportText('Метод порівняння', marketAnalytics.comparisonMethod)}
                    ${buildAuditReportText('Числове зіставлення', marketAnalytics.numericComparison)}
                    ${buildAuditReportText('Дані по позиціях договору', marketAnalytics.itemBreakdown)}
                </div>
            </section>
            <section class="audit-report-section">
                <h4>Блок 5. Висновок</h4>
                <div class="audit-report-body">
                    ${buildAuditReportLine('Ознаки завищення', getYesNoInsufficientLabel(conclusion.overpricingSigns))}
                    ${buildAuditReportText('Орієнтовний розмір відхилення', conclusion.estimatedDeviation)}
                    ${buildAuditReportText('Коментар на основі фактів', conclusion.comment)}
                </div>
            </section>
        </section>
    `;
}

function createAuditReportBlockHtml(block, auditItems = []) {
    const items = Array.isArray(block?.items) ? block.items : [];

    return `
        <section>
            <h3>${escapeHtml(block?.title || 'Блок')}</h3>
            ${items.map((item) => createAuditReportItemHtml(item, auditItems)).join('')}
        </section>
    `;
}

function createAuditReportItemHtml(item, auditItems = []) {
    const type = item?.type || 'line';
    const label = escapeHtml(item?.label || 'Поле');

    if ((item?.label || '') === 'Дані по позиціях договору' && Array.isArray(auditItems) && auditItems.length > 0) {
        return `
            <div>
                <p><strong>${label}:</strong></p>
                ${createPlainAuditItemsTableHtml(auditItems)}
            </div>
        `;
    }

    if (type === 'list') {
        const items = Array.isArray(item?.items)
            ? item.items.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            : [];

        if (items.length === 0) {
            return `<p><strong>${label}:</strong> —</p>`;
        }

        return `
            <div>
                <p><strong>${label}:</strong></p>
                <ul>
                    ${items.map((entry) => `<li>${escapeHtml(entry)}</li>`).join('')}
                </ul>
            </div>
        `;
    }

    if (type === 'text') {
        return `
            <div>
                <p><strong>${label}:</strong></p>
                <pre>${escapeHtml(formatAuditBlockValue(item?.value))}</pre>
            </div>
        `;
    }

    return `<p><strong>${label}:</strong> ${escapeHtml(formatAuditBlockValue(item?.value))}</p>`;
}

function createPlainAuditItemsTableHtml(items) {
    if (!Array.isArray(items) || items.length === 0) {
        return '';
    }

    return `
        <table border="1" cellpadding="6" cellspacing="0">
            <thead>
                <tr>
                    <th>Назва</th>
                    <th>Ризик</th>
                    <th>Ринкова ціна</th>
                    <th>Завищення</th>
                    <th>Ціна за од.</th>
                    <th>Сума</th>
                    <th>Кількість</th>
                    <th>Одиниця</th>
                    <th>Валюта</th>
                </tr>
            </thead>
            <tbody>
                ${items.map((item) => `
                    <tr>
                        <td>${escapeHtml(item?.itemName || '—')}</td>
                        <td>${escapeHtml(getAuditRiskLabel(item?.riskLevel))}</td>
                        <td>${escapeHtml(formatPlainAuditNumber(item?.marketUnitPrice))}</td>
                        <td>${escapeHtml(formatPlainAuditPercent(item?.overpricingPercent))}</td>
                        <td>${escapeHtml(formatPlainAuditNumber(item?.unitPrice))}</td>
                        <td>${escapeHtml(formatPlainAuditNumber(item?.totalPrice))}</td>
                        <td>${escapeHtml(formatPlainAuditNumber(item?.quantity))}</td>
                        <td>${escapeHtml(item?.unit || '—')}</td>
                        <td>${escapeHtml(item?.currency || '—')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

function formatPlainAuditNumber(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('uk-UA', { maximumFractionDigits: 2 })
        : '—';
}

function formatPlainAuditPercent(value) {
    return typeof value === 'number' && Number.isFinite(value)
        ? `${value.toLocaleString('uk-UA', { maximumFractionDigits: 2 })}%`
        : '—';
}

function formatAuditBlockValue(value) {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : '—';
    }

    return '—';
}

function formatAuditBlockList(value) {
    if (!Array.isArray(value) || value.length === 0) {
        return '—';
    }

    const normalized = value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);

    return normalized.length > 0 ? normalized.join('; ') : '—';
}

function buildAuditReportLine(label, value) {
    return `
        <div class="audit-report-line">
            <strong>${escapeHtml(label)}:</strong>
            <span>${escapeHtml(formatAuditBlockValue(value))}</span>
        </div>
    `;
}

function buildAuditReportText(label, value) {
    return `
        <div class="audit-report-line">
            <strong>${escapeHtml(label)}:</strong>
            <div class="audit-report-text">${formatAuditBlockMultiline(value)}</div>
        </div>
    `;
}

function buildAuditReportList(label, items) {
    const normalized = Array.isArray(items)
        ? items
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : [];

    if (normalized.length === 0) {
        return buildAuditReportLine(label, '—');
    }

    return `
        <div class="audit-report-line">
            <strong>${escapeHtml(label)}:</strong>
            <ul class="audit-report-list">
                ${normalized.map((item) => `<li>${formatAuditBlockMultiline(item)}</li>`).join('')}
            </ul>
        </div>
    `;
}

function formatAuditBlockMultiline(value) {
    const formatted = formatAuditBlockValue(value);
    return escapeHtml(formatted).replace(/\n/g, '<br>');
}

function getAuditRiskLabel(level) {
    const map = {
        low: 'Низький',
        medium: 'Середній',
        high: 'Високий',
        critical: 'Критичний',
        unknown: 'Невизначено',
    };

    return map[level] || 'Невизначено';
}

function getYesNoInsufficientLabel(value) {
    if (value === 'yes') {
        return 'ТАК';
    }

    if (value === 'no') {
        return 'НІ';
    }

    return 'НЕДОСТАТНЬО ДАНИХ';
}

function getAuditRiskBadgeClass(level) {
    if (level === 'low') {
        return 'complete';
    }

    if (level === 'medium') {
        return 'warning';
    }

    if (level === 'high' || level === 'critical') {
        return 'unsuccessful';
    }

    return 'muted';
}

function buildInlineAuditControls(latestAiAudit, items) {
    const itemCount = Array.isArray(items) ? items.length : 0;
    const documentDerivedCount = countDocumentDerivedAiItems(items);

    if (itemCount <= 0) {
        return '<p class="document-extraction-meta">Спершу потрібні AI-витягнуті позиції з документів, щоб провести аудит.</p>';
    }

    if (!latestAiAudit) {
        if (documentDerivedCount <= 0) {
            return '<p class="document-extraction-meta">У документах не знайдено структурованих позицій, тому аудит на API fallback не запускається.</p>';
        }
        return '<p class="document-extraction-meta">Аудит ще не запускався. Він стартує автоматично після загального аналізу документів.</p>';
    }

    const state = latestAiAudit.state || 'idle';

    if (state === 'processing') {
        return '<div class="document-extraction-loading inline"><span class="inline-spinner"></span><span>Gemini проводить аудит позицій...</span></div>';
    }

    if (state === 'failed') {
        return `<p class="document-extraction-error">${escapeHtml(latestAiAudit.failureReason || 'Не вдалося виконати AI аудит')}</p>`;
    }

    if (state === 'requires_gemini_config') {
        return '<p class="document-extraction-error">Потрібно додати <code>GEMINI_API_KEY</code> в env.</p>';
    }

    if (state === 'no_items_to_audit') {
        return '<p class="document-extraction-meta">Спершу потрібні AI-витягнуті позиції з документів, щоб провести аудит.</p>';
    }

    if (state === 'no_document_items_to_audit') {
        return '<p class="document-extraction-meta">У документах не знайдено структурованих позицій, тому аудит на API fallback не проводився.</p>';
    }

    return '';
}

function buildInlineAuditReferences(latestAiAudit) {
    const result = latestAiAudit?.result;
    const state = latestAiAudit?.state || 'idle';

    if (state !== 'completed') {
        return '';
    }

    const searchQueries = Array.isArray(result?.searchQueries) ? result.searchQueries : [];
    const sources = Array.isArray(result?.sources) ? result.sources : [];

    return `
        ${searchQueries.length > 0 ? `
            <details class="document-text-preview">
                <summary>Пошукові запити</summary>
                <div class="audit-reference-list">
                    ${searchQueries.map((query) => `<span class="header-chip">${escapeHtml(query)}</span>`).join('')}
                </div>
            </details>
        ` : ''}
        ${sources.length > 0 ? `
            <details class="document-text-preview">
                <summary>Джерела</summary>
                <div class="audit-source-list">
                    ${sources.map((source) => `
                        <a href="${escapeHtml(source?.url || '#')}" target="_blank" rel="noopener noreferrer" class="audit-source-link">
                            ${escapeHtml(source?.title || source?.url || 'Джерело')}
                        </a>
                    `).join('')}
                </div>
            </details>
        ` : ''}
    `;
}

function mergeAiExtractionWithAudit(items, latestAiAudit) {
    const auditState = latestAiAudit?.state || 'idle';
    const auditItems = auditState === 'completed' && Array.isArray(latestAiAudit?.result?.items)
        ? latestAiAudit.result.items
        : [];
    const auditByIndex = new Map(
        auditItems.map((item) => [Number(item?.itemIndex) || 0, item]),
    );

    return items.map((item, index) => {
        const auditItem = auditByIndex.get(index + 1) || null;

        return {
            ...item,
            auditRiskLevel: auditItem?.riskLevel || null,
            auditMarketUnitPrice: typeof auditItem?.marketUnitPrice === 'number' ? auditItem.marketUnitPrice : null,
            auditMarketPriceMin: typeof auditItem?.marketPriceMin === 'number' ? auditItem.marketPriceMin : null,
            auditMarketPriceMax: typeof auditItem?.marketPriceMax === 'number' ? auditItem.marketPriceMax : null,
            auditOverpricingPercent: typeof auditItem?.overpricingPercent === 'number' ? auditItem.overpricingPercent : null,
        };
    });
}

function createAiExtractedItemRowHtml(item) {
    const hasMarketRange = typeof item?.auditMarketPriceMin === 'number' || typeof item?.auditMarketPriceMax === 'number';
    const marketValueLabel = typeof item?.auditMarketUnitPrice === 'number'
        ? formatAmount(item.auditMarketUnitPrice)
        : '—';
    const marketRangeLabel = hasMarketRange
        ? `${typeof item?.auditMarketPriceMin === 'number' ? formatAmount(item.auditMarketPriceMin) : '—'} - ${typeof item?.auditMarketPriceMax === 'number' ? formatAmount(item.auditMarketPriceMax) : '—'}`
        : null;
    const overpricingLabel = typeof item?.auditOverpricingPercent === 'number'
        ? `${item.auditOverpricingPercent >= 0 ? '+' : ''}${formatMaybeNumber(item.auditOverpricingPercent)}%`
        : '—';

    return `
        <tr>
            <td class="contract-items-table-name-cell">
                <strong class="contract-items-table-title">${escapeHtml(item?.itemName || 'Без назви')}</strong>
            </td>
            <td>${item?.auditRiskLevel ? `<span class="badge badge-${getAuditRiskBadgeClass(item.auditRiskLevel)}">${escapeHtml(getAuditRiskLabel(item.auditRiskLevel))}</span>` : '—'}</td>
            <td>
                <strong class="contract-items-table-title">${escapeHtml(marketValueLabel)}</strong>
                ${marketRangeLabel ? `<span class="contract-items-table-subvalue">Діапазон: ${escapeHtml(marketRangeLabel)}</span>` : ''}
            </td>
            <td>${escapeHtml(overpricingLabel)}</td>
            <td>${escapeHtml(typeof item?.unitPrice === 'number' ? formatAmount(item.unitPrice) : '—')}</td>
            <td>${escapeHtml(typeof item?.totalPrice === 'number' ? formatAmount(item.totalPrice) : '—')}</td>
            <td>${escapeHtml(formatMaybeNumber(item?.quantity))}</td>
            <td>${escapeHtml(item?.unit || '—')}</td>
            <td>${escapeHtml(item?.currency || '—')}</td>
        </tr>
    `;
}

function setStatsLoading(show) {
    els.statsBar.classList.toggle('is-loading', show);
    els.statsLoading?.setAttribute('aria-hidden', show ? 'false' : 'true');
}

function getSelectedDateLabel() {
    const config = TYPE_CONFIG[currentType];
    return getOptionLabel(config.dateOptions, els.dateType.value) || 'Дата';
}

function getOptionLabel(options, value) {
    return options.find((option) => option.value === value)?.label || '';
}

function parseMultiValue(value) {
    if (!value) {
        return [];
    }

    return [...new Set(
        String(value)
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    )];
}

function sortByOptions(values, options) {
    const order = new Map(options.map((option, index) => [option.value, index]));

    return [...new Set(values)].sort((left, right) => {
        const leftOrder = order.get(left) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = order.get(right) ?? Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder;
    });
}

function formatAmount(value) {
    if (typeof value !== 'number') {
        return '0.00';
    }

    return value.toLocaleString('uk-UA', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function formatMaybeNumber(value) {
    if (typeof value !== 'number') {
        return '—';
    }

    return value.toLocaleString('uk-UA', {
        minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
    });
}

function formatPercentValue(value) {
    if (typeof value !== 'number') {
        return '—';
    }

    return `${value >= 0 ? '+' : ''}${formatMaybeNumber(value)}%`;
}

function formatMoneyValue(value, currency) {
    if (typeof value !== 'number') {
        return '—';
    }

    return `${formatAmount(value)}${currency ? ` ${currency}` : ''}`;
}

function formatUsdValue(value) {
    if (typeof value !== 'number') {
        return '—';
    }

    return `${value.toLocaleString('uk-UA', {
        minimumFractionDigits: value >= 1 ? 2 : 4,
        maximumFractionDigits: value >= 1 ? 2 : 6,
    })} USD`;
}

function formatConfidence(value) {
    if (typeof value !== 'number') {
        return '—';
    }

    return `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value) {
    const numeric = typeof value === 'number' ? value : Number(value || 0);
    return numeric.toLocaleString('uk-UA');
}

function formatDateOnly(value) {
    return new Date(value).toLocaleDateString('uk-UA');
}

function formatDateTime(value) {
    if (!value) {
        return '—';
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return '—';
    }

    return date.toLocaleString('uk-UA', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
    });
}

function getExternalLink(isContract, id) {
    if (!id) {
        return 'https://prozorro.gov.ua';
    }

    return isContract
        ? `https://prozorro.gov.ua/uk/contract/${encodeURIComponent(id)}`
        : `https://prozorro.gov.ua/tender/${encodeURIComponent(id)}`;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeHtmlTextarea(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
}

init();
