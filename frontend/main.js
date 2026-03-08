import axios from 'axios';

const API_BASE = 'http://localhost:3000/search';
const API_KEY = 'your_secure_api_key_for_bot_and_dashboard'; // Matches .env API_KEY

let currentType = 'tenders';
let currentPage = 0;
const TAKE = 20;

const state = {
    edrpou: '',
    role: 'customer',
    status: '',
    dateFrom: '',
    dateTo: '',
    priceFrom: '',
    priceTo: '',
    dateType: 'dateModified',
};

// UI Elements
const els = {
    edrpou: document.getElementById('edrpou'),
    role: document.getElementById('role'),
    status: document.getElementById('status'),
    dateFrom: document.getElementById('dateFrom'),
    dateTo: document.getElementById('dateTo'),
    priceFrom: document.getElementById('priceFrom'),
    priceTo: document.getElementById('priceTo'),
    dateType: document.getElementById('dateType'),
    searchBtn: document.getElementById('search-btn'),
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
    statTenders: document.getElementById('stat-tenders'),
    statContracts: document.getElementById('stat-contracts'),
    lastSync: document.getElementById('last-sync'),
};

// Initialize
function init() {
    setupEventListeners();
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
        if (currentPage > 0) {
            currentPage--;
            performSearch();
        }
    });

    els.nextBtn.addEventListener('click', () => {
        currentPage++;
        performSearch();
    });
}

function switchType(type) {
    currentType = type;
    els.toggleTenders.classList.toggle('active', type === 'tenders');
    els.toggleContracts.classList.toggle('active', type === 'contracts');

    // Adjust default role
    if (type === 'tenders') {
        els.role.value = 'customer';
    } else {
        els.role.value = 'supplier';
    }

    currentPage = 0;

    // Update dateType options based on view
    if (type === 'contracts') {
        els.dateType.innerHTML = `
            <option value="dateSigned">Підписано</option>
            <option value="dateModified">Оновлено</option>
        `;
    } else {
        els.dateType.innerHTML = `
            <option value="dateModified">Оновлено</option>
            <option value="dateCreated">Створено</option>
            <option value="tenderPeriodStart">Прийом пропозицій</option>
            <option value="enquiryPeriodStart">Період уточнень</option>
            <option value="auctionPeriodStart">Аукціон</option>
            <option value="awardPeriodStart">Кваліфікація</option>
        `;
    }

    if (els.edrpou.value.length === 8) {
        performSearch();
    }
}

async function performSearch() {
    const edrpou = els.edrpou.value;
    if (edrpou && edrpou.length !== 8) {
        alert('ЄДРПОУ має містити 8 цифр');
        return;
    }

    try {
        showLoading(true);
        const params = {
            edrpou: edrpou || undefined,
            role: els.role.value,
            status: els.status.value || undefined,
            dateFrom: els.dateFrom.value || undefined,
            dateTo: els.dateTo.value || undefined,
            priceFrom: els.priceFrom.value || undefined,
            priceTo: els.priceTo.value || undefined,
            dateType: els.dateType.value || undefined,
            skip: currentPage * TAKE,
            take: TAKE
        };

        const response = await axios.get(`${API_BASE}/${currentType}`, {
            params,
            headers: { 'X-API-KEY': API_KEY }
        });

        renderResults(response.data);
    } catch (error) {
        console.error('Search error:', error);
        els.resultsGrid.innerHTML = `
            <div class="empty-state">
                <p style="color: #ef4444">Помилка при запиті до сервера. Перевірте підключення.</p>
            </div>
        `;
    } finally {
        showLoading(false);
    }
}

async function fetchStats() {
    try {
        const response = await axios.get(`${API_BASE}/stats`, {
            headers: { 'X-API-KEY': API_KEY }
        });
        const { tenders, contracts, lastSync } = response.data;
        els.statTenders.innerText = tenders.toLocaleString();
        els.statContracts.innerText = contracts.toLocaleString();

        if (lastSync) {
            const date = new Date(lastSync);
            els.lastSync.innerText = `Синхронізовано: ${date.toLocaleString('uk-UA')}`;
        }

        els.statsBar.style.opacity = '1';
    } catch (error) {
        console.error('Stats fetch error:', error);
    }
}

function renderResults(data) {
    const { data: items, total } = data;

    let countHtml = '';

    if (currentType === 'tenders') {
        const contractsCount = items.reduce((acc, item) => acc + (item.contracts?.length || 0), 0);
        countHtml = `Знайдено <span class="highlight">${total.toLocaleString()}</span> тендери`;
        if (contractsCount > 0) {
            countHtml += ` і <span class="highlight">${contractsCount}</span> контрактів, пов’язаних із ними`;
        }
    } else {
        const uniqueTenderIds = new Set(items.map(item => item.tender?.tenderID).filter(Boolean));
        countHtml = `Знайдено <span class="highlight">${total.toLocaleString()}</span> контракти`;
        if (uniqueTenderIds.size > 0) {
            countHtml += `, пов’язаних із <span class="highlight">${uniqueTenderIds.size}</span> тендерами`;
        }
    }

    els.resultsCount.innerHTML = countHtml;

    if (items.length === 0) {
        els.resultsGrid.innerHTML = '<div class="empty-state"><p>Нічого не знайдено</p></div>';
        els.pagination.classList.add('hidden');
        return;
    }

    els.resultsGrid.innerHTML = items.map(item => createCard(item)).join('');

    // Update pagination
    els.pagination.classList.remove('hidden');
    els.pageInfo.innerText = `Сторінка ${currentPage + 1} з ${Math.ceil(total / TAKE)}`;
    els.prevBtn.disabled = currentPage === 0;
    els.nextBtn.disabled = (currentPage + 1) * TAKE >= total;

    window.scrollTo({ top: 300, behavior: 'smooth' });
}

function createCard(item) {
    const isContract = currentType === 'contracts';
    const id = isContract ? item.contractID : item.tenderID;
    const title = isContract ? (item.tender?.title || 'Без назви') : (item.title || 'Без назви');
    const customer = isContract ? item.tender?.customerName : item.customerName;
    const customerEdrpou = isContract ? item.tender?.customerEdrpou : item.customerEdrpou;
    const status = item.status || 'unknown';
    const amount = item.amount?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00';
    const currency = item.currency || (isContract ? item.tender?.currency : null) || 'UAH';

    // Dates
    const fmt = (d) => d ? new Date(d).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
    const modifiedDate = fmt(item.dateModified);
    const createdDate = fmt(item.dateCreated);
    const signedDate = fmt(item.dateSigned);

    let detailsHtml = '';
    if (isContract) {
        const vat = item.valueAddedTaxIncluded ? 'з ПДВ' : 'без ПДВ';
        const amountNet = item.amountNet ? item.amountNet.toLocaleString(undefined, { minimumFractionDigits: 2 }) : null;
        const tStatus = item.tender?.status || 'unknown';

        detailsHtml = `
            <div class="card-details-grid">
                <div class="detail-item"><span class="detail-label">Постачальник:</span> <span class="detail-val">${item.supplierName} (${item.supplierEdrpou})</span></div>
                <div class="detail-item"><span class="detail-label">Замовник:</span> <span class="detail-val">${customer} (${customerEdrpou})</span></div>
                <div class="detail-item"><span class="detail-label">Сума Net:</span> <span class="detail-val">${amountNet ? amountNet + ' ' + currency : '—'}</span></div>
                <div class="detail-item"><span class="detail-label">ПДВ:</span> <span class="detail-val">${vat}</span></div>
                <div class="detail-item"><span class="detail-label">Підписано:</span> <span class="detail-val">${signedDate}</span></div>
                <div class="detail-item"><span class="detail-label">Змінено:</span> <span class="detail-val">${modifiedDate}</span></div>
            </div>
            <div class="contracts-section">
                <span class="detail-label">Тендер-основа:</span>
                <div class="mini-contracts-list">
                    <a href="https://prozorro.gov.ua/tender/${item.tender?.tenderID}" target="_blank" class="mini-contract">
                        <div class="mini-contract-main">
                            <span class="mini-supplier">📜 ${item.tender?.tenderID}</span>
                            <span class="mini-status badge-sm badge-${getBadgeClass(tStatus)}">${tStatus}</span>
                        </div>
                        <span class="mini-amount" style="font-size: 0.75rem; color: var(--text-muted)">Перейти до тендеру 🔗</span>
                    </a>
                </div>
            </div>
        `;
    } else {
        const contractsHtml = (item.contracts || []).map(c => `
            <a href="https://prozorro.gov.ua/uk/contract/${c.contractID}" target="_blank" class="mini-contract">
                <div class="mini-contract-main">
                    <span class="mini-supplier">🏢 ${c.supplierName}</span>
                    <span class="mini-status badge-sm badge-${getBadgeClass(c.status || '')}">${c.status}</span>
                </div>
                <span class="mini-amount">${c.amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} ${c.currency || 'UAH'} 🔗</span>
            </a>
        `).join('');

        // Special date logic for tenders
        let specialDateHtml = '';
        const dt = els.dateType.value;
        if (dt !== 'dateModified' && dt !== 'dateCreated') {
            const label = els.dateType.options[els.dateType.selectedIndex].text;
            const val = fmt(item[dt]);
            specialDateHtml = `<div class="detail-item highlight-date"><span class="detail-label">${label}:</span> <span class="detail-val">${val}</span></div>`;
        }

        detailsHtml = `
            <div class="card-details-grid">
                <div class="detail-item"><span class="detail-label">Замовник:</span> <span class="detail-val">${customer} (${customerEdrpou})</span></div>
                <div class="detail-item"><span class="detail-label">Створено:</span> <span class="detail-val">${createdDate}</span></div>
                <div class="detail-item"><span class="detail-label">Змінено:</span> <span class="detail-val">${modifiedDate}</span></div>
                ${specialDateHtml}
            </div>
            ${item.contracts?.length > 0 ? `
                <div class="contracts-section">
                    <span class="detail-label">Контракти (${item.contracts.length}):</span>
                    <div class="mini-contracts-list">${contractsHtml}</div>
                </div>
            ` : ''}
        `;
    }

    return `
        <div class="result-card glass">
            <div class="card-header">
                <div>
                    <span class="tender-id">${id}</span>
                </div>
                <span class="badge badge-${getBadgeClass(status)}">${status}</span>
            </div>
            <h3 class="card-title">${title}</h3>
            
            ${detailsHtml}

            <div class="card-footer">
                <div class="amount">${amount} <span style="font-size: 0.9rem; color: var(--text-muted)">${currency}</span></div>
                <a href="${isContract ? 'https://prozorro.gov.ua/uk/contract/' + id : 'https://prozorro.gov.ua/tender/' + id}" target="_blank" class="btn btn-secondary btn-sm" style="padding: 6px 12px; font-size: 0.8rem">🔗 На Prozorro</a>
            </div>
        </div>
    `;
}

function getBadgeClass(status) {
    if (status.includes('complete') || status.includes('active')) return 'complete';
    if (status.includes('unsuccessful') || status.includes('terminated')) return 'unsuccessful';
    return 'active';
}

function showLoading(show) {
    els.loading.classList.toggle('hidden', !show);
    els.searchBtn.disabled = show;
    if (show) {
        els.resultsGrid.style.opacity = '0.5';
    } else {
        els.resultsGrid.style.opacity = '1';
    }
}

init();
