import axios from 'axios';

const API_BASE = 'http://localhost:3000/search';
const API_KEY = 'your_secure_api_key_for_bot_and_dashboard';
const TAKE = 20;
const EDRPOU_PATTERN = /^\d{8}(\d{2})?$/;

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

const els = {
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
    resultsGrid: document.getElementById('results-grid'),
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
};

function init() {
    applyTypeConfig(currentType, { forceReset: true });
    setupEventListeners();
    renderActiveFilters();
    fetchStats();
}

function setupEventListeners() {
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
        <article class="result-card glass">
            <div class="card-header">
                <div>
                    <span class="tender-id">${escapeHtml(id || '—')}</span>
                </div>
                <span class="badge badge-${getBadgeClass(status)}">${escapeHtml(status)}</span>
            </div>
            <h3 class="card-title">${escapeHtml(title)}</h3>
            ${detailsHtml}
            <div class="card-footer">
                <div class="amount">
                    ${amount}
                    <span class="amount-currency">${escapeHtml(currency)}</span>
                </div>
                <a
                    href="${escapeHtml(getExternalLink(isContract, id))}"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="btn btn-secondary btn-sm"
                >На Prozorro</a>
            </div>
        </article>
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

init();
